import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as net from 'net';
import type { AddressInfo } from 'net';
import { GodotRunner, BridgeDisconnectedError } from '../../src/utils/godot-runner.js';
import { encodeFrame, parseFrames } from '../../src/utils/bridge-protocol.js';

interface MockBridge {
  port: number;
  server: net.Server;
  /** Resolves with the JSON command string of the next frame. */
  nextFrame(): Promise<string>;
  /** Send a framed JSON response back to the most recently connected peer. */
  reply(payload: string): void;
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
      // mock peer error — ignored
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
  let prevPort: string | undefined;

  beforeEach(async () => {
    bridge = await startMockBridge();
    prevPort = process.env.MCP_BRIDGE_PORT;
    process.env.MCP_BRIDGE_PORT = String(bridge.port);
    runner = new GodotRunner({ godotPath: 'godot' });
  });

  afterEach(async () => {
    runner.closeConnection();
    await bridge.shutdown();
    if (prevPort === undefined) delete process.env.MCP_BRIDGE_PORT;
    else process.env.MCP_BRIDGE_PORT = prevPort;
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
    // closed socket — either way, B must not see this payload.
    try {
      bridge.reply('{"this":"is the late slow reply"}');
    } catch {
      // expected on some platforms — the peer may already be gone
    }

    const next = runner.sendCommand('fresh');
    const recv = await bridge.nextFrame();
    expect(JSON.parse(recv)).toEqual({ command: 'fresh' });
    bridge.reply('{"this":"is the fresh reply"}');
    const r = JSON.parse(await next);
    expect(r).toEqual({ this: 'is the fresh reply' });
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
    process.env.MCP_BRIDGE_PORT = '1';
    const r = new GodotRunner({ godotPath: 'godot' });
    await expect(r.sendCommand('ping')).rejects.toBeInstanceOf(BridgeDisconnectedError);
    r.closeConnection();
    process.env.MCP_BRIDGE_PORT = String(bridge.port);
  });
});
