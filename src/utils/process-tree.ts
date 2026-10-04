/**
 * Killing a spawned Godot together with whatever it started.
 *
 * The pid a spawn hands back is not always the engine: the Windows
 * `*_console.exe` wrapper and a launcher script both start the real Godot as a
 * child. Killing that one pid reports success while the game keeps running and
 * keeps its bridge port. Both the session games (`GodotRunner`) and the
 * bounded movie run (`movie-process.ts`) kill through here.
 */

import { spawnSync, type ChildProcess } from 'child_process';
import { logDebug } from './logger.js';
import { getErrorMessage } from './error-response.js';

const TASKKILL_TIMEOUT_MS = 5000;

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
 * Kill a process and everything it started. On Windows that is
 * `taskkill /T /F`; elsewhere the process group is signalled, which reaches
 * the children only when the child leads its own group (it was spawned
 * detached). Falls back to killing the process alone. Synchronous, and never
 * throws, so it is safe from a `process.on('exit')` handler.
 */
export function killProcessTree(
  proc: KillableProcess,
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

/**
 * The first, polite stop of a session game. Windows has no polite signal
 * (`kill()` there already terminates outright), so the whole tree is taken
 * down at once. Elsewhere the process gets SIGTERM and the caller escalates to
 * {@link killProcessTree} if it does not exit. A process with no pid never
 * started; `kill()` on it is a no-op. Never throws.
 */
export function terminateProcessTree(
  proc: KillableProcess,
  deps: KillTreeDeps = defaultKillTreeDeps,
): void {
  if (deps.platform === 'win32' && proc.pid !== undefined) {
    killProcessTree(proc, deps);
    return;
  }
  killQuietly(() => proc.kill());
}

function killQuietly(kill: () => void): void {
  try {
    kill();
  } catch (error) {
    logDebug(`Non-fatal: could not kill the process: ${getErrorMessage(error)}`);
  }
}
