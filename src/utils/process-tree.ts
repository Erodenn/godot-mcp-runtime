/**
 * Killing a spawned Godot together with whatever it started.
 *
 * The pid a spawn hands back is not always the engine: the Windows
 * `*_console.exe` wrapper and a launcher script both start the real Godot as a
 * child. Killing that one pid reports success while the game keeps running and
 * keeps its bridge port. The session games and the headless runs
 * (`GodotRunner`) and the bounded movie run (`movie-process.ts`) all kill
 * through here.
 */

import { spawnSync, type ChildProcess } from 'child_process';
import { logDebug } from './logger.js';
import { getErrorMessage } from './error-response.js';

const TASKKILL_TIMEOUT_MS = 5000;
/** `taskkill` exit status when no process has the given pid. */
const TASKKILL_STATUS_NOT_FOUND = 128;
const TASKKILL_STATUS_OK = 0;

export interface KillTreeDeps {
  platform: NodeJS.Platform;
  spawnSync: typeof spawnSync;
  kill: (pid: number, signal: NodeJS.Signals) => void;
}

export const defaultKillTreeDeps: KillTreeDeps = {
  platform: process.platform,
  spawnSync,
  kill: (pid, signal) => {
    process.kill(pid, signal);
  },
};

type KillableProcess = Pick<ChildProcess, 'pid' | 'kill'>;

/**
 * What a kill call did, as far as the call itself can tell. None of these is
 * "the process has exited": that is known only from the child's `exit` or
 * `close` event (see {@link waitForProcessEvent}).
 * - `signalled`: the kill was delivered to the tree, the group or the process.
 * - `not-running`: the operating system reported no such process. There was
 *   nothing left to kill, which is not a kill that failed.
 * - `failed`: the kill could not be delivered.
 */
export type KillOutcome = 'signalled' | 'not-running' | 'failed';

/**
 * Kill a process and everything it started. On Windows that is
 * `taskkill /T /F`; elsewhere the process group is signalled, which reaches
 * the children only when the child leads its own group (it was spawned
 * detached). Falls back to killing the process alone. Synchronous, and never
 * throws, so it is safe from a `process.on('exit')` handler.
 */
export function killProcessTree(
  proc: KillableProcess,
  deps: KillTreeDeps = defaultKillTreeDeps,
): KillOutcome {
  const pid = proc.pid;
  // A process with no pid never started.
  if (pid === undefined) return 'not-running';
  if (deps.platform === 'win32') {
    try {
      const result = deps.spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: TASKKILL_TIMEOUT_MS,
      });
      if (!result.error && result.status === TASKKILL_STATUS_OK) return 'signalled';
      // The process had already exited. Calling kill() on it would report a
      // failure for a process that needs no killing.
      if (!result.error && result.status === TASKKILL_STATUS_NOT_FOUND) return 'not-running';
      return killSingle(proc);
    } catch {
      return killSingle(proc);
    }
  }
  return signalGroupOrProcess(proc, pid, 'SIGKILL', deps);
}

/**
 * The first, polite stop of a session game. Windows has no polite signal
 * (`kill()` there already terminates outright), so the whole tree is taken
 * down at once. Elsewhere the process group gets SIGTERM, or the process
 * alone when it leads no group, and the caller escalates to
 * {@link killProcessTree} if it does not exit. A process with no pid never
 * started; `kill()` on it is a no-op. Never throws.
 */
export function terminateProcessTree(
  proc: KillableProcess,
  deps: KillTreeDeps = defaultKillTreeDeps,
): KillOutcome {
  const pid = proc.pid;
  if (pid === undefined) {
    killSingle(proc);
    return 'not-running';
  }
  if (deps.platform === 'win32') return killProcessTree(proc, deps);
  return signalGroupOrProcess(proc, pid, 'SIGTERM', deps);
}

/**
 * Signal the group a detached child leads, so a wrapper script's real engine
 * is reached too. `kill(-pid)` fails with ESRCH both when the group is gone
 * and when the child never led one (it was not spawned detached), and the two
 * cannot be told apart, so that failure falls back to the process alone.
 */
function signalGroupOrProcess(
  proc: KillableProcess,
  pid: number,
  signal: NodeJS.Signals,
  deps: KillTreeDeps,
): KillOutcome {
  try {
    deps.kill(-pid, signal);
    return 'signalled';
  } catch {
    return killSingle(proc, signal);
  }
}

/** `ChildProcess.kill` returns false when the process has already exited. */
function killSingle(proc: KillableProcess, signal?: NodeJS.Signals): KillOutcome {
  try {
    const delivered = signal === undefined ? proc.kill() : proc.kill(signal);
    return delivered === false ? 'not-running' : 'signalled';
  } catch (error) {
    logDebug(`Non-fatal: could not kill the process: ${getErrorMessage(error)}`);
    return 'failed';
  }
}

type ProcessEventSource = Pick<ChildProcess, 'once' | 'removeListener'>;

/**
 * Wait for a child's `exit` or `close` event, up to `timeoutMs`. Resolves true
 * when the event arrived and false when the wait ran out. This is the only
 * evidence that a kill worked: the kill call returning says the signal was
 * sent, not that anything died.
 */
export function waitForProcessEvent(
  proc: ProcessEventSource,
  event: 'exit' | 'close',
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const onEvent = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      proc.removeListener(event, onEvent);
      resolve(false);
    }, timeoutMs);
    proc.once(event, onEvent);
  });
}
