/**
 * Session lifecycle: the auto-clear on spawned-process exit, the idempotent
 * stop after a self-exit, and attached-mode disconnect handling.
 *
 * `child_process.spawn` is mocked at the I/O boundary so `runProject` runs its
 * real body — including the `'exit'` registration under test — without a Godot
 * binary. `BridgeManager` is replaced with a recorder so cleanup calls are
 * observable and nothing is written outside the tmp project.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as net from 'net';
import type { AddressInfo } from 'net';
import type * as childProcess from 'child_process';
import { encodeFrame, parseFrames } from '../../src/utils/bridge-protocol.js';
import { useTmpDirs } from '../helpers/tmp.js';

const spawnMock = vi.fn();
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  return { ...actual, spawn: (...args: unknown[]) => spawnMock(...args) };
});

const { GodotRunner, BridgeDisconnectedError } = await import('../../src/utils/godot-runner.js');
type Runner = InstanceType<typeof GodotRunner>;

/** Fixed bridge port for the spawned-exit cases; no socket is opened there. */
const UNUSED_BRIDGE_PORT = 19987;
/** Comfortably past one 1000 ms retry delay plus the 1000 ms ping probe. */
const DISCONNECT_CASE_TIMEOUT_MS = 15000;

interface FakeChildProcess extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

