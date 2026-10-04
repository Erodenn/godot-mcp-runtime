import { fileURLToPath } from 'url';
import { join, dirname, normalize, resolve } from 'path';
import { existsSync } from 'fs';
import type { ChildProcess, SpawnOptions } from 'child_process';
import { spawn } from 'child_process';
import * as net from 'net';
import { randomBytes } from 'crypto';
import {
  BridgeAutoloadCollisionError,
  BridgeManager,
  BridgeRegistryUnreadableError,
} from './bridge-manager.js';
import type { BridgeOwnerInfo } from './bridge-manager.js';
import { DebuggerProfiler } from './profiler.js';
import {
  encodeFrame,
  findFreePort,
  parseFrames,
  parseActionBoundary,
  bucketBySentinel,
  FRAME_HEADER_BYTES,
  MAX_FRAME_BYTES,
  BRIDGE_WAIT_SPAWNED_TIMEOUT_MS,
} from './bridge-protocol.js';
import type { ActionBoundaryMark } from './bridge-protocol.js';
import { logDebug, logError, DEBUG_MODE } from './logger.js';
import type { OperationParams } from '../mcp.types.js';
import {
  cleanStdout,
  extractOperationPayload,
  normalizeForCompare,
  normalizeExitCode,
  projectPathKey,
  splitOutputChunk,
} from './output-parsing.js';
import { checkDisplayAvailable, type ResolvedProjectPath } from './path-validation.js';
import { convertCamelToSnakeCase } from './parameter-conversion.js';
import { godotSpawnOptions } from './godot-spawn-options.js';
import {
  defaultKillTreeDeps,
  killProcessTree,
  terminateProcessTree,
  type KillTreeDeps,
} from './process-tree.js';

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

// First line godot_operations.gd prints to stderr once it has started dispatching
// an operation. KEEP IN SYNC with the log_info("Operation: ...") call in
// _run_from_cmdline in src/scripts/godot_operations.gd.
const OPERATION_STARTED_MARKER = '[INFO] Operation:';

// Bridge readiness polling
const BRIDGE_WAIT_SPAWNED_INTERVAL_MS = 300;
// Ceiling on how long attach mode waits with no evidence the bridge is
// even listening yet. Exported so the readiness-budget tests can assert the
// relationship to BRIDGE_WAIT_ATTACHED_CONNECTED_TIMEOUT_MS below.
export const BRIDGE_WAIT_ATTACHED_TIMEOUT_MS = 20000;
/**
 * Ceiling applied once a TCP connect to the bridge port has succeeded but no
 * pong has been validated yet. A successful connect is positive evidence the
 * bridge autoload ran and is listening - at that point the remaining wait is
 * the engine finishing its own startup on a large project, which is worth far
 * more patience than "nothing is listening yet". Exported for the same
 * reason as BRIDGE_WAIT_ATTACHED_TIMEOUT_MS above.
 *
 * Held under the MCP SDK's 60 s default per-request client timeout on purpose.
 * A client that attached no progressToken gets no heartbeats, so a wait past
 * that ceiling is aborted client-side and the server's own structured error -
 * the port-race diagnostic and its solutions - never reaches the agent. The
 * remaining headroom covers the attach path's stopProject teardown.
 */
export const BRIDGE_WAIT_ATTACHED_CONNECTED_TIMEOUT_MS = 45000;
/**
 * How many consecutive ping failures end an attached wait that has already
 * seen a TCP connect. The extended ceiling above exists for an engine still
 * finishing its startup, not for a socket that accepts and never answers: a
 * stale Godot from an earlier session holding the port, or an unrelated local
 * service on a user-supplied bridgePort, both connect and then fail every
 * ping. At the 1 s ping timeout plus the 2 s backed-off interval that is about
 * 24 s before the call reports, instead of the full ceiling. One successful
 * ping that simply is not a valid pong yet resets the count, so a bridge that
 * is answering is never cut off.
 */
export const BRIDGE_CONNECTED_PING_FAILURE_LIMIT = 8;
// Exported so the readiness-budget tests can assert it stays well under the
// attached ceilings above.
export const BRIDGE_WAIT_ATTACHED_INTERVAL_MS = 500;
// After this much waiting, pollBridge backs off from the fast early cadence
// to BRIDGE_WAIT_MAX_INTERVAL_MS - a flat interval across a 60s ceiling would
// otherwise open a socket every intervalMs for the whole wait. Exported for
// the same reason as BRIDGE_WAIT_ATTACHED_INTERVAL_MS above.
export const BRIDGE_WAIT_BACKOFF_AFTER_MS = 5000;
// Poll interval used once BRIDGE_WAIT_BACKOFF_AFTER_MS has elapsed. Exported
// for the same reason as BRIDGE_WAIT_ATTACHED_INTERVAL_MS above.
export const BRIDGE_WAIT_MAX_INTERVAL_MS = 2000;
// Exported so other tool modules (e.g. check_project's runtime probe) reuse
// the same bound instead of a bare-number timeout.
export const BRIDGE_PING_TIMEOUT_MS = 1000;
const BRIDGE_SHUTDOWN_SPAWNED_TIMEOUT_MS = 500;
const BRIDGE_SHUTDOWN_ATTACHED_TIMEOUT_MS = 1500;
const BRIDGE_PROCESS_EXIT_TIMEOUT_MS = 2000;
const BRIDGE_RECONNECT_DELAY_MS = 1000;

// A first import of an asset-heavy project can exceed 2 minutes; 5 minutes
// leaves headroom without hanging forever on a genuinely stuck import.
const IMPORT_TIMEOUT_MS = 300000;

// Retained-line cap on the session stderr ring buffer.
const STDERR_RING_LIMIT_LINES = 500;
// Retained-line cap on the session stdout ring buffer.
const STDOUT_RING_LIMIT_LINES = 500;
// The bridge's TCP response can land before its stderr has drained, so the
// final action boundary is waited for on a short bounded poll rather than
// assumed present.
const SENTINEL_DRAIN_TIMEOUT_MS = 250;
const SENTINEL_DRAIN_POLL_MS = 10;

export interface GodotProcess {
  process: ChildProcess;
  output: string[];
  errors: string[];
  totalErrorsWritten: number;
  exitCode: number | null;
  hasExited: boolean;
  sessionToken: string;
  /**
   * Action boundaries recorded from stderr during the current input batch.
   * Optional so a hand-built process literal (tests, fakes) stays valid;
   * `beginActionErrorCapture` resets it at the start of each batch.
   */
  actionBoundaries?: ActionBoundaryMark[];
  /**
   * True when the last line pushed to `errors` came from a chunk that did not
   * end in a newline, and so may be the front half of a line the next chunk
   * completes. `ingestStderrChunk` pops and rejoins it in that case.
   */
  stderrTailIncomplete?: boolean;
  /** The same for `output`, kept by `ingestStdoutChunk`. */
  stdoutTailIncomplete?: boolean;
}

/** Opaque handle returned by `beginActionErrorCapture`. */
export interface ActionErrorCapture {
  marker: number;
}

export interface ActionErrorBuckets {
  /** One entry per executed action, already filtered to runtime-error lines. */
  buckets: string[][];
  /** Runtime-error lines after the last boundary, for the last executed action. */
  trailing: string[];
  /** True when the expected boundary count never arrived before the deadline. */
  sentinelTimedOut: boolean;
}

export type RuntimeSessionMode = 'spawned' | 'attached';

/** Map key for a project: one normalization for the runner, the edit guard and the tools. */
export function sessionKey(projectPath: string): string {
  return projectPathKey(projectPath);
}

/**
 * One runtime session. Internal to the runner; exported only so the test
 * helper can type it. Handlers use {@link RuntimeSessionInfo}.
 */
export interface RuntimeSession {
  readonly key: string;
  /** Resolved absolute project path. */
  readonly projectPath: string;
  /** Null once the spawned process exited by itself. */
  mode: RuntimeSessionMode | null;
  bridgePort: number | null;
  /**
   * Bridge auth token. Spawned sessions deliver it through the
   * MCP_SESSION_TOKEN env var; attached sessions bake it into the injected
   * script (see BridgeManager.inject). Attached to every outgoing frame so the
   * bridge can reject unauthenticated drive-by commands.
   */
  token: string | null;
  process: GodotProcess | null;
  /**
   * Debugger receiver for `run_project({ profiling: true })`. Bound before the
   * spawn so `--remote-debug` has a port to dial, and torn down with the
   * session. Null in attached mode: the channel is set at launch or never.
   */
  profiler: DebuggerProfiler | null;
  /**
   * Monotonic counter bumped at the head of every transition that supersedes
   * or stops this session. See `GodotRunner.beginSessionTransition`.
   */
  epoch: number;
  /**
   * What the exit-time bridge cleanup could not confirm, when the spawned
   * process exited by itself. Nobody is on the line at that moment, so it is
   * kept here for the `stop_project` that follows. Empty when the cleanup was
   * complete or has not run.
   */
  exitCleanupProblems: string[];
  /**
   * Set when this spawned session was started over this server's own attached
   * session on the same project. Null otherwise.
   */
  replacedAttached: ReplacedAttachedSession | null;
}

