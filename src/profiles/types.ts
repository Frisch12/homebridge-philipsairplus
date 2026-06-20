/**
 * Device-profile types — the data model that drives both the built-in
 * model catalogue and the Homebridge UI "custom profile" form.
 *
 * The format mirrors kongo09's NEW2 device classes (see philips.py): each
 * speed / mode is a *preset* that writes a set of D-Code values atomically.
 * This is more accurate than the old "single key + step list" model because
 * many Philips NEW2 devices need several writes (POWER + MODE_A + MODE_B + …)
 * for a single user-visible action.
 */

/** Role hints used by the HomeKit mapping when interpreting a preset. */
export type PresetRole = 'speed' | 'auto' | 'sleep' | 'special';

/**
 * A single fan / mode preset: pressing a single HomeKit speed step ends up
 * writing all entries of `writes` to the device, in order.
 *
 * `id` is a stable identifier (snake_case, e.g. `speed_1`, `sleep`, `auto`,
 * `natural`). `role` drives how the preset is exposed in HomeKit:
 *  - `speed`   → part of the linear RotationSpeed slider
 *  - `auto`    → reached via TargetFanState.AUTO
 *  - `sleep`   → optional dedicated "Sleep" switch
 *  - `special` → optional dedicated switch (no implicit HomeKit binding)
 */
export interface PresetSpec {
  id: string;
  label: string;
  role: PresetRole;
  writes: Record<string, number>;
}

/** A simple on/off control (writes a fixed integer for each state). */
export interface BinaryControl {
  key: string;
  onValue: number;
  offValue: number;
}

export interface OscillationControl {
  key: string;
  onValue: number;
  offValue: number;
}

/** Temperature sensor: wire value is divided by `divisor` to get °C. */
export interface TemperatureSensor {
  key: string;
  divisor: number;
}

/** A filter pair: remaining life key + total life key. */
export interface FilterPair {
  remainingKey: string;
  totalKey: string;
}

export interface SensorSpec {
  pm25?: string;
  iai?: string;
  gas?: string;
  humidity?: string;
  temperature?: TemperatureSensor;
}

export interface FilterSpec {
  prefilter?: FilterPair;
  nanoprotect?: FilterPair;
}

export type ProfileVerification = 'verified' | 'reference' | 'custom';

export interface DeviceProfile {
  /** Stable identifier (kongo09 FanModel id, e.g. "CX3550", "AC3220"). */
  id: string;
  /** Human-friendly display name shown in the config UI dropdown. */
  displayName: string;
  /** `verified` = tested on hardware; `reference` = ported from kongo09 without local verification. */
  verification: ProfileVerification;
  /** Model-string prefixes (from D01S05) that auto-route to this profile. */
  matchModelPrefixes: string[];
  /** Family description shown in the log (helps with debugging which model class is active). */
  family?: string;

  /** Power control. Mandatory — without it the accessory cannot turn the device on or off. */
  power: BinaryControl;

  /** All speed / mode presets. At least one with role='speed' or role='auto' is required. */
  presets: PresetSpec[];

  oscillation?: OscillationControl;
  childLock?: BinaryControl;
  beep?: BinaryControl;
  autoPlus?: BinaryControl;
  standbySensors?: BinaryControl;
  backlight?: BinaryControl;

  sensors?: SensorSpec;
  filters?: FilterSpec;
}

/**
 * A "shallow" version of `DeviceProfile` used for the user-defined
 * customProfile config. Every top-level field is optional; the resolver
 * merges this on top of a built-in profile (when a `model` is selected)
 * or, if no model is selected, treats the customProfile as the only source.
 *
 * Notes on UI:
 *  - All keys are plain D-Code strings (no `#N` suffixes).
 *  - All values are integers on the wire.
 *  - `presets[].writes` is a `Record<string,number>` — the Homebridge UI
 *    expresses this as an array of `{ key, value }` pairs that the platform
 *    converts back to a record at load time.
 */
export interface CustomProfileConfig {
  power?: BinaryControl;
  presets?: PresetSpec[];
  oscillation?: OscillationControl;
  childLock?: BinaryControl;
  beep?: BinaryControl;
  autoPlus?: BinaryControl;
  standbySensors?: BinaryControl;
  backlight?: BinaryControl;
  sensors?: SensorSpec;
  filters?: FilterSpec;
}
