import { BUILTIN_PROFILES } from './builtin.js';
import type { BinaryControl, CustomProfileConfig, DeviceProfile, PresetSpec } from './types.js';

export interface ResolveOptions {
  /** Model id from config (`auto`, a built-in id like `CX3550`, or `Custom`). */
  model?: string;
  /** Model string actually reported by the device (D01S05). Used for auto-detect. */
  detectedModel?: string;
  /** Custom profile overrides supplied via the user's homebridge config. */
  customProfile?: CustomProfileConfig;
}

export interface ResolvedProfile {
  profile: DeviceProfile;
  /** True if the resulting profile was assembled (built-in + customProfile merged, or pure custom). */
  hasCustomOverrides: boolean;
}

/** Find the built-in profile whose `matchModelPrefixes` matches the detected model string. */
export function detectBuiltinFromModelString(modelString: string | undefined): DeviceProfile | undefined {
  if (!modelString) {
    return undefined;
  }
  const upper = modelString.toUpperCase();
  for (const profile of Object.values(BUILTIN_PROFILES)) {
    if (profile.matchModelPrefixes.some(p => upper.startsWith(p.toUpperCase()))) {
      return profile;
    }
  }
  return undefined;
}

/** Pick the built-in profile for an explicit `model` config value (case-insensitive). */
export function getBuiltinById(id: string): DeviceProfile | undefined {
  if (!id) {
    return undefined;
  }
  // Exact match first
  if (BUILTIN_PROFILES[id]) {
    return BUILTIN_PROFILES[id];
  }
  const lower = id.toLowerCase();
  for (const [key, p] of Object.entries(BUILTIN_PROFILES)) {
    if (key.toLowerCase() === lower) {
      return p;
    }
  }
  return undefined;
}

/**
 * Merge `overrides` into `base`. Each top-level control is replaced wholesale
 * (so a user override defines the full BinaryControl / OscillationControl /
 * SpeedControl rather than mixing fields with the built-in defaults). The
 * `presets` array is replaced as a whole if present in the overrides —
 * editing single preset writes would make the UX confusing.
 */
function mergeProfile(base: DeviceProfile, overrides: CustomProfileConfig): DeviceProfile {
  return {
    ...base,
    verification: 'custom',
    power: overrides.power ?? base.power,
    presets: overrides.presets ?? base.presets,
    oscillation: overrides.oscillation ?? base.oscillation,
    childLock: overrides.childLock ?? base.childLock,
    beep: overrides.beep ?? base.beep,
    autoPlus: overrides.autoPlus ?? base.autoPlus,
    standbySensors: overrides.standbySensors ?? base.standbySensors,
    backlight: overrides.backlight ?? base.backlight,
    sensors: overrides.sensors ?? base.sensors,
    filters: overrides.filters ?? base.filters,
  };
}

/**
 * Validate and normalise a custom-profile-config object that came from
 * homebridge config.json. Returns the cleaned object plus a list of
 * issues for debug logging. Invalid entries are silently dropped — never
 * thrown — because we never want to crash the homebridge process.
 */
