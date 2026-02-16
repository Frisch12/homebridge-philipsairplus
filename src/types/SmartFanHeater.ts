import { CharacteristicValue } from 'homebridge';
import { PhilipsAirPlusPlatform } from '../platform.js';

export enum Mode {
    auto = 0,
    high = 65,
    low = 66,
    medium = 67,
    ventilation = -127
  };
  
// Swing values vary by model:
// - CX5120: 17920 (on), 17222 (set command)
// - CX3120: 45 (on)
export const SWING_OFF = 0;

export enum DeviceModel {
  CX5120 = 'CX5120',
  CX3120 = 'CX3120'
}

export interface SwingConfig {
  onValue: number;
  setMultiplier: number;
}

export const SWING_CONFIG: Record<DeviceModel, SwingConfig> = {
  [DeviceModel.CX5120]: { onValue: 17920, setMultiplier: 17222 },
  [DeviceModel.CX3120]: { onValue: 45, setMultiplier: 45 },
};

export enum TemperatureUnit {
  CELSIUS = 0,
  FAHRENHEIT = 1
}

export class SmartFanHeater {
  private D01102: number = 0;
  private Name: string = ''; //name
  private D01S04: string = '';
  private Model: string = ''; //model
  private D01107: number = 0;
  private D01108: number = 3;
  private D01109: number = 3;
  private D0110A: number = 0;
  private D0110B: number = 1;
  private D0110C: number = 33;
  private D0110F: number = 3;
  private FirmwareRevision: string = ''; //firmware
  private D01213: number = 0;
  private ProductId: string = '';
  private DeviceId: string = '';
  private MCUBoot: boolean = true;
  private Runtime: number = 19270641;
  private rssi: number = -48;
  private wifilog: boolean = false;
  private free_memory: number = 57376;
  private WifiVersion: string = '';
  private StatusType: string = '';
  private ConnectType: string = '';
  private Active: boolean = false; // On/Off
  private LightBulb: boolean = false; // Light On/Off
  private D03106: number = 0;
  private D0310A: number = 3;
  private Mode: Mode = Mode.auto; // Mode
  private D0310D: number = 1;
  private TargetTemperature: number = 23; // target temperature
  private SwingModeValue: number = SWING_OFF; // swing mode raw value
  private D03110: number = 0; // Timer
  private CurrentTemperature: number = 210; // current temperature
  private Beep: number = 0; // Beep
  private D0313F: number = 65;
  private D03240: number = 0; // On/Off
  private D03450: number = 1;
  private D03451: number = 0;
  private AutoPlusAI: number = 1; // Auto+ AI
  private D03182: number = 2;
  private D03R81: string = '';
  private TemperatureUnit: TemperatureUnit = TemperatureUnit.CELSIUS;

  // Device model configuration
  private deviceModel: DeviceModel = DeviceModel.CX5120;

  public get swingConfig(): SwingConfig {
    return SWING_CONFIG[this.deviceModel];
  }
    
  constructor (
      public readonly platform: PhilipsAirPlusPlatform,
      json?: string,
      deviceModelOverride?: DeviceModel,
  ) {
    if (deviceModelOverride) {
      this.deviceModel = deviceModelOverride;
    }
    if (json) {
      const data = JSON.parse(json);
      this.D01102 = data.D01102;
      this.Name = data.D01S03;
      this.D01S04 = data.D01S04;
      this.Model = data.D01S05;
      // Auto-detect device model from model string if not overridden
      if (!deviceModelOverride) {
        this.deviceModel = this.detectDeviceModel(this.Model);
      }
      this.D01107 = data.D01107;
      this.D01108 = data.D01108;
      this.D01109 = data.D01109;
      this.D0110A = data.D0110A;
      this.D0110B = data.D0110B;
      this.D0110C = data.D0110C;
      this.D0110F = data.D0110F;
      this.FirmwareRevision = data.D01S12;
      this.TargetTemperature = data.D0310E;
      this.D01213 = data.D01213;
      this.ProductId = data.ProductId;
      this.DeviceId = data.DeviceId;
      this.MCUBoot = data.MCUBoot;
      this.Runtime = data.Runtime;
      this.rssi = data.rssi;
      this.wifilog = data.wifilog;
      this.free_memory = data.free_memory;
      this.WifiVersion = data.WifiVersion;
      this.StatusType = data.StatusType;
      this.ConnectType = data.ConnectType;
      this.Active = data.D03102;
      this.LightBulb = data.D03105 ?? false; // May not exist on all models
      this.D03106 = data.D03106;
      this.D0310A = data.D0310A;
      this.Mode = data.D0310C as Mode;
      this.D0310D = data.D0310D;
      this.TargetTemperature = data.D0310E;
      this.SwingModeValue = data.D0320F ?? SWING_OFF;
      this.D03110 = data.D03110;
      this.CurrentTemperature = data.D03224;
      this.Beep = data.D03130;
      this.D0313F = data.D0313F;
      this.D03240 = data.D03240;
      this.D03450 = data.D03450; // Eco?
      this.D03451 = data.D03451;
      this.AutoPlusAI = data.D03180;
      this.D03182 = data.D03182;
      this.D03R81 = data.D03R81;
    }
  }

