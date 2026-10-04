import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as net from 'net';
import type { AddressInfo } from 'net';
import { GodotRunner, BridgeDisconnectedError } from '../../src/utils/godot-runner.js';
import {
  encodeFrame,
  parseFrames,
  FRAME_HEADER_BYTES,
  MAX_FRAME_BYTES,
} from '../../src/utils/bridge-protocol.js';
import { currentRecord, installSession } from '../helpers/session-install.js';

/** Long enough for a destroyed socket's 'close' event to have been delivered. */
const STALE_CLOSE_WINDOW_MS = 50;

/** A frame header advertising one byte more than any frame may carry. */
function oversizedFrameHeader(): Buffer {
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
  return header;
}

interface MockBridge {
  port: number;
  server: net.Server;
  /** Resolves with the JSON command string of the next frame. */
  nextFrame(): Promise<string>;
  /** Send a framed JSON response back to the most recently connected peer. */
  reply(payload: string): void;
  /** Send bytes as they are, unframed, to the most recently connected peer. */
  replyRaw(bytes: Buffer): void;
  /** Close the most recently connected peer (no response). */
  closePeer(): void;
  /** Stop accepting new connections; existing peers stay alive. */
  stopAccepting(): Promise<void>;
  /** Tear everything down. */
  shutdown(): Promise<void>;
}

