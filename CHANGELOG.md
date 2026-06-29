# Changelog

All notable changes to this project will be documented in this file.

## [2.4.0] - 2026-06-29
- **New per-device `localOnlyMode` option (default off).** Switches a device fully to local control: the cloud is never contacted — not at startup and not on reconnect — so a hung or expired anonymous AWS-IoT guest session can no longer block local commands. It overrides `cloudStatus`.
- **Local keepalive fixes the "unresponsive after ~60 min" problem.** When `localOnlyMode` is on, the daemon re-asserts the device's beep state (`D03130`) on a fixed cadence to keep the device's local control session warm. CX-series units appear to drop their control session after roughly an hour of pure observe traffic, after which every `set` is silently ignored; exercising the control channel prevents that. The keepalive re-writes the *last reported* value (falling back to beep-off until the first status frame), so it stays silent and never overrides a Beep switch you set yourself. Interval is configurable via the new `localKeepaliveSec` option (default **60 s**, `0` disables it).
- **Cloud bootstrap is now best-effort on reconnect.** The one-shot shadow read is bounded by a 30 s timeout and a hang/failure is swallowed, so a stalled cloud read can never keep the device's control session occupied (which would silently break local `set`). In local-only mode the cloud bootstrap is skipped entirely.

## [2.3.1] - 2026-06-25
- **Fix: Oscillation switch always showed "off" on the CX3550.** The device is set with on-value `17242` but **reads back a different code** (observed: `23040`) while oscillating, with `0` when off. The status was derived as `value === onValue`, which never matched the read-back, so HomeKit showed oscillation as off even while it was running. Status is now derived as `value !== offValue` (anything but the off value counts as oscillating) — robust regardless of the exact code the device returns. Setting was unaffected; only the displayed state was wrong.

## [2.3.0] - 2026-06-20
- **Cloud bootstrap (AWS-IoT device shadow).** CX-series devices (e.g. CX3550) refuse to serve their local `/sys/dev/status` until they have been activated by a cloud client — verified on hardware: a cold device answers `/sys/dev/info` but times out on every status read and never pushes to a bare CoAP observe. This is why HomeKit showed no initial state. The plugin now reproduces what the official app does to wake the device: it reads each device's state from its **AWS-IoT device shadow** over an anonymous (guest) MQTT-over-WebSocket connection, once at startup and again after every local reconnect. This delivers a reliable **initial state**; subsequent change pushes come from the local CoAP observe (which works once the device has been warmed).
- The shadow's `state.reported` uses the exact same `D0…` keys as a local observe frame, so it feeds straight into the existing status pipeline — no profile changes.
- **One-shot, not persistent.** The cloud connection is opened only long enough to read the shadow, then closed again. The device exposes a single active control session: while a cloud client holds it, every local CoAP `set` is silently ignored. Holding a persistent shadow subscription therefore broke command sending entirely (status kept updating, but the fan stopped reacting). The one-shot bootstrap hands the control channel straight back to the local session, so **local control (set) works again** — control still goes over local CoAP.
- New per-device `cloudStatus` option (default **on**). Disable to run local-only.
- New requirement: the daemon now needs the python packages `requests` and `paho-mqtt` (<2.0) in addition to `phipsair`. See the README for the recommended virtual-env setup.
- Privacy note: enabling the cloud source binds your device(s) to an anonymous, randomly-generated guest identity on Philips' cloud (stored as `.philips-airplus-guest-id` in the Homebridge storage path). Bindings are additive — they do **not** displace the official app's binding.
- **Config UI: tabbed device layout.** Each device is now its own tab (labelled by its name) with a "+" to add a device — far easier to tell where one device's config ends and the next begins than the old stacked list.
- **Per-switch "expose to HomeKit" toggles (purifier/fan).** New per-device options `emitOscillationSwitch`, `emitSleepSwitch`, `emitBeepSwitch` and `emitLedSwitch` (all default **on**). Turn one off to keep that switch out of Homebridge/HomeKit entirely — useful when Siri confuses a device's dedicated switch (e.g. LED/Backlight) with the fan or a light. Disabling the Oscillation switch leaves the fan's native SwingMode intact on the fan tile.

## [2.2.0] - 2026-05-27
- Added support for Philips "NEW2"-protocol air purifiers / fans
- New profile-based architecture: each known model has its own `DeviceProfile` describing the exact D-Codes, preset writes (POWER + MODE_A + MODE_B + ...), oscillation values, sensors and filters. Profiles are ported from kongo09's `philips.py`.
- 24 built-in profiles included; CX3550 verified on hardware, all others marked `reference`.
- New `model` config dropdown (per device) listing every built-in profile, plus a `Custom` option.
- New `customProfile` config block — fully editable in the Homebridge UI. With a built-in model selected, customProfile fields *override* individual controls; with `Custom`, customProfile defines the full profile.
- New `printProfile` debug switch to log the resolved DeviceProfile JSON on startup.
- New `AirPurifierAccessory` exposing Fanv2 (Active, RotationSpeed, TargetFanState, SwingMode, LockPhysicalControls) plus AirQualitySensor, TemperatureSensor, HumiditySensor and FilterMaintenance services as supported by the resolved profile.
- New `deviceType` config option (`auto` / `purifier` / `heater`) to pick the right accessory type
- Existing heater accessory (CX3120, CX5120) untouched.

## [2.1.0] - 2026-02-16
- Update dependencies
- Merge [PR#119](https://github.com/agmv/homebridge-philipsairplus-platform/pull/119) from [Jeko](https://github.com/LeJeko) 

## [2.0.9] - 2025-11-25
- Update dependencies

## [2.0.8] - 2025-11-23
- Update dependencies
- Fix device initiation to respect characteristics accepted values

## [2.0.5] - 2025-06-30
- Fix module resolution (reported: https://github.com/homebridge/homebridge-plugin-template/issues/84)

## [2.0.4] - 2025-06-30
- Updated dependencies

## [2.0.3] - 2025-03-08
- Fixed temperature step to be 1°
- Added additional logging for longPoll callback

## [2.0.2] - 2025-03-08
- Bug fixing

## [2.0.1] - 2025-03-08
- Improved logging messages

## [2.0.0] - 2025-03-08
- Major refactoring. Accessories now are mapped to a thermostat with additional switches for other functions: swing, backlight, sounds, Auto+ AI

## [1.0.26] - 2025-03-07
- Fix bug on accessory creation

## [1.0.25] - 2025-03-07
- Revert ability to set heating threshold temperature
- Map accessory as thermostat

## [1.0.24] - 2025-03-07
- Updated dependencies
- Ability to set heating threshold temperature, or target temperature

## [1.0.23] - 2025-02-17
- Updated dependencies
- Fixed poll mechanism

## [1.0.22] - 2025-02-03
- Updated dependencies

## [1.0.21] - 2025-01-21
- Updated dependencies

## [1.0.18] - 2024-12-27
- Moved debug configuration to the device configuration to support debug per device
