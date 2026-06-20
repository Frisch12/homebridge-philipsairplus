import type { DeviceProfile } from './types.js';

/**
 * Philips AC0950 — reference profile ported from kongo09's PhilipsAirPurifierCoap
 * `philips.py`. Not hardware-verified by this plugin; if a value misbehaves on
 * your unit, switch to `Custom` and override only the failing fields.
 */
export const AC0950Profile: DeviceProfile = {
  id: 'AC0950',
  displayName: 'Philips AC0950',
  verification: 'reference',
  matchModelPrefixes: ['AC0950'],
  family: 'NEW2',

  power: { key: 'D03102', onValue: 1, offValue: 0 },
  presets: [
    {
      id: 'auto',
      label: 'Auto',
      role: 'auto',
      writes: { D03102: 1, D0310C: 0, D0310D: 1 },
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
      writes: { D03102: 1, D0310C: 19, D0310D: 2 },
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
