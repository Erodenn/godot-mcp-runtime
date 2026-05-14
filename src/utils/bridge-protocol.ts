/**
 * Wire format shared between the Node-side `GodotRunner.sendCommand` and the
 * GDScript-side `McpBridge` autoload.
 *
 * KEEP IN SYNC: src/scripts/mcp_bridge.gd implements the same framing on the
 * Godot side. Any change here MUST be mirrored there (and vice versa).
 *
 * Frame: 4-byte big-endian length prefix + UTF-8 JSON payload.
 * Max frame size is 16 MiB; oversize frames are rejected on receive.
 */

import * as net from 'net';

export const DEFAULT_BRIDGE_PORT = 9900;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const FRAME_HEADER_BYTES = 4;

/**
 * Find an available TCP port by binding to port 0 (OS-assigned ephemeral port),
 * reading the assigned port, and closing the listener. The brief TOCTOU window
 * between close and the consumer's listen is acceptable — if a collision occurs,
 * the bridge readiness check will surface the failure.
 */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close();
        reject(new Error('Failed to determine assigned port'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    // One-shot: only fires before listen() succeeds. If listen succeeded,
    // we proceed to srv.close() in the listening callback — a later error
    // is not possible from this server, so the listener stays safely dormant.
    srv.on('error', reject);
  });
}

/**
 * Encode a JSON string as a length-prefixed frame.
 */
export function encodeFrame(payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8');
  if (body.length > MAX_FRAME_BYTES) {
    throw new Error(`Bridge frame too large: ${body.length} bytes (limit ${MAX_FRAME_BYTES})`);
  }
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, FRAME_HEADER_BYTES);
  return frame;
}

export interface ParseFramesResult {
  frames: Buffer[];
  remainder: Buffer;
}

/**
 * Pull as many complete frames as possible from a streaming buffer. Any
 * partial frame at the tail is returned as `remainder` for the next call.
 *
 * Throws if a header advertises a payload larger than {@link MAX_FRAME_BYTES} —
 * the caller should treat this as a fatal protocol error and close the socket.
 */
export function parseFrames(buffer: Buffer): ParseFramesResult {
  const frames: Buffer[] = [];
  let offset = 0;

  while (buffer.length - offset >= FRAME_HEADER_BYTES) {
    const len = buffer.readUInt32BE(offset);
    if (len > MAX_FRAME_BYTES) {
      throw new Error(
        `Bridge frame header advertises ${len} bytes, exceeds limit ${MAX_FRAME_BYTES}`,
      );
    }
    const frameStart = offset + FRAME_HEADER_BYTES;
    const frameEnd = frameStart + len;
    if (buffer.length < frameEnd) break;
    frames.push(buffer.subarray(frameStart, frameEnd));
    offset = frameEnd;
  }

  const remainder = offset === 0 ? buffer : buffer.subarray(offset);
  return { frames, remainder };
}