/**
 * What became of an attached session that a spawned start replaced. The Godot
 * the user launched is still running either way; `shutdownAcknowledged` false
 * means its bridge did not answer the `shutdown` command and is still
 * listening on `bridgePort` with the replaced session's token.
 */
export interface ReplacedAttachedSession {
  bridgePort: number | null;
  shutdownAcknowledged: boolean;
}

/** Plain-data snapshot of one session, safe to hand to a tool handler. */
export interface RuntimeSessionInfo {
  projectPath: string;
  mode: RuntimeSessionMode | null;
  live: boolean;
  current: boolean;
  bridgePort: number | null;
  /** A process is retained and has exited. */
  processExited: boolean;
  /** Null unless `processExited`. */
  exitCode: number | null;
  /** A process, and so its stdout/stderr buffers, is retained. */
  hasRetainedLogs: boolean;
  profiling: boolean;
  /** See {@link RuntimeSession.replacedAttached}. Absent means null. */
  replacedAttached?: ReplacedAttachedSession | null;
}

export interface RuntimeSessionStatus {
  /** State of the current pointer. `exited` means current is set but not live. */
  state: 'live' | 'exited' | 'none';
  /** Null exactly when `state` is `none`. */
  current: RuntimeSessionInfo | null;
  /** Live sessions other than the current one. */
  otherLiveSessions: RuntimeSessionInfo[];
}

/** Copies of a session's retained process buffers, as `readSessionLogs` returns them. */
export interface RuntimeSessionLogs {
  output: string[];
  errors: string[];
  hasExited: boolean;
  exitCode: number | null;
}

function describeNoLiveCurrent(status: RuntimeSessionStatus): string {
  const head =
    status.current === null
      ? 'No current runtime session.'
      : `The current session's Godot process (${status.current.projectPath}) exited with code ${status.current.exitCode ?? 'unknown'}.`;
  const others = status.otherLiveSessions.map((info) => info.projectPath);
  const tail =
    others.length > 0 ? ` Live sessions: ${others.join(', ')}.` : ' No other session is live.';
  return head + tail;
}

/**
 * Thrown when a runtime command has no live current session to act on. Carries
 * the status so the caller can name the other live sessions; the runner never
 * picks one of them by itself.
 */
export class NoLiveCurrentSessionError extends Error {
  constructor(readonly status: RuntimeSessionStatus) {
    super(describeNoLiveCurrent(status));
    this.name = 'NoLiveCurrentSessionError';
  }
}

/**
 * An attached session is live until its bridge is seen to be gone. A spawned
 * session is live while its process is tracked and has not exited.
 */
function isSessionLive(session: RuntimeSession): boolean {
  if (session.mode === 'attached') return true;
  if (session.mode === 'spawned') return session.process !== null && !session.process.hasExited;
  return false;
}

export interface RuntimeStopResult {
  mode: RuntimeSessionMode;
  /** Resolved absolute path of the project whose session was stopped. */
  projectPath: string;
  /**
   * The stopped process's retained stdout and stderr lines. Null for an
   * attached stop: that session captured nothing, which is not the same as a
   * process that printed nothing.
   */
  output: string[] | null;
  errors: string[] | null;
  externalProcessPreserved?: boolean;
  /**
   * True when the spawned process had already exited on its own and
   * `handleSpawnedProcessExit` had already cleared the session and its bridge
   * artifacts. Read by `handleStopProject` for message wording and payload.
   */
  alreadyExited?: boolean;
  /** Exit code captured by the auto-clear, when `alreadyExited`. */
  exitCode?: number | null;
  /**
   * Bridge cleanup steps that were attempted and not confirmed, as sentences
   * (see `BridgeManager.cleanup`). For an `alreadyExited` stop these are the
   * ones recorded when the process exited. Empty when cleanup was complete.
   */
  cleanupProblems: string[];
  /**
   * Attached stops only: whether the bridge inside the still-running Godot
   * answered the `shutdown` command. False means it did not, so it is still
   * listening on its port.
   */
  shutdownAcknowledged?: boolean;
  /**
   * True when the record held nothing but a finished profiler capture: its
   * process had exited and an earlier stop had already returned its logs. This
   * stop released the capture, so `output` and `errors` are null.
   */
  releasedCaptureOnly?: boolean;
}

/**
 * True when a bridge reply to `shutdown` is an acknowledgement. The bridge
 * answers every refusal (a wrong token, a frame it cannot read) with an
 * `error` key, so a reply that parses and carries none is its shutdown handler
 * having run. A reply arriving at all is not enough: a refusal is a reply too.
 */
