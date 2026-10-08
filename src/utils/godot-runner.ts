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

/**
 * Thrown when the bridge socket closes (Godot exited, port closed, or peer
 * dropped the connection mid-flight). Lets callers distinguish
 * "session ended" from generic transport errors.
 */
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

/**
 * Thrown when a command timed out while its TCP connect was still pending.
 * Not a `BridgeDisconnectedError` and not proof of a live peer either: nothing
 * was reached yet. `connectOutcome` settles with what that connect did next.
 */
export class BridgeConnectPendingError extends Error {
  constructor(
    message: string,
    readonly connectOutcome: Promise<PendingConnectOutcome>,
  ) {
    super(message);
    this.name = 'BridgeConnectPendingError';
  }
}

/**
 * Thrown to a command that a stop cut off, and to any command sent afterwards
 * to the record that was stopped. Deliberately not a
 * `BridgeDisconnectedError`: that one means "the bridge may be gone, probe or
 * retry", and here nothing is to be retried. The session was ended on
 * purpose, by `stop_project` or by the server shutting down.
 */
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

/**
 * Thrown by a start that got its turn too late: what is left of the request's
 * time is less than the shortest bridge wait worth launching for. Thrown
 * before anything is stopped, written or spawned.
 */
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
// to BRIDGE_WAIT_MAX_INTERVAL_MS - a flat interval across a 45 s ceiling would
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
/**
 * How long a stop waits for the game's `exit` event after the forced tree
 * kill. A kill that was sent is not a process that died: past this the stop
 * reports the kill as unconfirmed instead of reporting a stop.
 */
const SESSION_KILL_CONFIRM_TIMEOUT_MS = 3000;
/**
 * The same wait for a headless run killed on its timeout, on its `close`
 * event. Until that arrives the engine may still be running and may still
 * save the scene the timed-out operation was editing.
 */
const HEADLESS_KILL_CONFIRM_TIMEOUT_MS = 3000;
/**
 * How long a stop waits, after the game's exit was confirmed, for its stdout
 * and stderr to report their end. The pipes of a dead process drain within a
 * few milliseconds; the bound is for a grandchild that inherited them and
 * keeps them open.
 */
const STREAM_END_WAIT_TIMEOUT_MS = 500;
/** Timeout of a headless child when the caller names none (the version probe). */
const HEADLESS_DEFAULT_TIMEOUT_MS = 10000;
/** Timeout of a headless operation when the caller names none. */
export const HEADLESS_OPERATION_TIMEOUT_MS = 30000;
/**
 * How long a graceful shutdown waits for headless runs still in flight to
 * report `close` before the process exits and the exit hook kills what is
 * left. A run that finishes inside it ends by itself, having written what it
 * set out to write; one that does not is killed as before.
 */
export const HEADLESS_SHUTDOWN_WAIT_MS = 10000;
/** Timeout of a bridge command when the caller names none. */
const BRIDGE_COMMAND_DEFAULT_TIMEOUT_MS = 10000;
/** How many trailing stderr lines a caller gets when it names no count. */
const RECENT_ERROR_LINES_DEFAULT = 20;
const BRIDGE_RECONNECT_DELAY_MS = 1000;
// Windows can take about 2 s to refuse a connect to a closed loopback port.
const BRIDGE_CONNECT_OUTCOME_WAIT_MS = 3000;

/**
 * The MCP SDK's default per-request client timeout. A client that attached no
 * progressToken gets no heartbeats and gives up here, and an answer the
 * server sends later is never read.
 */
export const CLIENT_REQUEST_TIMEOUT_MS = 60000;
/**
 * Time a start is given from the moment it was requested (when it asked for
 * its turn in the session queue) to the moment its answer is ready, the
 * teardown of a start that did not come up included. The rest of the client
 * ceiling is for delivering that answer.
 */
export const START_RESPONSE_BUDGET_MS = 55000;
/**
 * Longest a stop of a spawned session waits: the `shutdown` command, the
 * polite stop, the forced kill and the streams' end. The two kill calls
 * themselves are synchronous and normally take a few milliseconds.
 */
export const SPAWNED_STOP_WORST_CASE_MS =
  BRIDGE_SHUTDOWN_SPAWNED_TIMEOUT_MS +
  BRIDGE_PROCESS_EXIT_TIMEOUT_MS +
  SESSION_KILL_CONFIRM_TIMEOUT_MS +
  STREAM_END_WAIT_TIMEOUT_MS;
/** Longest a stop of an attached session waits: the `shutdown` command. */
export const ATTACHED_STOP_WORST_CASE_MS = BRIDGE_SHUTDOWN_ATTACHED_TIMEOUT_MS;
/**
 * Shortest bridge wait a start is launched for. A start with less left than
 * this is refused before it stops or spawns anything: a game given a few
 * seconds would be started only to be reported as not ready and killed.
 */
export const BRIDGE_WAIT_FLOOR_MS = 10000;

/**
 * When the bridge wait of a start requested at `requestedAt` has to end so
 * that the whole request stays inside START_RESPONSE_BUDGET_MS.
 *
 * Counted from the request, not from the spawn, so everything that came
 * first is charged to the wait: the time in the session queue, the checks,
 * and the stop of the session the start replaced. After the deadline come at
 * most one ping that was already in flight (BRIDGE_PING_TIMEOUT_MS) and the
 * teardown of the start that did not come up, both reserved here.
 *
 * Worst case from request to response, for a caller that waited the whole
 * queue timeout:
 *
 *   spawned:  55 s - (6 s teardown + 1 s ping) = 48 s deadline; the wait is
 *             min(30 s, what is left of the 48 s); answer by 55 s.
 *   attached: 55 s - (1.5 s teardown + 1 s ping) = 52.5 s deadline; the wait
 *             is min(20 s with no listener / 45 s once connected, what is
 *             left of the 52.5 s); answer by 55 s.
 *
 * The longest queue wait (30 s) plus the stop of a replaced spawned session
 * (6 s) still leaves both paths more than BRIDGE_WAIT_FLOOR_MS, so a start
 * that got its turn is refused for lack of time only when its own checks
 * were slow. `bridge-readiness-budget.test.ts` asserts these relations.
 */
export function startBridgeWaitDeadline(mode: RuntimeSessionMode, requestedAt: number): number {
  const teardown = mode === 'spawned' ? SPAWNED_STOP_WORST_CASE_MS : ATTACHED_STOP_WORST_CASE_MS;
  return requestedAt + START_RESPONSE_BUDGET_MS - teardown - BRIDGE_PING_TIMEOUT_MS;
}

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
   * Holds the stderr text that has not ended in a newline yet. Optional so a
   * hand-built process literal stays valid; `ingestStderrChunk` creates it.
   */
  stderrLines?: LineAssembler;
  /** The same for stdout, kept by `ingestStdoutChunk`. */
  stdoutLines?: LineAssembler;
  /**
   * Settles once stdout and stderr have both reported their end. Absent on a
   * hand-built process literal, which has no streams to wait for.
   */
  streamsEnded?: Promise<void>;
}

