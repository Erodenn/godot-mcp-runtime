/**
 * Receiver for Godot's own remote-debugger profiler stream.
 *
 * `run_project({ profiling: true })` binds this listener first and passes
 * `--remote-debug tcp://127.0.0.1:<port>` to the spawned engine, so the
 * measurements are the stock editor ones — no engine build, no addon, and
 * nothing injected into the project. Attached sessions cannot profile: the
 * debugger channel only exists if it was on the command line at launch.
 *
 * Godot pauses the game on a script error or `breakpoint` while a debugger is
 * connected, so every `debug_enter` is answered with `continue` — profiling
 * must never turn a runtime error into a frozen window.
 */

import * as net from 'net';
import { decodeVariant, encodeVariant, MAX_PACKET_BYTES, type Variant } from './godot-variant.js';
import { logDebug } from './logger.js';

export type ProfilerErrorCode =
  | 'bad_args'
  | 'profile_busy'
  | 'profile_not_started'
  | 'profile_timeout'
  | 'profile_disconnected';

export class ProfilerError extends Error {
  constructor(
    readonly code: ProfilerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProfilerError';
  }
}

export type ProfileSort = 'selfMs' | 'totalMs' | 'calls';

export const PROFILE_SORTS: readonly ProfileSort[] = ['selfMs', 'totalMs', 'calls'];
export const PROFILE_MAX_SECONDS = 60;
export const CAPTURE_LIMIT_MIN = 16;
export const CAPTURE_LIMIT_MAX = 512;
export const PROFILE_TOP_MAX = 100;

/** Bound on the rows kept for the slowest frame — a full frame is unbounded. */
const WORST_FRAME_ROWS = 30;
/** Every engine row is `[signature id, calls, self, total, internal]`. */
const ROW_STRIDE = 5;

const WAIT_CONNECT_MS = 5000;
const WAIT_FIRST_FRAME_MS = 5000;
const WAIT_TOTAL_MS = 10000;

export interface ProfilePeak {
  frame: number;
  calls: number;
  selfMs: number;
  totalMs: number;
}

export interface ProfileRow {
  signature: string;
  function: string;
  file: string;
  line: number;
  sourceResolved: boolean;
  calls: number;
  selfMs: number;
  totalMs: number;
  callsPerFrame: number;
  selfMsPerFrame: number;
  totalMsPerFrame: number;
  msPerCall: number;
  /** Inclusive share of an average frame, the editor's "Frame %" measure. */
  percentOfFrame: number;
  peak: ProfilePeak | null;
}

/** Average and worst value of one per-frame measurement across the capture. */
export interface ProfileStat {
  avg: number;
  max: number;
}

/** The engine's own frame breakdown — the editor's "Frame Time" category. */
export interface FrameTimings {
  frameMs: number;
  processMs: number;
  physicsMs: number;
  physicsFrameMs: number;
  scriptMs: number;
}

export interface ProfileServer {
  name: string;
  msPerFrame: number;
  functions: Array<{ name: string; msPerFrame: number }>;
}

export interface ProfileStartResult {
  active: boolean;
  maxSeconds: number;
  firstFrame: number | null;
  captureLimit: number;
}

export interface ProfileResult {
  seconds: number;
  frames: number;
  framesReceived: number;
  firstFrame: number | null;
  lastFrame: number | null;
  frameGaps: number;
  captureLimit: number;
  limitReached: boolean;
  sort: ProfileSort;
  functionsReceived: number;
  unresolvedFunctions: number;
  /** Per-frame engine breakdown, averaged over the capture and at its worst. */
  frame: Record<keyof FrameTimings, ProfileStat>;
  /** Server-side timings (physics, audio, …), averaged per frame. */
  servers: ProfileServer[];
  rows: ProfileRow[];
  worstFrame: ({ frame: number } & FrameTimings & { rows: FrameRow[] }) | null;
}

/** One function's numbers inside a single received frame. */
interface FrameRow {
  signature: string;
  function: string;
  file: string;
  line: number;
  sourceResolved: boolean;
  calls: number;
  selfMs: number;
  totalMs: number;
}

interface Capture {
  limit: number;
  startedAt: number;
  elapsedMs: number;
  /** Frames folded into the totals (excludes the discarded boundary frame). */
  frames: number;
  framesReceived: number;
  frameGaps: number;
  firstFrame: number | null;
  lastFrame: number | null;
  capped: boolean;
  totals: Map<string, FrameRow>;
  peaks: Map<string, ProfilePeak>;
  timingSums: FrameTimings;
  timingMax: FrameTimings;
  /** server name → function name → summed milliseconds. */
  servers: Map<string, Map<string, number>>;
  worst: ({ frame: number } & FrameTimings & { rows: FrameRow[] }) | null;
  result: FrameRow[] | null;
}

