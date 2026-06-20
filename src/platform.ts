import { type API, type Characteristic, type DynamicPlatformPlugin,
  type Logging, type PlatformAccessory, type PlatformConfig, type Service } from 'homebridge';
import { exec, execFile } from 'node:child_process';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { SmartFanHeaterAccessory } from './smartFanHeaterAccessory.js';
import { AirPurifierAccessory } from './airPurifierAccessory.js';
import { normaliseCustomProfile, profileToJSON, resolveProfile } from './profiles/registry.js';
import { BUILTIN_PROFILES } from './profiles/builtin.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export enum DeviceType {
  heater = 'heater',
  purifier = 'purifier',
  auto = 'auto',
}

/** Model prefixes known to be heaters (Thermostat-style accessory). */
const HEATER_MODEL_PREFIXES = ['CX3120', 'CX5120'];

function detectDeviceTypeFromModel(model: string | undefined): DeviceType {
  if (!model) {
    return DeviceType.purifier;
  }
  const upper = model.toUpperCase();
  return HEATER_MODEL_PREFIXES.some(p => upper.startsWith(p))
    ? DeviceType.heater
    : DeviceType.purifier;
}

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class PhilipsAirPlusPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: Map<string, PlatformAccessory> = new Map();
  public readonly discoveredCacheUUIDs: string[] = [];

  // Flag to track if phipsair is available
  private phipsairAvailable: boolean = false;

  // Stable anonymous guest id for the Philips cloud (AWS-IoT shadow source),
  // generated once and persisted; shared across all devices of this install.
  private guestId: string | undefined;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    log.debug('Config:', JSON.stringify(config));

    log.debug('Finished initializing platform:', this.config.name);

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', async () => {
      log.debug('Executed didFinishLaunching callback');

      // Check if phipsair is installed
      this.phipsairAvailable = await this.checkPhipsair();

      if (!this.phipsairAvailable) {
        log.error('phipsair is not installed! Please install it with: pip3 install phipsair');
        log.error('The plugin will not work without phipsair.');
        return;
      }

      // run the method to discover / register your devices as accessories
      await this.discoverDevices();
    });
  }

  /**
   * Check if phipsair is installed and available
   */
  async checkPhipsair(): Promise<boolean> {
    try {
      await execAsync('which phipsair');
      this.log.info('phipsair found');
      return true;
    } catch {
      // Try with python module check as fallback
      try {
        await execAsync('python3 -c "import phipsair"');
        this.log.info('phipsair module found');
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * Return a stable anonymous guest id for the Philips cloud, generating and
   * persisting one on first use. Stored in Homebridge's storage path so the
   * same anonymous enduser (and its device bindings) survives restarts.
   * Shared across all devices so a single enduser owns all bindings.
   */
  getGuestId(): string {
    if (this.guestId) {
      return this.guestId;
    }
    const file = path.join(this.api.user.storagePath(), '.philips-airplus-guest-id');
    try {
      const existing = fs.readFileSync(file, 'utf8').trim();
      if (/^[0-9a-f]{32}$/.test(existing)) {
        this.guestId = existing;
        return existing;
      }
    } catch {
      // file does not exist yet — fall through and create it
    }
    const id = randomBytes(16).toString('hex');
    try {
      fs.writeFileSync(file, id, { mode: 0o600 });
      this.log.info(`Generated Philips cloud guest id (stored in ${file}).`);
    } catch (e) {
      this.log.warn(`Could not persist guest id (${(e as Error).message}); using a session-only id.`);
    }
    this.guestId = id;
    return id;
  }

  /**
   * Fetch device info via the daemon's `info` sub-command, which calls
   * Philips' `/sys/dev/info` endpoint directly. Unlike status / observe,
   * info is a plain GET that the device always answers — observe-style
   * requests only push frames on state changes, which is useless for
   * startup-time auto-detect.
   */
  async fetchDeviceInfo(
    ipAddress: string,
    port: number = 5683,
  ): Promise<{ deviceId: string; model: string } | null> {
    try {
      this.log.info(`Fetching device info from ${ipAddress}:${port}...`);
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      const helper = path.resolve(__dirname, '../lib/phipsair_info.py');
      const { stdout } = await execFileAsync(
        'python3',
        [helper, '--host', ipAddress, '--port', String(port)],
        { timeout: 15000 },
      );
      const data = JSON.parse(stdout) as Record<string, string>;
      const deviceId = data.device_id;
      const model = data.modelid || 'Unknown';
      if (!deviceId) {
        this.log.error(`phipsair info response missing device_id for ${ipAddress}: ${stdout}`);
        return null;
      }
      this.log.info(`Device detected: ${model} (ID: ${deviceId})`);
      return { deviceId, model };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log.error(`Failed to fetch info from ${ipAddress}: ${msg}`);
      return null;
    }
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to set up event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    
    // add the restored accessory to the accessories cache, so we can track if it has already been registered
    this.accessories.set(accessory.UUID, accessory);
  }

  /**
   * This is an example method showing how to register discovered accessories.
   * Accessories must only be registered once, previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  async discoverDevices() {
    // loop over the discovered devices and register each one if it has not already been registered
    for (const device of this.config.devices) {
      this.log.debug('Processing device:', JSON.stringify(device));

      if (!device.active) {
        this.log.debug('Device inactive, continuing...');
        continue;
      }

      // Auto-detect deviceId / model if not provided
      let deviceId = device.deviceId;
      let detectedModel: string | undefined;
      const needsAutoDetect = !deviceId || (device.deviceType ?? 'auto') === DeviceType.auto;
      if (needsAutoDetect && device.ip_address) {
        this.log.info(`Auto-detecting device info for ${device.name}...`);
        const info = await this.fetchDeviceInfo(device.ip_address, device.port || 5683);
        if (info) {
          deviceId = deviceId ?? info.deviceId;
          detectedModel = info.model;
          device.deviceId = deviceId;
          this.log.info(`Detected: deviceId=${deviceId}, model=${detectedModel}`);
        } else if (!deviceId) {
          this.log.error(`Failed to auto-detect deviceId for ${device.name}. Please check the IP address or provide deviceId manually.`);
          continue;
        }
      }

      if (!deviceId) {
        this.log.error(`No deviceId for ${device.name} and no ip_address to auto-detect. Skipping.`);
        continue;
      }

      // Cache the detected model on the device config so the profile resolver
      // can use it without re-running auto-detect.
      if (detectedModel) {
        device.detectedModel = detectedModel;
      }

      // Resolve effective device type
      const configuredType = (device.deviceType ?? DeviceType.auto) as DeviceType;
      const effectiveType = configuredType === DeviceType.auto
        ? detectDeviceTypeFromModel(detectedModel ?? device.model)
        : configuredType;
      device.effectiveDeviceType = effectiveType;
      this.log.info(`Device "${device.name}" → type=${effectiveType}`);

      // generate a unique id for the accessory this should be generated from
      // something globally unique, but constant, for example, the device serial
      // number or MAC address
      const uuid = this.api.hap.uuid.generate(deviceId);


      // see if an accessory with the same uuid has already been registered and restored from
      // the cached devices we stored in the `configureAccessory` method above
      const existingAccessory = this.accessories.get(uuid);

      if (existingAccessory) {
        // the accessory already exists
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);

        // if you need to update the accessory.context then you should run `api.updatePlatformAccessories`. e.g.:
        this.log.debug('Updating existing accessory from cache:', JSON.stringify(existingAccessory.context.device), JSON.stringify(device));
        existingAccessory.context.device = device;
        this.api.updatePlatformAccessories([existingAccessory]);

        // create the accessory handler for the restored accessory
        this.instantiateAccessory(effectiveType, existingAccessory);

        // it is possible to remove platform accessories at any time using `api.unregisterPlatformAccessories`, e.g.:
        // remove platform accessories when no longer present
        // this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory]);
        // this.log.info('Removing existing accessory from cache:', existingAccessory.displayName);
      } else {
        // the accessory does not yet exist, so we need to create it
        this.log.info('Adding new accessory:', device.name);

        // create a new accessory
        const accessory = new this.api.platformAccessory(device.name, uuid);

        // store a copy of the device object in the `accessory.context`
        // the `context` property can be used to store any data about the accessory you may need
        accessory.context.device = device;

        // create the accessory handler for the newly created accessory
        this.instantiateAccessory(effectiveType, accessory);

        // link the accessory to your platform
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }

      // push into discoveredCacheUUIDs
      this.discoveredCacheUUIDs.push(uuid);
    }

    this.cleanupStaleAccessories();
  }

  /** Pick the right accessory handler based on the resolved device type. */
  private instantiateAccessory(type: DeviceType, accessory: PlatformAccessory) {
    if (type === DeviceType.heater) {
      new SmartFanHeaterAccessory(this, accessory);
      return;
    }
    const device = accessory.context.device ?? {};
    const { profile: customProfile, issues } = normaliseCustomProfile(device.customProfile);
    for (const issue of issues) {
      this.log.warn(`Custom profile for "${device.name}": ${issue}`);
    }
    const resolved = resolveProfile({
      model: device.model ?? 'auto',
      detectedModel: device.detectedModel ?? device.model,
      customProfile,
    });
    if (!resolved) {
      this.log.error(
        `Cannot resolve a device profile for "${device.name}". Set "model" to one of: ` +
        Object.keys(BUILTIN_PROFILES).join(', ') + ', or "Custom" with a full customProfile.',
      );
      return;
    }
    this.log.debug(
      `Effective profile for "${device.name}" =\n${profileToJSON(resolved.profile)}`,
    );
    if (device.printProfile) {
      this.log.info(
        `Profile snapshot for "${device.name}":\n${profileToJSON(resolved.profile)}`,
      );
    }
    new AirPurifierAccessory(this, accessory, resolved.profile);
  }

  private cleanupStaleAccessories() {
    // deal with accessories from the cache which are no longer present by removing them from Homebridge
    // for example, if your plugin logs into a cloud account to retrieve a device list, and a user has previously removed a device
    // from this cloud account, then this device will no longer be present in the device list but will still be in the Homebridge cache
    for (const [uuid, accessory] of this.accessories) {
      if (!this.discoveredCacheUUIDs.includes(uuid)) {
        this.log.info('Removing existing accessory from cache:', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }
}
