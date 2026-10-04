/**
 * Several projects running at once: one session record per project, a current
 * pointer that never moves by itself, a per-session exit epoch, and one bridge
 * socket that follows the current session.
 *
 * Same boundary as godot-runner-session-lifecycle.test.ts: `child_process.spawn`
 * is mocked so `runProject` runs its real body without a Godot binary, and
 * `BridgeManager` is replaced with a recorder. The profiler module is mocked
 * as well, so a test can hold `runProject` inside its profiler await.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as net from 'net';
import type { AddressInfo } from 'net';
import { resolve } from 'path';
import type * as childProcess from 'child_process';
import type { ChildProcess } from 'child_process';
import { encodeFrame, parseFrames } from '../../src/utils/bridge-protocol.js';
import type { GodotProcess } from '../../src/utils/godot-runner.js';
import { useTmpDirs } from '../helpers/tmp.js';
import { installSession } from '../helpers/session-install.js';

const spawnMock = vi.fn();
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  return { ...actual, spawn: (...args: unknown[]) => spawnMock(...args) };
});

const profilerCreateMock = vi.fn();
vi.mock('../../src/utils/profiler.js', () => ({
  DebuggerProfiler: { create: () => profilerCreateMock() },
}));

const { GodotRunner, NoLiveCurrentSessionError, sessionKey } =
  await import('../../src/utils/godot-runner.js');
type Runner = InstanceType<typeof GodotRunner>;
type NoLiveCurrent = InstanceType<typeof NoLiveCurrentSessionError>;

// One bridge port per project. Nothing listens on any of them: the tests that
// need a peer start a loopback bridge and use its port instead.
const PORT_A = 19971;
const PORT_B = 19972;
const PORT_C = 19973;
/** Port for the second run of project A, so a replaced session is tellable from its replacement. */
const PORT_A_RERUN = 19974;
/** Stand-in debugger port reported by the fake profiler. */
const FAKE_DEBUGGER_PORT = 19975;
/**
 * A stop sends `shutdown` to a port nobody listens on and waits out the
 * runner's own shutdown timeout per session; three sessions fit well inside.
 */
const STOP_CASE_TIMEOUT_MS = 15000;
const TOKEN_A = 'token-for-project-a';
const TOKEN_B = 'token-for-project-b';
const PONG = '{"status":"pong"}';

interface FakeChildProcess extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

/**
 * Minimal ChildProcess stand-in. With `exitOnKill`, the first `kill` queues
 * one `'exit'` in a microtask, the way a process that dies promptly looks to
 * the runner. Without it the test emits `'exit'` itself, at the moment under
 * test.
 */
function makeFakeChildProcess(opts: { exitOnKill: boolean }): FakeChildProcess {
  const proc = new EventEmitter() as FakeChildProcess;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  let exitQueued = false;
  proc.kill = vi.fn(() => {
    if (opts.exitOnKill && !exitQueued) {
      exitQueued = true;
      queueMicrotask(() => proc.emit('exit', null));
    }
    return true;
  });
  return proc;
}

interface FakeProfiler {
  port: number;
  hasResult: boolean;
  close: ReturnType<typeof vi.fn>;
}

function makeFakeProfiler(hasResult: boolean): FakeProfiler {
  return { port: FAKE_DEBUGGER_PORT, hasResult, close: vi.fn() };
}

/** A retained process that has already exited, for records installed by hand. */
function exitedProcess(exitCode: number): GodotProcess {
  return {
    process: makeFakeChildProcess({ exitOnKill: false }) as unknown as ChildProcess,
    output: [],
    errors: [],
    totalErrorsWritten: 0,
    exitCode,
    hasExited: true,
    sessionToken: 'retained-process-token',
  };
}

interface BridgeRecorder {
  cleanupCalls: string[];
  injectCalls: string[];
  /** Projects whose cleanup throws, after being recorded. */
  cleanupThrowsFor: Set<string>;
}

