/**
 * A bridge connect that outlives the command that started it.
 *
 * `sendCommand` dials lazily, and a command can time out (or be rejected by a
 * session switch) while its TCP connect is still pending. Connecting to a
 * closed loopback port takes about two seconds to fail on Windows, longer than
 * the ping and shutdown timeouts, so this is an ordinary sequence there. The
 * late outcome of such a connect must not touch the command that is in flight
 * by then, which may belong to another project's session.
 *
 * `net.connect` is replaced with hand-driven sockets so the order of events is
 * the test's to choose; everything else in `net` is the real module.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { resolve } from 'path';
import type { ChildProcess } from 'child_process';
import type * as netModule from 'net';
import type { GodotProcess } from '../../src/utils/godot-runner.js';
import { encodeFrame, parseFrames } from '../../src/utils/bridge-protocol.js';
import { installSession } from '../helpers/session-install.js';

const connectMock = vi.fn();
vi.mock('net', async (importOriginal) => {
  const actual = await importOriginal<typeof netModule>();
  return { ...actual, connect: (...args: unknown[]) => connectMock(...args) };
});

const { GodotRunner } = await import('../../src/utils/godot-runner.js');
type Runner = InstanceType<typeof GodotRunner>;

const PROJECT_A = '/abandoned-connect/project-a';
const PROJECT_B = '/abandoned-connect/project-b';
const PORT_A = 19981;
const PORT_B = 19982;
const TOKEN_A = 'token-for-project-a';
const TOKEN_B = 'token-for-project-b';
const LOOPBACK_HOST = '127.0.0.1';
/** Short enough that the first command gives up while its connect is pending. */
const ABANDONED_COMMAND_TIMEOUT_MS = 20;
/** Long enough that the second command is still in flight when the stale event lands. */
const LIVE_COMMAND_TIMEOUT_MS = 2000;
/** Long enough that the connect lands first, so the command times out on a connected socket. */
const CONNECTED_COMMAND_TIMEOUT_MS = 250;
const PONG = '{"status":"pong"}';