async function startMockBridge(): Promise<MockBridge> {
  let currentPeer: net.Socket | null = null;
  let rxBuffer: Buffer = Buffer.alloc(0);
  const pending: ((frame: string) => void)[] = [];
  const queued: string[] = [];

  const server = net.createServer((socket) => {
    currentPeer = socket;
    rxBuffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      rxBuffer = Buffer.concat([rxBuffer, chunk]);
      const { frames, remainder } = parseFrames(rxBuffer);
      rxBuffer = remainder;
      for (const frame of frames) {
        const text = frame.toString('utf8');
        const next = pending.shift();
        if (next) next(text);
        else queued.push(text);
      }
    });
    socket.on('error', () => {
      // mock peer error: ignored
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    server,
    nextFrame() {
      const queuedFrame = queued.shift();
      if (queuedFrame !== undefined) return Promise.resolve(queuedFrame);
      return new Promise((resolve) => pending.push(resolve));
    },
    reply(payload) {
      if (!currentPeer) throw new Error('No connected peer');
      currentPeer.write(encodeFrame(payload));
    },
    replyRaw(bytes) {
      if (!currentPeer) throw new Error('No connected peer');
      currentPeer.write(bytes);
    },
    closePeer() {
      if (currentPeer) currentPeer.destroy();
      currentPeer = null;
    },
    stopAccepting() {
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
    shutdown() {
      return new Promise((resolve) => {
        if (currentPeer) currentPeer.destroy();
        server.close(() => resolve());
      });
    },
  };
}

describe('GodotRunner.sendCommand (TCP)', () => {
  let bridge: MockBridge;
  let runner: GodotRunner;

  beforeEach(async () => {
    bridge = await startMockBridge();
    runner = new GodotRunner({ godotPath: 'godot' });
    // Installed on a session record: the port is read from the current session
    // at sendCommand time, not from env.
    installSession(runner, { bridgePort: bridge.port });
  });

  afterEach(async () => {
    runner.closeConnection();
    await bridge.shutdown();
  });

  it('lazy-connects on first call and round-trips a command', async () => {
    const pending = runner.sendCommand('ping');
    const received = await bridge.nextFrame();
    expect(JSON.parse(received)).toEqual({ command: 'ping' });
    bridge.reply('{"status":"pong"}');
    const response = await pending;
    expect(JSON.parse(response)).toEqual({ status: 'pong' });
  });

  it('reuses the same socket across multiple sequential commands', async () => {
    const first = runner.sendCommand('ping');
    await bridge.nextFrame();
    bridge.reply('{"status":"pong","n":1}');
    await first;

    const second = runner.sendCommand('ping');
    await bridge.nextFrame();
    bridge.reply('{"status":"pong","n":2}');
    const r2 = JSON.parse(await second);
    expect(r2.n).toBe(2);
  });

  it('rejects a second concurrent command with "another command in flight"', async () => {
    const first = runner.sendCommand('slow');
    await bridge.nextFrame(); // ensure first has been written
    await expect(runner.sendCommand('other')).rejects.toThrow(/another command/i);
    bridge.reply('{"ok":true}');
    await first;
  });

  it('rejects with BridgeDisconnectedError when the peer closes mid-flight', async () => {
    const pending = runner.sendCommand('slow');
    await bridge.nextFrame();
    bridge.closePeer();
    await expect(pending).rejects.toBeInstanceOf(BridgeDisconnectedError);
  });

  it('timeout closes the socket; next command reconnects cleanly', async () => {
    const pending = runner.sendCommand('hangs', {}, 50);
    await bridge.nextFrame();
    await expect(pending).rejects.toThrow(/timed out/);

    // Socket is destroyed on timeout. Next command must lazy-reconnect.
    const next = runner.sendCommand('ping');
    const recv = await bridge.nextFrame();
    expect(JSON.parse(recv)).toEqual({ command: 'ping' });
    bridge.reply('{"status":"pong"}');
    await expect(next).resolves.toContain('pong');
  });

  it('late reply for a timed-out command does not poison the next command', async () => {
    // Without socket destruction on timeout, the bridge's late reply for A
    // would correlate against B's promise (since the bridge serializes
    // commands and only sees A's slot first). Closing the socket on timeout
    // forces B to a new connection, making cross-talk impossible.
    const slow = runner.sendCommand('slow', {}, 50);
    await bridge.nextFrame();
    await expect(slow).rejects.toThrow(/timed out/);

    // Simulate the bridge eventually replying for the timed-out command on
    // the now-destroyed socket. The write either errors silently or hits a
    // closed socket: either way, B must not see this payload.
    try {
      bridge.reply('{"this":"is the late slow reply"}');
    } catch {
      // expected on some platforms: the peer may already be gone
    }

    const next = runner.sendCommand('fresh');
    const recv = await bridge.nextFrame();
    expect(JSON.parse(recv)).toEqual({ command: 'fresh' });
    bridge.reply('{"this":"is the fresh reply"}');
    const r = JSON.parse(await next);
    expect(r).toEqual({ this: 'is the fresh reply' });
  });

  // A socket that delivered an unreadable frame is destroyed, and a destroyed
  // socket still emits 'close' a tick later. With its listeners left on, that
  // 'close' settled whichever command was in flight by then: in attached mode
  // the probe ping, whose failure ends a live session.
  it('an oversized frame header drops the socket without a listener left to fail the next command', async () => {
    const first = runner.sendCommand('first');
    await bridge.nextFrame();
    bridge.replyRaw(oversizedFrameHeader());
    await expect(first).rejects.toThrow(/exceeds limit/);
    await expect(first).rejects.toBeInstanceOf(BridgeDisconnectedError);

    // Sent at once, the way the attached-mode probe follows a failure.
    const next = runner.sendCommand('ping');
    const recv = await bridge.nextFrame();
    expect(JSON.parse(recv)).toEqual({ command: 'ping' });
    await new Promise((resolve) => setTimeout(resolve, STALE_CLOSE_WINDOW_MS));
    bridge.reply('{"status":"pong"}');
    await expect(next).resolves.toContain('pong');
  });

  it('a garbage frame behind a valid one drops the socket the same way', async () => {
    const first = runner.sendCommand('first');
    await bridge.nextFrame();
    // One write: a complete frame, then a header no frame may carry. The
    // parser throws on the second header before it hands back the first frame.
    bridge.replyRaw(Buffer.concat([encodeFrame('{"ok":true}'), oversizedFrameHeader()]));
    await expect(first).rejects.toThrow(/Bridge framing error/);

    const next = runner.sendCommand('ping');
    await bridge.nextFrame();
    await new Promise((resolve) => setTimeout(resolve, STALE_CLOSE_WINDOW_MS));
    bridge.reply('{"status":"pong"}');
    await expect(next).resolves.toContain('pong');
  });

  it('handles a large response (1 MiB+) that would have been truncated under UDP', async () => {
    const pending = runner.sendCommand('big');
    await bridge.nextFrame();
    const big = JSON.stringify({ blob: 'x'.repeat(1024 * 1024) });
    bridge.reply(big);
    const response = await pending;
    expect(response.length).toBe(big.length);
    expect(JSON.parse(response).blob.length).toBe(1024 * 1024);
  });

  it('connect-refused surfaces as BridgeDisconnectedError', async () => {
    // Point the runner at a port nobody is listening on.
    const r = new GodotRunner({ godotPath: 'godot' });
    installSession(r, { bridgePort: 1 });
    await expect(r.sendCommand('ping')).rejects.toBeInstanceOf(BridgeDisconnectedError);
    r.closeConnection();
  });

  it('attaches the session token field to every outgoing frame when set', async () => {
    currentRecord(runner).token = 'sekrit-token';
    const pending = runner.sendCommand('ping');
    const received = await bridge.nextFrame();
    expect(JSON.parse(received)).toEqual({ command: 'ping', token: 'sekrit-token' });
    bridge.reply('{"status":"pong"}');
    await pending;
  });

  it('omits the token field when no session token is active', async () => {
    const pending = runner.sendCommand('ping');
    const received = await bridge.nextFrame();
    expect(JSON.parse(received)).not.toHaveProperty('token');
    bridge.reply('{"status":"pong"}');
    await pending;
  });
});

describe('GodotRunner.sendCommandWithErrors reconnect (TCP)', () => {
  let bridge: MockBridge;
  let runner: GodotRunner;

  beforeEach(async () => {
    bridge = await startMockBridge();
    runner = new GodotRunner({ godotPath: 'godot' });
    installSession(runner, { bridgePort: bridge.port });
  });

  afterEach(async () => {
    runner.closeConnection();
    await bridge.shutdown();
  });

  it('retries once on BridgeDisconnectedError during an active session', async () => {
    // Simulate an active session so reconnect logic kicks in.
    currentRecord(runner).mode = 'spawned';

    const pending = runner.sendCommandWithErrors('get_ui_elements', {}, 5000);
    await bridge.nextFrame();
    // Drop the connection mid-flight to trigger BridgeDisconnectedError.
    bridge.closePeer();

    // The reconnect delay is 1s, then it retries. The mock bridge accepts
    // a new connection and receives the retry.
    const retryFrame = await bridge.nextFrame();
    expect(JSON.parse(retryFrame)).toEqual({ command: 'get_ui_elements' });
    bridge.reply('{"nodes":[]}');

    const result = await pending;
    expect(JSON.parse(result.response)).toEqual({ nodes: [] });
  }, 10000);

  it('does not retry retryable commands when no session is active', async () => {
    // activeSessionMode is null: sendCommandWithReconnect must NOT retry
    // even for normally-retryable commands like get_ui_elements.
    const pending = runner.sendCommandWithErrors('get_ui_elements', {}, 5000);
    await bridge.nextFrame();
    bridge.closePeer();
    await expect(pending).rejects.toBeInstanceOf(BridgeDisconnectedError);
  });

  it('does not retry shutdown commands', async () => {
    currentRecord(runner).mode = 'spawned';

    const pending = runner.sendCommandWithErrors('shutdown', {}, 5000);
    await bridge.nextFrame();
    bridge.closePeer();
    await expect(pending).rejects.toBeInstanceOf(BridgeDisconnectedError);
  });

  it('does not retry input commands because they are not idempotent', async () => {
    currentRecord(runner).mode = 'spawned';

    const pending = runner.sendCommandWithErrors('input', { actions: [] }, 5000);
    await bridge.nextFrame();
    bridge.closePeer();
    await expect(pending).rejects.toBeInstanceOf(BridgeDisconnectedError);
  });

  it('does not retry run_script commands because they may have side effects', async () => {
    currentRecord(runner).mode = 'spawned';

    const pending = runner.sendCommandWithErrors(
      'run_script',
      { source: 'extends RefCounted' },
      5000,
    );
    await bridge.nextFrame();
    bridge.closePeer();
    await expect(pending).rejects.toBeInstanceOf(BridgeDisconnectedError);
  });

  it('propagates error if retry also fails', async () => {
    currentRecord(runner).mode = 'spawned';

    const pending = runner.sendCommandWithErrors('get_ui_elements', {}, 5000);
    await bridge.nextFrame();
    bridge.closePeer();

    // Stop accepting connections so the retry also fails.
    await bridge.stopAccepting();

    await expect(pending).rejects.toBeInstanceOf(BridgeDisconnectedError);
  }, 10000);
});
