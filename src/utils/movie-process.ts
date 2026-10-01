/**
 * The spawn seam for `render_movie`: one bounded Godot process, its output
 * captured, never left running.
 *
 * Unlike a runtime session this holds no state on the runner and speaks no
 * protocol; the caller reads the result from disk. Every path out resolves
 * (never rejects), and a timeout kills the whole process tree, so a wedged
 * movie run cannot outlive the call or the server.
 *
 * The movie-writer run flow (argument set, frame-scaled timeout, stderr tail)
 * is adapted from PR 63 by Mickael Canevet.
 */

import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { logDebug } from './logger.js';
import { getErrorMessage } from './error-response.js';
import { normalizeExitCode } from './output-parsing.js';

/** Each captured stream keeps only its last this many characters. */
export const MOVIE_OUTPUT_CAPTURE_MAX_CHARS = 64 * 1024;
/** After a timeout kill, how long to wait for the process to report closing before giving up. */
export const MOVIE_KILL_GRACE_MS = 5000;
const TASKKILL_TIMEOUT_MS = 5000;

export interface MovieProcessResult {
  /** Normalized exit code; null when the process did not exit on its own or never started. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the process could not be started at all. */
  spawnError?: string;
  /**
   * Set on a timeout whose kill was sent but whose process did not report
   * closing within the grace period: it may still be running.
   */
  killUnconfirmed?: boolean;
}

export type RunMovieProcess = (
  godotPath: string,
  args: string[],
  timeoutMs: number,
) => Promise<MovieProcessResult>;

export interface KillTreeDeps {
  platform: NodeJS.Platform;
  spawnSync: typeof spawnSync;
  kill: (pid: number, signal: NodeJS.Signals) => void;
}

const defaultKillTreeDeps: KillTreeDeps = {
  platform: process.platform,
  spawnSync,
  kill: (pid, signal) => {
    process.kill(pid, signal);
  },
};

/**
 * Kill a process and everything it started. On Windows that is
 * `taskkill /T /F`; elsewhere the child leads its own process group (it was
 * spawned detached), so the group is signalled. Falls back to killing the
 * process alone. Never throws.
 */
export function killProcessTree(
  proc: Pick<ChildProcess, 'pid' | 'kill'>,
  deps: KillTreeDeps = defaultKillTreeDeps,
): void {
  const pid = proc.pid;
  if (pid === undefined) return;
  if (deps.platform === 'win32') {
    try {
      const result = deps.spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: TASKKILL_TIMEOUT_MS,
      });
      if (result.error || result.status !== 0) proc.kill();
    } catch {
      killQuietly(() => proc.kill());
    }
    return;
  }
  try {
    deps.kill(-pid, 'SIGKILL');
  } catch {
    killQuietly(() => proc.kill('SIGKILL'));
  }
}

function killQuietly(kill: () => void): void {
  try {
    kill();
  } catch (error) {
    logDebug(`Non-fatal: could not kill the movie process: ${getErrorMessage(error)}`);
  }
}

export interface MovieProcessDeps {
  spawn: typeof spawn;
  killTree: (proc: ChildProcess) => void;
}

const defaultMovieProcessDeps: MovieProcessDeps = {
  spawn,
  killTree: (proc) => killProcessTree(proc),
};

/**
 * Children still running. A server that exits mid-run must not leave a Godot
 * window behind, so the first spawn registers one exit hook over this set.
 * A child leaves the set only when it reports closing (or never started), not
 * when its call resolves: one that outlived a timeout kill stays tracked, so
 * the exit hook gets a second attempt at it. Each child is kept with the tree
 * kill its own call was given, so the hook never reaches past an injected one.
 */
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

/**
 * Run Godot with the given arguments and wait for it to exit, bounded by
 * `timeoutMs`. Never rejects: a start failure is `spawnError`, a timeout is
 * `timedOut` (after a tree kill was sent, with `killUnconfirmed` when the
 * process did not report closing within the grace period), and anything else
 * is the exit code and the tail of each output stream.
 */
export function runMovieProcess(
  godotPath: string,
  args: string[],
  timeoutMs: number,
  deps: MovieProcessDeps = defaultMovieProcessDeps,
): Promise<MovieProcessResult> {
  return new Promise<MovieProcessResult>((resolve) => {
    let proc: ChildProcess | undefined;
    let settled = false;
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
      proc = deps.spawn(godotPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (error) {
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
      finish({ exitCode: null, stdout, stderr, timedOut: false, spawnError: error.message });
    });
    child.on('close', (code: number | null) => {
      activeMovieChildren.delete(child);
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
