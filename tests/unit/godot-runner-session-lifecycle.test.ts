/** `child_process.spawn` is mocked so `runProject` runs its real body (including the `'exit'` registration under test) without Godot.
 * BridgeManager is a recorder, so cleanup calls are observable and nothing is written outside the tmp project. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as net from 'net';
import type { AddressInfo } from 'net';
import type * as childProcess from 'child_process';
import { encodeFrame, parseFrames } from '../../src/utils/bridge-protocol.js';
import { useTmpDirs } from '../helpers/tmp.js';
import { currentRecord, installSession } from '../helpers/session-install.js';
import type { RuntimeSession } from '../../src/utils/godot-runner.js';

const spawnMock = vi.fn();
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  return { ...actual, spawn: (...args: unknown[]) => spawnMock(...args) };
});

const { GodotRunner, BridgeDisconnectedError } = await import('../../src/utils/godot-runner.js');
type Runner = InstanceType<typeof GodotRunner>;

const UNUSED_BRIDGE_PORT = 19987;
/** Comfortably past one 1000 ms retry delay plus the 1000 ms ping probe. */
const DISCONNECT_CASE_TIMEOUT_MS = 15000;

interface FakeChildProcess extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

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
  cleanupProblems: string[];
}

function stubBridge(runner: Runner): BridgeRecorder {
  const rec: BridgeRecorder = { cleanupCalls: [], injectCalls: [], cleanupProblems: [] };
  (runner as unknown as { bridge: unknown }).bridge = {
    precheckInject: () => '',
    inject: (projectPath: string) => {
      rec.injectCalls.push(projectPath);
    },
    cleanup: (projectPath: string) => {
      rec.cleanupCalls.push(projectPath);
      return [...rec.cleanupProblems];
    },
    isBridgeAutoloadRegistered: () => false,
    listOtherLiveOwners: () => [],
    repairOrphaned: () => {},
  };
  return rec;
}

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
  let scripted: ScriptedBridge | null = null;

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

  afterEach(async () => {
    if (savedDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = savedDisplay;
    runner.closeConnection();
    if (scripted) await scripted.shutdown();
    scripted = null;
  });

  async function start(): Promise<void> {
    await runner.runProject(projectPath, undefined, false, UNUSED_BRIDGE_PORT);
  }

  it('clears the session, cleans the bridge, and retains the process', async () => {
    await start();
    const captured = runner.activeProcess!;
    proc.stdout.emit('data', Buffer.from('hello from the game\n'));
    const profiler = { hasResult: true, close: vi.fn() };
    currentRecord(runner).profiler = profiler as unknown as RuntimeSession['profiler'];

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

    // Models the window a restart opens: the old process is still `activeProcess` while the epoch is bumped and a new
    // profiler is awaited, so an identity guard does not fire and only the epoch distinguishes the sessions.
    const internals = runner as unknown as {
      beginSessionTransition(session: RuntimeSession): number;
    };
    internals.beginSessionTransition(currentRecord(runner));
    expect(runner.activeProcess).toBe(captured);

    proc.emit('exit', 0);

    expect(captured.hasExited).toBe(true);
    expect(captured.exitCode).toBe(0);
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
    expect(bridge.cleanupCalls).toEqual([projectPath]);
    expect(proc.kill).not.toHaveBeenCalled();
  });

  // Nobody is listening when a game exits by itself, so what that cleanup
  // could not confirm has to survive until the stop that reports it.
  it('a cleanup problem at process exit is kept for the later stop', async () => {
    const problem = 'the McpBridge autoload entry could not be removed from project.godot (EPERM)';
    await start();
    bridge.cleanupProblems = [problem];
    proc.emit('exit', 1);
    // The stop does not clean again, so a later change must not reach its result.
    bridge.cleanupProblems = [];

    const result = await runner.stopProject();

    expect(result!.alreadyExited).toBe(true);
    expect(result!.cleanupProblems).toEqual([problem]);
    expect(bridge.cleanupCalls).toEqual([projectPath]);
  });

  it('an exit whose cleanup was complete leaves no problem for the later stop', async () => {
    await start();
    proc.emit('exit', 0);

    const result = await runner.stopProject();

    expect(result!.cleanupProblems).toEqual([]);
  });

  it('a stop of a running process carries what its own cleanup could not confirm', async () => {
    const problem = 'the bridge script could not be removed (EBUSY)';
    await start();
    bridge.cleanupProblems = [problem];
    // A process that exits as soon as it is asked to, so the stop does not
    // sit out its kill grace period.
    proc.kill.mockImplementation(() => {
      proc.emit('exit', 0);
      return true;
    });

    const result = await runner.stopProject();

    expect(result!.mode).toBe('spawned');
    expect(result!.alreadyExited).toBeUndefined();
    expect(result!.cleanupProblems).toEqual([problem]);
    expect(bridge.cleanupCalls).toEqual([projectPath]);
  });

  it('keeps a finished profiler capture across the already-exited stop', async () => {
    await start();
    const profiler = { hasResult: true, close: vi.fn() };
    currentRecord(runner).profiler = profiler as unknown as RuntimeSession['profiler'];
    proc.emit('exit', 0);

    await runner.stopProject();

    expect(profiler.close).not.toHaveBeenCalled();
    expect(runner.activeProfiler).toBe(profiler);
  });

  // What is left is a record holding only the capture; the next stop releases it, which did something: a result, not the null that means "nothing to stop".
  it('a second stop releases the retained capture and reports that it did', async () => {
    await start();
    const profiler = { hasResult: true, close: vi.fn() };
    currentRecord(runner).profiler = profiler as unknown as RuntimeSession['profiler'];
    proc.emit('exit', 0);
    await runner.stopProject();

    const second = await runner.stopProject();

    expect(second).toEqual({
      mode: 'spawned',
      projectPath: expect.any(String),
      output: null,
      errors: null,
      alreadyExited: true,
      cleanupProblems: [],
      releasedCaptureOnly: true,
    });
    expect(profiler.close).toHaveBeenCalledTimes(1);
    expect(runner.activeProfiler).toBeNull();
    expect(runner.listSessions()).toEqual([]);
    expect(await runner.stopProject()).toBeNull();
  });

  it('closes an unfinished profiler capture across the already-exited stop', async () => {
    await start();
    const profiler = { hasResult: false, close: vi.fn() };
    currentRecord(runner).profiler = profiler as unknown as RuntimeSession['profiler'];
    proc.emit('exit', 0);

    await runner.stopProject();

    expect(profiler.close).toHaveBeenCalledTimes(1);
    expect(runner.activeProfiler).toBeNull();
  });

  it('rethrows a bridge autoload collision instead of launching without a bridge', async () => {
    const { BridgeAutoloadCollisionError } = await import('../../src/utils/bridge-manager.js');
    (runner as unknown as { bridge: { inject: () => void } }).bridge.inject = () => {
      throw new BridgeAutoloadCollisionError('collision', 'res://game/mine.gd');
    };

    await expect(start()).rejects.toBeInstanceOf(BridgeAutoloadCollisionError);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  // An owner registry that cannot be read makes inject refuse; launching anyway would end as a bridge timeout that blames something else.
  it('rethrows an unreadable owner registry instead of launching without a bridge', async () => {
    const { BridgeRegistryUnreadableError } = await import('../../src/utils/bridge-manager.js');
    (runner as unknown as { bridge: { inject: () => void } }).bridge.inject = () => {
      throw new BridgeRegistryUnreadableError('cannot read owners/1-a.json: EBUSY');
    };

    await expect(start()).rejects.toBeInstanceOf(BridgeRegistryUnreadableError);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(runner.activeSessionMode).toBeNull();
  });

  it('returns null from stopProject when there is no session and no process', async () => {
    expect(await runner.stopProject()).toBeNull();
  });

  // The spawn-failure path is a second writer of the stderr buffer; it must use the same ingestion as real stderr,
  // or every later getErrorsSince / sentinel window is off by one.
  it('counts a spawn failure line the same way a stderr line is counted', async () => {
    await start();
    const marker = runner.getErrorCount();

    proc.emit('error', new Error('spawn godot ENOENT'));

    expect(runner.getErrorsSince(marker).join('\n')).toContain('Process error: spawn godot ENOENT');
    proc.stderr.emit('data', Buffer.from('SCRIPT ERROR: after the failure\n'));
    expect(runner.getErrorsSince(marker)).toEqual([
      'Process error: spawn godot ENOENT',
      'SCRIPT ERROR: after the failure',
    ]);
  });

  it('sendCommandWithErrors still classifies post-exit stderr as runtime errors, keyed on activeProcess', async () => {
    // Exercises sendCommandWithErrors itself: a direct extractRuntimeErrors call is unconditional and would stay green if the key reverted to activeSessionMode.
    // The stderr line is written after the command took its marker: the post-exit ordering under test.
    scripted = await startScriptedBridge(() => {
      proc.stderr.emit('data', Buffer.from('SCRIPT ERROR: post-exit line\n'));
      return { kind: 'reply', payload: OK };
    });
    await start();

    proc.emit('exit', 1);
    expect(runner.activeSessionMode).toBeNull();
    expect(runner.activeProcess).not.toBeNull();

    // The auto-clear nulls activeBridgePort/activeSessionToken, so they point at the scripted bridge only after the exit
    // (activeProcess survives, so a caller could still reach a bridge command).
    currentRecord(runner).bridgePort = scripted.port;
    currentRecord(runner).token = 'test-token';

    const { runtimeErrors } = await runner.sendCommandWithErrors('get_ui_elements', {});

    expect(runtimeErrors.some((l) => l.includes('SCRIPT ERROR: post-exit line'))).toBe(true);
  });
});

type FrameAction = { kind: 'reply'; payload: string } | { kind: 'drop' } | { kind: 'hold' };

interface ScriptedBridge {
  port: number;
  seen: string[];
  shutdown(): Promise<void>;
}

/** Loopback TCP server answering framed commands per `script`; `drop` destroys the peer without replying, `hold` keeps it open and silent. */
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
        else if (action.kind === 'drop') socket.destroy();
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
const SHUTTING_DOWN = '{"status":"shutting_down"}';
const UNAUTHORIZED = '{"error":"Unauthorized: invalid or missing session token"}';

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
    installSession(runner, {
      mode: 'attached',
      projectPath,
      bridgePort: port,
      token: 'test-token',
    });
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
    'a probe that times out does not end the session: the game is alive and not answering',
    async () => {
      // The command's connection is dropped, then the probe ping is never answered: a timeout, not a disconnect,
      // and only a disconnect says the bridge is gone.
      scripted = await startScriptedBridge((command) =>
        command === 'ping' ? { kind: 'hold' } : { kind: 'drop' },
      );
      attach(scripted.port);

      await expect(runner.sendCommandWithErrors('run_script', {})).rejects.toBeInstanceOf(
        BridgeDisconnectedError,
      );

      expect(scripted.seen).toEqual(['run_script', 'ping']);
      expect(runner.activeSessionMode).toBe('attached');
      expect(runner.activeProjectPath).toBe(projectPath);
      expect(runner.hasActiveRuntimeSession()).toBe(true);
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

  // A status ping already is the probe's question; a stop sends `shutdown` over a connection of its own, the only frame the bridge receives.
  it(
    'ping is exempt: a status ping that meets a disconnect is not probed again and clears nothing',
    async () => {
      scripted = await startScriptedBridge(() => ({ kind: 'drop' }));
      attach(scripted.port);

      await expect(runner.sendCommandWithErrors('ping', {})).rejects.toBeInstanceOf(
        BridgeDisconnectedError,
      );

      expect(scripted.seen).toEqual(['ping']);
      expect(runner.activeSessionMode).toBe('attached');
      expect(bridge.cleanupCalls).toEqual([]);
    },
    DISCONNECT_CASE_TIMEOUT_MS,
  );

  // The detach goes ahead either way; the stop must not imply the bridge in the still-running Godot stopped listening.
  it(
    'an attached stop records an unacknowledged shutdown',
    async () => {
      scripted = await startScriptedBridge(() => ({ kind: 'drop' }));
      attach(scripted.port);

      const result = await runner.stopProject();

      expect(scripted.seen).toEqual(['shutdown']);
      expect(result).toMatchObject({ mode: 'attached', shutdownAcknowledged: false });
      expect(bridge.cleanupCalls).toEqual([projectPath]);
      expect(runner.activeSessionMode).toBeNull();
    },
    DISCONNECT_CASE_TIMEOUT_MS,
  );

  it(
    'an attached stop records an acknowledged shutdown',
    async () => {
      scripted = await startScriptedBridge(() => ({ kind: 'reply', payload: SHUTTING_DOWN }));
      attach(scripted.port);

      const result = await runner.stopProject();

      expect(result).toMatchObject({
        mode: 'attached',
        shutdownAcknowledged: true,
        cleanupProblems: [],
      });
    },
    DISCONNECT_CASE_TIMEOUT_MS,
  );

  it(
    'a refusal from the bridge is a reply, not an acknowledgement',
    async () => {
      scripted = await startScriptedBridge(() => ({ kind: 'reply', payload: UNAUTHORIZED }));
      attach(scripted.port);

      const result = await runner.stopProject();

      expect(result).toMatchObject({ mode: 'attached', shutdownAcknowledged: false });
    },
    DISCONNECT_CASE_TIMEOUT_MS,
  );

  it(
    'an attached stop carries what its cleanup could not confirm',
    async () => {
      const problem = 'the bridge owner registry could not be read (EACCES)';
      scripted = await startScriptedBridge(() => ({ kind: 'reply', payload: SHUTTING_DOWN }));
      attach(scripted.port);
      bridge.cleanupProblems = [problem];

      const result = await runner.stopProject();

      expect(result!.cleanupProblems).toEqual([problem]);
    },
    DISCONNECT_CASE_TIMEOUT_MS,
  );

  // The disconnect clear deletes the record, so no later stop_project can
  // report what its cleanup left behind. The error is the last place to say it.
  it(
    'a disconnect that ends the session puts an incomplete cleanup on the error it throws',
    async () => {
      const problem =
        'the McpBridge autoload entry could not be removed from project.godot (EPERM)';
      scripted = await startScriptedBridge(() => ({ kind: 'drop' }));
      attach(scripted.port);
      bridge.cleanupProblems = [problem];

      const failure = await runner.sendCommandWithErrors('run_script', {}).catch((e: unknown) => e);

      expect(failure).toBeInstanceOf(BridgeDisconnectedError);
      expect((failure as Error).message).toContain('Bridge cleanup was incomplete');
      expect((failure as Error).message).toContain(problem);
      expect(runner.activeSessionMode).toBeNull();
    },
    DISCONNECT_CASE_TIMEOUT_MS,
  );
});

