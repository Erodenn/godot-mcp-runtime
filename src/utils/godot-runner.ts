import { fileURLToPath } from 'url';
import { join, dirname, normalize } from 'path';
import { existsSync } from 'fs';
import type { ChildProcess, SpawnOptions } from 'child_process';
import { spawn } from 'child_process';
import * as net from 'net';
import { randomBytes } from 'crypto';
import { BridgeManager } from './bridge-manager.js';
import {
  DEFAULT_BRIDGE_PORT,
  encodeFrame,
  findFreePort,
  parseFrames,
  FRAME_HEADER_BYTES,
  MAX_FRAME_BYTES,
  BRIDGE_WAIT_SPAWNED_TIMEOUT_MS,
} from './bridge-protocol.js';
import { logDebug, logError, DEBUG_MODE } from './logger.js';
import type { OperationParams } from '../mcp.types.js';
import { cleanStdout, normalizeForCompare } from './output-parsing.js';
import { checkDisplayAvailable, validateSubPath } from './path-validation.js';
import { convertCamelToSnakeCase } from './parameter-conversion.js';

/**
 * Thrown when the bridge socket closes (Godot exited, port closed, or peer
 * dropped the connection mid-flight). Lets callers distinguish
 * "session ended" from generic transport errors.
 */
export class BridgeDisconnectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeDisconnectedError';
  }
}

// Derive __filename and __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Bridge readiness polling
const BRIDGE_WAIT_SPAWNED_INTERVAL_MS = 300;
const BRIDGE_WAIT_ATTACHED_TIMEOUT_MS = 15000;
const BRIDGE_WAIT_ATTACHED_INTERVAL_MS = 500;
const BRIDGE_PING_TIMEOUT_MS = 1000;
const BRIDGE_SHUTDOWN_SPAWNED_TIMEOUT_MS = 500;
const BRIDGE_SHUTDOWN_ATTACHED_TIMEOUT_MS = 1500;
const BRIDGE_PROCESS_EXIT_TIMEOUT_MS = 2000;
const BRIDGE_RECONNECT_DELAY_MS = 1000;

export interface GodotProcess {
  process: ChildProcess;
  output: string[];
  errors: string[];
  totalErrorsWritten: number;
  exitCode: number | null;
  hasExited: boolean;
  sessionToken: string;
}

export type RuntimeSessionMode = 'spawned' | 'attached';

export interface RuntimeStopResult {
  mode: RuntimeSessionMode;
  output: string[];
  errors: string[];
  externalProcessPreserved?: boolean;
}

export interface GodotServerConfig {
  godotPath?: string;
  debugMode?: boolean;
}

export interface OperationResult {
  stdout: string;
  stderr: string;
}

