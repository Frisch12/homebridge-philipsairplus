import { PlatformAccessory, Service, type CharacteristicValue } from 'homebridge';

import { PhilipsAirPlusPlatform } from './platform.js';
import { AirControlHandler } from './airControlHandler.js';
import { Mode, SmartFanHeater, Swing } from './types/SmartFanHeater.js';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class ThermostatAccessory extends AirControlHandler {
  private thermostatService: Service | undefined; 
  private swingService: Service | undefined;
  private lightService: Service | undefined;
  private beepService: Service | undefined;
  private autoPlusAIService: Service | undefined;

  obj?: SmartFanHeater = undefined;

  constructor(
    public readonly platform: PhilipsAirPlusPlatform,
    public readonly accessory: PlatformAccessory,
  ) {
    super(platform, accessory);
    // read status from device
    this.initAccessory();    
  }

  handleError(error: unknown, message?: string) {
    if (typeof error === 'string') {
      this.platform.log.error('handleError():', message!, error, this.accessory.displayName);
    } else if (error instanceof Error) {
      this.platform.log.error('handleError():', message!,(error as Error).message, (error as Error).stack, this.accessory.displayName);
    } else {
      this.platform.log.error('handleError(): Error with unknown type.', JSON.stringify(error), this.accessory.displayName);
    }
  }

  async initAccessory() {
    try {     
      const args = [...this.args];
      args.push('status', '-J');
      await this.sendCommand(args, 60, true);      
    } catch (error) {
      this.handleError(error,'initAccessory():');
    }
  }  

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, turning on a Light bulb.
   */
  async setActive(value: CharacteristicValue) {    
    if (this.thermostatService && this.obj) {
      this.platform.log.debug(`setActive(${value})`, this.accessory.displayName);
    
      try {
        const args = [...this.args];
        args.push('set', `D03102=${value}`,'-I');
        this.obj.setActive(value as number);
        this.thermostatService.updateCharacteristic(this.platform.Characteristic.Active, value);        
        await this.sendCommand(args, 60);
      } catch (error) {
        this.handleError(error, `setActive(${value}):`);
      }
    } else {
      this.platform.log.error(`setActive(${value}): No service or object`, this.accessory.displayName);
    }
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, turning on a Light bulb.
   */
  async setSwingMode(value: CharacteristicValue) {    
    if (this.thermostatService && this.obj) {
      this.platform.log.debug(`setSwingMode(${value})`, this.accessory.displayName);
    
      try {
        const args = [...this.args];
        args.push('set', `D0320F=${(value as number * this.obj.SwingModeSetValue)}`,'-I');
        this.obj.setSwingMode(value as number);
        this.thermostatService.updateCharacteristic(this.platform.Characteristic.SwingMode, value);        
        await this.sendCommand(args, 60);
      } catch (error) {
        this.handleError(error, `setSwingMode(${value}):`);
      }
    } else {
      this.platform.log.error(`setSwingMode(${value}): No service or object`, this.accessory.displayName);
    }
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, turning on a Light bulb.
   */
  async setLight(value: CharacteristicValue) {    
    if (this.lightService && this.obj) {
      this.platform.log.debug(`setLight(${value})`, this.accessory.displayName);
    
      try {
        const args = [...this.args];
        args.push('set', `D03105=${value}`,'-I');
        this.obj.setLightStatus(value as number);
        this.lightService.updateCharacteristic(this.platform.Characteristic.On, value);        
        await this.sendCommand(args, 60);
      } catch (error) {
        this.handleError(error, `setLight(${value}):`);
      }
    } else {
      this.platform.log.error(`setLight(${value}): No service or object`, this.accessory.displayName);
    }
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, turning on a Light bulb.
   */
  async setBeep(value: CharacteristicValue) {    
    if (this.beepService && this.obj) {
      this.platform.log.debug(`setBeep(${value})`, this.accessory.displayName);
    
      try {
        const args = [...this.args];
        args.push('set', `D03130=${(value as number > 0)?100:0}`,'-I');
        this.obj.setBeepStatus(value as number);
        this.beepService.updateCharacteristic(this.platform.Characteristic.On, value);        
        await this.sendCommand(args, 60);
      } catch (error) {
        this.handleError(error, `setBeep(${value}):`);
      }
    } else {
      this.platform.log.error(`setBeep(${value}): No service or object`, this.accessory.displayName);
    }
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, turning on a Light bulb.
   */
  async setAutoPlusAI(value: CharacteristicValue) {    
    if (this.autoPlusAIService && this.obj) {
      this.platform.log.debug(`setAutoPlusAI(${value})`, this.accessory.displayName);
    
      try {
        const args = [...this.args];
        args.push('set', `D03180=${value}`,'-I');
        this.obj.setAutoPlusAIStatus(value as number);
        this.autoPlusAIService.updateCharacteristic(this.platform.Characteristic.On, value);        
        await this.sendCommand(args, 60);
      } catch (error) {
        this.handleError(error, `setAutoPlusAI(${value}):`);
      }
    } else {
      this.platform.log.error(`setAutoPlusAI(${value}): No service or object`, this.accessory.displayName);
    }
  }


  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, turning on a Light bulb.
   */
  async setTemperatureUnits(value: CharacteristicValue) {
    if (this.thermostatService && this.obj) {
      this.platform.log.debug(`setTemperatureUnits(${value})`, this.accessory.displayName);
    
      try {
        this.obj.setTemperatureUnit(value as number);
        this.thermostatService.updateCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits, value);
        this.thermostatService.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.obj.getCurrentTemp());
        const c = this.thermostatService.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature);
        if (c) {
          this.thermostatService.updateCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature, 
            this.obj.getTargetTemperature());
        }
      } catch (error) {
        this.handleError(error, `setTemperatureUnits(${value}):`);
      }
    } else {
      this.platform.log.error(`setTemperatureUnits(${value}): No service or object`, this.accessory.displayName);
    }
  }


  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, turning on a Light bulb.
   */
  async setTargetTemperature(value: CharacteristicValue) {    
    if (this.thermostatService && this.obj) {
      this.platform.log.debug(`setTargetTemperature(${value})`, this.accessory.displayName);
    
      try {
        const args = [...this.args];
        args.push('set', `D0310E=${value}`,'-I');
        this.obj.setTargetTemperature(value as number);
        await this.sendCommand(args, 60);
      } catch (error) {
        this.handleError(error, `setTargetTemperature(${value}):`);
      }
    } else {
      this.platform.log.error(`setTargetTemperature(${value}): No service or object`, this.accessory.displayName);
    }
  }

  
  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, turning on a Light bulb.
   */
  async setMode(value: Mode) {    
    if (this.thermostatService && this.obj) {
      this.platform.log.debug(`setMode(${value})`, this.accessory.displayName);
      
      try {
        const args = [...this.args];
        args.push('set', `D0310C=${value}`,'-I');
        this.obj.setMode(value);
        await this.sendCommand(args, 60);
      } catch (error) {
        this.handleError(error, `setMode(${value}):`);
      }
    } else {
      this.platform.log.error(`setMode(${value}): No service or object`, this.accessory.displayName);
    }
  }
  
  async setCurrentHeatingCoolingState(value: CharacteristicValue) {
    if (this.thermostatService && this.obj) {
      this.platform.log.debug(`setCurrentHeatingCoolingState(${value})`, this.accessory.displayName);
      switch(value){
      case this.platform.Characteristic.CurrentHeatingCoolingState.OFF:
        await this.setActive(this.platform.Characteristic.Active.INACTIVE);
        break;
      case this.platform.Characteristic.CurrentHeatingCoolingState.COOL:
        await this.setActive(this.platform.Characteristic.Active.ACTIVE);
        await this.setMode(Mode.ventilation);
        break;
      case this.platform.Characteristic.CurrentHeatingCoolingState.HEAT:
        await this.setActive(this.platform.Characteristic.Active.ACTIVE);
        await this.setMode(Mode.high);
        break;
      }
    } else {
      this.platform.log.error(`setCurrentHeatingCoolingState(${value}): No service or object`, this.accessory.displayName);
    }
  }

  async setTargetHeatingCoolingState(value: CharacteristicValue) {
    if (this.thermostatService && this.obj) {
      this.platform.log.debug(`setTargetHeatingCoolingState(${value})`, this.accessory.displayName);

      switch(value){
      case this.platform.Characteristic.TargetHeatingCoolingState.OFF:
        await this.setActive(this.platform.Characteristic.Active.INACTIVE);
        break;
      case this.platform.Characteristic.TargetHeatingCoolingState.COOL:
        await this.setActive(this.platform.Characteristic.Active.ACTIVE);
        await this.setMode(Mode.ventilation);
        break;
      case this.platform.Characteristic.TargetHeatingCoolingState.HEAT:
        await this.setActive(this.platform.Characteristic.Active.ACTIVE);
        await this.setMode(Mode.high);
        break;
      case this.platform.Characteristic.TargetHeatingCoolingState.AUTO:
        await this.setActive(this.platform.Characteristic.Active.ACTIVE);
        await this.setMode(Mode.auto);
        break;
      }

    } else {
      this.platform.log.error(`setTargetHeatingCoolingState(${value}): No service or object`, this.accessory.displayName);
    }
  }

  async onCmdData(data: string, startPoll: boolean) {
    data = data.toString().replace(/\n$/, '');
    this.platform.log.debug('onCmdData:', data, this.accessory.displayName);
    try {
      this.obj = new SmartFanHeater(this.platform, data);      
    
      // set accessory information
      this.accessory.getService(this.platform.Service.AccessoryInformation)!
        .setCharacteristic(this.platform.Characteristic.Manufacturer, this.manufacturer)
        .setCharacteristic(this.platform.Characteristic.Model, this.obj.getModel())
        .setCharacteristic(this.platform.Characteristic.SerialNumber, this.serialNumber)
        .setCharacteristic(this.platform.Characteristic.FirmwareRevision, this.obj.getFirmware());
      
      // get the HeaterCooler service if it exists, otherwise create a new HeaterCooler service
      this.thermostatService = this.accessory.getService(this.platform.Service.Thermostat) || 
      this.accessory.addService(this.platform.Service.Thermostat, this.obj.getName());

      const tempCharacteristic = this.thermostatService.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits) ||
        this.thermostatService.setCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits, 
          this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS);

      this.obj.setTemperatureUnit(tempCharacteristic.value || this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS);
      tempCharacteristic
        .onSet(this.setTemperatureUnits.bind(this));

      // Required Characteristics
      // each service must implement at-minimum the "required characteristics" for the given service type
      // see https://developers.homebridge.io/#/service/Thermostat

      if (!this.obj.getActive()) {
        this.thermostatService.updateCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState,
          this.platform.Characteristic.CurrentHeatingCoolingState.OFF);
        this.thermostatService.updateCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState, 
          this.platform.Characteristic.TargetHeatingCoolingState.OFF);
      } else {
        switch(this.obj.getMode()) {
        case Mode.auto:
          this.thermostatService.updateCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState,
            this.platform.Characteristic.CurrentHeatingCoolingState.HEAT);
          this.thermostatService.updateCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState, 
            this.platform.Characteristic.TargetHeatingCoolingState.AUTO);
          break;
        case Mode.ventilation:
          this.thermostatService.updateCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState,
            this.platform.Characteristic.CurrentHeatingCoolingState.COOL);
          this.thermostatService.updateCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState, 
            this.platform.Characteristic.TargetHeatingCoolingState.COOL);
          break;
        default:
          this.thermostatService.updateCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState,
            this.platform.Characteristic.CurrentHeatingCoolingState.HEAT);
          this.thermostatService.updateCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState, 
            this.platform.Characteristic.TargetHeatingCoolingState.HEAT);
          break;
        }
      }

      this.thermostatService.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
        .onSet(this.setCurrentHeatingCoolingState.bind(this));

      this.thermostatService.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
        .onSet(this.setTargetHeatingCoolingState.bind(this));

      this.thermostatService.setCharacteristic(this.platform.Characteristic.CurrentTemperature, this.obj.getCurrentTemp());

      this.thermostatService.setCharacteristic(this.platform.Characteristic.TargetTemperature, this.obj.getTargetTemperature());
      this.thermostatService.getCharacteristic(this.platform.Characteristic.TargetTemperature)
        .onSet(this.setTargetTemperature.bind(this));

      // Optional Characteristics

      this.thermostatService.setCharacteristic(this.platform.Characteristic.Name, this.obj.getName());
      
      // Map the beep function to a Switch
      // get the Beep Switch service if it exists, otherwise create a new Switch service    
      this.swingService = this.accessory.getService('Swing') ||
        this.accessory.addService(this.platform.Service.Switch, 'Swing', 'SWING');

      // Required Characteristics
      // each service must implement at-minimum the "required characteristics" for the given service type
      // see https://developers.homebridge.io/#/service/Switch
      this.swingService.setCharacteristic(this.platform.Characteristic.On, this.obj.getSwingMode() === Swing.on);

      this.swingService.getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.setSwingMode.bind(this));

      // Optional Characteristics
      this.swingService.setCharacteristic(this.platform.Characteristic.Name, 'Swing');

      // Map backligh to a Lightbulb
      // get the Lightbulb service if it exists, otherwise create a new Lightbulb service    
      this.lightService = this.accessory.getService('Backlight') ||
        this.accessory.addService(this.platform.Service.Lightbulb, 'Backlight', 'BACKLIGHT');

      // Required Characteristics
      // each service must implement at-minimum the "required characteristics" for the given service type
      // see https://developers.homebridge.io/#/service/Lightbulb
      this.lightService.setCharacteristic(this.platform.Characteristic.On, this.obj.getLightStatus() ? 1 : 0);

      this.lightService.getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.setLight.bind(this));

      // Optional Characteristics
      this.lightService.setCharacteristic(this.platform.Characteristic.Name, 'Backlight');

      // Map the beep function to a Switch
      // get the Beep Switch service if it exists, otherwise create a new Switch service    
      this.beepService = this.accessory.getService('Beep') ||
        this.accessory.addService(this.platform.Service.Switch, 'Beep', 'BEEP');

      // Required Characteristics
      // each service must implement at-minimum the "required characteristics" for the given service type
      // see https://developers.homebridge.io/#/service/Switch
      this.beepService.setCharacteristic(this.platform.Characteristic.On, this.obj.getBeepStatus());

      this.beepService.getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.setBeep.bind(this));

      // Optional Characteristics
      this.beepService.setCharacteristic(this.platform.Characteristic.Name, 'Beep');
      
      // Map the Auto+ AI function to a Switch
      // get the Auto Plus Switch service if it exists, otherwise create a new Switch service    
      this.autoPlusAIService = this.accessory.getService('Auto Plus AI') ||
        this.accessory.addService(this.platform.Service.Switch, 'Auto Plus AI', 'AUTO_PLUS_AI');

      // Required Characteristics
      // each service must implement at-minimum the "required characteristics" for the given service type
      // see https://developers.homebridge.io/#/service/Switch
      this.autoPlusAIService.setCharacteristic(this.platform.Characteristic.On, this.obj.getAutoPlusAIStatus());

      this.autoPlusAIService.getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.setAutoPlusAI.bind(this));

      // Optional Characteristics
      this.autoPlusAIService.setCharacteristic(this.platform.Characteristic.Name, 'Auto Plus AI');

      // Start Polling
      if (startPoll) {
        this.longPoll();
      }
    
    } catch(error) {
      this.handleError(error, 'onCmdData(...):');
    }
  }

  async onData(data: string) {
    data = data.toString().replace(/\n$/, '');
    this.platform.log.debug(`onData: ${data}`, this.accessory.displayName);
    try {

      // get the HeaterCooler service if it exists, otherwise create a new HeaterCooler service
      // you can create multiple services for each accessory
      this.thermostatService = this.accessory.getService(this.platform.Service.Thermostat) || 
        this.accessory.addService(this.platform.Service.Thermostat);

      // Update object
      if (this.obj) {
        this.obj.updateObj(data);
      } else {
        this.obj = new SmartFanHeater(this.platform, data);
        const tempCharacteristic = this.thermostatService.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits) ||
        this.thermostatService.setCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits, 
          this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS);
        this.obj.setTemperatureUnit(tempCharacteristic.value || this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS);
      }

      // set accessory information
      this.accessory.getService(this.platform.Service.AccessoryInformation)!
        .updateCharacteristic(this.platform.Characteristic.FirmwareRevision, this.obj.getFirmware());
            
      // Required Characteristics
      if (!this.obj.getActive()) {
        this.thermostatService.updateCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState,
          this.platform.Characteristic.CurrentHeatingCoolingState.OFF);
        this.thermostatService.updateCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState, 
          this.platform.Characteristic.TargetHeatingCoolingState.OFF);
      } else {
        switch(this.obj.getMode()) {
        case Mode.auto:
          this.thermostatService.updateCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState,
            this.platform.Characteristic.CurrentHeatingCoolingState.HEAT);
          this.thermostatService.updateCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState, 
            this.platform.Characteristic.TargetHeatingCoolingState.AUTO);
          break;
        case Mode.ventilation:
          this.thermostatService.updateCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState,
            this.platform.Characteristic.CurrentHeatingCoolingState.COOL);
          this.thermostatService.updateCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState, 
            this.platform.Characteristic.TargetHeatingCoolingState.COOL);
          break;
        default:
          this.thermostatService.updateCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState,
            this.platform.Characteristic.CurrentHeatingCoolingState.HEAT);
          this.thermostatService.updateCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState, 
            this.platform.Characteristic.TargetHeatingCoolingState.HEAT);
          break;
        }
      }
      this.thermostatService.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.obj.getCurrentTemp());      
      this.thermostatService.setCharacteristic(this.platform.Characteristic.TargetTemperature, this.obj.getTargetTemperature());
      
      // Optional Characteristics
      this.thermostatService.updateCharacteristic(this.platform.Characteristic.Name, this.obj.getName());

      // Light and buttons
      this.swingService = this.accessory.getService('Swing') ||
        this.accessory.addService(this.platform.Service.Switch, 'Swing', 'SWING');

      this.swingService.updateCharacteristic(this.platform.Characteristic.On, this.obj.getSwingMode() === Swing.on);

      this.lightService = this.accessory.getService('Backlight') ||
        this.accessory.addService(this.platform.Service.Lightbulb, 'Backlight', 'BACKLIGHT');

      this.lightService.updateCharacteristic(this.platform.Characteristic.On, this.obj.getLightStatus());

      this.beepService = this.accessory.getService('Beep') ||
        this.accessory.addService(this.platform.Service.Switch, 'Beep', 'BEEP');

      this.beepService.updateCharacteristic(this.platform.Characteristic.On, this.obj.getBeepStatus());
      
      this.autoPlusAIService = this.accessory.getService('Auto Plus AI') ||
        this.accessory.addService(this.platform.Service.Switch, 'Auto Plus AI', 'AUTO_PLUS_AI');

      this.autoPlusAIService.updateCharacteristic(this.platform.Characteristic.On, this.obj.getAutoPlusAIStatus());

    } catch(error) {
      this.handleError(error, 'onData(...):');
    }
  }
}