function isShutdownAcknowledged(response: string): boolean {
  try {
    const parsed: unknown = JSON.parse(response);
    return typeof parsed === 'object' && parsed !== null && !('error' in parsed);
  } catch {
    return false;
  }
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

/**
 * A `child_process.spawn` promise rejection carries `stdout`/`stderr`
 * captured before the failure (e.g. a timeout kill) on top of the plain
 * `Error` shape. Narrows `error: unknown` from a catch block to that shape,
 * or returns null when it doesn't match. Shared by `executeOperation` and
 * `importAssets`, which both need to recover partial output from a spawn
 * failure rather than losing it to a rethrow.
 */
function asSpawnError(error: unknown): (Error & { stdout: string; stderr: string }) | null {
  if (error instanceof Error && 'stdout' in error && 'stderr' in error) {
    return error as Error & { stdout: string; stderr: string };
  }
  return null;
}

export class GodotRunner {
  private godotPath: string | null = null;
  private operationsScriptPath: string;
  private bridge: BridgeManager;
  private validatedPaths: Map<string, boolean> = new Map();
  private cachedVersion: string | null = null;
  /** One record per project, keyed by {@link sessionKey}. */
  private sessions = new Map<string, RuntimeSession>();
  /**
   * The session the runtime tools act on, or null. Set by `runProject`,
   * `attachProject` and `switchSession`; emptied when its session is stopped
   * or forgotten. Never moved to another session implicitly: the one way it
   * goes back to an earlier session is a start that launched nothing undoing
   * its own move (see `restoreCurrentAfterFailedStart`).
   */
  private current: RuntimeSession | null = null;
  /** How session games are killed. A field so tests can substitute the OS calls. */
  private killTreeDeps: KillTreeDeps = defaultKillTreeDeps;

  private socket: net.Socket | null = null;
  /**
   * The session the open bridge socket was dialed for. There is one socket,
   * and it follows the session a command is sent to: `sendCommandTo` closes a
   * socket that belongs to a different session before dialing.
   */
  private socketSession: RuntimeSession | null = null;
  /**
   * True once a TCP connect to the bridge port has succeeded since the current
   * session became current. Set in `sendCommandTo`'s `ensureSocket`
   * `onConnect` callback, read by `pollBridge` to switch to the extended
   * readiness budget, and reset in `setCurrent` so it never leaks across
   * sessions.
   */
  private bridgeConnectObserved = false;
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

  // Read-only views of the current session. A session on another project is
  // reachable only through the methods that take a projectPath or return
  // RuntimeSessionInfo snapshots, so a caller reading these names can never
  // act on a non-current session by accident.

  get activeSessionMode(): RuntimeSessionMode | null {
    return this.current?.mode ?? null;
  }

  /** Null once the current session's process exited; the record keeps its path. */
  get activeProjectPath(): string | null {
    return this.current !== null && this.current.mode !== null ? this.current.projectPath : null;
  }

  get activeBridgePort(): number | null {
    return this.current?.bridgePort ?? null;
  }

  get activeProcess(): GodotProcess | null {
    return this.current?.process ?? null;
  }

  get activeProfiler(): DebuggerProfiler | null {
    return this.current?.profiler ?? null;
  }

  private get activeSessionToken(): string | null {
    return this.current?.token ?? null;
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
      const proc = spawn(cmd, args, godotSpawnOptions('headless'));
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
   * True when `project.godot` currently registers the `McpBridge` autoload
   * pointing at this server's script. Thin pass-through to BridgeManager —
   * used by the bridge-not-ready timeout diagnostic to tell "the game started
   * with no bridge autoload at all" from "the bridge is registered but never
   * became ready".
   */
  isBridgeAutoloadRegistered(projectPath: string): boolean {
    return this.bridge.isBridgeAutoloadRegistered(projectPath);
  }

  /**
   * Other live MCP sessions (different server process, or a different
   * `BridgeManager` instance in this same process) currently registered on
   * this project, excluding this runner's own session. Thin pass-through to
   * `BridgeManager.listOtherLiveOwners`, resolving the path the same way
   * `runProject`/`attachProject` do so the lookup matches their own owner
   * file's directory. Powers the cross-server edit guard in
   * `rejectIfLiveSessionOnProject` (src/utils/headless-op.ts).
   */
  otherLiveSessionsOnProject(projectPath: string): BridgeOwnerInfo[] {
    return this.bridge.listOtherLiveOwners(resolve(projectPath));
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
      const spawnError = asSpawnError(error);
      if (!spawnError) throw error;
      stdout = spawnError.stdout;
      stderr = spawnError.stderr;
    }

    // If the process produced no operation output but has errors, initialization
    // failed before the script ran. Autoload errors are the most common cause.
    // The engine banner is on stdout, so "stdout is not empty" is true for every
    // run. The script's own first line is the evidence that dispatch started.
    const operationRan =
      stderr.includes(OPERATION_STARTED_MARKER) || extractOperationPayload(stdout) !== null;
    if (!operationRan && (stderr.includes('ERROR:') || stderr.includes('SCRIPT ERROR:'))) {
      throw new Error(
        `Headless Godot failed before the operation could run - likely an autoload initialization error.\n` +
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
    const editor = spawn(
      this.godotPath,
      ['-e', '--path', projectPath],
      godotSpawnOptions('editor'),
    );
    // Nothing reads the editor's output, but the pipes stay open on purpose
    // (see godotSpawnOptions). An unread pipe fills, and a writer blocked on a
    // full pipe is a frozen editor, so both streams are put into flowing mode
    // and their data discarded.
    editor.stdout?.resume();
    editor.stderr?.resume();
    return editor;
  }

  /**
   * Run `godot --headless --import --path <projectPath>` to (re)import assets
   * into `.godot/imported`. Called by `executeSceneOp` (src/utils/headless-op.ts)
   * when the scene-load probe in godot_operations.gd reports an unimported
   * dependency via the `[IMPORT_NEEDED]` stderr marker: a fresh project (or a
   * newly-added asset) has no imported artifacts yet, and resource-touching
   * operations would otherwise fail with `resource not found` even though the
   * file is on disk — the import step has never run for it.
   *
   * Note: Godot exits 0 even when individual assets fail to import; this
   * method inspects stderr for "ERROR: Error importing" and throws if found,
   * since the caller has no other signal that the import didn't fully succeed.
   */
  async importAssets(projectPath: string, timeoutMs: number = IMPORT_TIMEOUT_MS): Promise<void> {
    if (!this.godotPath) {
      await this.detectGodotPath();
      if (!this.godotPath) {
        throw new Error('Could not find a valid Godot executable path');
      }
    }
    logDebug(`Importing assets for project: ${projectPath}`);
    let stderr = '';
    try {
      ({ stderr } = await this.spawnAsync(
        this.godotPath,
        ['--headless', '--import', '--path', projectPath],
        timeoutMs,
      ));
    } catch (error: unknown) {
      const spawnError = asSpawnError(error);
      if (!spawnError) throw error;
      stderr = spawnError.stderr;
    }
    // Godot exits 0 even when individual assets fail; check stderr for import errors.
    const failedFiles = [...stderr.matchAll(/ERROR: Error importing '([^']+)'/g)].map((m) => m[1]);
    if (failedFiles.length > 0) {
      throw new Error(
        `Asset import reported errors for ${failedFiles.length} file(s):\n` +
          failedFiles.map((f) => `  - ${f}`).join('\n') +
          '\nCheck the files are valid (PNG/SVG/etc.) and the Godot version matches the project.',
      );
    }
  }

  async runProject(
    projectPath: string,
    scene?: ResolvedProjectPath,
    background: boolean = false,
    bridgePort?: number,
    profiling: boolean = false,
  ): Promise<GodotProcess> {
    if (!this.godotPath) {
      throw new Error(
        'No Godot executable resolved. Set GODOT_PATH to a Godot 4.x binary, or pass godotPath via config.',
      );
    }

    // Resolve relative paths (e.g. ".") to absolute against the server's cwd.
    // The bridge reports an absolute project_path in its pong, so a relative
    // expectedPath makes pollBridge's path guard fail immediately and mask
    // the real reason as a generic bridge timeout.
    projectPath = resolve(projectPath);

    // Checked before any teardown: a launch that cannot happen must not cost
    // the project the session it already has.
    if (!checkDisplayAvailable()) {
      throw new Error(
        'No display server available (DISPLAY and WAYLAND_DISPLAY are both unset). ' +
          'Godot requires a display to run a project window.',
      );
    }

    // Only a session on this same project is replaced. Sessions on other
    // projects keep running and are not touched.
    const key = sessionKey(projectPath);
    const previous = this.sessions.get(key) ?? null;
    let replacedAttached: ReplacedAttachedSession | null = null;
    if (previous !== null) {
      this.beginSessionTransition(previous);
      this.closeProfiler(previous);
      if (previous.mode === 'spawned' && previous.process) {
        logDebug('Killing existing Godot process before starting a new one');
        terminateProcessTree(previous.process.process, this.killTreeDeps);
      } else if (previous.mode === 'attached') {
        // The Godot the user launched keeps running, and until its bridge is
        // told to shut down it keeps listening with the old session's token.
        // Same bounded request stop_project makes; whether it was answered is
        // kept for run_project to report.
        replacedAttached = {
          bridgePort: previous.bridgePort,
          shutdownAcknowledged: await this.shutdownAttachedBridge(previous),
        };
        // The shutdown was awaited: another start on this project may have
        // registered its own record meanwhile, and it is not this start's to
        // replace.
        if (this.sessions.get(key) !== previous) {
          throw new Error(
            `The session on ${projectPath} was stopped or replaced while its attached session was being detached; nothing was launched.`,
          );
        }
      }
      // No bridge cleanup for the same path: the replacement re-injects over
      // the same owner file.
      this.cleanupRespelledProject(previous, projectPath);
    }

    const session = this.createSession(projectPath, 'spawned');
    session.replacedAttached = replacedAttached;
    const epoch = session.epoch;
    const previousCurrent = this.current;
    this.sessions.set(key, session);
    this.setCurrent(session);

    // Set the moment inject is called, not when it returns, as in
    // attachProject: inject writes its owner file first, so one that throws
    // part-way (the swallowed kind below) has left a live owner claim on the
    // project. If a later step of this start then fails, that claim has to be
    // withdrawn, or every other server is told a session is running here
    // until this server exits.
    let injectAttempted = false;
    let processSpawned = false;
    try {
      const port = bridgePort ?? (await findFreePort());
      this.assertStartStillOwned(session, epoch);
      // The token is set before the port: a record with a port can be dialed,
      // and a frame sent to it must never go out without the token.
      const sessionToken = randomBytes(16).toString('hex');
      session.token = sessionToken;
      session.bridgePort = port;

      injectAttempted = true;
      try {
        this.bridge.inject(projectPath, port);
      } catch (err) {
        // A name collision with a user's own McpBridge autoload, and an owner
        // registry that could not be read, are the inject failures the caller
        // can act on (rename the autoload; retry), and swallowing either would
        // surface as a generic bridge timeout half a minute later. Inject
        // leaves no owner file behind for either. Everything else (an
        // unwritable project directory, a packaging problem in the shipped
        // template) still degrades to a bridgeless run, as before.
        if (
          err instanceof BridgeAutoloadCollisionError ||
          err instanceof BridgeRegistryUnreadableError
        ) {
          throw err;
        }
        logDebug(`Non-fatal: Failed to inject bridge autoload: ${err}`);
      }

      const cmdArgs = ['--path', projectPath];
      if (profiling) {
        const profiler = await DebuggerProfiler.create();
        // Assigned before the check so a start that lost its record still
        // releases the listener through discardFailedStart.
        session.profiler = profiler;
        this.assertStartStillOwned(session, epoch);
        cmdArgs.push('--remote-debug', `tcp://127.0.0.1:${profiler.port}`);
        logDebug(`Profiling enabled (debugger port ${profiler.port})`);
      }
      if (scene) {
        logDebug(`Adding scene parameter: ${scene.resPath}`);
        cmdArgs.push(scene.resPath);
      }

      const portSource = bridgePort !== undefined ? 'explicit' : 'auto';
      logDebug(`Running Godot project: ${projectPath} (bridge port ${port}, ${portSource})`);
      const spawnOptions: SpawnOptions = {
        ...godotSpawnOptions(background ? 'run-background' : 'run'),
        env: {
          ...process.env,
          MCP_SESSION_TOKEN: sessionToken,
          // Delivers this session's resolved port without baking it into the
          // shared script — see BridgeManager: spawned sessions never bake,
          // so the on-disk script stays identical for every spawned session
          // regardless of who wrote it.
          MCP_BRIDGE_PORT: String(port),
        },
      };
      if (background) {
        spawnOptions.env = { ...spawnOptions.env, MCP_BACKGROUND: '1' };
      }
      const proc = spawn(this.godotPath, cmdArgs, spawnOptions);
      processSpawned = true;
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
        this.ingestStdoutChunk(godotProcess, data.toString());
      });

      proc.stderr?.on('data', (data: Buffer) => {
        this.ingestStderrChunk(godotProcess, data.toString());
      });

      proc.on('exit', (code: number | null) => {
        this.handleSpawnedProcessExit(session, godotProcess, epoch, code);
      });

      proc.on('error', (err: Error) => {
        console.error('Failed to start Godot process:', err);
        // Through ingestStderrChunk, not a bare errors.push: it is the only
        // writer of `errors` and `totalErrorsWritten`, and every sentinel `seq`
        // and `getErrorsSince` window is computed from the two staying in step.
        // One uncounted push shifts every later window by a line.
        this.ingestStderrChunk(godotProcess, `Process error: ${err.message}\n`);
        godotProcess.hasExited = true;
        // The engine will never dial back, so nothing can arrive on the debugger
        // listener. Holding the port open until the next run_project is pointless.
        this.closeProfiler(session);
      });

      session.process = godotProcess;
      return godotProcess;
    } catch (err) {
      // Nothing is running for this record: drop it, release the debugger
      // listener, and remove whatever bridge artifacts the start (or the
      // session it replaced) left on the project.
      const heldCurrent = this.current === session;
      this.appendCleanupProblems(
        err,
        this.discardFailedStart(session, injectAttempted || previous !== null),
      );
      if (!processSpawned && heldCurrent) this.restoreCurrentAfterFailedStart(previousCurrent);
      throw err;
    }
  }

  /**
   * Give the current pointer back to the session that held it before a start
   * that launched nothing. Such a start took the pointer and then failed
   * without anything to show for it (a name collision, an unreadable
   * registry), so leaving the pointer empty would be the call moving it by
   * itself. This is an undo, not a promotion: only the record that was
   * current before the call is considered, only when it is still registered
   * (a session the start replaced is not), and only when nothing else has
   * taken the pointer since.
   */
  private restoreCurrentAfterFailedStart(previousCurrent: RuntimeSession | null): void {
    if (previousCurrent === null || this.current !== null) return;
    if (this.sessions.get(previousCurrent.key) !== previousCurrent) return;
    this.setCurrent(previousCurrent);
  }

  /**
   * Move a session to its next epoch. Called as the first synchronous
   * statement of every path that supersedes or stops that session, before any
   * `await`, any `kill` and any bridge call, so handlers registered under the
   * previous epoch are inert the moment the transition starts.
   *
   * The counter is per session on purpose. A spawned process's exit handler
   * captures the value its own session had at registration and does nothing
   * when it no longer matches, so a late exit from a superseded process cannot
   * clear the session that replaced it. Process identity is not enough: under
   * `profiling: true`, `runProject` awaits `DebuggerProfiler.create()` between
   * `bridge.inject()` and the new record's `process` assignment, and a handler
   * that only asked "does this project have a session" firing in that window
   * would clean the replacement's freshly injected bridge script. A single
   * runner-wide counter fails the other way: starting a second project would
   * make the first project's own later exit look superseded, and that session
   * would never clear itself.
   */
  private beginSessionTransition(session: RuntimeSession): number {
    session.epoch += 1;
    return session.epoch;
  }

  /** Build a session record. Does not register it. */
  private createSession(projectPath: string, mode: RuntimeSessionMode | null): RuntimeSession {
    return {
      key: sessionKey(projectPath),
      projectPath,
      mode,
      bridgePort: null,
      token: null,
      process: null,
      profiler: null,
      epoch: 0,
      exitCleanupProblems: [],
      replacedAttached: null,
    };
  }

  /**
   * Point `current` at a session, or at nothing. The bridge socket follows:
   * a socket dialed for any other session is closed here, and the next
   * command lazy-connects to the new current session's port with its token.
   */
  private setCurrent(session: RuntimeSession | null): void {
    if (this.current === session) return;
    if (this.socketSession !== session) this.closeConnection();
    this.bridgeConnectObserved = false;
    this.current = session;
  }

  /**
   * Drop a session record. Leaves `current` empty when it pointed here; no
   * other session is promoted in its place.
   */
  private forgetSession(session: RuntimeSession): void {
    if (this.sessions.get(session.key) === session) this.sessions.delete(session.key);
    if (this.current === session) this.setCurrent(null);
  }

  private closeProfiler(session: RuntimeSession): void {
    session.profiler?.close();
    session.profiler = null;
  }

  /**
   * Undo a start that threw before it produced a running session. The record
   * is dropped so nothing reports a session that never ran, and the bridge
   * artifacts are removed when this start injected them (or tried to: an
   * inject that throws part-way has already written its owner file) or when it
   * replaced a session whose artifacts would otherwise have no owner left to
   * remove them.
   *
   * Returns what that cleanup attempted and could not confirm. The start is
   * about to rethrow to its caller, which is the only place left to say so.
   */
  private discardFailedStart(session: RuntimeSession, ownsArtifacts: boolean): string[] {
    this.closeProfiler(session);
    this.forgetSession(session);
    if (!ownsArtifacts) return [];
    // Another record took this project while the start was in flight. It
    // shares the owner file, so the artifacts are its to remove now.
    if (this.sessions.has(session.key)) return [];
    try {
      return this.bridge.cleanup(session.projectPath);
    } catch (err) {
      logDebug(`Bridge cleanup after a failed start failed (ignored): ${err}`);
      return [`bridge cleanup failed outright (${String(err)})`];
    }
  }

  /**
   * Put cleanup problems on the error a caller is about to receive. They were
   * found while handling that error, and no later call would report them: the
   * session record is already gone.
   */
  private appendCleanupProblems(error: unknown, problems: readonly string[]): void {
    if (problems.length === 0 || !(error instanceof Error)) return;
    error.message += ` Bridge cleanup was incomplete: ${problems.join('; ')}`;
  }

  /**
   * Refuse to go on with a start whose record was stopped or replaced inside
   * one of the start's own awaits (a server shutdown landing there is the
   * realistic case). Going on would inject a bridge and spawn a process for a
   * record nothing tracks any more: its exit handler is already inert, no
   * stop can reach it, and the exit-time cleanup never visits it.
   */
  private assertStartStillOwned(session: RuntimeSession, epoch: number): void {
    if (session.epoch === epoch && this.sessions.get(session.key) === session) return;
    throw new Error(
      `The session on ${session.projectPath} was stopped or replaced while it was starting; nothing was launched.`,
    );
  }

  /**
   * Session keys fold case and separators, so a start can replace a record
   * whose stored path is spelled differently. When the two spellings are the
   * same directory this costs one redundant cleanup before the re-inject; on a
   * case-sensitive filesystem they can be two directories, and the replaced
   * one would otherwise keep its bridge artifacts with no record left to
   * remove them.
   */
  private cleanupRespelledProject(previous: RuntimeSession, projectPath: string): void {
    if (previous.projectPath === projectPath) return;
    try {
      this.bridge.cleanup(previous.projectPath);
    } catch (err) {
      logDebug(`Bridge cleanup for a replaced session failed (ignored): ${err}`);
    }
  }

  private describeSession(session: RuntimeSession): RuntimeSessionInfo {
    const exited = session.process !== null && session.process.hasExited ? session.process : null;
    return {
      projectPath: session.projectPath,
      mode: session.mode,
      live: isSessionLive(session),
      current: this.current === session,
      bridgePort: session.bridgePort,
      processExited: exited !== null,
      exitCode: exited !== null ? exited.exitCode : null,
      hasRetainedLogs: session.process !== null,
      profiling: session.profiler !== null,
      replacedAttached: session.replacedAttached,
    };
  }

  /**
   * `'exit'` handler for a spawned Godot process: the session auto-clear.
   *
   * WIDEST INPUT: this fires for every exit of every process this runner ever
   * spawned — a crash, a window the user closed, a `stopProject` kill, and the
   * kill `runProject` issues before starting a replacement. `exitCode` and
   * `hasExited` are recorded unconditionally because the buffer belongs to the
   * captured process whichever record holds it; everything after the epoch
   * check mutates the session and its bridge artifacts and so runs only while
   * the session is still in the epoch that registered this handler.
   *
   * The record's `process` and `profiler` are deliberately left alone, the
   * record stays in the map, and `current` is not moved: the output buffer and
   * exit code live on the former, a capture that finished just before a crash
   * stays readable through the latter, and a session that was current stays
   * the one `get_debug_output` and `stop_project` act on.
   */
  private handleSpawnedProcessExit(
    session: RuntimeSession,
    proc: GodotProcess,
    epoch: number,
    code: number | null,
  ): void {
    const normalizedCode = normalizeExitCode(code);
    logDebug(`Godot process exited with code ${normalizedCode}`);
    proc.exitCode = normalizedCode;
    proc.hasExited = true;

    if (session.epoch !== epoch) {
      logDebug('Ignoring exit from a superseded Godot session (session epoch moved on)');
      return;
    }

    session.mode = null;
    session.bridgePort = null;
    session.token = null;
    // The socket to a dead peer is garbage. Only when it is this session's:
    // an exit on another project must not cut the current session's channel.
    // Idempotent, and the rejection it issues on an in-flight command is a
    // BridgeDisconnectedError the spawned branch of sendCommandWithReconnect
    // already ignores.
    if (this.socketSession === session) this.closeConnection();
    // Nobody is waiting on this exit, so what the cleanup could not confirm is
    // kept on the record for the stop_project that reads it later.
    try {
      session.exitCleanupProblems = this.bridge.cleanup(session.projectPath);
    } catch (err) {
      logDebug(`Bridge cleanup after process exit failed: ${err}`);
      session.exitCleanupProblems = [`bridge cleanup failed outright (${String(err)})`];
    }
  }

  /**
   * Drop an attached session whose bridge has gone away. Mirrors the
   * attached branch of `stopSession` minus the `shutdown` command, since
   * there is no peer left to talk to. An attached session retains nothing, so
   * its record is deleted outright.
   *
   * Production call site: the disconnect probe in `sendCommandWithReconnect`.
   *
   * Returns what the cleanup attempted and could not confirm. The record is
   * deleted here, so no later stop_project can report it: the caller puts it
   * on the error it is about to throw.
   */
  private clearAttachedSession(session: RuntimeSession): string[] {
    if (this.socketSession === session) this.closeConnection();
    let problems: string[];
    try {
      problems = this.bridge.cleanup(session.projectPath);
    } catch (err) {
      logDebug(`Bridge cleanup after attached disconnect failed (ignored): ${err}`);
      problems = [`bridge cleanup failed outright (${String(err)})`];
    }
    this.forgetSession(session);
    return problems;
  }

  /**
   * Synchronous, never-throwing bridge artifact removal for every session
   * that still holds artifacts. `BridgeManager.cleanup` is pure synchronous
   * `fs`, so this is safe from a `process.on('exit')` handler, where promises
   * never settle. One guard per session, so a cleanup that throws on one
   * project does not cost the others theirs. A session whose mode is null was
   * already cleaned by its own exit handler.
   *
   * Production call site: the `'exit'` handler registered by
   * `registerProcessLifecycle` in `src/index.ts`.
   */
  cleanupBridgeArtifactsSync(): void {
    for (const session of [...this.sessions.values()]) {
      if (session.mode === null) continue;
      try {
        this.bridge.cleanup(session.projectPath);
      } catch {
        // Exit handlers must not throw; there is nowhere left to report to.
      }
    }
  }

  /**
   * Force a process and its children down. Never throws. A process with no
   * pid never started, so there is no tree to walk and `kill` is a no-op.
   */
  private forceKillProcessTree(proc: ChildProcess): void {
    if (proc.pid !== undefined) {
      killProcessTree(proc, this.killTreeDeps);
      return;
    }
    try {
      proc.kill('SIGKILL');
    } catch {
      // already dead
    }
  }

  /**
   * Synchronous, never-throwing kill of every spawned game still running, for
   * the `process.on('exit')` handler. A graceful shutdown has already stopped
   * every session by then; this is for the exits that skip it (a stop that
   * threw, an uncaught error), where the games would otherwise outlive the
   * server with nothing left to stop them. Attached sessions are not this
   * server's processes and are left running. The bridge `shutdown` command is
   * not sent: there is no event loop left to send it on.
   */
  killSpawnedProcessesSync(): void {
    for (const session of [...this.sessions.values()]) {
      const tracked = session.process;
      if (session.mode !== 'spawned' || tracked === null || tracked.hasExited) continue;
      try {
        this.forceKillProcessTree(tracked.process);
      } catch {
        // Exit handlers must not throw; there is nowhere left to report to.
      }
    }
  }

  async attachProject(projectPath: string, bridgePort?: number): Promise<void> {
    // Resolve relative paths for the same reason as runProject — pollBridge
    // compares against the absolute path the bridge reports.
    projectPath = resolve(projectPath);

    // Only a session on this same project is replaced. A session on another
    // project, spawned or attached, is left as it is.
    const key = sessionKey(projectPath);
    const previous = this.sessions.get(key) ?? null;
    if (previous !== null) {
      if (previous.mode === 'spawned' && previous.process) {
        await this.stopSession(previous);
      } else {
        this.beginSessionTransition(previous);
        this.closeProfiler(previous);
        this.forgetSession(previous);
        this.cleanupRespelledProject(previous, projectPath);
      }
    }

    const session = this.createSession(projectPath, 'attached');
    const epoch = session.epoch;
    const previousCurrent = this.current;
    this.sessions.set(key, session);
    this.setCurrent(session);

    // Set the moment inject is called, not when it returns. inject writes its
    // owner file and the baked script before it touches .gitignore and
    // project.godot, so one that throws there has left a live owner claim on
    // the project. Without a cleanup that claim stands until this server
    // exits, and every other server is told a session is running here.
    let injectAttempted = false;
    try {
      const port = bridgePort ?? (await findFreePort());
      this.assertStartStillOwned(session, epoch);
      // Attach has no env channel to a Godot process the user launched
      // themselves, so the baked script copy is the only way to deliver the
      // auth token. Set before the port, so the record never has a port to
      // dial without the token every frame must carry.
      const token = randomBytes(16).toString('hex');
      session.token = token;
      session.bridgePort = port;
      injectAttempted = true;
      this.bridge.inject(projectPath, port, token);
      const portSource = bridgePort !== undefined ? 'explicit' : 'auto';
      logDebug(`Attaching to Godot project: ${projectPath} (bridge port ${port}, ${portSource})`);
    } catch (err) {
      const heldCurrent = this.current === session;
      this.appendCleanupProblems(
        err,
        this.discardFailedStart(session, injectAttempted || previous !== null),
      );
      // An attach never spawns, so a failure here always launched nothing.
      if (heldCurrent) this.restoreCurrentAfterFailedStart(previousCurrent);
      throw err;
    }
  }

  /**
   * Stop the current session. Leaves `current` empty afterwards: a session on
   * another project is never promoted in its place.
   */
  async stopProject(): Promise<RuntimeStopResult | null> {
    const session = this.current;
    if (!session) return null;
    return this.stopSession(session);
  }

  /**
   * Ask an attached session's bridge to shut down, so the user's
   * still-running Godot releases the port, then close the socket. Bounded by
   * BRIDGE_SHUTDOWN_ATTACHED_TIMEOUT_MS and never throws: a bridge that does
   * not answer does not stop the detach, it dies when the user closes Godot.
   * Returns whether it acknowledged, read from the reply, because until it
   * does the bridge is still listening with that session's token.
   */
  private async shutdownAttachedBridge(session: RuntimeSession): Promise<boolean> {
    let shutdownAcknowledged = false;
    try {
      const reply = await this.sendCommandTo(
        session,
        'shutdown',
        {},
        BRIDGE_SHUTDOWN_ATTACHED_TIMEOUT_MS,
      );
      shutdownAcknowledged = isShutdownAcknowledged(reply);
    } catch (err) {
      logDebug(`Attached shutdown timed out or failed (continuing): ${err}`);
    }
    this.closeConnection();
    return shutdownAcknowledged;
  }

  private async stopSession(session: RuntimeSession): Promise<RuntimeStopResult | null> {
    this.beginSessionTransition(session);
    if (session.mode === null) {
      // Release the debugger listener before any early return. A record with
      // no mode and no process is a finished capture kept readable after an
      // earlier stop; stopping again is where it is finally released. That is
      // a stop that did something, so it is reported as one: the callers that
      // point here (switch_project, check_project) say stop_project frees it.
      if (!session.process) {
        const heldCapture = session.profiler !== null;
        this.closeProfiler(session);
        this.forgetSession(session);
        if (!heldCapture) return null;
        return {
          mode: 'spawned',
          projectPath: session.projectPath,
          // The logs went out with the earlier stop: nothing is held, which is
          // not the same as a process that printed nothing.
          output: null,
          errors: null,
          alreadyExited: true,
          cleanupProblems: [],
          releasedCaptureOnly: true,
        };
      }

      // The process exited on its own and handleSpawnedProcessExit already
      // closed the connection and ran the bridge cleanup. Nothing left to
      // kill or clean: hand back the captured logs, and whatever that cleanup
      // could not confirm, so stop_project stays idempotent and honest. A
      // capture that finished before the exit survives; only an unfinished
      // one is torn down.
      const exited = session.process;
      if (session.profiler !== null && !session.profiler.hasResult) {
        this.closeProfiler(session);
      }
      session.process = null;
      // A finished capture keeps the record, process-less, so it stays
      // readable through `activeProfiler` until the next stop.
      if (session.profiler === null) this.forgetSession(session);
      return {
        mode: 'spawned',
        projectPath: session.projectPath,
        output: exited.output,
        errors: exited.errors,
        alreadyExited: true,
        exitCode: exited.exitCode,
        cleanupProblems: session.exitCleanupProblems,
      };
    }

    if (session.mode === 'attached') {
      const shutdownAcknowledged = await this.shutdownAttachedBridge(session);
      this.closeProfiler(session);
      const cleanupProblems = this.bridge.cleanup(session.projectPath);
      this.forgetSession(session);
      return {
        mode: 'attached',
        projectPath: session.projectPath,
        // Nothing was captured: null, never an empty log.
        output: null,
        errors: null,
        externalProcessPreserved: true,
        cleanupProblems,
        shutdownAcknowledged,
      };
    }

    const tracked = session.process;
    if (!tracked) {
      // Only a start that has not spawned yet looks like this (a shutdown
      // arriving inside the start's own awaits). There is nothing to kill,
      // but the start may already have injected: its owner file and the
      // McpBridge entry are on the project. The start removes them when it
      // resumes and finds its record gone, and a server shutdown can exit
      // before it ever resumes, after which nothing visits this project
      // (the exit-time cleanup walks the session map, and this record is
      // about to leave it). So they are removed here; the resumed start's own
      // cleanup then finds nothing left to do.
      // A record gets its port in the statement before inject is called, so
      // one with no port yet has injected nothing and is left alone.
      this.closeProfiler(session);
      if (session.bridgePort !== null) {
        try {
          const problems = this.bridge.cleanup(session.projectPath);
          if (problems.length > 0) {
            logDebug(`Bridge cleanup for a start stopped mid-flight: ${problems.join('; ')}`);
          }
        } catch (err) {
          logDebug(`Bridge cleanup for a start stopped mid-flight failed (ignored): ${err}`);
        }
      }
      this.forgetSession(session);
      return null;
    }

    // Spawned: try graceful shutdown so the bridge releases the port,
    // then ensure the process actually exits.
    try {
      await this.sendCommandTo(session, 'shutdown', {}, BRIDGE_SHUTDOWN_SPAWNED_TIMEOUT_MS);
    } catch {
      // Bridge may already be unreachable — proceed to kill.
    }
    this.closeConnection();
    this.closeProfiler(session);

    logDebug('Stopping Godot process');
    const proc = tracked.process;
    // The pid may be a wrapper (the Windows *_console.exe, a launcher), so the
    // kill takes the tree: killing the wrapper alone would report a stop while
    // the real game keeps running and holding the bridge port.
    terminateProcessTree(proc, this.killTreeDeps);

    // Wait up to BRIDGE_PROCESS_EXIT_TIMEOUT_MS for the exit; otherwise force
    // the whole tree down.
    if (!tracked.hasExited) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.forceKillProcessTree(proc);
          resolve();
        }, BRIDGE_PROCESS_EXIT_TIMEOUT_MS);
        proc.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    session.process = null;
    const cleanupProblems = this.bridge.cleanup(session.projectPath);
    this.forgetSession(session);

    return {
      mode: 'spawned',
      projectPath: session.projectPath,
      output: tracked.output,
      errors: tracked.errors,
      cleanupProblems,
    };
  }

  /**
   * Stop every session, for server shutdown. Bounded: each stop spends at
   * most its shutdown-command timeout plus BRIDGE_PROCESS_EXIT_TIMEOUT_MS. One
   * session failing to stop does not keep the others running.
   */
  async stopAllSessions(): Promise<void> {
    for (const session of [...this.sessions.values()]) {
      try {
        await this.stopSession(session);
      } catch (err) {
        logDebug(`Stopping the session on ${session.projectPath} failed (continuing): ${err}`);
      }
    }
    // A stop of an already-exited session keeps a finished profiler capture
    // readable; at shutdown nothing will read it. A record whose stop threw
    // still has a mode and is left in place, so the synchronous exit handler
    // gets one more attempt at its bridge artifacts.
    for (const session of [...this.sessions.values()]) {
      if (session.mode !== null) continue;
      this.closeProfiler(session);
      this.forgetSession(session);
    }
  }

  /** True when there is a current session and it is live. */
  hasActiveRuntimeSession(): boolean {
    return this.current !== null && isSessionLive(this.current);
  }

  /** Every session record, live or retained, in the order the projects were started. */
  listSessions(): RuntimeSessionInfo[] {
    return [...this.sessions.values()].map((session) => this.describeSession(session));
  }

  listLiveSessions(): RuntimeSessionInfo[] {
    return this.listSessions().filter((info) => info.live);
  }

  /** The session on one project, current or not. Null when the project has none. */
  getSessionInfo(projectPath: string): RuntimeSessionInfo | null {
    const session = this.sessions.get(sessionKey(projectPath));
    return session ? this.describeSession(session) : null;
  }

  getCurrentSessionInfo(): RuntimeSessionInfo | null {
    return this.current ? this.describeSession(this.current) : null;
  }

  getRuntimeSessionStatus(): RuntimeSessionStatus {
    const current = this.current;
    const otherLiveSessions = [...this.sessions.values()]
      .filter((session) => session !== current && isSessionLive(session))
      .map((session) => this.describeSession(session));
    if (current === null) return { state: 'none', current: null, otherLiveSessions };
    return {
      state: isSessionLive(current) ? 'live' : 'exited',
      current: this.describeSession(current),
      otherLiveSessions,
    };
  }

  /**
   * The current session, or a `NoLiveCurrentSessionError` when there is none
   * or it is no longer live. Never falls back to another live session.
   */
  requireLiveCurrentSession(): RuntimeSessionInfo {
    const status = this.getRuntimeSessionStatus();
    if (status.state !== 'live' || status.current === null) {
      throw new NoLiveCurrentSessionError(status);
    }
    return status.current;
  }

  /** True when this runner has a live session on the project, current or not. */
  hasLiveSessionOnProject(projectPath: string): boolean {
    const session = this.sessions.get(sessionKey(projectPath));
    return session !== undefined && isSessionLive(session);
  }

  /**
   * Make a project's session current and close the bridge socket, so the next
   * command dials that session. Returns null, changing nothing, when the
   * project has no session. Succeeds on a retained session whose process has
   * exited and reports it as `live: false`: that is how its logs are read and
   * how it is freed.
   */
  switchSession(projectPath: string): RuntimeSessionInfo | null {
    const session = this.sessions.get(sessionKey(projectPath));
    if (!session) return null;
    this.setCurrent(session);
    return this.describeSession(session);
  }

  /**
   * Copies of the retained stdout/stderr of a project's session, current or
   * not. Null when the project has no session or the session holds no process
   * (attached mode), so "nothing was captured" is never reported as empty logs.
   */
  readSessionLogs(projectPath: string): RuntimeSessionLogs | null {
    const proc = this.sessions.get(sessionKey(projectPath))?.process;
    if (!proc) return null;
    return {
      output: [...proc.output],
      errors: [...proc.errors],
      hasExited: proc.hasExited,
      exitCode: proc.exitCode,
    };
  }

  /**
   * Send a JSON command to the McpBridge over a long-lived TCP connection.
   *
   * MCP serializes tool calls so we hold one in-flight command at a time. The
   * socket is lazy-connected on first call and persists across commands until
   * `closeConnection` (or a peer-side close). A close mid-flight rejects with
   * `BridgeDisconnectedError`. A per-command timeout rejects with a plain
   * `Error` and destroys the socket, so a late response cannot be read as the
   * answer to the next command; it does not end the session, and the next
   * command reconnects.
   *
   * Always addresses the current session. With none, or with one that has no
   * bridge port left, nothing is dialed and the call rejects with
   * `BridgeDisconnectedError`.
   */
  sendCommand(
    command: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = 10000,
  ): Promise<string> {
    return this.sendCommandTo(this.current, command, params, timeoutMs);
  }

  /**
   * `sendCommand` against a named session. There is one socket: when the open
   * one was dialed for a different session it is closed first, and this
   * command dials the target's port and carries the target's token. Used
   * directly only by teardown, which has to reach a session that may not be
   * the current one.
   */
  private sendCommandTo(
    target: RuntimeSession | null,
    command: string,
    params: Record<string, unknown>,
    timeoutMs: number,
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

      if (this.socket !== null && this.socketSession !== target) this.closeConnection();

      // A session with no bridge port has nothing to dial: it never started,
      // or its process exited and the port went with it. Dialing a default
      // port instead could reach some other Godot that happens to listen
      // there, with a frame that carries no token.
      const port = target?.bridgePort ?? null;
      if (port === null) {
        reject(
          new BridgeDisconnectedError(
            `Command '${command}' not sent: the session has no bridge port to connect to`,
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
        if (this.socket) this.discardSocket(this.socket);
        this.resetRxBuffer();
        settle(
          new Error(`Command '${command}' timed out after ${timeoutMs}ms. Is the game running?`),
        );
      }, timeoutMs);

      const flight: InFlightCommand = { command, resolve, reject, timer };
      this.inFlight = flight;

      const ensureSocket = (cb: (err?: Error) => void): void => {
        if (this.socket) {
          cb();
          return;
        }
        const sock = net.connect(port, '127.0.0.1');
        // A connect can outlive the command that started it: the command timed
        // out, or closeConnection rejected it, while the connect was still
        // pending. Its late outcome then belongs to nobody. Installing that
        // socket would point the one channel at this command's session and
        // write this command's stale frame; reporting its failure would reject
        // whichever command is in flight by then, possibly one for another
        // session. Both callbacks act only while this command is still the one
        // in flight.
        const onConnect = (): void => {
          sock.removeListener('error', onConnectError);
          if (this.inFlight !== flight) {
            sock.destroy();
            return;
          }
          sock.setNoDelay(true);
          this.socket = sock;
          this.socketSession = target;
          this.bridgeConnectObserved = true;
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
              this.discardSocket(sock);
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
              this.discardSocket(sock);
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
          if (this.inFlight !== flight) return;
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
          const payload = JSON.stringify({
            command,
            token: target?.token ?? undefined,
            ...params,
          });
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
    this.socketSession = null;
    this.resetRxBuffer();
  }

  /**
   * Drop a socket this side has given up on: a command timed out on it, or it
   * delivered a frame that cannot be read. The listeners go before the
   * destroy. A destroyed socket still emits `'close'` a tick later, and a
   * `'close'` handler left on it would settle whichever command is in flight
   * by then with a disconnect it never had (in attached mode that is the
   * probe ping, and a failed probe ends a live session), and would null the
   * reference to the socket that replaced this one.
   */
  private discardSocket(sock: net.Socket): void {
    if (this.socket === sock) this.socket = null;
    sock.removeAllListeners();
    // An 'error' with no listener is thrown; one arriving on a socket nobody
    // is waiting on any more must not take the server down.
    sock.on('error', () => {});
    sock.destroy();
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

  /**
   * Fold one raw stderr chunk into a spawned session's buffers. The only writer
   * of `GodotProcess.errors` and `totalErrorsWritten`.
   *
   * Action-boundary sentinels are recorded as marks and never retained, so
   * every reader of `errors` - `get_debug_output`, `stop_project`'s
   * `finalErrors`, `getErrorsSince`, `getRecentErrors` - is clean without a
   * per-read filter. `totalErrorsWritten` counts retained lines only, which
   * keeps the delta arithmetic in `getErrorsSince` correct and makes each
   * mark's `seq` survive the ring trim below.
   *
   * Public only so unit tests can drive ingestion without spawning Godot; the
   * production caller is the session stderr handler in `runProject`.
   *
   * What is retained is lines, not `split('\n')` segments. A line has no
   * terminator left on it (the `\r` Windows writes before the `\n` is removed
   * with it), the empty string after a chunk's final newline is not a line,
   * and a blank line is not retained. Without that, a Windows log alternated
   * between `text\r` and `''`, and every stripped boundary line left a `''`
   * behind, which is what `get_debug_output`'s `limit` then counted.
   *
   * A `'data'` event boundary can land mid-line. The text after a chunk's last
   * newline is retained at once, so a reader sees it, and it is marked with
   * `proc.stderrTailIncomplete`; the next chunk pops it back off, continues it,
   * and only then decides what the finished line is. That is how a sentinel
   * split across two chunks is recognized: it is unrecognizable in either half.
   * A tail that already reads as a complete boundary is recorded as one at
   * once and is not held back for a continuation, because the bridge writes
   * each boundary in one `printerr` and the batch is waiting on it.
   *
   * Why the bookkeeping stays correct:
   * - `totalErrorsWritten` counts retained lines only. The pop decrements
   *   before the finished line's push increments, so the count lands where an
   *   unsplit chunk would have left it. Boundaries and blank lines are never
   *   counted, so dropping them shifts no window.
   * - `actionBoundaries[].seq`: an incomplete tail is the last thing its chunk
   *   retained, so no mark was recorded after it and the pop invalidates none.
   *   A mark from the finished line takes its `seq` from the already
   *   decremented counter.
   * - `STDERR_RING_LIMIT_LINES`: the trim removes from the front and the
   *   incomplete tail is the newest line, so it is never the line trimmed.
   * - Process exit with a dangling partial line: nothing to flush, it is
   *   already in `errors`.
   */
  ingestStderrChunk(proc: GodotProcess, text: string): void {
    if (text === '') return;
    let carried: string | null = null;
    if (proc.stderrTailIncomplete && proc.errors.length > 0) {
      carried = proc.errors.pop()!;
      proc.totalErrorsWritten -= 1;
    }
    const { complete, partial } = splitOutputChunk(text, carried);
    const recordBoundary = (line: string): boolean => {
      const boundaryIndex = parseActionBoundary(line);
      if (boundaryIndex === null) return false;
      if (!proc.actionBoundaries) proc.actionBoundaries = [];
      proc.actionBoundaries.push({ index: boundaryIndex, seq: proc.totalErrorsWritten });
      return true;
    };
    const retain = (line: string): void => {
      proc.errors.push(line);
      proc.totalErrorsWritten += 1;
      logDebug(`[Godot stderr] ${line}`);
    };
    for (const line of complete) {
      if (recordBoundary(line) || line.trim() === '') continue;
      retain(line);
    }
    proc.stderrTailIncomplete = false;
    if (partial !== null && !recordBoundary(partial)) {
      retain(partial);
      proc.stderrTailIncomplete = true;
    }
    if (proc.errors.length > STDERR_RING_LIMIT_LINES) {
      proc.errors.splice(0, proc.errors.length - STDERR_RING_LIMIT_LINES);
    }
  }

  /**
   * Fold one raw stdout chunk into a spawned session's `output` buffer, under
   * the same line rules as {@link ingestStderrChunk}: no terminator left on a
   * line, no blank lines, and a line split across two chunks is one entry.
   * The only writer of `GodotProcess.output`.
   */
  ingestStdoutChunk(proc: GodotProcess, text: string): void {
    if (text === '') return;
    const carried = proc.stdoutTailIncomplete && proc.output.length > 0 ? proc.output.pop()! : null;
    const { complete, partial } = splitOutputChunk(text, carried);
    for (const line of complete) {
      if (line.trim() === '') continue;
      proc.output.push(line);
      logDebug(`[Godot stdout] ${line}`);
    }
    proc.stdoutTailIncomplete = partial !== null;
    if (partial !== null) proc.output.push(partial);
    if (proc.output.length > STDOUT_RING_LIMIT_LINES) {
      proc.output.splice(0, proc.output.length - STDOUT_RING_LIMIT_LINES);
    }
  }

  /**
   * The same delta window as {@link getErrorsSince}, without its blank-line
   * filter and with the sequence number of the first line. Per-action error
   * attribution needs line positions that line up with the recorded boundary
   * marks, which dropping blanks would shift. `getErrorsSince` itself is
   * deliberately untouched so every existing caller keeps its behavior.
   */
  stderrWindowSince(marker: number): { lines: string[]; startSeq: number } {
    if (!this.activeProcess) return { lines: [], startSeq: marker };
    const { errors, totalErrorsWritten } = this.activeProcess;
    const delta = totalErrorsWritten - marker;
    if (delta <= 0) return { lines: [], startSeq: totalErrorsWritten };
    const lines = delta >= errors.length ? errors.slice() : errors.slice(errors.length - delta);
    return { lines, startSeq: totalErrorsWritten - lines.length };
  }

  /**
   * Open a per-action error capture ahead of an input batch. Clearing the
   * boundary list here bounds it to one batch: only the input path consumes
   * boundaries and MCP serializes tool calls, so no cap is needed.
   */
  beginActionErrorCapture(): ActionErrorCapture {
    if (this.activeProcess) this.activeProcess.actionBoundaries = [];
    return { marker: this.getErrorCount() };
  }

  /**
   * Close a capture and attribute its runtime-error lines to the actions that
   * produced them.
   *
   * Waits on a bounded poll for the expected boundary count, because the TCP
   * response can arrive before stderr has drained. On timeout it attributes
   * what is present and reports `sentinelTimedOut`; it never blocks
   * indefinitely. `drainTimeoutMs` is a parameter so tests need not spend the
   * full wait. Attached sessions have no captured stderr, so they get empty
   * buckets immediately and the caller simply omits `errors`.
   */
  async collectActionErrors(
    capture: ActionErrorCapture,
    expectedSentinels: number,
    drainTimeoutMs: number = SENTINEL_DRAIN_TIMEOUT_MS,
  ): Promise<ActionErrorBuckets> {
    const proc = this.activeProcess;
    if (!proc) {
      return {
        buckets: Array.from({ length: Math.max(0, expectedSentinels) }, () => [] as string[]),
        trailing: [],
        sentinelTimedOut: false,
      };
    }

    const deadline = Date.now() + drainTimeoutMs;
    while ((proc.actionBoundaries?.length ?? 0) < expectedSentinels && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, SENTINEL_DRAIN_POLL_MS));
    }

    const boundaries = proc.actionBoundaries ?? [];
    const sentinelTimedOut = boundaries.length < expectedSentinels;
    const { lines, startSeq } = this.stderrWindowSince(capture.marker);
    const { buckets, trailing } = bucketBySentinel({
      lines,
      startSeq,
      boundaries,
      executedCount: expectedSentinels,
    });
    return {
      buckets: buckets.map((bucket) => this.extractRuntimeErrors(bucket)),
      trailing: this.extractRuntimeErrors(trailing),
      sentinelTimedOut,
    };
  }

  // Only the explicit `SCRIPT ERROR:` / `USER SCRIPT ERROR:` markers belong here — the looser
  // `GDScript error` substring also matches user printerr output and produces false positives.
  private static readonly SCRIPT_ERROR_PATTERNS = ['SCRIPT ERROR:', 'USER SCRIPT ERROR:'];
  private static readonly RETRYABLE_BRIDGE_COMMANDS = new Set(['get_ui_elements', 'screenshot']);
  /**
   * Commands exempt from the attached-mode disconnect probe: a teardown guard.
   * `closeConnection` is itself one of the producers of
   * `BridgeDisconnectedError` (it rejects any in-flight command with one), and
   * the command in flight during our own teardown is a `shutdown`. Probing on
   * that would clear a session already being torn down deliberately, and
   * probing on a `ping` would recurse into the probe itself. Both teardown
   * `shutdown`s and the probe go straight to `sendCommandTo`, so for them this
   * set only keeps a later rerouting through the reconnect wrapper correct.
   * The `ping` entry is live: `check_project` and `switch_project` ping
   * through `sendCommandWithErrors`, and an unanswered status ping must report
   * the bridge as unresponsive without ending the session.
   */
  private static readonly DISCONNECT_EXEMPT_BRIDGE_COMMANDS = new Set(['shutdown', 'ping']);

  extractRuntimeErrors(lines: string[]): string[] {
    return lines.filter((line) => GodotRunner.SCRIPT_ERROR_PATTERNS.some((p) => line.includes(p)));
  }

  /**
   * `sendCommand` plus the transient-drop retry and, in attached mode, the
   * disconnect-means-session-end probe.
   *
   * WIDEST INPUT of the disconnect predicate: `BridgeDisconnectedError` has
   * seven producers in `sendCommandTo` — connect failure, socket unavailable,
   * oversized frame header, framing parse error, socket `'error'`, peer
   * `'close'`, and `closeConnection`'s in-flight rejection. A per-command
   * timeout is a plain `Error` and never reaches here, so a wedged-but-alive
   * game is not mistaken for a dead one. The chain below narrows that set:
   * spawned sessions keep today's behavior (the exit handler owns them),
   * `shutdown`/`ping` are exempt, a retryable command spends its one retry
   * first, and every survivor must still fail a live `ping` before anything is
   * cleared.
   */
  private async sendCommandWithReconnect(
    command: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = 10000,
  ): Promise<string> {
    // The session this command belongs to. Read once: the first send, the
    // retry and the probe all go to this session, and the disconnect handling
    // judges and, if it comes to that, clears this session, not whichever one
    // is current by the time a delay or a probe has run its course.
    const session = this.current;
    let failure: Error;
    try {
      return await this.sendCommandTo(session, command, params, timeoutMs);
    } catch (err) {
      if (!(err instanceof BridgeDisconnectedError)) throw err;
      failure = err;
    }

    const retryable = GodotRunner.RETRYABLE_BRIDGE_COMMANDS.has(command);

    if (session === null || session.mode !== 'attached') {
      // Spawned (or already-cleared) session: unchanged behavior.
      if (session?.mode && retryable) {
        this.closeConnection();
        await new Promise((r) => setTimeout(r, BRIDGE_RECONNECT_DELAY_MS));
        return this.sendCommandTo(session, command, params, timeoutMs);
      }
      throw failure;
    }

    if (GodotRunner.DISCONNECT_EXEMPT_BRIDGE_COMMANDS.has(command)) throw failure;

    if (retryable) {
      this.closeConnection();
      await new Promise((r) => setTimeout(r, BRIDGE_RECONNECT_DELAY_MS));
      try {
        return await this.sendCommandTo(session, command, params, timeoutMs);
      } catch (retryErr) {
        if (!(retryErr instanceof BridgeDisconnectedError)) throw retryErr;
        failure = retryErr;
      }
    }

    // Exactly one probe, on the existing ping timeout. A pong means the
    // command failed but the session did not; a failure means the bridge is
    // gone and the attached session ends here.
    this.closeConnection();
    try {
      await this.sendCommandTo(session, 'ping', {}, BRIDGE_PING_TIMEOUT_MS);
    } catch {
      this.appendCleanupProblems(failure, this.clearAttachedSession(session));
    }
    throw failure;
  }

  async sendCommandWithErrors(
    command: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = 10000,
  ): Promise<{ response: string; runtimeErrors: string[]; stderrWindow: string[] }> {
    // No current session: reject before any socket is dialed, with the live
    // sessions on the error. Another session is never picked in its place. A
    // current session that is no longer live still sends, as before.
    if (this.current === null) {
      throw new NoLiveCurrentSessionError(this.getRuntimeSessionStatus());
    }
    const marker = this.getErrorCount();
    const response = await this.sendCommandWithReconnect(command, params, timeoutMs);
    const newErrors = this.getErrorsSince(marker);
    // Keyed on the retained process rather than the session mode: the
    // auto-clear nulls the mode the moment a spawned process exits, but the
    // stderr buffer being classified here lives on the current session's
    // process, which survives. Attached sessions have no process and so still
    // get [].
    const runtimeErrors = this.activeProcess !== null ? this.extractRuntimeErrors(newErrors) : [];
    // Unfiltered stderr window (newErrors) for callers that need the full
    // engine output around a failure — e.g. run_script compile diagnostics,
    // where the SCRIPT ERROR line is followed by an "at: <path>:<line>" line
    // that extractRuntimeErrors' per-line filter drops.
    return { response, runtimeErrors, stderrWindow: newErrors };
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
    /**
     * Extended ceiling applied once a TCP connect to the bridge port has
     * succeeded. A connect proves the autoload ran and is listening, so the
     * remaining wait is the engine finishing its own startup - worth far more
     * patience than "nothing is listening yet". Omitted means the single
     * `timeoutMs` ceiling applies throughout.
     */
    extendedTimeoutMs?: number;
  }): Promise<{ ready: boolean; error?: string }> {
    const started = Date.now();
    // Consecutive ping failures since the last answered ping, counted only
    // once a TCP connect has been observed. See
    // BRIDGE_CONNECTED_PING_FAILURE_LIMIT.
    let connectedPingFailures = 0;

    while (true) {
      let budget = opts.timeoutMs;
      let extended = false;
      if (opts.extendedTimeoutMs !== undefined && this.bridgeConnectObserved) {
        budget = opts.extendedTimeoutMs;
        extended = true;
      }
      if (Date.now() - started >= budget) break;
      if (extended && connectedPingFailures >= BRIDGE_CONNECTED_PING_FAILURE_LIMIT) {
        return {
          ready: false,
          error: `Something is listening on the bridge port but did not answer ${BRIDGE_CONNECTED_PING_FAILURE_LIMIT} consecutive pings - it is most likely not this bridge. Check for a Godot process left over from an earlier session, or pass a different bridgePort.`,
        };
      }

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
        // Answered at all, so the peer is something that speaks the frame
        // protocol. Reset before validating: a reply that is not a valid pong
        // yet is a bridge mid-startup, not a wrong listener.
        connectedPingFailures = 0;
        const parsed = JSON.parse(response);
        if (opts.validatePong(parsed)) {
          if (opts.expectedPath && typeof parsed.project_path === 'string') {
            const bridgePath = normalizeForCompare(parsed.project_path);
            // Compared with the session key's folding, not as spelled. The
            // path the session was started with and the one Godot reports for
            // `res://` are the same directory under two spellings whenever the
            // drive letter or a directory name differs in case, and a
            // case-sensitive compare would fail a healthy start as if another
            // project's bridge had answered.
            if (projectPathKey(bridgePath) !== projectPathKey(opts.expectedPath)) {
              return {
                ready: false,
                error: `Bridge reports project ${bridgePath}, expected ${opts.expectedPath}`,
              };
            }
          }
          return { ready: true };
        }
      } catch {
        // Expected: ping will fail until bridge is listening. Once a connect
        // has been observed it stops being expected, which is what the counter
        // is for. Refusals from before anything listened are not counted: in
        // the normal attach flow Godot is launched seconds after this wait
        // began, and counting those would spend the whole limit before the
        // listener exists, so its first slow pong would end the wait.
        if (this.bridgeConnectObserved) connectedPingFailures += 1;
      }

      const interval =
        Date.now() - started < BRIDGE_WAIT_BACKOFF_AFTER_MS
          ? opts.intervalMs
          : BRIDGE_WAIT_MAX_INTERVAL_MS;
      await new Promise((resolve) => setTimeout(resolve, interval));
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
        'Bridge did not respond within timeout - is Godot running with the McpBridge autoload?',
      pingPayload: {},
      validatePong: (parsed) => parsed.status === 'pong',
      extendedTimeoutMs: BRIDGE_WAIT_ATTACHED_CONNECTED_TIMEOUT_MS,
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