type ProfilerState = 'idle' | 'starting' | 'capturing' | 'stopping' | 'finished';

interface Waiter {
  predicate: () => boolean;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function asNumber(value: Variant | undefined): number {
  if (typeof value !== 'number') throw new Error('Expected a number in a profiler frame');
  return value;
}

/** Trim float noise from the summary — these are milliseconds, not physics. */
function roundNumbers<T>(value: T): T {
  if (typeof value === 'number') return (Math.round(value * 1e4) / 1e4) as T;
  if (Array.isArray(value)) return value.map(roundNumbers) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, roundNumbers(inner)]),
    ) as T;
  }
  return value;
}

const noTimings = (): FrameTimings => ({
  frameMs: 0,
  processMs: 0,
  physicsMs: 0,
  physicsFrameMs: 0,
  scriptMs: 0,
});

/** One received frame, in the same three parts the editor's tree shows. */
interface FrameSample {
  frame: number;
  timings: FrameTimings;
  servers: Array<{ name: string; functions: Array<{ name: string; ms: number }> }>;
  rows: FrameRow[];
}

/**
 * Split the engine's per-frame array. Layout: six timing fields, a server
 * count, that many `name, entryCount, ...name/time pairs` blocks, then the
 * flattened function rows preceded by their own length.
 */
function parseFrame(data: Variant[], signatures: Map<number, string>): FrameSample {
  const timings: FrameTimings = {
    frameMs: asNumber(data[1]) * 1000,
    processMs: asNumber(data[2]) * 1000,
    physicsMs: asNumber(data[3]) * 1000,
    physicsFrameMs: asNumber(data[4]) * 1000,
    scriptMs: asNumber(data[5]) * 1000,
  };
  const servers: FrameSample['servers'] = [];
  let offset = 7;
  for (let i = 0; i < asNumber(data[6]); i++) {
    const name = data[offset];
    const entries = asNumber(data[offset + 1]);
    const functions: Array<{ name: string; ms: number }> = [];
    for (let j = offset + 2; j < offset + 2 + entries; j += 2) {
      functions.push({ name: String(data[j]), ms: asNumber(data[j + 1]) * 1000 });
    }
    servers.push({ name: String(name), functions });
    offset += 2 + entries;
  }
  const length = asNumber(data[offset]);
  offset += 1;
  if (length < 0 || length % ROW_STRIDE !== 0 || offset + length !== data.length) {
    throw new Error('Invalid profiler frame length');
  }
  const rows: FrameRow[] = [];
  for (let i = offset; i < offset + length; i += ROW_STRIDE) {
    const calls = asNumber(data[i + 1]);
    if (calls === 0) continue;
    const id = asNumber(data[i]);
    const resolved = signatures.get(id);
    const signature = resolved ?? `<unresolved:${id}>`;
    const parts = signature.split('::');
    rows.push({
      signature,
      file: parts.length >= 3 ? parts.slice(0, -2).join('::') : (parts[0] ?? ''),
      line: parts.length >= 3 ? Number(parts[parts.length - 2]) : 0,
      function: parts[parts.length - 1] ?? signature,
      sourceResolved: resolved !== undefined,
      calls,
      selfMs: asNumber(data[i + 2]) * 1000,
      totalMs: asNumber(data[i + 3]) * 1000,
    });
  }
  return { frame: asNumber(data[0]), timings, servers, rows };
}

export class DebuggerProfiler {
  private socket: net.Socket | null = null;
  private rxBuffer: Buffer = Buffer.alloc(0);
  private threadId: Variant = null;
  private processId: number | null = null;
  private state: ProfilerState = 'idle';
  private error: string | null = null;
  private closed = false;
  private lastMessage: string | null = null;
  private lastDecodeError: string | null = null;
  private signatures: Map<number, string> = new Map();
  private capture: Capture | null = null;
  private autoStopTimer: NodeJS.Timeout | null = null;
  private waiters: Waiter[] = [];

  private constructor(
    private readonly server: net.Server,
    readonly port: number,
  ) {
    server.on('connection', (socket) => this.accept(socket));
    server.on('error', (err) => this.fail(err.message));
  }

