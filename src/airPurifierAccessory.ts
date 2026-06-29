import { PlatformAccessory, Service, type CharacteristicValue } from 'homebridge';

import { PhilipsAirPlusPlatform } from './platform.js';
import { AirControlHandler } from './airControlHandler.js';
import type { BinaryControl, DeviceProfile, PresetSpec } from './profiles/types.js';
import {
  applyObserveFrame,
  autoPreset,
  DeviceState,
  pm25ToAirQuality,
  presetToRotationSpeed,
  rotationSpeedToPreset,
  sleepPreset,
  speedPresets,
} from './profiles/state.js';

/**
 * Out-of-range value written to the oscillation key as the local-only keepalive
 * "poke". It is neither the on- nor the off-value, so the device rejects it
 * (no physical change) but still answers with a fresh status frame — which is
 * what keeps the local control session warm. Configurable here if a model ever
 * reacts to it; the valid on-value is model-specific (e.g. 17242 on the CX3550).
 */
const OSCILLATION_POKE_VALUE = 9999;

/**
 * Profile-driven Homebridge accessory for Philips NEW2 air purifiers / fans.
 *
 * Everything the accessory exposes is decided by its `DeviceProfile`:
 *  - Fanv2 service is always created (Active + RotationSpeed + TargetFanState
 *    + optional SwingMode / LockPhysicalControls).
 *  - AirQualitySensor, TemperatureSensor, HumiditySensor and
 *    FilterMaintenance services are created only when the profile declares
 *    the relevant sensor / filter keys.
 *  - Beep / Auto+ AI / Standby-Sensors / Backlight switches are created
 *    only when the profile declares those controls.
 */
export class AirPurifierAccessory extends AirControlHandler {
  private fanService?: Service;
  private airQualityService?: Service;
  private temperatureService?: Service;
  private humidityService?: Service;
  private filterService?: Service;
  private beepService?: Service;
  private autoPlusAIService?: Service;
  private standbySensorsService?: Service;
  private backlightService?: Service;
  private oscillationService?: Service;
  private sleepService?: Service;
  /** Whether to expose the (often bogus) TemperatureSensor service. */
  private emitTemperatureSensor = true;

  private readonly state = new DeviceState();

  constructor(
    public readonly platform: PhilipsAirPlusPlatform,
    public readonly accessory: PlatformAccessory,
    public readonly profile: DeviceProfile,
  ) {
    super(platform, accessory);

    this.platform.log.info(
      `Using profile "${profile.id}" (${profile.verification}) for ${this.accessory.displayName}`,
    );
    if (profile.verification === 'reference') {
      this.platform.log.info(
        `Profile "${profile.id}" was ported from kongo09 and has not been verified on actual hardware. ` +
        'If something misbehaves, switch the model to "Custom" and override only the affected fields.',
      );
    }

    this.initAccessory();
  }

  private handleError(error: unknown, context: string) {
    if (error instanceof Error) {
      this.platform.log.error(`${context}:`, error.message, this.accessory.displayName);
    } else {
      this.platform.log.error(`${context}:`, JSON.stringify(error), this.accessory.displayName);
    }
  }