interface FakeSocket extends EventEmitter {
  setNoDelay: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

/** A socket that connects, errors and receives data only when the test says so. */
function makeFakeSocket(): FakeSocket {
  const sock = new EventEmitter() as FakeSocket;
  sock.setNoDelay = vi.fn();
  sock.write = vi.fn();
  sock.destroy = vi.fn();
  return sock;
}

function writtenFrames(sock: FakeSocket): Array<Record<string, unknown>> {
  return sock.write.mock.calls.map((call) => {
    const { frames } = parseFrames(call[0] as Buffer);
    return JSON.parse(frames[0]!.toString('utf8')) as Record<string, unknown>;
  });
}

describe('a bridge connect abandoned by its command', () => {
  let runner: Runner;
  let staleSock: FakeSocket;
  let liveSock: FakeSocket;

  beforeEach(() => {
    connectMock.mockReset();
    staleSock = makeFakeSocket();
    liveSock = makeFakeSocket();
    connectMock.mockReturnValueOnce(staleSock).mockReturnValueOnce(liveSock);
    runner = new GodotRunner({ godotPath: 'godot' });
    installSession(runner, {
      mode: 'attached',
      projectPath: PROJECT_B,
      bridgePort: PORT_B,
      token: TOKEN_B,
      current: false,
    });
    installSession(runner, {
      mode: 'attached',
      projectPath: PROJECT_A,
      bridgePort: PORT_A,
      token: TOKEN_A,
    });
  });

  afterEach(() => {
    runner.closeConnection();
  });

  /**
   * Time a command for project A out while its connect is pending, switch to
   * project B, and leave a command for B in flight on its own pending connect.
   * The in-flight command comes back wrapped: an async function that returned
   * the promise itself would wait for it.
   */
  async function abandonConnectThenSwitch(): Promise<{ pending: Promise<string> }> {
    await expect(runner.sendCommand('ping', {}, ABANDONED_COMMAND_TIMEOUT_MS)).rejects.toThrow(
      /timed out/,
    );
    runner.switchSession(PROJECT_B);
    const pending = runner.sendCommand('get_ui_elements', {}, LIVE_COMMAND_TIMEOUT_MS);
    // A command takes its turn in the session queue, so it dials a tick later.
    await vi.waitFor(() => expect(connectMock).toHaveBeenCalledTimes(2));
    expect(connectMock).toHaveBeenNthCalledWith(1, PORT_A, LOOPBACK_HOST);
    expect(connectMock).toHaveBeenNthCalledWith(2, PORT_B, LOOPBACK_HOST);
    return { pending };
  }

  function answerOnLiveSocket(): void {
    liveSock.emit('connect');
    liveSock.emit('data', encodeFrame(PONG));
  }

  it('discards a connect that lands late instead of making it the bridge socket', async () => {
    const { pending } = await abandonConnectThenSwitch();

    staleSock.emit('connect');

    // Not installed, and the abandoned ping is never written to project A.
    expect(staleSock.destroy).toHaveBeenCalledTimes(1);
    expect(staleSock.write).not.toHaveBeenCalled();

    answerOnLiveSocket();

    await expect(pending).resolves.toBe(PONG);
    expect(writtenFrames(liveSock)).toEqual([{ command: 'get_ui_elements', token: TOKEN_B }]);
  });

  it('does not fail the command now in flight when the abandoned connect errors late', async () => {
    const { pending } = await abandonConnectThenSwitch();

    staleSock.emit('error', new Error('connect ECONNREFUSED'));

    answerOnLiveSocket();

    await expect(pending).resolves.toBe(PONG);
    expect(writtenFrames(liveSock)).toEqual([{ command: 'get_ui_elements', token: TOKEN_B }]);
  });
});

describe('a bridge connect still pending when a probe ping gives up', () => {
  const ATTACHED_PROJECT = resolve('/pending-connect/attached-project');
  const SPAWNED_PROJECT = resolve('/pending-connect/spawned-project');
  const PORT_RERUN = 19983;
  /** How long after the attach began the pending connect settles: past the 1 s probe ping. */
  const LATE_CONNECT_OUTCOME_MS = 1500;
  const CASE_TIMEOUT_MS = 10000;

  let runner: Runner;
  let firstSock: FakeSocket;
  let secondSock: FakeSocket;
  let injectCalls: string[];
  let cleanupCalls: string[];

  beforeEach(() => {
    connectMock.mockReset();
    firstSock = makeFakeSocket();
    secondSock = makeFakeSocket();
    connectMock.mockReturnValueOnce(firstSock).mockReturnValueOnce(secondSock);
    runner = new GodotRunner({ godotPath: 'godot' });
    injectCalls = [];
    cleanupCalls = [];
    (runner as unknown as { bridge: unknown }).bridge = {
      precheckInject: () => '',
      inject: (projectPath: string) => {
        injectCalls.push(projectPath);
      },
      cleanup: (projectPath: string): string[] => {
        cleanupCalls.push(projectPath);
        return [];
      },
    };
  });

  afterEach(() => {
    runner.closeConnection();
  });

  function installAttached(current: boolean): void {
    installSession(runner, {
      mode: 'attached',
      projectPath: ATTACHED_PROJECT,
      bridgePort: PORT_B,
      token: TOKEN_B,
      current,
    });
  }

  function settleLater(action: () => void): void {
    setTimeout(action, LATE_CONNECT_OUTCOME_MS);
  }

  it(
    'attaches afresh when the connect is refused only after the ping timed out',
    async () => {
      installAttached(true);
      settleLater(() => firstSock.emit('error', new Error('connect ECONNREFUSED 127.0.0.1')));

      const result = await runner.attachProject(ATTACHED_PROJECT, PORT_RERUN);

      // Nothing listens there: the session is replaced, not kept as "busy".
      expect(result.alreadyAttached).toBe(false);
      expect(injectCalls).toEqual([ATTACHED_PROJECT]);
      expect(runner.getSessionInfo(ATTACHED_PROJECT)).toMatchObject({ bridgePort: PORT_RERUN });
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'keeps the session when that connect succeeds late: a peer is there and was only slow',
    async () => {
      installAttached(true);
      settleLater(() => firstSock.emit('connect'));

      const result = await runner.attachProject(ATTACHED_PROJECT, PORT_RERUN);

      expect(result).toMatchObject({ alreadyAttached: true, existingBridge: 'silent' });
      expect(injectCalls).toEqual([]);
      // The late socket belongs to no command and is not kept.
      expect(firstSock.destroy).toHaveBeenCalledTimes(1);
      expect(firstSock.write).not.toHaveBeenCalled();
    },
    CASE_TIMEOUT_MS,
  );

  it("an exit of a game whose own command timed out leaves another session's probe alone", async () => {
    installAttached(false);
    const game: GodotProcess = {
      process: new EventEmitter() as unknown as ChildProcess,
      output: [],
      errors: [],
      totalErrorsWritten: 0,
      exitCode: null,
      hasExited: false,
      sessionToken: TOKEN_A,
    };
    const spawned = installSession(runner, {
      mode: 'spawned',
      projectPath: SPAWNED_PROJECT,
      bridgePort: PORT_A,
      token: TOKEN_A,
      process: game,
    });

    // A command to the game connects and then times out unanswered.
    const timedOut = runner
      .sendCommand('run_script', {}, CONNECTED_COMMAND_TIMEOUT_MS)
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(connectMock).toHaveBeenCalledTimes(1));
    firstSock.emit('connect');
    expect(firstSock.write).toHaveBeenCalledTimes(1);
    expect(await timedOut).toMatchObject({ message: expect.stringMatching(/timed out/) });

    // The attach probes the other project's session; its connect is pending
    // when the game exits.
    const attach = runner.attachProject(ATTACHED_PROJECT, PORT_RERUN);
    await vi.waitFor(() => expect(connectMock).toHaveBeenCalledTimes(2));
    (
      runner as unknown as {
        handleSpawnedProcessExit(s: unknown, p: GodotProcess, epoch: number, code: number): void;
      }
    ).handleSpawnedProcessExit(spawned, game, spawned.epoch, 0);
    secondSock.emit('connect');
    secondSock.emit('data', encodeFrame(PONG));

    await expect(attach).resolves.toMatchObject({
      alreadyAttached: true,
      existingBridge: 'answered',
    });
    expect(injectCalls).toEqual([]);
    expect(cleanupCalls).toEqual([SPAWNED_PROJECT]);
  });
});
