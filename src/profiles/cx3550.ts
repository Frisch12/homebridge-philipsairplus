import type { DeviceProfile } from './types.js';

/**
 * Philips CX3550 — verified against an actual unit (family "Trident",
 * WifiVersion AWS_Philips_AIR_Combo@86, model id CX3550/01).
 *
 * Confirmed via the observe stream:
 *  - It is a pure fan: NO PM2.5 / IAI / humidity / temperature sensors and
 *    NO filter status are reported by the device.
 *  - Each speed step writes D03102 / D0310A / D0310C / D0310D together
 *    (mirroring kongo09's PhilipsCX3550 AVAILABLE_SPEEDS map).
 *  - D0310C = 1, 2, 3 are the explicit speed steps.
 *  - D0310C = 17 puts the unit into sleep / quiet (the device also forces
 *    D03130 = 0 internally, i.e. beep off).
 *  - D0310C = -126 (0x82 as unsigned byte) is the "natural breeze" auto
 *    mode that cycles between speed 1 and 2 at intervals.
 *  - D0310D is read-only on the CX3550 and silently ignores writes, but
 *    writing it along with D0310C does no harm.
 *  - D0320F oscillation on-value is 17242 (off = 0).
 *  - D03105 controls display backlight (100 = on, 0 = off).
 *  - D0313B carries the room temperature in °C directly (no divisor). This
 *    is the CX3550's equivalent of the D03224 key seen on other NEW2
 *    models. Treated as best-guess; if your unit reports clearly wrong
 *    values, drop this back via customProfile.
 *  - D03125 is the relative humidity in %. Not present in every observe
 *    frame — the device only seems to report it when humidity sensing is
 *    active. HomeKit will show "Unknown" until the first reading arrives.
 *
 * Per kongo09 the CX3550 only exposes a Beep switch (no child lock, no
 * Auto+ AI, no standby sensors). Those are therefore not declared here.
 */
export const CX3550Profile: DeviceProfile = {
  id: 'CX3550',
  displayName: 'Philips CX3550 (Trident)',
  verification: 'verified',
  matchModelPrefixes: ['CX3550'],
  family: 'NEW2 / AWS_Philips_AIR_Combo (Trident)',

  power: { key: 'D03102', onValue: 1, offValue: 0 },
  presets: [
    {
      id: 'speed_1',
      label: 'Speed 1',
      role: 'speed',
      writes: { D03102: 1, D0310A: 1, D0310C: 1, D0310D: 1 },
    },
    {
      id: 'speed_2',
      label: 'Speed 2',
      role: 'speed',
      writes: { D03102: 1, D0310A: 1, D0310C: 2, D0310D: 2 },
    },
    {
      id: 'speed_3',
      label: 'Speed 3',
      role: 'speed',
      writes: { D03102: 1, D0310A: 1, D0310C: 3, D0310D: 3 },
    },
    {
      id: 'natural',
      label: 'Natural Breeze',
      role: 'auto',
      writes: { D03102: 1, D0310A: 1, D0310C: -126, D0310D: 1 },
    },
    {
      id: 'sleep',
      label: 'Sleep',
      role: 'sleep',
      writes: { D03102: 1, D0310A: 1, D0310C: 17, D0310D: 2 },
    },
  ],
  oscillation: { key: 'D0320F', onValue: 17242, offValue: 0 },
  beep: { key: 'D03130', onValue: 100, offValue: 0 },
  backlight: { key: 'D03105', onValue: 100, offValue: 0 },

  sensors: {
    temperature: { key: 'D0313B', divisor: 1 },
    humidity: 'D03125',
  },
};