interface InFlightCommand {
  command: string;
  resolve: (value: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Read the first `n` bytes from a chunk array without concatenating the
 * entire array. If the first chunk already has enough bytes, returns a
 * zero-copy subarray; otherwise copies just `n` bytes into a fresh buffer.
 * Caller must ensure total length across chunks is >= n.
 */
function readBytesFromChunks(chunks: Buffer[], n: number): Buffer {
  const first = chunks[0];
  if (first === undefined) {
    throw new Error('readBytesFromChunks called with empty chunks array');
  }
  if (first.length >= n) return first.subarray(0, n);
  const result = Buffer.allocUnsafe(n);
  let copied = 0;
  for (const c of chunks) {
    const take = Math.min(c.length, n - copied);
    c.copy(result, copied, 0, take);
    copied += take;
    if (copied >= n) break;
  }
  return result;
}

export class GodotRunner {
  private godotPath: string | null = null;
  private operationsScriptPath: string;
  private bridge: BridgeManager;
  private validatedPaths: Map<string, boolean> = new Map();
  private cachedVersion: string | null = null;
  public activeProcess: GodotProcess | null = null;
  public activeProjectPath: string | null = null;
  public activeSessionMode: RuntimeSessionMode | null = null;
  public activeBridgePort: number | null = null;

  private socket: net.Socket | null = null;
  // Receive buffer kept as an array of chunks until at least one complete frame
  // is available. Avoids re-copying accumulated bytes on every TCP data event
  // (the old `Buffer.concat([rxBuffer, chunk])` pattern was O(n²) on large
  // frames split across many chunks).
  private rxChunks: Buffer[] = [];
  private rxTotal = 0;
  private inFlight: InFlightCommand | null = null;

  constructor(config?: GodotServerConfig) {
    this.operationsScriptPath = join(__dirname, '..', 'scripts', 'godot_operations.gd');
    const bridgeScriptPath = join(__dirname, '..', 'scripts', 'mcp_bridge.gd');
    this.bridge = new BridgeManager(bridgeScriptPath);
    logDebug(`Operations script path: ${this.operationsScriptPath}`);

    if (config?.godotPath) {
      const normalizedPath = normalize(config.godotPath);
      if (this.isValidGodotPathSync(normalizedPath)) {
        this.godotPath = normalizedPath;
        logDebug(`Custom Godot path provided: ${this.godotPath}`);
      } else {
        console.warn(`[SERVER] Invalid custom Godot path provided: ${normalizedPath}`);
      }
    }
  }

  private isValidGodotPathSync(path: string): boolean {
    try {
      logDebug(`Quick-validating Godot path: ${path}`);
      return path === 'godot' || existsSync(path);
    } catch {
      logDebug(`Invalid Godot path: ${path}`);
      return false;
    }
  }

  private spawnAsync(
    cmd: string,
    args: string[],
    timeoutMs: number = 10000,
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, { stdio: 'pipe' });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error(`Process timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          const err = new Error(`Process exited with code ${code}`) as Error & {
            stdout: string;
            stderr: string;
            code: number | null;
          };
          err.stdout = stdout;
          err.stderr = stderr;
          err.code = code;
          reject(err);
        }
      });
    });
  }

  private async isValidGodotPath(path: string): Promise<boolean> {
    if (this.validatedPaths.has(path)) {
      return this.validatedPaths.get(path)!;
    }

    try {
      logDebug(`Validating Godot path: ${path}`);

      if (path !== 'godot' && !existsSync(path)) {
        logDebug(`Path does not exist: ${path}`);
        this.validatedPaths.set(path, false);
        return false;
      }

      await this.spawnAsync(path, ['--version']);

      logDebug(`Valid Godot path: ${path}`);
      this.validatedPaths.set(path, true);
      return true;
    } catch {
      logDebug(`Invalid Godot path: ${path}`);
      this.validatedPaths.set(path, false);
      return false;
    }
  }

  async detectGodotPath(): Promise<void> {
    // Explicit paths (constructor config or GODOT_PATH) are authoritative — leave
    // godotPath null on failure rather than fabricating a platform default, so
    // callers can produce actionable errors.
    if (this.godotPath) {
      if (await this.isValidGodotPath(this.godotPath)) {
        logDebug(`Using existing Godot path: ${this.godotPath}`);
        return;
      }
      logError(
        `Configured Godot path "${this.godotPath}" is not a working Godot executable. ` +
          `Pass a valid Godot 4.x binary via the godotPath config option.`,
      );
      this.godotPath = null;
      return;
    }

    if (process.env.GODOT_PATH) {
      const normalizedPath = normalize(process.env.GODOT_PATH);
      logDebug(`Checking GODOT_PATH environment variable: ${normalizedPath}`);
      if (await this.isValidGodotPath(normalizedPath)) {
        this.godotPath = normalizedPath;
        logDebug(`Using Godot path from environment: ${this.godotPath}`);
        return;
      }
      logError(
        `GODOT_PATH is set to "${normalizedPath}" but no working Godot executable was found there. ` +
          `Update GODOT_PATH to your Godot 4.x binary or unset it to auto-detect.`,
      );
      return;
    }

    const osPlatform = process.platform;
    logDebug(`Auto-detecting Godot path for platform: ${osPlatform}`);

    const possiblePaths: string[] = ['godot'];

    if (osPlatform === 'darwin') {
      possiblePaths.push(
        '/Applications/Godot.app/Contents/MacOS/Godot',
        '/Applications/Godot_4.app/Contents/MacOS/Godot',
        `${process.env.HOME}/Applications/Godot.app/Contents/MacOS/Godot`,
      );
    } else if (osPlatform === 'win32') {
      possiblePaths.push(
        'C:\\Program Files\\Godot\\Godot.exe',
        'C:\\Program Files (x86)\\Godot\\Godot.exe',
        `${process.env.USERPROFILE}\\Godot\\Godot.exe`,
      );
    } else if (osPlatform === 'linux') {
      possiblePaths.push(
        '/usr/bin/godot',
        '/usr/local/bin/godot',
        '/snap/bin/godot',
        `${process.env.HOME}/.local/bin/godot`,
      );
    }

    const normalizedCandidates = possiblePaths.map((p) => normalize(p));
    const probeResults = await Promise.all(
      normalizedCandidates.map(async (p) => ({ path: p, valid: await this.isValidGodotPath(p) })),
    );
    const winner = probeResults.find((r) => r.valid);
    if (winner) {
      this.godotPath = winner.path;
      logDebug(`Found Godot at: ${winner.path}`);
      return;
    }

    logError(
      `Could not find Godot in common locations for ${osPlatform}. ` +
        `Set GODOT_PATH to your Godot 4.x executable.`,
    );
  }

  getGodotPath(): string | null {
    return this.godotPath;
  }

  /**
   * Read the port currently baked into the project's bridge script. Returns
   * null if the file is missing or malformed. Thin pass-through to
   * BridgeManager — used by bridge-wait-timeout race detection.
   */
  readBakedBridgePort(projectPath: string): number | null {
    return this.bridge.readBakedPort(projectPath);
  }

  async getVersion(): Promise<string> {
    if (this.cachedVersion !== null) {
      return this.cachedVersion;
    }
    if (!this.godotPath) {
      await this.detectGodotPath();
      if (!this.godotPath) {
        throw new Error('Could not find a valid Godot executable path');
      }
    }

    const { stdout } = await this.spawnAsync(this.godotPath, ['--version']);
    this.cachedVersion = stdout.trim();
    return this.cachedVersion;
  }

  async executeOperation(
    operation: string,
    params: OperationParams,
    projectPath: string,
    timeoutMs: number = 30000,
  ): Promise<OperationResult> {
    logDebug(`Executing operation: ${operation} in project: ${projectPath}`);
    logDebug(`Original operation params: ${JSON.stringify(params)}`);

    this.bridge.repairOrphaned(projectPath);

    const snakeCaseParams = convertCamelToSnakeCase(params);
    logDebug(`Converted snake_case params: ${JSON.stringify(snakeCaseParams)}`);

    if (!this.godotPath) {
      await this.detectGodotPath();
      if (!this.godotPath) {
        throw new Error('Could not find a valid Godot executable path');
      }
    }

    const paramsJson = JSON.stringify(snakeCaseParams);
    const args = [
      '--headless',
      '--path',
      projectPath,
      '--script',
      this.operationsScriptPath,
      operation,
      paramsJson,
      ...(DEBUG_MODE ? ['--debug-godot'] : []),
    ];

    logDebug(`Command: ${this.godotPath} ${args.join(' ')}`);

    let stdout = '';
    let stderr = '';
    try {
      ({ stdout, stderr } = await this.spawnAsync(this.godotPath, args, timeoutMs));
    } catch (error: unknown) {
      if (error instanceof Error && 'stdout' in error && 'stderr' in error) {
        const execError = error as Error & { stdout: string; stderr: string };
        stdout = execError.stdout;
        stderr = execError.stderr;
      } else {
        throw error;
      }
    }

    // If the process produced no operation output but has errors, initialization
    // failed before the script ran. Autoload errors are the most common cause.
    const operationRan = stdout.trim().length > 0 || stderr.includes('[INFO] Operation:');
    if (!operationRan && (stderr.includes('ERROR:') || stderr.includes('SCRIPT ERROR:'))) {
      throw new Error(
        `Headless Godot failed before the operation could run — likely an autoload initialization error.\n` +
          `Stderr:\n${stderr.trim()}\n\n` +
          `Use list_autoloads and remove_autoload to inspect or remove the failing autoload, then retry.`,
      );
    }

    return { stdout: cleanStdout(stdout), stderr };
  }

  launchEditor(projectPath: string): ChildProcess {
    if (!this.godotPath) {
      throw new Error(
        'No Godot executable resolved. Set GODOT_PATH to a Godot 4.x binary, or pass godotPath via config.',
      );
    }
    return spawn(this.godotPath, ['-e', '--path', projectPath], { stdio: 'pipe' });
  }

  async runProject(
    projectPath: string,
    scene?: string,
    background: boolean = false,
    bridgePort?: number,
  ): Promise<GodotProcess> {
    if (!this.godotPath) {
      throw new Error(
        'No Godot executable resolved. Set GODOT_PATH to a Godot 4.x binary, or pass godotPath via config.',
      );
    }

    if (this.activeSessionMode === 'spawned' && this.activeProcess) {
      logDebug('Killing existing Godot process before starting a new one');
      this.closeConnection();
      this.activeProcess.process.kill();
      if (this.activeProjectPath && this.activeProjectPath !== projectPath) {
        this.bridge.cleanup(this.activeProjectPath);
      }
    } else if (
      this.activeSessionMode === 'attached' &&
      this.activeProjectPath &&
      this.activeProjectPath !== projectPath
    ) {
      this.closeConnection();
      this.bridge.cleanup(this.activeProjectPath);
    }

    if (!checkDisplayAvailable()) {
      throw new Error(
        'No display server available (DISPLAY and WAYLAND_DISPLAY are both unset). ' +
          'Godot requires a display to run a project window.',
      );
    }

    const port = bridgePort ?? (await findFreePort());
    this.activeBridgePort = port;

    try {
      this.bridge.inject(projectPath, port);
    } catch (err) {
      logDebug(`Non-fatal: Failed to inject bridge autoload: ${err}`);
    }
    this.activeProjectPath = projectPath;
    this.activeSessionMode = 'spawned';

    const cmdArgs = ['--path', projectPath];
    if (scene && validateSubPath(projectPath, scene)) {
      logDebug(`Adding scene parameter: ${scene}`);
      cmdArgs.push(scene);
    }

    const portSource = bridgePort !== undefined ? 'explicit' : 'auto';
    logDebug(`Running Godot project: ${projectPath} (bridge port ${port}, ${portSource})`);
    const sessionToken = randomBytes(16).toString('hex');
    const spawnOptions: SpawnOptions = {
      stdio: 'pipe',
      env: {
        ...process.env,
        MCP_SESSION_TOKEN: sessionToken,
      },
    };
    if (background) {
      spawnOptions.env = { ...spawnOptions.env, MCP_BACKGROUND: '1' };
    }
    const proc = spawn(this.godotPath, cmdArgs, spawnOptions);
    const output: string[] = [];
    const errors: string[] = [];

    const godotProcess: GodotProcess = {
      process: proc,
      output,
      errors,
      totalErrorsWritten: 0,
      exitCode: null,
      hasExited: false,
      sessionToken,
    };

    proc.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      output.push(...lines);
      if (output.length > 500) output.splice(0, output.length - 500);
      lines.forEach((line: string) => {
        if (line.trim()) logDebug(`[Godot stdout] ${line}`);
      });
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      godotProcess.totalErrorsWritten += lines.length;
      errors.push(...lines);
      if (errors.length > 500) errors.splice(0, errors.length - 500);
      lines.forEach((line: string) => {
        if (line.trim()) logDebug(`[Godot stderr] ${line}`);
      });
    });

    proc.on('exit', (code: number | null) => {
      logDebug(`Godot process exited with code ${code}`);
      godotProcess.exitCode = code;
      godotProcess.hasExited = true;
      // Don't clear activeProcess immediately - keep it so output can be retrieved
    });

    proc.on('error', (err: Error) => {
      console.error('Failed to start Godot process:', err);
      errors.push(`Process error: ${err.message}`);
      godotProcess.hasExited = true;
    });

    this.activeProcess = godotProcess;
    return this.activeProcess;
  }

  async attachProject(projectPath: string, bridgePort?: number): Promise<void> {
    if (this.activeSessionMode === 'spawned' && this.activeProcess) {
      await this.stopProject();
    } else if (
      this.activeSessionMode === 'attached' &&
      this.activeProjectPath &&
      this.activeProjectPath !== projectPath
    ) {
      // Different project — detach the old one cleanly so its bridge
      // releases the port before we inject into the new project.
      try {
        await this.sendCommand('shutdown', {}, BRIDGE_SHUTDOWN_ATTACHED_TIMEOUT_MS);
      } catch (err) {
        logDebug(`Shutdown command failed during attach swap (ignored): ${err}`);
      }
      this.closeConnection();
      this.bridge.cleanup(this.activeProjectPath);
      this.activeProjectPath = null;
      this.activeSessionMode = null;
    }

    const port = bridgePort ?? (await findFreePort());
    this.activeBridgePort = port;
    this.bridge.inject(projectPath, port);
    const portSource = bridgePort !== undefined ? 'explicit' : 'auto';
    logDebug(`Attaching to Godot project: ${projectPath} (bridge port ${port}, ${portSource})`);
    this.activeProjectPath = projectPath;
    this.activeSessionMode = 'attached';
    this.activeProcess = null;
  }

  async stopProject(): Promise<RuntimeStopResult | null> {
    if (!this.activeSessionMode) {
      return null;
    }

    if (this.activeSessionMode === 'attached') {
      // Ask the bridge to shut down so the user's still-running Godot
      // releases the port. A timeout here is non-fatal — same end state
      // as today, the bridge dies when the user closes Godot.
      try {
        await this.sendCommand('shutdown', {}, BRIDGE_SHUTDOWN_ATTACHED_TIMEOUT_MS);
      } catch (err) {
        logDebug(`Attached shutdown timed out or failed (continuing cleanup): ${err}`);
      }
      this.closeConnection();
      const projectPath = this.activeProjectPath;
      if (projectPath) {
        this.bridge.cleanup(projectPath);
      }
      this.activeProjectPath = null;
      this.activeSessionMode = null;
      this.activeBridgePort = null;
      this.activeProcess = null;
      return {
        mode: 'attached',
        output: [],
        errors: [],
        externalProcessPreserved: true,
      };
    }

    if (!this.activeProcess) {
      return null;
    }

    // Spawned: try graceful shutdown so the bridge releases the port,
    // then ensure the process actually exits.
    try {
      await this.sendCommand('shutdown', {}, BRIDGE_SHUTDOWN_SPAWNED_TIMEOUT_MS);
    } catch {
      // Bridge may already be unreachable — proceed to kill.
    }
    this.closeConnection();

    logDebug('Stopping active Godot process');
    const proc = this.activeProcess.process;
    proc.kill();

    // Wait up to BRIDGE_PROCESS_EXIT_TIMEOUT_MS for graceful exit; otherwise SIGKILL.
    if (!this.activeProcess.hasExited) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {
            // already dead
          }
          resolve();
        }, BRIDGE_PROCESS_EXIT_TIMEOUT_MS);
        proc.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    const result: RuntimeStopResult = {
      mode: 'spawned',
      output: this.activeProcess.output,
      errors: this.activeProcess.errors,
    };
    this.activeProcess = null;

    if (this.activeProjectPath) {
      this.bridge.cleanup(this.activeProjectPath);
      this.activeProjectPath = null;
    }
    this.activeSessionMode = null;
    this.activeBridgePort = null;

    return result;
  }

  hasActiveRuntimeSession(): boolean {
    if (!this.activeSessionMode || !this.activeProjectPath) {
      return false;
    }
    if (this.activeSessionMode === 'spawned') {
      return this.activeProcess !== null && !this.activeProcess.hasExited;
    }
    return true;
  }

  /**
   * Send a JSON command to the McpBridge over a long-lived TCP connection.
   *
   * MCP serializes tool calls so we hold one in-flight command at a time. The
   * socket is lazy-connected on first call and persists across commands until
   * `closeConnection` (or a peer-side close). A close mid-flight rejects with
   * `BridgeDisconnectedError`; a per-command timeout rejects but does NOT
   * close the socket — a slow command does not invalidate the session.
   */
  sendCommand(
    command: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = 10000,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.inFlight) {
        reject(
          new Error(
            `Command '${command}' rejected: another command ('${this.inFlight.command}') is in flight`,
          ),
        );
        return;
      }

      const settle = (err: Error | null, value?: string): void => {
        if (!this.inFlight) return;
        const flight = this.inFlight;
        this.inFlight = null;
        clearTimeout(flight.timer);
        if (err) {
          flight.reject(err);
        } else {
          flight.resolve(value ?? '');
        }
      };

      const timer = setTimeout(() => {
        // Destroy the socket on timeout. The bridge serializes commands
        // (peer.handling gate), so a slow command's late response would
        // otherwise correlate against the next command we send. The next
        // sendCommand lazy-reconnects.
        if (this.socket) {
          const sock = this.socket;
          this.socket = null;
          sock.removeAllListeners();
          sock.destroy();
        }
        this.resetRxBuffer();
        settle(
          new Error(`Command '${command}' timed out after ${timeoutMs}ms. Is the game running?`),
        );
      }, timeoutMs);

      this.inFlight = { command, resolve, reject, timer };

      const ensureSocket = (cb: (err?: Error) => void): void => {
        if (this.socket) {
          cb();
          return;
        }
        // Fallback to DEFAULT_BRIDGE_PORT is defensive — every entry point
        // (runProject, attachProject) sets activeBridgePort before sendCommand
        // can be reached, so this branch is not expected in practice.
        const port = this.activeBridgePort ?? DEFAULT_BRIDGE_PORT;
        const sock = net.connect(port, '127.0.0.1');
        const onConnect = (): void => {
          sock.setNoDelay(true);
          sock.removeListener('error', onConnectError);
          this.socket = sock;
          this.resetRxBuffer();

          sock.on('data', (chunk: Buffer) => {
            this.rxChunks.push(chunk);
            this.rxTotal += chunk.length;

            // Defer the (potentially expensive) concat until we know at least
            // one complete frame is ready. Peek the 4-byte header without
            // copying all accumulated chunks first.
            if (this.rxTotal < FRAME_HEADER_BYTES) return;
            const header = readBytesFromChunks(this.rxChunks, FRAME_HEADER_BYTES);
            const firstLen = header.readUInt32BE(0);
            if (firstLen > MAX_FRAME_BYTES) {
              this.socket = null;
              sock.destroy();
              settle(
                new BridgeDisconnectedError(
                  `Bridge frame header advertises ${firstLen} bytes, exceeds limit ${MAX_FRAME_BYTES}`,
                ),
              );
              return;
            }
            if (this.rxTotal < FRAME_HEADER_BYTES + firstLen) return;

            try {
              const first = this.rxChunks[0];
              const buffer =
                first !== undefined && this.rxChunks.length === 1
                  ? first
                  : Buffer.concat(this.rxChunks, this.rxTotal);
              const { frames, remainder } = parseFrames(buffer);
              if (remainder.length === 0) {
                this.rxChunks = [];
                this.rxTotal = 0;
              } else {
                this.rxChunks = [remainder];
                this.rxTotal = remainder.length;
              }
              for (const frame of frames) {
                settle(null, frame.toString('utf8'));
              }
            } catch (parseErr) {
              const message = parseErr instanceof Error ? parseErr.message : String(parseErr);
              this.socket = null;
              sock.destroy();
              settle(new BridgeDisconnectedError(`Bridge framing error: ${message}`));
            }
          });

          const onClose = (): void => {
            this.socket = null;
            settle(
              new BridgeDisconnectedError(
                `Bridge connection closed before '${command}' response was received`,
              ),
            );
          };
          sock.once('close', onClose);
          sock.on('error', (sockErr: Error) => {
            this.socket = null;
            settle(
              new BridgeDisconnectedError(
                `Bridge socket error during '${command}': ${sockErr.message}`,
              ),
            );
          });

          cb();
        };
        const onConnectError = (connErr: Error): void => {
          sock.destroy();
          cb(connErr);
        };
        sock.once('connect', onConnect);
        sock.once('error', onConnectError);
      };

      ensureSocket((err) => {
        if (err) {
          settle(
            new BridgeDisconnectedError(
              `Failed to connect to bridge for '${command}': ${err.message}`,
            ),
          );
          return;
        }
        if (!this.socket) {
          settle(new BridgeDisconnectedError(`Bridge socket unavailable for '${command}'`));
          return;
        }
        try {
          const payload = JSON.stringify({ command, ...params });
          this.socket.write(encodeFrame(payload));
        } catch (writeErr) {
          const message = writeErr instanceof Error ? writeErr.message : String(writeErr);
          settle(new Error(`Failed to send command '${command}': ${message}`));
        }
      });
    });
  }

  /**
   * Tear down the bridge socket. Idempotent. Any in-flight command is
   * rejected with a session-ended error.
   */
  closeConnection(): void {
    if (this.inFlight) {
      const flight = this.inFlight;
      this.inFlight = null;
      clearTimeout(flight.timer);
      flight.reject(new BridgeDisconnectedError('Bridge session ended'));
    }
    if (this.socket) {
      const sock = this.socket;
      this.socket = null;
      sock.removeAllListeners();
      sock.destroy();
    }
    this.resetRxBuffer();
  }

  private resetRxBuffer(): void {
    this.rxChunks = [];
    this.rxTotal = 0;
  }

  getErrorCount(): number {
    return this.activeProcess?.totalErrorsWritten ?? 0;
  }

  getErrorsSince(marker: number): string[] {
    if (!this.activeProcess) return [];
    const { errors, totalErrorsWritten } = this.activeProcess;
    const delta = totalErrorsWritten - marker;
    if (delta <= 0) return [];
    const window = delta >= errors.length ? errors.slice() : errors.slice(errors.length - delta);
    return window.filter((line) => line.trim() !== '');
  }

  // Only the explicit `SCRIPT ERROR:` / `USER SCRIPT ERROR:` markers belong here — the looser
  // `GDScript error` substring also matches user printerr output and produces false positives.
  private static readonly SCRIPT_ERROR_PATTERNS = ['SCRIPT ERROR:', 'USER SCRIPT ERROR:'];
  private static readonly RETRYABLE_BRIDGE_COMMANDS = new Set(['get_ui_elements', 'screenshot']);

  extractRuntimeErrors(lines: string[]): string[] {
    return lines.filter((line) => GodotRunner.SCRIPT_ERROR_PATTERNS.some((p) => line.includes(p)));
  }

  private async sendCommandWithReconnect(
    command: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = 10000,
  ): Promise<string> {
    try {
      return await this.sendCommand(command, params, timeoutMs);
    } catch (err) {
      if (
        err instanceof BridgeDisconnectedError &&
        this.activeSessionMode &&
        GodotRunner.RETRYABLE_BRIDGE_COMMANDS.has(command)
      ) {
        this.closeConnection();
        await new Promise((r) => setTimeout(r, BRIDGE_RECONNECT_DELAY_MS));
        return this.sendCommand(command, params, timeoutMs);
      }
      throw err;
    }
  }

  async sendCommandWithErrors(
    command: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = 10000,
  ): Promise<{ response: string; runtimeErrors: string[] }> {
    const marker = this.getErrorCount();
    const response = await this.sendCommandWithReconnect(command, params, timeoutMs);
    const newErrors = this.getErrorsSince(marker);
    const runtimeErrors =
      this.activeSessionMode === 'spawned' ? this.extractRuntimeErrors(newErrors) : [];
    return { response, runtimeErrors };
  }

  /**
   * Shared poll loop for `waitForBridge` (spawned) and `waitForBridgeAttached`.
   * Sends `ping` payloads until the bridge replies with a pong that
   * `validatePong` accepts, the deadline passes, or `shouldAbort` reports
   * the spawned process has exited.
   */
  private async pollBridge(opts: {
    expectedPath: string | null;
    timeoutMs: number;
    intervalMs: number;
    timeoutError: string;
    pingPayload: Record<string, unknown>;
    validatePong: (parsed: { status?: string; [k: string]: unknown }) => boolean;
    shouldAbort?: () => { aborted: boolean; tail: string[] };
  }): Promise<{ ready: boolean; error?: string }> {
    const deadline = Date.now() + opts.timeoutMs;

    while (Date.now() < deadline) {
      if (opts.shouldAbort) {
        const abort = opts.shouldAbort();
        if (abort.aborted) {
          const errorText = abort.tail.length > 0 ? `\nLast stderr:\n${abort.tail.join('\n')}` : '';
          return {
            ready: false,
            error: `Process exited with code ${this.activeProcess?.exitCode ?? '?'} before bridge was ready.${errorText}`,
          };
        }
      }

      try {
        const response = await this.sendCommand('ping', opts.pingPayload, BRIDGE_PING_TIMEOUT_MS);
        const parsed = JSON.parse(response);
        if (opts.validatePong(parsed)) {
          if (opts.expectedPath && typeof parsed.project_path === 'string') {
            const bridgePath = normalizeForCompare(parsed.project_path);
            if (bridgePath !== opts.expectedPath) {
              return {
                ready: false,
                error: `Bridge reports project ${bridgePath}, expected ${opts.expectedPath}`,
              };
            }
          }
          return { ready: true };
        }
      } catch {
        // Expected: ping will fail until bridge is listening
      }

      await new Promise((resolve) => setTimeout(resolve, opts.intervalMs));
    }

    return { ready: false, error: opts.timeoutError };
  }

  async waitForBridgeAttached(
    timeoutMs: number = BRIDGE_WAIT_ATTACHED_TIMEOUT_MS,
    intervalMs: number = BRIDGE_WAIT_ATTACHED_INTERVAL_MS,
  ): Promise<{ ready: boolean; error?: string }> {
    return this.pollBridge({
      expectedPath: this.activeProjectPath ? normalizeForCompare(this.activeProjectPath) : null,
      timeoutMs,
      intervalMs,
      timeoutError:
        'Bridge did not respond within timeout — is Godot running with the McpBridge autoload?',
      pingPayload: {},
      validatePong: (parsed) => parsed.status === 'pong',
    });
  }

  async waitForBridge(
    timeoutMs: number = BRIDGE_WAIT_SPAWNED_TIMEOUT_MS,
    intervalMs: number = BRIDGE_WAIT_SPAWNED_INTERVAL_MS,
  ): Promise<{ ready: boolean; error?: string }> {
    const expectedToken = this.activeProcess?.sessionToken;
    if (!expectedToken) {
      return { ready: false, error: 'No active spawned Godot process to verify' };
    }

    return this.pollBridge({
      expectedPath: this.activeProjectPath ? normalizeForCompare(this.activeProjectPath) : null,
      timeoutMs,
      intervalMs,
      timeoutError: 'Bridge did not respond with the expected session token within timeout',
      pingPayload: { session_token: expectedToken },
      validatePong: (parsed) => parsed.status === 'pong' && parsed.session_token === expectedToken,
      shouldAbort: () => ({
        aborted: this.activeProcess !== null && this.activeProcess.hasExited,
        tail: this.getRecentErrors(20),
      }),
    });
  }

  getRecentErrors(count: number = 20): string[] {
    if (!this.activeProcess) return [];
    return this.activeProcess.errors.slice(-count).filter((line) => line.trim() !== '');
  }
}
