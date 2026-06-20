import type { DeviceProfile } from './types.js';

/**
 * Philips HU5710 — reference profile ported from kongo09's PhilipsAirPurifierCoap
 * `philips.py`. Not hardware-verified by this plugin; if a value misbehaves on
 * your unit, switch to `Custom` and override only the failing fields.
 */
export const HU5710Profile: DeviceProfile = {
  id: 'HU5710',
  displayName: 'Philips HU5710',
  verification: 'reference',
  matchModelPrefixes: ['HU5710'],
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
  childLock: { key: 'D03103', onValue: 1, offValue: 0 },
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