  /** Bind a loopback listener the spawned engine will dial back into. */
  static create(): Promise<DebuggerProfiler> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          server.close();
          reject(new Error('Failed to bind a debugger port for profiling'));
          return;
        }
        server.removeListener('error', reject);
        resolve(new DebuggerProfiler(server, address.port));
      });
    });
  }

  /** PID reported by the connected engine, or null before it connects. */
  get pid(): number | null {
    return this.processId;
  }

  get connected(): boolean {
    return this.socket !== null && this.threadId !== null;
  }

  /**
   * Enable the engine profiler and return once frames are arriving. The
   * capture stops itself after `seconds` so a forgotten `start_profiler`
   * cannot profile the rest of the session.
   */
  async start(seconds: number, captureLimit: number): Promise<ProfileStartResult> {
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > PROFILE_MAX_SECONDS) {
      throw new ProfilerError('bad_args', `seconds must be in (0, ${PROFILE_MAX_SECONDS}]`);
    }
    if (
      !Number.isInteger(captureLimit) ||
      captureLimit < CAPTURE_LIMIT_MIN ||
      captureLimit > CAPTURE_LIMIT_MAX
    ) {
      throw new ProfilerError(
        'bad_args',
        `captureLimit must be an integer in [${CAPTURE_LIMIT_MIN}, ${CAPTURE_LIMIT_MAX}]`,
      );
    }
    if (this.state === 'starting' || this.state === 'capturing' || this.state === 'stopping') {
      throw new ProfilerError('profile_busy', 'A capture is already active');
    }

    await this.wait(
      () => this.threadId !== null,
      WAIT_CONNECT_MS,
      'Godot never opened the debugger connection',
    );

    this.signatures = new Map();
    this.capture = {
      limit: captureLimit,
      startedAt: Date.now(),
      elapsedMs: 0,
      frames: 0,
      framesReceived: 0,
      frameGaps: 0,
      firstFrame: null,
      lastFrame: null,
      capped: false,
      totals: new Map(),
      peaks: new Map(),
      timingSums: noTimings(),
      timingMax: noTimings(),
      servers: new Map(),
      worst: null,
      result: null,
    };
    this.state = 'starting';
    this.send(true, captureLimit);
    this.autoStopTimer = setTimeout(() => this.autoStop(), seconds * 1000);

    try {
      await this.wait(
        () => (this.capture?.frames ?? 0) > 0,
        WAIT_FIRST_FRAME_MS,
        'Godot sent no profiler frames',
      );
    } catch (err) {
      this.autoStop();
      throw err;
    }
    return {
      active: this.isCapturing(),
      maxSeconds: seconds,
      firstFrame: this.capture.firstFrame,
      captureLimit: captureLimit,
    };
  }

  /**
   * Stop an active capture (or re-read a finished one) and rank the functions.
   * The engine's own accumulated totals close the capture, so this waits for
   * the `profile_total` packet rather than summing the last frame.
   */
  async stop(top: number, sort: ProfileSort): Promise<ProfileResult> {
    if (!Number.isInteger(top) || top < 1 || top > PROFILE_TOP_MAX) {
      throw new ProfilerError('bad_args', `top must be an integer in [1, ${PROFILE_TOP_MAX}]`);
    }
    if (!PROFILE_SORTS.includes(sort)) {
      throw new ProfilerError('bad_args', `sort must be one of ${PROFILE_SORTS.join(', ')}`);
    }
    if (this.state === 'idle' || this.capture === null) {
      throw new ProfilerError('profile_not_started', 'Start a capture first');
    }
    this.autoStop();
    const capture = this.capture;
    await this.wait(() => capture.result !== null, WAIT_TOTAL_MS, 'Godot sent no profiler totals');
    return this.summarize(capture, top, sort);
  }

  /** `start` + wait out the window + `stop`, for a one-shot capture. */
  async captureWindow(seconds: number, top: number, sort: ProfileSort): Promise<ProfileResult> {
    await this.start(seconds, CAPTURE_LIMIT_MAX);
    const capture = this.capture;
    if (capture === null) throw new ProfilerError('profile_not_started', 'Capture was discarded');
    await this.wait(
      () => capture.result !== null,
      seconds * 1000 + WAIT_TOTAL_MS,
      'Godot sent no profiler totals',
    );
    return this.stop(top, sort);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.state === 'starting' || this.state === 'capturing') {
      this.autoStop();
    }
    this.clearAutoStop();
    this.rejectWaiters(new ProfilerError('profile_disconnected', 'Profiler closed'));
    this.socket?.destroy();
    this.socket = null;
    this.server.close();
  }

  // --- transport ---

  private accept(socket: net.Socket): void {
    if (this.socket !== null || this.closed) {
      socket.destroy();
      return;
    }
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => this.receive(chunk));
    socket.on('error', (err) => this.fail(err.message));
    socket.on('close', () => this.fail('Debugger disconnected'));
  }

  private receive(chunk: Buffer): void {
    this.rxBuffer = Buffer.concat([this.rxBuffer, chunk]);
    while (this.rxBuffer.length >= 4) {
      const size = this.rxBuffer.readUInt32LE(0);
      if (size === 0 || size > MAX_PACKET_BYTES) {
        this.fail('Debugger packet exceeds limit');
        return;
      }
      if (this.rxBuffer.length < 4 + size) return;
      const payload = this.rxBuffer.subarray(4, 4 + size);
      this.rxBuffer = this.rxBuffer.subarray(4 + size);
      let message: Variant;
      try {
        message = decodeVariant(payload);
      } catch (err) {
        // Unrelated debugger packets carry objects and vectors we don't decode.
        this.lastDecodeError = err instanceof Error ? err.message : String(err);
        continue;
      }
      try {
        this.handle(message);
      } catch (err) {
        this.fail(err instanceof Error ? err.message : String(err));
        return;
      }
      this.notify();
    }
  }

  private handle(message: Variant): void {
    if (!Array.isArray(message) || message.length !== 3) return;
    const [name, data] = [message[0], message[2]];
    const threadId = message[1] ?? null;
    if (typeof name !== 'string' || !Array.isArray(data)) return;
    this.lastMessage = name;

    if (name === 'set_pid') {
      this.threadId = threadId;
      this.processId = typeof data[0] === 'number' ? data[0] : null;
      return;
    }
    if (name === 'debug_enter') {
      // A script error or `breakpoint` halted the game; resume it immediately.
      this.write(['continue', threadId, []]);
      return;
    }
    const capturing =
      this.state === 'starting' || this.state === 'capturing' || this.state === 'stopping';
    if (!capturing || this.capture === null) return;

    if (name === 'servers:function_signature') {
      if (typeof data[0] === 'string' && typeof data[1] === 'number') {
        this.signatures.set(data[1], data[0]);
      }
      return;
    }
    if (name !== 'servers:profile_frame' && name !== 'servers:profile_total') return;

    const capture = this.capture;
    const sample = parseFrame(data, this.signatures);
    const rows = sample.rows;
    capture.capped = capture.capped || rows.length >= capture.limit;

    if (name === 'servers:profile_total') {
      capture.result = [...capture.totals.values()];
      capture.elapsedMs = Date.now() - capture.startedAt;
      this.state = 'finished';
      this.clearAutoStop();
      return;
    }
    if (this.state === 'starting') this.state = 'capturing';
    capture.framesReceived += 1;
    // Enabling the profiler inside a running VM call gives that first sample a
    // zero start timestamp, so its elapsed time is fiction. Drop it.
    if (capture.framesReceived === 1) return;

    const frame = sample.frame;
    capture.frames += 1;
    if (capture.firstFrame === null) capture.firstFrame = frame;
    if (capture.lastFrame !== null) {
      capture.frameGaps += Math.max(0, frame - capture.lastFrame - 1);
    }
    capture.lastFrame = frame;

    for (const key of Object.keys(capture.timingSums) as Array<keyof FrameTimings>) {
      capture.timingSums[key] += sample.timings[key];
      capture.timingMax[key] = Math.max(capture.timingMax[key], sample.timings[key]);
    }
    for (const server of sample.servers) {
      let functions = capture.servers.get(server.name);
      if (functions === undefined) {
        functions = new Map();
        capture.servers.set(server.name, functions);
      }
      for (const fn of server.functions) {
        functions.set(fn.name, (functions.get(fn.name) ?? 0) + fn.ms);
      }
    }

    for (const row of rows) {
      const total = capture.totals.get(row.signature);
      if (total === undefined) {
        capture.totals.set(row.signature, { ...row });
      } else {
        total.calls += row.calls;
        total.selfMs += row.selfMs;
        total.totalMs += row.totalMs;
      }
      const peak = capture.peaks.get(row.signature);
      if (peak === undefined || row.totalMs > peak.totalMs) {
        capture.peaks.set(row.signature, {
          frame,
          calls: row.calls,
          selfMs: row.selfMs,
          totalMs: row.totalMs,
        });
      }
    }
    if (capture.worst === null || sample.timings.frameMs > capture.worst.frameMs) {
      capture.worst = {
        frame,
        ...sample.timings,
        rows: [...rows].sort((a, b) => b.totalMs - a.totalMs).slice(0, WORST_FRAME_ROWS),
      };
    }
  }

  private summarize(capture: Capture, top: number, sort: ProfileSort): ProfileResult {
    const frames = Math.max(1, capture.frames);
    const frame = {} as Record<keyof FrameTimings, ProfileStat>;
    for (const key of Object.keys(capture.timingSums) as Array<keyof FrameTimings>) {
      frame[key] = { avg: capture.timingSums[key] / frames, max: capture.timingMax[key] };
    }
    const servers: ProfileServer[] = [];
    for (const [name, functions] of capture.servers) {
      const entries = [...functions.entries()]
        .map(([fn, ms]) => ({ name: fn, msPerFrame: ms / frames }))
        .sort((a, b) => b.msPerFrame - a.msPerFrame);
      servers.push({
        name,
        msPerFrame: entries.reduce((sum, fn) => sum + fn.msPerFrame, 0),
        functions: entries,
      });
    }
    servers.sort((a, b) => b.msPerFrame - a.msPerFrame);

    const rows: ProfileRow[] = [];
    for (const row of capture.result ?? []) {
      if (row.calls <= 0) continue;
      const totalMsPerFrame = row.totalMs / frames;
      rows.push({
        ...row,
        callsPerFrame: row.calls / frames,
        selfMsPerFrame: row.selfMs / frames,
        totalMsPerFrame,
        msPerCall: row.totalMs / row.calls,
        percentOfFrame: frame.frameMs.avg > 0 ? (totalMsPerFrame / frame.frameMs.avg) * 100 : 0,
        peak: capture.peaks.get(row.signature) ?? null,
      });
    }
    rows.sort((a, b) => b[sort] - a[sort]);
    return roundNumbers({
      seconds: capture.elapsedMs / 1000,
      frames: capture.frames,
      framesReceived: capture.framesReceived,
      firstFrame: capture.firstFrame,
      lastFrame: capture.lastFrame,
      frameGaps: capture.frameGaps,
      captureLimit: capture.limit,
      limitReached: capture.capped,
      sort,
      functionsReceived: rows.length,
      unresolvedFunctions: rows.filter((r) => !r.sourceResolved).length,
      frame,
      servers,
      rows: rows.slice(0, top),
      worstFrame: capture.worst,
    });
  }

  /** Read behind a call so `start`'s own state assignment doesn't narrow it. */
  private isCapturing(): boolean {
    return this.state === 'capturing';
  }

  private send(enabled: boolean, limit: number): void {
    this.write(['profiler:servers', this.threadId, enabled ? [true, [limit, false]] : [false]]);
  }

  private write(message: Variant): void {
    const socket = this.socket;
    if (socket === null) return;
    const raw = encodeVariant(message);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(raw.length, 0);
    try {
      socket.write(Buffer.concat([header, raw]));
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  private autoStop(): void {
    if (this.state !== 'starting' && this.state !== 'capturing') return;
    this.state = 'stopping';
    this.clearAutoStop();
    if (this.capture) this.send(false, this.capture.limit);
    this.notify();
  }

  private clearAutoStop(): void {
    if (this.autoStopTimer === null) return;
    clearTimeout(this.autoStopTimer);
    this.autoStopTimer = null;
  }

  private fail(reason: string): void {
    if (this.error !== null) return;
    this.error = reason;
    logDebug(`[Profiler] ${reason}`);
    this.rejectWaiters(new ProfilerError('profile_disconnected', reason));
  }

  // --- waiting ---

  private wait(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
    if (predicate()) return Promise.resolve();
    if (this.error !== null || this.closed) {
      return Promise.reject(
        new ProfilerError('profile_disconnected', this.error ?? 'Profiler closed'),
      );
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(
            new ProfilerError(
              'profile_timeout',
              `${what} (last debugger message: ${this.lastMessage ?? 'none'}; ` +
                `signatures: ${this.signatures.size}; decode: ${this.lastDecodeError ?? 'none'})`,
            ),
          );
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  private notify(): void {
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate()) continue;
      this.waiters = this.waiters.filter((w) => w !== waiter);
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  private rejectWaiters(error: ProfilerError): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}
