import {
  CLIENT_REQUEST_TIMEOUT_MS,
  NoLiveCurrentSessionError,
  SessionStoppedError,
  type GodotRunner,
  type RuntimeSessionInfo,
  type RuntimeSessionStatus,
} from './godot-runner.js';
import type { HandlerResult, ToolResponse } from '../mcp.types.js';
import { createErrorResponse, getErrorMessage } from './error-response.js';
import { ok, err, type Result } from './result.js';
import { SessionQueueTimeoutError } from './session-queue.js';

export const SWITCH_PROJECT_SOLUTION =
  'Call switch_project with one of the listed project paths to point the runtime tools at that session';

/** How one tool words the error for "no live current session". */
export interface NoSessionWording {
  /** Completes "... cannot <action>." */
  action: string;
  /** Whole message when nothing is current and no other session is live. */
  noneMessage: string;
  noneSolutions: string[];
  exitedSolutions: string[];
}

export function runtimeToolWording(action: string): NoSessionWording {
  return {
    action,
    noneMessage: `No active runtime session. A project must be running or attached to ${action}.`,
    noneSolutions: [
      'Use run_project to start a Godot project first',
      'Or pass attach: true to run_project before launching Godot yourself',
    ],
    exitedSolutions: [
      'Use get_debug_output to inspect the last captured logs',
      'Call stop_project to clean up, then run_project again',
    ],
  };
}

/** The current pointer names a spawned session whose process is gone. */
export function isExitedCurrent(status: RuntimeSessionStatus): boolean {
  const current = status.current;
  return (
    status.state === 'exited' &&
    current !== null &&
    (current.processExited || current.mode === 'spawned')
  );
}

/** '' when no other session is live; otherwise a sentence with a leading space. */
export function otherLiveSessionsClause(status: RuntimeSessionStatus): string {
  const paths = status.otherLiveSessions.map((info) => info.projectPath);
  if (paths.length === 0) return '';
  return ` Live sessions on other projects, none of which is picked automatically: ${paths.join(', ')}.`;
}

/**
 * The error for a runtime tool that has no live current session. Never picks
 * another session: it lists them and points at switch_project.
 */
export function noLiveCurrentSessionError(
  status: RuntimeSessionStatus,
  wording: NoSessionWording,
): ToolResponse {
  const others = otherLiveSessionsClause(status);
  const switchSolution = others === '' ? [] : [SWITCH_PROJECT_SOLUTION];
  if (isExitedCurrent(status) && status.current !== null) {
    const { projectPath, exitCode } = status.current;
    return createErrorResponse(
      `The spawned Godot process has exited (project ${projectPath}, exit code ${exitCode ?? 'unknown'}) and cannot ${wording.action}.${others}`,
      [...wording.exitedSolutions, ...switchSolution],
    );
  }
  if (others === '') return createErrorResponse(wording.noneMessage, wording.noneSolutions);
  if (status.current !== null) {
    // Current is set but holds neither a live game nor an exited process:
    // what is left of an ended session (a finished profiler capture kept
    // readable after stop_project). "Not pointed at any project" would be
    // false here, and check_project names this project as the current one.
    return createErrorResponse(
      `The current session (project ${status.current.projectPath}) has ended, so this call cannot ${wording.action}.${others}`,
      [...switchSolution, ...wording.noneSolutions],
    );
  }
  return createErrorResponse(
    `No current runtime session: the runtime tools are not pointed at any project, so this call cannot ${wording.action}.${others}`,
    [...switchSolution, ...wording.noneSolutions],
  );
}

/**
 * The error for a call that gave up waiting for its turn in the session
 * queue. Nothing was sent for it, so the only thing to do is try again once
 * the call it names has returned.
 */
export function sessionBusyError(error: SessionQueueTimeoutError): ToolResponse {
  return createErrorResponse(error.message, [
    `Wait for ${error.behind} to return, then retry this call`,
    'A runtime session runs one operation at a time: issue runtime calls one after another, not in parallel',
  ]);
}

