/**
 * Integration test: an attached session survives a framing error on the bridge.
 *
 * A reply the client cannot frame (a header that advertises more than any
 * frame may carry) makes the runner destroy the socket, and a destroyed socket
 * still emits `close` a moment later. In attached mode the command's failure
 * is followed by a probe ping on a fresh socket; a late `close` from the old
 * socket must not settle that ping, because a failed probe ends a live
 * session and removes its bridge. The bridge here is a scripted loopback
 * server, so no Godot binary is needed and the test runs everywhere.
 *
 * Unit cover for the same defect sits at the `sendCommand` level
 * (godot-runner.sendCommand.test.ts); this one asserts the session outcome.
 */

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
import { installSession } from '../helpers/session-install.js';
import { useTmpDirs } from '../helpers/tmp.js';

const tmp = useTmpDirs();

/** Longer than a destroyed socket needs to deliver its `close`, shorter than the 1 s ping timeout. */
const LATE_PONG_DELAY_MS = 300;
/** Covers the retry delay, the probe's connect and the late pong. */
const CASE_TIMEOUT_MS = 15000;
const SESSION_TOKEN = 'test-token';
const PONG = '{"status":"pong"}';

/** A header advertising one byte more than any frame may carry. */
function oversizedFrameHeader(): Buffer {
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
  return header;
}

interface FramingBridge {
  port: number;
  seen: string[];
  shutdown(): Promise<void>;
}

/** Answers `ping` with a pong after a delay and every other command with an unreadable frame. */
async function startFramingBridge(): Promise<FramingBridge> {
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
        const { command } = JSON.parse(frame.toString('utf8')) as { command: string };
        seen.push(command);
        if (command === 'ping') {
          setTimeout(() => {
            if (!socket.destroyed) socket.write(encodeFrame(PONG));
          }, LATE_PONG_DELAY_MS);
        } else {
          socket.write(oversizedFrameHeader());
        }
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
        for (const peer of peers) peer.destroy();
        server.close(() => resolve());
      });
    },
  };
}

describe('attached session and a bridge reply that cannot be framed', () => {
  let runner: GodotRunner;
  let bridge: FramingBridge | null = null;

  beforeEach(() => {
    runner = new GodotRunner({ godotPath: 'godot' });
  });

  afterEach(async () => {
    runner.closeConnection();
    if (bridge) await bridge.shutdown();
    bridge = null;
  });

  it(
    'the command fails as a disconnect and the probe, answered late, keeps the session',
    async () => {
      bridge = await startFramingBridge();
      const projectPath = tmp.makeProject('godot-mcp-framing-');
      installSession(runner, {
        mode: 'attached',
        projectPath,
        bridgePort: bridge.port,
        token: SESSION_TOKEN,
      });

      await expect(runner.sendCommandWithErrors('run_script', {})).rejects.toBeInstanceOf(
        BridgeDisconnectedError,
      );

      // The probe reached the bridge and its pong, arriving after the old
      // socket's `close`, was read: a stale listener would have failed it.
      expect(bridge.seen).toEqual(['run_script', 'ping']);
      expect(runner.activeSessionMode).toBe('attached');
      expect(runner.activeProjectPath).toBe(projectPath);
      expect(runner.hasActiveRuntimeSession()).toBe(true);
    },
    CASE_TIMEOUT_MS,
  );
});
