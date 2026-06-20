import type { DeviceProfile } from './types.js';

/**
 * Philips HU1510 — reference profile ported from kongo09's PhilipsAirPurifierCoap
 * `philips.py`. Not hardware-verified by this plugin; if a value misbehaves on
 * your unit, switch to `Custom` and override only the failing fields.
 */
export const HU1510Profile: DeviceProfile = {
  id: 'HU1510',
  displayName: 'Philips HU1510',
  verification: 'reference',
  matchModelPrefixes: ['HU1510'],
  family: 'NEW2',

  power: { key: 'D03102', onValue: 1, offValue: 0 },
  presets: [
    {
      id: 'auto',
      label: 'Auto',
      role: 'auto',
      writes: { D03102: 1, D0310C: 0 },
    },
  ],
  beep: { key: 'D03130', onValue: 100, offValue: 0 },
  standbySensors: { key: 'D03134', onValue: 1, offValue: 0 },
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
