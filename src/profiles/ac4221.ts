import type { DeviceProfile } from './types.js';

/**
 * Philips AC4221 — reference profile ported from kongo09's PhilipsAirPurifierCoap
 * `philips.py`. Not hardware-verified by this plugin; if a value misbehaves on
 * your unit, switch to `Custom` and override only the failing fields.
 */
export const AC4221Profile: DeviceProfile = {
  id: 'AC4221',
  displayName: 'Philips AC4221',
  verification: 'reference',
  matchModelPrefixes: ['AC4221'],
  family: 'NEW2',

  power: { key: 'D03102', onValue: 1, offValue: 0 },
  presets: [
    {
      id: 'speed_1',
      label: 'Speed 1',
      role: 'speed',
      writes: { D03102: 1, D0310C: 1 },
    },
    {
      id: 'speed_2',
      label: 'Speed 2',
      role: 'speed',
      writes: { D03102: 1, D0310C: 2 },
    },
    {
      id: 'speed_3',
      label: 'Speed 3',
      role: 'speed',
      writes: { D03102: 1, D0310C: 3 },
    },
    {
      id: 'speed_4',
      label: 'Speed 4',
      role: 'speed',
      writes: { D03102: 1, D0310C: 4 },
    },
    {
      id: 'speed_5',
      label: 'Speed 5',
      role: 'speed',
      writes: { D03102: 1, D0310C: 5 },
    },
    {
      id: 'auto',
      label: 'Auto',
      role: 'auto',
      writes: { D03102: 1, D0310C: 0 },
    },
    {
      id: 'sleep',
      label: 'Sleep',
      role: 'sleep',
      writes: { D03102: 1, D0310C: 17 },
    },
    {
      id: 'turbo',
      label: 'Turbo',
      role: 'special',
      writes: { D03102: 1, D0310C: 18 },
    },
    {
      id: 'medium',
      label: 'Medium',
      role: 'special',
      writes: { D03102: 1, D0310C: 19 },
    },
  ],
  childLock: { key: 'D03103', onValue: 1, offValue: 0 },
  beep: { key: 'D03130', onValue: 100, offValue: 0 },
  autoPlus: { key: 'D03180', onValue: 1, offValue: 0 },
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
