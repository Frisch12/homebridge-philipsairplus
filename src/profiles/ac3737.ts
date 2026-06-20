import type { DeviceProfile } from './types.js';

/**
 * Philips AC3737 — reference profile ported from kongo09's PhilipsAirPurifierCoap
 * `philips.py`. Not hardware-verified by this plugin; if a value misbehaves on
 * your unit, switch to `Custom` and override only the failing fields.
 */
export const AC3737Profile: DeviceProfile = {
  id: 'AC3737',
  displayName: 'Philips AC3737',
  verification: 'reference',
  matchModelPrefixes: ['AC3737'],
  family: 'NEW2',

  power: { key: 'D03102', onValue: 1, offValue: 0 },
  presets: [
    {
      id: 'speed_1',
      label: 'Speed 1',
      role: 'speed',
      writes: { D03102: 1, D0310A: 2, D0310C: 1 },
    },
    {
      id: 'speed_2',
      label: 'Speed 2',
      role: 'speed',
      writes: { D03102: 1, D0310A: 2, D0310C: 2 },
    },
    {
      id: 'auto',
      label: 'Auto',
      role: 'auto',
      writes: { D03102: 1, D0310A: 2, D0310C: 0 },
    },
    {
      id: 'sleep',
      label: 'Sleep',
      role: 'sleep',
      writes: { D03102: 1, D0310A: 2, D0310C: 17 },
    },
    {
      id: 'turbo',
      label: 'Turbo',
      role: 'special',
      writes: { D03102: 1, D0310A: 3, D0310C: 18 },
    },
  ],
  childLock: { key: 'D03103', onValue: 1, offValue: 0 },
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
