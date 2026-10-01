import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess, spawn, spawnSync } from 'child_process';
import {
  MOVIE_KILL_GRACE_MS,
  MOVIE_OUTPUT_CAPTURE_MAX_CHARS,
  killProcessTree,
  runMovieProcess,
  type KillTreeDeps,
  type MovieProcessDeps,
} from '../../src/utils/movie-process.js';

const FAKE_PID = 4321;
const TEST_TIMEOUT_MS = 1000;
const OVERSIZE_EXTRA_CHARS = 100;

interface FakeChild extends EventEmitter {
  pid: number | undefined;
  kill: ReturnType<typeof vi.fn>;
  stdout: EventEmitter;
  stderr: EventEmitter;
}

function createFakeChild(pid: number | null = FAKE_PID): FakeChild {
  return Object.assign(new EventEmitter(), {
    pid: pid ?? undefined,
    kill: vi.fn(),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
}

function createDeps(child: FakeChild): MovieProcessDeps & {
  spawnMock: ReturnType<typeof vi.fn>;
  killTreeMock: ReturnType<typeof vi.fn>;
} {
  const spawnMock = vi.fn(() => child);
  const killTreeMock = vi.fn();
  return {
    spawn: spawnMock as unknown as typeof spawn,
    killTree: killTreeMock,
    spawnMock,
    killTreeMock,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('runMovieProcess', () => {
  it('passes the executable and args to spawn', async () => {
    const child = createFakeChild();
    const deps = createDeps(child);
    const promise = runMovieProcess('/fake/godot', ['--path', '/p'], TEST_TIMEOUT_MS, deps);
    child.emit('close', 0);
    await promise;
    expect(deps.spawnMock).toHaveBeenCalledTimes(1);
    expect(deps.spawnMock).toHaveBeenCalledWith(
      '/fake/godot',
      ['--path', '/p'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  });

  it('resolves with the exit code and captured stderr on close', async () => {
    const child = createFakeChild();
    const promise = runMovieProcess('/fake/godot', [], TEST_TIMEOUT_MS, createDeps(child));
    child.stdout.emit('data', Buffer.from('out text'));
    child.stderr.emit('data', Buffer.from('boom'));
    child.emit('close', 3);
    await expect(promise).resolves.toEqual({
      exitCode: 3,
      stdout: 'out text',
      stderr: 'boom',
      timedOut: false,
    });
  });

  it('keeps only the tail of an oversized stream', async () => {
    const child = createFakeChild();
    const promise = runMovieProcess('/fake/godot', [], TEST_TIMEOUT_MS, createDeps(child));
    child.stderr.emit('data', 'x'.repeat(MOVIE_OUTPUT_CAPTURE_MAX_CHARS + OVERSIZE_EXTRA_CHARS));
    child.stderr.emit('data', 'THE-END');
    child.emit('close', 0);
    const result = await promise;
    expect(result.stderr.length).toBe(MOVIE_OUTPUT_CAPTURE_MAX_CHARS);
    expect(result.stderr.endsWith('THE-END')).toBe(true);
  });

  it('resolves with spawnError when the process cannot start', async () => {
    const child = createFakeChild(null);
    const promise = runMovieProcess('/fake/godot', [], TEST_TIMEOUT_MS, createDeps(child));
    child.emit('error', new Error('spawn ENOENT'));
    const result = await promise;
    expect(result.spawnError).toBe('spawn ENOENT');
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
  });

  it('resolves with spawnError when spawn itself throws', async () => {
    const deps: MovieProcessDeps = {
      spawn: (() => {
        throw new Error('bad arguments');
      }) as unknown as typeof spawn,
      killTree: vi.fn(),
    };
    const result = await runMovieProcess('/fake/godot', [], TEST_TIMEOUT_MS, deps);
    expect(result.spawnError).toBe('bad arguments');
    expect(result.exitCode).toBeNull();
  });

  it('kills the tree and reports timedOut when the timeout elapses', async () => {
    vi.useFakeTimers();
    const child = createFakeChild();
    const deps = createDeps(child);
    const promise = runMovieProcess('/fake/godot', [], TEST_TIMEOUT_MS, deps);
    expect(deps.killTreeMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(TEST_TIMEOUT_MS);
    expect(deps.killTreeMock).toHaveBeenCalledWith(child);
    child.emit('close', null);
    const result = await promise;
    expect(result.timedOut).toBe(true);
    expect(result.killUnconfirmed).toBeUndefined();
  });

  it('resolves after the kill grace even if close never arrives, marking the kill unconfirmed', async () => {
    vi.useFakeTimers();
    const child = createFakeChild();
    const promise = runMovieProcess('/fake/godot', [], TEST_TIMEOUT_MS, createDeps(child));
    vi.advanceTimersByTime(TEST_TIMEOUT_MS + MOVIE_KILL_GRACE_MS);
    const result = await promise;
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.killUnconfirmed).toBe(true);
    // Untrack the fake child, as a real one does when it finally closes.
    child.emit('close', null);
  });

  it('does not report a start failure for an error raised after the timeout kill', async () => {
    vi.useFakeTimers();
    const child = createFakeChild();
    const promise = runMovieProcess('/fake/godot', [], TEST_TIMEOUT_MS, createDeps(child));
    vi.advanceTimersByTime(TEST_TIMEOUT_MS);
    child.emit('error', new Error('kill EPERM'));
    vi.advanceTimersByTime(MOVIE_KILL_GRACE_MS);
    const result = await promise;
    expect(result.timedOut).toBe(true);
    expect(result.spawnError).toBeUndefined();
    expect(result.killUnconfirmed).toBe(true);
    child.emit('close', null);
  });
});

describe('killProcessTree', () => {
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

  it('runs taskkill /PID <pid> /T /F on win32', () => {
    const deps = killDeps('win32');
    const proc = createFakeChild();
    killProcessTree(proc as unknown as ChildProcess, deps);
    expect(deps.spawnSyncMock).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', String(FAKE_PID), '/T', '/F'],
      expect.objectContaining({ windowsHide: true }),
    );
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it('falls back to proc.kill when taskkill reports failure on win32', () => {
    const deps = killDeps('win32');
    deps.spawnSyncMock.mockReturnValue({ status: 128 });
    const proc = createFakeChild();
    killProcessTree(proc as unknown as ChildProcess, deps);
    expect(proc.kill).toHaveBeenCalledTimes(1);
  });

  it('signals the process group elsewhere', () => {
    const deps = killDeps('linux');
    const proc = createFakeChild();
    killProcessTree(proc as unknown as ChildProcess, deps);
    expect(deps.killMock).toHaveBeenCalledWith(-FAKE_PID, 'SIGKILL');
    expect(deps.spawnSyncMock).not.toHaveBeenCalled();
  });

  it('falls back to proc.kill when the tree kill throws', () => {
    const deps = killDeps('linux');
    deps.killMock.mockImplementation(() => {
      throw new Error('ESRCH');
    });
    const proc = createFakeChild();
    expect(() => killProcessTree(proc as unknown as ChildProcess, deps)).not.toThrow();
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('does nothing when the process has no pid', () => {
    const deps = killDeps('linux');
    const proc = createFakeChild(null);
    killProcessTree(proc as unknown as ChildProcess, deps);
    expect(deps.killMock).not.toHaveBeenCalled();
    expect(proc.kill).not.toHaveBeenCalled();
  });
});