/** Opaque handle returned by `beginActionErrorCapture`. */
export interface ActionErrorCapture {
  marker: number;
  /**
   * The process whose stderr the capture reads, fixed when the capture was
   * opened. Null for an attached session, which captures nothing. Absent on a
   * hand-built capture, which reads the current session's process.
   */
  proc?: GodotProcess | null;
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
  /**
   * True once a TCP connect to this session's bridge port has succeeded. Set
   * in `sendCommandTo`'s `onConnect` callback and read by `pollBridge` to
   * switch to the extended readiness budget.
   */
  bridgeConnectObserved: boolean;
  /**
   * What the start of this session could not confirm about the session it
   * replaced, as sentences for the `run_project` payload. Empty normally.
   */
  startWarnings: string[];
  /**
   * True from the first statement of a stop of this record. A stop does not
   * wait for the operation holding the session queue, so that operation may
   * still hold this record: every command it sends here afterwards is
   * rejected with `SessionStoppedError`, and a start that was replacing this
   * record gives up. Never reset.
   */
  stopped: boolean;
  /**
   * The stop in progress on this record, or null. A second stop arriving
   * meanwhile shares it and reports the same result.
   */
  stopping: Promise<RuntimeStopResult | null> | null;
}

/**
 * A reference to one session record, for a caller that started the session
 * and has to act on that same record after its own awaits. The current
 * pointer and the per-project map can both name a different record by then;
 * a reference cannot. Opaque: pass it back to the runner.
 */
export interface SessionRef {
  readonly projectPath: string;
}

/** What `attachProject` did. */
export interface AttachResult {
  session: SessionRef;
  /**
   * True when this server already held a live attached session on the
   * project and its bridge was not seen to be gone: that session was kept and
   * made current, and nothing was injected.
   */
  alreadyAttached: boolean;
  /**
   * What the kept session's bridge did with the probe ping, when
   * `alreadyAttached`: `answered` with a pong, `silent` when no reply came
   * within the probe time (a game that is busy, not one that is gone), or
   * `unexpected-reply` when something answered that was not a pong.
   */
  existingBridge?: AttachedProbeOutcome;
}

/** See {@link AttachResult.existingBridge}. */
export type AttachedProbeOutcome = 'answered' | 'silent' | 'unexpected-reply';

/** What a bridge wait reports. */
export interface BridgeWaitResult {
  ready: boolean;
  error?: string;
  /** True when the wait ended because the session was stopped under it. */
  stopped?: boolean;
  /** How long the wait lasted. */
  waitedMs?: number;
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
  /** See {@link RuntimeSession.startWarnings}. Absent means none. */
  startWarnings?: string[];
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

/** What a bridge wait reports when its session was stopped under it. */
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
  /**
   * True when the kill was sent and the process did not report its exit
   * within the wait: it may still be running. Absent when the exit was
   * observed, or when the operating system reported the process already gone.
   */
  killUnconfirmed?: boolean;
  /** Pid the kill was sent to, when `killUnconfirmed`. */
  pid?: number;
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
  /** The session the command was sent to. */
  target: RuntimeSession | null;
  /** True once the frame was handed to the socket. */
  frameWritten: boolean;
  /** The outcome of the connect this command started, while that connect is pending. */
  pendingConnect: Promise<PendingConnectOutcome> | null;
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

/**
 * True when `err` proves the bridge command it came from never reached the
 * game: the session was stopped or absent before the send, or the channel
 * failed before the frame was written.
 */
export function commandWasNotSent(err: unknown): boolean {
  if (err instanceof SessionStoppedError) return !err.cutOff;
  if (err instanceof NoLiveCurrentSessionError) return true;
  if (err instanceof BridgeDisconnectedError) return !err.frameWritten;
  return err instanceof BridgeConnectPendingError;
}

/**
 * Wait for `promise` up to `timeoutMs`. True when it settled in time. Never
 * rejects: a rejection counts as settled.
 */
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

/** Why a `--version` probe failed, from what `spawnAsync` rejected with. */
function describeProbeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const tail = stderrTailLines(asSpawnError(error)?.stderr ?? '').map((line) => line.trim());
  return tail.length === 0 ? message : `${message}; stderr: ${tail.join(' | ')}`;
}

/** A retry's disconnect, restated for a command whose first attempt was written. */
function asSentDisconnect(err: BridgeDisconnectedError): BridgeDisconnectedError {
  return err.frameWritten ? err : new BridgeDisconnectedError(err.message, true);
}

/** A retry's failure for a command whose first attempt was written: never "not sent". */
function asSentFailure(err: unknown): unknown {
  if (err instanceof BridgeDisconnectedError) return asSentDisconnect(err);
  if (err instanceof BridgeConnectPendingError) return new Error(err.message);
  return err;
}

/** Resolves when a child stream has ended; at once for a stream that was never opened. */
function streamEnded(stream: NodeJS.ReadableStream | null | undefined): Promise<void> {
  if (!stream) return Promise.resolve();
  return new Promise((resolve) => {
    stream.once('end', () => resolve());
    // A stream destroyed without ending emits only 'close'.
    stream.once('close', () => resolve());
  });
}

/** The last `count` retained stderr lines of a process, or none when there is no process. */
function recentErrorLines(proc: GodotProcess | null, count: number): string[] {
  if (!proc) return [];
  return proc.errors.slice(-count).filter((line) => line.trim() !== '');
}

