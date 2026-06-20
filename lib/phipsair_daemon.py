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
import sys
import threading
import traceback
from typing import Any

try:
    from phipsair.coap.client import Client
except Exception as exc:  # pragma: no cover — install issue
    sys.stderr.write(f"phipsair import failed: {exc}\n")
    sys.exit(2)

# Cloud status source (AWS-IoT device shadow). Optional: if its dependencies
# (requests / paho-mqtt) are not installed, the daemon still works in
# local-only mode — it just won't have a reliable initial-state / push source.
try:
    from philips_cloud import ShadowListener
except Exception as exc:  # pragma: no cover — optional dependency
    ShadowListener = None  # type: ignore[assignment]
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


# stdout is written from both the asyncio loop (local observe/set) and the
# cloud listener's background thread, so serialize writes.
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
                 guest_id: str | None = None, device_id: str | None = None):
        self.host = host
        self.port = port
        self.keepalive_sec = keepalive_sec
        self.idle_rebuild_sec = idle_rebuild_sec
        # Cloud (AWS-IoT shadow) status source. Both must be set to enable it.
        self.guest_id = guest_id
        self.device_id = device_id
        self.cloud: Any = None  # ShadowListener instance once started
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
        if self.cloud is not None:
            try:
                self.cloud.stop()
            except Exception as exc:
                log("debug", f"cloud shutdown error: {exc}")
            self.cloud = None
        if self.client is not None:
            try:
                await self.client.shutdown()
            except Exception as exc:
                log("debug", f"shutdown error: {exc}")
            self.client = None

    # ------------- cloud status source (AWS-IoT shadow) -------------

    async def start_cloud(self) -> None:
        """
        Start the cloud shadow listener. The CX-series devices won't serve
        their local status until cloud-activated; the AWS-IoT device shadow
        mirrors the exact same `state.reported` keys as a local observe frame,
        so we feed it straight into the normal status pipeline.
        """
        if not self.guest_id:
            log("debug", "cloud status source not configured (no guest-id)")
            return
        if ShadowListener is None:
            log("warn", f"cloud status source unavailable: {_CLOUD_IMPORT_ERROR}")
            return

        device_id = self.device_id
        if not device_id and self.client is not None:
            try:
                info = await self.client.info()
                device_id = info.get("device_id")
            except Exception as exc:
                log("warn", f"cloud: could not read device_id locally: {exc}")
        if not device_id:
            log("warn", "cloud status source disabled: no device-id available")
            return

        def on_state(reported: dict[str, Any]) -> None:
            # Invoked from the listener's background thread; emit() is locked.
            emit({"type": "status", "data": reported})

        def clog(level: str, message: str) -> None:
            log(level, message)

        self.cloud = ShadowListener(self.guest_id, device_id, on_state, clog)
        self.cloud.start()
        log("info", f"cloud status source started for device {device_id}")

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
        emit({"type": "status", "data": reported})

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
        except Exception as exc:
            log("warn", f"reconnect failed: {exc}")

    # ------------- set commands -------------

    async def do_set(self, data: dict[str, Any]) -> bool:
        assert self.client is not None
        async with self._coap_lock:
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
        try:
            await self.connect()
        except Exception as exc:
            emit({"type": "error", "message": f"connect failed: {exc}"})
            log("debug", traceback.format_exc())
            return 1
        emit({"type": "ready"})

        # Start the cloud shadow status source (initial state + reliable
        # change pushes). Local observe stays up as a fast complement and for
        # the case where the device has been warmed by something else.
        await self.start_cloud()

        tasks = [
            asyncio.create_task(self.observe_loop(), name="observe"),
            asyncio.create_task(self.keepalive_loop(), name="keepalive"),
            asyncio.create_task(self.stdin_loop(), name="stdin"),
        ]
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
    args = ap.parse_args()

    daemon = Daemon(
        host=args.host,
        port=args.port,
        keepalive_sec=args.keepalive_sec,
        idle_rebuild_sec=args.idle_rebuild_sec,
        guest_id=args.guest_id,
        device_id=args.device_id,
    )
    try:
        return asyncio.run(daemon.run())
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
