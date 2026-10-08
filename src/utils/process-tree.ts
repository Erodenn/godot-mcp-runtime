// Kills a spawned Godot with whatever it started: the pid can be a wrapper (the Windows *_console.exe, a launcher) whose child is the engine, and killing it alone leaves the game running on its bridge port.

import { spawnSync, type ChildProcess } from 'child_process';
import { logDebug } from './logger.js';
import { getErrorMessage } from './error-response.js';

const TASKKILL_TIMEOUT_MS = 5000;
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

/** What a kill call did, not whether the process died: only the child's `exit`/`close` says that ({@link waitForProcessEvent}). `not-running` is the OS reporting no such process, which is not a failed kill. */
export type KillOutcome = 'signalled' | 'not-running' | 'failed';

/** Kill a process and its children: `taskkill /T /F` on Windows, elsewhere the process group (which reaches children only for a detached child), else the process alone. Synchronous and never throws, so it is safe in a `process.on('exit')` handler. */
export function killProcessTree(
  proc: KillableProcess,
  deps: KillTreeDeps = defaultKillTreeDeps,
): KillOutcome {
  const pid = proc.pid;
  if (pid === undefined) return 'not-running';
  if (deps.platform === 'win32') {
    try {
      const result = deps.spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: TASKKILL_TIMEOUT_MS,
      });
      if (!result.error && result.status === TASKKILL_STATUS_OK) return 'signalled';
      // Already exited: kill() on it would report a failure for a process that needs no killing.
      if (!result.error && result.status === TASKKILL_STATUS_NOT_FOUND) return 'not-running';
      return killSingle(proc);
    } catch {
      return killSingle(proc);
    }
  }
  return signalGroupOrProcess(proc, pid, 'SIGKILL', deps);
}

/** The first, polite stop of a session game: the whole tree at once on Windows (no polite signal), elsewhere SIGTERM to the group or the process, for the caller to escalate to {@link killProcessTree}. Never throws. */
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

// kill(-pid) fails with ESRCH both when the group is gone and when the child never led one; the two cannot be told apart, so it falls back to the process alone.
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

/** Wait for a child's `exit` or `close` up to `timeoutMs`; true when it arrived. The only evidence a kill worked: the kill call returning says only that the signal was sent. */
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
