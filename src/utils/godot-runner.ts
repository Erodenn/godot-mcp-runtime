import { fileURLToPath } from 'url';
import { join, dirname, normalize, resolve } from 'path';
import { existsSync } from 'fs';
import type { ChildProcess, SpawnOptions } from 'child_process';
import { spawn } from 'child_process';
import * as net from 'net';
import { randomBytes } from 'crypto';
import { BridgeManager } from './bridge-manager.js';
import type { BridgeOwnerInfo, OwnerRegistryRead } from './bridge-manager.js';
import { DebuggerProfiler } from './profiler.js';
import {
  encodeFrame,
  findFreePort,
  parseFrames,
  parseActionBoundary,
  bucketBySentinel,
  clampTimerDelay,
  FRAME_HEADER_BYTES,
  MAX_FRAME_BYTES,
  BRIDGE_UNAUTHORIZED_ERROR,
  BRIDGE_WAIT_SPAWNED_TIMEOUT_MS,
  PARENT_WATCH_PORT_ENV,
  ParentWatchListener,
  requestOnce,
} from './bridge-protocol.js';
import type { ActionBoundaryMark } from './bridge-protocol.js';
import { logDebug, logError, DEBUG_MODE } from './logger.js';
import type { OperationParams } from '../mcp.types.js';
import {
  cleanStdout,
  extractTokenFramedPayload,
  newOperationResultToken,
  normalizeForCompare,
  normalizeExitCode,
  OPERATION_RESULT_TOKEN_ENV,
  projectPathKey,
} from './output-parsing.js';
import { checkDisplayAvailable, type ResolvedProjectPath } from './path-validation.js';
import { convertCamelToSnakeCase } from './parameter-conversion.js';
import { godotSpawnOptions } from './godot-spawn-options.js';
import {
  defaultKillTreeDeps,
  killProcessTree,
  terminateProcessTree,
  waitForProcessEvent,
  type KillOutcome,
  type KillTreeDeps,
} from './process-tree.js';
import { LineAssembler, Utf8StreamDecoder } from './child-output.js';
import { SessionQueue, type QueueTurn } from './session-queue.js';
import { stderrTailLines } from './error-response.js';

/** Thrown when the bridge socket closes (Godot exited, port closed, peer dropped mid-flight), as opposed to a generic transport error. */
export class BridgeDisconnectedError extends Error {
  constructor(
    message: string,
    /** False when the command's frame was never written to the bridge. */
    readonly frameWritten: boolean = true,
  ) {
    super(message);
    this.name = 'BridgeDisconnectedError';
  }
}

/** How a bridge connect that outlived its command ended. */
export type PendingConnectOutcome = 'connected' | 'failed';

/** A command timed out while its TCP connect was still pending: proves neither a live peer nor a dead one. */
export class BridgeConnectPendingError extends Error {
  constructor(
    message: string,
    readonly connectOutcome: Promise<PendingConnectOutcome>,
  ) {
    super(message);
    this.name = 'BridgeConnectPendingError';
  }
}

/** Thrown to a command a stop cut off and to later commands on the stopped record. Not a `BridgeDisconnectedError`: nothing is to be retried or probed. */
export class SessionStoppedError extends Error {
  constructor(
    readonly projectPath: string,
    readonly command: string | null,
    /** True when the command was in flight; false when it was never sent. */
    readonly cutOff: boolean,
  ) {
    super(
      command === null
        ? `The session on ${projectPath} was stopped.`
        : cutOff
          ? `The session on ${projectPath} was stopped while '${command}' was running. The command was cut off: whatever it had already done in the game stays done, and its result was not delivered.`
          : `The session on ${projectPath} was stopped, so '${command}' was not sent.`,
    );
    this.name = 'SessionStoppedError';
  }
}

/** Thrown by a start that got its turn with less time left than the shortest bridge wait, before anything is stopped, written or spawned. */
export class StartBudgetExhaustedError extends Error {
  constructor(
    readonly waitedMs: number,
    readonly behind: string | null,
    readonly remainingMs: number,
  ) {
    super(
      `The runtime session queue was busy: this start waited ${waitedMs} ms${behind !== null ? ` behind ${behind}` : ''}, which leaves ${Math.max(0, remainingMs)} ms to wait for the bridge, under the ${BRIDGE_WAIT_FLOOR_MS} ms a start needs. Nothing was stopped or launched; retry.`,
    );
    this.name = 'StartBudgetExhaustedError';
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// First stderr line godot_operations.gd prints once dispatching.
// KEEP IN SYNC with the log_info("Operation: ...") call in _run_from_cmdline (godot_operations.gd).
const OPERATION_STARTED_MARKER = '[INFO] Operation:';

const BRIDGE_WAIT_SPAWNED_INTERVAL_MS = 300;
// Ceiling on how long attach mode waits with no evidence the bridge is listening. Exported for the budget tests.
export const BRIDGE_WAIT_ATTACHED_TIMEOUT_MS = 20000;
/** Ceiling once a TCP connect to the bridge port has succeeded but no pong is validated: the engine is finishing startup. Held under the SDK's 60 s client timeout so the structured error still arrives. Exported for the budget tests. */
export const BRIDGE_WAIT_ATTACHED_CONNECTED_TIMEOUT_MS = 45000;
/** Consecutive ping failures that end an attached wait after a TCP connect: a socket that accepts and never answers (stale Godot, unrelated service). A successful non-pong ping resets the count. */
export const BRIDGE_CONNECTED_PING_FAILURE_LIMIT = 8;
// Exported for the budget tests.
export const BRIDGE_WAIT_ATTACHED_INTERVAL_MS = 500;
// After this much waiting pollBridge backs off to BRIDGE_WAIT_MAX_INTERVAL_MS. Exported for the budget tests.
export const BRIDGE_WAIT_BACKOFF_AFTER_MS = 5000;
export const BRIDGE_WAIT_MAX_INTERVAL_MS = 2000;
// Exported so check_project's runtime probe reuses the bound.
export const BRIDGE_PING_TIMEOUT_MS = 1000;
const BRIDGE_SHUTDOWN_SPAWNED_TIMEOUT_MS = 500;
const BRIDGE_SHUTDOWN_ATTACHED_TIMEOUT_MS = 1500;
const BRIDGE_PROCESS_EXIT_TIMEOUT_MS = 2000;
/** How long a stop waits for `exit` after the forced tree kill; past it the stop reports the kill as unconfirmed. */
const SESSION_KILL_CONFIRM_TIMEOUT_MS = 3000;
/** The same wait for a headless run killed on its timeout, on `close`: the engine may still save the scene until then. */
const HEADLESS_KILL_CONFIRM_TIMEOUT_MS = 3000;
/** How long a stop waits, after exit, for stdout and stderr to end; bounds a grandchild that inherited the pipes. */
const STREAM_END_WAIT_TIMEOUT_MS = 500;
/** Timeout of a headless child when the caller names none (the version probe). */
const HEADLESS_DEFAULT_TIMEOUT_MS = 10000;
/** Timeout of a headless operation when the caller names none. */
export const HEADLESS_OPERATION_TIMEOUT_MS = 30000;
/** How long a graceful shutdown waits for headless runs to report `close` before the exit hook kills the rest. */
export const HEADLESS_SHUTDOWN_WAIT_MS = 10000;
/** Timeout of a bridge command when the caller names none. */
const BRIDGE_COMMAND_DEFAULT_TIMEOUT_MS = 10000;
/** How many trailing stderr lines a caller gets when it names no count. */
const RECENT_ERROR_LINES_DEFAULT = 20;
const BRIDGE_RECONNECT_DELAY_MS = 1000;
// Windows can take about 2 s to refuse a connect to a closed loopback port.
const BRIDGE_CONNECT_OUTCOME_WAIT_MS = 3000;

/** The MCP SDK's default per-request client timeout; a later answer is never read. */
export const CLIENT_REQUEST_TIMEOUT_MS = 60000;
/** Time a start gets from requesting its turn to its answer being ready, teardown of a failed start included. */
export const START_RESPONSE_BUDGET_MS = 55000;
/** Longest a stop of a spawned session waits. */
export const SPAWNED_STOP_WORST_CASE_MS =
  BRIDGE_SHUTDOWN_SPAWNED_TIMEOUT_MS +
  BRIDGE_PROCESS_EXIT_TIMEOUT_MS +
  SESSION_KILL_CONFIRM_TIMEOUT_MS +
  STREAM_END_WAIT_TIMEOUT_MS;
/** Longest a stop of an attached session waits: the `shutdown` command. */
export const ATTACHED_STOP_WORST_CASE_MS = BRIDGE_SHUTDOWN_ATTACHED_TIMEOUT_MS;
/** Shortest bridge wait a start is launched for; with less left it is refused before stopping or spawning anything. */
export const BRIDGE_WAIT_FLOOR_MS = 10000;

/** When a start's bridge wait must end to keep the request inside START_RESPONSE_BUDGET_MS: counted from the request (queue time and the replaced session's stop are charged), with one in-flight ping and the teardown reserved. */
export function startBridgeWaitDeadline(mode: RuntimeSessionMode, requestedAt: number): number {
  const teardown = mode === 'spawned' ? SPAWNED_STOP_WORST_CASE_MS : ATTACHED_STOP_WORST_CASE_MS;
  return requestedAt + START_RESPONSE_BUDGET_MS - teardown - BRIDGE_PING_TIMEOUT_MS;
}

// A first import of an asset-heavy project can exceed 2 minutes.
const IMPORT_TIMEOUT_MS = 300000;

const STDERR_RING_LIMIT_LINES = 500;
const STDOUT_RING_LIMIT_LINES = 500;
// The bridge's TCP response can land before its stderr drains, so the last action boundary is polled for.
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
  /** Boundaries recorded from stderr during the current input batch; reset by `beginActionErrorCapture`. Optional so hand-built literals stay valid. */
  actionBoundaries?: ActionBoundaryMark[];
  /** Stderr text not yet ended by a newline. Optional like `actionBoundaries`; `ingestStderrChunk` creates it. */
  stderrLines?: LineAssembler;
  stdoutLines?: LineAssembler;
  /** Settles once stdout and stderr both ended. Absent on a hand-built literal. */
  streamsEnded?: Promise<void>;
}

/** Opaque handle returned by `beginActionErrorCapture`. */
export interface ActionErrorCapture {
  marker: number;
  /** The process whose stderr the capture reads, fixed at open. Null for an attached session; absent on a hand-built capture, which reads the current process. */
  proc?: GodotProcess | null;
}

export interface ActionErrorBuckets {
  buckets: string[][];
  trailing: string[];
  sentinelTimedOut: boolean;
}

export type RuntimeSessionMode = 'spawned' | 'attached';

export function sessionKey(projectPath: string): string {
  return projectPathKey(projectPath);
}

/** One runtime session. Exported only so the test helper can type it; handlers use {@link RuntimeSessionInfo}. */
export interface RuntimeSession {
  readonly key: string;
  readonly projectPath: string;
  mode: RuntimeSessionMode | null;
  bridgePort: number | null;
  /** Bridge auth token, sent on every frame. Spawned sessions get it via MCP_SESSION_TOKEN; attached ones bake it into the injected script. */
  token: string | null;
  process: GodotProcess | null;
  /** Debugger receiver for `profiling: true`, bound before the spawn so `--remote-debug` has a port. Null in attached mode. */
  profiler: DebuggerProfiler | null;
  /** Bumped at the head of every transition that supersedes or stops this session; see `GodotRunner.beginSessionTransition`. */
  epoch: number;
  /** What exit-time bridge cleanup could not confirm; kept for the `stop_project` that follows. */
  exitCleanupProblems: string[];
  /** Set when this spawned session was started over this server's own attached session. */
  replacedAttached: ReplacedAttachedSession | null;
  /** True once a TCP connect to the bridge port succeeded; read by `pollBridge` to extend the budget. */
  bridgeConnectObserved: boolean;
  /** What the start could not confirm about the session it replaced, for the `run_project` payload. */
  startWarnings: string[];
  /** True from a stop's first statement, never reset: every later command on this record is rejected with `SessionStoppedError` and a start replacing it gives up. */
  stopped: boolean;
  /** The stop in progress; a second stop shares it. */
  stopping: Promise<RuntimeStopResult | null> | null;
}

/** Reference to one session record for a caller acting on it after its own awaits; the current pointer and map may name another by then. */
export interface SessionRef {
  readonly projectPath: string;
}

export interface AttachResult {
  session: SessionRef;
  /** True when a live attached session was kept (bridge not seen gone) and nothing was injected. */
  alreadyAttached: boolean;
  /** The kept session's probe ping outcome: `answered`, `silent` (busy, not gone) or `unexpected-reply`. */
  existingBridge?: AttachedProbeOutcome;
}

export type AttachedProbeOutcome = 'answered' | 'silent' | 'unexpected-reply';

export interface BridgeWaitResult {
  ready: boolean;
  error?: string;
  stopped?: boolean;
  waitedMs?: number;
}

/** An attached session a spawned start replaced. `shutdownAcknowledged` false: its bridge did not answer `shutdown` and still listens on `bridgePort` with the old token. */
export interface ReplacedAttachedSession {
  bridgePort: number | null;
  shutdownAcknowledged: boolean;
}

export interface RuntimeSessionInfo {
  projectPath: string;
  mode: RuntimeSessionMode | null;
  live: boolean;
  current: boolean;
  bridgePort: number | null;
  processExited: boolean;
  exitCode: number | null;
  hasRetainedLogs: boolean;
  profiling: boolean;
  replacedAttached?: ReplacedAttachedSession | null;
  startWarnings?: string[];
}

export interface RuntimeSessionStatus {
  state: 'live' | 'exited' | 'none';
  current: RuntimeSessionInfo | null;
  otherLiveSessions: RuntimeSessionInfo[];
}

export interface RuntimeSessionLogs {
  output: string[];
  errors: string[];
  hasExited: boolean;
  exitCode: number | null;
}

const BRIDGE_WAIT_STOPPED: BridgeWaitResult = {
  ready: false,
  stopped: true,
  error: 'The session was stopped while it was starting.',
};

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

/** Thrown when a runtime command has no live current session; carries the status so the caller can name the others. The runner never picks one itself. */
export class NoLiveCurrentSessionError extends Error {
  constructor(readonly status: RuntimeSessionStatus) {
    super(describeNoLiveCurrent(status));
    this.name = 'NoLiveCurrentSessionError';
  }
}

/** Attached: live until its bridge is seen gone. Spawned: live while its process is tracked and has not exited. */
function isSessionLive(session: RuntimeSession): boolean {
  if (session.mode === 'attached') return true;
  if (session.mode === 'spawned') return session.process !== null && !session.process.hasExited;
  return false;
}

export interface RuntimeStopResult {
  mode: RuntimeSessionMode;
  projectPath: string;
  /** Retained stdout lines; null for an attached stop, which captured nothing (not the same as printing nothing). */
  output: string[] | null;
  errors: string[] | null;
  externalProcessPreserved?: boolean;
  /** The process had already exited and `handleSpawnedProcessExit` had cleared the session. */
  alreadyExited?: boolean;
  exitCode?: number | null;
  /** Bridge cleanup steps attempted and not confirmed; for `alreadyExited`, those recorded at exit. */
  cleanupProblems: string[];
  /** Attached stops only: false when the bridge did not answer `shutdown` and still listens on its port. */
  shutdownAcknowledged?: boolean;
  /** The record held only a finished profiler capture whose logs an earlier stop returned; `output` and `errors` are null. */
  releasedCaptureOnly?: boolean;
  /** The kill was sent and no exit was reported within the wait, so the process may still run. */
  killUnconfirmed?: boolean;
  pid?: number;
}

/** A `shutdown` reply is an acknowledgement only when it parses and carries no `error` key: a refusal is a reply too. */
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
  target: RuntimeSession | null;
  frameWritten: boolean;
  pendingConnect: Promise<PendingConnectOutcome> | null;
  resolve: (value: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** First `n` bytes of a chunk array without concatenating it; caller guarantees the total is at least `n`. */
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

/** Narrows a caught `unknown` to a spawn rejection carrying the partial `stdout`/`stderr`, or null. */
function asSpawnError(error: unknown): (Error & { stdout: string; stderr: string }) | null {
  if (error instanceof Error && 'stdout' in error && 'stderr' in error) {
    return error as Error & { stdout: string; stderr: string };
  }
  return null;
}

/** True when `err` proves the command never reached the game. */
export function commandWasNotSent(err: unknown): boolean {
  if (err instanceof SessionStoppedError) return !err.cutOff;
  if (err instanceof NoLiveCurrentSessionError) return true;
  if (err instanceof BridgeDisconnectedError) return !err.frameWritten;
  return err instanceof BridgeConnectPendingError;
}

/** True when `promise` settled within `timeoutMs`; never rejects. */
function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    const done = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    promise.then(done, done);
  });
}

function describeProbeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const tail = stderrTailLines(asSpawnError(error)?.stderr ?? '').map((line) => line.trim());
  return tail.length === 0 ? message : `${message}; stderr: ${tail.join(' | ')}`;
}

function asSentDisconnect(err: BridgeDisconnectedError): BridgeDisconnectedError {
  return err.frameWritten ? err : new BridgeDisconnectedError(err.message, true);
}

function asSentFailure(err: unknown): unknown {
  if (err instanceof BridgeDisconnectedError) return asSentDisconnect(err);
  if (err instanceof BridgeConnectPendingError) return new Error(err.message);
  return err;
}

function streamEnded(stream: NodeJS.ReadableStream | null | undefined): Promise<void> {
  if (!stream) return Promise.resolve();
  return new Promise((resolve) => {
    stream.once('end', () => resolve());
    // A stream destroyed without ending emits only 'close'.
    stream.once('close', () => resolve());
  });
}

function recentErrorLines(proc: GodotProcess | null, count: number): string[] {
  if (!proc) return [];
  return proc.errors.slice(-count).filter((line) => line.trim() !== '');
}

function errorsSince(proc: GodotProcess | null, marker: number): string[] {
  if (!proc) return [];
  const { errors, totalErrorsWritten } = proc;
  const delta = totalErrorsWritten - marker;
  if (delta <= 0) return [];
  const window = delta >= errors.length ? errors.slice() : errors.slice(errors.length - delta);
  return window.filter((line) => line.trim() !== '');
}

export class GodotRunner {
  private godotPath: string | null = null;
  private operationsScriptPath: string;
  private bridge: BridgeManager;
  private validatedPaths: Map<string, boolean> = new Map();
  private cachedVersion: string | null = null;
  private sessions = new Map<string, RuntimeSession>();
  /** The session the runtime tools act on. Never moved implicitly, except by a start that launched nothing undoing its own move (`restoreCurrentAfterFailedStart`). */
  private current: RuntimeSession | null = null;
  private killTreeDeps: KillTreeDeps = defaultKillTreeDeps;

  // A stop does not wait on this queue: the game has to be stoppable while a batch or script holds it. The interrupted operation is kept off a gone session by `stopped`, the epoch and the record's place in the map (see `stopSession`).
  private readonly queue = new SessionQueue();
  private readonly knownSessions = new WeakSet<object>();
  private readonly parentWatch = new ParentWatchListener();
  /** Headless children without `close`; they lead their own process group outside Windows, so the exit hook kills what is left. */
  private readonly headlessChildren = new Set<ChildProcess>();
  /** Spawned games without `exit`; a game whose kill was unconfirmed leaves the session map, so the exit hook kills from here too. */
  private readonly spawnedGames = new Set<ChildProcess>();
  /** Set once by `stopAllSessions`. A start checks it after each await before its record exists, where a shutdown finds nothing to stop. */
  private shuttingDown = false;
  /** Movie runs per project, counted because two may run; a start on such a project is refused (it would inject under a rendering Godot). */
  private readonly movieRuns = new Map<string, number>();
  private readonly importsInFlight = new Map<string, Promise<void>>();
  private readonly probeFailures = new Map<string, string>();

  private socket: net.Socket | null = null;
  /** The session the one bridge socket was dialed for; `sendCommandTo` closes a socket belonging to another session before dialing. */
  private socketSession: RuntimeSession | null = null;
  // Chunks are joined only once a whole frame is available; re-concatenating per data event was O(n^2) on large split frames.
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

  // Read-only views of the current session; another project's session is reachable only through projectPath methods or snapshots.

  get activeSessionMode(): RuntimeSessionMode | null {
    return this.current?.mode ?? null;
  }

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