  private initAccessory() {
    const C = this.platform.Characteristic;
    const S = this.platform.Service;

    // Per-switch "expose to HomeKit" toggles (default on). When off, the
    // corresponding service is not created at all — useful when Siri can't
    // tell a device's dedicated switch (e.g. LED/Backlight) apart from the
    // fan itself. A switch is only ever created when BOTH the profile
    // declares the control AND the user left it enabled.
    const device = this.accessory.context.device ?? {};
    const emitOscillationSwitch = device.emitOscillationSwitch !== false;
    const emitSleepSwitch = device.emitSleepSwitch !== false;
    // In local-only mode the keepalive forces beep off (so its pokes stay
    // silent); exposing a Beep switch there would be a lie — it can't be turned
    // on without making the device chirp on every poke. Hide it in that mode.
    const emitBeepSwitch = device.emitBeepSwitch !== false && !this.localOnlyMode;
    const emitLedSwitch = device.emitLedSwitch !== false;
    // The CX3550 reports a temperature D-code but has no real sensor (hardcoded
    // ~20 °C); let the user hide that bogus TemperatureSensor service.
    this.emitTemperatureSensor = device.emitTemperatureSensor !== false;

    // Accessory information
    this.accessory.getService(S.AccessoryInformation)!
      .setCharacteristic(C.Manufacturer, this.manufacturer)
      .setCharacteristic(C.SerialNumber, this.serialNumber)
      .setCharacteristic(C.Model, this.profile.displayName);

    // Fanv2 (primary)
    this.fanService = this.accessory.getService(S.Fanv2)
      ?? this.accessory.addService(S.Fanv2, this.displayName);
    this.fanService.setCharacteristic(C.Name, this.displayName);

    this.fanService.getCharacteristic(C.Active).onSet(this.setActive.bind(this));

    // Stepped RotationSpeed slider — most Philips NEW2 devices only have a
    // handful of discrete speeds. Snapping prevents HomeKit from sending
    // values that the device would just round anyway.
    const speedCount = speedPresets(this.profile).length;
    const minStep = speedCount > 0 ? Math.round((100 / speedCount) * 100) / 100 : 1;
    this.fanService.getCharacteristic(C.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep })
      .onSet(this.setRotationSpeed.bind(this));
    this.fanService.getCharacteristic(C.TargetFanState).onSet(this.setTargetFanState.bind(this));

    if (this.profile.oscillation) {
      // SwingMode characteristic — picked up by iOS Home automatically.
      this.fanService.getCharacteristic(C.SwingMode).onSet(this.setSwingMode.bind(this));
    }
    if (this.profile.childLock) {
      this.fanService.getCharacteristic(C.LockPhysicalControls).onSet(this.setLockPhysicalControls.bind(this));
    }

    // Dedicated Oscillation Switch in addition to Fanv2's native SwingMode.
    // Reason: iOS Home renders SwingMode inline on the fan tile when you
    // long-press it, but the Homebridge UI tester and many third-party
    // HomeKit apps only show "primitive" Fanv2 characteristics (Active +
    // RotationSpeed). The Switch is linked to the Fanv2 service so Apple
    // Home groups them under the same accessory.
    if (this.profile.oscillation && emitOscillationSwitch) {
      this.oscillationService = this.accessory.getServiceById(S.Switch, 'OSCILLATION')
        ?? this.accessory.addService(S.Switch, 'Oscillation', 'OSCILLATION');
      this.oscillationService.getCharacteristic(C.On).onSet(this.setSwingMode.bind(this));
      this.fanService.addLinkedService(this.oscillationService);
    } else {
      this.removeSwitchById('OSCILLATION');
    }

    // Sleep doesn't map to a native Fanv2 characteristic, so it gets its own
    // Switch. Same linking logic.
    if (sleepPreset(this.profile) && emitSleepSwitch) {
      this.sleepService = this.accessory.getServiceById(S.Switch, 'SLEEP')
        ?? this.accessory.addService(S.Switch, 'Sleep', 'SLEEP');
      this.sleepService.getCharacteristic(C.On).onSet(this.setSleep.bind(this));
      this.fanService.addLinkedService(this.sleepService);
    } else {
      this.removeSwitchById('SLEEP');
    }

    this.fanService.setPrimaryService(true);

