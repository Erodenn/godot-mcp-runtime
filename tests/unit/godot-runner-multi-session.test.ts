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

const {
  GodotRunner,
  NoLiveCurrentSessionError,
  SessionStoppedError,
  StartBudgetExhaustedError,
  START_RESPONSE_BUDGET_MS,
  sessionKey,
} = await import('../../src/utils/godot-runner.js');
const { BridgeAttachConflictError, BridgeAutoloadCollisionError, BridgeRegistryUnreadableError } =
  await import('../../src/utils/bridge-manager.js');
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
/** How long after a faked kill the fake child reports its exit. */
const EXIT_REPORT_DELAY_MS = 20;
/** Delay before a call made from outside a queued operation, so it lands while the operation runs. */
const OUTSIDE_CALL_DELAY_MS = 10;
/** `taskkill` exit status for a pid no process has. */
const TASKKILL_STATUS_NOT_FOUND = 128;
/** Longest a test waits for a bridge wait that its request's deadline is expected to cut short. */
const CUT_WAIT_CEILING_MS = 5000;
/** How long ago a start that has used up nearly all of its request's time was requested. */
const NEARLY_SPENT_REQUEST_AGE_MS = START_RESPONSE_BUDGET_MS - 1000;
/** How long a fake child's stream stays open after its exit, in the stream-end case. */
const STREAM_END_DELAY_MS = 40;
/** Pid of another server process in a faked owner record. */
const OTHER_SERVER_PID = 60001;
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
  /** Projects cleaned through `cleanupAtExit`, the entry that runs no helper program. */
  exitCleanupCalls: string[];
  injectCalls: string[];
  /** Thrown by the next prechecks, standing in for a refusal. Null: the project is healthy. */
  precheckError: Error | null;
  /** Projects whose cleanup throws, after being recorded. */
  cleanupThrowsFor: Set<string>;
}

