<p align="center">
    <img src="images/logo.png" height="200">
</p>

<h1 align="center">homebridge-philipsairplus-platform</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/homebridge-philipsair-platform"><img src="https://img.shields.io/npm/v/homebridge-philipsair-platform.svg?style=flat-square" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/homebridge-philipsair-platform"><img src="https://img.shields.io/npm/dt/homebridge-philipsair-platform.svg?style=flat-square" alt="npm downloads"></a>
  <a href="https://github.com/homebridge/homebridge/wiki/Verified-Plugins"><img src="https://badgen.net/badge/homebridge/verified/purple" alt="verified-by-homebridge"></a>
</p>

<p align="center">A Homebridge plugin for Philips Air+ Smart Tower Heaters <strong>and</strong> NEW2-protocol air purifiers / fans (e.g. CX3550).</p>

## Installation

After [Homebridge](https://github.com/homebridge/homebridge) has been installed:

```
sudo npm install -g --unsafe-perm homebridge-philipsairplus-platform@latest
```

The plugin uses a library based on `python3`. To use the plugin, Python/Pip must be installed!

```
sudo apt install python3-pip git
```

You also need the `phipsair` module from [M. Frister](https://github.com/mfrister/phipsair),
plus `requests` and `paho-mqtt` (<2.0) for the [cloud status source](#cloud-status-source-aws-iot-shadow):

```
sudo pip3 install -U phipsair "requests" "paho-mqtt<2.0"
```

On recent Debian/Raspberry Pi OS, the system Python is "externally managed" and `pip`
refuses to install into it. The clean way is a dedicated virtual environment that still
sees system packages, then point the plugin at it via the per-device `pythonBin` option:

```
sudo -u homebridge python3 -m venv --system-site-packages /var/lib/homebridge/philips-air-venv
sudo -u homebridge /var/lib/homebridge/philips-air-venv/bin/pip install phipsair "requests" "paho-mqtt<2.0"
# then set  "pythonBin": "/var/lib/homebridge/philips-air-venv/bin/python3"  for each device
```

> If you don't want the cloud source at all, set `"cloudStatus": false` per device and only
> `phipsair` is required (status may then be unreliable on CX-series devices — see below).

### Docker Installation

If you are running Homebridge in a Docker container (e.g., `homebridge/homebridge`), you need to install the dependencies using the startup script.

Create or edit the file `/homebridge/startup.sh` with the following content:

```bash
#!/bin/bash

# Install phipsair library
apt update && apt install -y python3 python3-pip
pip3 install phipsair --break-system-packages
```

Make sure the script is executable and restart your container.

## Device ID Auto-Detection

The plugin can automatically detect the `deviceId` from the device's IP address. Simply leave the `deviceId` field empty and provide the `ip_address`.

If you prefer to manually get the deviceId, use the following phipsair command:
```
phipsair -H <ip-address> status -J
```

> **Note:** The plugin will check if `phipsair` is installed at startup. If not found, an error message will be displayed in the logs.

## Cloud status source (AWS-IoT shadow)

CX-series devices (e.g. **CX3550 "Trident"**) do **not** serve their local encrypted
`/sys/dev/status` until they have been "activated" by a cloud client. On a freshly started
device the local `info` endpoint answers, but every status read times out and a bare CoAP
`observe` never receives a push. That is why, with local-only polling, HomeKit showed **no
initial state** and **unreliable updates**.

Every device also mirrors its full state into an **AWS-IoT device shadow**. This plugin uses
that path purely to **wake the device and grab the initial state**: on startup (and again after
every local reconnect) it obtains an anonymous **guest** token from Philips' cloud (no account
needed), binds the device, fetches a pre-signed MQTT-over-WebSocket URL, reads the shadow once
(`shadow/get`), and then **closes the connection again**. The shadow's `state.reported` carries
the exact same `D0…` keys as a local observe frame, so:

- **Initial state** is delivered on startup from the one-shot shadow read.
- **Changes** afterwards come from the local CoAP `observe`, which works reliably once the
  device has been warmed by that first cloud read.
- Reads are silent (no beep). **Control** (turning on/off, speed, …) goes over local CoAP.

> **Why one-shot and not a persistent subscription?** The device exposes a *single* active
> control session. While a cloud client holds that session open, the device keeps reporting
> state but **silently ignores every local CoAP `set`** — i.e. the fan stops reacting to
> commands. The bootstrap therefore releases the cloud connection immediately so local control
> keeps working.

This requires internet connectivity and the `requests` + `paho-mqtt` python packages.

| | |
|---|---|
| **Config** | per-device `"cloudStatus": true` (default). Set to `false` to run local-only. |
| **Guest identity** | a random id generated once and stored as `.philips-airplus-guest-id` in the Homebridge storage path, shared across all devices. |
| **Privacy** | enabling this binds your device(s) to that anonymous guest identity on Philips' cloud. Bindings are **additive** and do **not** displace the official app. |

## Local-only mode (`localOnlyMode`)

If your device becomes **unresponsive after roughly an hour** — HomeKit still shows state but
the fan/heater no longer reacts to commands — turn on **local-only mode** for that device.

CX-series units appear to drop their single local control session after about an hour of pure
observe traffic, after which every local `set` is silently ignored. Local-only mode fixes this
two ways:

- It **never contacts the cloud** (overrides `cloudStatus`, and skips the cloud bootstrap on
  reconnect), so a hung or expired anonymous guest session can't fight for the control session.
- It keeps the local control session warm **silently**: it turns the beep off once, then every
  `localKeepaliveSec` seconds pokes the oscillation control with an out-of-range value the
  device rejects (no physical change) but answers with a fresh status. Writing the beep key
  itself chirps, so it is used only for the one-time silencing, never for the periodic poke.
  The Beep switch is hidden in this mode (beep is forced off so the poke stays silent).

| | |
|---|---|
| **Config** | per-device `"localOnlyMode": true` (default **false**). |
| **Interval** | `"localKeepaliveSec"` — seconds between keepalive writes (default **60**, `0` disables the keepalive). |
| **Requirement** | the device must be locally reachable; no `requests` / `paho-mqtt` needed in this mode. |

## Example Config

### Minimal configuration (with auto-detection)

```json
{
    "platforms": [
        {
            "platform": "PhilipsAirPlusPlatform",
            "name": "PhilipsAirPlusPlatform",
            "devices": [
                {
                    "active": true,
                    "name": "Heater",
                    "ip_address": "192.168.10.77"
                }
            ]
        }
    ]
}
```

### Full configuration

```json
{
    "platforms": [
        {
            "platform": "PhilipsAirPlusPlatform",
            "name": "PhilipsAirPlusPlatform",
            "devices": [
                {
                    "active": true,
                    "debug": false,
                    "name": "Heater",
                    "deviceId": "4c9c6904ca0f11afb5691bcd86317a2a",
                    "ip_address": "192.168.10.77",
                    "port": 5683,
                    "model": "CX3120",
                    "enableBacklight": false,
                    "enableBeep": true
                }
            ]
        }
    ]
}
```

| Fields             | Description                                                  | Default                    | Required |
|--------------------|--------------------------------------------------------------|----------------------------|----------|
| **platform**       | Must always be `PhilipsAirPlusPlatform`.                     | `"PhilipsAirPlusPlatform"` | Yes      |
| **name**           | For logging purposes                                         | `"PhilipsAirPlusPlatform"` | Yes      |
| devices            | Array of Philips air purifiers.                              |                            | Yes      |
| - active           | Whether the device is active and should be used              |                            | Yes      |
| - debug            | Enables additional output (debug) in the log.                | `false`                    | No       |
| - name             | Unique name of your device.                                  |                            | Yes      |
| - deviceId         | Device unique identifier (auto-detected if empty)            | Auto-detected              | No       |
| - **ip_address**   | Host/IP address of your device.                              |                            | Yes      |
| - port             | Port of your device.                                         | `5683`                     | No       |
| - deviceType       | `auto`, `purifier`, or `heater`. Picks the HomeKit service.  | `auto`                     | No       |
| - model            | Purifier model: `auto`, `Custom`, `CX3550`, `AC3220`, … (full list in UI dropdown) | `auto` | No |
| - customProfile    | Purifier only. Overrides individual controls of the chosen `model`, or — with `model: Custom` — defines the full profile. Fully editable in the Homebridge UI. | _empty_ | No |
| - printProfile     | If `true`, the resolved DeviceProfile JSON is printed to the log on startup. | `false`               | No       |
| - enableBacklight  | Heater only. Backlight control (not supported on CX3120)     | `true`                     | No       |
| - enableBeep       | Heater only. Beep control switch                             | `true`                     | No       |
| - emitOscillationSwitch | Purifier only. Expose the dedicated Oscillation switch to HomeKit. `false` keeps it out (fan's native SwingMode stays). | `true` | No |
| - emitSleepSwitch  | Purifier only. Expose the Sleep switch to HomeKit (if the profile has a sleep preset). | `true`           | No       |
| - emitBeepSwitch   | Purifier only. Expose the Beep switch to HomeKit (if the profile has a beep control). | `true`            | No       |
| - emitLedSwitch    | Purifier only. Expose the LED / Backlight to HomeKit (if the profile has a backlight control). Turn off if Siri confuses it with the fan. | `true` | No |
| - emitTemperatureSensor | Purifier only. Expose the TemperatureSensor to HomeKit (if the profile declares one). Turn off for devices like the CX3550 that report a temperature D-code but have no real sensor (hardcoded ~20 °C). | `true` | No |

### Profiles

Each NEW2 model is described by a `DeviceProfile` listing the exact D-Codes,
preset writes, oscillation values, sensors and filters. The profiles live in
`src/profiles/` — one file per model — and are ported from kongo09's
`philips.py`. Verified profiles: `CX3550`. All other built-in profiles carry
the `reference` mark (not hardware-verified by this plugin).

If a built-in profile is mostly correct but one or two values misbehave on
your unit, leave `model` on the matching built-in and use `customProfile`
to override only the offending fields. With `model: Custom`, define the
full profile.

A handy way to see the values to start from: enable `printProfile` and the
resolved profile is dumped as JSON into the Homebridge log.

## HomeKit Controls

The plugin exposes two different accessory layouts depending on the resolved `deviceType`.

### Heater (`deviceType: "heater"`, e.g. CX3120, CX5120)

Thermostat-based control:

| HomeKit Mode | Device Mode |
|--------------|-------------|
| Off          | Power off   |
| Auto         | Automatic   |
| Heat         | High        |
| Cool         | Ventilation |

> **Note:** Medium and Low modes are not directly accessible via HomeKit but are preserved if set via the Philips app.

Plus switches: Oscillation, Beep, Auto+, Backlight (CX5120 only).

### Air Purifier / Fan (`deviceType: "purifier"`, e.g. CX3550)

`Fanv2`-based control:

| HomeKit Characteristic | Device field   | Notes                                                                              |
|------------------------|----------------|------------------------------------------------------------------------------------|
| Active                 | `D03102`       | Power on/off                                                                       |
| RotationSpeed          | `D0310C`       | Snaps to speed step 1/2/3. `D0310D` is read-only on the CX3550 and not written.    |
| TargetFanState         | `D0310C`       | `Auto` → `D0310C=-126` ("natural breeze"); `Manual` → last explicit step / step 1. |
| SwingMode              | `D0320F`       | CX3550 uses `17242`; on-value otherwise learned from observe / overridable.        |
| LockPhysicalControls   | `D03103`       | Child lock.                                                                        |

Sensors and filter info are added automatically once observed:

- **AirQualitySensor** — `AirQuality` derived from PM2.5 thresholds + `PM2_5Density`
- **TemperatureSensor** — `D03224 / 10` °C
- **HumiditySensor** — `D03125` %
- **FilterMaintenance** — minimum of pre-filter (`D0520D`/`D05207`) and NanoProtect (`D0540E`/`D05408`) remaining life

Optional switches: Beep, Auto+ AI, Standby-Sensors.

> **Tip:** You can rename services in the Home app by long-pressing the accessory and selecting "Accessory Settings".


# Tested devices

The following devices have been tested with this plugin and confirmed to work:

| Model      | Type     | Features                                                                |
|------------|----------|-------------------------------------------------------------------------|
| CX5120/11  | Heater   | Full support (thermostat, backlight, beep, oscillation, Auto+)         |
| CX3120/01  | Heater   | Thermostat, beep, oscillation, Auto+ (no backlight)                    |
| CX3550/01  | Purifier | Fanv2, PM2.5/AirQuality, Temperature, Humidity, Filter, Beep, Auto+ AI |

# Supported clients

This plugin has been verified to work with the following apps/systems:

- iOS >= 13
- Apple Home
- Homebridge >= v1.8.0
- Node >= 22


# Contributing

> This project is heavily inspired by Seydx's [homebridge-philipsair-platform](https://github.com/SeydX/homebridge-philipsair-platform) and - Since the plugin didn't support heaters and coolers I extended it. The **homebridge-philips-air** was a very great help for the implementation!

**Contributors:**
- [Jeko](https://github.com/jeko) - CX3120 support, auto-detection of deviceId, phipsair verification, UI improvements

You can contribute to this homebridge plugin in following ways:

- Report issues and help verify fixes as they are checked in.
- Review the source code changes.
- Contribute bug fixes.
- Contribute changes to extend the capabilities
- Pull requests are accepted.

# Troubleshooting
If you have any issues with the plugin then you can run this plugin in debug mode, which will provide some additional information. This might be useful for debugging issues. Just open your config ui and set debug to true!

**Status updates but commands don't react (CX-series).** The device has a single active control session; a persistent cloud connection holding it makes the device ignore local commands. This plugin only reads the cloud shadow once at startup and then closes the connection, so local control keeps working — make sure you are on a version that does this (≥ 2.3.1). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#cloud-bootstrap-one-shot).

**A switch toggles but its state always shows off.** Some devices read a control's value back as a different code than the one used to set it (e.g. CX3550 oscillation). This is handled for built-in profiles; for a `customProfile`, the displayed state is derived as "not the off value". See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#profiles).

For the full design — daemon protocol, control/status flow, and device quirks — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

# Disclaimer

All product and company names are trademarks™ or registered® trademarks of their respective holders. Use of them does not imply any affiliation with or endorsement by them.

# License

### MIT License

Copyright (c) 2024 André Vieira

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
