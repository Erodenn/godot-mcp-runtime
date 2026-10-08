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

export interface NoSessionWording {
  action: string;
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

export function isExitedCurrent(status: RuntimeSessionStatus): boolean {
  const current = status.current;
  return (
    status.state === 'exited' &&
    current !== null &&
    (current.processExited || current.mode === 'spawned')
  );
}

export function otherLiveSessionsClause(status: RuntimeSessionStatus): string {
  const paths = status.otherLiveSessions.map((info) => info.projectPath);
  if (paths.length === 0) return '';
  return ` Live sessions on other projects, none of which is picked automatically: ${paths.join(', ')}.`;
}

/** The error for a runtime tool with no live current session; never picks another, lists them and points at switch_project. */
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
    // Current holds neither a live game nor an exited process (e.g. a finished profiler capture kept after stop_project).
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

/** The error for a call that gave up waiting for its turn; nothing was sent, so retry once the named call returns. */
export function sessionBusyError(error: SessionQueueTimeoutError): ToolResponse {
  return createErrorResponse(error.message, [
    `Wait for ${error.behind} to return, then retry this call`,
    'A runtime session runs one operation at a time: issue runtime calls one after another, not in parallel',
  ]);
}

/** Run a handler's session work with the session queue held, so its gate and command (or start, wait and teardown) are one step; `toolName` is what waiters are told. A turn that did not come in time becomes a structured error. */
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

export const MAX_RUNTIME_TIMEOUT_MS = 600000;

/** The least a command may keep after the queue wait comes off its `timeout`; under it, it is refused with nothing sent. */
export const QUEUE_CHARGED_COMMAND_FLOOR_MS = 2000;

/** `shorten`: the caller's `timeout` is the budget and the wait comes off it. `fixed`: the command takes up to `worstCaseMs` regardless, so the wait is charged against the client's request timeout. */
export type QueueChargeNeed =
  | { kind: 'shorten'; budgetMs: number }
  | { kind: 'fixed'; worstCaseMs: number };

/** Charge the queue wait against a command and return the milliseconds it may use; call inside `runSessionExclusive` after the gate and before the send. `shorten` refuses under `QUEUE_CHARGED_COMMAND_FLOOR_MS`; `fixed` refuses when the worst case fits the client timeout alone but not after the wait (a worst case already over it is not refused for waiting). */
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

export function requireRuntimeSession(
  runner: GodotRunner,
  wording: NoSessionWording,
): Result<RuntimeSessionInfo, ToolResponse> {
  const status = runner.getRuntimeSessionStatus();
  if (status.state === 'live' && status.current !== null) return ok(status.current);
  return err(noLiveCurrentSessionError(status, wording));
}

/** Error for a bridge command that threw; if the session ended meanwhile, says so and lists the live ones. */
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
  // The command never left the queue: the session is not to blame and the caller's solutions do not apply.
  if (error instanceof SessionQueueTimeoutError) return sessionBusyError(error);
  const status = runner.getRuntimeSessionStatus();
  // A stop ended the session; the bridge did not fail, so the caller's solutions and any "game crashed" wording do not apply.
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
  // Nothing left: an attached session whose bridge went away, or one stopped mid-call. The caller's stop_project and get_debug_output solutions would only report no session.
  return createErrorResponse(
    `${message}\nThe session ended during this call and no session is current now.${others}`,
    [...SESSION_GONE_SOLUTIONS, ...switchSolution],
  );
}

/** The error for a call a stop cut off or that reached an already-ended session; a cut-off call may have done part of its work, which stays done. */
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

/** How to stop this server's live session on a project, which may not be the current one; `retryWhat` completes "then retry <retryWhat>". */
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