describe('an attach whose bridge injection fails', () => {
  const ATTACH_PORT = 19988;
  let runner: Runner;
  let bridge: BridgeRecorder;
  let projectPath: string;

  beforeEach(() => {
    runner = new GodotRunner({ godotPath: 'godot' });
    bridge = stubBridge(runner);
    projectPath = tmp.makeProject('godot-mcp-attach-fail-');
  });

  function failInject(message: string): void {
    (runner as unknown as { bridge: { inject: (path: string) => void } }).bridge.inject = (
      path: string,
    ) => {
      bridge.injectCalls.push(path);
      throw new Error(message);
    };
  }

  // inject writes its owner file before it touches .gitignore and project.godot, so a throw there leaves a live owner claim;
  // without cleanup every other server is told a session runs here until this one exits.
  it('withdraws what the injection left on the project, with no earlier session', async () => {
    failInject('EPERM: operation not permitted, open project.godot');

    await expect(runner.attachProject(projectPath, ATTACH_PORT)).rejects.toThrow(/EPERM/);

    expect(bridge.injectCalls).toEqual([projectPath]);
    expect(bridge.cleanupCalls).toEqual([projectPath]);
    expect(runner.listSessions()).toEqual([]);
    expect(runner.getCurrentSessionInfo()).toBeNull();
  });

  it('says so on the error when that cleanup could not be confirmed', async () => {
    const problem = "this session's bridge owner file could not be removed (EBUSY)";
    failInject('EPERM: operation not permitted, open project.godot');
    bridge.cleanupProblems = [problem];

    const failure = await runner.attachProject(projectPath, ATTACH_PORT).catch((e: unknown) => e);

    expect((failure as Error).message).toMatch(/EPERM/);
    expect((failure as Error).message).toContain('Bridge cleanup was incomplete');
    expect((failure as Error).message).toContain(problem);
  });
});