    // Optional sub-services (only if declared by the profile). Each is linked
    // to the primary Fanv2 so iOS Home groups them under the same tile rather
    // than scattering them across the Home screen.
    if (this.profile.beep && emitBeepSwitch) {
      this.beepService = this.accessory.getServiceById(S.Switch, 'BEEP')
        ?? this.accessory.addService(S.Switch, 'Beep', 'BEEP');
      this.beepService.getCharacteristic(C.On).onSet(this.setBeep.bind(this));
      this.fanService.addLinkedService(this.beepService);
    } else {
      this.removeSwitchById('BEEP');
    }
    if (this.profile.autoPlus) {
      this.autoPlusAIService = this.accessory.getServiceById(S.Switch, 'AUTO_PLUS_AI')
        ?? this.accessory.addService(S.Switch, 'Auto+', 'AUTO_PLUS_AI');
      this.autoPlusAIService.getCharacteristic(C.On).onSet(this.setAutoPlusAI.bind(this));
      this.fanService.addLinkedService(this.autoPlusAIService);
    } else {
      this.removeSwitchById('AUTO_PLUS_AI');
    }
    if (this.profile.standbySensors) {
      this.standbySensorsService = this.accessory.getServiceById(S.Switch, 'STANDBY_SENSORS')
        ?? this.accessory.addService(S.Switch, 'Standby Sensors', 'STANDBY_SENSORS');
      this.standbySensorsService.getCharacteristic(C.On).onSet(this.setStandbySensors.bind(this));
      this.fanService.addLinkedService(this.standbySensorsService);
    } else {
      this.removeSwitchById('STANDBY_SENSORS');
    }
    if (this.profile.backlight && emitLedSwitch) {
      this.backlightService = this.accessory.getServiceById(S.Lightbulb, 'BACKLIGHT')
        ?? this.accessory.addService(S.Lightbulb, 'Backlight', 'BACKLIGHT');
      this.backlightService.getCharacteristic(C.On).onSet(this.setBacklight.bind(this));
      this.fanService.addLinkedService(this.backlightService);
    } else {
      this.removeLightbulbById('BACKLIGHT');
    }

    // Sensor / filter services come up lazily on the first observe frame —
    // except the temperature sensor, which the user can suppress entirely.
    if (!this.emitTemperatureSensor) {
      const existingTemp = this.accessory.getServiceById(S.TemperatureSensor, 'TEMP');
      if (existingTemp) {
        this.platform.log.info('Removing Temperature sensor (disabled)', this.accessory.displayName);
        this.accessory.removeService(existingTemp);
      }
    }

    // Local-only keepalive: silence the beep once (profile's beep key), then
    // poke the oscillation key with an out-of-range value (see the daemon).
    this.localSilenceKey = this.profile.beep?.key;
    this.localSilenceValue = this.profile.beep?.offValue;
    this.localPokeKey = this.profile.oscillation?.key;
    this.localPokeValue = this.profile.oscillation ? OSCILLATION_POKE_VALUE : undefined;

