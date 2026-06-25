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


def fetch_shadow_once(
    guest_id: str,
    device_id: str,
    log: Callable[[str, str], None] = lambda lvl, m: None,
    timeout: float = 20.0,
) -> Optional[dict]:
    """
    One-shot cloud read: open an AWS-IoT MQTT connection, request the device
    shadow, return the first full `state.reported` we receive, then close the
    connection again.

    Why one-shot rather than a persistent listener: the device accepts local
    (CoAP) control writes only while no cloud client holds its single active
    control session. A long-lived shadow subscription silently locks out every
    local `set` — the device keeps reporting state but stops acting on local
    commands. We therefore touch the cloud only long enough to lift the device
    out of its cold "won't serve local status" state and grab the initial
    snapshot, then hand the control channel straight back to the local session.

    Returns the reported dict, or None on timeout. Network/auth failures raise.
    """
    cloud = PhilipsCloud(guest_id)
    topics = _topics(device_id)

    # token -> bind (idempotent) -> mqttInfo -> presigned wss:// URL
    cloud.get_token()
    meta = cloud.bind(device_id).get("meta", {})
    log("debug", f"cloud bind {device_id}: {meta.get('message')}")
    infos = cloud.mqtt_info([device_id])
    if not infos:
        raise RuntimeError("mqttInfo returned no entries (device not bound?)")
    info = infos[0]
    u = urllib.parse.urlsplit(info["host"])
    host, path, client_id = u.hostname, info["path"], info["client_id"]

    result: dict = {}
    got = threading.Event()

    def on_connect(client, userdata, flags, rc):
        if rc != 0:
            log("warn", f"cloud MQTT rc={rc}")
            return
        client.subscribe(topics["get_accepted"], qos=1)
        # request the current full shadow -> delivers the initial state
        client.publish(topics["get"], payload="", qos=1)
        log("debug", "cloud MQTT connected + shadow/get requested")

    def on_message(client, userdata, msg):
        reported = _extract_reported(msg.payload)
        if reported:
            result.update(reported)
            got.set()

    c = mqtt.Client(client_id=client_id, transport="websockets")
    c.on_connect = on_connect
    c.on_message = on_message
    # AWS IoT signed SignedHeaders=host with the bare endpoint; Paho would
    # otherwise send "host:443" and break the SigV4 signature.
    c.ws_set_options(
        path=path,
        headers=lambda h: {**h, "Host": host, "Origin": f"https://{host}"},
    )
    c.tls_set()
    log("debug", f"cloud connecting {host} (client_id={client_id})")
    c.connect(host, 443, keepalive=30)
    c.loop_start()
    try:
        if not got.wait(timeout=timeout):
            log("warn", "cloud shadow fetch timed out")
            return None
        return dict(result)
    finally:
        try:
            c.loop_stop()
            c.disconnect()
        except Exception:
            pass


# Tiny CLI for manual testing:  python philips_cloud.py <guest_id> <device_id>
if __name__ == "__main__":
    import sys

    gid, did = sys.argv[1], sys.argv[2]

    def _log(lvl, m):
        print(f"[{lvl}] {m}", flush=True)

    reported = fetch_shadow_once(gid, did, _log)
    if reported:
        keys = {k: reported.get(k) for k in ("D01102", "D0310C", "D03105", "D0313B", "D03125") if k in reported}
        print(f"[state] {keys} (total {len(reported)} keys)", flush=True)
    else:
        print("[state] no shadow returned", flush=True)
