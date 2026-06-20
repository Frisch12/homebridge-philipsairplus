import type { DeviceProfile } from './types.js';

/**
 * Philips AMF765 — reference profile ported from kongo09's PhilipsAirPurifierCoap
 * `philips.py`. Not hardware-verified by this plugin; if a value misbehaves on
 * your unit, switch to `Custom` and override only the failing fields.
 */
export const AMF765Profile: DeviceProfile = {
  id: 'AMF765',
  displayName: 'Philips AMF765',
  verification: 'reference',
  matchModelPrefixes: ['AMF765'],
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
      writes: { D03102: 1, D0310C: 5, D0310D: 5 },
    },
    {
      id: 'speed_6',
      label: 'Speed 6',
      role: 'speed',
      writes: { D03102: 1, D0310C: 6, D0310D: 6 },
    },
    {
      id: 'speed_7',
      label: 'Speed 7',
      role: 'speed',
      writes: { D03102: 1, D0310C: 7, D0310D: 7 },
    },
    {
      id: 'speed_8',
      label: 'Speed 8',
      role: 'speed',
      writes: { D03102: 1, D0310C: 8, D0310D: 8 },
    },
    {
      id: 'speed_9',
      label: 'Speed 9',
      role: 'speed',
      writes: { D03102: 1, D0310C: 9, D0310D: 9 },
    },
    {
      id: 'speed_10',
      label: 'Speed 10',
      role: 'speed',
      writes: { D03102: 1, D0310C: 10, D0310D: 10 },
    },
    {
      id: 'auto_plus',
      label: 'Auto+',
      role: 'auto',
      writes: { D03102: 1, D0310C: 0, D03180: 0, D0310D: 3 },
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
  ],
  childLock: { key: 'D03103', onValue: 1, offValue: 0 },
  beep: { key: 'D03130', onValue: 100, offValue: 0 },
  autoPlus: { key: 'D03180', onValue: 1, offValue: 0 },
  standbySensors: { key: 'D03134', onValue: 1, offValue: 0 },
  backlight: { key: 'D0312D', onValue: 100, offValue: 0 },
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
