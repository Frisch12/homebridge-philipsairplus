import type { DeviceProfile } from './types.js';

/**
 * Philips AC0850/41 (Combo) — reference profile ported from kongo09's PhilipsAirPurifierCoap
 * `philips.py`. Not hardware-verified by this plugin; if a value misbehaves on
 * your unit, switch to `Custom` and override only the failing fields.
 */
export const AC0850_41CProfile: DeviceProfile = {
  id: 'AC0850-41C',
  displayName: 'Philips AC0850/41 (Combo)',
  verification: 'reference',
  matchModelPrefixes: ['AC0850/41', 'AC0850-41'],
  family: 'NEW2 / AWS_Philips_AIR_Combo',

  power: { key: 'D03102', onValue: 1, offValue: 0 },
  presets: [
    {
      id: 'auto',
      label: 'Auto',
      role: 'auto',
      writes: { D03102: 1, D0310C: 0 },
    },
  ],
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
