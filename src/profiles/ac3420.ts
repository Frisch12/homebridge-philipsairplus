import type { DeviceProfile } from './types.js';

/**
 * Philips AC3420 — reference profile ported from kongo09's PhilipsAirPurifierCoap
 * `philips.py`. Not hardware-verified by this plugin; if a value misbehaves on
 * your unit, switch to `Custom` and override only the failing fields.
 */
export const AC3420Profile: DeviceProfile = {
  id: 'AC3420',
  displayName: 'Philips AC3420',
  verification: 'reference',
  matchModelPrefixes: ['AC3420'],
  family: 'NEW2',

  power: { key: 'D03102', onValue: 1, offValue: 0 },
  presets: [
    {
      id: 'speed_1',
      label: 'Speed 1',
      role: 'speed',
      writes: { D03102: 1, D0310C: 1, D0310D: 1 },
    },
    {
      id: 'speed_2',
      label: 'Speed 2',
      role: 'speed',
      writes: { D03102: 1, D0310C: 2, D0310D: 2 },
    },
    {
      id: 'speed_3',
      label: 'Speed 3',
      role: 'speed',
      writes: { D03102: 1, D0310C: 3, D0310D: 3 },
    },
    {
      id: 'speed_4',
      label: 'Speed 4',
      role: 'speed',
      writes: { D03102: 1, D0310C: 4, D0310D: 4 },
    },
    {
      id: 'speed_5',
      label: 'Speed 5',
      role: 'speed',
      writes: { D03102: 1, D0310C: 5, D0310D: 18 },
    },
    {
      id: 'auto',
      label: 'Auto',
      role: 'auto',
      writes: { D03102: 1, D0310C: 0, D0310D: 3 },
    },
    {
      id: 'sleep',
      label: 'Sleep',
      role: 'sleep',
      writes: { D03102: 1, D0310C: 17, D0310D: 1 },
    },
    {
      id: 'turbo',
      label: 'Turbo',
      role: 'special',
      writes: { D03102: 1, D0310C: 18, D0310D: 18 },
    },
    {
      id: 'medium',
      label: 'Medium',
      role: 'special',
      writes: { D03102: 1, D0310C: 19, D0310D: 3 },
    },
  ],
  childLock: { key: 'D03103', onValue: 1, offValue: 0 },
  beep: { key: 'D03130', onValue: 100, offValue: 0 },
  backlight: { key: 'D03105', onValue: 100, offValue: 0 },
  sensors: {
    pm25: 'D03221',
    iai: 'D03120',
    humidity: 'D03125',
    temperature: { key: 'D03224', divisor: 10 },
  },
  filters: {
    prefilter: { remainingKey: 'D0520D', totalKey: 'D05207' },
    nanoprotect: { remainingKey: 'D0540E', totalKey: 'D05408' },
  },
};