/** The stderr lines a process retained after `marker` (a `totalErrorsWritten` reading). */
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

  /**
   * Runs starts, switches and bridge commands one at a time. An MCP client
   * may issue tool calls in parallel; the socket carries one command, and a
   * start spans several awaits.
   *
   * A stop does not wait here. `stop_project`, server shutdown
   * (`stopAllSessions`) and the process exit handlers act at once, whatever
   * holds the queue: a batch of input or a wedged script can hold it for
   * minutes, and the game has to be stoppable meanwhile. What keeps the
   * interrupted operation from acting on a session that is gone is on the
   * record: `stopped`, the per-record epoch, and the record's place in the
   * map (see `stopSession`).
   */
  private readonly queue = new SessionQueue();
  /** Every record this runner built, so a `SessionRef` handed back is known to be one. */
  private readonly knownSessions = new WeakSet<object>();
  /** What a spawned game connects to so it can tell when this server is gone. */
  private readonly parentWatch = new ParentWatchListener();
  /**
   * Headless children that have not reported `close`. They lead their own
   * process group outside Windows, so the terminal does not signal them with
   * the server; the exit hook kills what is left here.
   */
  private readonly headlessChildren = new Set<ChildProcess>();
  /**
   * Spawned games that have not reported `exit`. A game whose kill was not
   * confirmed leaves the session map, so the exit hook kills from here too.
   */
  private readonly spawnedGames = new Set<ChildProcess>();
  /**
   * Set by `stopAllSessions`, which runs once, as the server shuts down. A
   * start checks it after each await that comes before its record exists: in
   * that stretch a shutdown finds no record to stop, and this is how the
   * start learns that it must not go on to spawn a game after the server
   * stopped everything.
   */
  private shuttingDown = false;
  /**
   * Movie runs in flight per project ({@link sessionKey}), counted because
   * two may run on one project. A start on a project named here is refused:
   * it would inject the bridge under a Godot that is rendering the project.
   */
  private readonly movieRuns = new Map<string, number>();
  /** The asset import in flight per project ({@link sessionKey}); a second caller joins it. */
  private readonly importsInFlight = new Map<string, Promise<void>>();
  /** Why the `--version` probe of a path failed, for the paths it failed on. */
  private readonly probeFailures = new Map<string, string>();

  private socket: net.Socket | null = null;
  /**
   * The session the open bridge socket was dialed for. There is one socket,
   * and it follows the session a command is sent to: `sendCommandTo` closes a
   * socket that belongs to a different session before dialing.
   */
  private socketSession: RuntimeSession | null = null;
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

  /**
   * Run one headless Godot to completion and collect its output.
   *
   * On timeout the whole process tree is killed, because the executable may
   * be a wrapper whose child is the engine, and the rejection is held until
   * the child reports `close` or HEADLESS_KILL_CONFIRM_TIMEOUT_MS passes. The
   * error says which: until the exit is confirmed the engine may still be
   * running and may still write to the project.
   *
   * `extraEnv` is added to this process's environment for the child. The
   * spawn options themselves still come from `godotSpawnOptions`.
   */
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
          // Nothing was left to kill, so there is no exit to wait for.
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
        // A sequence the stream ended in the middle of comes out here.
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

  /** ` Its --version probe failed: <why>.` for a path whose probe failed, else ''. */
  private probeFailureNote(path: string): string {
    const reason = this.probeFailures.get(path);
    return reason === undefined ? '' : ` Its --version probe failed: ${reason}.`;
  }

  /**
   * The error for a call that has no Godot executable to run, carrying why
   * each probed path was turned down (exit code, signal, timeout, stderr
   * tail): without it a probe that failed for a passing reason reads the same
   * as a path that was never there.
   */
  private noGodotPathError(): Error {
    const reasons = [...this.probeFailures].map(([path, reason]) => `"${path}": ${reason}`);
    return new Error(
      reasons.length === 0
        ? 'Could not find a valid Godot executable path'
        : `Could not find a valid Godot executable path. Probed ${reasons.join('; ')}`,
    );
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
   *
   * The registry read removes the owner files of sessions whose process is
   * gone. With `registryRead` `'read-only'` it removes nothing and gives the
   * same answer (`BridgeManager.peekOtherLiveOwners`).
   */
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

    // Again after the await above: a shutdown that began during the probe
    // has already stopped waiting for the headless runs it could see.
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

    // Drawn per run and echoed by the script in its result line, so a line a
    // project script prints with the sentinel is not taken for the result.
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

    // If the process produced no operation output but has errors, initialization
    // failed before the script ran. Autoload errors are the most common cause.
    // The engine banner is on stdout, so "stdout is not empty" is true for every
    // run. The script's own first line is the evidence that dispatch started.
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
  importAssets(projectPath: string, timeoutMs: number = IMPORT_TIMEOUT_MS): Promise<void> {
    // One import per project at a time. A second caller joins the one in
    // flight (and its timeout): two engines importing one project are two
    // writers of the same .godot/ directory, and a caller that gave up
    // waiting (see `runSceneOp`) retries into the import it left running.
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

  /**
   * Refuse a headless run once the server is shutting down. The shutdown
   * waits for the runs it can see and then exits; one started after that
   * would be killed by the exit hook partway through its work.
   */
  private assertHeadlessRunAllowed(what: string): void {
    if (!this.shuttingDown) return;
    throw new Error(
      `The server is shutting down, so ${what} was not started; nothing was changed.`,
    );
  }

  /**
   * Resolve when every headless child has reported `close`, or after
   * `boundMs`, whichever comes first. True when none is left. Kills nothing:
   * the exit hook (`killSpawnedProcessesSync`) kills what outlasts the bound.
   * Called by the server's shutdown after `stopAllSessions`, which is what
   * stops new runs from joining the set.
   */
  async waitForHeadlessChildren(boundMs: number = HEADLESS_SHUTDOWN_WAIT_MS): Promise<boolean> {
    const pending = [...this.headlessChildren];
    if (pending.length === 0) return true;
    // A failed spawn reports 'error' and no 'close'; either takes the child
    // out of the set, and the set is what the answer is read from.
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

  /**
   * Record that a `render_movie` run is using a project, and return the
   * function that ends the record. Until it is called, a start on the project
   * is refused (`assertNoMovieRun`). The caller registers with the session
   * queue held and before it spawns, so no start can run between its own
   * session check and the registration, and ends the record when the movie
   * child reports `close`, not when its own call returns: a child that
   * outlived its timeout kill is still rendering the project.
   *
   * This server's process only. Another server process does not see the
   * record, and a movie run registers no bridge owner for it to find.
   */
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

  /**
   * Refuse a start on a project a movie run is using. First phase of both
   * starts: nothing has been stopped, written or spawned.
   */
  private assertNoMovieRun(key: string, projectPath: string): void {
    if (!this.movieRuns.has(key)) return;
    throw new Error(
      `A render_movie run is using this project (${projectPath}); wait for it to return, then retry. Nothing was stopped or launched: the movie process would load the bridge this start injects.`,
    );
  }

  /**
   * Run `operation` with the session queue held: no other session transition
   * and no other bridge command runs until it returns. For a tool handler
   * whose gate and command, or whose start, wait and teardown, have to be one
   * step. The runner's own queued methods called from inside it run at once.
   * `label` is what a caller made to wait is told it waited behind, so pass
   * the tool name.
   *
   * @throws {SessionQueueTimeoutError} when the turn did not come in time.
   */
  runExclusive<T>(label: string, operation: () => Promise<T>): Promise<T> {
    return this.queue.run(label, operation);
  }

  /**
   * How the operation the caller is inside got its turn in the session queue
   * (how long it waited, and behind what), or null when the caller is not
   * inside one. A command about to be sent charges that wait against its own
   * budget with it.
   */
  queueTurn(): QueueTurn | null {
    return this.queue.turn();
  }

  /**
   * Start a spawned session on a project and make it current. Returns a
   * reference to the new record; the bridge is not ready yet (`waitForBridge`).
   *
   * Ordered so that a start that cannot happen costs nothing: every check
   * that can refuse and needs no teardown runs first (display, port, debugger
   * listener, the inject precheck), and only then is the session this start
   * replaces stopped. A refusal in the first phase leaves that session
   * running and current.
   */
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

    // Resolve relative paths (e.g. ".") to absolute against the server's cwd.
    // The bridge reports an absolute project_path in its pong, so a relative
    // expectedPath makes pollBridge's path guard fail immediately and mask
    // the real reason as a generic bridge timeout.
    projectPath = resolve(projectPath);
    const key = sessionKey(projectPath);

    // Phase 1: preconditions. Nothing is stopped, written or spawned here, so
    // a failure leaves the project's existing session exactly as it was.
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

    // Phase 2: stop the session this start replaces. Only a session on this
    // same project is replaced; sessions on other projects keep running.
    const previous = await this.previousAfterPendingStop(key);
    let replacedAttached: ReplacedAttachedSession | null = null;
    const startWarnings: string[] = [];
    if (previous !== null) {
      this.beginSessionTransition(previous);
      this.closeProfiler(previous);
      this.releaseSocketOf(previous);
      if (previous.mode === 'spawned' && previous.process) {
        logDebug('Stopping the existing Godot process before starting a new one');
        // Waited for, and escalated: the old game holds its bridge port until
        // it has exited, and a new one given the same explicit port could not
        // bind it.
        const stopped = await this.stopTrackedProcess(previous.process);
        if (!stopped.confirmed) {
          startWarnings.push(
            `The game this start replaced (pid ${stopped.pid ?? 'unknown'}) was sent a kill and did not report its exit, so it may still be running and may still hold its bridge port.`,
          );
        }
      } else if (previous.mode === 'attached') {
        // The Godot the user launched keeps running, and until its bridge is
        // told to shut down it keeps listening with the old session's token.
        // Same bounded request stop_project makes; whether it was answered is
        // kept for run_project to report.
        replacedAttached = {
          bridgePort: previous.bridgePort,
          shutdownAcknowledged: await this.shutdownAttachedBridge(previous),
        };
      }
      // The stop was awaited, and a stop_project or a server shutdown does
      // not wait for this start: either may have taken the record meanwhile.
      // A stop still in progress owns the project's bridge artifacts until it
      // has removed them, so a record registered now would lose them to it.
      if (previous.stopping !== null || this.sessions.get(key) !== previous) {
        profiler?.close();
        throw new Error(
          `The session on ${projectPath} was stopped while this start was replacing it; nothing was launched.`,
        );
      }
      // No bridge cleanup for the same path: the replacement re-injects over
      // the same owner file.
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
      // The token is set before the port: a record with a port can be dialed,
      // and a frame sent to it must never go out without the token.
      const sessionToken = randomBytes(16).toString('hex');
      session.token = sessionToken;
      session.bridgePort = port;

      // Any failure here fails the start. A game spawned without the bridge
      // could only time out half a minute later, with the cause (a read-only
      // project.godot, a script that could not be written) long gone from
      // view. The catch below removes whatever a partial inject left.
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
          // Delivers this session's resolved port without baking it into the
          // shared script — see BridgeManager: spawned sessions never bake,
          // so the on-disk script stays identical for every spawned session
          // regardless of who wrote it.
          MCP_BRIDGE_PORT: String(port),
          // Spawned sessions only: the game quits when this server is gone.
          // An attached Godot is the user's process and never gets one.
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

      // One decoder per stream: a pipe chunk can end inside a UTF-8 sequence.
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
        // Through ingestStderrChunk, not a bare errors.push: it is the only
        // writer of `errors` and `totalErrorsWritten`, and every sentinel `seq`
        // and `getErrorsSince` window is computed from the two staying in step.
        // One uncounted push shifts every later window by a line.
        this.ingestStderrChunk(godotProcess, `Process error: ${err.message}\n`);
        godotProcess.hasExited = true;
        // No pid: the spawn itself failed, so there is nothing to kill later.
        if (proc.pid === undefined) this.spawnedGames.delete(proc);
        // The engine will never dial back, so nothing can arrive on the debugger
        // listener. Holding the port open until the next run_project is pointless.
        this.closeProfiler(session);
      });

      session.process = godotProcess;
      return session;
    } catch (err) {
      // Nothing is running for this record: drop it, release the debugger
      // listener, and remove whatever bridge artifacts the start (or the
      // session it replaced) left on the project.
      const heldCurrent = this.current === session;
      this.appendCleanupProblems(err, this.discardFailedStart(session, true));
      if (!processSpawned && heldCurrent) this.restoreCurrentAfterFailedStart(previousCurrent);
      throw err;
    }
  }

  /**
   * Refuse to go on with a start that a server shutdown overtook during one
   * of the start's awaits. Every await of a start comes before its record is
   * registered, so a shutdown landing there finds nothing to stop; going on
   * would inject a bridge and spawn a game after the server stopped
   * everything. From the record's creation to the spawn a start does not
   * await, so nothing can land in between.
   */
  private assertNotShuttingDown(projectPath: string): void {
    if (!this.shuttingDown) return;
    throw new Error(
      `The server is shutting down, so the session on ${projectPath} was not started; nothing was launched.`,
    );
  }

  /**
   * Refuse an explicit bridge port that a live session on another project
   * holds: the new game could not bind it, and its bridge wait would only
   * reach the other session's bridge. A session on this same project is
   * exempt, because the start stops it first.
   */
  private assertBridgePortNotHeld(bridgePort: number | undefined, key: string): void {
    if (bridgePort === undefined) return;
    for (const other of this.sessions.values()) {
      if (other.key === key || other.bridgePort !== bridgePort || !isSessionLive(other)) continue;
      throw new Error(
        `Bridge port ${bridgePort} is already held by this server's live session on ${other.projectPath}. Nothing was stopped or launched: pass a different bridgePort, omit it to get a free port, or stop that session first.`,
      );
    }
  }

  /**
   * Refuse a start that has too little of its request's time left to wait
   * for the bridge (see `startBridgeWaitDeadline`). Called in the first
   * phase, before the session the start replaces is touched, with the stop of
   * that session reserved: it is spent before the wait begins.
   *
   * @throws {StartBudgetExhaustedError}
   */
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

  /**
   * The record a start on this project would replace, once any stop already
   * running on it has finished. A stop does not wait in the queue, so a start
   * can find the project's record half stopped; replacing it then would race
   * the stop's own removal of the bridge artifacts.
   */
  private async previousAfterPendingStop(key: string): Promise<RuntimeSession | null> {
    const found = this.sessions.get(key) ?? null;
    if (found === null || found.stopping === null) return found;
    await found.stopping.catch(() => undefined);
    return this.sessions.get(key) ?? null;
  }

  /**
   * Port of the parent-watch listener for a spawned game, or null when it
   * could not be bound. Not fatal: the game then runs without the watchdog,
   * as every game did before it existed.
   */
  private async parentWatchPort(): Promise<number | null> {
    try {
      return await this.parentWatch.port();
    } catch (err) {
      logDebug(`Non-fatal: the parent-watch listener could not be bound: ${err}`);
      return null;
    }
  }

  /**
   * Stop a tracked game process and observe that it stopped.
   *
   * The polite stop first, then BRIDGE_PROCESS_EXIT_TIMEOUT_MS for the `exit`
   * event, then the forced tree kill and SESSION_KILL_CONFIRM_TIMEOUT_MS more.
   * `confirmed` is true when the exit was observed, or when the operating
   * system said there was no such process left to kill. It is false when a
   * kill was sent and nothing came back: the process may still be running.
   * A process with no pid never started and needs no wait. Never throws.
   */
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
    // "No such process" is not an unconfirmed kill: there was nothing to kill.
    if (first === 'not-running') return { confirmed: true, pid };
    const forced = this.forceKillProcessTree(proc);
    if (tracked.hasExited || forced === 'not-running') return { confirmed: true, pid };
    const exited = await waitForProcessEvent(proc, 'exit', SESSION_KILL_CONFIRM_TIMEOUT_MS);
    return { confirmed: exited || tracked.hasExited, pid };
  }

  /**
   * Give the current pointer back to the session that held it before a start
   * that launched nothing. Such a start took the pointer and then failed
   * without anything to show for it (the bridge could not be written into
   * the project), so leaving the pointer empty would be the call moving it by
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
   * clear the session that replaced it. Asking "does this project still have
   * a session" is not enough: the superseded game's exit usually arrives
   * after the replacement registered its record and injected its bridge, and
   * a handler that answered yes would clean that freshly injected script. A single
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

  /**
   * Point `current` at a session, or at nothing. Only the socket of the
   * session losing the pointer is closed: a command in flight to any other
   * session (an attach probe, a start's bridge wait) keeps its channel.
   */
  private setCurrent(session: RuntimeSession | null): void {
    if (this.current === session) return;
    const losing = this.current;
    this.current = session;
    if (losing !== null) this.releaseSocketOf(losing);
  }

  /**
   * Drop a session record. Leaves `current` empty when it pointed here; no
   * other session is promoted in its place.
   */
  private forgetSession(session: RuntimeSession): void {
    if (this.sessions.get(session.key) === session) this.sessions.delete(session.key);
    if (this.current === session) this.setCurrent(null);
    this.releaseSocketOf(session);
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
   * Session keys fold case and separators, so a start can replace a record
   * whose stored path is spelled differently. When the two spellings are the
   * same directory this costs one redundant cleanup before the re-inject; on a
   * case-sensitive filesystem they can be two directories, and the replaced
   * one would otherwise keep its bridge artifacts with no record left to
   * remove them.
   *
   * Returns what that cleanup could not confirm, as sentences for the new
   * session's `startWarnings`: the replaced record is gone, so no later stop
   * can report it.
   */
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
    // The socket to a dead peer is garbage. Only this session's: an exit on
    // another project must not cut the channel of the command in flight.
    this.releaseSocketOf(session);
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

  /**
   * Synchronous, never-throwing bridge artifact removal for every session
   * that still holds artifacts. `BridgeManager.cleanup` is pure synchronous
   * `fs`, so this is safe from a `process.on('exit')` handler, where promises
   * never settle. One guard per session, so a cleanup that throws on one
   * project does not cost the others theirs. A session whose mode is null was
   * already cleaned by its own exit handler.
   *
   * No helper program is run from here either: `cleanupAtExit` judges another
   * owner by what is already known about it, because a program started from
   * an exit handler holds the exit up for as long as it runs.
   *
   * Production call site: the `'exit'` handler registered by
   * `registerProcessLifecycle` in `src/index.ts`.
   */
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

  /**
   * Force a process and its children down. Never throws. A process with no
   * pid never started, so there is no tree to walk and `kill` is a no-op.
   */
  private forceKillProcessTree(proc: ChildProcess): KillOutcome {
    return killProcessTree(proc, this.killTreeDeps);
  }

  /**
   * Synchronous, never-throwing kill of every spawned game still running, for
   * the `process.on('exit')` handler. A graceful shutdown has already stopped
   * every session by then; this is for the exits that skip it (a stop that
   * threw, an uncaught error), where the games would otherwise outlive the
   * server with nothing left to stop them, and for a game whose stop sent a
   * kill that was never confirmed. Attached sessions are not this server's
   * processes and are left running. The bridge `shutdown` command is
   * not sent: there is no event loop left to send it on.
   *
   * Headless children still running are killed here as well. Outside Windows
   * both kinds lead their own process group, so the signal the terminal sends
   * the server does not reach them.
   */
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

  /**
   * Attach to a project whose Godot the caller launches: inject the bridge
   * with a baked port and token and make the session current. The bridge is
   * not ready yet (`waitForBridgeAttached`).
   *
   * When this server already holds a live attached session on the project,
   * that session is kept and returned with `alreadyAttached` unless its
   * bridge is seen to be gone. A fresh attach would bake a new token the
   * running Godot never reads, wait out the readiness budget, and then remove
   * the bridge from under a game that was working.
   *
   * Ordered like `runProject`: the port and the inject precheck (attach
   * conflict, name collision, registry) come before the session this attach
   * replaces is stopped.
   */
  attachProject(projectPath: string, bridgePort?: number): Promise<AttachResult> {
    return this.queue.run('run_project (attach)', () =>
      this.startAttached(projectPath, bridgePort),
    );
  }

  private async startAttached(projectPath: string, bridgePort?: number): Promise<AttachResult> {
    // Resolve relative paths for the same reason as runProject — pollBridge
    // compares against the absolute path the bridge reports.
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

    // Phase 1: preconditions. Nothing is stopped or written here.
    this.assertBridgePortNotHeld(bridgePort, key);
    this.assertNoMovieRun(key, projectPath);
    const port = bridgePort ?? (await findFreePort());
    this.assertNotShuttingDown(projectPath);
    this.bridge.precheckInject(projectPath, true);
    this.assertStartBudget('attached', key);

    // Phase 2: the session this attach replaces. Only one on this same
    // project; a session on another project, spawned or attached, is left as
    // it is.
    const previous = await this.previousAfterPendingStop(key);
    const startWarnings: string[] = [];
    if (previous !== null) {
      if (previous.mode === 'spawned' && previous.process) {
        await this.stopSession(previous);
        // The stop was awaited. A record registered on this project meanwhile
        // is not this attach's to replace.
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

    // Phase 3: the new record and its bridge.
    const session = this.createSession(projectPath, 'attached');
    session.startWarnings = startWarnings;
    const previousCurrent = this.current;
    this.sessions.set(key, session);
    this.setCurrent(session);

    try {
      // Attach has no env channel to a Godot process the user launched
      // themselves, so the baked script copy is the only way to deliver the
      // auth token. Set before the port, so the record never has a port to
      // dial without the token every frame must carry.
      const token = randomBytes(16).toString('hex');
      session.token = token;
      session.bridgePort = port;
      this.bridge.inject(projectPath, port, token);
      const portSource = bridgePort !== undefined ? 'explicit' : 'auto';
      logDebug(`Attaching to Godot project: ${projectPath} (bridge port ${port}, ${portSource})`);
      return { session, alreadyAttached: false };
    } catch (err) {
      // inject writes its owner file and the baked script before it touches
      // .gitignore and project.godot, so one that throws there has left a
      // live owner claim on the project. The cleanup withdraws it, and what
      // the session this attach replaced had left there with it.
      const heldCurrent = this.current === session;
      this.appendCleanupProblems(err, this.discardFailedStart(session, true));
      // An attach never spawns, so a failure here always launched nothing.
      if (heldCurrent) this.restoreCurrentAfterFailedStart(previousCurrent);
      throw err;
    }
  }

  /**
   * One ping to an attached session's bridge, to decide whether a repeated
   * attach keeps the session. Never throws.
   *
   * `gone` means nothing listens on the port, or the peer closed (see
   * `probeFailureMeansGone`, the rule `sendCommandWithReconnect` shares). A
   * ping that a connected peer left unanswered is a game that is alive and
   * busy for a second (loading, paused in a long frame), and replacing its
   * session would bake a token it never reads and then remove its bridge.
   */
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

  /**
   * Whether a failed probe ping shows the bridge to be gone. A disconnect
   * does. A ping that timed out with its connect still pending shows nothing
   * yet, so that connect's own outcome is waited for, up to
   * BRIDGE_CONNECT_OUTCOME_WAIT_MS: refused is gone, connected or still
   * pending is a peer that may be alive. Never throws.
   */
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

  /**
   * Stop the current session, now. Leaves `current` empty afterwards: a
   * session on another project is never promoted in its place.
   *
   * Does not wait in the session queue. Whatever holds it (an input batch
   * with minutes of waits, a script that never returns, a start waiting for
   * its bridge) is cut off: its command in flight is rejected with
   * `SessionStoppedError`, and so is every command it or a caller queued
   * behind it sends to this record afterwards.
   */
  stopProject(): Promise<RuntimeStopResult | null> {
    const session = this.current;
    if (!session) return Promise.resolve(null);
    return this.stopSession(session);
  }

  /** The record behind a reference this runner handed out. */
  private recordOf(ref: SessionRef): RuntimeSession {
    if (!this.knownSessions.has(ref)) {
      throw new Error('Not a session reference from this runner');
    }
    return ref as RuntimeSession;
  }

  /**
   * Snapshot of the record a reference names, whether or not it is still
   * registered or current. `current` is false once another record has taken
   * the pointer.
   */
  describeSessionRef(ref: SessionRef): RuntimeSessionInfo {
    return this.describeSession(this.recordOf(ref));
  }

  /**
   * `DebuggerProfiler.streamProblem` for the record a reference names: null
   * when it has no profiler, nothing has arrived yet, or the stream reads.
   */
  profilerStreamProblemFor(ref: SessionRef): string | null {
    return this.recordOf(ref).profiler?.streamProblem ?? null;
  }

  /** `getRecentErrors` for the record a reference names. */
  recentErrorsFor(ref: SessionRef, count: number = RECENT_ERROR_LINES_DEFAULT): string[] {
    return recentErrorLines(this.recordOf(ref).process, count);
  }

  /**
   * Stop the session a reference names, current or not. Null, stopping
   * nothing, when that record is no longer the one registered for its
   * project: it was already stopped, or another start replaced it, and the
   * project's bridge artifacts are not this record's to remove any more.
   */
  stopSessionRef(ref: SessionRef): Promise<RuntimeStopResult | null> {
    const session = this.recordOf(ref);
    if (this.sessions.get(session.key) !== session) return Promise.resolve(null);
    return this.stopSession(session);
  }

  /**
   * Ask a session's bridge to shut down, on a connection of its own, and say
   * whether it acknowledged. Never throws, and bounded by `timeoutMs`.
   *
   * Not sent over the command socket: a stop does not wait for the command
   * that socket may be carrying, and must neither be refused because of it
   * nor be mistaken for its reply.
   */
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

  /**
   * Ask an attached session's bridge to shut down, so the user's
   * still-running Godot releases the port. Bounded by
   * BRIDGE_SHUTDOWN_ATTACHED_TIMEOUT_MS and never throws: a bridge that does
   * not answer does not stop the detach, it dies when the user closes Godot.
   * Returns whether it acknowledged, read from the reply, because until it
   * does the bridge is still listening with that session's token.
   */
  private shutdownAttachedBridge(session: RuntimeSession): Promise<boolean> {
    // The command socket to this session, if it is open, goes first: the
    // session is ending and nothing more is sent over it.
    this.releaseSocketOf(session);
    return this.requestBridgeShutdown(
      session.bridgePort,
      session.token,
      BRIDGE_SHUTDOWN_ATTACHED_TIMEOUT_MS,
    );
  }

  /**
   * Close the command socket when it belongs to `session`, rejecting the
   * command in flight to that session with `reason` (a disconnect when
   * omitted). A socket or a command that belongs to another session is left
   * alone.
   */
  private releaseSocketOf(session: RuntimeSession, reason?: Error): void {
    if (this.socketSession === session || this.inFlight?.target === session) {
      this.closeConnection(reason);
    }
  }

  /** Forget the command socket. `socket` and `socketSession` only ever change together. */
  private dropSocketReference(): void {
    this.socket = null;
    this.socketSession = null;
  }

  /**
   * Stop one session. The single entry to a stop: `stop_project`, the
   * teardown of a start that did not come up, an attach replacing a spawned
   * session, and server shutdown.
   *
   * Runs at once, whatever holds the session queue. Its first statements are
   * synchronous and are what make that safe: the epoch moves, so the exit
   * handler of the game about to be killed is inert; `stopped` is set, so no
   * command reaches this record again; and the command in flight to it is
   * rejected with `SessionStoppedError`, which no caller retries. The
   * operation that was cut off holds a record that can do nothing further.
   *
   * A second stop of a record already being stopped shares the first one's
   * outcome.
   */
  private stopSession(session: RuntimeSession): Promise<RuntimeStopResult | null> {
    if (session.stopping !== null) return session.stopping;
    const stopping = this.performStop(session).finally(() => {
      if (session.stopping === stopping) session.stopping = null;
    });
    session.stopping = stopping;
    return stopping;
  }

  /**
   * Remove a stopped session's bridge artifacts, unless another record has
   * taken the project since. That record shares the owner file, so the
   * artifacts are its to remove now.
   */
  private cleanupStoppedSession(session: RuntimeSession): string[] {
    const registered = this.sessions.get(session.key);
    if (registered !== undefined && registered !== session) return [];
    return this.bridge.cleanup(session.projectPath);
  }

  /** Forget a stopped record and leave nothing on it that could be dialed. */
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
      const cleanupProblems = this.cleanupStoppedSession(session);
      this.retireSession(session);
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
      // A spawned record with no process. A start registers its record,
      // injects and spawns without awaiting, so no stop can observe this
      // state in passing; it is handled so that a record left this way is
      // still released. There is nothing to kill, but the record may have
      // injected: a record gets its port in the statement before inject is
      // called, so one with a port has its bridge artifacts removed here, and
      // one with no port yet has injected nothing and is left alone.
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

    // Spawned: try graceful shutdown so the bridge releases the port,
    // then ensure the process actually exits.
    await this.requestBridgeShutdown(
      session.bridgePort,
      session.token,
      BRIDGE_SHUTDOWN_SPAWNED_TIMEOUT_MS,
    );
    this.closeProfiler(session);

    logDebug('Stopping Godot process');
    // The pid may be a wrapper (the Windows *_console.exe, a launcher), so the
    // kill takes the tree: killing the wrapper alone would report a stop while
    // the real game keeps running and holding the bridge port.
    const stopped = await this.stopTrackedProcess(tracked);
    // A process can exit a moment before its pipes have delivered their last
    // bytes. Flushing the line assemblers now would hand back the front of a
    // line as a whole line and its rest as a second one, so a confirmed exit
    // waits for both streams to end; their `end` handlers flush. When the
    // exit was not confirmed the streams may never end, and what is held is
    // flushed as it stands.
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

  /**
   * Stop every session, for server shutdown. Bounded: each stop spends at
   * most SPAWNED_STOP_WORST_CASE_MS or ATTACHED_STOP_WORST_CASE_MS. One
   * session failing to stop does not keep the others running.
   *
   * Does not wait in the queue, as no stop does: the client is gone, and a
   * start parked in a 45 s bridge wait must not hold the shutdown up. Terminal:
   * a start that has no record yet learns of it from `shuttingDown`, and no
   * start is accepted afterwards.
   */
  async stopAllSessions(): Promise<void> {
    this.shuttingDown = true;
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
    // Moving the pointer closes the socket, which would reject a command
    // another call has in flight. `switch_project` holds the queue around
    // this; a caller that does not must find it free.
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
   * The socket carries one command at a time, so the send waits its turn in
   * the session queue: a client may issue tool calls in parallel. The
   * socket is lazy-connected on first call and persists across commands until
   * `closeConnection` (or a peer-side close). A close mid-flight rejects with
   * `BridgeDisconnectedError`. A per-command timeout rejects with a plain
   * `Error` and destroys the socket, so a late response cannot be read as the
   * answer to the next command; it does not end the session, and the next
   * command reconnects.
   *
   * Always addresses the session that is current when the command's turn
   * comes. With none, or with one that has no bridge port left, nothing is
   * dialed and the call rejects with `BridgeDisconnectedError`.
   *
   * @throws {SessionQueueTimeoutError} when the turn did not come in time.
   */
  sendCommand(
    command: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = BRIDGE_COMMAND_DEFAULT_TIMEOUT_MS,
  ): Promise<string> {
    return this.queue.run(`bridge command '${command}'`, () =>
      this.sendCommandTo(this.current, command, params, timeoutMs),
    );
  }

  /**
   * `sendCommand` against a named session. There is one socket: when the open
   * one was dialed for a different session it is closed first, and this
   * command dials the target's port and carries the target's token. Not
   * queued: every caller already holds the queue. A second command while one
   * is in flight cannot happen while that holds, so it is checked as an
   * invariant and rejected, never interleaved. Teardown does not come through
   * here (`requestBridgeShutdown`).
   *
   * A record that was stopped is never dialed: the caller is an operation the
   * stop cut off, or one that was queued behind it.
   */
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

      // A session with no bridge port has nothing to dial: it never started,
      // or its process exited and the port went with it. Dialing a default
      // port instead could reach some other Godot that happens to listen
      // there, with a frame that carries no token.
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
        // Destroy the socket on timeout. The bridge serializes commands
        // (peer.handling gate), so a slow command's late response would
        // otherwise correlate against the next command we send. The next
        // sendCommand lazy-reconnects.
        if (this.socket) this.discardSocket(this.socket);
        this.resetRxBuffer();
        const message = `Command '${command}' timed out after ${timeoutMs}ms. Is the game running?`;
        // A connect still pending is not a peer that failed to answer.
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

  /**
   * Tear down the bridge socket. Idempotent. Any in-flight command is
   * rejected with `reason`: by default a disconnect, which is what the
   * callers that drop a socket to reconnect mean; a stop passes
   * `SessionStoppedError`.
   */
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
    if (this.socket === sock) this.dropSocketReference();
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
    return errorsSince(this.activeProcess, marker);
  }

  /**
   * Fold one decoded stderr chunk into a spawned session's buffers. With
   * `finishStderr`, the only writer of `GodotProcess.errors` and
   * `totalErrorsWritten`.
   *
   * Action-boundary sentinels are recorded as marks and never retained, so
   * every reader of `errors` - `get_debug_output`, `stop_project`'s
   * `finalErrors`, `getErrorsSince`, `getRecentErrors` - is clean without a
   * per-read filter. `totalErrorsWritten` counts retained lines only, which
   * keeps the delta arithmetic in `getErrorsSince` correct and makes each
   * mark's `seq` survive the ring trim below.
   *
   * Public only so unit tests can drive ingestion without spawning Godot; the
   * production caller is the session stderr handler in `startSpawned`.
   *
   * Only complete lines are classified and retained. A `'data'` event
   * boundary can land anywhere, so the text after a chunk's last newline is
   * held in `proc.stderrLines` until the chunk that ends it, or until the
   * stream ends (`finishStderr`). Deciding on a tail at once reads the front
   * of a line as the whole of it: `MCP_ACTION_BOUNDARY 1` followed by `2\n`
   * in the next chunk is boundary 12, not boundary 1 and a stray line `2`.
   * The held text is capped (see `LineAssembler`), so a stream that never
   * sends a newline costs a bounded amount per chunk.
   *
   * A retained line has no terminator left on it (the `\r` Windows writes
   * before the `\n` is removed with it) and is never blank. `errors` and
   * `totalErrorsWritten` only ever grow here, apart from the ring trim, which
   * removes from the front and leaves every recorded `seq` meaningful.
   */
  ingestStderrChunk(proc: GodotProcess, text: string): void {
    if (text === '') return;
    proc.stderrLines ??= new LineAssembler();
    for (const line of proc.stderrLines.push(text)) this.retainStderrLine(proc, line);
    this.trimStderrRing(proc);
  }

  /**
   * The stderr stream ended: the text it stopped in the middle of is the last
   * line. Also called when a stop hands the logs back before the stream has
   * reported its end.
   */
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

  /**
   * Fold one decoded stdout chunk into a spawned session's `output` buffer,
   * under the same line rules as {@link ingestStderrChunk}: complete lines
   * only, no terminator left on a line, no blank lines. With `finishStdout`,
   * the only writer of `GodotProcess.output`.
   */
  ingestStdoutChunk(proc: GodotProcess, text: string): void {
    if (text === '') return;
    proc.stdoutLines ??= new LineAssembler();
    for (const line of proc.stdoutLines.push(text)) this.retainStdoutLine(proc, line);
  }

  /** As {@link finishStderr}, for stdout. */
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

  /**
   * The same delta window as {@link getErrorsSince}, without its blank-line
   * filter and with the sequence number of the first line. Per-action error
   * attribution needs line positions that line up with the recorded boundary
   * marks, which dropping blanks would shift. `getErrorsSince` itself is
   * deliberately untouched so every existing caller keeps its behavior.
   */
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

  /**
   * Open a per-action error capture ahead of an input batch, on the current
   * session's process. The capture keeps that process, so closing it reads
   * the same stderr whatever is current by then. Clearing the boundary list
   * here bounds it to one batch: only the input path consumes boundaries and
   * the session queue runs one batch at a time, so no cap is needed.
   */
  beginActionErrorCapture(): ActionErrorCapture {
    const proc = this.activeProcess;
    if (proc) proc.actionBoundaries = [];
    return { marker: proc?.totalErrorsWritten ?? 0, proc };
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

  // Only the explicit `SCRIPT ERROR:` / `USER SCRIPT ERROR:` markers belong here — the looser
  // `GDScript error` substring also matches user printerr output and produces false positives.
  private static readonly SCRIPT_ERROR_PATTERNS = ['SCRIPT ERROR:', 'USER SCRIPT ERROR:'];
  private static readonly RETRYABLE_BRIDGE_COMMANDS = new Set(['get_ui_elements', 'screenshot']);
  /**
   * Commands exempt from the attached-mode disconnect probe. A `ping` is
   * already the question the probe asks: `check_project` and `switch_project`
   * ping through `sendCommandWithErrors`, and an unanswered status ping must
   * report the bridge as unresponsive without ending the session, and must
   * not recurse into a second ping. Teardown needs no entry: a `shutdown`
   * goes over a connection of its own and never through the reconnect wrapper.
   */
  private static readonly DISCONNECT_EXEMPT_BRIDGE_COMMANDS = new Set(['ping']);

  extractRuntimeErrors(lines: string[]): string[] {
    return lines.filter((line) => GodotRunner.SCRIPT_ERROR_PATTERNS.some((p) => line.includes(p)));
  }

  /**
   * `sendCommand` plus the transient-drop retry and, in attached mode, the
   * disconnect-means-session-end probe.
   *
   * WIDEST INPUT of the disconnect predicate: `BridgeDisconnectedError` has
   * seven producers in `sendCommandTo` — no bridge port, connect failure,
   * socket unavailable, oversized frame header, framing parse error, socket
   * `'error'`, peer `'close'` — and an eighth in `closeConnection`'s
   * in-flight rejection. A per-command
   * timeout is a plain `Error` and never reaches here, so a wedged-but-alive
   * game is not mistaken for a dead one, and neither does a
   * `SessionStoppedError`: a session that was stopped is not retried, probed
   * or cleared a second time. The chain below narrows that set: spawned
   * sessions keep today's behavior (the exit handler owns them), `ping` is
   * exempt, a retryable command spends its one retry first, and for every
   * survivor a probe `ping` must still show the bridge gone
   * (`probeFailureMeansGone`) before anything is cleared.
   */
  private async sendCommandWithReconnect(
    // The session this command belongs to. The first send, the retry and the
    // probe all go to it, and the disconnect handling judges and, if it comes
    // to that, clears this session, not whichever one is current by the time
    // a delay or a probe has run its course.
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
      // Spawned (or already-cleared) session: unchanged behavior.
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

    // Exactly one probe, on the existing ping timeout. A pong means the
    // command failed but the session did not. The session ends here only when
    // the probe shows the bridge gone: nothing listening, or the peer closing.
    // A connected peer that leaves the ping unanswered is a game that is alive
    // and not answering, which is the case a timeout must never be taken for.
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

  /**
   * Send a command to the current session and return its reply with the
   * stderr the game wrote meanwhile. Waits its turn in the session queue.
   *
   * The session is read once, when the turn comes: the send, the retry, the
   * probe and the stderr window all belong to that record, whatever is
   * current by the time the reply arrives.
   *
   * @throws {SessionQueueTimeoutError} when the turn did not come in time.
   */
  sendCommandWithErrors(
    command: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = BRIDGE_COMMAND_DEFAULT_TIMEOUT_MS,
  ): Promise<{ response: string; runtimeErrors: string[]; stderrWindow: string[] }> {
    return this.queue.run(`bridge command '${command}'`, async () => {
      // No current session: reject before any socket is dialed, with the live
      // sessions on the error. Another session is never picked in its place. A
      // current session that is no longer live still sends, as before.
      const session = this.current;
      if (session === null) {
        throw new NoLiveCurrentSessionError(this.getRuntimeSessionStatus());
      }
      const marker = session.process?.totalErrorsWritten ?? 0;
      const response = await this.sendCommandWithReconnect(session, command, params, timeoutMs);
      // Read off the record's retained process rather than its mode: the
      // auto-clear nulls the mode the moment a spawned process exits, but the
      // stderr buffer being classified here lives on that process, which
      // survives. Attached sessions have no process and so still get [].
      const newErrors = errorsSince(session.process, marker);
      const runtimeErrors = session.process !== null ? this.extractRuntimeErrors(newErrors) : [];
      // Unfiltered stderr window (newErrors) for callers that need the full
      // engine output around a failure, e.g. run_script compile diagnostics,
      // where the SCRIPT ERROR line is followed by an "at: <path>:<line>" line
      // that extractRuntimeErrors' per-line filter drops.
      return { response, runtimeErrors, stderrWindow: newErrors };
    });
  }

  /**
   * Shared poll loop for `waitForBridge` (spawned) and `waitForBridgeAttached`.
   * Sends `ping` payloads to one session until its bridge replies with a pong
   * that `validatePong` accepts, the deadline passes, or `shouldAbort` reports
   * the spawned process has exited.
   *
   * Everything is read off the `session` record it was given, never through
   * the current pointer: the wait lasts up to 45 s, and the answer has to be
   * about the session that was started, whatever is current by then.
   */
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
      /**
       * Extended ceiling applied once a TCP connect to the bridge port has
       * succeeded. A connect proves the autoload ran and is listening, so the
       * remaining wait is the engine finishing its own startup - worth far more
       * patience than "nothing is listening yet". Omitted means the single
       * `timeoutMs` ceiling applies throughout.
       */
      extendedTimeoutMs?: number;
      /**
       * `Date.now()` value past which the wait ends whichever ceiling applies
       * (see `startBridgeWaitDeadline`). Omitted means the ceilings alone.
       */
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
    // Consecutive ping failures since the last answered ping, counted only
    // once a TCP connect has been observed. See
    // BRIDGE_CONNECTED_PING_FAILURE_LIMIT.
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

      // Looked for before every ping, and before the exit check: a stop kills
      // the game, and that exit must not be reported as the game's own.
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
        // Answered at all, so the peer is something that speaks the frame
        // protocol. Reset before validating: a reply that is not a valid pong
        // yet is a bridge mid-startup, not a wrong listener.
        connectedPingFailures = 0;
        const parsed = JSON.parse(response);
        // A bridge that refuses this session's token refuses it on every
        // ping: it took its token from another session and reads no new one.
        // Counted as "answered" above, it would otherwise spend the whole
        // budget.
        if (parsed !== null && parsed.error === BRIDGE_UNAUTHORIZED_ERROR) {
          return result({
            ready: false,
            error: `A bridge with a different session token is listening on port ${session.bridgePort ?? 'unknown'}: a Godot left from an earlier session. Close it, then retry.`,
          });
        }
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
              return result({
                ready: false,
                error: `Bridge reports project ${bridgePath}, expected ${opts.expectedPath}`,
              });
            }
          }
          return result({ ready: true });
        }
      } catch (err) {
        // The stop that cut this ping off has ended the session.
        if (err instanceof SessionStoppedError) return result(BRIDGE_WAIT_STOPPED);
        // Expected: ping will fail until bridge is listening. Once a connect
        // has been observed it stops being expected, which is what the counter
        // is for. Refusals from before anything listened are not counted: in
        // the normal attach flow Godot is launched seconds after this wait
        // began, and counting those would spend the whole limit before the
        // listener exists, so its first slow pong would end the wait.
        if (session.bridgeConnectObserved) connectedPingFailures += 1;
      }

      const elapsed = Date.now() - started;
      const interval =
        elapsed < BRIDGE_WAIT_BACKOFF_AFTER_MS ? opts.intervalMs : BRIDGE_WAIT_MAX_INTERVAL_MS;
      // Never slept past the end of the budget: the wait must not outlast it
      // by more than the one ping that may be in flight when it runs out.
      const pause = Math.min(interval, Math.max(0, budget - elapsed));
      await new Promise((resolve) => setTimeout(resolve, pause));
    }

    return result({ ready: false, error: opts.timeoutError });
  }

  /**
   * The deadline of a bridge wait made inside a start's own turn, and the
   * sentence that says so when it is what cut the wait short of `nominalMs`.
   * A wait made outside any turn has no request to answer to and no deadline.
   */
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

  /**
   * Wait for an attached session's bridge. `ref` names the session to wait
   * on; omitted, it is the session that is current when the wait starts.
   * Holds the session queue for the whole wait.
   */
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

  /**
   * Wait for a spawned session's bridge. `ref` names the session to wait on;
   * omitted, it is the session that is current when the wait starts. Holds
   * the session queue for the whole wait.
   */
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