    this.longPoll();
  }

  private removeSwitchById(id: string) {
    const existing = this.accessory.getServiceById(this.platform.Service.Switch, id);
    if (existing) {
      this.accessory.removeService(existing);
    }
  }
  private removeLightbulbById(id: string) {
    const existing = this.accessory.getServiceById(this.platform.Service.Lightbulb, id);
    if (existing) {
      this.accessory.removeService(existing);
    }
  }

  // ---------- HomeKit setters ----------

  async setActive(value: CharacteristicValue) {
    try {
      const on = value === this.platform.Characteristic.Active.ACTIVE;
      // Power off: just write `power.offValue`. Power on: write the current
      // (or first speed) preset so the device actually spins back up to a
      // sensible state. The preset is written with 'fallback' merge so a
      // sibling setRotationSpeed/setTargetFanState in the same coalesce
      // window wins the speed-key (D0310C / D0310D) tug-of-war — without
      // this, Siri's "set fan to N%" would race and sometimes land on the
      // last-known speed instead of the requested one.
      if (on) {
        const preset = this.pickPresetForActiveOn();
        if (preset) {
          await this.writePreset(preset, { mergeMode: 'fallback' });
        } else {
          await this.writeBinary(this.profile.power, true);
        }
        this.state.active = true;
      } else {
        await this.writeBinary(this.profile.power, false);
        this.state.active = false;
      }
    } catch (error) {
      this.handleError(error, 'setActive');
    }
  }

  private pickPresetForActiveOn(): PresetSpec | undefined {
    if (this.state.activePresetId) {
      const cur = this.profile.presets.find(p => p.id === this.state.activePresetId);
      if (cur) {
        return cur;
      }
    }
    const speeds = speedPresets(this.profile);
    if (speeds.length > 0) {
      return speeds[0];
    }
    return autoPreset(this.profile) ?? this.profile.presets[0];
  }

  async setRotationSpeed(value: CharacteristicValue) {
    try {
      const percent = Number(value);
      if (percent <= 0) {
        // Treat slider = 0 as "leave power alone" — HomeKit also calls
        // setActive on the same gesture, which is the authoritative signal.
        return;
      }
      const preset = rotationSpeedToPreset(percent, this.profile);
      if (preset) {
        await this.writePreset(preset);
        this.state.activePresetId = preset.id;
        this.state.active = true;
      }
    } catch (error) {
      this.handleError(error, 'setRotationSpeed');
    }
  }

  async setTargetFanState(value: CharacteristicValue) {
    try {
      const auto = value === this.platform.Characteristic.TargetFanState.AUTO;
      const target = auto
        ? autoPreset(this.profile)
        : speedPresets(this.profile)[0];
      if (target) {
        await this.writePreset(target);
        this.state.activePresetId = target.id;
        this.state.active = true;
      }
    } catch (error) {
      this.handleError(error, 'setTargetFanState');
    }
  }

  async setSwingMode(value: CharacteristicValue) {
    if (!this.profile.oscillation) {
      return;
    }
    try {
      // Accept both Fanv2's SwingMode enum AND the Switch's boolean value —
      // this setter is reused for both services.
      const enabled = value === this.platform.Characteristic.SwingMode.SWING_ENABLED
        || value === true;
      await this.writeBinary(this.profile.oscillation, enabled);
      this.state.oscillation = enabled;
    } catch (error) {
      this.handleError(error, 'setSwingMode');
    }
  }

  async setSleep(value: CharacteristicValue) {
    const sleep = sleepPreset(this.profile);
    if (!sleep) {
      return;
    }
    try {
      if (value) {
        await this.writePreset(sleep);
        this.state.activePresetId = sleep.id;
        this.state.active = true;
      } else {
        // Sleep off → fall back to the first speed preset (or auto if no speeds).
        const fallback = speedPresets(this.profile)[0] ?? autoPreset(this.profile);
        if (fallback) {
          await this.writePreset(fallback);
          this.state.activePresetId = fallback.id;
          this.state.active = true;
        }
      }
    } catch (error) {
      this.handleError(error, 'setSleep');
    }
  }

  async setLockPhysicalControls(value: CharacteristicValue) {
    if (!this.profile.childLock) {
      return;
    }
    try {
      const locked = value === this.platform.Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED;
      await this.writeBinary(this.profile.childLock, locked);
      this.state.childLock = locked;
    } catch (error) {
      this.handleError(error, 'setLockPhysicalControls');
    }
  }

  async setBeep(value: CharacteristicValue) {
    if (!this.profile.beep) {
      return;
    }
    try {
      const on = Boolean(value);
      await this.writeBinary(this.profile.beep, on);
      this.state.beep = on;
    } catch (error) {
      this.handleError(error, 'setBeep');
    }
  }

  async setAutoPlusAI(value: CharacteristicValue) {
    if (!this.profile.autoPlus) {
      return;
    }
    try {
      const on = Boolean(value);
      await this.writeBinary(this.profile.autoPlus, on);
      this.state.autoPlus = on;
    } catch (error) {
      this.handleError(error, 'setAutoPlusAI');
    }
  }

  async setStandbySensors(value: CharacteristicValue) {
    if (!this.profile.standbySensors) {
      return;
    }
    try {
      const on = Boolean(value);
      await this.writeBinary(this.profile.standbySensors, on);
      this.state.standbySensors = on;
    } catch (error) {
      this.handleError(error, 'setStandbySensors');
    }
  }

  async setBacklight(value: CharacteristicValue) {
    if (!this.profile.backlight) {
      return;
    }
    try {
      const on = Boolean(value);
      await this.writeBinary(this.profile.backlight, on);
      this.state.backlight = on;
    } catch (error) {
      this.handleError(error, 'setBacklight');
    }
  }

  // ---------- Wire writers ----------

  private async writeBinary(ctrl: BinaryControl, on: boolean): Promise<void> {
    const v = on ? ctrl.onValue : ctrl.offValue;
    this.sendSet({ [ctrl.key]: v });
  }

  private async writePreset(
    preset: PresetSpec,
    opts?: { mergeMode?: 'override' | 'fallback' },
  ): Promise<void> {
    this.platform.log.debug(`Preset "${preset.id}": ${JSON.stringify(preset.writes)}`, this.accessory.displayName);
    this.sendSet({ ...preset.writes }, opts);
  }

  // ---------- Observe callbacks ----------

  async onPollData(data: string): Promise<void> {
    const trimmed = data.replace(/\n$/, '');
    if (trimmed === '') {
      return;
    }
    try {
      applyObserveFrame(this.state, this.profile, trimmed);
      this.ensureDynamicServices();
      this.pushStateToHomeKit();
    } catch (error) {
      this.handleError(error, 'onPollData');
    }
  }

  /** Create sensor / filter services lazily when the profile declares them and a value has been observed. */
  private ensureDynamicServices() {
    const C = this.platform.Characteristic;
    const S = this.platform.Service;
    const s = this.profile.sensors;
    const f = this.profile.filters;

    if (s?.pm25 && !this.airQualityService) {
      this.airQualityService = this.accessory.getServiceById(S.AirQualitySensor, 'AIR_QUALITY')
        ?? this.accessory.addService(S.AirQualitySensor, `${this.displayName} Air Quality`, 'AIR_QUALITY');
      this.fanService?.addLinkedService(this.airQualityService);
    }
    if (s?.temperature && this.emitTemperatureSensor && !this.temperatureService) {
      this.temperatureService = this.accessory.getServiceById(S.TemperatureSensor, 'TEMP')
        ?? this.accessory.addService(S.TemperatureSensor, `${this.displayName} Temperature`, 'TEMP');
      this.fanService?.addLinkedService(this.temperatureService);
    }
    if (s?.humidity && !this.humidityService) {
      this.humidityService = this.accessory.getServiceById(S.HumiditySensor, 'HUMIDITY')
        ?? this.accessory.addService(S.HumiditySensor, `${this.displayName} Humidity`, 'HUMIDITY');
      this.fanService?.addLinkedService(this.humidityService);
    }
    if ((f?.prefilter || f?.nanoprotect) && !this.filterService) {
      this.filterService = this.accessory.getServiceById(S.FilterMaintenance, 'FILTER')
        ?? this.accessory.addService(S.FilterMaintenance, `${this.displayName} Filter`, 'FILTER');
      this.fanService?.addLinkedService(this.filterService);
    }
    void C;
  }

  private pushStateToHomeKit() {
    if (!this.fanService) {
      return;
    }
    const C = this.platform.Characteristic;
    const state = this.state;
    const profile = this.profile;

    if (state.firmware) {
      this.accessory.getService(this.platform.Service.AccessoryInformation)
        ?.updateCharacteristic(C.FirmwareRevision, state.firmware);
    }
    if (state.model) {
      this.accessory.getService(this.platform.Service.AccessoryInformation)
        ?.updateCharacteristic(C.Model, state.model);
    }

    // Fanv2
    this.fanService.updateCharacteristic(C.Active,
      state.active ? C.Active.ACTIVE : C.Active.INACTIVE);
    this.fanService.updateCharacteristic(C.CurrentFanState,
      !state.active ? C.CurrentFanState.INACTIVE : C.CurrentFanState.BLOWING_AIR);

    const auto = autoPreset(profile);
    const isAuto = !!auto && state.activePresetId === auto.id;
    this.fanService.updateCharacteristic(C.TargetFanState,
      isAuto ? C.TargetFanState.AUTO : C.TargetFanState.MANUAL);

    this.fanService.updateCharacteristic(C.RotationSpeed,
      presetToRotationSpeed(state.activePresetId, profile));

    if (profile.oscillation) {
      this.fanService.updateCharacteristic(C.SwingMode,
        state.oscillation ? C.SwingMode.SWING_ENABLED : C.SwingMode.SWING_DISABLED);
    }
    if (profile.childLock) {
      this.fanService.updateCharacteristic(C.LockPhysicalControls,
        state.childLock ? C.LockPhysicalControls.CONTROL_LOCK_ENABLED : C.LockPhysicalControls.CONTROL_LOCK_DISABLED);
    }
    if (state.name) {
      this.fanService.updateCharacteristic(C.Name, state.name);
    }

    if (this.airQualityService) {
      this.airQualityService.updateCharacteristic(C.AirQuality, pm25ToAirQuality(
        state.pm25,
        C.AirQuality.EXCELLENT, C.AirQuality.GOOD, C.AirQuality.FAIR,
        C.AirQuality.INFERIOR, C.AirQuality.POOR, C.AirQuality.UNKNOWN,
      ));
      if (state.pm25 !== undefined) {
        this.airQualityService.updateCharacteristic(C.PM2_5Density,
          Math.max(0, Math.min(1000, state.pm25)));
      }
    }
    if (this.temperatureService && state.temperature !== undefined) {
      this.temperatureService.updateCharacteristic(C.CurrentTemperature, state.temperature);
    }
    if (this.humidityService && state.humidity !== undefined) {
      this.humidityService.updateCharacteristic(C.CurrentRelativeHumidity,
        Math.max(0, Math.min(100, state.humidity)));
    }
    if (this.filterService) {
      const lifes: number[] = [];
      if (state.prefilterRemaining !== undefined && state.prefilterTotal && state.prefilterTotal > 0) {
        lifes.push(Math.max(0, Math.min(100, Math.round((state.prefilterRemaining / state.prefilterTotal) * 100))));
      }
      if (state.nanoprotectRemaining !== undefined && state.nanoprotectTotal && state.nanoprotectTotal > 0) {
        lifes.push(Math.max(0, Math.min(100, Math.round((state.nanoprotectRemaining / state.nanoprotectTotal) * 100))));
      }
      if (lifes.length > 0) {
        const life = Math.min(...lifes);
        this.filterService.updateCharacteristic(C.FilterLifeLevel, life);
        this.filterService.updateCharacteristic(C.FilterChangeIndication,
          life <= 5 ? C.FilterChangeIndication.CHANGE_FILTER : C.FilterChangeIndication.FILTER_OK);
      }
    }

    if (this.beepService) {
      this.beepService.updateCharacteristic(C.On, state.beep);
    }
    if (this.autoPlusAIService) {
      this.autoPlusAIService.updateCharacteristic(C.On, state.autoPlus);
    }
    if (this.standbySensorsService) {
      this.standbySensorsService.updateCharacteristic(C.On, state.standbySensors);
    }
    if (this.backlightService) {
      this.backlightService.updateCharacteristic(C.On, state.backlight);
    }
    if (this.oscillationService) {
      this.oscillationService.updateCharacteristic(C.On, state.oscillation);
    }
    if (this.sleepService) {
      const sleep = sleepPreset(profile);
      const isSleep = !!sleep && state.activePresetId === sleep.id;
      this.sleepService.updateCharacteristic(C.On, isSleep);
    }
  }
}
