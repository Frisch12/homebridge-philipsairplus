# Architecture

How this plugin talks to Philips Air+ "NEW2" devices (air purifiers / fans such
as the CX3550), and the two device quirks that shaped the design.

## Components

```
HomeKit ──▶ Homebridge plugin (TypeScript)
                   │  spawns one per device, JSON-Lines over stdin/stdout
                   ▼
            phipsair_daemon.py (Python, long-lived)
              ├── local CoAP  ◀─────────▶  device  (control + status)
              └── AWS-IoT shadow (MQTT)  ◀  Philips cloud  (initial state only)
```

- **Plugin (`src/`)** — registers HomeKit accessories, maps characteristics to
  device "D-codes" via a `DeviceProfile`, and owns one long-lived daemon process
  per device (`AirControlHandler`).
- **Daemon (`lib/phipsair_daemon.py`)** — wraps the `phipsair` CoAP client and
  keeps a persistent `observe` subscription + periodic `sync` keepalive open,
  which the stock `phipsair` CLI cannot do (it spawns one process per command).
- **Cloud (`lib/philips_cloud.py`)** — reads a device's AWS-IoT **device shadow**
  over an anonymous guest MQTT-over-WebSocket connection. Used **only** to obtain
  the initial state; see [Cloud bootstrap](#cloud-bootstrap-one-shot).

## Daemon wire protocol (JSON Lines)

One JSON object per line over the daemon's stdin/stdout.

Plugin → daemon:
```json
{"type": "set", "data": {"D03102": 1, "D0310C": 1}}   // atomic write of all pairs
{"type": "shutdown"}
```

Daemon → plugin:
```json
{"type": "ready"}
{"type": "status", "data": { ...reported D-codes... }}   // every observe push + cloud bootstrap
{"type": "set_result", "data": {...}, "ok": true}
{"type": "log", "level": "info|warn|debug", "message": "..."}
```

## Sending commands (control)

Always **local CoAP** — the cloud path is read-only.

1. A HomeKit `onSet` handler calls `sendSet({ key: value })` /
   `writePreset(...)` in the accessory.
2. `AirControlHandler` **coalesces** all writes within a 50 ms window
   (`COALESCE_WINDOW_MS`) into a single `{type:"set"}` message. Siri often sets
   `Active` + `RotationSpeed` together; without coalescing the device beeps per
   write and two writes can race on the same key. `mergeMode: 'fallback'` lets a
   best-guess write yield to an explicit sibling in the same window.
3. The daemon's `do_set` writes all key/value pairs atomically through
   `phipsair`'s `set_control_values` (AES encryption + retry), serialized against
   sync/observe by a single `_coap_lock`.
4. The daemon replies with `set_result`; the accessory logs ok/failure.

## Receiving status

- **Steady state:** local CoAP `observe` on `/sys/dev/status`. Each frame is
  decrypted individually and undecryptable frames are skipped (never fatal to the
  subscription).
- **Liveness:** a periodic `sync` keepalive (`keepaliveSec`, default 5 s) — this,
  not status silence, is the health signal. The device only pushes on an actual
  state change, so minute-long idle gaps are normal and must never trigger a
  teardown. Only repeated **sync** failures trigger a reconnect.
- **Initial state:** the [cloud bootstrap](#cloud-bootstrap-one-shot).

## Cloud bootstrap (one-shot)

> **Gotcha #1 — the device has a single active control session.**
> CX-series devices refuse to serve their local `/sys/dev/status` until they have
> been "activated" by a cloud client (a cold unit answers `/sys/dev/info` but
> times out on every status read). The obvious fix — hold an AWS-IoT shadow
> subscription open as a status source — **breaks command sending entirely**:
> while a cloud client holds the device's control session, the device keeps
> reporting state but **silently ignores every local CoAP `set`**. Symptom:
> status updates fine, but the fan stops reacting to commands.

Therefore the cloud connection is **one-shot**: `bootstrap_from_cloud()` opens it,
reads the shadow once (`shadow/get`), emits a single `status` frame, and closes it
again — handing the control channel straight back to the local session. It runs at
startup (fire-and-forget, so local observe isn't delayed) and again after every
local reconnect. The shadow's `state.reported` uses the same `D-code` keys as a
local observe frame, so it feeds the normal status pipeline unchanged.

Disable per device with `cloudStatus: false` to run local-only.

The shadow read is **best-effort**: it is bounded by a 30 s timeout
(`CLOUD_BOOTSTRAP_TIMEOUT_SEC`) and any failure/timeout is swallowed. A hung
guest connection must never keep the control session occupied — that is exactly
the Gotcha #1 failure mode (status keeps flowing, local `set` is silently
ignored). On reconnect the bootstrap is only re-scheduled when a cloud source is
actually configured (`guest_id` present).

## Local-only mode (`localOnlyMode`)

> **Gotcha #3 — the local control session goes stale after ~1 h.**
> On CX-series devices, after roughly an hour of pure observe traffic the device
> stops accepting local `set` writes — the bridge keeps showing state but no
> longer reacts to commands. The trigger appears to be an idle control session
> (and/or a held/expired anonymous cloud guest binding fighting for it).

`localOnlyMode: true` addresses this directly:

- **No cloud, ever.** The mode forces `cloudStatus` off (no `--guest-id` is
  passed to the daemon), so the cloud is contacted neither at startup nor on
  reconnect. The device must already be locally reachable (true once it has been
  warmed by the official app at least once).
- **Silent re-assert keepalive.** The daemon runs an extra `local_keepalive_loop`
  that re-writes a single key every `localKeepaliveSec` seconds (default 60,
  `0` disables). The key is the profile's **beep** D-code (`D03130`); the value
  is the *last value the device reported* for that key
  (`_note_keepalive_state`), falling back to **beep-off** (`0`) only until the
  first status frame arrives. Re-asserting the current value is a no-op state
  change, so the device's observe echo carries no surprise — a user's `Beep=on`
  is preserved rather than clobbered. The write goes through the same
  `do_set` / `_coap_lock` path as a real command, so it exercises the control
  channel and keeps the session warm without racing sync/observe. A failed
  keepalive is logged and never tears the loop down.

The beep D-code is chosen because writing it never makes the unit chirp (it only
governs whether *button presses* beep), so the keepalive stays silent. The
plugin supplies the key + fallback value from the device profile
(`profile.beep`); the Smart Fan Heater, which has no profile, hard-codes
`D03130 = 0`. A device whose profile has no beep control gets a warning and no
keepalive.

## Profiles

Each model is described by a `DeviceProfile` (`src/profiles/`) listing the exact
D-codes for power, presets (atomic mode/speed writes), oscillation, sensors and
filters. `customProfile` in the config overrides a built-in profile field by
field, or — with `model: "Custom"` — defines the whole thing. If `customProfile`
supplies `presets`, it **replaces** the base preset array as a whole; a preset
without `writes` is dropped with a `presets[i].writes: missing` warning.

> **Gotcha #2 — set value ≠ read-back value (oscillation).**
> On the CX3550, oscillation is turned on by writing `D0320F = 17242`, but the
> device **reads the key back as a different code** (observed: `23040`), and `0`
> when off. A strict `value === onValue` status check therefore never matched and
> HomeKit always showed oscillation as off. State is derived as
> **`value !== offValue`** instead (anything but the off value counts as on),
> which is robust regardless of the exact code the device returns. Setting was
> never affected — only the displayed state. See `src/profiles/state.ts`.

## Exposing switches to HomeKit

Optional purifier switches (Oscillation, Sleep, Beep, LED/Backlight) are created
only when the profile declares the control **and** the per-device `emit*Switch`
flag is left on (all default on). Turning one off keeps that service out of
HomeKit entirely — useful when Siri confuses a device's dedicated switch (e.g.
LED/Backlight) with the fan or a light. Disabling the Oscillation switch leaves
the fan's native `SwingMode` on the fan tile intact.
