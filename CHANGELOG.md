# Changelog

All notable changes to this project will be documented in this file.

## [2.3.0] - 2026-06-20
- **Cloud status source (AWS-IoT device shadow).** CX-series devices (e.g. CX3550) refuse to serve their local `/sys/dev/status` until they have been activated by a cloud client — verified on hardware: a cold device answers `/sys/dev/info` but times out on every status read and never pushes to a bare CoAP observe. This is why HomeKit showed no initial state and unreliable updates. The plugin now reproduces exactly what the official app does: it reads each device's state from its **AWS-IoT device shadow** over an anonymous (guest) MQTT-over-WebSocket connection. This delivers a reliable **initial state on startup** and **change pushes** (local, physical or app-side changes are mirrored to the shadow within ~1 s), without a Philips account.
- The shadow's `state.reported` uses the exact same `D0…` keys as a local observe frame, so it feeds straight into the existing status pipeline — no profile changes.
- New per-device `cloudStatus` option (default **on**). Disable to run local-only.
- New requirement: the daemon now needs the python packages `requests` and `paho-mqtt` (<2.0) in addition to `phipsair`. See the README for the recommended virtual-env setup.
- Privacy note: enabling the cloud source binds your device(s) to an anonymous, randomly-generated guest identity on Philips' cloud (stored as `.philips-airplus-guest-id` in the Homebridge storage path). Bindings are additive — they do **not** displace the official app's binding.
- Daemon: the cloud listener runs alongside the existing local observe/sync; control (set) still goes over local CoAP. Cleaner shutdown on parent exit.

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