/**
 * Run a handler's session work with the session queue held, so its gate and
 * its command, or its start, wait and teardown, are one step that no other
 * runtime call can interleave with. `toolName` is what a call made to wait
 * behind this one is told. A call that could not get its turn in time comes
 * back as a structured error.
 */
export async function runSessionExclusive(
  runner: GodotRunner,
  toolName: string,
  operation: () => Promise<HandlerResult>,
): Promise<HandlerResult> {
  try {
    return await runner.runExclusive(toolName, operation);
  } catch (error) {
    if (error instanceof SessionQueueTimeoutError) return err(sessionBusyError(error));
    throw error;
  }
}

/** The longest `timeout` a runtime tool accepts, and the ceiling of one input batch's budget. */
export const MAX_RUNTIME_TIMEOUT_MS = 600000;

/**
 * The least a command may be left with once the queue wait has been taken off
 * its `timeout`. Under it the command could not finish what it was asked for,
 * so it is refused with nothing sent.
 */
export const QUEUE_CHARGED_COMMAND_FLOOR_MS = 2000;

/**
 * What a command needs from the time it has left after the queue wait.
 * `shorten`: the caller's `timeout` is the budget and the wait comes off it.
 * `fixed`: the command takes up to `worstCaseMs` whatever it is given, so the
 * wait is charged against the client's request timeout instead.
 */
export type QueueChargeNeed =
  | { kind: 'shorten'; budgetMs: number }
  | { kind: 'fixed'; worstCaseMs: number };

/**
 * Charge the time the caller spent waiting for its turn in the session queue
 * against its command, and return the milliseconds the command may use. Call
 * it inside the `runSessionExclusive` callback, after the session gate and
 * before the send. A refusal sends nothing.
 *
 * `shorten`: the budget less the wait, refused when that is under
 * `QUEUE_CHARGED_COMMAND_FLOOR_MS`. `fixed`: refused when the worst case fits
 * the client's request timeout alone but not after the wait; a command whose
 * worst case is over it already was never promised an answer in time, and is
 * not refused for waiting.
 */
export function chargeQueueWait(
  runner: GodotRunner,
  toolName: string,
  need: QueueChargeNeed,
): Result<number, ToolResponse> {
  const turn = runner.queueTurn();
  const waitedMs = turn?.waitedMs ?? 0;
  const behind = turn?.behind ?? 'another operation';
  const refuse = (detail: string): Result<number, ToolResponse> =>
    err(
      createErrorResponse(
        `${toolName} waited ${waitedMs} ms for ${behind} to finish, ${detail} Nothing was sent; retry the call now that the queue is free.`,
        [
          `Retry ${toolName}: it is not charged for a wait that did not happen`,
          'A runtime session runs one operation at a time: issue runtime calls one after another, not in parallel',
        ],
      ),
    );

  if (need.kind === 'shorten') {
    if (waitedMs === 0) return ok(need.budgetMs);
    const remainingMs = need.budgetMs - waitedMs;
    if (remainingMs < QUEUE_CHARGED_COMMAND_FLOOR_MS) {
      return refuse(
        `which leaves ${Math.max(0, remainingMs)} ms of its ${need.budgetMs} ms timeout, under the ${QUEUE_CHARGED_COMMAND_FLOOR_MS} ms a command needs.`,
      );
    }
    return ok(remainingMs);
  }

  if (
    need.worstCaseMs <= CLIENT_REQUEST_TIMEOUT_MS &&
    waitedMs + need.worstCaseMs > CLIENT_REQUEST_TIMEOUT_MS
  ) {
    return refuse(
      `and the call can take up to ${need.worstCaseMs} ms, which together pass the ${CLIENT_REQUEST_TIMEOUT_MS} ms after which a client that sent no progress token abandons the request.`,
    );
  }
  return ok(need.worstCaseMs);
}

/** The one gate the runtime and profiling handlers share. */
export function requireRuntimeSession(
  runner: GodotRunner,
  wording: NoSessionWording,
): Result<RuntimeSessionInfo, ToolResponse> {
  const status = runner.getRuntimeSessionStatus();
  if (status.state === 'live' && status.current !== null) return ok(status.current);
  return err(noLiveCurrentSessionError(status, wording));
}

