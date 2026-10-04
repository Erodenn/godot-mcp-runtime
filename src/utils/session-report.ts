import {
  NoLiveCurrentSessionError,
  type GodotRunner,
  type RuntimeSessionInfo,
  type RuntimeSessionStatus,
} from './godot-runner.js';
import type { ToolResponse } from '../mcp.types.js';
import { createErrorResponse, getErrorMessage } from './error-response.js';
import { ok, err, type Result } from './result.js';

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
  const message = `${failurePrefix}: ${getErrorMessage(error)}`;
  const status = runner.getRuntimeSessionStatus();
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
