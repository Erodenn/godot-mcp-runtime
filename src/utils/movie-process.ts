/** The spawn seam for `render_movie`: one bounded Godot process, output captured, never left running. Every path out resolves (never rejects) and a timeout kills the whole process tree, so a wedged run cannot outlive the call or the server.
 * The movie-writer run flow (argument set, frame-scaled timeout, stderr tail) is adapted from PR 63 by Mickael Canevet. */

import { spawn, type ChildProcess } from 'child_process';
import { logDebug } from './logger.js';
import { getErrorMessage } from './error-response.js';
import { normalizeExitCode } from './output-parsing.js';
import { godotSpawnOptions } from './godot-spawn-options.js';
import { killProcessTree } from './process-tree.js';

/** Each captured stream keeps only its last this many characters. */
export const MOVIE_OUTPUT_CAPTURE_MAX_CHARS = 64 * 1024;
/** After a timeout kill, how long to wait for the process to report closing before giving up. */
export const MOVIE_KILL_GRACE_MS = 5000;

export interface MovieProcessResult {
  /** Normalized exit code; null when the process did not exit on its own or never started. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the process could not be started at all. */
  spawnError?: string;
  /** Set on a timeout whose kill was sent but whose process did not report closing within the grace period: it may still be running. */
  killUnconfirmed?: boolean;
}

export interface MovieRunHooks {
  /** Called once when the child is known not to be running (it reported `close`, or never started), not when the call merely gives up on a child that outlived its timeout kill: a caller tracking 'a movie process uses this project' ends that here, not on the result. */
  onClosed?: () => void;
}

export type RunMovieProcess = (
  godotPath: string,
  args: string[],
  timeoutMs: number,
  hooks?: MovieRunHooks,
) => Promise<MovieProcessResult>;

export interface MovieProcessDeps {
  spawn: typeof spawn;
  killTree: (proc: ChildProcess) => void;
}

const defaultMovieProcessDeps: MovieProcessDeps = {
  spawn,
  killTree: (proc) => killProcessTree(proc),
};

/** Children still running: the first spawn registers one exit hook over this set so a server exiting mid-run leaves no Godot window. A child leaves only when it reports closing (or never started), not when its call resolves, so one that outlived a timeout kill gets a second attempt; each is kept with its own call's tree kill. */
const activeMovieChildren = new Map<ChildProcess, (proc: ChildProcess) => void>();
let exitHookRegistered = false;

function registerExitHook(): void {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.once('exit', () => {
    for (const [child, killTree] of activeMovieChildren) {
      try {
        killTree(child);
      } catch {
        // Exit handlers must not throw.
      }
    }
  });
}

function appendTail(current: string, chunk: unknown): string {
  return (current + String(chunk)).slice(-MOVIE_OUTPUT_CAPTURE_MAX_CHARS);
}

/** Runs Godot and waits for exit, bounded by `timeoutMs`; never rejects: `spawnError`, `timedOut` (tree kill sent; `killUnconfirmed` if it did not report closing within grace), else the exit code and each stream's tail. */
export function runMovieProcess(
  godotPath: string,
  args: string[],
  timeoutMs: number,
  deps: MovieProcessDeps = defaultMovieProcessDeps,
  hooks: MovieRunHooks = {},
): Promise<MovieProcessResult> {
  return new Promise<MovieProcessResult>((resolve) => {
    let proc: ChildProcess | undefined;
    let settled = false;
    let closedReported = false;
    const reportClosed = (): void => {
      if (closedReported) return;
      closedReported = true;
      try {
        hooks.onClosed?.();
      } catch (error) {
        logDebug(`Non-fatal: a movie run's onClosed hook threw: ${getErrorMessage(error)}`);
      }
    };
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timers: { timeout?: NodeJS.Timeout; grace?: NodeJS.Timeout } = {};

    const finish = (result: MovieProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timers.timeout);
      clearTimeout(timers.grace);
      resolve(result);
    };

    try {
      proc = deps.spawn(godotPath, args, godotSpawnOptions('movie'));
    } catch (error) {
      reportClosed();
      finish({
        exitCode: null,
        stdout,
        stderr,
        timedOut: false,
        spawnError: getErrorMessage(error),
      });
      return;
    }

    const child = proc;
    activeMovieChildren.set(child, deps.killTree);
    registerExitHook();

    child.stdout?.on('data', (chunk: unknown) => {
      stdout = appendTail(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: unknown) => {
      stderr = appendTail(stderr, chunk);
    });
    child.on('error', (error: Error) => {
      // After the timeout kill, 'error' means the kill itself failed, not that
      // the process never started. The grace timer reports that outcome.
      if (timedOut) {
        logDebug(`Non-fatal: the movie process reported an error after the kill: ${error.message}`);
        return;
      }
      activeMovieChildren.delete(child);
      reportClosed();
      finish({ exitCode: null, stdout, stderr, timedOut: false, spawnError: error.message });
    });
    child.on('close', (code: number | null) => {
      activeMovieChildren.delete(child);
      reportClosed();
      finish({ exitCode: normalizeExitCode(code), stdout, stderr, timedOut });
    });

    timers.timeout = setTimeout(() => {
      timedOut = true;
      deps.killTree(child);
      timers.grace = setTimeout(() => {
        finish({ exitCode: null, stdout, stderr, timedOut: true, killUnconfirmed: true });
      }, MOVIE_KILL_GRACE_MS);
    }, timeoutMs);
  });
}
