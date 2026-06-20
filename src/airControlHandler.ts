import { ChildProcess, spawn } from 'node:child_process';
import { IPv4Address, PlatformAccessory } from 'homebridge';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PhilipsAirPlusPlatform } from './platform.js';


/**
 * Long-lived helper for a single Philips NEW2 device.
 *
 * Wraps `lib/phipsair_daemon.py`, which keeps a CoAP observe subscription
 * open and sends periodic sync keepalives — phipsair's stock CLI cannot do
 * either (it spawns one process per command and observes only briefly).
 *
 * Communication: JSON Lines over the daemon's stdin/stdout.
 *  - We receive `{type: "status", data: {...}}` for every observe frame.
 *  - We receive `{type: "set_result", data: {...}, ok: true|false}` after each set.
 *  - We send `{type: "set", data: {...}}` to perform writes, or
 *    `{type: "shutdown"}` to ask the daemon to exit cleanly.
 */
export abstract class AirControlHandler {
  manufacturer: string = 'Philips';
  serialNumber: string = '0000';
  ipAddress: IPv4Address;
  port: number;
  debug: boolean = false;
  displayName: string = '';
  /** Path to the python interpreter we invoke (e.g. `python3`). */
  protected pythonBin: string;
  /** Absolute path to lib/phipsair_daemon.py. */
  protected daemonScript: string;
  /** Cloud (AWS-IoT thing name == local device id) for the shadow source. */
  protected cloudDeviceId: string | undefined;
  /** Stable anonymous guest id for the Philips cloud (shared across devices). */
  protected guestId: string | undefined;
  /** Whether the cloud shadow status source is enabled for this device. */
  protected cloudEnabled: boolean = true;
  protected keepaliveSec: number;

  private daemonProc: ChildProcess | undefined;
  private shutdownRequested: boolean = false;
  private stdoutBuffer: string = '';
  private restartTimer: NodeJS.Timeout | undefined;

  /**
   * Coalescing buffer for outbound writes. HomeKit (and especially Siri)
   * frequently sets multiple characteristics on the same accessory in one
   * go — e.g. Active+RotationSpeed when asked to "set fan to 33%". Each
   * onSet handler used to fire its own CoAP write, which made the device
   * beep per write and opened a race when two writes targeted the same
   * key from different presets. We now collect everything that arrives
   * within COALESCE_WINDOW_MS into a single atomic set.
   */
  private pendingSet: Record<string, number> = {};
  private flushTimer: NodeJS.Timeout | undefined;
  private static readonly COALESCE_WINDOW_MS = 50;

  constructor(
    public readonly platform: PhilipsAirPlusPlatform,
    public readonly accessory: PlatformAccessory,
  ) {
    const device = accessory.context.device ?? {};
    this.ipAddress = device.ip_address;
    this.port = device.port || 5683;
    this.serialNumber = device.serialNumber || '0000';
    this.debug = device.debug || false;
    this.displayName = device.name;
    this.pythonBin = device.pythonBin || 'python3';
    // Cloud (AWS-IoT shadow) status source. The device id doubles as the
    // AWS-IoT thing name; the guest id is a stable per-install anonymous
    // identity shared across all devices. Disabled per-device via `cloudStatus`.
    this.cloudDeviceId = device.deviceId;
    this.cloudEnabled = device.cloudStatus !== false;
    this.guestId = this.cloudEnabled ? this.platform.getGuestId() : undefined;
    this.keepaliveSec = Number(device.keepaliveSec ?? 5);
    if (!Number.isFinite(this.keepaliveSec) || this.keepaliveSec < 1) {
      this.keepaliveSec = 5;
    }

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    this.daemonScript = path.resolve(__dirname, '../lib/phipsair_daemon.py');

    this.platform.api.on('shutdown', () => {
      this.shutdown();
    });
  }

  // ---------- abstract surface for subclasses ----------

  /**
   * Called for every `{type: "status", data: {...}}` frame received from
   * the daemon — i.e. every observe push that arrives because something
   * on the device changed state.
   */
  abstract onPollData(json: string): Promise<void>;