export function normaliseCustomProfile(raw: unknown): { profile: CustomProfileConfig; issues: string[] } {
  const issues: string[] = [];
  const out: CustomProfileConfig = {};
  if (!raw || typeof raw !== 'object') {
    return { profile: out, issues };
  }
  const r = raw as Record<string, unknown>;

  const binary = (label: string, v: unknown): BinaryControl | undefined => {
    if (!v || typeof v !== 'object') {
      return undefined;
    }
    const o = v as Record<string, unknown>;
    if (typeof o.key !== 'string' || typeof o.onValue !== 'number' || typeof o.offValue !== 'number') {
      issues.push(`${label}: expected { key, onValue, offValue } as { string, number, number }`);
      return undefined;
    }
    return { key: o.key, onValue: o.onValue, offValue: o.offValue };
  };

  out.power = binary('power', r.power);
  out.oscillation = binary('oscillation', r.oscillation);
  out.childLock = binary('childLock', r.childLock);
  out.beep = binary('beep', r.beep);
  out.autoPlus = binary('autoPlus', r.autoPlus);
  out.standbySensors = binary('standbySensors', r.standbySensors);
  out.backlight = binary('backlight', r.backlight);

  if (Array.isArray(r.presets)) {
    const presets: PresetSpec[] = [];
    for (const [i, raw] of r.presets.entries()) {
      if (!raw || typeof raw !== 'object') {
        issues.push(`presets[${i}]: not an object`);
        continue;
      }
      const p = raw as Record<string, unknown>;
      const id = typeof p.id === 'string' ? p.id : '';
      const label = typeof p.label === 'string' ? p.label : id;
      const role = (typeof p.role === 'string' && ['speed', 'auto', 'sleep', 'special'].includes(p.role)
        ? p.role : 'special') as PresetSpec['role'];
      const writes: Record<string, number> = {};
      // Accept either { key, value }[] (UI-friendly) or { D03102: 1 } record.
      if (Array.isArray(p.writes)) {
        for (const [j, w] of (p.writes as unknown[]).entries()) {
          if (!w || typeof w !== 'object') {
            issues.push(`presets[${i}].writes[${j}]: not an object`);
            continue;
          }
          const wo = w as Record<string, unknown>;
          if (typeof wo.key !== 'string' || typeof wo.value !== 'number') {
            issues.push(`presets[${i}].writes[${j}]: expected { key: string, value: number }`);
            continue;
          }
          writes[wo.key] = wo.value;
        }
      } else if (p.writes && typeof p.writes === 'object') {
        for (const [k, v] of Object.entries(p.writes as Record<string, unknown>)) {
          if (typeof v === 'number') {
            writes[k] = v;
          } else {
            issues.push(`presets[${i}].writes.${k}: expected number`);
          }
        }
      } else {
        issues.push(`presets[${i}].writes: missing`);
        continue;
      }
      if (!id) {
        issues.push(`presets[${i}].id: missing`);
        continue;
      }
      presets.push({ id, label, role, writes });
    }
    if (presets.length > 0) {
      out.presets = presets;
    }
  }

  // Sensors
  if (r.sensors && typeof r.sensors === 'object') {
    const s = r.sensors as Record<string, unknown>;
    const sensors: NonNullable<CustomProfileConfig['sensors']> = {};
    if (typeof s.pm25 === 'string') {
      sensors.pm25 = s.pm25;
    }
    if (typeof s.iai === 'string') {
      sensors.iai = s.iai;
    }
    if (typeof s.gas === 'string') {
      sensors.gas = s.gas;
    }
    if (typeof s.humidity === 'string') {
      sensors.humidity = s.humidity;
    }
    if (s.temperature && typeof s.temperature === 'object') {
      const t = s.temperature as Record<string, unknown>;
      if (typeof t.key === 'string' && typeof t.divisor === 'number') {
        sensors.temperature = { key: t.key, divisor: t.divisor };
      } else {
        issues.push('sensors.temperature: expected { key: string, divisor: number }');
      }
    }
    if (Object.keys(sensors).length > 0) {
      out.sensors = sensors;
    }
  }

  // Filters
  if (r.filters && typeof r.filters === 'object') {
    const f = r.filters as Record<string, unknown>;
    const filters: NonNullable<CustomProfileConfig['filters']> = {};
    for (const k of ['prefilter', 'nanoprotect'] as const) {
      const fv = f[k];
      if (fv && typeof fv === 'object') {
        const fo = fv as Record<string, unknown>;
        if (typeof fo.remainingKey === 'string' && typeof fo.totalKey === 'string') {
          filters[k] = { remainingKey: fo.remainingKey, totalKey: fo.totalKey };
        } else {
          issues.push(`filters.${k}: expected { remainingKey: string, totalKey: string }`);
        }
      }
    }
    if (Object.keys(filters).length > 0) {
      out.filters = filters;
    }
  }

  return { profile: out, issues };
}

/** Synthetic empty starting profile for pure-custom mode (model = "Custom"). */
function emptyCustomBase(): DeviceProfile {
  return {
    id: 'Custom',
    displayName: 'Custom',
    verification: 'custom',
    matchModelPrefixes: [],
    family: 'User-defined',
    power: { key: 'D03102', onValue: 1, offValue: 0 },
    presets: [],
  };
}

/**
 * Resolve a final DeviceProfile from the user's config plus the device's
 * reported model string. Strategy:
 *  - explicit model = "Custom" → start from an empty profile, overlay customProfile
 *  - explicit model = a built-in id → start from that profile, overlay customProfile
 *  - model = "auto" / unset → match the detectedModel string against
 *    matchModelPrefixes; if nothing matches, fall back to a customProfile
 *    or a clear-error null result.
 */
export function resolveProfile(opts: ResolveOptions): ResolvedProfile | null {
  const model = (opts.model ?? 'auto').trim();
  const overrides = opts.customProfile;

  // Explicit custom
  if (model.toLowerCase() === 'custom') {
    if (!overrides || !overrides.power || !overrides.presets || overrides.presets.length === 0) {
      return null;
    }
    const merged = mergeProfile(emptyCustomBase(), overrides);
    return { profile: merged, hasCustomOverrides: true };
  }

  // Explicit built-in id (case-insensitive)
  if (model && model.toLowerCase() !== 'auto') {
    const base = getBuiltinById(model);
    if (!base) {
      return null;
    }
    if (overrides && Object.keys(overrides).length > 0) {
      return { profile: mergeProfile(base, overrides), hasCustomOverrides: true };
    }
    return { profile: base, hasCustomOverrides: false };
  }

  // Auto-detect
  const detected = detectBuiltinFromModelString(opts.detectedModel);
  if (detected) {
    if (overrides && Object.keys(overrides).length > 0) {
      return { profile: mergeProfile(detected, overrides), hasCustomOverrides: true };
    }
    return { profile: detected, hasCustomOverrides: false };
  }

  // Auto-detect failed but custom profile fully describes the device
  if (overrides && overrides.power && overrides.presets && overrides.presets.length > 0) {
    return { profile: mergeProfile(emptyCustomBase(), overrides), hasCustomOverrides: true };
  }

  return null;
}

/**
 * Return the effective profile as a JSON-friendly snapshot — used to dump
 * built-in profiles into the log so users can copy fields into their
 * customProfile config.
 */
export function profileToJSON(p: DeviceProfile): string {
  return JSON.stringify(p, null, 2);
}
