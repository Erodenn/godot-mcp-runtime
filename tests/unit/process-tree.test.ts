/**
 * `terminateProcessTree`: the first stop of a session game. The forced tree
 * kill it escalates to, `killProcessTree`, is covered in movie-process.test.ts
 * through the same module's re-export.
 */

import { describe, it, expect, vi } from 'vitest';
import type { spawnSync } from 'child_process';
import { terminateProcessTree, type KillTreeDeps } from '../../src/utils/process-tree.js';

const FAKE_PID = 4321;
const TASKKILL_FAILED_STATUS = 128;

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

describe('terminateProcessTree', () => {
  it('takes the whole tree down with taskkill on win32, so a wrapper pid does not leave the game running', () => {
    const deps = killDeps('win32');
    const proc = fakeChild();

    terminateProcessTree(proc, deps);

    expect(deps.spawnSyncMock).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', String(FAKE_PID), '/T', '/F'],
      expect.objectContaining({ windowsHide: true }),
    );
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it('falls back to killing the process alone when taskkill fails on win32', () => {
    const deps = killDeps('win32');
    deps.spawnSyncMock.mockReturnValue({ status: TASKKILL_FAILED_STATUS });
    const proc = fakeChild();

    terminateProcessTree(proc, deps);

    expect(proc.kill).toHaveBeenCalledTimes(1);
  });

  it('sends the polite default signal elsewhere and leaves the group alone', () => {
    const deps = killDeps('linux');
    const proc = fakeChild();

    terminateProcessTree(proc, deps);

    expect(proc.kill).toHaveBeenCalledWith();
    expect(deps.killMock).not.toHaveBeenCalled();
    expect(deps.spawnSyncMock).not.toHaveBeenCalled();
  });

  it('never runs taskkill for a process that has no pid', () => {
    const deps = killDeps('win32');
    const proc = fakeChild(null);

    terminateProcessTree(proc, deps);

    expect(deps.spawnSyncMock).not.toHaveBeenCalled();
    expect(proc.kill).toHaveBeenCalledTimes(1);
  });

  it('never throws when the kill itself throws', () => {
    const deps = killDeps('linux');
    const proc = fakeChild();
    proc.kill.mockImplementation(() => {
      throw new Error('EPERM');
    });

    expect(() => terminateProcessTree(proc, deps)).not.toThrow();
  });
});
