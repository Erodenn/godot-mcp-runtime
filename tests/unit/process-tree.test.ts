import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { spawnSync } from 'child_process';
import {
  killProcessTree,
  terminateProcessTree,
  waitForProcessEvent,
  type KillTreeDeps,
} from '../../src/utils/process-tree.js';

const FAKE_PID = 4321;
const TASKKILL_NOT_FOUND_STATUS = 128;
const TASKKILL_ACCESS_DENIED_STATUS = 1;
const EXIT_WAIT_MS = 500;

/** `null` models a process that never started: Node leaves its pid undefined. */
function fakeChild(pid: number | null = FAKE_PID): {
  pid: number | undefined;
  kill: ReturnType<typeof vi.fn>;
} {
  return { pid: pid ?? undefined, kill: vi.fn(() => true) };
}

function killDeps(platform: NodeJS.Platform): KillTreeDeps & {
  spawnSyncMock: ReturnType<typeof vi.fn>;
  killMock: ReturnType<typeof vi.fn>;
} {
  const spawnSyncMock = vi.fn(() => ({ status: 0 }));
  const killMock = vi.fn();
  return {
    platform,
    spawnSync: spawnSyncMock as unknown as typeof spawnSync,
    kill: killMock,
    spawnSyncMock,
    killMock,
  };
}

function noSuchProcess(): never {
  throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
}

describe('terminateProcessTree', () => {
  it('takes the whole tree down with taskkill on win32, so a wrapper pid does not leave the game running', () => {
    const deps = killDeps('win32');
    const proc = fakeChild();

    expect(terminateProcessTree(proc, deps)).toBe('signalled');

    expect(deps.spawnSyncMock).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', String(FAKE_PID), '/T', '/F'],
      expect.objectContaining({ windowsHide: true }),
    );
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it('falls back to killing the process alone when taskkill fails on win32', () => {
    const deps = killDeps('win32');
    deps.spawnSyncMock.mockReturnValue({ status: TASKKILL_ACCESS_DENIED_STATUS });
    const proc = fakeChild();

    expect(terminateProcessTree(proc, deps)).toBe('signalled');

    expect(proc.kill).toHaveBeenCalledTimes(1);
  });

  it('reports a process taskkill cannot find as not running, and does not kill it again', () => {
    const deps = killDeps('win32');
    deps.spawnSyncMock.mockReturnValue({ status: TASKKILL_NOT_FOUND_STATUS });
    const proc = fakeChild();

    expect(terminateProcessTree(proc, deps)).toBe('not-running');

    expect(proc.kill).not.toHaveBeenCalled();
  });

  it('sends SIGTERM to the process group elsewhere, so a wrapper script and its engine both get it', () => {
    const deps = killDeps('linux');
    const proc = fakeChild();

    expect(terminateProcessTree(proc, deps)).toBe('signalled');

    expect(deps.killMock).toHaveBeenCalledWith(-FAKE_PID, 'SIGTERM');
    expect(proc.kill).not.toHaveBeenCalled();
    expect(deps.spawnSyncMock).not.toHaveBeenCalled();
  });

  it('signals the process alone when it leads no group', () => {
    const deps = killDeps('linux');
    deps.killMock.mockImplementation(noSuchProcess);
    const proc = fakeChild();

    expect(terminateProcessTree(proc, deps)).toBe('signalled');

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('never runs taskkill for a process that has no pid', () => {
    const deps = killDeps('win32');
    const proc = fakeChild(null);

    expect(terminateProcessTree(proc, deps)).toBe('not-running');

    expect(deps.spawnSyncMock).not.toHaveBeenCalled();
    expect(proc.kill).toHaveBeenCalledTimes(1);
  });

  it('never throws when the kill itself throws, and reports the kill as failed', () => {
    const deps = killDeps('linux');
    deps.killMock.mockImplementation(noSuchProcess);
    const proc = fakeChild();
    proc.kill.mockImplementation(() => {
      throw new Error('EPERM');
    });

    expect(terminateProcessTree(proc, deps)).toBe('failed');
  });
});

describe('killProcessTree outcome', () => {
  it('reports a delivered group kill as signalled', () => {
    const deps = killDeps('linux');
    expect(killProcessTree(fakeChild(), deps)).toBe('signalled');
    expect(deps.killMock).toHaveBeenCalledWith(-FAKE_PID, 'SIGKILL');
  });

  it('reports not running when neither the group nor the process exists any more', () => {
    const deps = killDeps('linux');
    deps.killMock.mockImplementation(noSuchProcess);
    const proc = fakeChild();
    // ChildProcess.kill returns false for a process that has already exited.
    proc.kill.mockReturnValue(false);

    expect(killProcessTree(proc, deps)).toBe('not-running');
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('reports a process that never started as not running, without signalling anything', () => {
    const deps = killDeps('linux');
    const proc = fakeChild(null);

    expect(killProcessTree(proc, deps)).toBe('not-running');
    expect(deps.killMock).not.toHaveBeenCalled();
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it('reports taskkill status 128 as not running on win32', () => {
    const deps = killDeps('win32');
    deps.spawnSyncMock.mockReturnValue({ status: TASKKILL_NOT_FOUND_STATUS });
    const proc = fakeChild();

    expect(killProcessTree(proc, deps)).toBe('not-running');
    expect(proc.kill).not.toHaveBeenCalled();
  });
});

describe('waitForProcessEvent', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves true when the event arrives inside the wait', async () => {
    const proc = new EventEmitter();
    const waiting = waitForProcessEvent(proc, 'exit', EXIT_WAIT_MS);
    proc.emit('exit', 0);
    await expect(waiting).resolves.toBe(true);
  });

  it('resolves false when the wait runs out, and stops listening', async () => {
    vi.useFakeTimers();
    const proc = new EventEmitter();
    const waiting = waitForProcessEvent(proc, 'close', EXIT_WAIT_MS);
    vi.advanceTimersByTime(EXIT_WAIT_MS);
    await expect(waiting).resolves.toBe(false);
    expect(proc.listenerCount('close')).toBe(0);
  });
});