/** Swap the runner's BridgeManager for a recorder. Touches no filesystem. */
function stubBridge(runner: Runner): BridgeRecorder {
  const rec: BridgeRecorder = {
    cleanupCalls: [],
    exitCleanupCalls: [],
    injectCalls: [],
    precheckError: null,
    cleanupThrowsFor: new Set(),
  };
  (runner as unknown as { bridge: unknown }).bridge = {
    precheckInject: () => {
      if (rec.precheckError) throw rec.precheckError;
      return '';
    },
    // As the real inject does: the precheck again, then the writes.
    inject: (projectPath: string) => {
      if (rec.precheckError) throw rec.precheckError;
      rec.injectCalls.push(projectPath);
    },
    // Returns what BridgeManager.cleanup returns: the steps it could not
    // confirm, none here.
    cleanup: (projectPath: string): string[] => {
      rec.cleanupCalls.push(projectPath);
      if (rec.cleanupThrowsFor.has(projectPath)) throw new Error('cleanup failed');
      return [];
    },
    cleanupAtExit: (projectPath: string): string[] => {
      rec.exitCleanupCalls.push(projectPath);
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

interface RecordingBridgeOptions {
  dropFirstFrame?: boolean;
  /** Commands that are recorded and never answered, the way a game busy inside one looks. */
  unanswered?: string[];
}

/**
 * Loopback bridge that records each parsed frame and answers it with a pong.
 * With `dropFirstFrame`, the first frame it ever receives is recorded and its
 * connection closed without an answer, the way a transient drop looks.
 */
async function startRecordingBridge(opts: RecordingBridgeOptions = {}): Promise<RecordingBridge> {
  const frames: Array<Record<string, unknown>> = [];
  const peers = new Set<net.Socket>();
  const unanswered = new Set(opts.unanswered ?? []);
  let connections = 0;
  let dropPending = opts.dropFirstFrame === true;
  const server = net.createServer((socket) => {
    connections += 1;
    peers.add(socket);
    let rx: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      rx = Buffer.concat([rx, chunk]);
      const parsed = parseFrames(rx);
      rx = parsed.remainder;
      for (const frame of parsed.frames) {
        const received = JSON.parse(frame.toString('utf8')) as Record<string, unknown>;
        frames.push(received);
        if (unanswered.has(String(received.command))) continue;
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

  async function startLoopback(opts: RecordingBridgeOptions = {}): Promise<RecordingBridge> {
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

  it('a restart held in its profiler await has stopped nothing and written nothing yet', async () => {
    const first = await startProject(projectA, PORT_A, { exitOnKill: false });
    let resolveProfiler: (profiler: FakeProfiler) => void = () => {};
    profilerCreateMock.mockReturnValue(
      new Promise<FakeProfiler>((done) => {
        resolveProfiler = done;
      }),
    );
    const second = makeFakeChildProcess({ exitOnKill: false });
    queuedChildren.push(second);

    // The debugger listener is one of the start's preconditions. While it is
    // pending the session being replaced is untouched: still running, still
    // current, and its bridge has not been injected over.
    const pending = runner.runProject(projectA, undefined, false, PORT_A_RERUN, true);
    await vi.waitFor(() => expect(profilerCreateMock).toHaveBeenCalledTimes(1));
    expect(first.kill).not.toHaveBeenCalled();
    expect(bridge.injectCalls).toEqual([projectA]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(runner.activeProcess?.process).toBe(first);
    expect(runner.activeBridgePort).toBe(PORT_A);

    resolveProfiler(makeFakeProfiler(false));
    await pending;

    expect(first.kill).toHaveBeenCalledTimes(1);
    expect(runner.activeProcess?.process).toBe(second);
    expect(runner.activeBridgePort).toBe(PORT_A_RERUN);
    expect(bridge.injectCalls).toEqual([projectA, projectA]);
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

    // Through the exit-time entry only: the ordinary cleanup may run a helper
    // program to judge another owner, and an exit handler must not.
    expect(bridge.exitCleanupCalls).toEqual([projectB, projectC]);
    expect(bridge.cleanupCalls).toEqual([]);
  });

  it('cleanupBridgeArtifactsSync continues past a throwing cleanup and never throws', async () => {
    await startProject(projectA, PORT_A);
    await startProject(projectB, PORT_B);
    bridge.cleanupThrowsFor.add(projectA);

    expect(() => runner.cleanupBridgeArtifactsSync()).not.toThrow();

    expect(bridge.exitCleanupCalls).toEqual([projectA, projectB]);
    expect(bridge.cleanupCalls).toEqual([]);
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
  // Spawning over this server's own attached session
  // -------------------------------------------------------------------------

  it('spawning over an attached session on the same project shuts its bridge down first', async () => {
    const loopback = await startLoopback();
    await runner.attachProject(projectA, loopback.port);
    const attachedToken = (runner as unknown as { current: { token: string } }).current.token;

    await startProject(projectA, PORT_A_RERUN);

    // The user's Godot is told to stop listening, with the attached session's
    // own token, before the spawned session takes the project.
    expect(loopback.frames).toEqual([{ command: 'shutdown', token: attachedToken }]);
    expect(runner.getSessionInfo(projectA)).toMatchObject({
      mode: 'spawned',
      bridgePort: PORT_A_RERUN,
      replacedAttached: { bridgePort: loopback.port, shutdownAcknowledged: true },
    });
  });

  it(
    'records an attached bridge that did not acknowledge the shutdown',
    async () => {
      // Nothing listens on PORT_A, so the shutdown is never answered.
      await runner.attachProject(projectA, PORT_A);

      await startProject(projectA, PORT_A_RERUN);

      expect(runner.getSessionInfo(projectA)?.replacedAttached).toEqual({
        bridgePort: PORT_A,
        shutdownAcknowledged: false,
      });
    },
    STOP_CASE_TIMEOUT_MS,
  );

  it('a spawned start that replaced nothing attached records nothing', async () => {
    await startProject(projectA, PORT_A, { exitOnKill: false });
    await startProject(projectA, PORT_A_RERUN);

    expect(runner.getSessionInfo(projectA)?.replacedAttached).toBeNull();
  });

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

  it('re-running a project kills the superseded game as a tree and spawns only after it has exited', async () => {
    const order: string[] = [];
    let first: FakeChildProcess | null = null;
    const kills = fakeWindowsTreeKill(() => {
      order.push('taskkill');
      // The exit is reported a moment after the kill, as it is for a real process.
      setTimeout(() => {
        order.push('exit');
        first?.emit('exit', null);
      }, EXIT_REPORT_DELAY_MS);
    });
    first = await startProjectWithPid(projectA, PORT_A, FAKE_GAME_PID);
    spawnMock.mockClear();
    const defaultSpawn = spawnMock.getMockImplementation()!;
    spawnMock.mockImplementation((...args: unknown[]) => {
      order.push('spawn');
      return defaultSpawn(...args);
    });

    await startProjectWithPid(projectA, PORT_A_RERUN, FAKE_OTHER_GAME_PID);

    expect(kills.taskkillPids).toEqual([String(FAKE_GAME_PID)]);
    expect(first.kill).not.toHaveBeenCalled();
    // The old game holds its bridge port until it has exited.
    expect(order).toEqual(['taskkill', 'exit', 'spawn']);
    expect(runner.getSessionInfo(projectA)?.startWarnings).toBeUndefined();
  });

  it(
    'a restart whose kill is never confirmed still starts, and says the old game may be running',
    async () => {
      // taskkill reports success and the exit never arrives.
      fakeWindowsTreeKill();
      await startProjectWithPid(projectA, PORT_A, FAKE_GAME_PID);

      await startProjectWithPid(projectA, PORT_A_RERUN, FAKE_OTHER_GAME_PID);

      const warnings = runner.getSessionInfo(projectA)?.startWarnings ?? [];
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`pid ${FAKE_GAME_PID}`);
      expect(warnings[0]).toMatch(/did not report its exit/);
    },
    STOP_CASE_TIMEOUT_MS,
  );

  it(
    'a stop whose kill is never confirmed reports killUnconfirmed with the pid',
    async () => {
      const kills = fakeWindowsTreeKill();
      await startProjectWithPid(projectA, PORT_A, FAKE_GAME_PID);

      const result = await runner.stopProject();

      // The polite stop and the forced one: both sent, neither answered.
      expect(kills.taskkillPids).toEqual([String(FAKE_GAME_PID), String(FAKE_GAME_PID)]);
      expect(result).toMatchObject({
        mode: 'spawned',
        projectPath: projectA,
        killUnconfirmed: true,
        pid: FAKE_GAME_PID,
      });
    },
    STOP_CASE_TIMEOUT_MS,
  );

  it(
    'a stop of a process taskkill reports as already gone is not an unconfirmed kill',
    async () => {
      const taskkillPids: string[] = [];
      (runner as unknown as { killTreeDeps: unknown }).killTreeDeps = {
        platform: 'win32',
        spawnSync: (_command: string, args: string[]) => {
          taskkillPids.push(args[1] ?? '');
          return { status: TASKKILL_STATUS_NOT_FOUND };
        },
        kill: () => {},
      };
      const child = await startProjectWithPid(projectA, PORT_A, FAKE_GAME_PID);

      const result = await runner.stopProject();

      expect(taskkillPids).toEqual([String(FAKE_GAME_PID)]);
      expect(child.kill).not.toHaveBeenCalled();
      expect(result).toMatchObject({ mode: 'spawned', projectPath: projectA });
      expect(result).not.toHaveProperty('killUnconfirmed');
    },
    STOP_CASE_TIMEOUT_MS,
  );

  it('a stop whose exit is observed carries no killUnconfirmed', async () => {
    let child: FakeChildProcess | null = null;
    fakeWindowsTreeKill(() => {
      queueMicrotask(() => child?.emit('exit', null));
    });
    child = await startProjectWithPid(projectA, PORT_A, FAKE_GAME_PID);

    const result = await runner.stopProject();

    expect(result).not.toHaveProperty('killUnconfirmed');
    expect(result).not.toHaveProperty('pid');
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
    // Nothing was launched, so the call must not have moved the pointer: the
    // session that was current before it is current again.
    expect(runner.getCurrentSessionInfo()).toMatchObject({ projectPath: projectA, live: true });
  });

  it('a start refused before anything is launched keeps the session that was current', async () => {
    await startProject(projectA, PORT_A);
    await startProject(projectB, PORT_B);
    runner.switchSession(projectA);
    (runner as unknown as { bridge: { inject: () => void } }).bridge.inject = () => {
      throw new BridgeAutoloadCollisionError('McpBridge is taken', 'res://game/own_bridge.gd');
    };

    await expect(runner.runProject(projectC, undefined, false, PORT_C)).rejects.toThrow(
      'McpBridge is taken',
    );

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(sessionPaths()).toEqual([projectA, projectB]);
    // A was current, not B: the pointer goes back to where it was, and the
    // other live session is not picked instead.
    expect(runner.getCurrentSessionInfo()).toMatchObject({ projectPath: projectA });
  });

  it('a failed attach keeps the session that was current', async () => {
    await startProject(projectA, PORT_A);
    (runner as unknown as { bridge: { inject: () => void } }).bridge.inject = () => {
      throw new Error('project.godot is not writable');
    };

    await expect(runner.attachProject(projectB, PORT_B)).rejects.toThrow('not writable');

    expect(sessionPaths()).toEqual([projectA]);
    expect(runner.getCurrentSessionInfo()).toMatchObject({ projectPath: projectA, live: true });
  });

  it('a failed restart of the current project leaves no session current, because the one it replaced is gone', async () => {
    await startProject(projectA, PORT_A);
    await startProject(projectB, PORT_B, { exitOnKill: false });
    spawnMock.mockImplementationOnce(() => {
      throw new Error('spawn godot ENOENT');
    });

    await expect(runner.runProject(projectB, undefined, false, PORT_B)).rejects.toThrow(
      'spawn godot ENOENT',
    );

    // B was current and the restart killed it: there is nothing to go back
    // to, and A is not promoted.
    expect(sessionPaths()).toEqual([projectA]);
    expect(runner.getCurrentSessionInfo()).toBeNull();
  });

  it('a start overtaken by a shutdown inside its profiler await launches nothing and writes nothing', async () => {
    let resolveProfiler: (profiler: FakeProfiler) => void = () => {};
    profilerCreateMock.mockReturnValue(
      new Promise<FakeProfiler>((done) => {
        resolveProfiler = done;
      }),
    );
    const profiler = makeFakeProfiler(false);

    // Held inside the profiler await: nothing registered, nothing injected.
    const pending = runner.runProject(projectA, undefined, false, PORT_A, true);
    await vi.waitFor(() => expect(profilerCreateMock).toHaveBeenCalledTimes(1));
    expect(bridge.injectCalls).toEqual([]);
    expect(runner.listSessions()).toEqual([]);

    // A server shutdown landing in that window finds no record to stop.
    await runner.stopAllSessions();

    resolveProfiler(profiler);

    // The resumed start must not go on to spawn a game after the shutdown.
    await expect(pending).rejects.toThrow(/server is shutting down.*nothing was launched/);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(profiler.close).toHaveBeenCalledTimes(1);
    expect(bridge.injectCalls).toEqual([]);
    expect(bridge.cleanupCalls).toEqual([]);
    expect(runner.listSessions()).toEqual([]);
    expect(runner.getCurrentSessionInfo()).toBeNull();
  });

  it('no start is accepted once the server has stopped everything', async () => {
    await runner.stopAllSessions();

    await expect(startProject(projectA, PORT_A)).rejects.toThrow(/server is shutting down/);
    await expect(runner.attachProject(projectB, PORT_B)).rejects.toThrow(/server is shutting down/);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(bridge.injectCalls).toEqual([]);
    expect(runner.listSessions()).toEqual([]);
  });

  it('an inject that fails fails the start at once, spawns nothing and withdraws what it wrote', async () => {
    // The owner file is written before project.godot is touched, so an inject
    // that throws there has left a live owner claim behind.
    (runner as unknown as { bridge: { inject: (path: string) => void } }).bridge.inject = (
      path: string,
    ) => {
      bridge.injectCalls.push(path);
      throw new Error('EPERM: operation not permitted, open project.godot');
    };

    await expect(runner.runProject(projectA, undefined, false, PORT_A)).rejects.toThrow(
      'EPERM: operation not permitted, open project.godot',
    );

    // No game is started to wait half a minute for a bridge that is not there.
    expect(spawnMock).not.toHaveBeenCalled();
    expect(bridge.injectCalls).toEqual([projectA]);
    expect(bridge.cleanupCalls).toEqual([projectA]);
    expect(runner.listSessions()).toEqual([]);
    expect(runner.getCurrentSessionInfo()).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Preconditions come before the session being replaced is stopped
  // -------------------------------------------------------------------------

  it('a restart whose precheck refuses leaves the running game alive and current', async () => {
    const child = await startProject(projectA, PORT_A, { exitOnKill: false });
    const record = (runner as unknown as { current: unknown }).current;
    bridge.precheckError = new BridgeRegistryUnreadableError('EACCES: owners/');

    await expect(runner.runProject(projectA, undefined, false, PORT_A_RERUN)).rejects.toThrow(
      BridgeRegistryUnreadableError,
    );

    expect(child.kill).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(bridge.injectCalls).toEqual([projectA]);
    expect(bridge.cleanupCalls).toEqual([]);
    // The same record, not a rebuilt one: still current, still live, same port.
    expect((runner as unknown as { current: unknown }).current).toBe(record);
    expect(runner.getCurrentSessionInfo()).toMatchObject({
      projectPath: projectA,
      live: true,
      bridgePort: PORT_A,
    });
  });

  it("an attach refused because another server holds the attach slot leaves this server's game running", async () => {
    const child = await startProject(projectA, PORT_A, { exitOnKill: false });
    const record = (runner as unknown as { current: unknown }).current;
    bridge.precheckError = new BridgeAttachConflictError('attached elsewhere', {
      pid: OTHER_SERVER_PID,
      instanceId: 'other-server',
      hostname: 'this-host',
      mode: 'attached',
      startedAt: new Date().toISOString(),
      port: PORT_C,
    });

    await expect(runner.attachProject(projectA, PORT_A_RERUN)).rejects.toThrow(
      BridgeAttachConflictError,
    );

    expect(child.kill).not.toHaveBeenCalled();
    expect(bridge.cleanupCalls).toEqual([]);
    expect((runner as unknown as { current: unknown }).current).toBe(record);
    expect(runner.getCurrentSessionInfo()).toMatchObject({ mode: 'spawned', live: true });
  });

  it('a spawned start whose precheck refuses does not shut down the attached bridge it would replace', async () => {
    const loopback = await startLoopback();
    await runner.attachProject(projectA, loopback.port);
    const record = (runner as unknown as { current: unknown }).current;
    bridge.precheckError = new BridgeRegistryUnreadableError('EACCES: owners/');

    await expect(runner.runProject(projectA, undefined, false, PORT_A_RERUN)).rejects.toThrow(
      BridgeRegistryUnreadableError,
    );

    // The shutdown cannot be taken back until the user restarts Godot, so it
    // is not sent for a start that was never going to happen.
    expect(loopback.frames).toEqual([]);
    expect(spawnMock).not.toHaveBeenCalled();
    expect((runner as unknown as { current: unknown }).current).toBe(record);
    expect(runner.getCurrentSessionInfo()).toMatchObject({ mode: 'attached', live: true });
  });

  // -------------------------------------------------------------------------
  // Attaching over this server's own attached session
  // -------------------------------------------------------------------------

  it('an attach over a live attached session whose bridge answers keeps that session', async () => {
    const loopback = await startLoopback();
    const first = await runner.attachProject(projectA, loopback.port);
    const record = (runner as unknown as { current: { token: string } }).current;
    const token = record.token;
    expect(first.alreadyAttached).toBe(false);
    // Another project takes the pointer, so the re-attach has to give it back.
    await startProject(projectB, PORT_B);

    const second = await runner.attachProject(projectA, PORT_A_RERUN);

    expect(second.alreadyAttached).toBe(true);
    // One ping with the session's own token; nothing was injected again, so
    // the running Godot still holds the port and token the record has.
    expect(loopback.frames).toEqual([{ command: 'ping', token }]);
    expect(bridge.injectCalls).toEqual([projectA, projectB]);
    expect(bridge.cleanupCalls).toEqual([]);
    expect((runner as unknown as { current: unknown }).current).toBe(record);
    expect(runner.describeSessionRef(second.session)).toMatchObject({
      projectPath: projectA,
      mode: 'attached',
      bridgePort: loopback.port,
      current: true,
    });
  });

  it(
    'an attach over an attached session whose bridge does not answer attaches afresh',
    async () => {
      // Nothing listens on PORT_A: the first attach never became ready.
      await runner.attachProject(projectA, PORT_A);
      const stale = (runner as unknown as { current: { token: string } }).current;

      const second = await runner.attachProject(projectA, PORT_A_RERUN);

      expect(second.alreadyAttached).toBe(false);
      expect(bridge.injectCalls).toEqual([projectA, projectA]);
      const fresh = (runner as unknown as { current: { token: string } }).current;
      expect(fresh).not.toBe(stale);
      expect(fresh.token).not.toBe(stale.token);
      expect(runner.getSessionInfo(projectA)).toMatchObject({
        mode: 'attached',
        bridgePort: PORT_A_RERUN,
      });
    },
    STOP_CASE_TIMEOUT_MS,
  );

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
    // No tool call can move the pointer while a command holds the queue. A
    // server shutdown can, so the pointer is moved underneath the command the
    // way that would: the command must still finish on the session it began on.
    const internals = runner as unknown as {
      sessions: Map<string, unknown>;
      setCurrent(session: unknown): void;
    };
    internals.setCurrent(internals.sessions.get(sessionKey(projectB)));

    const { response } = await pending;

    expect(response).toBe(PONG);
    expect(loopbackA.frames).toEqual([
      { command: 'get_ui_elements', token: TOKEN_A },
      { command: 'get_ui_elements', token: TOKEN_A },
    ]);
    expect(loopbackB.frames).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // One operation at a time
  // -------------------------------------------------------------------------

  it('two commands issued together are sent one after the other, each to the session current at its turn', async () => {
    const loopback = await startLoopback();
    installSession(runner, {
      mode: 'spawned',
      projectPath: projectA,
      bridgePort: loopback.port,
      token: TOKEN_A,
    });

    const [first, second] = await Promise.all([
      runner.sendCommandWithErrors('get_ui_elements', {}),
      runner.sendCommandWithErrors('screenshot', {}),
    ]);

    expect(first.response).toBe(PONG);
    expect(second.response).toBe(PONG);
    expect(loopback.frames.map((frame) => frame.command)).toEqual([
      'get_ui_elements',
      'screenshot',
    ]);
    // Both went down the one socket; neither was rejected as "in flight".
    expect(loopback.connectionCount()).toBe(1);
  });

  // -------------------------------------------------------------------------
  // A stop does not wait in the queue
  // -------------------------------------------------------------------------

  it('a stop issued while a command is in flight cuts the command off and does not wait for it', async () => {
    // The game never answers run_script: a wedged script. Waiting for it would
    // leave the game unstoppable for the whole command timeout.
    const loopback = await startLoopback({ unanswered: ['run_script'] });
    installSession(runner, {
      mode: 'attached',
      projectPath: projectA,
      bridgePort: loopback.port,
      token: TOKEN_A,
    });

    const outcome = runner.sendCommandWithErrors('run_script', {}).catch((error: unknown) => error);
    await vi.waitFor(() => expect(loopback.frames).toHaveLength(1));
    const stop = await runner.stopProject();
    const error = await outcome;

    expect(error).toBeInstanceOf(SessionStoppedError);
    expect(error).toMatchObject({ projectPath: projectA, command: 'run_script', cutOff: true });
    expect(stop).toMatchObject({
      mode: 'attached',
      projectPath: projectA,
      shutdownAcknowledged: true,
    });
    // The shutdown went over a connection of its own: the command socket was
    // closed under the command it carried, not reused for the teardown.
    expect(loopback.frames.map((frame) => frame.command)).toEqual(['run_script', 'shutdown']);
    expect(loopback.connectionCount()).toBe(2);
    expect(bridge.cleanupCalls).toEqual([projectA]);
    expect(runner.listSessions()).toEqual([]);
  });

  it('a command queued behind the one a stop cut off is never sent to the stopped session', async () => {
    const loopback = await startLoopback({ unanswered: ['run_script'] });
    installSession(runner, {
      mode: 'attached',
      projectPath: projectA,
      bridgePort: loopback.port,
      token: TOKEN_A,
    });

    const first = runner.sendCommandWithErrors('run_script', {}).catch((error: unknown) => error);
    await vi.waitFor(() => expect(loopback.frames).toHaveLength(1));
    const second = runner.sendCommandWithErrors('screenshot', {}).catch((error: unknown) => error);
    await runner.stopProject();

    expect(await first).toMatchObject({ name: 'SessionStoppedError', cutOff: true });
    // Its turn came the moment the first was cut off, while the stop was
    // still tearing the session down.
    expect(await second).toMatchObject({
      name: 'SessionStoppedError',
      command: 'screenshot',
      cutOff: false,
    });
    expect(loopback.frames.map((frame) => frame.command)).toEqual(['run_script', 'shutdown']);
  });

  it('a command sent to a record a stop has ended is refused as not sent, and nothing is dialed', async () => {
    const loopback = await startLoopback();
    const record = installSession(runner, {
      mode: 'attached',
      projectPath: projectA,
      bridgePort: loopback.port,
      token: TOKEN_A,
    });
    record.stopped = true;

    const error = await runner
      .sendCommandWithErrors('get_ui_elements', {})
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SessionStoppedError);
    expect(error).toMatchObject({ command: 'get_ui_elements', cutOff: false });
    expect(loopback.connectionCount()).toBe(0);
    // Not a disconnect: nothing probes the bridge or clears the session for it.
    expect(bridge.cleanupCalls).toEqual([]);
  });

  it(
    'a stop does not wait for an operation that holds the queue',
    async () => {
      const child = await startProject(projectA, PORT_A);
      let releaseHolder: () => void = () => {};
      const holder = runner.runExclusive(
        'simulate_input',
        () =>
          new Promise<void>((done) => {
            releaseHolder = done;
          }),
      );

      // The holder is still running when the stop returns.
      const stop = await runner.stopProject();

      expect(stop).toMatchObject({ mode: 'spawned', projectPath: projectA });
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(runner.listSessions()).toEqual([]);
      releaseHolder();
      await holder;
    },
    STOP_CASE_TIMEOUT_MS,
  );

  it(
    'a second stop of a session already being stopped shares the first one and kills once',
    async () => {
      const child = await startProject(projectA, PORT_A);
      const record = (runner as unknown as { current: unknown }).current;
      const internals = runner as unknown as { stopSession(session: unknown): Promise<unknown> };

      const [first, second] = await Promise.all([
        internals.stopSession(record),
        internals.stopSession(record),
      ]);

      expect(first).toMatchObject({ mode: 'spawned', projectPath: projectA });
      expect(second).toBe(first);
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(bridge.cleanupCalls).toEqual([projectA]);
    },
    STOP_CASE_TIMEOUT_MS,
  );

  it(
    'a start waiting for its bridge is told its session was stopped, not that its game exited',
    async () => {
      // Nothing listens on PORT_A, so the wait would run its whole budget. The
      // stop kills the game, so by the wait's next look the process has exited
      // as well: the stop is what has to be reported.
      const child = await startProject(projectA, PORT_A);

      const wait = runner.waitForBridge();
      await new Promise((resolve) => setTimeout(resolve, OUTSIDE_CALL_DELAY_MS));
      await runner.stopProject();
      const result = await wait;

      expect(result).toMatchObject({ ready: false, stopped: true });
      expect(result.error).not.toMatch(/exited/);
      expect(child.kill).toHaveBeenCalledTimes(1);
    },
    STOP_CASE_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // The time a start spent in the queue comes out of its bridge wait
  // -------------------------------------------------------------------------

  /** Make the queue report that the running operation was requested `ageMs` ago. */
  function stubQueueTurn(ageMs: number, waitedMs: number, behind: string | null): void {
    const queue = (runner as unknown as { queue: { turn(): unknown } }).queue;
    const requestedAt = Date.now() - ageMs;
    queue.turn = () => ({ requestedAt, waitedMs, behind });
  }

  it('a start that got its turn with too little time left is refused before anything is stopped or launched', async () => {
    const running = await startProject(projectA, PORT_A, { exitOnKill: false });
    bridge.injectCalls.length = 0;
    stubQueueTurn(NEARLY_SPENT_REQUEST_AGE_MS, NEARLY_SPENT_REQUEST_AGE_MS, 'simulate_input');

    const error = await runner
      .runProject(projectA, undefined, false, PORT_A_RERUN)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StartBudgetExhaustedError);
    expect(error).toMatchObject({
      behind: 'simulate_input',
      waitedMs: NEARLY_SPENT_REQUEST_AGE_MS,
    });
    expect(String(error)).toMatch(/Nothing was stopped or launched/);
    // The session the start would have replaced is untouched.
    expect(running.kill).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(bridge.injectCalls).toEqual([]);
    expect(bridge.cleanupCalls).toEqual([]);
    expect(runner.getCurrentSessionInfo()).toMatchObject({
      projectPath: projectA,
      bridgePort: PORT_A,
      live: true,
    });
  });

  it('an attach that got its turn with too little time left is refused the same way', async () => {
    stubQueueTurn(NEARLY_SPENT_REQUEST_AGE_MS, NEARLY_SPENT_REQUEST_AGE_MS, 'run_script');

    await expect(runner.attachProject(projectA, PORT_A)).rejects.toBeInstanceOf(
      StartBudgetExhaustedError,
    );
    expect(bridge.injectCalls).toEqual([]);
    expect(runner.listSessions()).toEqual([]);
  });

  it('a start with its whole request ahead of it is not refused', async () => {
    stubQueueTurn(0, 0, null);

    await startProject(projectA, PORT_A);

    expect(bridge.injectCalls).toEqual([projectA]);
  });

  it('a bridge wait is cut to what is left of the request, and the error says where the time went', async () => {
    await startProject(projectA, PORT_A, { exitOnKill: false });
    // Requested so long ago that the deadline has arrived: the nominal 30 s
    // wait must not run.
    stubQueueTurn(NEARLY_SPENT_REQUEST_AGE_MS, NEARLY_SPENT_REQUEST_AGE_MS, 'simulate_input');

    const started = Date.now();
    const result = await runner.waitForBridge();

    expect(result.ready).toBe(false);
    expect(Date.now() - started).toBeLessThan(CUT_WAIT_CEILING_MS);
    expect(result.error).toMatch(/The wait was cut to \d+ ms from \d+ ms/);
    expect(result.error).toContain('behind simulate_input');
  });

  // -------------------------------------------------------------------------
  // Logs handed back by a stop
  // -------------------------------------------------------------------------

  it(
    'a stop waits for the streams of an exited game to end before it hands the logs back',
    async () => {
      const child = makeFakeChildProcess({ exitOnKill: false });
      // The process reports its exit at once; its stderr delivers the rest of
      // its last line, and its end, a moment later.
      child.kill = vi.fn(() => {
        queueMicrotask(() => child.emit('exit', null));
        setTimeout(() => {
          child.stderr.emit('data', Buffer.from('half of the line\n'));
          child.stderr.emit('end');
          child.stdout.emit('end');
        }, STREAM_END_DELAY_MS);
        return true;
      });
      queuedChildren.push(child);
      await runner.runProject(projectA, undefined, false, PORT_A);
      child.stderr.emit('data', Buffer.from('first line\nthe first '));

      const stop = await runner.stopProject();

      // Flushed at the exit, the held text would be a line of its own and its
      // rest a second one.
      expect(stop?.errors).toEqual(['first line', 'the first half of the line']);
    },
    STOP_CASE_TIMEOUT_MS,
  );

  it(
    'a stop does not wait out a stream that never ends: what is held is handed back as it stands',
    async () => {
      const child = await startProject(projectA, PORT_A);
      child.stderr.emit('data', Buffer.from('first line\nno newline yet'));

      const stop = await runner.stopProject();

      expect(stop?.errors).toEqual(['first line', 'no newline yet']);
    },
    STOP_CASE_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Re-attach: only a bridge seen to be gone is replaced
  // -------------------------------------------------------------------------

  it(
    'an attach over an attached session whose bridge is listening and silent keeps that session',
    async () => {
      // Connects, and never answers the probe ping: a game that is alive and
      // busy. A fresh attach would bake a token it never reads.
      const loopback = await startLoopback({ unanswered: ['ping'] });
      await runner.attachProject(projectA, loopback.port);
      const record = (runner as unknown as { current: unknown }).current;

      const second = await runner.attachProject(projectA, PORT_A_RERUN);

      expect(second).toMatchObject({ alreadyAttached: true, existingBridge: 'silent' });
      expect(loopback.frames.map((frame) => frame.command)).toEqual(['ping']);
      expect(bridge.injectCalls).toEqual([projectA]);
      expect(bridge.cleanupCalls).toEqual([]);
      expect((runner as unknown as { current: unknown }).current).toBe(record);
      expect(runner.getSessionInfo(projectA)).toMatchObject({
        mode: 'attached',
        bridgePort: loopback.port,
      });
    },
    STOP_CASE_TIMEOUT_MS,
  );

  it('switchSession refuses to move the pointer under an operation that holds the queue', async () => {
    const loopback = await startLoopback();
    installSession(runner, { mode: 'spawned', projectPath: projectB, current: false });
    installSession(runner, {
      mode: 'spawned',
      projectPath: projectA,
      bridgePort: loopback.port,
      token: TOKEN_A,
    });

    // A call from outside the operation, made while the operation holds the
    // queue. The timer is created out here: one created inside the operation
    // would count as part of it.
    let outsideError: unknown = null;
    const outsideCall = new Promise<void>((done) => {
      setTimeout(() => {
        try {
          runner.switchSession(projectA);
        } catch (error) {
          outsideError = error;
        }
        done();
      }, OUTSIDE_CALL_DELAY_MS);
    });

    let switchedInside: unknown = null;
    await runner.runExclusive('switch_project', async () => {
      expect(() => runner.switchSession(projectB)).not.toThrow();
      switchedInside = runner.getCurrentSessionInfo()?.projectPath;
      await outsideCall;
    });

    expect(switchedInside).toBe(projectB);
    expect(String(outsideError)).toMatch(/switch_project is running/);
    expect(runner.getCurrentSessionInfo()?.projectPath).toBe(projectB);
  });
});