/** Swap the runner's BridgeManager for a recorder. Touches no filesystem. */
function stubBridge(runner: Runner): BridgeRecorder {
  const rec: BridgeRecorder = { cleanupCalls: [], injectCalls: [], cleanupThrowsFor: new Set() };
  (runner as unknown as { bridge: unknown }).bridge = {
    inject: (projectPath: string) => {
      rec.injectCalls.push(projectPath);
    },
    // Returns what BridgeManager.cleanup returns: the steps it could not
    // confirm, none here.
    cleanup: (projectPath: string): string[] => {
      rec.cleanupCalls.push(projectPath);
      if (rec.cleanupThrowsFor.has(projectPath)) throw new Error('cleanup failed');
      return [];
    },
    isBridgeAutoloadRegistered: () => false,
    listOtherLiveOwners: () => [],
    repairOrphaned: () => {},
  };
  return rec;
}

interface RecordingBridge {
  port: number;
  /** Every frame received, parsed, in arrival order. */
  frames: Array<Record<string, unknown>>;
  /** Connections accepted so far. */
  connectionCount(): number;
  shutdown(): Promise<void>;
}

/**
 * Loopback bridge that records each parsed frame and answers it with a pong.
 * With `dropFirstFrame`, the first frame it ever receives is recorded and its
 * connection closed without an answer, the way a transient drop looks.
 */
async function startRecordingBridge(
  opts: { dropFirstFrame: boolean } = { dropFirstFrame: false },
): Promise<RecordingBridge> {
  const frames: Array<Record<string, unknown>> = [];
  const peers = new Set<net.Socket>();
  let connections = 0;
  let dropPending = opts.dropFirstFrame;
  const server = net.createServer((socket) => {
    connections += 1;
    peers.add(socket);
    let rx: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      rx = Buffer.concat([rx, chunk]);
      const parsed = parseFrames(rx);
      rx = parsed.remainder;
      for (const frame of parsed.frames) {
        frames.push(JSON.parse(frame.toString('utf8')) as Record<string, unknown>);
        if (dropPending) {
          dropPending = false;
          socket.destroy();
          return;
        }
        socket.write(encodeFrame(PONG));
      }
    });
    socket.on('error', () => {
      // peer teardown races are expected here
    });
    socket.on('close', () => peers.delete(socket));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return {
    port: (server.address() as AddressInfo).port,
    frames,
    connectionCount: () => connections,
    shutdown() {
      return new Promise((done) => {
        for (const peer of peers) peer.destroy();
        server.close(() => done());
      });
    },
  };
}

const tmp = useTmpDirs();

