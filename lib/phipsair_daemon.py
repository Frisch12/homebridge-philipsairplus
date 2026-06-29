#!/usr/bin/env python3
"""
Long-lived helper for a single Philips NEW2 device.

Built on top of phipsair's Client class so we don't reimplement CoAP /
AES — we only fix what phipsair's CLI doesn't: the device-side observe
subscription expires unless the client keeps sending sync messages
(observed via tcpdump of the official app: a fresh `sys/dev/sync.XXXX`
every few seconds, even while observe is delivering status pushes).

Wire protocol with the parent Node.js process — JSON Lines on stdin/stdout.

  stdout:
    {"type": "ready"}                                  once the sync handshake is done
    {"type": "status", "data": { ... }}                every observed status frame
    {"type": "set_result", "data": {...}, "ok": true}  after each set
    {"type": "error",  "message": "..."}               recoverable / fatal error
    {"type": "log",    "level": "info|debug|warn",
                       "message": "..."}                free-form log line

  stdin:
    {"type": "set",  "data": {"D03102": 1, "D0310A": 1}}
    {"type": "shutdown"}

Each `set` posts ALL key/value pairs atomically through phipsair's
set_control_values, which already does the encryption + retry dance.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import signal
import sys
import threading
import traceback
from typing import Any

try:
    from phipsair.coap.client import Client
except Exception as exc:  # pragma: no cover — install issue
    sys.stderr.write(f"phipsair import failed: {exc}\n")
    sys.exit(2)

# Cloud bootstrap source (AWS-IoT device shadow). Optional: if its dependencies
# (requests / paho-mqtt) are not installed, the daemon still works in
# local-only mode — it just won't have a reliable initial-state source.
try:
    from philips_cloud import fetch_shadow_once
except Exception as exc:  # pragma: no cover — optional dependency
    fetch_shadow_once = None  # type: ignore[assignment]
    _CLOUD_IMPORT_ERROR = str(exc)
else:
    _CLOUD_IMPORT_ERROR = ""

try:
    from aiocoap import GET, NON, Message
except Exception as exc:  # pragma: no cover — install issue
    sys.stderr.write(f"aiocoap import failed: {exc}\n")
    sys.exit(2)

import warnings

# aiocoap deprecates passing `mtype` to Message(); we still set it to mirror
# the official app's NON observe. Silence the warning so it doesn't flood the
# parent's log via stderr on every (re)registration.
warnings.filterwarnings("ignore", category=DeprecationWarning)


# Default cadence of sync keepalives. Tuned to be much faster than any
# plausible device-side observe expiry (the official app sends sync at
# 1–10 second intervals).
DEFAULT_KEEPALIVE_SEC = 5.0

# If the device produces no status frames for this long, we treat the
# observe as effectively dead and rebuild it (re-issue observe GET).
DEFAULT_OBSERVE_IDLE_SEC = 60.0

# Upper bound on a single cloud shadow read. Past this we abandon the bootstrap
# rather than risk holding the device's control session (see Gotcha #1).
CLOUD_BOOTSTRAP_TIMEOUT_SEC = 30.0

# How often the parent-watch checks whether our parent (the Node plugin) is gone.
PARENT_WATCH_SEC = 5.0


def _set_parent_death_signal() -> None:
    """
    Linux fast-path: ask the kernel to SIGTERM us the moment our parent dies, so
    an orphaned daemon exits immediately instead of lingering. Best-effort and
    racy (misses a parent that died before this call) — the parent-watch loop is
    the portable backstop that always catches it within PARENT_WATCH_SEC.
    """
    if sys.platform != "linux":
        return
    try:
        import ctypes

        PR_SET_PDEATHSIG = 1
        libc = ctypes.CDLL("libc.so.6", use_errno=True)
        libc.prctl(PR_SET_PDEATHSIG, signal.SIGTERM)
    except Exception as exc:  # pragma: no cover — non-glibc / no ctypes
        log("debug", f"PR_SET_PDEATHSIG unavailable: {exc}")


# stdout is written from both the asyncio loop (local observe/set) and the
# cloud bootstrap's executor / paho threads, so serialize writes.
_emit_lock = threading.Lock()


def emit(obj: dict[str, Any]) -> None:
    """Single point for writing JSON Lines to stdout (thread-safe)."""
    line = json.dumps(obj, ensure_ascii=False) + "\n"
    with _emit_lock:
        sys.stdout.write(line)
        sys.stdout.flush()


def log(level: str, message: str) -> None:
    emit({"type": "log", "level": level, "message": message})


class Daemon:
    def __init__(self, host: str, port: int, keepalive_sec: float, idle_rebuild_sec: float,
                 guest_id: str | None = None, device_id: str | None = None,
                 local_keepalive_key: str | None = None,
                 local_keepalive_value: int | None = None,
                 local_keepalive_sec: float = 0.0):
        self.host = host
        self.port = port
        self.keepalive_sec = keepalive_sec
        self.idle_rebuild_sec = idle_rebuild_sec
        # Cloud (AWS-IoT shadow) bootstrap source. Both must be set to enable it.
        self.guest_id = guest_id
        self.device_id = device_id
        # Local-only keepalive: periodically re-assert a single key to keep the
        # device's local control session warm. The plugin passes the profile's
        # "beep off" pair as the *fallback* — once a status frame is seen, the
        # loop re-writes the last reported value instead, so it never clobbers a
        # user-set value (e.g. Beep=on). Only active when key + value + sec set.
        self.local_keepalive_key = local_keepalive_key
        self.local_keepalive_value = local_keepalive_value
        self.local_keepalive_sec = local_keepalive_sec
        # Last value the device reported for local_keepalive_key (None until the
        # first status frame). Drives the re-assert; falls back to the configured
        # value while still None.
        self._last_keepalive_value: int | None = None
        self._bootstrap_task: asyncio.Task | None = None  # one-shot cloud read
        self.client: Client | None = None
        self._last_frame_at = 0.0
        self._stop = asyncio.Event()
        # Single lock to serialize all CoAP traffic — sync/observe/set
        # share the same aiocoap context and we don't want concurrent
        # encryption-context updates.
        self._coap_lock = asyncio.Lock()

    async def connect(self) -> None:
        log("debug", f"connecting to {self.host}:{self.port}")
        self.client = await Client.create(host=self.host, port=self.port)
        log("debug", "sync handshake complete")

    async def shutdown(self) -> None:
        self._stop.set()
        if self._bootstrap_task is not None and not self._bootstrap_task.done():
            self._bootstrap_task.cancel()
        if self.client is not None:
            try:
                await self.client.shutdown()
            except Exception as exc:
                log("debug", f"shutdown error: {exc}")
            self.client = None

    # ------------- cloud bootstrap (AWS-IoT shadow, one-shot) -------------

    def schedule_cloud_bootstrap(self) -> None:
        """
        Fire a one-shot cloud shadow read in the background, replacing any
        previous bootstrap still in flight. Used at startup and after every
        local reconnect — see bootstrap_from_cloud() for the why.
        """
        if self._bootstrap_task is not None and not self._bootstrap_task.done():
            self._bootstrap_task.cancel()
        self._bootstrap_task = asyncio.create_task(
            self.bootstrap_from_cloud(), name="cloud-bootstrap")

    async def bootstrap_from_cloud(self) -> None:
        """
        Read the device's AWS-IoT shadow exactly once for the initial state,
        then drop the cloud connection again.

        The CX-series devices won't serve their local status until they have
        been cloud-activated; a single shadow read lifts them out of that cold
        state. Crucially we must NOT hold the cloud connection open: the device
        has a single active control session, and while the cloud owns it every
        local CoAP `set` is silently ignored. So we grab the snapshot and hand
        the control channel straight back to the local session.

        The shadow's `state.reported` uses the same `D…` keys as a local
        observe frame, so we feed it straight into the normal status pipeline.
        """
        if not self.guest_id:
            log("debug", "cloud bootstrap not configured (no guest-id)")
            return
        if fetch_shadow_once is None:
            log("warn", f"cloud bootstrap unavailable: {_CLOUD_IMPORT_ERROR}")
            return

        device_id = self.device_id
        if not device_id and self.client is not None:
            try:
                info = await self.client.info()
                device_id = info.get("device_id")
            except Exception as exc:
                log("warn", f"cloud: could not read device_id locally: {exc}")
        if not device_id:
            log("warn", "cloud bootstrap disabled: no device-id available")
            return

        loop = asyncio.get_event_loop()
        try:
            # Bound the blocking cloud read: anonymous AWS-IoT guest credentials
            # can expire/stall, and a hung shadow read must never keep the
            # device's control session occupied (Gotcha #1) — that is exactly
            # what makes local `set` writes silently fail. On timeout we simply
            # give up the bootstrap; local observe stays the steady-state source.
            reported = await asyncio.wait_for(
                loop.run_in_executor(
                    None, fetch_shadow_once, self.guest_id, device_id, log),
                timeout=CLOUD_BOOTSTRAP_TIMEOUT_SEC,
            )
        except asyncio.CancelledError:
            raise
        except asyncio.TimeoutError:
            log("warn",
                f"cloud bootstrap timed out after {CLOUD_BOOTSTRAP_TIMEOUT_SEC:.0f}s "
                "— ignoring, continuing local-only")
            return
        except Exception as exc:
            log("warn", f"cloud bootstrap failed: {type(exc).__name__}: {exc}")
            return
        if reported:
            self._note_keepalive_state(reported)
            emit({"type": "status", "data": reported})
            log("info",
                f"cloud bootstrap: initial state for {device_id} "
                f"({len(reported)} keys); connection closed")
        else:
            log("debug", "cloud bootstrap: no shadow state returned")

    # ------------- observe -------------

    async def observe_loop(self) -> None:
        """
        Hold a persistent observe subscription on /sys/dev/status and emit
        every *decryptable* status frame.

        Unlike phipsair's stock `observe_status()` — which decrypts inside the
        async generator and therefore raises out of the whole stream on the
        first bad frame (a single stray/undecryptable payload used to tear the
        observation down and force a reconnect) — we decrypt each frame
        individually and simply skip the ones we cannot read.
        """
        assert self.client is not None
        loop = asyncio.get_event_loop()
        while not self._stop.is_set():
            try:
                self._last_frame_at = loop.time()
                await self._run_observation()
                # The observation ended on its own — uncommon on a healthy
                # session. Re-register after a short pause.
                log("debug", "observe stream ended — re-registering")
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log("warn", f"observe error: {exc.__class__.__name__}: {exc}")
            if self._stop.is_set():
                return
            await asyncio.sleep(1.0)

    async def _run_observation(self) -> None:
        """Register the observe once and pump frames until it ends."""
        client = self.client
        assert client is not None
        msg = Message(
            code=GET,
            mtype=NON,
            uri=f"coap://{client.host}:{client.port}/sys/dev/status",
        )
        msg.opt.observe = 0
        requester = client._client_context.request(msg)  # noqa: SLF001
        try:
            self._handle_frame(await requester.response)
            async for response in requester.observation:
                self._handle_frame(response)
        finally:
            try:
                requester.observation.cancel()
            except Exception:
                pass

    def _handle_frame(self, response: Any) -> None:
        """
        Decrypt a single observe frame and emit its reported state. A frame we
        cannot decrypt/parse is logged at debug level and dropped — never fatal
        to the observation.
        """
        assert self.client is not None
        self._last_frame_at = asyncio.get_event_loop().time()
        try:
            payload = self.client._encryption_context.decrypt(  # noqa: SLF001
                response.payload.decode()
            )
            reported = json.loads(payload)["state"]["reported"]
        except Exception as exc:
            raw = b""
            try:
                raw = response.payload
            except Exception:
                pass
            log("debug",
                f"skipping unreadable observe frame: {exc.__class__.__name__} "
                f"len={len(raw)} head={raw[:40]!r}")
            return
        self._note_keepalive_state(reported)
        emit({"type": "status", "data": reported})

    def _note_keepalive_state(self, reported: Any) -> None:
        """Remember the device's last reported value for the keepalive key, so
        the keepalive can re-assert it rather than forcing a fixed value."""
        key = self.local_keepalive_key
        if key is None or not isinstance(reported, dict) or key not in reported:
            return
        try:
            self._last_keepalive_value = int(reported[key])
        except (TypeError, ValueError):
            pass

    # ------------- sync keepalive -------------

    async def keepalive_loop(self) -> None:
        """
        Periodically run a fresh sync handshake. The official Philips app
        does this every few seconds; without it, the device terminates
        the observe subscription. We hold the lock for the duration so a
        set/observe doesn't race with the encryption-context update.
        """
        assert self.client is not None
        sync_failures = 0
        while not self._stop.is_set():
            try:
                await asyncio.sleep(self.keepalive_sec)
                if self._stop.is_set():
                    return
                async with self._coap_lock:
                    await self.client._sync()  # noqa: SLF001 — we intentionally re-call sync
                sync_failures = 0
                log("debug", "sync keepalive ok")
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                sync_failures += 1
                log("warn",
                    f"sync keepalive failed ({sync_failures}): {exc.__class__.__name__}: {exc}")
                # Only the SYNC handshake tells us whether the session is still
                # alive. Status silence does NOT: this device family only pushes
                # on an actual state change, so minute-long idle gaps are the
                # normal case and must never trigger a teardown (doing so was
                # the cause of the endless "no frames >60s — reconnecting /
                # LibraryShutdown" churn that dropped real updates). We rebuild
                # only after several consecutive sync failures.
                if sync_failures >= 3:
                    log("warn", "sync failed repeatedly — reconnecting")
                    await self._reconnect()
                    sync_failures = 0

    async def local_keepalive_loop(self) -> None:
        """
        Local-only keepalive: periodically re-assert a single key to keep the
        device's local control session warm.

        Background: CX-series units appear to drop their local control session
        after roughly an hour of pure observe traffic, after which every `set`
        is silently ignored. Exercising the control channel with a write on a
        fixed cadence prevents that.

        To avoid clobbering a user-set value, we re-write the *last value the
        device reported* for this key (tracked via _note_keepalive_state),
        falling back to the configured value only until the first status frame
        arrives. Re-asserting the current value is a no-op state change, so the
        device's observe echo carries no surprise and HomeKit stays consistent
        (e.g. a user's Beep=on is preserved). We reuse do_set() so the write
        serializes against sync/observe via _coap_lock, and we never emit a
        set_result for it (it bypasses _dispatch) to keep HomeKit quiet.
        """
        key = self.local_keepalive_key
        fallback = self.local_keepalive_value
        if key is None or fallback is None or self.local_keepalive_sec <= 0:
            return
        while not self._stop.is_set():
            try:
                await asyncio.sleep(self.local_keepalive_sec)
                if self._stop.is_set():
                    return
                if self.client is None:
                    # Mid-reconnect — skip this tick, try again next cycle.
                    continue
                value = self._last_keepalive_value
                if value is None:
                    value = fallback
                await self.do_set({key: value})
                log("debug", f"local keepalive ok ({key}={value})")
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                # Never let a single failed write kill the keepalive loop.
                log("warn",
                    f"local keepalive failed: {exc.__class__.__name__}: {exc}")

    async def parent_watch_loop(self) -> None:
        """
        Exit when our parent (the Node plugin / child-bridge process) goes away.

        stdin_loop already shuts down on stdin EOF, but orphaned daemons have
        been observed in the field surviving their parent's death for *days*
        (PPID reparented away from the original parent), each still holding
        observe/sync/cloud sessions to the same device — multiple stale clients
        per device, which can destabilise control. This is a portable backstop:
        a process's parent PID only changes when the original parent dies, so
        `getppid() != start_ppid` is a precise "we have been orphaned" signal.
        """
        start_ppid = os.getppid()
        while not self._stop.is_set():
            try:
                await asyncio.sleep(PARENT_WATCH_SEC)
            except asyncio.CancelledError:
                raise
            ppid = os.getppid()
            if ppid != start_ppid:
                log("warn",
                    f"parent gone (ppid {start_ppid} -> {ppid}) — shutting down")
                self._stop.set()
                return

    async def _reconnect(self) -> None:
        if self.client is not None:
            try:
                await self.client.shutdown()
            except Exception:
                pass
            self.client = None
        try:
            await self.connect()
            self._last_frame_at = asyncio.get_event_loop().time()
            emit({"type": "ready"})
            # Re-seed the initial state via a one-shot cloud read — but only if
            # the cloud source is configured at all. In local-only mode we never
            # touch the cloud on reconnect (no guest id was passed), so a failing
            # or absent cloud can't get in the way of local control.
            if self.guest_id:
                self.schedule_cloud_bootstrap()
        except Exception as exc:
            log("warn", f"reconnect failed: {exc}")

    # ------------- set commands -------------

    async def do_set(self, data: dict[str, Any]) -> bool:
        # Re-check the client *inside* the lock: a reconnect can null it out
        # between a caller's pre-check and here (the keepalive loop and set
        # dispatch both race against keepalive_loop -> _reconnect).
        async with self._coap_lock:
            if self.client is None:
                return False
            return await self.client.set_control_values(data=data)

    # ------------- stdin handler -------------

    async def stdin_loop(self) -> None:
        loop = asyncio.get_event_loop()
        reader = asyncio.StreamReader()
        await loop.connect_read_pipe(
            lambda: asyncio.StreamReaderProtocol(reader),
            sys.stdin,
        )
        while not self._stop.is_set():
            try:
                line = await reader.readline()
            except asyncio.CancelledError:
                raise
            if not line:
                # stdin closed — parent died
                log("debug", "stdin closed — shutting down")
                self._stop.set()
                return
            text = line.decode("utf-8", errors="replace").strip()
            if not text:
                continue
            try:
                msg = json.loads(text)
            except json.JSONDecodeError as exc:
                emit({"type": "error", "message": f"bad json command: {exc}"})
                continue
            await self._dispatch(msg)

    async def _dispatch(self, msg: dict[str, Any]) -> None:
        kind = msg.get("type")
        if kind == "set":
            data = msg.get("data") or {}
            if not isinstance(data, dict) or not data:
                emit({"type": "error", "message": "set: data must be a non-empty object"})
                return
            try:
                ok = await self.do_set(data)
                emit({"type": "set_result", "data": data, "ok": bool(ok)})
            except Exception as exc:
                emit({"type": "set_result", "data": data, "ok": False, "error": str(exc)})
        elif kind == "shutdown":
            self._stop.set()
        else:
            emit({"type": "error", "message": f"unknown command: {kind!r}"})

    # ------------- main -------------

    async def run(self) -> int:
        # Clean shutdown when systemd (or anything) sends SIGTERM/SIGINT on a
        # restart, so we close CoAP/cloud sessions instead of being hard-killed.
        loop = asyncio.get_event_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                loop.add_signal_handler(sig, self._stop.set)
            except (NotImplementedError, RuntimeError):
                pass  # signal handlers unsupported on this platform/loop

        try:
            await self.connect()
        except Exception as exc:
            emit({"type": "error", "message": f"connect failed: {exc}"})
            log("debug", traceback.format_exc())
            return 1
        emit({"type": "ready"})

        # One-shot cloud read for the initial state (fire-and-forget so local
        # observe starts immediately). The connection is closed again right
        # after — we never hold the device's control session, otherwise local
        # `set` writes get silently ignored. Local observe is the steady-state
        # status source from here on. Skipped entirely in local-only mode
        # (no guest id), where the cloud is never contacted.
        if self.guest_id:
            self.schedule_cloud_bootstrap()

        tasks = [
            asyncio.create_task(self.observe_loop(), name="observe"),
            asyncio.create_task(self.keepalive_loop(), name="keepalive"),
            asyncio.create_task(self.stdin_loop(), name="stdin"),
            asyncio.create_task(self.parent_watch_loop(), name="parent-watch"),
        ]
        if (self.local_keepalive_key is not None
                and self.local_keepalive_value is not None
                and self.local_keepalive_sec > 0):
            tasks.append(asyncio.create_task(
                self.local_keepalive_loop(), name="local-keepalive"))
            log("info",
                f"local keepalive active: re-asserting {self.local_keepalive_key} "
                f"(fallback {self.local_keepalive_value}) every "
                f"{self.local_keepalive_sec:.0f}s")
        try:
            await self._stop.wait()
        finally:
            for t in tasks:
                t.cancel()
            for t in tasks:
                try:
                    await t
                except (asyncio.CancelledError, Exception):
                    pass
            await self.shutdown()
        return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Philips NEW2 device daemon")
    ap.add_argument("--host", required=True, help="Device IP")
    ap.add_argument("--port", type=int, default=5683)
    ap.add_argument("--keepalive-sec", type=float, default=DEFAULT_KEEPALIVE_SEC,
                    help="Interval between sync keepalive pings (default: 5s)")
    ap.add_argument("--idle-rebuild-sec", type=float, default=DEFAULT_OBSERVE_IDLE_SEC,
                    help="Reconnect if no frames received for this long (default: 60s)")
    ap.add_argument("--guest-id",
                    help="Stable anonymous guest id for the Philips cloud (enables the "
                         "AWS-IoT shadow status source). Omit to run local-only.")
    ap.add_argument("--device-id",
                    help="Cloud device id (AWS-IoT thing name). Falls back to the local "
                         "/sys/dev/info device_id if omitted.")
    ap.add_argument("--local-keepalive-key",
                    help="D-code written periodically in local-only mode to keep the "
                         "device's local control session warm (e.g. the beep-off key).")
    ap.add_argument("--local-keepalive-value", type=int,
                    help="Value written for --local-keepalive-key (e.g. 0 for beep off).")
    ap.add_argument("--local-keepalive-sec", type=float, default=0.0,
                    help="Interval between local keepalive writes (default: 0 = disabled).")
    args = ap.parse_args()

    daemon = Daemon(
        host=args.host,
        port=args.port,
        keepalive_sec=args.keepalive_sec,
        idle_rebuild_sec=args.idle_rebuild_sec,
        guest_id=args.guest_id,
        device_id=args.device_id,
        local_keepalive_key=args.local_keepalive_key,
        local_keepalive_value=args.local_keepalive_value,
        local_keepalive_sec=args.local_keepalive_sec,
    )
    # Linux fast-path so an orphaned daemon dies immediately; the parent-watch
    # loop in run() is the portable backstop.
    _set_parent_death_signal()
    try:
        return asyncio.run(daemon.run())
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