  /**
   * Called after each set: ok=true on success, ok=false otherwise. Default
   * implementation just logs; subclasses can override for richer handling.
   */
  async onSetResult(data: Record<string, number>, ok: boolean, error?: string): Promise<void> {
    if (!ok) {
      this.platform.log.warn(
        `set ${JSON.stringify(data)} failed${error ? `: ${error}` : ''}`,
        this.accessory.displayName,
      );
    } else {
      this.platform.log.debug(`set ${JSON.stringify(data)} ok`, this.accessory.displayName);
    }
  }

  // ---------- daemon management ----------

  /**
   * Start the daemon if it is not already running. Subclasses call this
   * once they have finished registering HomeKit services.
   */
  protected startDaemon(): void {
    if (this.daemonProc || this.shutdownRequested) {
      return;
    }
    const args = [
      this.daemonScript,
      '--host', String(this.ipAddress),
      '--port', String(this.port),
      '--keepalive-sec', String(this.keepaliveSec),
    ];
    // Enable the cloud shadow status source when we have a stable guest id and
    // the device's cloud id. This is what gives a reliable initial state and
    // change pushes for CX-series devices that won't serve local status cold.
    if (this.cloudEnabled && this.guestId) {
      args.push('--guest-id', this.guestId);
      if (this.cloudDeviceId) {
        args.push('--device-id', String(this.cloudDeviceId));
      }
    }
    this.platform.log.info('Starting daemon:', this.accessory.displayName);
    this.platform.log.debug(`Daemon cmd: ${this.pythonBin} ${args.join(' ')}`, this.accessory.displayName);

    const proc = spawn(this.pythonBin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.daemonProc = proc;

    proc.stdout?.on('data', (chunk: Buffer) => this.onStdoutChunk(chunk));
    proc.stderr?.on('data', (chunk: Buffer) => {
      const txt = chunk.toString().trim();
      if (txt) {
        this.platform.log.warn(`daemon stderr: ${txt}`, this.accessory.displayName);
      }
    });
    proc.on('error', (err) => {
      this.platform.log.error(`daemon spawn error: ${err.message}`, this.accessory.displayName);
    });
    proc.on('exit', (code, signal) => {
      this.daemonProc = undefined;
      this.stdoutBuffer = '';
      if (this.shutdownRequested) {
        this.platform.log.debug(`daemon exited cleanly (code=${code} signal=${signal})`,
          this.accessory.displayName);
        return;
      }
      this.platform.log.warn(
        `daemon exited unexpectedly (code=${code} signal=${signal}) — restarting in 5 s`,
        this.accessory.displayName,
      );
      this.restartTimer = setTimeout(() => {
        this.restartTimer = undefined;
        if (!this.shutdownRequested) {
          this.startDaemon();
        }
      }, 5000);
    });
  }

  private onStdoutChunk(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString();
    let nl: number;
    while ((nl = this.stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.stdoutBuffer.substring(0, nl).trim();
      this.stdoutBuffer = this.stdoutBuffer.substring(nl + 1);
      if (line) {
        this.handleDaemonLine(line);
      }
    }
  }

  private async handleDaemonLine(line: string): Promise<void> {
    let msg: { type?: string; data?: unknown; ok?: boolean; error?: string; level?: string; message?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      this.platform.log.debug(`daemon: non-JSON line ${line.slice(0, 200)}`, this.accessory.displayName);
      return;
    }
    switch (msg.type) {
    case 'ready':
      this.platform.log.info('daemon ready', this.accessory.displayName);
      break;
    case 'status':
      try {
        await this.onPollData(JSON.stringify(msg.data ?? {}));
      } catch (err) {
        this.platform.log.error(
          `onPollData failed: ${err instanceof Error ? err.message : String(err)}`,
          this.accessory.displayName,
        );
      }
      break;
    case 'set_result': {
      const data = (msg.data ?? {}) as Record<string, number>;
      await this.onSetResult(data, msg.ok ?? false, msg.error);
      break;
    }
    case 'log':
      // Forward daemon's internal log into homebridge's log at matching level
      switch (msg.level) {
      case 'warn':
        this.platform.log.warn(`daemon: ${msg.message ?? ''}`, this.accessory.displayName);
        break;
      case 'info':
        this.platform.log.info(`daemon: ${msg.message ?? ''}`, this.accessory.displayName);
        break;
      default:
        this.platform.log.debug(`daemon: ${msg.message ?? ''}`, this.accessory.displayName);
      }
      break;
    case 'error':
      this.platform.log.warn(`daemon error: ${msg.message ?? ''}`, this.accessory.displayName);
      break;
    default:
      this.platform.log.debug(`daemon: unknown message type ${msg.type}`, this.accessory.displayName);
    }
  }

  /**
   * Queue a batch of writes to the device. Calls within the coalescing
   * window are merged into a single set message — keeps the device from
   * beeping per characteristic when HomeKit batches Active+RotationSpeed
   * (and resolves the race where two handlers fight over the same key).
   *
   * `mergeMode`:
   *  - 'override' (default): the supplied values overwrite anything
   *    already buffered for the same key. Use for writes that express
   *    user intent (rotation speed, mode switch, …).
   *  - 'fallback': only fill keys that are NOT yet in the buffer. Use
   *    for "best-guess" writes that should yield to a more authoritative
   *    sibling write arriving in the same window (e.g. setActive's
   *    inferred speed preset losing to setRotationSpeed's explicit one).
   */
  protected sendSet(
    data: Record<string, number>,
    opts: { mergeMode?: 'override' | 'fallback' } = {},
  ): void {
    const fallback = opts.mergeMode === 'fallback';
    for (const [k, v] of Object.entries(data)) {
      if (fallback) {
        if (!(k in this.pendingSet)) {
          this.pendingSet[k] = v;
        }
      } else {
        this.pendingSet[k] = v;
      }
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushPendingSet(), AirControlHandler.COALESCE_WINDOW_MS);
    }
  }

  /** Send the coalesced buffer to the daemon as a single atomic write. */
  private flushPendingSet(): void {
    this.flushTimer = undefined;
    const data = this.pendingSet;
    this.pendingSet = {};
    if (Object.keys(data).length === 0) {
      return;
    }
    if (!this.daemonProc?.stdin || !this.daemonProc.stdin.writable) {
      this.platform.log.warn(
        `flushPendingSet: daemon not ready, dropping ${JSON.stringify(data)}`,
        this.accessory.displayName,
      );
      return;
    }
    const line = JSON.stringify({ type: 'set', data }) + '\n';
    this.platform.log.debug(`-> daemon set ${JSON.stringify(data)}`, this.accessory.displayName);
    this.daemonProc.stdin.write(line);
  }

  /** Used by subclasses to ship a single-key write through the daemon. */
  protected async sendSetKey(key: string, value: number): Promise<void> {
    this.sendSet({ [key]: value });
  }

  /** Tell the daemon to exit cleanly and stop trying to restart it. */
  protected shutdown(): void {
    this.shutdownRequested = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
      this.pendingSet = {};
    }
    if (this.daemonProc?.stdin?.writable) {
      try {
        this.daemonProc.stdin.write(JSON.stringify({ type: 'shutdown' }) + '\n');
        this.daemonProc.stdin.end();
      } catch { /* ignore */ }
    }
    if (this.daemonProc) {
      try {
        this.daemonProc.kill();
      } catch { /* ignore */ }
      this.daemonProc = undefined;
    }
  }

  // ---------- compat shims for the existing accessories ----------

  /**
   * Existing accessory code calls `longPoll()` to kick off the observe
   * stream. We just start the daemon — the daemon handles everything.
   */
  longPoll(): void {
    this.startDaemon();
  }

  /** Tear-down hook called by some accessories on errors. */
  kill(shutdown: boolean): void {
    if (shutdown) {
      this.shutdown();
    }
  }
}