/** Minimal ChildProcess stand-in: an EventEmitter with stdout/stderr streams. */
function makeFakeChildProcess(): FakeChildProcess {
  const proc = new EventEmitter() as FakeChildProcess;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

interface BridgeRecorder {
  cleanupCalls: string[];
  injectCalls: string[];
}

/** Swap the runner's BridgeManager for a recorder. Touches no filesystem. */
function stubBridge(runner: Runner): BridgeRecorder {
  const rec: BridgeRecorder = { cleanupCalls: [], injectCalls: [] };
  (runner as unknown as { bridge: unknown }).bridge = {
    inject: (projectPath: string) => {
      rec.injectCalls.push(projectPath);
    },
    cleanup: (projectPath: string) => {
      rec.cleanupCalls.push(projectPath);
    },
    readBakedPort: () => null,
    repairOrphaned: () => {},
  };
  return rec;
}

/** Read the four fields the auto-clear nulls, so assertions read as one statement. */
function sessionFields(runner: Runner): Record<string, unknown> {
  const r = runner as unknown as {
    activeSessionMode: unknown;
    activeProjectPath: unknown;
    activeBridgePort: unknown;
    activeSessionToken: unknown;
  };
  return {
    mode: r.activeSessionMode,
    projectPath: r.activeProjectPath,
    bridgePort: r.activeBridgePort,
    sessionToken: r.activeSessionToken,
  };
}

const tmp = useTmpDirs();

describe('spawned-process exit auto-clear', () => {
  let runner: Runner;
  let bridge: BridgeRecorder;
  let proc: FakeChildProcess;
  let projectPath: string;
  let savedDisplay: string | undefined;

  beforeEach(() => {
    // checkDisplayAvailable gates runProject on Linux. Nothing real is spawned
    // here, so satisfy it rather than letting the platform decide the test.
    savedDisplay = process.env.DISPLAY;
    if (process.platform === 'linux' && !process.env.DISPLAY) process.env.DISPLAY = ':0';
    proc = makeFakeChildProcess();
    spawnMock.mockReset();
    spawnMock.mockReturnValue(proc);
    runner = new GodotRunner({ godotPath: 'godot' });
    bridge = stubBridge(runner);
    projectPath = tmp.makeProject('godot-mcp-lifecycle-');
  });

  afterEach(() => {
    if (savedDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = savedDisplay;
  });

  async function start(): Promise<void> {
    await runner.runProject(projectPath, undefined, false, UNUSED_BRIDGE_PORT);
  }

  it('clears the session, cleans the bridge, and retains the process', async () => {
    await start();
    const captured = runner.activeProcess!;
    proc.stdout.emit('data', Buffer.from('hello from the game\n'));
    const profiler = { hasResult: true, close: vi.fn() };
    (runner as unknown as { activeProfiler: unknown }).activeProfiler = profiler;

    proc.emit('exit', 3);

    expect(sessionFields(runner)).toEqual({
      mode: null,
      projectPath: null,
      bridgePort: null,
      sessionToken: null,
    });
    expect(bridge.cleanupCalls).toEqual([projectPath]);
    expect(runner.activeProcess).toBe(captured);
    expect(captured.hasExited).toBe(true);
    expect(captured.exitCode).toBe(3);
    expect(captured.output.join('')).toContain('hello from the game');
    expect(runner.activeProfiler).toBe(profiler);
    expect(profiler.close).not.toHaveBeenCalled();
    expect(runner.hasActiveRuntimeSession()).toBe(false);
  });

  it('ignores an exit from a superseded session (epoch guard)', async () => {
    await start();
    const captured = runner.activeProcess!;

    // Model the window a restart opens: `runProject` bumps the epoch as its
    // first statement, then kills the old process, injects a fresh bridge
    // script, and (under `profiling: true`) awaits DebuggerProfiler.create()
    // before assigning the new `activeProcess`. Throughout that window the old
    // process is still `activeProcess`, so an identity guard does not fire —
    // only the epoch distinguishes the sessions.
    (runner as unknown as { beginSessionTransition(): number }).beginSessionTransition();
    expect(runner.activeProcess).toBe(captured);

    proc.emit('exit', 0);

    // The buffer belongs to the captured process regardless of epoch.
    expect(captured.hasExited).toBe(true);
    expect(captured.exitCode).toBe(0);
    // ...but nothing belonging to the incoming session was touched.
    expect(bridge.cleanupCalls).toEqual([]);
    expect(sessionFields(runner)).toEqual({
      mode: 'spawned',
      projectPath,
      bridgePort: UNUSED_BRIDGE_PORT,
      sessionToken: expect.any(String),
    });
  });

  it('stopProject after a self-exit reports alreadyExited with the captured logs', async () => {
    await start();
    proc.stdout.emit('data', Buffer.from('line one\n'));
    proc.stderr.emit('data', Buffer.from('SCRIPT ERROR: boom\n'));
    proc.emit('exit', 1);

    const result = await runner.stopProject();

    expect(result).not.toBeNull();
    expect(result!.alreadyExited).toBe(true);
    expect(result!.mode).toBe('spawned');
    expect(result!.exitCode).toBe(1);
    expect(result!.output.join('')).toContain('line one');
    expect(result!.errors.join('')).toContain('SCRIPT ERROR: boom');
    expect(runner.activeProcess).toBeNull();
    // The exit handler already cleaned up; stop must not clean a second time.
    expect(bridge.cleanupCalls).toEqual([projectPath]);
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it('keeps a finished profiler capture across the already-exited stop', async () => {
    await start();
    const profiler = { hasResult: true, close: vi.fn() };
    (runner as unknown as { activeProfiler: unknown }).activeProfiler = profiler;
    proc.emit('exit', 0);

    await runner.stopProject();

    expect(profiler.close).not.toHaveBeenCalled();
    expect(runner.activeProfiler).toBe(profiler);
  });

  it('closes an unfinished profiler capture across the already-exited stop', async () => {
    await start();
    const profiler = { hasResult: false, close: vi.fn() };
    (runner as unknown as { activeProfiler: unknown }).activeProfiler = profiler;
    proc.emit('exit', 0);

    await runner.stopProject();

    expect(profiler.close).toHaveBeenCalledTimes(1);
    expect(runner.activeProfiler).toBeNull();
  });

  // An McpBridge name collision is the one inject failure the user can act on,
  // so runProject must surface it instead of degrading to a bridge timeout.
  it('rethrows a bridge autoload collision instead of launching without a bridge', async () => {
    const { BridgeAutoloadCollisionError } = await import('../../src/utils/bridge-manager.js');
    (runner as unknown as { bridge: { inject: () => void } }).bridge.inject = () => {
      throw new BridgeAutoloadCollisionError('collision', 'res://game/mine.gd');
    };

    await expect(start()).rejects.toBeInstanceOf(BridgeAutoloadCollisionError);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('returns null from stopProject when there is no session and no process', async () => {
    expect(await runner.stopProject()).toBeNull();
  });

  it('still classifies stderr as runtime errors after the auto-clear', async () => {
    await start();
    proc.emit('exit', 1);
    proc.stderr.emit('data', Buffer.from('SCRIPT ERROR: post-exit line\n'));

    const errors = runner.extractRuntimeErrors(runner.getErrorsSince(0));
    expect(errors.some((l) => l.includes('SCRIPT ERROR: post-exit line'))).toBe(true);
    // The mode is null now; sendCommandWithErrors keys its classification on
    // activeProcess, which is still here.
    expect(runner.activeSessionMode).toBeNull();
    expect(runner.activeProcess).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Attached-mode disconnect
// ---------------------------------------------------------------------------

type FrameAction = { kind: 'reply'; payload: string } | { kind: 'drop' };

interface ScriptedBridge {
  port: number;
  seen: string[];
  shutdown(): Promise<void>;
}

/**
 * Loopback TCP server that answers each framed command according to `script`.
 * `drop` destroys the peer without replying, which is what a Godot process
 * that went away looks like to `sendCommand`.
 */
async function startScriptedBridge(
  script: (command: string, seenCount: number) => FrameAction,
): Promise<ScriptedBridge> {
  const seen: string[] = [];
  const peers = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    peers.add(socket);
    let rx: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      rx = Buffer.concat([rx, chunk]);
      const { frames, remainder } = parseFrames(rx);
      rx = remainder;
      for (const frame of frames) {
        const parsed = JSON.parse(frame.toString('utf8')) as { command: string };
        const action = script(parsed.command, seen.length);
        seen.push(parsed.command);
        if (action.kind === 'reply') socket.write(encodeFrame(action.payload));
        else socket.destroy();
      }
    });
    socket.on('error', () => {
      // peer teardown races are expected here
    });
    socket.on('close', () => peers.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    seen,
    shutdown() {
      return new Promise((resolve) => {
        for (const p of peers) p.destroy();
        server.close(() => resolve());
      });
    },
  };
}

const PONG = '{"status":"pong"}';
const OK = '{"ok":true}';

describe('attached-mode bridge disconnect', () => {
  let runner: Runner;
  let bridge: BridgeRecorder;
  let scripted: ScriptedBridge | null = null;
  let projectPath: string;

  beforeEach(() => {
    runner = new GodotRunner({ godotPath: 'godot' });
    bridge = stubBridge(runner);
    projectPath = tmp.makeProject('godot-mcp-attached-');
  });

  afterEach(async () => {
    runner.closeConnection();
    if (scripted) await scripted.shutdown();
    scripted = null;
  });

  function attach(port: number): void {
    const r = runner as unknown as {
      activeSessionMode: string;
      activeProjectPath: string;
      activeBridgePort: number;
      activeSessionToken: string;
    };
    r.activeSessionMode = 'attached';
    r.activeProjectPath = projectPath;
    r.activeBridgePort = port;
    r.activeSessionToken = 'test-token';
  }

  it(
    'non-retryable command whose probe fails ends the session',
    async () => {
      scripted = await startScriptedBridge(() => ({ kind: 'drop' }));
      attach(scripted.port);

      await expect(runner.sendCommandWithErrors('run_script', {})).rejects.toBeInstanceOf(
        BridgeDisconnectedError,
      );

      expect(scripted.seen).toEqual(['run_script', 'ping']);
      expect(runner.activeSessionMode).toBeNull();
      expect(runner.activeProjectPath).toBeNull();
      expect(bridge.cleanupCalls).toEqual([projectPath]);
      expect(runner.hasActiveRuntimeSession()).toBe(false);
    },
    DISCONNECT_CASE_TIMEOUT_MS,
  );

  it(
    'non-retryable command whose probe succeeds leaves the session intact',
    async () => {
      scripted = await startScriptedBridge((command) =>
        command === 'ping' ? { kind: 'reply', payload: PONG } : { kind: 'drop' },
      );
      attach(scripted.port);

      await expect(runner.sendCommandWithErrors('run_script', {})).rejects.toBeInstanceOf(
        BridgeDisconnectedError,
      );

      expect(scripted.seen).toEqual(['run_script', 'ping']);
      expect(runner.activeSessionMode).toBe('attached');
      expect(runner.activeProjectPath).toBe(projectPath);
      expect(bridge.cleanupCalls).toEqual([]);
    },
    DISCONNECT_CASE_TIMEOUT_MS,
  );

  it(
    'retryable command that succeeds on its retry never probes',
    async () => {
      scripted = await startScriptedBridge((command, seenCount) =>
        command === 'screenshot' && seenCount === 0
          ? { kind: 'drop' }
          : { kind: 'reply', payload: OK },
      );
      attach(scripted.port);

      const { response } = await runner.sendCommandWithErrors('screenshot', {});

      expect(JSON.parse(response)).toEqual({ ok: true });
      expect(scripted.seen).toEqual(['screenshot', 'screenshot']);
      expect(runner.activeSessionMode).toBe('attached');
      expect(bridge.cleanupCalls).toEqual([]);
    },
    DISCONNECT_CASE_TIMEOUT_MS,
  );

  it(
    'retryable command that fails twice then fails its probe ends the session',
    async () => {
      scripted = await startScriptedBridge(() => ({ kind: 'drop' }));
      attach(scripted.port);

      await expect(runner.sendCommandWithErrors('screenshot', {})).rejects.toBeInstanceOf(
        BridgeDisconnectedError,
      );

      expect(scripted.seen).toEqual(['screenshot', 'screenshot', 'ping']);
      expect(runner.activeSessionMode).toBeNull();
      expect(bridge.cleanupCalls).toEqual([projectPath]);
    },
    DISCONNECT_CASE_TIMEOUT_MS,
  );

  it(
    'shutdown is exempt: a disconnect during teardown never probes or clears',
    async () => {
      scripted = await startScriptedBridge(() => ({ kind: 'drop' }));
      attach(scripted.port);

      await expect(runner.sendCommandWithErrors('shutdown', {})).rejects.toBeInstanceOf(
        BridgeDisconnectedError,
      );

      expect(scripted.seen).toEqual(['shutdown']);
      expect(runner.activeSessionMode).toBe('attached');
      expect(bridge.cleanupCalls).toEqual([]);
    },
    DISCONNECT_CASE_TIMEOUT_MS,
  );
});