describe('spawn options reach child_process.spawn', () => {
  const EDITOR_PID = 4242;
  const SPAWN_OPTIONS_ARG = 2;
  const SPAWN_CASE_BRIDGE_PORT = 19988;
  let savedDisplay: string | undefined;

  beforeEach(() => {
    savedDisplay = process.env.DISPLAY;
    if (process.platform === 'linux' && !process.env.DISPLAY) process.env.DISPLAY = ':0';
    spawnMock.mockReset();
  });

  afterEach(() => {
    if (savedDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = savedDisplay;
  });

  function spawnOptions(): Record<string, unknown> {
    return spawnMock.mock.calls[0]![SPAWN_OPTIONS_ARG] as Record<string, unknown>;
  }

  it('launchEditor drains both pipes', () => {
    const child = {
      pid: EDITOR_PID,
      stdout: { resume: vi.fn() },
      stderr: { resume: vi.fn() },
      on: vi.fn(),
    };
    spawnMock.mockReturnValue(child);
    const runner = new GodotRunner({ godotPath: 'godot' });

    const returned = runner.launchEditor('/some/project');

    expect(returned).toBe(child);
    expect(child.stdout.resume).toHaveBeenCalledTimes(1);
    expect(child.stderr.resume).toHaveBeenCalledTimes(1);
  });

  it('launchEditor keeps piped stdio and never asks for a hidden window', () => {
    spawnMock.mockReturnValue({
      pid: EDITOR_PID,
      stdout: { resume: vi.fn() },
      stderr: { resume: vi.fn() },
      on: vi.fn(),
    });
    const runner = new GodotRunner({ godotPath: 'godot' });

    runner.launchEditor('/some/project');

    expect(spawnOptions()).toEqual({ stdio: 'pipe' });
  });

  it('runProject keeps piped stdio and never asks for a hidden window', async () => {
    spawnMock.mockReturnValue(makeFakeChildProcess());
    const runner = new GodotRunner({ godotPath: 'godot' });
    stubBridge(runner);

    const projectPath = tmp.makeProject('godot-mcp-spawn-');
    await runner.runProject(projectPath, undefined, false, SPAWN_CASE_BRIDGE_PORT);

    const options = spawnOptions();
    expect(options.stdio).toBe('pipe');
    expect(options).not.toHaveProperty('windowsHide');
    expect(options.env).toMatchObject({ MCP_BRIDGE_PORT: String(SPAWN_CASE_BRIDGE_PORT) });
  });

  it('runProject with background hides the window and sets MCP_BACKGROUND', async () => {
    spawnMock.mockReturnValue(makeFakeChildProcess());
    const runner = new GodotRunner({ godotPath: 'godot' });
    stubBridge(runner);

    const projectPath = tmp.makeProject('godot-mcp-spawn-');
    await runner.runProject(projectPath, undefined, true, SPAWN_CASE_BRIDGE_PORT);

    const options = spawnOptions();
    expect(options.stdio).toBe('pipe');
    expect(options.windowsHide).toBe(true);
    expect(options.env).toMatchObject({ MCP_BACKGROUND: '1' });
  });

  it('a headless spawn hides its console window', async () => {
    const proc = makeFakeChildProcess();
    spawnMock.mockReturnValue(proc);
    const runner = new GodotRunner({ godotPath: 'godot' });

    const pending = runner.getVersion();
    proc.stdout.emit('data', Buffer.from('4.7.2.stable.official\n'));
    proc.emit('close', 0);

    expect(await pending).toBe('4.7.2.stable.official');
    expect(spawnOptions()).toEqual({
      stdio: 'pipe',
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
  });
});