  private detectDeviceModel(modelString: string): DeviceModel {
    if (modelString?.startsWith('CX3120')) {
      return DeviceModel.CX3120;
    }
    // Default to CX5120 for other models (including CX5120/11)
    return DeviceModel.CX5120;
  }

  updateObj(json: string) {
    const data = JSON.parse(json);
    this.D01102 = data.D01102;
    this.Name = data.D01S03;
    this.D01S04 = data.D01S04;
    this.Model = data.D01S05;
    this.D01107 = data.D01107;
    this.D01108 = data.D01108;
    this.D01109 = data.D01109;
    this.D0110A = data.D0110A;
    this.D0110B = data.D0110B;
    this.D0110C = data.D0110C;
    this.D0110F = data.D0110F;
    this.FirmwareRevision = data.D01S12;
    this.TargetTemperature = data.D0310E;
    this.D01213 = data.D01213;
    this.ProductId = data.ProductId;
    this.DeviceId = data.DeviceId;
    this.MCUBoot = data.MCUBoot;
    this.Runtime = data.Runtime;
    this.rssi = data.rssi;
    this.wifilog = data.wifilog;
    this.free_memory = data.free_memory;
    this.WifiVersion = data.WifiVersion;
    this.StatusType = data.StatusType;
    this.ConnectType = data.ConnectType;
    this.Active = data.D03102;
    this.LightBulb = data.D03105 ?? false; // May not exist on all models
    this.D03106 = data.D03106;
    this.D0310A = data.D0310A;
    this.Mode = data.D0310C as Mode;
    this.D0310D = data.D0310D;
    this.TargetTemperature = data.D0310E;
    this.SwingModeValue = data.D0320F ?? SWING_OFF;
    this.D03110 = data.D03110;
    this.CurrentTemperature = data.D03224;
    this.Beep = data.D03130;
    this.D0313F = data.D0313F;
    this.D03240 = data.D03240;
    this.D03450 = data.D03450; // Eco?
    this.D03451 = data.D03451;
    this.AutoPlusAI = data.D03180;
    this.D03182 = data.D03182;
    this.D03R81 = data.D03R81;
  }
    
  getName() : string {
    return this.Name;
  }
  
  getModel() : string {
    return this.Model;
  }
  
  getFirmware() : string {
    return this.FirmwareRevision;
  }
  
  getTargetTemperature() : number {    
    return this.TargetTemperature;
    // Homekit uses Celsius internally
    /*if (this.TemperatureUnit === TemperatureUnit.CELSIUS) {
      return this.TargetTemperature;
    } else {
      //°F = °C × (9/5) + 32
      return this.TargetTemperature * (9/5) + 32;
    }*/
  }
  setTargetTemperature(value: number) {
    this.TargetTemperature = value;
  }  
  
  getDeviceId() : string {
    return this.DeviceId;
  }
  
  getStatusType() : string {
    return this.StatusType;
  }
  
  getCurrentTemp() : number {
    return this.CurrentTemperature/10;
    // Homekit uses Celsius internally
    /*
    if (this.TemperatureUnit === TemperatureUnit.CELSIUS) {
      return this.CurrentTemperature/10;
    } else {
      //°F = °C × (9/5) + 32
      return this.CurrentTemperature/10 * (9/5) + 32;
    }
    */
  }
  
  getActive() : boolean {
    return this.Active;
  }
  
  setActive(value: number) {
    this.Active = value > 0;
  }
  
  getLightStatus() : boolean {
    return this.LightBulb;
  }
  
  setLightStatus(value: number) {
    this.LightBulb = value > 0;
  }
  
  isSwingEnabled(): boolean {
    return this.SwingModeValue !== SWING_OFF;
  }

  getSwingModeRawValue(): number {
    return this.SwingModeValue;
  }

  setSwingMode(enabled: boolean) {
    this.SwingModeValue = enabled ? this.swingConfig.onValue : SWING_OFF;
  }

  getDeviceModel(): DeviceModel {
    return this.deviceModel;
  }

  hasBacklight(): boolean {
    // CX3120 models don't have backlight control via D03105
    return this.deviceModel !== DeviceModel.CX3120;
  }
  
  toString() : string {
    return JSON.stringify(this);
  }
  
  getBeepStatus() : boolean {
    return this.Beep > 0;
  }
  
  setBeepStatus(value: number) {
    this.Beep = value > 0 ? 100 : 0;
  }
  
  getAutoPlusAIStatus() : boolean {
    return this.AutoPlusAI === 1;
  }
  
  setAutoPlusAIStatus(value: number) {
    this.AutoPlusAI = value;
  }

  getMode() : Mode {
    return this.Mode;
  }

  setMode(value: Mode) {
    this.Mode = value;
  }

  setTemperatureUnit(value: CharacteristicValue) {
    this.TemperatureUnit = value as TemperatureUnit;    
  }

  getTemperatureUnit() {
    return this.TemperatureUnit;
  }
}