  /** Run one headless Godot to completion. On timeout the process tree is killed (the executable may be a wrapper) and the rejection waits for `close` or HEADLESS_KILL_CONFIRM_TIMEOUT_MS, since the engine may still write to the project. */
  private spawnAsync(
    cmd: string,
    args: string[],
    timeoutMs: number = HEADLESS_DEFAULT_TIMEOUT_MS,
    extraEnv?: Readonly<Record<string, string>>,
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const options = godotSpawnOptions('headless');
      const proc = spawn(
        cmd,
        args,
        extraEnv === undefined ? options : { ...options, env: { ...process.env, ...extraEnv } },
      );
      this.headlessChildren.add(proc);
      const stdoutDecoder = new Utf8StreamDecoder();
      const stderrDecoder = new Utf8StreamDecoder();
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;
      const settle = (finish: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        finish();
      };
      const timeoutError = (exitConfirmed: boolean): Error =>
        new Error(
          exitConfirmed
            ? `Process timed out after ${timeoutMs}ms and was killed; its exit was confirmed.`
            : `Process timed out after ${timeoutMs}ms. The kill was sent, but the process (pid ${proc.pid ?? 'unknown'}) did not report its exit within ${HEADLESS_KILL_CONFIRM_TIMEOUT_MS}ms: it may still be running and may still write to the project.`,
        );
      const timer = setTimeout(() => {
        timedOut = true;
        const outcome = killProcessTree(proc, this.killTreeDeps);
        if (outcome === 'not-running') {
          settle(() => reject(timeoutError(true)));
          return;
        }
        void waitForProcessEvent(proc, 'close', HEADLESS_KILL_CONFIRM_TIMEOUT_MS).then((closed) => {
          settle(() => reject(timeoutError(closed)));
        });
      }, clampTimerDelay(timeoutMs));

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += stdoutDecoder.write(data);
      });
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += stderrDecoder.write(data);
      });
      proc.on('error', (err) => {
        this.headlessChildren.delete(proc);
        settle(() => reject(err));
      });
      proc.on('close', (code, signal) => {
        this.headlessChildren.delete(proc);
        stdout += stdoutDecoder.end();
        stderr += stderrDecoder.end();
        if (timedOut) {
          settle(() => reject(timeoutError(true)));
          return;
        }
        settle(() => {
          if (code === 0) {
            resolve({ stdout, stderr });
            return;
          }
          const err = new Error(
            code === null && typeof signal === 'string'
              ? `Process was ended by signal ${signal}`
              : `Process exited with code ${code}`,
          ) as Error & {
            stdout: string;
            stderr: string;
            code: number | null;
          };
          err.stdout = stdout;
          err.stderr = stderr;
          err.code = code;
          reject(err);
        });
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
        this.probeFailures.set(path, 'the file does not exist');
        this.validatedPaths.set(path, false);
        return false;
      }

      await this.spawnAsync(path, ['--version']);

      logDebug(`Valid Godot path: ${path}`);
      this.validatedPaths.set(path, true);
      return true;
    } catch (error: unknown) {
      const reason = describeProbeFailure(error);
      logDebug(`Invalid Godot path: ${path} (${reason})`);
      this.probeFailures.set(path, reason);
      this.validatedPaths.set(path, false);
      return false;
    }
  }

  private probeFailureNote(path: string): string {
    const reason = this.probeFailures.get(path);
    return reason === undefined ? '' : ` Its --version probe failed: ${reason}.`;
  }

  /** The error for a call with no Godot executable, with why each probed path was turned down, so a passing probe failure does not read as a missing path. */
  private noGodotPathError(): Error {
    const reasons = [...this.probeFailures].map(([path, reason]) => `"${path}": ${reason}`);
    return new Error(
      reasons.length === 0
        ? 'Could not find a valid Godot executable path'
        : `Could not find a valid Godot executable path. Probed ${reasons.join('; ')}`,
    );
  }

  async detectGodotPath(): Promise<void> {
    // Explicit paths are authoritative: on failure godotPath stays null instead of a fabricated platform default.
    if (this.godotPath) {
      if (await this.isValidGodotPath(this.godotPath)) {
        logDebug(`Using existing Godot path: ${this.godotPath}`);
        return;
      }
      logError(
        `Configured Godot path "${this.godotPath}" is not a working Godot executable.` +
          `${this.probeFailureNote(this.godotPath)} ` +
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
        `GODOT_PATH is set to "${normalizedPath}" but no working Godot executable was found there.` +
          `${this.probeFailureNote(normalizedPath)} ` +
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

  /** Whether `project.godot` registers the `McpBridge` autoload at this server's script. */
  isBridgeAutoloadRegistered(projectPath: string): boolean {
    return this.bridge.isBridgeAutoloadRegistered(projectPath);
  }

  /** Other live owners on this project, excluding this runner; `'read-only'` prunes dead owners' files from nothing. */
  otherLiveSessionsOnProject(
    projectPath: string,
    registryRead: OwnerRegistryRead = 'prune',
  ): BridgeOwnerInfo[] {
    const root = resolve(projectPath);
    return registryRead === 'read-only'
      ? this.bridge.peekOtherLiveOwners(root)
      : this.bridge.listOtherLiveOwners(root);
  }

  async getVersion(): Promise<string> {
    if (this.cachedVersion !== null) {
      return this.cachedVersion;
    }
    if (!this.godotPath) {
      await this.detectGodotPath();
      if (!this.godotPath) {
        throw this.noGodotPathError();
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
    timeoutMs: number = HEADLESS_OPERATION_TIMEOUT_MS,
  ): Promise<OperationResult> {
    logDebug(`Executing operation: ${operation} in project: ${projectPath}`);
    logDebug(`Original operation params: ${JSON.stringify(params)}`);

    this.assertHeadlessRunAllowed(`the ${operation} operation`);
    this.bridge.repairOrphaned(projectPath);

    const snakeCaseParams = convertCamelToSnakeCase(params);
    logDebug(`Converted snake_case params: ${JSON.stringify(snakeCaseParams)}`);

    if (!this.godotPath) {
      await this.detectGodotPath();
      if (!this.godotPath) {
        throw this.noGodotPathError();
      }
    }

    // Again after the await: a shutdown that began during the probe has stopped waiting for runs it could see.
    this.assertHeadlessRunAllowed(`the ${operation} operation`);

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

    // Drawn per run and echoed in the result line, so a project script printing the sentinel is not taken for the result.
    const resultToken = newOperationResultToken();

    let stdout = '';
    let stderr = '';
    try {
      ({ stdout, stderr } = await this.spawnAsync(this.godotPath, args, timeoutMs, {
        [OPERATION_RESULT_TOKEN_ENV]: resultToken,
      }));
    } catch (error: unknown) {
      const spawnError = asSpawnError(error);
      if (!spawnError) throw error;
      stdout = spawnError.stdout;
      stderr = spawnError.stderr;
    }

    // No operation output plus errors means init failed before the script ran (usually an autoload). The banner makes stdout non-empty on every run, so the script's first line is the evidence.
    const operationRan =
      stderr.includes(OPERATION_STARTED_MARKER) ||
      extractTokenFramedPayload(stdout, resultToken) !== null;
    if (!operationRan && (stderr.includes('ERROR:') || stderr.includes('SCRIPT ERROR:'))) {
      throw new Error(
        `Headless Godot failed before the operation could run - likely an autoload initialization error.\n` +
          `Stderr:\n${stderr.trim()}\n\n` +
          `Use list_autoloads and remove_autoload to inspect or remove the failing autoload, then retry.`,
      );
    }

    return { stdout: cleanStdout(stdout, resultToken), stderr };
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
    // The pipes stay open on purpose (see godotSpawnOptions); an unread pipe fills and freezes the editor, so both are drained.
    editor.stdout?.resume();
    editor.stderr?.resume();
    return editor;
  }

  /** Run `godot --headless --import` for a project; Godot exits 0 even when assets fail, so stderr is inspected for "ERROR: Error importing". */
  importAssets(projectPath: string, timeoutMs: number = IMPORT_TIMEOUT_MS): Promise<void> {
    // A second caller joins the import in flight: two engines importing one project write the same .godot/ directory.
    const key = sessionKey(resolve(projectPath));
    const inFlight = this.importsInFlight.get(key);
    if (inFlight !== undefined) return inFlight;
    const started = this.runImport(projectPath, timeoutMs);
    this.importsInFlight.set(key, started);
    const forget = (): void => {
      if (this.importsInFlight.get(key) === started) this.importsInFlight.delete(key);
    };
    started.then(forget, forget);
    return started;
  }

  private async runImport(projectPath: string, timeoutMs: number): Promise<void> {
    this.assertHeadlessRunAllowed('the asset import');
    if (!this.godotPath) {
      await this.detectGodotPath();
      if (!this.godotPath) {
        throw this.noGodotPathError();
      }
      this.assertHeadlessRunAllowed('the asset import');
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
    const failedFiles = [...stderr.matchAll(/ERROR: Error importing '([^']+)'/g)].map((m) => m[1]);
    if (failedFiles.length > 0) {
      throw new Error(
        `Asset import reported errors for ${failedFiles.length} file(s):\n` +
          failedFiles.map((f) => `  - ${f}`).join('\n') +
          '\nCheck the files are valid (PNG/SVG/etc.) and the Godot version matches the project.',
      );
    }
  }

  /** Refuse a headless run once shutdown began: the exit hook would kill it partway. */
  private assertHeadlessRunAllowed(what: string): void {
    if (!this.shuttingDown) return;
    throw new Error(
      `The server is shutting down, so ${what} was not started; nothing was changed.`,
    );
  }

  /** Resolve when every headless child has reported `close` or after `boundMs`; true when none is left. Kills nothing: the exit hook does. */
  async waitForHeadlessChildren(boundMs: number = HEADLESS_SHUTDOWN_WAIT_MS): Promise<boolean> {
    const pending = [...this.headlessChildren];
    if (pending.length === 0) return true;
    // A failed spawn reports 'error' and no 'close'; the set is what the answer is read from.
    const gone = pending.map(
      (child) =>
        new Promise<void>((resolveGone) => {
          child.once('close', () => resolveGone());
          child.once('error', () => resolveGone());
        }),
    );
    await settlesWithin(Promise.all(gone), boundMs);
    return this.headlessChildren.size === 0;
  }

  /** Record a `render_movie` run on a project until the returned function ends it; a start on the project is refused meanwhile. Ended on the child's `close`, not when the caller returns. This server process only. */
  beginMovieRun(projectPath: string): () => void {
    const key = sessionKey(resolve(projectPath));
    this.movieRuns.set(key, (this.movieRuns.get(key) ?? 0) + 1);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const left = (this.movieRuns.get(key) ?? 1) - 1;
      if (left > 0) this.movieRuns.set(key, left);
      else this.movieRuns.delete(key);
    };
  }

  /** First phase of both starts: refuse a project a movie run is using. */
  private assertNoMovieRun(key: string, projectPath: string): void {
    if (!this.movieRuns.has(key)) return;
    throw new Error(
      `A render_movie run is using this project (${projectPath}); wait for it to return, then retry. Nothing was stopped or launched: the movie process would load the bridge this start injects.`,
    );
  }

  /** Run `operation` with the session queue held, for a handler whose steps must be one. `label` names the tool for callers made to wait. @throws {SessionQueueTimeoutError} */
  runExclusive<T>(label: string, operation: () => Promise<T>): Promise<T> {
    return this.queue.run(label, operation);
  }

  /** How the enclosing operation got its turn (wait and what it waited behind), or null outside one. */
  queueTurn(): QueueTurn | null {
    return this.queue.turn();
  }

  /** Start a spawned session and make it current; the bridge is not ready yet (`waitForBridge`). Refusals that need no teardown run first, so a refused start leaves the replaced session running. */
  runProject(
    projectPath: string,
    scene?: ResolvedProjectPath,
    background: boolean = false,
    bridgePort?: number,
    profiling: boolean = false,
  ): Promise<SessionRef> {
    return this.queue.run('run_project', () =>
      this.startSpawned(projectPath, scene, background, bridgePort, profiling),
    );
  }

  private async startSpawned(
    projectPath: string,
    scene: ResolvedProjectPath | undefined,
    background: boolean,
    bridgePort: number | undefined,
    profiling: boolean,
  ): Promise<RuntimeSession> {
    const godotPath = this.godotPath;
    if (!godotPath) {
      throw new Error(
        'No Godot executable resolved. Set GODOT_PATH to a Godot 4.x binary, or pass godotPath via config.',
      );
    }

    // Absolute path: the bridge reports an absolute project_path, and a relative expectedPath fails pollBridge's guard and masks the cause as a timeout.
    projectPath = resolve(projectPath);
    const key = sessionKey(projectPath);

    // Phase 1: preconditions. Nothing is stopped, written or spawned.
    if (!checkDisplayAvailable()) {
      throw new Error(
        'No display server available (DISPLAY and WAYLAND_DISPLAY are both unset). ' +
          'Godot requires a display to run a project window.',
      );
    }
    this.assertBridgePortNotHeld(bridgePort, key);
    this.assertNoMovieRun(key, projectPath);
    const port = bridgePort ?? (await findFreePort());
    const parentWatchPort = await this.parentWatchPort();
    let profiler: DebuggerProfiler | null = null;
    try {
      if (profiling) profiler = await DebuggerProfiler.create();
      this.assertNotShuttingDown(projectPath);
      this.bridge.precheckInject(projectPath, false);
      this.assertStartBudget('spawned', key);
    } catch (err) {
      profiler?.close();
      throw err;
    }

    // Phase 2: stop the session this start replaces (same project only).
    const previous = await this.previousAfterPendingStop(key);
    let replacedAttached: ReplacedAttachedSession | null = null;
    const startWarnings: string[] = [];
    if (previous !== null) {
      this.beginSessionTransition(previous);
      this.closeProfiler(previous);
      this.releaseSocketOf(previous);
      if (previous.mode === 'spawned' && previous.process) {
        logDebug('Stopping the existing Godot process before starting a new one');
        // Waited for and escalated: the old game holds its bridge port until it exits.
        const stopped = await this.stopTrackedProcess(previous.process);
        if (!stopped.confirmed) {
          startWarnings.push(
            `The game this start replaced (pid ${stopped.pid ?? 'unknown'}) was sent a kill and did not report its exit, so it may still be running and may still hold its bridge port.`,
          );
        }
      } else if (previous.mode === 'attached') {
        // The user's Godot keeps running with the old token until its bridge is told to shut down.
        replacedAttached = {
          bridgePort: previous.bridgePort,
          shutdownAcknowledged: await this.shutdownAttachedBridge(previous),
        };
      }
      // A stop_project or shutdown does not wait for this start and may have taken the record; a stop in progress owns the artifacts until removed.
      if (previous.stopping !== null || this.sessions.get(key) !== previous) {
        profiler?.close();
        throw new Error(
          `The session on ${projectPath} was stopped while this start was replacing it; nothing was launched.`,
        );
      }
      // No bridge cleanup for the same path: the replacement re-injects over the same owner file.
      startWarnings.push(...this.cleanupRespelledProject(previous, projectPath));
    }

    if (this.shuttingDown) {
      profiler?.close();
      this.assertNotShuttingDown(projectPath);
    }

    // Phase 3: the new record, its bridge and its process.
    const session = this.createSession(projectPath, 'spawned');
    session.replacedAttached = replacedAttached;
    session.startWarnings = startWarnings;
    session.profiler = profiler;
    const epoch = session.epoch;
    const previousCurrent = this.current;
    this.sessions.set(key, session);
    this.setCurrent(session);

    let processSpawned = false;
    try {
      // Token before port: a record with a port can be dialed, and a frame must never go out without the token.
      const sessionToken = randomBytes(16).toString('hex');
      session.token = sessionToken;
      session.bridgePort = port;

      // An inject failure fails the start: a game spawned without the bridge only times out later with the cause gone. The catch below removes partial artifacts.
      this.bridge.inject(projectPath, port);

      const cmdArgs = ['--path', projectPath];
      if (profiler !== null) {
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
        // KEEP IN SYNC: the three MCP_* names below with `_ready` in src/scripts/mcp_bridge.gd.
        env: {
          ...process.env,
          MCP_SESSION_TOKEN: sessionToken,
          // Delivers the resolved port without baking it into the shared script.
          MCP_BRIDGE_PORT: String(port),
          // Spawned sessions only; an attached Godot never gets one.
          ...(parentWatchPort !== null ? { [PARENT_WATCH_PORT_ENV]: String(parentWatchPort) } : {}),
        },
      };
      if (background) {
        spawnOptions.env = { ...spawnOptions.env, MCP_BACKGROUND: '1' };
      }
      const proc = spawn(godotPath, cmdArgs, spawnOptions);
      processSpawned = true;
      this.spawnedGames.add(proc);
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
        streamsEnded: Promise.all([streamEnded(proc.stdout), streamEnded(proc.stderr)]).then(
          () => undefined,
        ),
      };

      const stdoutDecoder = new Utf8StreamDecoder();
      const stderrDecoder = new Utf8StreamDecoder();
      proc.stdout?.on('data', (data: Buffer) => {
        this.ingestStdoutChunk(godotProcess, stdoutDecoder.write(data));
      });
      proc.stdout?.on('end', () => {
        this.ingestStdoutChunk(godotProcess, stdoutDecoder.end());
        this.finishStdout(godotProcess);
      });

      proc.stderr?.on('data', (data: Buffer) => {
        this.ingestStderrChunk(godotProcess, stderrDecoder.write(data));
      });
      proc.stderr?.on('end', () => {
        this.ingestStderrChunk(godotProcess, stderrDecoder.end());
        this.finishStderr(godotProcess);
      });

      proc.on('exit', (code: number | null) => {
        this.spawnedGames.delete(proc);
        this.handleSpawnedProcessExit(session, godotProcess, epoch, code);
      });

      proc.on('error', (err: Error) => {
        console.error('Failed to start Godot process:', err);
        // Through ingestStderrChunk: the only writer keeping `errors` and `totalErrorsWritten` in step, which every sentinel `seq` and `getErrorsSince` window depends on.
        this.ingestStderrChunk(godotProcess, `Process error: ${err.message}\n`);
        godotProcess.hasExited = true;
        if (proc.pid === undefined) this.spawnedGames.delete(proc);
        // The engine will never dial back, so the debugger listener is released.
        this.closeProfiler(session);
      });

      session.process = godotProcess;
      return session;
    } catch (err) {
      // Nothing is running for this record: drop it and remove whatever bridge artifacts were left.
      const heldCurrent = this.current === session;
      this.appendCleanupProblems(err, this.discardFailedStart(session, true));
      if (!processSpawned && heldCurrent) this.restoreCurrentAfterFailedStart(previousCurrent);
      throw err;
    }
  }

  /** Refuse a start a shutdown overtook during one of its awaits (all of which precede its record, so the shutdown found nothing to stop). */
  private assertNotShuttingDown(projectPath: string): void {
    if (!this.shuttingDown) return;
    throw new Error(
      `The server is shutting down, so the session on ${projectPath} was not started; nothing was launched.`,
    );
  }

  /** Refuse an explicit bridge port a live session on another project holds; the same project's session is exempt because the start stops it first. */
  private assertBridgePortNotHeld(bridgePort: number | undefined, key: string): void {
    if (bridgePort === undefined) return;
    for (const other of this.sessions.values()) {
      if (other.key === key || other.bridgePort !== bridgePort || !isSessionLive(other)) continue;
      throw new Error(
        `Bridge port ${bridgePort} is already held by this server's live session on ${other.projectPath}. Nothing was stopped or launched: pass a different bridgePort, omit it to get a free port, or stop that session first.`,
      );
    }
  }

  /** Refuse a start with too little of its request's time left for the bridge wait; the replaced session's stop is reserved. @throws {StartBudgetExhaustedError} */
  private assertStartBudget(mode: RuntimeSessionMode, key: string): void {
    const turn = this.queue.turn();
    if (turn === null) return;
    const previous = this.sessions.get(key) ?? null;
    const replaceReserve =
      previous === null || !isSessionLive(previous)
        ? 0
        : previous.mode === 'attached'
          ? ATTACHED_STOP_WORST_CASE_MS
          : SPAWNED_STOP_WORST_CASE_MS;
    const remaining = startBridgeWaitDeadline(mode, turn.requestedAt) - Date.now() - replaceReserve;
    if (remaining >= BRIDGE_WAIT_FLOOR_MS) return;
    throw new StartBudgetExhaustedError(turn.waitedMs, turn.behind, remaining);
  }

  /** The record a start would replace, after any stop already running on it finishes: a stop does not queue, and replacing a half-stopped record races its artifact removal. */
  private async previousAfterPendingStop(key: string): Promise<RuntimeSession | null> {
    const found = this.sessions.get(key) ?? null;
    if (found === null || found.stopping === null) return found;
    await found.stopping.catch(() => undefined);
    return this.sessions.get(key) ?? null;
  }

  /** Parent-watch port for a spawned game, or null when it could not be bound (non-fatal: no watchdog). */
  private async parentWatchPort(): Promise<number | null> {
    try {
      return await this.parentWatch.port();
    } catch (err) {
      logDebug(`Non-fatal: the parent-watch listener could not be bound: ${err}`);
      return null;
    }
  }

  /** Stop a tracked game and observe it stopped: polite stop, BRIDGE_PROCESS_EXIT_TIMEOUT_MS for `exit`, then a forced tree kill and SESSION_KILL_CONFIRM_TIMEOUT_MS. `confirmed` is false when a kill went out and nothing came back. Never throws. */
  private async stopTrackedProcess(
    tracked: GodotProcess,
  ): Promise<{ confirmed: boolean; pid: number | undefined }> {
    const proc = tracked.process;
    const pid = proc.pid;
    if (tracked.hasExited) return { confirmed: true, pid };
    const first: KillOutcome = terminateProcessTree(proc, this.killTreeDeps);
    if (pid === undefined || tracked.hasExited) return { confirmed: true, pid };
    if (await waitForProcessEvent(proc, 'exit', BRIDGE_PROCESS_EXIT_TIMEOUT_MS)) {
      return { confirmed: true, pid };
    }
    if (first === 'not-running') return { confirmed: true, pid };
    const forced = this.forceKillProcessTree(proc);
    if (tracked.hasExited || forced === 'not-running') return { confirmed: true, pid };
    const exited = await waitForProcessEvent(proc, 'exit', SESSION_KILL_CONFIRM_TIMEOUT_MS);
    return { confirmed: exited || tracked.hasExited, pid };
  }

  /** Undo, not promotion: give `current` back to the record that held it before a start that launched nothing, if it is still registered and nothing took the pointer. */
  private restoreCurrentAfterFailedStart(previousCurrent: RuntimeSession | null): void {
    if (previousCurrent === null || this.current !== null) return;
    if (this.sessions.get(previousCurrent.key) !== previousCurrent) return;
    this.setCurrent(previousCurrent);
  }

  // Called first, before any await, kill or bridge call, so handlers of the old epoch are inert.
  // Per session, not runner-wide: a superseded game's late exit must not clean the replacement's script, and a second project must not make the first's exit look superseded.
  private beginSessionTransition(session: RuntimeSession): number {
    session.epoch += 1;
    return session.epoch;
  }

  private createSession(projectPath: string, mode: RuntimeSessionMode | null): RuntimeSession {
    const session: RuntimeSession = {
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
      bridgeConnectObserved: false,
      startWarnings: [],
      stopped: false,
      stopping: null,
    };
    this.knownSessions.add(session);
    return session;
  }

  /** Point `current` at a session or nothing; only the losing session's socket closes, so a command in flight to another keeps its channel. */
  private setCurrent(session: RuntimeSession | null): void {
    if (this.current === session) return;
    const losing = this.current;
    this.current = session;
    if (losing !== null) this.releaseSocketOf(losing);
  }

  /** Drop a session record; `current` is left empty if it pointed here. */
  private forgetSession(session: RuntimeSession): void {
    if (this.sessions.get(session.key) === session) this.sessions.delete(session.key);
    if (this.current === session) this.setCurrent(null);
    this.releaseSocketOf(session);
  }

  private closeProfiler(session: RuntimeSession): void {
    session.profiler?.close();
    session.profiler = null;
  }

  /** Undo a start that threw before running: drop the record and remove the bridge artifacts when this start injected them or replaced a session whose artifacts would lose their owner. Returns what could not be confirmed. */
  private discardFailedStart(session: RuntimeSession, ownsArtifacts: boolean): string[] {
    this.closeProfiler(session);
    this.forgetSession(session);
    if (!ownsArtifacts) return [];
    // Another record took this project; it shares the owner file and removes the artifacts.
    if (this.sessions.has(session.key)) return [];
    try {
      return this.bridge.cleanup(session.projectPath);
    } catch (err) {
      logDebug(`Bridge cleanup after a failed start failed (ignored): ${err}`);
      return [`bridge cleanup failed outright (${String(err)})`];
    }
  }

  /** Put cleanup problems on the error about to be thrown: the record is gone, so no later call could report them. */
  private appendCleanupProblems(error: unknown, problems: readonly string[]): void {
    if (problems.length === 0 || !(error instanceof Error)) return;
    error.message += ` Bridge cleanup was incomplete: ${problems.join('; ')}`;
  }

  /** Session keys fold case and separators, so a start can replace a record spelled differently; on a case-sensitive filesystem that may be another directory whose artifacts would be orphaned. Returns what could not be confirmed, for `startWarnings`. */
  private cleanupRespelledProject(previous: RuntimeSession, projectPath: string): string[] {
    if (previous.projectPath === projectPath) return [];
    let problems: string[];
    try {
      problems = this.bridge.cleanup(previous.projectPath);
    } catch (err) {
      logDebug(`Bridge cleanup for a replaced session failed: ${err}`);
      problems = [`bridge cleanup failed outright (${String(err)})`];
    }
    if (problems.length === 0) return [];
    return [
      `Bridge cleanup for the session this start replaced (${previous.projectPath}) was incomplete: ${problems.join('; ')}`,
    ];
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
      ...(session.startWarnings.length > 0 ? { startWarnings: [...session.startWarnings] } : {}),
    };
  }

  // The session auto-clear for any exit of any spawned process. Exit code and `hasExited` are recorded unconditionally (the buffer belongs to the process); the rest runs only in the epoch that registered the handler.
  // `process` and `profiler` are left alone and `current` is not moved: logs and a finished capture stay readable and the session stays the one get_debug_output and stop_project act on.
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
    // Only this session's socket: an exit on another project must not cut the command in flight.
    this.releaseSocketOf(session);
    // Nobody waits on this exit, so the cleanup problems are kept for the stop_project that reads them.
    try {
      session.exitCleanupProblems = this.bridge.cleanup(session.projectPath);
    } catch (err) {
      logDebug(`Bridge cleanup after process exit failed: ${err}`);
      session.exitCleanupProblems = [`bridge cleanup failed outright (${String(err)})`];
    }
  }

  /** Drop an attached session whose bridge has gone, like the attached branch of `stopSession` minus `shutdown`. Returns cleanup problems for the caller to put on the error it throws; no later stop_project can report them. */
  private clearAttachedSession(session: RuntimeSession): string[] {
    this.releaseSocketOf(session);
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

  /** Synchronous, never-throwing artifact removal for every session, safe from a `process.on('exit')` handler. One guard per session; no helper program is run (`cleanupAtExit` judges other owners by what is already known). */
  cleanupBridgeArtifactsSync(): void {
    for (const session of [...this.sessions.values()]) {
      if (session.mode === null) continue;
      try {
        this.bridge.cleanupAtExit(session.projectPath);
      } catch {
        // Exit handlers must not throw; there is nowhere left to report to.
      }
    }
  }

  /** Force a process and its children down. Never throws. */
  private forceKillProcessTree(proc: ChildProcess): KillOutcome {
    return killProcessTree(proc, this.killTreeDeps);
  }

  /** Synchronous, never-throwing kill of every spawned game and headless child still running, for the `process.on('exit')` handler (no event loop left, so no bridge `shutdown`). Also covers games whose kill was unconfirmed; attached sessions are left running. Outside Windows both kinds lead their own process group, so the terminal's signal misses them. */
  killSpawnedProcessesSync(): void {
    const games = new Set<ChildProcess>();
    for (const session of this.sessions.values()) {
      const tracked = session.process;
      if (session.mode !== 'spawned' || tracked === null || tracked.hasExited) continue;
      games.add(tracked.process);
    }
    for (const game of this.spawnedGames) games.add(game);
    for (const game of games) {
      try {
        this.forceKillProcessTree(game);
      } catch {
        // Exit handlers must not throw; there is nowhere left to report to.
      }
    }
    for (const child of [...this.headlessChildren]) {
      try {
        this.forceKillProcessTree(child);
      } catch {
        // Exit handlers must not throw; there is nowhere left to report to.
      }
    }
  }

  /** Attach to a project whose Godot the caller launches: inject the bridge with a baked port and token and make the session current. A live attached session of this server is kept (`alreadyAttached`) unless its bridge is gone: a fresh attach would bake a token the running Godot never reads and then remove its bridge. */
  attachProject(projectPath: string, bridgePort?: number): Promise<AttachResult> {
    return this.queue.run('run_project (attach)', () =>
      this.startAttached(projectPath, bridgePort),
    );
  }

  private async startAttached(projectPath: string, bridgePort?: number): Promise<AttachResult> {
    // Absolute path: pollBridge compares against the path the bridge reports.
    projectPath = resolve(projectPath);
    const key = sessionKey(projectPath);

    const existing = this.sessions.get(key) ?? null;
    if (existing !== null && existing.mode === 'attached' && !existing.stopped) {
      const probe = await this.probeAttachedBridge(existing);
      if (probe !== 'gone' && !existing.stopped && this.sessions.get(key) === existing) {
        this.setCurrent(existing);
        return { session: existing, alreadyAttached: true, existingBridge: probe };
      }
    }

    // Phase 1: preconditions. Nothing is stopped or written.
    this.assertBridgePortNotHeld(bridgePort, key);
    this.assertNoMovieRun(key, projectPath);
    const port = bridgePort ?? (await findFreePort());
    this.assertNotShuttingDown(projectPath);
    this.bridge.precheckInject(projectPath, true);
    this.assertStartBudget('attached', key);

    // Phase 2: replace only this project's session.
    const previous = await this.previousAfterPendingStop(key);
    const startWarnings: string[] = [];
    if (previous !== null) {
      if (previous.mode === 'spawned' && previous.process) {
        await this.stopSession(previous);
        // The stop was awaited; a record registered meanwhile is not this attach's to replace.
        if (this.sessions.has(key)) {
          throw new Error(
            `Another session was started on ${projectPath} while its spawned session was being stopped; nothing was attached.`,
          );
        }
      } else {
        this.beginSessionTransition(previous);
        this.closeProfiler(previous);
        this.forgetSession(previous);
        startWarnings.push(...this.cleanupRespelledProject(previous, projectPath));
      }
    }
    this.assertNotShuttingDown(projectPath);

    const session = this.createSession(projectPath, 'attached');
    session.startWarnings = startWarnings;
    const previousCurrent = this.current;
    this.sessions.set(key, session);
    this.setCurrent(session);

    try {
      // No env channel reaches a Godot the user launched, so the baked script is the only way to deliver the token. Set before the port.
      const token = randomBytes(16).toString('hex');
      session.token = token;
      session.bridgePort = port;
      this.bridge.inject(projectPath, port, token);
      const portSource = bridgePort !== undefined ? 'explicit' : 'auto';
      logDebug(`Attaching to Godot project: ${projectPath} (bridge port ${port}, ${portSource})`);
      return { session, alreadyAttached: false };
    } catch (err) {
      // inject writes its owner file before .gitignore and project.godot, so a throw there leaves a live owner claim; the cleanup withdraws it.
      const heldCurrent = this.current === session;
      this.appendCleanupProblems(err, this.discardFailedStart(session, true));
      if (heldCurrent) this.restoreCurrentAfterFailedStart(previousCurrent);
      throw err;
    }
  }

  /** One ping to decide whether a repeated attach keeps the session; 'gone' as in `probeFailureMeansGone`. A connected peer that does not answer is alive and busy, and replacing it would bake a token it never reads. Never throws. */
  private async probeAttachedBridge(
    session: RuntimeSession,
  ): Promise<AttachedProbeOutcome | 'gone'> {
    let reply: string;
    try {
      reply = await this.sendCommandTo(session, 'ping', {}, BRIDGE_PING_TIMEOUT_MS);
    } catch (err) {
      return (await this.probeFailureMeansGone(err)) ? 'gone' : 'silent';
    }
    try {
      const parsed: unknown = JSON.parse(reply);
      const isPong =
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as { status?: unknown }).status === 'pong';
      return isPong ? 'answered' : 'unexpected-reply';
    } catch {
      return 'unexpected-reply';
    }
  }

  /** Whether a failed probe ping shows the bridge gone. A disconnect does; a ping with its connect still pending shows nothing, so that connect's outcome is awaited up to BRIDGE_CONNECT_OUTCOME_WAIT_MS (refused is gone). Never throws. */
  private async probeFailureMeansGone(err: unknown): Promise<boolean> {
    if (err instanceof BridgeDisconnectedError) return true;
    if (!(err instanceof BridgeConnectPendingError)) return false;
    const outcome = await new Promise<PendingConnectOutcome | null>((resolveOutcome) => {
      const timer = setTimeout(() => resolveOutcome(null), BRIDGE_CONNECT_OUTCOME_WAIT_MS);
      void err.connectOutcome.then((settled) => {
        clearTimeout(timer);
        resolveOutcome(settled);
      });
    });
    return outcome === 'failed';
  }

  /** Stop the current session now, without waiting in the session queue: the command in flight is rejected with `SessionStoppedError`, as is every later one on the record. Leaves `current` empty. */
  stopProject(): Promise<RuntimeStopResult | null> {
    const session = this.current;
    if (!session) return Promise.resolve(null);
    return this.stopSession(session);
  }

  private recordOf(ref: SessionRef): RuntimeSession {
    if (!this.knownSessions.has(ref)) {
      throw new Error('Not a session reference from this runner');
    }
    return ref as RuntimeSession;
  }

  /** Snapshot of the record a reference names, registered or not. */
  describeSessionRef(ref: SessionRef): RuntimeSessionInfo {
    return this.describeSession(this.recordOf(ref));
  }

  /** `DebuggerProfiler.streamProblem` for the referenced record. */
  profilerStreamProblemFor(ref: SessionRef): string | null {
    return this.recordOf(ref).profiler?.streamProblem ?? null;
  }

  recentErrorsFor(ref: SessionRef, count: number = RECENT_ERROR_LINES_DEFAULT): string[] {
    return recentErrorLines(this.recordOf(ref).process, count);
  }

  /** Stop the referenced session; null, stopping nothing, when it is no longer the one registered for its project (its artifacts are not its to remove). */
  stopSessionRef(ref: SessionRef): Promise<RuntimeStopResult | null> {
    const session = this.recordOf(ref);
    if (this.sessions.get(session.key) !== session) return Promise.resolve(null);
    return this.stopSession(session);
  }

  /** Ask a session's bridge to shut down on a connection of its own, so a command the command socket carries neither blocks the stop nor is mistaken for its reply. Never throws; bounded by `timeoutMs`. */
  private async requestBridgeShutdown(
    port: number | null,
    token: string | null,
    timeoutMs: number,
  ): Promise<boolean> {
    if (port === null) return false;
    try {
      const payload = JSON.stringify({ command: 'shutdown', token: token ?? undefined });
      return isShutdownAcknowledged(await requestOnce(port, payload, timeoutMs));
    } catch (err) {
      logDebug(`Bridge shutdown timed out or failed (continuing): ${err}`);
      return false;
    }
  }

  /** Ask an attached session's bridge to shut down so the user's Godot releases the port; returns whether it acknowledged, since until it does the bridge listens with that token. Never throws. */
  private shutdownAttachedBridge(session: RuntimeSession): Promise<boolean> {
    // The command socket to this session goes first: nothing more is sent over it.
    this.releaseSocketOf(session);
    return this.requestBridgeShutdown(
      session.bridgePort,
      session.token,
      BRIDGE_SHUTDOWN_ATTACHED_TIMEOUT_MS,
    );
  }

  /** Close the command socket when it belongs to `session`, rejecting its command in flight with `reason`; another session's socket and command are left alone. */
  private releaseSocketOf(session: RuntimeSession, reason?: Error): void {
    if (this.socketSession === session || this.inFlight?.target === session) {
      this.closeConnection(reason);
    }
  }

  // `socket` and `socketSession` only ever change together.
  private dropSocketReference(): void {
    this.socket = null;
    this.socketSession = null;
  }

  // The single entry to a stop; runs at once whatever holds the session queue. The first synchronous statements make that safe: the epoch moves (the killed game's exit handler is inert), `stopped` is set, and the command in flight is rejected with `SessionStoppedError`, which no caller retries.
  // A second stop of a record being stopped shares the first one's outcome.
  private stopSession(session: RuntimeSession): Promise<RuntimeStopResult | null> {
    if (session.stopping !== null) return session.stopping;
    const stopping = this.performStop(session).finally(() => {
      if (session.stopping === stopping) session.stopping = null;
    });
    session.stopping = stopping;
    return stopping;
  }

  /** Remove a stopped session's artifacts unless another record took the project (it shares the owner file). */
  private cleanupStoppedSession(session: RuntimeSession): string[] {
    const registered = this.sessions.get(session.key);
    if (registered !== undefined && registered !== session) return [];
    return this.bridge.cleanup(session.projectPath);
  }

  private retireSession(session: RuntimeSession): void {
    this.forgetSession(session);
    session.mode = null;
    session.bridgePort = null;
    session.token = null;
  }

  private async performStop(session: RuntimeSession): Promise<RuntimeStopResult | null> {
    this.beginSessionTransition(session);
    session.stopped = true;
    this.releaseSocketOf(
      session,
      new SessionStoppedError(session.projectPath, this.inFlight?.command ?? null, true),
    );
    if (session.mode === null) {
      // Release the debugger listener before any early return; stopping a finished capture's record is what finally releases it, and counts as a stop that did something.
      if (!session.process) {
        const heldCapture = session.profiler !== null;
        this.closeProfiler(session);
        this.forgetSession(session);
        if (!heldCapture) return null;
        return {
          mode: 'spawned',
          projectPath: session.projectPath,
          // The logs went out with the earlier stop: nothing held, not a process that printed nothing.
          output: null,
          errors: null,
          alreadyExited: true,
          cleanupProblems: [],
          releasedCaptureOnly: true,
        };
      }

      // The process exited on its own and handleSpawnedProcessExit already cleaned up: return the captured logs and what that cleanup could not confirm. A finished capture survives; only an unfinished one is torn down.
      const exited = session.process;
      if (session.profiler !== null && !session.profiler.hasResult) {
        this.closeProfiler(session);
      }
      session.process = null;
      // A finished capture keeps the record process-less, readable through `activeProfiler` until the next stop.
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
      const cleanupProblems = this.cleanupStoppedSession(session);
      this.retireSession(session);
      return {
        mode: 'attached',
        projectPath: session.projectPath,
        // Null, never an empty log.
        output: null,
        errors: null,
        externalProcessPreserved: true,
        cleanupProblems,
        shutdownAcknowledged,
      };
    }

    const tracked = session.process;
    if (!tracked) {
      // A spawned record with no process: a start does not await between registering, injecting and spawning, so this is unreachable in passing. A record with a port may have injected, so its artifacts are removed; one without has injected nothing.
      this.closeProfiler(session);
      if (session.bridgePort !== null) {
        try {
          const problems = this.cleanupStoppedSession(session);
          if (problems.length > 0) {
            logDebug(`Bridge cleanup for a start stopped mid-flight: ${problems.join('; ')}`);
          }
        } catch (err) {
          logDebug(`Bridge cleanup for a start stopped mid-flight failed (ignored): ${err}`);
        }
      }
      this.retireSession(session);
      return null;
    }

    // Spawned: graceful shutdown so the bridge releases the port, then ensure the exit.
    await this.requestBridgeShutdown(
      session.bridgePort,
      session.token,
      BRIDGE_SHUTDOWN_SPAWNED_TIMEOUT_MS,
    );
    this.closeProfiler(session);

    logDebug('Stopping Godot process');
    // The pid may be a wrapper (Windows *_console.exe, a launcher), so the kill takes the tree.
    const stopped = await this.stopTrackedProcess(tracked);
    // A confirmed exit waits for both streams to end before flushing, so a line is not split in two; an unconfirmed exit may never end them, so what is held is flushed as it stands.
    if (stopped.confirmed && tracked.streamsEnded !== undefined) {
      await settlesWithin(tracked.streamsEnded, STREAM_END_WAIT_TIMEOUT_MS);
    }
    this.finishStderr(tracked);
    this.finishStdout(tracked);

    session.process = null;
    const cleanupProblems = this.cleanupStoppedSession(session);
    this.retireSession(session);

    return {
      mode: 'spawned',
      projectPath: session.projectPath,
      output: tracked.output,
      errors: tracked.errors,
      cleanupProblems,
      ...(stopped.confirmed
        ? {}
        : { killUnconfirmed: true, ...(stopped.pid !== undefined ? { pid: stopped.pid } : {}) }),
    };
  }

  /** Stop every session for server shutdown, each bounded by its worst-case constant; one failing does not keep the others running. Does not queue (a start in a 45 s bridge wait must not hold it up). Terminal: `shuttingDown` tells a record-less start, and no start is accepted afterwards. */
  async stopAllSessions(): Promise<void> {
    this.shuttingDown = true;
    for (const session of [...this.sessions.values()]) {
      try {
        await this.stopSession(session);
      } catch (err) {
        logDebug(`Stopping the session on ${session.projectPath} failed (continuing): ${err}`);
      }
    }
    // A finished capture stays readable after a stop of an exited session; at shutdown nothing reads it. A record whose stop threw keeps its mode, so the exit handler gets another attempt at its artifacts.
    for (const session of [...this.sessions.values()]) {
      if (session.mode !== null) continue;
      this.closeProfiler(session);
      this.forgetSession(session);
    }
  }

  hasActiveRuntimeSession(): boolean {
    return this.current !== null && isSessionLive(this.current);
  }

  listSessions(): RuntimeSessionInfo[] {
    return [...this.sessions.values()].map((session) => this.describeSession(session));
  }

  listLiveSessions(): RuntimeSessionInfo[] {
    return this.listSessions().filter((info) => info.live);
  }

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

  hasLiveSessionOnProject(projectPath: string): boolean {
    const session = this.sessions.get(sessionKey(projectPath));
    return session !== undefined && isSessionLive(session);
  }

  /** Make a project's session current and close the bridge socket so the next command dials it; null, changing nothing, when there is none. Works on a retained exited session (`live: false`), which is how its logs are read and freed. */
  switchSession(projectPath: string): RuntimeSessionInfo | null {
    // Moving the pointer closes the socket, which would reject a command another call has in flight; switch_project holds the queue around this.
    if (!this.queue.freeOrHeldByCaller()) {
      throw new Error(
        `Cannot switch sessions while ${this.queue.running ?? 'another operation'} is running: call switchSession inside runExclusive.`,
      );
    }
    const session = this.sessions.get(sessionKey(projectPath));
    if (!session) return null;
    this.setCurrent(session);
    return this.describeSession(session);
  }

  /** Copies of a project's retained stdout/stderr; null when it has no process (attached), so "nothing captured" is never empty logs. */
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

  /** Send a JSON command to the McpBridge over one long-lived socket, waiting its turn in the session queue. A per-command timeout rejects with a plain `Error` and destroys the socket so a late response cannot answer the next command; the session lives and the next command reconnects. Always addresses the session current when the turn comes; with none, or no bridge port, nothing is dialed and it rejects with `BridgeDisconnectedError`. @throws {SessionQueueTimeoutError} */
  sendCommand(
    command: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = BRIDGE_COMMAND_DEFAULT_TIMEOUT_MS,
  ): Promise<string> {
    return this.queue.run(`bridge command '${command}'`, () =>
      this.sendCommandTo(this.current, command, params, timeoutMs),
    );
  }

  /** `sendCommand` against a named session, not queued (callers hold the queue). Closes a socket dialed for another session first. A second command in flight is a server bug and is rejected, never interleaved. A stopped record is never dialed. Teardown uses `requestBridgeShutdown`. */
  private sendCommandTo(
    target: RuntimeSession | null,
    command: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      if (target !== null && target.stopped) {
        reject(new SessionStoppedError(target.projectPath, command, false));
        return;
      }
      if (this.inFlight) {
        reject(
          new Error(
            `Internal error: bridge command '${command}' was issued while '${this.inFlight.command}' was still in flight. Bridge commands are serialized by the session queue, so this is a bug in the server, not in the call.`,
          ),
        );
        return;
      }

      if (this.socket !== null && this.socketSession !== target) this.closeConnection();

      // No bridge port means nothing to dial; a default port could reach another Godot with a frame that carries no token.
      const port = target?.bridgePort ?? null;
      if (port === null) {
        reject(
          new BridgeDisconnectedError(
            `Command '${command}' not sent: the session has no bridge port to connect to`,
            false,
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
        // Destroy the socket: the bridge serializes commands, so a late response would correlate against the next command.
        if (this.socket) this.discardSocket(this.socket);
        this.resetRxBuffer();
        const message = `Command '${command}' timed out after ${timeoutMs}ms. Is the game running?`;
        // A pending connect is not a peer that failed to answer.
        const pendingConnect = flight.pendingConnect;
        settle(
          pendingConnect !== null
            ? new BridgeConnectPendingError(message, pendingConnect)
            : new Error(message),
        );
      }, clampTimerDelay(timeoutMs));

      const flight: InFlightCommand = {
        command,
        target,
        frameWritten: false,
        pendingConnect: null,
        resolve,
        reject,
        timer,
      };
      this.inFlight = flight;

      const ensureSocket = (cb: (err?: Error) => void): void => {
        if (this.socket) {
          cb();
          return;
        }
        const sock = net.connect(port, '127.0.0.1');
        let reportOutcome: (outcome: PendingConnectOutcome) => void = () => {};
        flight.pendingConnect = new Promise<PendingConnectOutcome>((settleOutcome) => {
          reportOutcome = settleOutcome;
        });
        // A connect can outlive its command (timed out, or closeConnection rejected it). Its late outcome belongs to nobody: installing the socket would point the channel at this command's session and write a stale frame, and reporting its failure would reject another command. Both callbacks act only while this command is in flight.
        const onConnect = (): void => {
          sock.removeListener('error', onConnectError);
          reportOutcome('connected');
          if (this.inFlight !== flight) {
            sock.destroy();
            return;
          }
          flight.pendingConnect = null;
          sock.setNoDelay(true);
          this.socket = sock;
          this.socketSession = target;
          if (target !== null) target.bridgeConnectObserved = true;
          this.resetRxBuffer();

          sock.on('data', (chunk: Buffer) => {
            this.rxChunks.push(chunk);
            this.rxTotal += chunk.length;

            // Peek the 4-byte header before concatenating accumulated chunks.
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
            if (this.socket === sock) this.dropSocketReference();
            settle(
              new BridgeDisconnectedError(
                `Bridge connection closed before '${command}' response was received`,
              ),
            );
          };
          sock.once('close', onClose);
          sock.on('error', (sockErr: Error) => {
            if (this.socket === sock) this.dropSocketReference();
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
          reportOutcome('failed');
          if (this.inFlight !== flight) return;
          flight.pendingConnect = null;
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
              false,
            ),
          );
          return;
        }
        if (!this.socket) {
          settle(new BridgeDisconnectedError(`Bridge socket unavailable for '${command}'`, false));
          return;
        }
        try {
          const payload = JSON.stringify({
            command,
            token: target?.token ?? undefined,
            ...params,
          });
          this.socket.write(encodeFrame(payload));
          flight.frameWritten = true;
        } catch (writeErr) {
          const message = writeErr instanceof Error ? writeErr.message : String(writeErr);
          settle(new Error(`Failed to send command '${command}': ${message}`));
        }
      });
    });
  }

  /** Tear down the bridge socket; idempotent. A command in flight is rejected with `reason` (a disconnect by default; a stop passes `SessionStoppedError`). */
  closeConnection(reason?: Error): void {
    if (this.inFlight) {
      const flight = this.inFlight;
      this.inFlight = null;
      clearTimeout(flight.timer);
      flight.reject(
        reason ?? new BridgeDisconnectedError('Bridge session ended', flight.frameWritten),
      );
    }
    const sock = this.socket;
    this.dropSocketReference();
    if (sock) {
      sock.removeAllListeners();
      sock.destroy();
    }
    this.resetRxBuffer();
  }

  /** Drop a socket given up on (timeout, unreadable frame). Listeners go before the destroy: its late 'close' would settle whichever command is in flight with a disconnect it never had (ending a live attached session via the probe) and null the replacement socket's reference. */
  private discardSocket(sock: net.Socket): void {
    if (this.socket === sock) this.dropSocketReference();
    sock.removeAllListeners();
    // An 'error' with no listener is thrown; a late one on an abandoned socket must not take the server down.
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
    return errorsSince(this.activeProcess, marker);
  }

  /** Fold one decoded stderr chunk into the session buffers; with `finishStderr`, the only writer of `errors` and `totalErrorsWritten`. Public for tests. Sentinels become marks, never retained lines; only complete lines are classified (a chunk may end mid-line: boundary 1 then "2" is boundary 12), so the tail is held in `proc.stderrLines`. */
  ingestStderrChunk(proc: GodotProcess, text: string): void {
    if (text === '') return;
    proc.stderrLines ??= new LineAssembler();
    for (const line of proc.stderrLines.push(text)) this.retainStderrLine(proc, line);
    this.trimStderrRing(proc);
  }

  /** The stream ended: the text it stopped in the middle of is the last line. Also called when a stop hands logs back early. */
  finishStderr(proc: GodotProcess): void {
    const tail = proc.stderrLines?.end() ?? null;
    if (tail === null) return;
    this.retainStderrLine(proc, tail);
    this.trimStderrRing(proc);
  }

  private retainStderrLine(proc: GodotProcess, line: string): void {
    const boundaryIndex = parseActionBoundary(line);
    if (boundaryIndex !== null) {
      if (!proc.actionBoundaries) proc.actionBoundaries = [];
      proc.actionBoundaries.push({ index: boundaryIndex, seq: proc.totalErrorsWritten });
      return;
    }
    if (line.trim() === '') return;
    proc.errors.push(line);
    proc.totalErrorsWritten += 1;
    logDebug(`[Godot stderr] ${line}`);
  }

  private trimStderrRing(proc: GodotProcess): void {
    if (proc.errors.length > STDERR_RING_LIMIT_LINES) {
      proc.errors.splice(0, proc.errors.length - STDERR_RING_LIMIT_LINES);
    }
  }

  /** Fold one decoded stdout chunk into `output` under the same line rules as {@link ingestStderrChunk}; with `finishStdout`, its only writer. */
  ingestStdoutChunk(proc: GodotProcess, text: string): void {
    if (text === '') return;
    proc.stdoutLines ??= new LineAssembler();
    for (const line of proc.stdoutLines.push(text)) this.retainStdoutLine(proc, line);
  }

  finishStdout(proc: GodotProcess): void {
    const tail = proc.stdoutLines?.end() ?? null;
    if (tail !== null) this.retainStdoutLine(proc, tail);
  }

  private retainStdoutLine(proc: GodotProcess, line: string): void {
    if (line.trim() === '') return;
    proc.output.push(line);
    logDebug(`[Godot stdout] ${line}`);
    if (proc.output.length > STDOUT_RING_LIMIT_LINES) {
      proc.output.splice(0, proc.output.length - STDOUT_RING_LIMIT_LINES);
    }
  }

  /** The delta window of {@link getErrorsSince} without its blank-line filter, with the first line's sequence number; boundary marks need unshifted positions. */
  stderrWindowSince(
    marker: number,
    proc: GodotProcess | null = this.activeProcess,
  ): { lines: string[]; startSeq: number } {
    if (!proc) return { lines: [], startSeq: marker };
    const { errors, totalErrorsWritten } = proc;
    const delta = totalErrorsWritten - marker;
    if (delta <= 0) return { lines: [], startSeq: totalErrorsWritten };
    const lines = delta >= errors.length ? errors.slice() : errors.slice(errors.length - delta);
    return { lines, startSeq: totalErrorsWritten - lines.length };
  }

  /** Open a per-action error capture ahead of an input batch on the current process, which the capture keeps. Clearing the boundary list bounds it to one batch (one batch at a time via the session queue). */
  beginActionErrorCapture(): ActionErrorCapture {
    const proc = this.activeProcess;
    if (proc) proc.actionBoundaries = [];
    return { marker: proc?.totalErrorsWritten ?? 0, proc };
  }

  /** Close a capture and attribute its runtime-error lines to actions. The TCP response can beat stderr, so it polls (bounded by `drainTimeoutMs`) for the expected boundary count and reports `sentinelTimedOut`. Attached sessions get empty buckets. */
  async collectActionErrors(
    capture: ActionErrorCapture,
    expectedSentinels: number,
    drainTimeoutMs: number = SENTINEL_DRAIN_TIMEOUT_MS,
  ): Promise<ActionErrorBuckets> {
    const proc = capture.proc !== undefined ? capture.proc : this.activeProcess;
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
    const { lines, startSeq } = this.stderrWindowSince(capture.marker, proc);
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

  // Only explicit script-error markers: the looser `GDScript error` substring also matches user printerr output.
  private static readonly SCRIPT_ERROR_PATTERNS = ['SCRIPT ERROR:', 'USER SCRIPT ERROR:'];
  private static readonly RETRYABLE_BRIDGE_COMMANDS = new Set(['get_ui_elements', 'screenshot']);
  /** Exempt from the attached-mode disconnect probe: a `ping` is already that probe's question and must not recurse. `shutdown` never goes through the reconnect wrapper. */
  private static readonly DISCONNECT_EXEMPT_BRIDGE_COMMANDS = new Set(['ping']);

  extractRuntimeErrors(lines: string[]): string[] {
    return lines.filter((line) => GodotRunner.SCRIPT_ERROR_PATTERNS.some((p) => line.includes(p)));
  }

  /** `sendCommand` plus the transient-drop retry and, in attached mode, the disconnect probe. Only `BridgeDisconnectedError` enters: a per-command timeout (plain `Error`) never does, so a wedged-but-alive game is not taken for a dead one, and neither does `SessionStoppedError`. Spawned sessions are left to their exit handler, `ping` is exempt, a retryable command spends its retry first, and a probe must show the bridge gone before anything is cleared. */
  private async sendCommandWithReconnect(
    // All attempts and the probe go to this session, which is judged and cleared, not whichever is current later.
    session: RuntimeSession | null,
    command: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = BRIDGE_COMMAND_DEFAULT_TIMEOUT_MS,
  ): Promise<string> {
    let failure: BridgeDisconnectedError;
    try {
      return await this.sendCommandTo(session, command, params, timeoutMs);
    } catch (err) {
      if (!(err instanceof BridgeDisconnectedError)) throw err;
      failure = err;
    }

    const retryable = GodotRunner.RETRYABLE_BRIDGE_COMMANDS.has(command);

    if (session === null || session.mode !== 'attached') {
      if (session?.mode && retryable) {
        this.releaseSocketOf(session);
        await new Promise((r) => setTimeout(r, BRIDGE_RECONNECT_DELAY_MS));
        try {
          return await this.sendCommandTo(session, command, params, timeoutMs);
        } catch (retryErr) {
          throw failure.frameWritten ? asSentFailure(retryErr) : retryErr;
        }
      }
      throw failure;
    }

    if (GodotRunner.DISCONNECT_EXEMPT_BRIDGE_COMMANDS.has(command)) throw failure;

    if (retryable) {
      this.releaseSocketOf(session);
      await new Promise((r) => setTimeout(r, BRIDGE_RECONNECT_DELAY_MS));
      try {
        return await this.sendCommandTo(session, command, params, timeoutMs);
      } catch (retryErr) {
        const sentBefore = failure.frameWritten;
        if (!(retryErr instanceof BridgeDisconnectedError)) {
          throw sentBefore ? asSentFailure(retryErr) : retryErr;
        }
        failure = sentBefore ? asSentDisconnect(retryErr) : retryErr;
      }
    }

    // Exactly one probe. A pong means the session stands; it ends only when the probe shows the bridge gone. A connected peer leaving the ping unanswered is alive, which a timeout must never be taken for.
    this.releaseSocketOf(session);
    try {
      await this.sendCommandTo(session, 'ping', {}, BRIDGE_PING_TIMEOUT_MS);
    } catch (probeErr) {
      const gone = await this.probeFailureMeansGone(probeErr);
      // A stop does not wait for this command and may have taken the record.
      if (gone && !session.stopped && this.sessions.get(session.key) === session) {
        this.appendCleanupProblems(failure, this.clearAttachedSession(session));
      }
    }
    throw failure;
  }

  /** Send a command to the current session and return the reply with the stderr written meanwhile. The session is read once, when the turn comes; send, retry, probe and stderr window all belong to that record. @throws {SessionQueueTimeoutError} */
  sendCommandWithErrors(
    command: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = BRIDGE_COMMAND_DEFAULT_TIMEOUT_MS,
  ): Promise<{ response: string; runtimeErrors: string[]; stderrWindow: string[] }> {
    return this.queue.run(`bridge command '${command}'`, async () => {
      // No current session: reject before dialing, with the live sessions on the error; another is never picked.
      const session = this.current;
      if (session === null) {
        throw new NoLiveCurrentSessionError(this.getRuntimeSessionStatus());
      }
      const marker = session.process?.totalErrorsWritten ?? 0;
      const response = await this.sendCommandWithReconnect(session, command, params, timeoutMs);
      // Keyed on the retained process, not the mode: the auto-clear nulls the mode on exit but the stderr buffer survives. Attached sessions have no process and get [].
      const newErrors = errorsSince(session.process, marker);
      const runtimeErrors = session.process !== null ? this.extractRuntimeErrors(newErrors) : [];
      // The unfiltered window is for callers needing the engine output around a failure (run_script compile diagnostics: the "at:" line the per-line filter drops).
      return { response, runtimeErrors, stderrWindow: newErrors };
    });
  }

  /** Shared poll loop for `waitForBridge` and `waitForBridgeAttached`: ping one session until a valid pong, the deadline, or `shouldAbort`. Reads only the given record, never the current pointer: the wait lasts up to 45 s. */
  private async pollBridge(
    session: RuntimeSession,
    opts: {
      expectedPath: string | null;
      timeoutMs: number;
      intervalMs: number;
      timeoutError: string;
      pingPayload: Record<string, unknown>;
      validatePong: (parsed: { status?: string; [k: string]: unknown }) => boolean;
      shouldAbort?: () => { aborted: boolean; tail: string[] };
      /** Extended ceiling once a TCP connect to the bridge port succeeded (the engine is finishing startup). Omitted: `timeoutMs` throughout. */
      extendedTimeoutMs?: number;
      /** `Date.now()` past which the wait ends whichever ceiling applies (see `startBridgeWaitDeadline`). */
      deadlineAt?: number | null;
    },
  ): Promise<BridgeWaitResult> {
    const started = Date.now();
    const deadlineBudget =
      typeof opts.deadlineAt === 'number' ? Math.max(0, opts.deadlineAt - started) : null;
    const result = (outcome: BridgeWaitResult): BridgeWaitResult => ({
      ...outcome,
      waitedMs: Date.now() - started,
    });
    // Consecutive ping failures since the last answered ping, counted once a connect was observed (BRIDGE_CONNECTED_PING_FAILURE_LIMIT).
    let connectedPingFailures = 0;

    while (true) {
      let budget = opts.timeoutMs;
      let extended = false;
      if (opts.extendedTimeoutMs !== undefined && session.bridgeConnectObserved) {
        budget = opts.extendedTimeoutMs;
        extended = true;
      }
      if (deadlineBudget !== null) budget = Math.min(budget, deadlineBudget);
      if (Date.now() - started >= budget) break;
      if (extended && connectedPingFailures >= BRIDGE_CONNECTED_PING_FAILURE_LIMIT) {
        return result({
          ready: false,
          error: `Something is listening on the bridge port but did not answer ${BRIDGE_CONNECTED_PING_FAILURE_LIMIT} consecutive pings - it is most likely not this bridge. Check for a Godot process left over from an earlier session, or pass a different bridgePort.`,
        });
      }

      // Before the exit check: a stop kills the game, and that exit must not be reported as the game's own.
      if (session.stopped) return result(BRIDGE_WAIT_STOPPED);
      if (this.sessions.get(session.key) !== session) {
        return result({
          ready: false,
          error: 'The session was replaced while it was starting.',
        });
      }
      if (opts.shouldAbort) {
        const abort = opts.shouldAbort();
        if (abort.aborted) {
          const errorText = abort.tail.length > 0 ? `\nLast stderr:\n${abort.tail.join('\n')}` : '';
          return result({
            ready: false,
            error: `Process exited with code ${session.process?.exitCode ?? '?'} before bridge was ready.${errorText}`,
          });
        }
      }

      try {
        const response = await this.sendCommandTo(
          session,
          'ping',
          opts.pingPayload,
          BRIDGE_PING_TIMEOUT_MS,
        );
        // Answered at all, so the peer speaks the frame protocol; reset before validating (a non-pong reply is a bridge mid-startup).
        connectedPingFailures = 0;
        const parsed = JSON.parse(response);
        // A bridge refusing this session's token refuses every ping (it took its token from another session); counted as answered it would spend the whole budget.
        if (parsed !== null && parsed.error === BRIDGE_UNAUTHORIZED_ERROR) {
          return result({
            ready: false,
            error: `A bridge with a different session token is listening on port ${session.bridgePort ?? 'unknown'}: a Godot left from an earlier session. Close it, then retry.`,
          });
        }
        if (opts.validatePong(parsed)) {
          if (opts.expectedPath && typeof parsed.project_path === 'string') {
            const bridgePath = normalizeForCompare(parsed.project_path);
            // Compared with the session key's folding: the two spellings of one directory differ in drive-letter or name case.
            if (projectPathKey(bridgePath) !== projectPathKey(opts.expectedPath)) {
              return result({
                ready: false,
                error: `Bridge reports project ${bridgePath}, expected ${opts.expectedPath}`,
              });
            }
          }
          return result({ ready: true });
        }
      } catch (err) {
        if (err instanceof SessionStoppedError) return result(BRIDGE_WAIT_STOPPED);
        // Expected until the bridge listens. Refusals before the first connect are not counted: Godot launches seconds into an attach wait, and counting them would spend the limit first.
        if (session.bridgeConnectObserved) connectedPingFailures += 1;
      }

      const elapsed = Date.now() - started;
      const interval =
        elapsed < BRIDGE_WAIT_BACKOFF_AFTER_MS ? opts.intervalMs : BRIDGE_WAIT_MAX_INTERVAL_MS;
      // Never sleep past the budget (by more than one in-flight ping).
      const pause = Math.min(interval, Math.max(0, budget - elapsed));
      await new Promise((resolve) => setTimeout(resolve, pause));
    }

    return result({ ready: false, error: opts.timeoutError });
  }

  /** Deadline of a bridge wait made inside a start's turn, and the sentence saying so when it cut the wait short of `nominalMs`; a wait outside any turn has none. */
  private bridgeWaitDeadline(
    mode: RuntimeSessionMode,
    nominalMs: number,
  ): { deadlineAt: number | null; cutNote: string } {
    const turn = this.queue.turn();
    if (turn === null) return { deadlineAt: null, cutNote: '' };
    const deadlineAt = startBridgeWaitDeadline(mode, turn.requestedAt);
    const left = Math.max(0, deadlineAt - Date.now());
    if (left >= nominalMs) return { deadlineAt, cutNote: '' };
    const behind = turn.behind !== null ? ` behind ${turn.behind}` : '';
    return {
      deadlineAt,
      cutNote: ` The wait was cut to ${left} ms from ${nominalMs} ms: this call had already spent ${Date.now() - turn.requestedAt} ms, ${turn.waitedMs} ms of it waiting for its turn${behind}, and has to answer within ${START_RESPONSE_BUDGET_MS} ms.`,
    };
  }

  /** Wait for an attached session's bridge (`ref`, else the current one), holding the session queue throughout. */
  waitForBridgeAttached(
    timeoutMs: number = BRIDGE_WAIT_ATTACHED_TIMEOUT_MS,
    intervalMs: number = BRIDGE_WAIT_ATTACHED_INTERVAL_MS,
    ref?: SessionRef,
  ): Promise<BridgeWaitResult> {
    return this.queue.run('run_project (attach)', async () => {
      const session = ref !== undefined ? this.recordOf(ref) : this.current;
      if (session === null) {
        return { ready: false, error: 'No attached session to wait for' };
      }
      const { deadlineAt, cutNote } = this.bridgeWaitDeadline(
        'attached',
        BRIDGE_WAIT_ATTACHED_CONNECTED_TIMEOUT_MS,
      );
      return this.pollBridge(session, {
        expectedPath: normalizeForCompare(session.projectPath),
        timeoutMs,
        intervalMs,
        timeoutError: `Bridge did not respond within timeout - is Godot running with the McpBridge autoload?${cutNote}`,
        pingPayload: {},
        validatePong: (parsed) => parsed.status === 'pong',
        extendedTimeoutMs: BRIDGE_WAIT_ATTACHED_CONNECTED_TIMEOUT_MS,
        deadlineAt,
      });
    });
  }

  /** Wait for a spawned session's bridge (`ref`, else the current one), holding the session queue throughout. */
  waitForBridge(
    timeoutMs: number = BRIDGE_WAIT_SPAWNED_TIMEOUT_MS,
    intervalMs: number = BRIDGE_WAIT_SPAWNED_INTERVAL_MS,
    ref?: SessionRef,
  ): Promise<BridgeWaitResult> {
    return this.queue.run('run_project', async () => {
      const session = ref !== undefined ? this.recordOf(ref) : this.current;
      if (session !== null && session.stopped) return BRIDGE_WAIT_STOPPED;
      const proc = session?.process ?? null;
      const expectedToken = proc?.sessionToken;
      if (session === null || proc === null || !expectedToken) {
        return { ready: false, error: 'No active spawned Godot process to verify' };
      }

      const { deadlineAt, cutNote } = this.bridgeWaitDeadline('spawned', timeoutMs);
      return this.pollBridge(session, {
        expectedPath: normalizeForCompare(session.projectPath),
        timeoutMs,
        intervalMs,
        timeoutError: `Bridge did not respond with the expected session token within timeout${cutNote === '' ? '' : `.${cutNote}`}`,
        pingPayload: { session_token: expectedToken },
        validatePong: (parsed) =>
          parsed.status === 'pong' && parsed.session_token === expectedToken,
        shouldAbort: () => ({
          aborted: proc.hasExited,
          tail: recentErrorLines(proc, RECENT_ERROR_LINES_DEFAULT),
        }),
        deadlineAt,
      });
    });
  }

  getRecentErrors(count: number = RECENT_ERROR_LINES_DEFAULT): string[] {
    return recentErrorLines(this.activeProcess, count);
  }
}
