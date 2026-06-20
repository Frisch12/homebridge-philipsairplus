#!/usr/bin/env python3
"""
Philips Air+ guest-cloud client — reverse-engineered from the official app
(com.philips.ph.homecare, gaoda/Air-Matters SDK, EU/Production).

Why this exists
---------------
CX-series devices (e.g. CX3550 "Trident") refuse to serve their encrypted
local `/sys/dev/status` (observe OR one-shot read) until they have been
"activated" by a cloud client — verified empirically: a cold device answers
`/sys/dev/info` but times out on every status read and never pushes to a bare
observe. The official app gets state because every device mirrors its full
state into an **AWS-IoT Device Shadow**, and the app reads/subscribes to that
shadow over MQTT-over-WebSocket.

This module reproduces exactly that path for an anonymous *guest* (the app is
usable without a Philips account):

    GET  /device/serverTime/                      -> timestamp
    POST /enduser/v2/getToken/   (HMAC-signed)    -> anonymous JWT
    POST /enduser/v2/bindDevice/ (HMAC-signed)    -> bind device to guest
    POST /enduser/v2/mqttInfo/                    -> presigned wss:// URL
    wss://<ats-iot-endpoint>/mqtt?X-Amz-...       -> AWS-IoT MQTT (Paho)
       subscribe $aws/things/<id>/shadow/get|update/...
       publish   $aws/things/<id>/shadow/get  (empty)  -> full state back

The shadow uses the SAME `D01xxx` status keys as the local push, so its
`state.reported` is a drop-in replacement for a local observe frame.

Security note: the presigned URL embeds short-lived (1 h) AWS credentials
returned by Philips' server; we never compute AWS signatures ourselves.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import threading
import time
import urllib.parse
from typing import Callable, Optional

import requests

try:
    import paho.mqtt.client as mqtt
except Exception as exc:  # pragma: no cover
    raise SystemExit(f"paho-mqtt import failed: {exc}")

# --- EU/Production constants (decoded from the app's obfuscated config) ---
BASE = "https://www.api.air.philips.com/"
APP_ID = "9fd505fa9c7111e9a1e3061302926720"
SECRET = "a_zagf9sb2dpbiImtycwibgfzd6nksd65m"
USER_AGENT = "MxChip&Fog&Hyj#com.philips.ph.homecare#_v3.18.1"
PUSH_TYPE = "android-fcm-v1"

# presigned URLs are valid for X-Amz-Expires=3600s; refresh comfortably before.
URL_TTL_SEC = 3600
URL_REFRESH_SEC = 3000


def _hmac_hex(message: str, key: str) -> str:
    return hmac.new(key.encode(), message.encode(), hashlib.sha256).hexdigest()


class PhilipsCloud:
    """Thin HTTP client for the gaoda guest API (token / bind / mqttInfo)."""

    def __init__(self, guest_id: str, timeout: float = 15.0):
        self.user = f"ahc:id={guest_id}"
        self.timeout = timeout
        self.s = requests.Session()
        self.s.headers["User-Agent"] = USER_AGENT
        self.token: Optional[str] = None
        self.enduser_id: Optional[str] = None

    def _server_time(self) -> str:
        r = self.s.get(BASE + "device/serverTime/", timeout=self.timeout)
        return r.json()["data"]["timestamp2"]

    def get_token(self) -> str:
        ts = self._server_time()
        params = (
            f"app_id={APP_ID}&timestamp={ts}"
            f"&username={urllib.parse.quote(self.user, safe='')}"
        )
        sig = _hmac_hex(_hmac_hex(params, SECRET), self.user)
        r = self.s.post(
            BASE + "enduser/v2/getToken/",
            headers={"Signature": sig, "Content-Type": "application/json;charset:utf-8"},
            data=json.dumps({"timestamp": ts, "username": self.user, "app_id": APP_ID}),
            timeout=self.timeout,
        )
        d = r.json().get("data", {})
        self.token = d.get("token")
        self.enduser_id = d.get("enduser_id")
        if not self.token:
            raise RuntimeError(f"getToken failed: {r.text[:300]}")
        self.s.headers["Authorization"] = "jwt " + self.token
        return self.token

    def bind(self, device_id: str, registration_id: str = "homebridge") -> dict:
        ts = self._server_time()
        sign = (
            f"device_id={device_id}&push_type={PUSH_TYPE}"
            f"&registration_id={urllib.parse.quote(registration_id, safe='')}"
            f"&timestamp={ts}"
        )
        sig = _hmac_hex(_hmac_hex(sign, SECRET), self.user)
        r = self.s.post(
            BASE + "enduser/v2/bindDevice/",
            headers={"Signature": sig, "Content-Type": "application/json;charset:utf-8"},
            data=json.dumps(
                {
                    "timestamp": ts,
                    "device_id": device_id,
                    "push_type": PUSH_TYPE,
                    "registration_id": registration_id,
                }
            ),
            timeout=self.timeout,
        )
        return r.json()

    def mqtt_info(self, device_ids: list[str]) -> list[dict]:
        r = self.s.post(
            BASE + "enduser/v2/mqttInfo/",
            headers={"Content-Type": "application/json;charset:utf-8"},
            data=json.dumps({"device_id": device_ids}),
            timeout=self.timeout,
        )
        j = r.json()
        if j.get("meta", {}).get("code") != 0:
            raise RuntimeError(f"mqttInfo failed: {j.get('meta')}")
        return j["data"].get("mqttinfos", [])

    def unbind(self, device_id: str) -> dict:
        r = self.s.delete(
            BASE + "enduser/unBindDevice/?device_id=" + device_id, timeout=self.timeout
        )
        return r.json()


def _topics(device_id: str) -> dict:
    base = f"$aws/things/{device_id}/shadow"
    return {
        "get": f"{base}/get",
        "get_accepted": f"{base}/get/accepted",
        "update_accepted": f"{base}/update/accepted",
        "update_documents": f"{base}/update/documents",
    }


def _extract_reported(payload: bytes) -> Optional[dict]:
    """Pull `state.reported` (or `current.state.reported`) out of a shadow msg."""
    try:
        d = json.loads(payload)
    except Exception:
        return None
    st = d.get("state")
    if isinstance(st, dict) and isinstance(st.get("reported"), dict):
        return st["reported"]
    cur = d.get("current")
    if isinstance(cur, dict):
        st = cur.get("state")
        if isinstance(st, dict) and isinstance(st.get("reported"), dict):
            return st["reported"]
    return None


class ShadowListener:
    """
    Maintains a cloud MQTT connection for ONE device and invokes
    `on_state(reported_dict_full)` on every shadow update, always with the
    full merged reported state (never a partial delta).

    Runs its own background thread; call start() then stop().
    """

    def __init__(
        self,
        guest_id: str,
        device_id: str,
        on_state: Callable[[dict], None],
        log: Callable[[str, str], None] = lambda lvl, m: None,
    ):
        self.guest_id = guest_id
        self.device_id = device_id
        self.on_state = on_state
        self.log = log
        self.topics = _topics(device_id)

        self._cloud = PhilipsCloud(guest_id)
        self._client: Optional[mqtt.Client] = None
        self._state: dict = {}
        self._state_lock = threading.Lock()
        self._stop = threading.Event()
        self._connected = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._url_fetched_at = 0.0

    # ---- lifecycle ----

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name="cloud-shadow", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        c = self._client
        if c is not None:
            try:
                c.loop_stop()
                c.disconnect()
            except Exception:
                pass
        if self._thread:
            self._thread.join(timeout=5)

    # ---- internals ----

    def _bootstrap_url(self) -> tuple[str, str, str]:
        """token -> bind (idempotent) -> mqttInfo -> (host, path, client_id)."""
        self._cloud.get_token()
        meta = self._cloud.bind(self.device_id).get("meta", {})
        self.log("debug", f"cloud bind {self.device_id}: {meta.get('message')}")
        infos = self._cloud.mqtt_info([self.device_id])
        if not infos:
            raise RuntimeError("mqttInfo returned no entries (device not bound?)")
        info = infos[0]
        u = urllib.parse.urlsplit(info["host"])
        self._url_fetched_at = time.time()
        return u.hostname, info["path"], info["client_id"]

    def _run(self) -> None:
        backoff = 5
        while not self._stop.is_set():
            try:
                host, path, client_id = self._bootstrap_url()
                self.log("debug", f"cloud connecting {host} (client_id={client_id})")
                self._connect(host, path, client_id)
                backoff = 5
                # Hold the connection until it's time to refresh the (1 h) URL
                # or we lose the connection / are asked to stop.
                while not self._stop.is_set():
                    if time.time() - self._url_fetched_at > URL_REFRESH_SEC:
                        self.log("debug", "cloud presigned URL ageing — refreshing")
                        break
                    if self._client is None or not self._client.is_connected():
                        self.log("warn", "cloud MQTT not connected — reconnecting")
                        break
                    self._stop.wait(5)
                self._teardown_client()
            except Exception as exc:
                self.log("warn", f"cloud listener error: {type(exc).__name__}: {exc}")
                self._teardown_client()
                self._stop.wait(backoff)
                backoff = min(backoff * 2, 120)

    def _connect(self, host: str, path: str, client_id: str) -> None:
        c = mqtt.Client(client_id=client_id, transport="websockets")
        c.on_connect = self._on_connect
        c.on_message = self._on_message
        c.on_disconnect = self._on_disconnect
        # AWS IoT signed SignedHeaders=host with the bare endpoint; Paho would
        # otherwise send "host:443" and break the SigV4 signature.
        c.ws_set_options(
            path=path,
            headers=lambda h: {**h, "Host": host, "Origin": f"https://{host}"},
        )
        c.tls_set()
        self._connected.clear()
        c.connect(host, 443, keepalive=30)
        self._client = c
        c.loop_start()
        if not self._connected.wait(timeout=20):
            raise RuntimeError("cloud MQTT connect timeout")

    def _teardown_client(self) -> None:
        c = self._client
        self._client = None
        if c is not None:
            try:
                c.loop_stop()
                c.disconnect()
            except Exception:
                pass

    # ---- paho callbacks ----

    def _on_connect(self, client, userdata, flags, rc):
        if rc != 0:
            self.log("warn", f"cloud MQTT rc={rc}")
            return
        for t in (
            self.topics["get_accepted"],
            self.topics["update_accepted"],
            self.topics["update_documents"],
        ):
            client.subscribe(t, qos=1)
        # request the current full shadow -> delivers the initial state
        client.publish(self.topics["get"], payload="", qos=1)
        self._connected.set()
        self.log("debug", "cloud MQTT connected + shadow/get requested")

    def _on_message(self, client, userdata, msg):
        reported = _extract_reported(msg.payload)
        if not reported:
            return
        with self._state_lock:
            self._state.update(reported)
            full = dict(self._state)
        try:
            self.on_state(full)
        except Exception as exc:
            self.log("warn", f"on_state callback error: {exc}")

    def _on_disconnect(self, client, userdata, rc):
        if rc != 0:
            self.log("debug", f"cloud MQTT disconnected rc={rc}")


# Tiny CLI for manual testing:  python philips_cloud.py <guest_id> <device_id>
if __name__ == "__main__":
    import sys

    gid, did = sys.argv[1], sys.argv[2]

    def _log(lvl, m):
        print(f"[{lvl}] {m}", flush=True)

    def _state(rep):
        keys = {k: rep.get(k) for k in ("D01102", "D0310C", "D03105", "D0313B", "D03125") if k in rep}
        print(f"[state] {keys} (total {len(rep)} keys)", flush=True)

    sl = ShadowListener(gid, did, _state, _log)
    sl.start()
    try:
        time.sleep(float(sys.argv[3]) if len(sys.argv) > 3 else 30)
    finally:
        sl.stop()
