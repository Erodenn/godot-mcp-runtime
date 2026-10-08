// Wire format shared with the McpBridge autoload: 4-byte big-endian length prefix + UTF-8 JSON payload, max 16 MiB.
// KEEP IN SYNC: src/scripts/mcp_bridge.gd implements the same framing; the session token is an accident guard, not a security boundary (docs/security.md).

import * as net from 'net';

export const DEFAULT_BRIDGE_PORT = 9900;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const FRAME_HEADER_BYTES = 4;
/** Ceiling on how long a spawned Godot is given to bring the bridge up; `waitForBridge` aborts as soon as the child exits, so raising it only bounds a broken launch. */
export const BRIDGE_WAIT_SPAWNED_TIMEOUT_MS = 30000;

// Key the bridge sets true on the error it sends in place of a reply too large to frame; the command already ran, unlike a refusal.
// KEEP IN SYNC: `OVERSIZE_RESPONSE_FIELD` in src/scripts/mcp_bridge.gd.
export const OVERSIZE_RESPONSE_FIELD = 'response_too_large';

// The `error` the bridge answers with for a missing or wrong token; the readiness wait reads it to tell a bridge from another session's.
// KEEP IN SYNC: `UNAUTHORIZED_ERROR` in src/scripts/mcp_bridge.gd.
export const BRIDGE_UNAUTHORIZED_ERROR = 'Unauthorized: invalid or missing session token';

// Key the bridge sets on a reply that sent INF/NAN as null, holding how many; the reader strips it.
// KEEP IN SYNC: `NON_FINITE_COUNT_FIELD` in src/scripts/mcp_bridge.gd.
export const NON_FINITE_COUNT_FIELD = 'non_finite_count';

/** The warning for a reply whose numbers were not all finite, or null; a count that is not a positive whole number counts as none. */
export function nonFiniteWarning(count: unknown): string | null {
  if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0) return null;
  return `${count} non-finite numbers (INF, NAN) were returned as null`;
}

/** Remove the non-finite count from a parsed reply and return its warning, or null; the field never reaches a payload. */
export function takeNonFiniteWarning(reply: object): string | null {
  const record = reply as Record<string, unknown>;
  const warning = nonFiniteWarning(record[NON_FINITE_COUNT_FIELD]);
  delete record[NON_FINITE_COUNT_FIELD];
  return warning;
}

/** Largest delay `setTimeout` honors; a larger value overflows and fires after 1 ms. */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
const MIN_TIMER_DELAY_MS = 1;

/** A duration safe for `setTimeout`, the one bound on caller-supplied timeouts; a non-number becomes the maximum. */
export function clampTimerDelay(ms: number): number {
  if (typeof ms !== 'number' || Number.isNaN(ms)) return MAX_TIMER_DELAY_MS;
  return Math.min(MAX_TIMER_DELAY_MS, Math.max(MIN_TIMER_DELAY_MS, Math.floor(ms)));
}

// Gives a spawned game the port of this server's parent-watch listener; never set for an attached Godot, which is the user's process.
// KEEP IN SYNC: `PARENT_WATCH_PORT_ENV` in src/scripts/mcp_bridge.gd.
export const PARENT_WATCH_PORT_ENV = 'MCP_PARENT_WATCH_PORT';

/** Listener a spawned game's bridge holds a connection to, so the game can tell its server died without running an exit hook (the OS closes a dead process's sockets). It accepts and discards, is unref'd, and is never closed. */
export class ParentWatchListener {
  private server: net.Server | null = null;
  private listening: Promise<number> | null = null;
  private readonly connections = new Set<net.Socket>();

  port(): Promise<number> {
    if (this.listening !== null) return this.listening;
    const pending = new Promise<number>((resolve, reject) => {
      const server = net.createServer((socket) => {
        // Heartbeat bytes are dropped so the game's writes never fill the buffer; an error is the game going away.
        socket.on('error', () => {});
        socket.on('close', () => this.connections.delete(socket));
        this.connections.add(socket);
        socket.resume();
        socket.unref();
      });
      server.once('error', (error) => {
        this.listening = null;
        reject(error);
      });
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          this.listening = null;
          server.close();
          reject(new Error('Failed to determine the parent-watch port'));
          return;
        }
        server.unref();
        this.server = server;
        resolve(address.port);
      });
    });
    this.listening = pending;
    return pending;
  }

  /** Stop listening and drop every connection. For tests only. */
  close(): void {
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    this.server?.close();
    this.server = null;
    this.listening = null;
  }
}

