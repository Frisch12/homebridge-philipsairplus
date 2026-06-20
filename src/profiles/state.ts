import type { DeviceProfile, PresetSpec } from './types.js';

/**
 * Runtime state container for a single device. Holds the last value seen
 * for every key the active profile cares about plus a few generic
 * metadata fields. All fields are optional — the observe stream often
 * emits partial frames.
 */
export class DeviceState {
  // Metadata
  name = '';
  model = '';
  firmware = '';
  deviceId = '';
  wifiVersion = '';

  // Raw map of all observed keys (used to detect the active preset).
  rawValues: Record<string, number> = {};

  // Derived state
  active = false;
  /** Active preset id (matches one of `profile.presets[].id`) or undefined. */
  activePresetId?: string;

  // Switches
  oscillation = false;
  childLock = false;
  beep = false;
  autoPlus = false;
  standbySensors = false;
  backlight = false;

  // Sensors
  pm25?: number;
  iai?: number;
  gas?: number;
  humidity?: number;
  temperature?: number;

  // Filters
  prefilterRemaining?: number;
  prefilterTotal?: number;
  nanoprotectRemaining?: number;
  nanoprotectTotal?: number;

  // Diagnostics
  errorCode = 0;
  initialized = false;
}

const num = (v: unknown): number | undefined => {
  if (typeof v === 'number') {
    return v;
  }
  if (typeof v === 'string' && v !== '' && !Number.isNaN(Number(v))) {
    return Number(v);
  }
  return undefined;
};
const str = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined;

function readBinary(state: DeviceState, ctrl?: { key: string; onValue: number; offValue: number }): boolean | undefined {
  if (!ctrl) {
    return undefined;
  }
  const v = state.rawValues[ctrl.key];
  if (v === undefined) {
    return undefined;
  }
  return v === ctrl.onValue;
}

/**
 * Determine which preset is currently active by matching the state's
 * `rawValues` against each preset's `writes`. The preset whose writes
 * match the most keys wins; ties prefer the order in `profile.presets`.
 */
function detectActivePreset(state: DeviceState, profile: DeviceProfile): string | undefined {
  let best: { id: string; matched: number } | undefined;
  for (const p of profile.presets) {
    const entries = Object.entries(p.writes);
    if (entries.length === 0) {
      continue;
    }
    let matched = 0;
    let mismatched = false;
    for (const [k, v] of entries) {
      const cur = state.rawValues[k];
      if (cur === undefined) {
        continue;
      }
      if (cur === v) {
        matched++;
      } else {
        mismatched = true;
        break;
      }
    }
    if (mismatched) {
      continue;
    }
    if (matched === 0) {
      continue;
    }
    if (!best || matched > best.matched) {
      best = { id: p.id, matched };
    }
  }
  return best?.id;
}

/**
 * Apply a JSON observe frame to the state, interpreting fields through
 * the lens of the active profile. Returns the same state instance for
 * chaining.
 */
