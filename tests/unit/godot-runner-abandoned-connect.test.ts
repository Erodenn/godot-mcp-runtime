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
import type * as netModule from 'net';
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