// Marker the bridge prints on stderr after each input action settles, as `<sentinel> <action index>`; one ordered fd lets error lines be attributed to the action before the marker.
// KEEP IN SYNC: `ACTION_BOUNDARY_SENTINEL` in src/scripts/mcp_bridge.gd; a mismatch silently degrades attribution.
export const ACTION_BOUNDARY_SENTINEL = 'MCP_ACTION_BOUNDARY';

const ACTION_BOUNDARY_PATTERN = new RegExp(`^${ACTION_BOUNDARY_SENTINEL} (\\d+)$`);

/** One recorded sentinel; `seq` is the retained stderr lines before it, so it survives the ring trim. */
export interface ActionBoundaryMark {
  index: number;
  seq: number;
}

/** The action index of an action-boundary line, or null for any other stderr line. */
export function parseActionBoundary(line: string): number | null {
  const match = ACTION_BOUNDARY_PATTERN.exec(line.trim());
  const digits = match?.[1];
  if (digits === undefined) return null;
  return Number.parseInt(digits, 10);
}

export interface BucketBySentinelInput {
  lines: string[];
  startSeq: number;
  boundaries: ActionBoundaryMark[];
  executedCount: number;
}

export interface BucketBySentinelResult {
  buckets: string[][];
  trailing: string[];
}

/** Split a stderr window into one bucket per executed action: a mark closes its action. Out-of-range marks are ignored; lines after the last mark (or all, with no marks) are `trailing`. A missing mark leaves its bucket empty and its lines fall into the next mark's. No filtering here. */
export function bucketBySentinel({
  lines,
  startSeq,
  boundaries,
  executedCount,
}: BucketBySentinelInput): BucketBySentinelResult {
  const buckets: string[][] = Array.from({ length: Math.max(0, executedCount) }, () => []);
  const endSeq = startSeq + lines.length;
  const sliceBySeq = (fromSeq: number, toSeq: number): string[] => {
    const lo = Math.max(0, fromSeq - startSeq);
    const hi = Math.min(lines.length, toSeq - startSeq);
    return hi > lo ? lines.slice(lo, hi) : [];
  };

  let prevSeq = startSeq;
  for (const boundary of boundaries) {
    if (boundary.index < 0 || boundary.index >= buckets.length) continue;
    const seq = Math.max(prevSeq, boundary.seq);
    buckets[boundary.index] = sliceBySeq(prevSeq, seq);
    prevSeq = seq;
  }

  return { buckets, trailing: sliceBySeq(prevSeq, endSeq) };
}

/** Find a free TCP port by binding port 0 and closing; a collision in the window before the consumer listens surfaces as a bridge readiness failure. */
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
    // One-shot: fires only before listen() succeeds; no later error is possible from this server.
    srv.on('error', reject);
  });
}

/** Send one frame on a connection of its own and resolve with the first reply frame, for teardown: a `shutdown` neither waits for the runner's command socket nor disturbs it. Rejects on no listener, early close, unframeable reply or timeout. */
export function requestOnce(port: number, payload: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let received: Buffer = Buffer.alloc(0);
    let settled = false;
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      // An 'error' with no listener is thrown; a late one must not take the server down.
      socket.on('error', () => {});
      socket.destroy();
      finish();
    };
    const timer = setTimeout(() => {
      settle(() => reject(new Error(`No reply from the bridge within ${timeoutMs}ms`)));
    }, clampTimerDelay(timeoutMs));
    socket.once('connect', () => {
      socket.setNoDelay(true);
      socket.write(encodeFrame(payload));
    });
    socket.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      try {
        const first = parseFrames(received).frames[0];
        if (first !== undefined) settle(() => resolve(first.toString('utf8')));
      } catch (error) {
        settle(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    });
    socket.on('error', (error: Error) => settle(() => reject(error)));
    socket.on('close', () =>
      settle(() => reject(new Error('The bridge closed the connection before replying'))),
    );
  });
}

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

/** Pull complete frames from a streaming buffer, returning the partial tail as `remainder`. Throws if a header advertises more than {@link MAX_FRAME_BYTES}; the caller closes the socket. */
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