describe('multi-project runtime sessions', () => {
  let runner: Runner;
  let bridge: BridgeRecorder;
  let queuedChildren: FakeChildProcess[];
  let loopbacks: RecordingBridge[];
  let projectA: string;
  let projectB: string;
  let projectC: string;
  let savedDisplay: string | undefined;

  beforeEach(() => {
    // checkDisplayAvailable gates runProject on Linux. Nothing real is spawned
    // here, so satisfy it rather than letting the platform decide the test.
    savedDisplay = process.env.DISPLAY;
    if (process.platform === 'linux' && !process.env.DISPLAY) process.env.DISPLAY = ':0';
    queuedChildren = [];
    loopbacks = [];
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => {
      const next = queuedChildren.shift();
      if (!next) throw new Error('spawn called with no fake child queued');
      return next;
    });
    profilerCreateMock.mockReset();
    runner = new GodotRunner({ godotPath: 'godot' });
    bridge = stubBridge(runner);
    // The runner stores resolved paths; compare against the same form.
    projectA = resolve(tmp.makeProject('godot-mcp-multi-a-'));
    projectB = resolve(tmp.makeProject('godot-mcp-multi-b-'));
    projectC = resolve(tmp.makeProject('godot-mcp-multi-c-'));
  });

  afterEach(async () => {
    if (savedDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = savedDisplay;
    runner.closeConnection();
    for (const loopback of loopbacks) await loopback.shutdown();
  });

  /** Run a project with a fresh fake child and hand the child back. */
  async function startProject(
    projectPath: string,
    port: number,
    opts: { exitOnKill: boolean } = { exitOnKill: true },
  ): Promise<FakeChildProcess> {
    const child = makeFakeChildProcess(opts);
    queuedChildren.push(child);
    await runner.runProject(projectPath, undefined, false, port);
    return child;
  }

  async function startLoopback(
    opts: { dropFirstFrame: boolean } = { dropFirstFrame: false },
  ): Promise<RecordingBridge> {
    const loopback = await startRecordingBridge(opts);
    loopbacks.push(loopback);
    return loopback;
  }

  function sessionPaths(): string[] {
    return runner.listSessions().map((info) => info.projectPath);
  }

  // -------------------------------------------------------------------------
  // Session map
  // -------------------------------------------------------------------------

  it('starting a second project keeps the first session running', async () => {
    const childA = await startProject(projectA, PORT_A);
    await startProject(projectB, PORT_B);

    expect(childA.kill).not.toHaveBeenCalled();
    expect(bridge.cleanupCalls).toEqual([]);
    expect(sessionPaths()).toEqual([projectA, projectB]);
    expect(runner.getSessionInfo(projectA)).toMatchObject({
      mode: 'spawned',
      live: true,
      current: false,
      bridgePort: PORT_A,
    });
    expect(runner.getSessionInfo(projectB)).toMatchObject({
      mode: 'spawned',
      live: true,
      current: true,
      bridgePort: PORT_B,
    });
    expect(runner.activeProjectPath).toBe(projectB);
  });

  it("re-running a project replaces only that project's session", async () => {
    // The replaced child stays silent here: what its late exit may and may
    // not do is the epoch tests' subject.
    const firstA = await startProject(projectA, PORT_A, { exitOnKill: false });
    const childB = await startProject(projectB, PORT_B);
    const secondA = await startProject(projectA, PORT_A_RERUN);

    expect(firstA.kill).toHaveBeenCalledTimes(1);
    expect(childB.kill).not.toHaveBeenCalled();
    expect(sessionPaths()).toEqual([projectA, projectB]);
    expect(runner.getSessionInfo(projectA)).toMatchObject({
      live: true,
      current: true,
      bridgePort: PORT_A_RERUN,
    });
    expect(runner.getSessionInfo(projectB)).toMatchObject({
      live: true,
      current: false,
      bridgePort: PORT_B,
    });
    expect(runner.activeProcess?.process).toBe(secondA);
  });

  it("attaching a second project leaves the first project's spawned session alone", async () => {
    const childA = await startProject(projectA, PORT_A);

    await runner.attachProject(projectB, PORT_B);

    expect(childA.kill).not.toHaveBeenCalled();
    expect(bridge.cleanupCalls).toEqual([]);
    expect(runner.getSessionInfo(projectA)).toMatchObject({
      mode: 'spawned',
      live: true,
      current: false,
    });
    expect(runner.getSessionInfo(projectB)).toMatchObject({
      mode: 'attached',
      live: true,
      current: true,
      bridgePort: PORT_B,
    });
  });

  it('session keys ignore case, separators and a trailing slash', async () => {
    expect(sessionKey('C:\\Games\\Proj\\')).toBe(sessionKey('c:/games/proj'));
    expect(sessionKey(projectA)).not.toBe(sessionKey(projectB));

    await startProject(projectA, PORT_A);

    expect(runner.getSessionInfo(`${projectA.toUpperCase()}/`)?.projectPath).toBe(projectA);
    expect(runner.hasLiveSessionOnProject(projectA.toUpperCase())).toBe(true);
  });

  it('hasLiveSessionOnProject is true for a live non-current session and false once its process exits', async () => {
    const childA = await startProject(projectA, PORT_A);
    await startProject(projectB, PORT_B);

    expect(runner.hasLiveSessionOnProject(projectA)).toBe(true);

    childA.emit('exit', 0);

    expect(runner.hasLiveSessionOnProject(projectA)).toBe(false);
    expect(runner.hasLiveSessionOnProject(projectB)).toBe(true);
    expect(runner.hasLiveSessionOnProject(projectC)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Per-session exit epoch
  // -------------------------------------------------------------------------

  it('an exit from a superseded process inside the profiler await does not clean the replacement', async () => {
    const first = await startProject(projectA, PORT_A, { exitOnKill: false });
    let resolveProfiler: (profiler: FakeProfiler) => void = () => {};
    profilerCreateMock.mockReturnValue(
      new Promise<FakeProfiler>((done) => {
        resolveProfiler = done;
      }),
    );
    const second = makeFakeChildProcess({ exitOnKill: false });
    queuedChildren.push(second);

    // With an explicit port there is no await before the profiler one, so the
    // call has run this far by the time it hands back its promise: the old
    // process killed, the bridge injected again, nothing spawned yet.
    const pending = runner.runProject(projectA, undefined, false, PORT_A_RERUN, true);
    expect(first.kill).toHaveBeenCalledTimes(1);
    expect(bridge.injectCalls).toEqual([projectA, projectA]);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    first.emit('exit', null);

    expect(bridge.cleanupCalls).toEqual([]);
    expect(runner.activeSessionMode).toBe('spawned');
    expect(runner.activeBridgePort).toBe(PORT_A_RERUN);

    resolveProfiler(makeFakeProfiler(false));
    await pending;

    expect(runner.activeProcess?.process).toBe(second);
    expect(bridge.cleanupCalls).toEqual([]);
  });

  it('an exit from a superseded process arriving after the replacement started does not clean it', async () => {
    const first = await startProject(projectA, PORT_A, { exitOnKill: false });
    const second = await startProject(projectA, PORT_A_RERUN, { exitOnKill: false });

    first.emit('exit', 0);

    expect(bridge.cleanupCalls).toEqual([]);
    expect(runner.getSessionInfo(projectA)).toMatchObject({
      mode: 'spawned',
      live: true,
      bridgePort: PORT_A_RERUN,
    });
    expect(runner.activeProcess?.process).toBe(second);
  });

  it("a project's own exit still clears it after another project started", async () => {
    const childA = await startProject(projectA, PORT_A);
    await startProject(projectB, PORT_B);

    childA.emit('exit', 3);

    expect(runner.getSessionInfo(projectA)).toMatchObject({
      mode: null,
      live: false,
      current: false,
      bridgePort: null,
      processExited: true,
      exitCode: 3,
    });
    expect(bridge.cleanupCalls).toEqual([projectA]);
    expect(runner.getSessionInfo(projectB)).toMatchObject({ live: true, current: true });
  });

  it('an exit on a non-current project does not close the bridge socket', async () => {
    const loopbackB = await startLoopback();
    const childA = await startProject(projectA, PORT_A);
    await startProject(projectB, loopbackB.port);
    await runner.sendCommand('ping');
    const closeSpy = vi.spyOn(runner, 'closeConnection');

    childA.emit('exit', 0);

    expect(closeSpy).not.toHaveBeenCalled();
    // The socket to B is the same one: the next command needs no new connect.
    await runner.sendCommand('ping');
    expect(loopbackB.connectionCount()).toBe(1);
    expect(loopbackB.frames).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Stop, and no fallback to another session
  // -------------------------------------------------------------------------

  it(
    'stopProject stops the current session only and leaves current empty',
    async () => {
      const childA = await startProject(projectA, PORT_A);
      const childB = await startProject(projectB, PORT_B);

      const result = await runner.stopProject();

      expect(result).toMatchObject({ mode: 'spawned', projectPath: projectB });
      expect(childB.kill).toHaveBeenCalledTimes(1);
      expect(childA.kill).not.toHaveBeenCalled();
      expect(bridge.cleanupCalls).toEqual([projectB]);
      expect(runner.getSessionInfo(projectB)).toBeNull();
      expect(runner.getSessionInfo(projectA)).toMatchObject({ live: true, current: false });
      expect(runner.getCurrentSessionInfo()).toBeNull();
      expect(runner.activeSessionMode).toBeNull();
      expect(runner.hasActiveRuntimeSession()).toBe(false);
    },
    STOP_CASE_TIMEOUT_MS,
  );

  it(
    'a runtime command with no current session rejects with NoLiveCurrentSessionError naming the live session',
    async () => {
      await startProject(projectA, PORT_A);
      await startProject(projectB, PORT_B);
      await runner.stopProject();

      const failure: unknown = await runner
        .sendCommandWithErrors('get_ui_elements', {})
        .catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(NoLiveCurrentSessionError);
      const { status, message } = failure as NoLiveCurrent;
      expect(status.state).toBe('none');
      expect(status.current).toBeNull();
      expect(status.otherLiveSessions.map((info) => info.projectPath)).toEqual([projectA]);
      expect(message).toContain(projectA);
    },
    STOP_CASE_TIMEOUT_MS,
  );

  it(
    'current stays empty until switchSession names a session',
    async () => {
      await startProject(projectA, PORT_A);
      await startProject(projectB, PORT_B);
      await runner.stopProject();

      expect(runner.getRuntimeSessionStatus().state).toBe('none');
      expect(() => runner.requireLiveCurrentSession()).toThrow(NoLiveCurrentSessionError);
      expect(runner.activeProcess).toBeNull();
      expect(runner.activeProjectPath).toBeNull();

      expect(runner.switchSession(projectA)).toMatchObject({
        projectPath: projectA,
        live: true,
        current: true,
      });
      expect(runner.requireLiveCurrentSession().projectPath).toBe(projectA);
      expect(runner.activeProjectPath).toBe(projectA);
    },
    STOP_CASE_TIMEOUT_MS,
  );

  it('switchSession returns null for a project with no session and leaves current unchanged', async () => {
    await startProject(projectA, PORT_A);

    expect(runner.switchSession(projectB)).toBeNull();
    expect(runner.getCurrentSessionInfo()?.projectPath).toBe(projectA);
  });

  it('switchSession closes the socket and the next command dials the new session with its token', async () => {
    const loopbackA = await startLoopback();
    const loopbackB = await startLoopback();
    installSession(runner, {
      mode: 'attached',
      projectPath: projectA,
      bridgePort: loopbackA.port,
      token: TOKEN_A,
      current: false,
    });
    installSession(runner, {
      mode: 'attached',
      projectPath: projectB,
      bridgePort: loopbackB.port,
      token: TOKEN_B,
    });
    await runner.sendCommand('ping');
    expect(loopbackB.frames).toEqual([{ command: 'ping', token: TOKEN_B }]);
    const closeSpy = vi.spyOn(runner, 'closeConnection');

    expect(runner.switchSession(projectA)).toMatchObject({ projectPath: projectA, current: true });

    expect(closeSpy).toHaveBeenCalledTimes(1);
    await runner.sendCommand('ping');
    expect(loopbackA.frames).toEqual([{ command: 'ping', token: TOKEN_A }]);
    expect(loopbackB.frames).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // The current session's game exits by itself
  // -------------------------------------------------------------------------

  it('a self-exit of the current session is reported with the other live session listed', async () => {
    await startProject(projectA, PORT_A);
    const childB = await startProject(projectB, PORT_B);
    childB.stdout.emit('data', Buffer.from('last words from B\n'));

    childB.emit('exit', 3);

    let failure: unknown = null;
    try {
      runner.requireLiveCurrentSession();
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeInstanceOf(NoLiveCurrentSessionError);
    const { status, message } = failure as NoLiveCurrent;
    expect(status.state).toBe('exited');
    expect(status.current).toMatchObject({ projectPath: projectB, exitCode: 3, live: false });
    expect(status.otherLiveSessions.map((info) => info.projectPath)).toEqual([projectA]);
    expect(message).toContain('exited with code 3');
    expect(message).toContain(projectA);
    // The exited session is still the current one, so its logs read at once.
    expect(runner.activeProcess?.output.join('')).toContain('last words from B');
    expect(runner.activeSessionMode).toBeNull();
  });

  it('retained logs survive switching away and back', async () => {
    await startProject(projectA, PORT_A);
    const childB = await startProject(projectB, PORT_B);
    childB.stdout.emit('data', Buffer.from('last words from B\n'));
    childB.emit('exit', 3);

    expect(runner.switchSession(projectA)).toMatchObject({ live: true, current: true });
    expect(runner.switchSession(projectB)).toMatchObject({
      live: false,
      current: true,
      hasRetainedLogs: true,
      processExited: true,
      exitCode: 3,
    });
    const logs = runner.readSessionLogs(projectB);
    expect(logs).toMatchObject({ hasExited: true, exitCode: 3 });
    expect(logs?.output.join('')).toContain('last words from B');

    const result = await runner.stopProject();

    expect(result).toMatchObject({ alreadyExited: true, projectPath: projectB, exitCode: 3 });
    expect(result?.output.join('')).toContain('last words from B');
    expect(runner.getSessionInfo(projectB)).toBeNull();
    expect(runner.readSessionLogs(projectB)).toBeNull();
    expect(runner.getSessionInfo(projectA)).toMatchObject({ live: true, current: false });
  });

  // -------------------------------------------------------------------------
  // Process-exit cleanup and shutdown
  // -------------------------------------------------------------------------

  it('cleanupBridgeArtifactsSync visits every session that still holds artifacts', async () => {
    const childA = await startProject(projectA, PORT_A);
    await startProject(projectB, PORT_B);
    await runner.attachProject(projectC, PORT_C);
    // A's own exit already removed A's artifacts; it is not visited again.
    childA.emit('exit', 0);
    expect(bridge.cleanupCalls).toEqual([projectA]);
    bridge.cleanupCalls.length = 0;

    runner.cleanupBridgeArtifactsSync();

    expect(bridge.cleanupCalls).toEqual([projectB, projectC]);
  });

  it('cleanupBridgeArtifactsSync continues past a throwing cleanup and never throws', async () => {
    await startProject(projectA, PORT_A);
    await startProject(projectB, PORT_B);
    bridge.cleanupThrowsFor.add(projectA);

    expect(() => runner.cleanupBridgeArtifactsSync()).not.toThrow();

    expect(bridge.cleanupCalls).toEqual([projectA, projectB]);
  });

  it(
    'stopAllSessions stops every session and empties the map',
    async () => {
      const childA = await startProject(projectA, PORT_A);
      const childB = await startProject(projectB, PORT_B);
      await runner.attachProject(projectC, PORT_C);

      await runner.stopAllSessions();

      expect(childA.kill).toHaveBeenCalledTimes(1);
      expect(childB.kill).toHaveBeenCalledTimes(1);
      expect(bridge.cleanupCalls).toEqual([projectA, projectB, projectC]);
      expect(runner.listSessions()).toEqual([]);
      expect(runner.getCurrentSessionInfo()).toBeNull();
    },
    STOP_CASE_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Games are killed as a process tree
  // -------------------------------------------------------------------------

  /** A pid for a fake child; nothing real is signalled, the OS calls are faked. */
  const FAKE_GAME_PID = 43210;
  const FAKE_OTHER_GAME_PID = 43211;

  /** Replace the runner's OS kill calls with recorders for a Windows host. */
  function fakeWindowsTreeKill(onTaskkill: () => void = () => {}): { taskkillPids: string[] } {
    const taskkillPids: string[] = [];
    (runner as unknown as { killTreeDeps: unknown }).killTreeDeps = {
      platform: 'win32',
      spawnSync: (_command: string, args: string[]) => {
        taskkillPids.push(args[1] ?? '');
        onTaskkill();
        return { status: 0 };
      },
      kill: () => {},
    };
    return { taskkillPids };
  }

  async function startProjectWithPid(
    projectPath: string,
    port: number,
    pid: number,
    opts: { exitOnKill: boolean } = { exitOnKill: false },
  ): Promise<FakeChildProcess> {
    const child = makeFakeChildProcess(opts);
    (child as unknown as { pid: number }).pid = pid;
    queuedChildren.push(child);
    await runner.runProject(projectPath, undefined, false, port);
    return child;
  }

  it(
    'stopProject kills the spawned game as a tree, not the one pid it holds',
    async () => {
      // The tree kill is what ends the process; report the exit as it would.
      let child: FakeChildProcess | null = null;
      const kills = fakeWindowsTreeKill(() => {
        queueMicrotask(() => child?.emit('exit', null));
      });
      child = await startProjectWithPid(projectA, PORT_A, FAKE_GAME_PID);

      const result = await runner.stopProject();

      expect(result).toMatchObject({ mode: 'spawned', projectPath: projectA });
      expect(kills.taskkillPids).toEqual([String(FAKE_GAME_PID)]);
      // taskkill succeeded, so the bare single-pid kill was never needed.
      expect(child.kill).not.toHaveBeenCalled();
    },
    STOP_CASE_TIMEOUT_MS,
  );

  it('re-running a project kills the superseded game as a tree', async () => {
    const kills = fakeWindowsTreeKill();
    const first = await startProjectWithPid(projectA, PORT_A, FAKE_GAME_PID);

    await startProjectWithPid(projectA, PORT_A_RERUN, FAKE_OTHER_GAME_PID);

    expect(kills.taskkillPids).toEqual([String(FAKE_GAME_PID)]);
    expect(first.kill).not.toHaveBeenCalled();
  });

  it('killSpawnedProcessesSync kills every running spawned game and leaves the rest alone', async () => {
    const kills = fakeWindowsTreeKill();
    const exited = await startProjectWithPid(projectA, PORT_A, FAKE_GAME_PID);
    await startProjectWithPid(projectB, PORT_B, FAKE_OTHER_GAME_PID);
    await runner.attachProject(projectC, PORT_C);
    exited.emit('exit', 0);

    runner.killSpawnedProcessesSync();

    // A already exited and C is not this server's process: only B is killed.
    expect(kills.taskkillPids).toEqual([String(FAKE_OTHER_GAME_PID)]);
  });

  it('killSpawnedProcessesSync never throws, and goes on to the next game', async () => {
    const taskkillPids: string[] = [];
    (runner as unknown as { killTreeDeps: unknown }).killTreeDeps = {
      platform: 'win32',
      spawnSync: (_command: string, args: string[]) => {
        taskkillPids.push(args[1] ?? '');
        throw new Error('taskkill is not available');
      },
      kill: () => {},
    };
    const childA = await startProjectWithPid(projectA, PORT_A, FAKE_GAME_PID);
    const childB = await startProjectWithPid(projectB, PORT_B, FAKE_OTHER_GAME_PID);
    childA.kill.mockImplementation(() => {
      throw new Error('kill EPERM');
    });

    expect(() => runner.killSpawnedProcessesSync()).not.toThrow();

    expect(taskkillPids).toEqual([String(FAKE_GAME_PID), String(FAKE_OTHER_GAME_PID)]);
    // With taskkill unavailable the single process is still killed.
    expect(childB.kill).toHaveBeenCalledTimes(1);
  });

  it('stopAllSessions releases a finished profiler capture kept by an exited session', async () => {
    // A stop of an already-exited session keeps a finished capture readable.
    // At shutdown nothing will read it, so the record must not outlive the call.
    const profiler = makeFakeProfiler(true);
    installSession(runner, { projectPath: projectA, process: exitedProcess(0), profiler });

    await runner.stopAllSessions();

    expect(profiler.close).toHaveBeenCalledTimes(1);
    expect(runner.listSessions()).toEqual([]);
    expect(runner.getCurrentSessionInfo()).toBeNull();
    expect(bridge.cleanupCalls).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // A start that fails
  // -------------------------------------------------------------------------

  it('a start that throws leaves no session behind', async () => {
    spawnMock.mockImplementation(() => {
      throw new Error('spawn godot ENOENT');
    });

    await expect(runner.runProject(projectA, undefined, false, PORT_A)).rejects.toThrow(
      'spawn godot ENOENT',
    );

    expect(runner.listSessions()).toEqual([]);
    expect(runner.getCurrentSessionInfo()).toBeNull();
    expect(bridge.injectCalls).toEqual([projectA]);
    // The bridge it injected has no session left to remove it later.
    expect(bridge.cleanupCalls).toEqual([projectA]);
  });

  it("a failed start on one project leaves another project's session untouched", async () => {
    const childA = await startProject(projectA, PORT_A);
    spawnMock.mockImplementationOnce(() => {
      throw new Error('spawn godot ENOENT');
    });

    await expect(runner.runProject(projectB, undefined, false, PORT_B)).rejects.toThrow(
      'spawn godot ENOENT',
    );

    expect(childA.kill).not.toHaveBeenCalled();
    expect(sessionPaths()).toEqual([projectA]);
    expect(runner.getSessionInfo(projectA)).toMatchObject({ live: true, bridgePort: PORT_A });
    expect(bridge.cleanupCalls).toEqual([projectB]);
    // The failed start had taken the current pointer and nothing is promoted
    // into its place.
    expect(runner.getCurrentSessionInfo()).toBeNull();
  });

  it('a start that is stopped inside its profiler await launches nothing and removes its bridge', async () => {
    let resolveProfiler: (profiler: FakeProfiler) => void = () => {};
    profilerCreateMock.mockReturnValue(
      new Promise<FakeProfiler>((done) => {
        resolveProfiler = done;
      }),
    );
    const profiler = makeFakeProfiler(false);

    // Held inside the profiler await: injected, nothing spawned yet.
    const pending = runner.runProject(projectA, undefined, false, PORT_A, true);
    expect(bridge.injectCalls).toEqual([projectA]);

    // A server shutdown landing in that window finds a record with no process.
    await runner.stopAllSessions();
    expect(runner.listSessions()).toEqual([]);

    resolveProfiler(profiler);

    await expect(pending).rejects.toThrow(/stopped or replaced while it was starting/);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(profiler.close).toHaveBeenCalledTimes(1);
    expect(bridge.cleanupCalls).toEqual([projectA]);
    expect(runner.listSessions()).toEqual([]);
    expect(runner.getCurrentSessionInfo()).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Paths and ports a command may reach
  // -------------------------------------------------------------------------

  it("replacing a session through a differently spelled path removes the replaced spelling's bridge artifacts", async () => {
    const first = await startProject(projectA, PORT_A, { exitOnKill: false });
    // Same session key, different string. On a case-sensitive filesystem this
    // can be another directory, so the replaced one must not keep its bridge.
    const respelled = projectA.toUpperCase();

    await startProject(respelled, PORT_A_RERUN, { exitOnKill: false });

    expect(first.kill).toHaveBeenCalledTimes(1);
    expect(bridge.cleanupCalls).toEqual([projectA]);
    expect(sessionPaths()).toEqual([respelled]);
  });

  it('a command for a current session whose game exited is rejected for lack of a bridge port', async () => {
    const childA = await startProject(projectA, PORT_A);
    childA.emit('exit', 1);

    // The record keeps no port, and no default port stands in for it.
    await expect(runner.sendCommandWithErrors('run_script', {})).rejects.toThrow(/no bridge port/);
  });

  it('a retried command stays on the session it started on when current changes during the reconnect delay', async () => {
    const loopbackA = await startLoopback({ dropFirstFrame: true });
    const loopbackB = await startLoopback();
    installSession(runner, {
      mode: 'spawned',
      projectPath: projectB,
      bridgePort: loopbackB.port,
      token: TOKEN_B,
      current: false,
    });
    installSession(runner, {
      mode: 'spawned',
      projectPath: projectA,
      bridgePort: loopbackA.port,
      token: TOKEN_A,
    });

    const pending = runner.sendCommandWithErrors('get_ui_elements', {});
    await vi.waitFor(() => expect(loopbackA.frames).toHaveLength(1));
    runner.switchSession(projectB);

    const { response } = await pending;

    expect(response).toBe(PONG);
    expect(loopbackA.frames).toEqual([
      { command: 'get_ui_elements', token: TOKEN_A },
      { command: 'get_ui_elements', token: TOKEN_A },
    ]);
    expect(loopbackB.frames).toEqual([]);
  });
});
