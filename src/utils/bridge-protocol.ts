/**
 * Wire format shared between the Node-side `GodotRunner.sendCommand` and the
 * GDScript-side `McpBridge` autoload.
 *
 * KEEP IN SYNC: src/scripts/mcp_bridge.gd implements the same framing on the
 * Godot side. Any change here MUST be mirrored there (and vice versa).
 *
 * Frame: 4-byte big-endian length prefix + UTF-8 JSON payload.
 * Max frame size is 16 MiB; oversize frames are rejected on receive.
 *
 * Request frame contract (additive): every request JSON payload is
 * `{ command: string, token?: string, ...params }`. `sendCommand` in
 * `godot-runner.ts` attaches the per-session auth token; the bridge rejects
 * any frame whose `token` doesn't match its configured session token (see
 * `_dispatch_command` in `mcp_bridge.gd`). This is a best-effort accident
 * guard against unauthenticated local processes finding the bridge port, not
 * a hard security boundary — see `docs/security.md`.
 */

import * as net from 'net';

export const DEFAULT_BRIDGE_PORT = 9900;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const FRAME_HEADER_BYTES = 4;
/**
 * Ceiling on how long a spawned Godot process is given to bring the bridge
 * up before `run_project` reports a timeout. `pollBridge` returns on the
 * first accepted pong, so raising this costs nothing in the healthy case -
 * it only bounds how long a genuinely broken launch takes to be reported.
 * Safe to raise furthest of the readiness budgets because `shouldAbort` in
 * `waitForBridge` aborts the moment the child process exits, so a crashed
 * launch is still reported early regardless of this ceiling.
 * `tests/helpers/run-project-or-skip.ts` already overrides this at 20000 for
 * every integration test, which is the evidence the previous 8000 was too
 * tight for the fixture project on CI hardware.
 */
export const BRIDGE_WAIT_SPAWNED_TIMEOUT_MS = 30000;

/**
 * Key the bridge sets to `true` on the error it sends in place of a reply too
 * large to frame. The command had already run by then, which is what tells
 * this error apart from a refusal: a handler that reads any `error` as "the
 * command did nothing" would tell the caller to repeat work that landed.
 *
 * KEEP IN SYNC: `OVERSIZE_RESPONSE_FIELD` in src/scripts/mcp_bridge.gd.
 */
export const OVERSIZE_RESPONSE_FIELD = 'response_too_large';

/**
 * Largest delay `setTimeout` honors. A larger value overflows its 32-bit
 * signed field and the timer fires after 1 ms instead, so a caller-supplied
 * timeout of a few months would expire at once while the work it bounds is
 * still running.
 */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
const MIN_TIMER_DELAY_MS = 1;

/**
 * A duration that is safe to hand to `setTimeout`. The one place a
 * caller-supplied timeout is bounded: every bridge command and every headless
 * child goes through it. A value that is not a number becomes the maximum,
 * which is the longest wait a timer can express.
 */
export function clampTimerDelay(ms: number): number {
  if (typeof ms !== 'number' || Number.isNaN(ms)) return MAX_TIMER_DELAY_MS;
  return Math.min(MAX_TIMER_DELAY_MS, Math.max(MIN_TIMER_DELAY_MS, Math.floor(ms)));
}

/**
 * Environment variable that gives a spawned game the port of this server's
 * parent-watch listener. Set next to `MCP_SESSION_TOKEN` and `MCP_BRIDGE_PORT`
 * for spawned sessions only: an attached Godot is the user's process and is
 * never given one.
 *
 * KEEP IN SYNC: `PARENT_WATCH_PORT_ENV` in src/scripts/mcp_bridge.gd.
 */
export const PARENT_WATCH_PORT_ENV = 'MCP_PARENT_WATCH_PORT';

/**
 * The listener a spawned game's bridge keeps one connection open to, so the
 * game can tell when this server process is gone.
 *
 * Nothing watches a parent process for a child. A server that is killed
 * outright (TerminateProcess, SIGKILL, a client that force-kills it) runs no
 * exit hook, and the game it spawned keeps running; in background mode that
 * game is hidden and cannot be focused. The operating system does close every
 * socket of a dead process, though, however it died, so a connection to the
 * server is the one signal that needs no cooperation from it. The bridge
 * writes a byte down that connection on a timer and quits the game when the
 * write fails or the connection reports closed.
 *
 * The listener only accepts and discards. It is unref'd, so it never keeps
 * the server alive, and it is never closed: it ends with the process, which
 * is the event it exists to signal.
 */
