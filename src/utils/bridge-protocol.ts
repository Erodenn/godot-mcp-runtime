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

export const DEFAULT_BRIDGE_PORT = 9900;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const FRAME_HEADER_BYTES = 4;

/**
 * Resolve the bridge port. Reads `MCP_BRIDGE_PORT` from the environment, falls
 * back to {@link DEFAULT_BRIDGE_PORT}. Invalid values fall back to the default.
 */
export function getBridgePort(): number {
  const raw = process.env.MCP_BRIDGE_PORT;
  if (!raw) return DEFAULT_BRIDGE_PORT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    return DEFAULT_BRIDGE_PORT;
  }
  return parsed;
}

/**
 * Encode a JSON string as a length-prefixed frame.
 */
export function encodeFrame(payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8');
  if (body.length > MAX_FRAME_BYTES) {
    throw new Error(`Bridge frame too large: ${body.length} bytes (limit ${MAX_FRAME_BYTES})`);
  }
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body], FRAME_HEADER_BYTES + body.length);
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