export function applyObserveFrame(state: DeviceState, profile: DeviceProfile, json: string): DeviceState {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return state;
  }

  // Metadata
  const name = str(data.D01S03);
  if (name !== undefined) {
    state.name = name;
  }
  const model = str(data.D01S05);
  if (model !== undefined) {
    state.model = model;
  }
  const fw = str(data.D01S12);
  if (fw !== undefined) {
    state.firmware = fw;
  }
  const did = str(data.DeviceId);
  if (did !== undefined) {
    state.deviceId = did;
  }
  const wifi = str(data.WifiVersion);
  if (wifi !== undefined) {
    state.wifiVersion = wifi;
  }

  // Cache raw numeric values (only the keys we care about)
  for (const [k, v] of Object.entries(data)) {
    const n = num(v);
    if (n !== undefined) {
      state.rawValues[k] = n;
    }
  }

  // Power
  const power = state.rawValues[profile.power.key];
  if (power !== undefined) {
    state.active = power === profile.power.onValue;
  }

  // Active preset — pick the preset whose `writes` match the current state.
  state.activePresetId = detectActivePreset(state, profile);

  // Oscillation
  if (profile.oscillation) {
    const v = state.rawValues[profile.oscillation.key];
    if (v !== undefined) {
      state.oscillation = v === profile.oscillation.onValue;
    }
  }
  state.childLock = readBinary(state, profile.childLock) ?? state.childLock;
  state.beep = readBinary(state, profile.beep) ?? state.beep;
  state.autoPlus = readBinary(state, profile.autoPlus) ?? state.autoPlus;
  state.standbySensors = readBinary(state, profile.standbySensors) ?? state.standbySensors;
  state.backlight = readBinary(state, profile.backlight) ?? state.backlight;

  // Sensors
  const s = profile.sensors;
  if (s) {
    if (s.pm25) {
      const v = state.rawValues[s.pm25];
      if (v !== undefined) {
        state.pm25 = v;
      }
    }
    if (s.iai) {
      const v = state.rawValues[s.iai];
      if (v !== undefined) {
        state.iai = v;
      }
    }
    if (s.gas) {
      const v = state.rawValues[s.gas];
      if (v !== undefined) {
        state.gas = v;
      }
    }
    if (s.humidity) {
      const v = state.rawValues[s.humidity];
      if (v !== undefined) {
        state.humidity = v;
      }
    }
    if (s.temperature) {
      const v = state.rawValues[s.temperature.key];
      if (v !== undefined && s.temperature.divisor !== 0) {
        state.temperature = v / s.temperature.divisor;
      }
    }
  }

  // Filters
  const f = profile.filters;
  if (f) {
    if (f.prefilter) {
      state.prefilterRemaining = state.rawValues[f.prefilter.remainingKey] ?? state.prefilterRemaining;
      state.prefilterTotal = state.rawValues[f.prefilter.totalKey] ?? state.prefilterTotal;
    }
    if (f.nanoprotect) {
      state.nanoprotectRemaining = state.rawValues[f.nanoprotect.remainingKey] ?? state.nanoprotectRemaining;
      state.nanoprotectTotal = state.rawValues[f.nanoprotect.totalKey] ?? state.nanoprotectTotal;
    }
  }

  const err = state.rawValues.D03240;
  if (err !== undefined) {
    state.errorCode = err;
  }

  state.initialized = true;
  return state;
}

/** All presets that should appear on the linear RotationSpeed slider, in display order. */
export function speedPresets(profile: DeviceProfile): PresetSpec[] {
  return profile.presets.filter(p => p.role === 'speed');
}

/** First preset with role='auto' or 'sleep', used as the auto target. */
export function autoPreset(profile: DeviceProfile): PresetSpec | undefined {
  return profile.presets.find(p => p.role === 'auto');
}

export function sleepPreset(profile: DeviceProfile): PresetSpec | undefined {
  return profile.presets.find(p => p.role === 'sleep');
}

/** Map an active-preset id to a HomeKit RotationSpeed percentage. */
export function presetToRotationSpeed(presetId: string | undefined, profile: DeviceProfile): number {
  if (!presetId) {
    return 0;
  }
  const speeds = speedPresets(profile);
  const idx = speeds.findIndex(p => p.id === presetId);
  if (idx >= 0 && speeds.length > 0) {
    return Math.round((100 / speeds.length) * (idx + 1));
  }
  const all = profile.presets.find(p => p.id === presetId);
  if (!all) {
    return 0;
  }
  // Auto: show mid-range; sleep: low; special: high.
  if (all.role === 'auto') {
    return 50;
  }
  if (all.role === 'sleep') {
    return 15;
  }
  if (all.role === 'special') {
    return 100;
  }
  return 0;
}

/** Pick the speed preset that matches a HomeKit RotationSpeed percentage. */
export function rotationSpeedToPreset(percent: number, profile: DeviceProfile): PresetSpec | undefined {
  const speeds = speedPresets(profile);
  if (speeds.length === 0) {
    return undefined;
  }
  const clamped = Math.max(0, Math.min(100, percent));
  if (clamped <= 0) {
    return speeds[0];
  }
  const step = 100 / speeds.length;
  const idx = Math.min(speeds.length - 1, Math.max(0, Math.ceil(clamped / step) - 1));
  return speeds[idx];
}

/**
 * Map a PM2.5 µg/m³ reading to a HomeKit AirQuality value (1..5).
 * Caller passes in the HomeKit enum constants — keeps this module free
 * of homebridge imports.
 */
export function pm25ToAirQuality(pm25: number | undefined,
  excellent: number, good: number, fair: number, inferior: number,
  poor: number, unknown: number): number {
  if (pm25 === undefined || pm25 === null || Number.isNaN(pm25)) {
    return unknown;
  }
  if (pm25 <= 10) {
    return excellent;
  }
  if (pm25 <= 20) {
    return good;
  }
  if (pm25 <= 25) {
    return fair;
  }
  if (pm25 <= 50) {
    return inferior;
  }
  return poor;
}