export class ParentWatchListener {
  private server: net.Server | null = null;
  private listening: Promise<number> | null = null;
  /** Open connections, kept only so `close` can end them. */
  private readonly connections = new Set<net.Socket>();

  /** Port of the listener, binding it on first use. */
  port(): Promise<number> {
    if (this.listening !== null) return this.listening;
    const pending = new Promise<number>((resolve, reject) => {
      const server = net.createServer((socket) => {
        // Heartbeat bytes are read and dropped, so the game's writes never
        // fill the socket buffer. An error here is the game going away.
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

  /**
   * Stop listening and drop every connection, which is what a game sees when
   * the server process dies. For tests; the server process never calls it.
   */
  close(): void {
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    this.server?.close();
    this.server = null;
    this.listening = null;
  }
}

/**
 * Marker the bridge prints on stderr after each simulated input action settles,
 * as `<sentinel> <action index>`. stderr is a single ordered fd, so every
 * runtime-error line an input handler wrote during an action lands before that
 * action's marker and can be attributed to it.
 *
 * KEEP IN SYNC: `ACTION_BOUNDARY_SENTINEL` in src/scripts/mcp_bridge.gd is the
 * twin of this constant. Any change here MUST be mirrored there (and vice
 * versa) or error attribution silently degrades to unattributed lines.
 */
export const ACTION_BOUNDARY_SENTINEL = 'MCP_ACTION_BOUNDARY';

const ACTION_BOUNDARY_PATTERN = new RegExp(`^${ACTION_BOUNDARY_SENTINEL} (\\d+)$`);

/**
 * One recorded sentinel. `seq` is the number of retained stderr lines that
 * preceded it, which is why a mark stays meaningful after the stderr ring
 * buffer drops older lines.
 */
export interface ActionBoundaryMark {
  index: number;
  seq: number;
}

/**
 * Recognize an action-boundary line and return its action index, or null for
 * any other stderr line.
 */
export function parseActionBoundary(line: string): number | null {
  const match = ACTION_BOUNDARY_PATTERN.exec(line.trim());
  const digits = match?.[1];
  if (digits === undefined) return null;
  return Number.parseInt(digits, 10);
}

export interface BucketBySentinelInput {
  /** Contiguous stderr lines, oldest first. */
  lines: string[];
  /** Sequence number of `lines[0]`. */
  startSeq: number;
  /** Marks recorded during the same window, in arrival order. */
  boundaries: ActionBoundaryMark[];
  /** Number of actions that actually ran, which is the bucket count. */
  executedCount: number;
}

export interface BucketBySentinelResult {
  buckets: string[][];
  trailing: string[];
}

/**
 * Split a stderr window into one bucket per executed action.
 *
 * A mark closes its action, so the bucket for `index` gets the lines between
 * the previous mark and this one. A mark whose index falls outside
 * `[0, executedCount)` is ignored. Lines at or after the last mark, and every
 * line when no mark arrived, become `trailing` for the caller to attach to the
 * last executed action. No filtering happens here: the caller applies
 * `extractRuntimeErrors` to each bucket.
 *
 * When an action's mark is missing (a partial stderr drain), its bucket stays
 * empty and its lines fall into the next mark's bucket - the two are genuinely
 * indistinguishable without the marker.
 */
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
 * Send one frame to a bridge on a connection of its own and resolve with the
 * first frame it answers. The connection is closed either way. Rejects when
 * nothing listens, the peer closes first, the reply cannot be framed, or
 * `timeoutMs` passes.
 *
 * For teardown. The runner's command socket carries one command at a time and
 * may be in the middle of one when a session has to be stopped; a `shutdown`
 * sent this way neither waits for that command nor disturbs it. The bridge
 * serves each connection by itself.
 */
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
      // An 'error' with no listener is thrown; a late one on a socket nobody
      // waits on any more must not take the server down.
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