/**
 * Error for a bridge command that threw. When the session ended while the
 * command was in flight, the message says so and lists the sessions still live.
 */
export function runtimeCommandFailure(
  runner: GodotRunner,
  error: unknown,
  failurePrefix: string,
  solutions: string[],
  wording: NoSessionWording,
): ToolResponse {
  if (error instanceof NoLiveCurrentSessionError) {
    return noLiveCurrentSessionError(error.status, wording);
  }
  // The command never left the queue, so nothing about the session is to
  // blame and the caller's own solutions do not apply.
  if (error instanceof SessionQueueTimeoutError) return sessionBusyError(error);
  const status = runner.getRuntimeSessionStatus();
  // A stop ended the session under this call, or before its turn came. The
  // bridge did not fail, so the caller's own solutions (check the logs, retry)
  // do not apply, and neither does anything that says the game crashed.
  if (error instanceof SessionStoppedError)
    return sessionStoppedError(error, failurePrefix, status);
  const message = `${failurePrefix}: ${getErrorMessage(error)}`;
  if (status.state === 'live') return createErrorResponse(message, solutions);
  const others = otherLiveSessionsClause(status);
  const switchSolution = others === '' ? [] : [SWITCH_PROJECT_SOLUTION];
  if (isExitedCurrent(status) && status.current !== null) {
    return createErrorResponse(
      `${message}\nThe session ended during this call: the Godot process exited (project ${status.current.projectPath}, exit code ${status.current.exitCode ?? 'unknown'}).${others}`,
      [...solutions, ...switchSolution],
    );
  }
  // Nothing is left of the session: a spawned one that exits keeps its record,
  // so this is an attached session whose bridge went away, or one that was
  // stopped while the command was in flight. The caller's own solutions speak
  // of stop_project and get_debug_output, and both would only report that
  // there is no session.
  return createErrorResponse(
    `${message}\nThe session ended during this call and no session is current now.${others}`,
    [...SESSION_GONE_SOLUTIONS, ...switchSolution],
  );
}

/**
 * The error for a runtime call that a stop cut off, or that reached a session
 * a stop had already ended. `error.cutOff` says which: a call that was cut
 * off may have done part of its work in the game, and that part stays done.
 */
export function sessionStoppedError(
  error: SessionStoppedError,
  failurePrefix: string,
  status: RuntimeSessionStatus,
): ToolResponse {
  const others = otherLiveSessionsClause(status);
  return createErrorResponse(`${failurePrefix}: ${error.message}${others}`, [
    error.cutOff
      ? 'Do not assume the call did nothing: what it had already done before the stop stays done, and the session it ran in is gone'
      : 'Nothing was sent to the game for this call',
    'The session was ended by stop_project (or by the server shutting down), not by a crash: call run_project to start a new one',
    ...(others === '' ? [] : [SWITCH_PROJECT_SOLUTION]),
  ]);
}

const SESSION_GONE_SOLUTIONS = [
  'Nothing is left to stop or to read logs from: stop_project and get_debug_output would both report no session',
  "If this was an attached session, its bridge disconnected and was removed from the project: check the Godot process's own output, then call run_project with attach: true again and relaunch Godot while that call waits",
  'Otherwise call run_project to start a new session',
];

/**
 * How to stop this server's own live session on a project, which may not be
 * the current one. `retryWhat` completes "then retry <retryWhat>".
 */
export function liveSessionRemedy(
  runner: GodotRunner,
  projectPath: string,
  retryWhat: string,
): { note: string; solutions: string[] } {
  const info = runner.getSessionInfo(projectPath);
  if (info === null || info.current) {
    return { note: '', solutions: [`Call stop_project, then retry ${retryWhat}`] };
  }
  const currentPath = runner.getCurrentSessionInfo()?.projectPath ?? 'no project';
  return {
    note: ` That session is not the current one (the runtime tools point at ${currentPath}), so stop_project by itself would not stop it.`,
    solutions: [
      `Call switch_project with projectPath "${info.projectPath}", then stop_project, then retry ${retryWhat}`,
    ],
  };
}
