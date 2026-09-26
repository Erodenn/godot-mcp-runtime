/**
 * Receiver for Godot's own remote-debugger profiler stream.
 *
 * `run_project({ profiling: true })` binds this listener first and passes
 * `--remote-debug tcp://127.0.0.1:<port>` to the spawned engine, so the
 * measurements are the stock editor ones — no engine build, no addon, and
 * nothing injected into the project. Attached sessions cannot profile: the
 * debugger channel only exists if it was on the command line at launch.
 *
 * Three engine profilers feed one capture: `servers` (script functions and
 * the frame budget, always on), `visual` (render-stage CPU/GPU timestamps,
 * opt-in) and `performance` (the Monitors tab, which the engine enables by
 * itself whenever a debugger is attached and samples once a second).
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
  | 'profile_disconnected'
  | 'profile_no_frames'
  | 'profile_bad_frame';

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
/**
 * The engine's errors when a frame runs out of render timestamp slots:
 * RenderingDevice (Forward+/Mobile) says so, while the Compatibility renderer
 * only fails the condition, so stderr shows `Condition "...timestamp_count >=
 * max_timestamp_query_elements" is true.`
 */
export const TIMESTAMP_OVERFLOW_ERRORS = [
  'Tried capturing more timestamps than the configured maximum',
  'timestamp_count >= max_timestamp_query_elements',
] as const;
/**
 * What to do about it, shared by every tool that can surface it. The setting
 * is read by RenderingDevice at startup; the Compatibility renderer ignores it
 * and stops at its compile-time MAX_QUERIES of 256.
 */
export const TIMESTAMP_OVERFLOW_FIX =
  'Forward+/Mobile: add settings/profiler/max_timestamp_query_elements=4096 under [debug] in project.godot and relaunch. Compatibility: the limit is fixed at 256 - profile this scene without visual.';
export const TIMELINE_MS_MIN = 250;
export const TIMELINE_MS_MAX = 5000;
/**
 * Intervals a timeline splits its window into. Every interval costs the agent
 * a few hundred bytes of context, so a longer window gets wider intervals.
 * Frames arriving just after the window closes can add one or two more.
 */
export const MAX_TIMELINE_BUCKETS = 60;
/** A widened interval rounds up to a multiple of this, so it stays readable. */
const TIMELINE_MS_STEP = 50;
export const TARGET_FPS_MAX = 1000;
export const DEFAULT_TARGET_FPS = 60;

/**
 * The interval a timeline over `seconds` actually uses: `timelineMs`, widened
 * when the window would not fit in MAX_TIMELINE_BUCKETS intervals of it.
 */
export function timelineBucketMs(timelineMs: number, seconds: number): number {
  const widest =
    Math.ceil((seconds * 1000) / MAX_TIMELINE_BUCKETS / TIMELINE_MS_STEP) * TIMELINE_MS_STEP;
  return Math.min(TIMELINE_MS_MAX, Math.max(timelineMs, widest));
}

/** Bound on the rows kept for the slowest frame — a full frame is unbounded. */
const WORST_FRAME_ROWS = 30;
/** The same bound for the render stages kept from the slowest rendered frame. */
const WORST_FRAME_AREAS = 15;
/** Every visual row is `[name, cpu ms, gpu ms]`. */
const AREA_STRIDE = 3;
/**
 * The marker `TIMESTAMP_BEGIN()` writes only while frame profiling is on. A
 * frame without it was timed before the profiler was enabled.
 */
const FRAME_BEGIN = 'Frame Begin';
/**
 * Visual frames skipped after every enable. Both renderers read timestamps
 * back through a ring of two or three frames and stamp each readback with a
 * fresh frame number, so the first few can hold timing taken before this
 * capture: the Compatibility renderer's internal markers, or, when a capture
 * starts right after another, frames the previous one recorded. Five covers
 * the deepest ring plus the enable landing mid-iteration (measured on 4.7).
 */
const VISUAL_SETTLE_FRAMES = 5;
/**
 * Consecutive truncated frames after which a capture switches the visual
 * profiler off. The engine logs an error for every marker a frame loses, and
 * a scene over the limit loses hundreds per frame: left on, the logging slows
 * the game several times over for the rest of the window, and every timing in
 * the capture measures the logging instead of the game. One frame over the
 * limit costs little; three in a row mean the scene itself is over it.
 */
const VISUAL_OVERFLOW_STOP_FRAMES = 3;
/** Joins a stage to its groups. Engine stage names contain `/` but never this. */
const PATH_SEPARATOR = ' > ';
/** Time inside a render group that none of its markers account for. */
const OTHER_AREA = '(other)';
const MIB = 1024 * 1024;
/** Custom monitors tracked per capture; the peer decides how many exist. */
const MAX_CUSTOM_MONITORS = 64;
/**
 * Things of each kind a timeline bucket keeps totals for; its top few are
 * picked from these. Per kind, so a game with hundreds of script functions
 * cannot crowd the render stages and server calls out of the ranking.
 */
const MAX_BUCKET_ITEMS = 512;
/** Heaviest things reported per timeline bucket. */
const BUCKET_TOP = 3;
/** `Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME`, the one monitor a bucket carries. */
const DRAW_CALLS_MONITOR = 13;
/** Every engine row is `[signature id, calls, self, total, internal]`. */
const ROW_STRIDE = 5;
/** Milliseconds are reported to this many decimals; below it is float noise. */
const MS_DECIMALS = 4;
const MS_ROUNDING = 10 ** MS_DECIMALS;

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
  visual: boolean;
  timeline: boolean;
  /** The timeline's interval, widened for a long window; null without a timeline. */
  timelineMs: number | null;
  maxSeconds: number;
  firstFrame: number | null;
  captureLimit: number;
}

/** What a capture records beyond the function profiler it always runs. */
export interface CaptureOptions {
  visual?: boolean;
  /** Timeline bucket length in ms; absent or null records no timeline. */
  timelineMs?: number | null;
  /** Frame rate whose frame time `slowFrames` counts against. */
  targetFps?: number;
  /**
   * NodePath:property specs the bridge samples during the capture. The
   * samples reach the capture through the `TrackCollector` its stop is
   * given: this receiver only speaks to the debugger, never to the bridge.
   */
  track?: string[];
}

/** One bridge sample, stamped with the engine process frame it was taken on. */
export interface TrackSample {
  frame: number;
  values: Record<string, unknown>;
}

/**
 * Fetch a capture's track from the bridge: its samples, or why there are
 * none. Called once the capture has closed, so the bridge's work handing the
 * samples over lands outside the measured frames. Must not reject.
 */
export type TrackCollector = () => Promise<{ samples: TrackSample[] | null; error: string | null }>;

/** One of the heaviest things in a timeline bucket. */
export interface TimelineItem {
  /** A GDScript function, an engine server function, or a render stage. */
  kind: 'script' | 'server' | 'render';
  name: string;
  /** Milliseconds per frame across the bucket; render stages use the heavier of CPU and GPU. */
  ms: number;
  /** The most it took in any one frame of the bucket. */
  maxMs: number;
}

export interface TimelineBucket {
  /** Seconds from the capture's first frame to the start of this bucket. */
  t: number;
  frames: number;
  /** Null for a trailing bucket too short to divide by. */
  fps: number | null;
  frameMs: ProfileStat | null;
  processMs: number | null;
  physicsMs: number | null;
  scriptMs: number | null;
  slowFrames: number;
  /** Render timeline per profiled frame; null without `visual`. */
  render: { cpuMs: number; gpuMs: number } | null;
  drawCalls: number | null;
  top: TimelineItem[];
  /** The last tracked sample taken inside the bucket's frames. */
  track: Record<string, unknown> | null;
}

export interface TimelineResult {
  bucketMs: number;
  track: string[];
  /** Why tracked values are missing, when they are. */
  trackError: string | null;
  buckets: TimelineBucket[];
}

/** One render stage from the editor's Visual Profiler, over the capture. */
export interface VisualArea {
  /** The engine's group nesting, e.g. `Render Viewports > Render Viewport 0 > Render 3D Scene`. */
  path: string;
  name: string;
  /** A bracketed group: its times include everything inside it. */
  group: boolean;
  /** Frames the stage appeared in. Averages divide by every folded frame. */
  frames: number;
  cpuMs: ProfileStat;
  gpuMs: ProfileStat;
}

export interface VisualWorstFrame {
  frame: number;
  cpuMs: number;
  gpuMs: number;
  areas: Array<{ path: string; cpuMs: number; gpuMs: number }>;
}

export interface VisualResult {
  hardware: { cpu: string; gpu: string } | null;
  framesReceived: number;
  frames: number;
  /** False when every GPU timestamp was zero: the renderer did not time the GPU. */
  gpuTimed: boolean;
  /**
   * Frames whose markers ran out before the frame ended: the renderer hit
   * `debug/settings/profiler/max_timestamp_query_elements` and dropped the
   * rest (the engine logs an error per dropped marker).
   */
  truncatedFrames: number;
  /**
   * Seconds into the capture at which the visual profiler was switched off
   * because frames kept running out of timestamp slots; null when it ran for
   * the whole capture.
   */
  stoppedAt: number | null;
  /** The whole render timeline of a frame, first marker to last. */
  cpuMs: ProfileStat;
  gpuMs: ProfileStat;
  areasReceived: number;
  areas: VisualArea[];
  worstFrame: VisualWorstFrame | null;
}

export interface MonitorStat {
  avg: number;
  min: number;
  max: number;
}

/**
 * `Performance.Monitor` indices this server names, with the factor that turns
 * the engine's unit (bytes) into the reported one. The enum only grows at its
 * end — 0-32 since 4.0, 33-38 in 4.4, 39-58 in 4.5 — so an index means the
 * same monitor on every 4.x build that sends it. The TIME_* monitors (0-3) are
 * left out: FPS counts the engine's previous full second, which can reach up
 * to two seconds before the sample, and the process times are per-second
 * maxima. The capture's own frames measure both more exactly.
 */
const MONITORS = [
  ['staticMemMiB', 4, 1 / MIB],
  ['objects', 7, 1],
  ['resources', 8, 1],
  ['nodes', 9, 1],
  ['orphanNodes', 10, 1],
  ['objectsInFrame', 11, 1],
  ['primitivesInFrame', 12, 1],
  ['drawCallsInFrame', 13, 1],
  ['videoMemMiB', 14, 1 / MIB],
  ['textureMemMiB', 15, 1 / MIB],
  ['bufferMemMiB', 16, 1 / MIB],
  ['physics2dActiveObjects', 17, 1],
  ['physics2dCollisionPairs', 18, 1],
  ['physics3dActiveObjects', 20, 1],
  ['physics3dCollisionPairs', 21, 1],
] as const;

export type MonitorName = (typeof MONITORS)[number][0];
export const MONITOR_NAMES: readonly MonitorName[] = MONITORS.map(([name]) => name);

/** `PIPELINE_COMPILATIONS_*` (4.4+): running totals since launch, not per frame. */
const PIPELINE_COMPILATION_MONITORS = [34, 35, 36, 37, 38];

export type MonitorsResult = { samples: number } & Record<MonitorName, MonitorStat> & {
    /** `duringCapture` is null when a single sample left nothing to count from. */
    pipelineCompilations: { duringCapture: number | null; total: number } | null;
    custom: Array<{ name: string } & MonitorStat>;
  };

export interface ProfileResult {
  seconds: number;
  frames: number;
  /**
   * Engine frames per second across the capture: the frame-number span over
   * the wall time between the first and last folded frame. Null when fewer
   * than two frames were folded.
   */
  fps: number | null;
  targetFps: number;
  /** Folded frames whose `frameMs` exceeded `1000 / targetFps`. */
  slowFrames: number;
  framesReceived: number;
  firstFrame: number | null;
  lastFrame: number | null;
  frameGaps: number;
  /**
   * Debugger packets dropped because the codec could not represent them. A
   * non-zero value means the capture may be missing frames it was sent.
   */
  undecodablePackets: number;
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
  /** Engine monitors sampled once a second; null when no sample arrived. */
  monitors: MonitorsResult | null;
  /** Render stages; null unless the capture was started with `visual`. */
  visual: VisualResult | null;
  /** The capture over time; null unless it was started with a timeline. */
  timeline: TimelineResult | null;
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
  /** Window the caller asked for; the auto-stop is armed off the first frame. */
  maxSeconds: number;
  startedAt: number;
  /** Arrival time of the newest folded frame, the end of the `fps` span. */
  lastFrameAt: number;
  elapsedMs: number;
  /** Frames folded into the totals (excludes the discarded boundary frame). */
  frames: number;
  framesReceived: number;
  frameGaps: number;
  /** Packets the codec could not represent while this capture was open. */
  undecodablePackets: number;
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
  monitors: MonitorCapture;
  /** Null unless the capture enabled the engine's visual profiler. */
  visual: VisualCapture | null;
  targetFps: number;
  slowFrames: number;
  timeline: TimelineCapture | null;
}

interface BucketItem {
  kind: TimelineItem['kind'];
  name: string;
  sum: number;
  max: number;
}

/**
 * A bucket's candidates for its `top`, per kind: scripts by signature, server
 * calls by server then function, render stages by path. Display names are
 * built once per item, not once per frame.
 */
interface BucketItems {
  scripts: Map<string, BucketItem>;
  servers: Map<string, Map<string, BucketItem>>;
  serverCount: number;
  render: Map<string, BucketItem>;
}

/** One slice of the timeline, filled by arrival time as frames come in. */
interface Bucket {
  frames: number;
  frameSum: number;
  frameMax: number;
  processSum: number;
  physicsSum: number;
  scriptSum: number;
  slowFrames: number;
  firstFrame: number | null;
  lastFrame: number | null;
  /**
   * Totals while the bucket fills. Once the capture moves past it nothing more
   * arrives for it, so it is ranked into `top` and these are dropped: a long
   * capture keeps one bucket's totals, not one per interval.
   */
  items: BucketItems | null;
  top: TimelineItem[];
  renderFrames: number;
  renderCpuSum: number;
  renderGpuSum: number;
  drawCalls: number | null;
}

interface TimelineCapture {
  bucketMs: number;
  /** Buckets past this belong to frames that arrived after the window closed. */
  maxBuckets: number;
  buckets: Bucket[];
  track: string[];
  samples: TrackSample[] | null;
  trackError: string | null;
  /** The one collection of the track, shared by stops that overlap. */
  collecting: Promise<void> | null;
}

/** Running count, sum and range of one monitor. */
interface Accumulator {
  count: number;
  sum: number;
  min: number;
  max: number;
}

/**
 * Monitor samples, folded as they arrive: the peer decides how many arrive
 * and how wide they are, so none is kept whole.
 */
interface MonitorCapture {
  samples: number;
  named: Map<MonitorName, Accumulator>;
  custom: Map<string, Accumulator>;
  /**
   * Pipeline compilations at the last sample before the capture opened: the
   * baseline that lets even a one-sample capture report what compiled.
   */
  baselineCompilations: number | null;
  firstCompilations: number | null;
  lastCompilations: number | null;
}

/** A render stage's time inside one frame, in milliseconds. */
interface FrameArea {
  /** `areaKey` of the stage, computed once per frame. */
  key: string;
  path: string;
  name: string;
  group: boolean;
  cpuMs: number;
  gpuMs: number;
}

interface AreaTotals {
  path: string;
  name: string;
  group: boolean;
  frames: number;
  cpuSum: number;
  cpuMax: number;
  gpuSum: number;
  gpuMax: number;
}

interface VisualCapture {
  framesReceived: number;
  frames: number;
  truncatedFrames: number;
  /** Truncated frames in a row, up to the newest folded one. */
  truncatedRun: number;
  stoppedAt: number | null;
  /** Number of the newest folded frame; a repeat of it is the same draw re-sent. */
  lastFrame: number | null;
  gpuTimed: boolean;
  cpuSum: number;
  cpuMax: number;
  gpuSum: number;
  gpuMax: number;
  areas: Map<string, AreaTotals>;
  worst: VisualWorstFrame | null;
}

/** One `visual:profile_frame`: timestamps, each counted from the frame's first marker. */
interface VisualSample {
  frame: number;
  markers: Array<{ name: string; cpuMs: number; gpuMs: number }>;
}

type ProfilerState = 'idle' | 'starting' | 'capturing' | 'stopping' | 'finished';

interface Waiter {
  predicate: () => boolean;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function badFrame(what: string): ProfilerError {
  return new ProfilerError(
    'profile_bad_frame',
    `Unrecognized profiler frame layout (${what}) - this Godot version may not be supported`,
  );
}

/**
 * Engine timings come from integer tick counts and are always finite. A NaN
 * or an infinity would serialize as `null` and break the output schema, so it
 * is treated like any other layout the server does not understand.
 */
function asNumber(value: Variant | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw badFrame('expected a finite number');
  }
  return value;
}

/**
 * Loop bounds and element counts must be real non-negative integers. Plain
 * `asNumber` would accept a float — and a layout shift that lands a timing
 * value where a count belongs makes `for (i < 0.016)` run once instead of
 * throwing, walking `offset` off silently. Fail loudly on version drift.
 */
function asCount(value: Variant | undefined, limit: number): number {
  const count = asNumber(value);
  if (!Number.isSafeInteger(count) || count < 0 || count > limit) {
    throw badFrame(`expected a count in [0, ${limit}], got ${count}`);
  }
  return count;
}

/** Trim float noise from the summary — these are milliseconds, not physics. */
function roundNumbers<T>(value: T): T {
  if (typeof value === 'number') return (Math.round(value * MS_ROUNDING) / MS_ROUNDING) as T;
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
  /**
   * Rows the engine actually sent, before zero-call rows are dropped. The
   * engine's `captureLimit` applies to this count, so the truncation check
   * has to use it rather than the filtered `rows.length`.
   */
  rawRowCount: number;
}

/**
 * Split the engine's per-frame array. Layout: the frame number, five timing
 * fields, a server count, that many `name, entryCount, ...name/time pairs`
 * blocks, then the flattened function rows preceded by their own length.
 * Verified against `ServersProfilerFrame::serialize()`; `internal_time` at
 * `i + 4` is deliberately skipped (the editor's "internal functions" toggle).
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
  const serverCount = asCount(data[6], data.length);
  for (let i = 0; i < serverCount; i++) {
    const name = data[offset];
    const entries = asCount(data[offset + 1], data.length - offset);
    if (entries % 2 !== 0) throw badFrame('server block holds an odd entry count');
    const functions: Array<{ name: string; ms: number }> = [];
    for (let j = offset + 2; j < offset + 2 + entries; j += 2) {
      functions.push({ name: String(data[j]), ms: asNumber(data[j + 1]) * 1000 });
    }
    servers.push({ name: String(name), functions });
    offset += 2 + entries;
  }
  const length = asCount(data[offset], data.length - offset);
  offset += 1;
  if (length % ROW_STRIDE !== 0 || offset + length !== data.length) {
    throw badFrame('row block does not fill the packet');
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
  return {
    frame: asNumber(data[0]),
    timings,
    servers,
    rows,
    rawRowCount: length / ROW_STRIDE,
  };
}

/**
 * Split the engine's visual frame: the frame number, the length of the rest,
 * then `name, cpu ms, gpu ms` per marker. Verified against
 * `VisualProfilerFrame::serialize()`, unchanged since 4.0.
 */
function parseVisualFrame(data: Variant[]): VisualSample {
  const length = asCount(data[1], data.length);
  if (length % AREA_STRIDE !== 0 || 2 + length !== data.length) {
    throw badFrame('visual marker block does not fill the packet');
  }
  const markers: VisualSample['markers'] = [];
  for (let i = 2; i < data.length; i += AREA_STRIDE) {
    const name = data[i];
    if (typeof name !== 'string') throw badFrame('expected a render marker name');
    markers.push({ name, cpuMs: asNumber(data[i + 1]), gpuMs: asNumber(data[i + 2]) });
  }
  return { frame: asNumber(data[0]), markers };
}

const costOf = (area: { cpuMs: number; gpuMs: number }): number => Math.max(area.cpuMs, area.gpuMs);

/** A group and a stage may share a name and a parent; keep their rows apart. */
const areaKey = (area: { path: string; group: boolean }): string =>
  `${area.group ? 'group' : 'stage'}:${area.path}`;

const childPath = (parent: { path: string } | undefined, name: string): string =>
  parent === undefined ? name : `${parent.path}${PATH_SEPARATOR}${name}`;

/**
 * Turn one frame's markers into stage times. A marker's stage lasts until the
 * next marker, as in the editor's tree; `>name` opens a group and `<name`
 * closes it. Unlike the editor, a group's time is the span between its own
 * markers, and whatever its children leave uncovered becomes an `(other)` row
 * — in the Compatibility renderer that is the blit and buffer swap inside a
 * viewport, which the editor's tree silently drops.
 */
function frameAreas(markers: VisualSample['markers']): { areas: FrameArea[]; truncated: boolean } {
  const areas = new Map<string, FrameArea>();
  const add = (path: string, name: string, group: boolean, cpuMs: number, gpuMs: number): void => {
    const key = areaKey({ path, group });
    const known = areas.get(key);
    if (known === undefined) {
      areas.set(key, { key, path, name, group, cpuMs, gpuMs });
    } else {
      known.cpuMs += cpuMs;
      known.gpuMs += gpuMs;
    }
  };
  interface OpenGroup {
    path: string;
    name: string;
    cpuMs: number;
    gpuMs: number;
    childCpuMs: number;
    childGpuMs: number;
  }
  const stack: OpenGroup[] = [];
  const close = (group: OpenGroup, at: { cpuMs: number; gpuMs: number }): void => {
    const cpuMs = Math.max(0, at.cpuMs - group.cpuMs);
    const gpuMs = Math.max(0, at.gpuMs - group.gpuMs);
    add(group.path, group.name, true, cpuMs, gpuMs);
    const otherCpu = Math.max(0, cpuMs - group.childCpuMs);
    const otherGpu = Math.max(0, gpuMs - group.childGpuMs);
    if (otherCpu > 1e-9 || otherGpu > 1e-9) {
      add(childPath(group, OTHER_AREA), OTHER_AREA, false, otherCpu, otherGpu);
    }
    const parent = stack[stack.length - 1];
    if (parent !== undefined) {
      parent.childCpuMs += cpuMs;
      parent.childGpuMs += gpuMs;
    }
  };
  /** Close groups down to and including the innermost open one named `name`. */
  const closeTo = (name: string, at: { cpuMs: number; gpuMs: number }): void => {
    if (!stack.some((group) => group.name === name)) return;
    let group = stack.pop();
    while (group !== undefined) {
      close(group, at);
      if (group.name === name) break;
      group = stack.pop();
    }
  };

  const last = markers.length - 1;
  markers.forEach((marker, i) => {
    if (marker.name.startsWith('>')) {
      const name = marker.name.slice(1).trim();
      // A group opened while one of its name is still open is that stage's
      // next pass, not a child of it: the engine opens "Render
      // DirectionalLight2D Shadows" once per light but closes it once, after
      // the loop (renderer_viewport.cpp). Nested, the first pass would stay
      // open to the end of the viewport and claim its swap and vsync wait.
      closeTo(name, marker);
      stack.push({
        path: childPath(stack[stack.length - 1], name),
        name,
        cpuMs: marker.cpuMs,
        gpuMs: marker.gpuMs,
        childCpuMs: 0,
        childGpuMs: 0,
      });
      return;
    }
    if (marker.name.startsWith('<')) {
      // A close with no open group of its name is dropped, so it cannot
      // wreck the rest of the frame.
      closeTo(marker.name.slice(1).trim(), marker);
      return;
    }
    const parent = stack[stack.length - 1];
    // The first marker opens the timeline and the last one ends it; neither
    // starts a stage (the editor skips both the same way). The Compatibility
    // renderer puts its own "Internal Begin" ahead of "Frame Begin", which is
    // no stage either.
    const next = markers[i + 1];
    if (i === 0 || i === last || next === undefined || marker.name === FRAME_BEGIN) return;
    const cpuMs = Math.max(0, next.cpuMs - marker.cpuMs);
    const gpuMs = Math.max(0, next.gpuMs - marker.gpuMs);
    add(childPath(parent, marker.name), marker.name, false, cpuMs, gpuMs);
    if (parent !== undefined) {
      parent.childCpuMs += cpuMs;
      parent.childGpuMs += gpuMs;
    }
  });
  // By the end of a whole frame every group is closed, a re-opened one by its
  // re-open above. One still open means the frame ran out of timestamp slots
  // and lost its remaining markers, closes included.
  const truncated = stack.length > 0;
  const end = markers[last];
  if (end !== undefined) {
    for (let group = stack.pop(); group !== undefined; group = stack.pop()) close(group, end);
  }
  return { areas: [...areas.values()], truncated };
}

function newVisualCapture(): VisualCapture {
  return {
    framesReceived: 0,
    frames: 0,
    truncatedFrames: 0,
    truncatedRun: 0,
    stoppedAt: null,
    lastFrame: null,
    gpuTimed: false,
    cpuSum: 0,
    cpuMax: 0,
    gpuSum: 0,
    gpuMax: 0,
    areas: new Map(),
    worst: null,
  };
}

/** A visual frame that made it into the totals, for the timeline to place too. */
interface FoldedRender {
  cpuMs: number;
  gpuMs: number;
  areas: FrameArea[];
  truncated: boolean;
}

function foldVisualFrame(visual: VisualCapture, sample: VisualSample): FoldedRender | null {
  visual.framesReceived += 1;
  if (visual.framesReceived <= VISUAL_SETTLE_FRAMES) return null;
  // A frame timed while profiling was off: the Compatibility renderer writes
  // its "Internal Begin/End" pair whether or not anyone is profiling.
  if (!sample.markers.some((marker) => marker.name === FRAME_BEGIN)) return null;
  // While nothing draws (a minimized window, low-processor mode with nothing
  // changed) the engine re-sends the last drawn frame every iteration under
  // the same number. Only a new draw advances it.
  if (visual.lastFrame !== null && sample.frame <= visual.lastFrame) return null;
  visual.lastFrame = sample.frame;
  const first = sample.markers[0];
  const end = sample.markers[sample.markers.length - 1];
  if (first === undefined || end === undefined) return null;

  const cpuMs = Math.max(0, end.cpuMs - first.cpuMs);
  const gpuMs = Math.max(0, end.gpuMs - first.gpuMs);
  visual.frames += 1;
  visual.cpuSum += cpuMs;
  visual.cpuMax = Math.max(visual.cpuMax, cpuMs);
  visual.gpuSum += gpuMs;
  visual.gpuMax = Math.max(visual.gpuMax, gpuMs);
  visual.gpuTimed = visual.gpuTimed || sample.markers.some((marker) => marker.gpuMs > 0);

  const { areas, truncated } = frameAreas(sample.markers);
  if (truncated) visual.truncatedFrames += 1;
  for (const area of areas) {
    const totals = visual.areas.get(area.key);
    if (totals === undefined) {
      visual.areas.set(area.key, {
        path: area.path,
        name: area.name,
        group: area.group,
        frames: 1,
        cpuSum: area.cpuMs,
        cpuMax: area.cpuMs,
        gpuSum: area.gpuMs,
        gpuMax: area.gpuMs,
      });
    } else {
      totals.frames += 1;
      totals.cpuSum += area.cpuMs;
      totals.cpuMax = Math.max(totals.cpuMax, area.cpuMs);
      totals.gpuSum += area.gpuMs;
      totals.gpuMax = Math.max(totals.gpuMax, area.gpuMs);
    }
  }
  if (visual.worst === null || Math.max(cpuMs, gpuMs) > costOf(visual.worst)) {
    visual.worst = {
      frame: sample.frame,
      cpuMs,
      gpuMs,
      // Group rows only restate their children; the stages explain a spike.
      areas: areas
        .filter((area) => !area.group)
        .sort((a, b) => costOf(b) - costOf(a))
        .slice(0, WORST_FRAME_AREAS)
        .map(({ path, cpuMs: cpu, gpuMs: gpu }) => ({ path, cpuMs: cpu, gpuMs: gpu })),
    };
  }
  return { cpuMs, gpuMs, areas, truncated };
}

function summarizeVisual(
  visual: VisualCapture,
  hardware: VisualResult['hardware'],
  top: number,
): VisualResult {
  const frames = Math.max(visual.frames, 1);
  const areas: VisualArea[] = [];
  for (const totals of visual.areas.values()) {
    if (totals.cpuMax <= 0 && totals.gpuMax <= 0) continue;
    areas.push({
      path: totals.path,
      name: totals.name,
      group: totals.group,
      frames: totals.frames,
      cpuMs: { avg: totals.cpuSum / frames, max: totals.cpuMax },
      gpuMs: { avg: totals.gpuSum / frames, max: totals.gpuMax },
    });
  }
  const cost = (area: VisualArea): number => Math.max(area.cpuMs.avg, area.gpuMs.avg);
  areas.sort((a, b) => cost(b) - cost(a) || a.path.localeCompare(b.path));
  return {
    hardware,
    framesReceived: visual.framesReceived,
    frames: visual.frames,
    gpuTimed: visual.gpuTimed,
    truncatedFrames: visual.truncatedFrames,
    stoppedAt: visual.stoppedAt,
    cpuMs: { avg: visual.cpuSum / frames, max: visual.cpuMax },
    gpuMs: { avg: visual.gpuSum / frames, max: visual.gpuMax },
    areasReceived: areas.length,
    areas: areas.slice(0, top),
    worstFrame: visual.worst,
  };
}

function newTimeline(bucketMs: number, maxSeconds: number, track: string[]): TimelineCapture {
  return {
    bucketMs,
    maxBuckets: Math.ceil((maxSeconds * 1000) / bucketMs) + 2,
    buckets: [],
    track,
    samples: null,
    trackError: null,
    collecting: null,
  };
}

/**
 * The bucket for something that arrived `elapsedMs` after the capture's first
 * frame, grown up to it so an interval with no frames at all (a freeze) still
 * shows as an empty bucket. Null past the window's end.
 */
function bucketAt(timeline: TimelineCapture, elapsedMs: number): Bucket | null {
  const index = Math.max(0, Math.floor(elapsedMs / timeline.bucketMs));
  if (index >= timeline.maxBuckets) return null;
  while (timeline.buckets.length <= index) {
    // Things are placed by arrival time, so once a later bucket exists
    // nothing more lands in the one before it: rank that one now.
    const previous = timeline.buckets[timeline.buckets.length - 1];
    if (previous !== undefined) closeBucket(previous);
    timeline.buckets.push({
      frames: 0,
      frameSum: 0,
      frameMax: 0,
      processSum: 0,
      physicsSum: 0,
      scriptSum: 0,
      slowFrames: 0,
      firstFrame: null,
      lastFrame: null,
      items: { scripts: new Map(), servers: new Map(), serverCount: 0, render: new Map() },
      top: [],
      renderFrames: 0,
      renderCpuSum: 0,
      renderGpuSum: 0,
      drawCalls: null,
    });
  }
  return timeline.buckets[index] ?? null;
}

function bump(item: BucketItem, ms: number): void {
  item.sum += ms;
  if (ms > item.max) item.max = ms;
}

/** The bucket's heaviest things, by the per-frame milliseconds they report. */
function rankBucket(bucket: Bucket): TimelineItem[] {
  const items = bucket.items;
  if (items === null) return bucket.top;
  const ranked: TimelineItem[] = [];
  const add = (item: BucketItem, frames: number): void => {
    ranked.push({
      kind: item.kind,
      name: item.name,
      ms: item.sum / Math.max(frames, 1),
      maxMs: item.max,
    });
  };
  for (const item of items.scripts.values()) add(item, bucket.frames);
  for (const functions of items.servers.values()) {
    for (const item of functions.values()) add(item, bucket.frames);
  }
  // Render stages come from fewer frames than the servers profiler sends.
  for (const item of items.render.values()) add(item, bucket.renderFrames);
  return ranked.sort((a, b) => b.ms - a.ms).slice(0, BUCKET_TOP);
}

function closeBucket(bucket: Bucket): void {
  if (bucket.items === null) return;
  bucket.top = rankBucket(bucket);
  bucket.items = null;
}

function foldTimelineFrame(bucket: Bucket, sample: FrameSample, slow: boolean): void {
  bucket.frames += 1;
  bucket.frameSum += sample.timings.frameMs;
  bucket.frameMax = Math.max(bucket.frameMax, sample.timings.frameMs);
  bucket.processSum += sample.timings.processMs;
  bucket.physicsSum += sample.timings.physicsMs;
  bucket.scriptSum += sample.timings.scriptMs;
  if (slow) bucket.slowFrames += 1;
  bucket.firstFrame ??= sample.frame;
  bucket.lastFrame = sample.frame;
  const items = bucket.items;
  if (items === null) return;
  for (const row of sample.rows) {
    const known = items.scripts.get(row.signature);
    if (known !== undefined) {
      bump(known, row.selfMs);
    } else if (items.scripts.size < MAX_BUCKET_ITEMS) {
      const where = row.sourceResolved ? ` (${row.file}:${row.line})` : '';
      items.scripts.set(row.signature, {
        kind: 'script',
        name: `${row.function}${where}`,
        sum: row.selfMs,
        max: row.selfMs,
      });
    }
  }
  for (const server of sample.servers) {
    let functions = items.servers.get(server.name);
    for (const fn of server.functions) {
      const known = functions?.get(fn.name);
      if (known !== undefined) {
        bump(known, fn.ms);
        continue;
      }
      if (items.serverCount >= MAX_BUCKET_ITEMS) continue;
      if (functions === undefined) {
        functions = new Map();
        items.servers.set(server.name, functions);
      }
      const name = `${server.name}/${fn.name}`;
      functions.set(fn.name, { kind: 'server', name, sum: fn.ms, max: fn.ms });
      items.serverCount += 1;
    }
  }
}

function foldTimelineRender(bucket: Bucket, render: FoldedRender): void {
  bucket.renderFrames += 1;
  bucket.renderCpuSum += render.cpuMs;
  bucket.renderGpuSum += render.gpuMs;
  const items = bucket.items;
  if (items === null) return;
  for (const area of render.areas) {
    if (area.group) continue;
    const cost = costOf(area);
    const known = items.render.get(area.path);
    if (known !== undefined) {
      bump(known, cost);
    } else if (items.render.size < MAX_BUCKET_ITEMS) {
      items.render.set(area.path, { kind: 'render', name: area.path, sum: cost, max: cost });
    }
  }
}

function summarizeTimeline(timeline: TimelineCapture, spanMs: number): TimelineResult {
  const samples = [...(timeline.samples ?? [])].sort((a, b) => a.frame - b.frame);
  const last = timeline.buckets.length - 1;
  const buckets = timeline.buckets.map((bucket, index): TimelineBucket => {
    const startMs = index * timeline.bucketMs;
    // Only the trailing bucket is partial. Measured from its start to the last
    // frame, it is too short to divide by when the capture ended just inside it.
    const durationMs = index === last ? spanMs - startMs : timeline.bucketMs;
    const fps = durationMs >= timeline.bucketMs / 4 ? bucket.frames / (durationMs / 1000) : null;
    const perFrame = (sum: number): number | null =>
      bucket.frames > 0 ? sum / bucket.frames : null;
    let track: TimelineBucket['track'] = null;
    if (bucket.firstFrame !== null && bucket.lastFrame !== null) {
      for (const sample of samples) {
        if (sample.frame > bucket.lastFrame) break;
        if (sample.frame >= bucket.firstFrame) track = sample.values;
      }
    }
    return {
      t: startMs / 1000,
      frames: bucket.frames,
      fps,
      frameMs:
        bucket.frames > 0 ? { avg: bucket.frameSum / bucket.frames, max: bucket.frameMax } : null,
      processMs: perFrame(bucket.processSum),
      physicsMs: perFrame(bucket.physicsSum),
      scriptMs: perFrame(bucket.scriptSum),
      slowFrames: bucket.slowFrames,
      render:
        bucket.renderFrames > 0
          ? {
              cpuMs: bucket.renderCpuSum / bucket.renderFrames,
              gpuMs: bucket.renderGpuSum / bucket.renderFrames,
            }
          : null,
      drawCalls: bucket.drawCalls,
      // The newest bucket is still open; ranking it here leaves it that way.
      top: rankBucket(bucket),
      track,
    };
  });
  return {
    bucketMs: timeline.bucketMs,
    track: timeline.track,
    trackError: timeline.trackError,
    buckets,
  };
}

function newMonitorCapture(baselineCompilations: number | null): MonitorCapture {
  return {
    samples: 0,
    named: new Map(),
    custom: new Map(),
    baselineCompilations,
    firstCompilations: null,
    lastCompilations: null,
  };
}

function accumulate<K>(into: Map<K, Accumulator>, key: K, value: number): void {
  const known = into.get(key);
  if (known === undefined) {
    into.set(key, { count: 1, sum: value, min: value, max: value });
    return;
  }
  known.count += 1;
  known.sum += value;
  known.min = Math.min(known.min, value);
  known.max = Math.max(known.max, value);
}

function monitorStat(accumulator: Accumulator | undefined): MonitorStat {
  if (accumulator === undefined) return { avg: 0, min: 0, max: 0 };
  return {
    avg: accumulator.sum / accumulator.count,
    min: accumulator.min,
    max: accumulator.max,
  };
}

/**
 * One `performance:profile_frame`, read against the custom monitor names in
 * force when it arrived. Built-in monitors lead; the custom ones fill the
 * tail. A value that is not a finite number is absent: the engine forwards
 * any custom value that `is_num()`, infinities included.
 */
function readMonitorSample(
  data: Variant[],
  customNames: string[],
): { builtin: Array<number | null>; custom: Array<number | null> } {
  const finite = (value: Variant | undefined): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  const builtinCount =
    data.length >= customNames.length ? data.length - customNames.length : data.length;
  return {
    builtin: data.slice(0, builtinCount).map(finite),
    custom: customNames.map((_, i) => finite(data[builtinCount + i])),
  };
}

/** Sum of the `PIPELINE_COMPILATIONS_*` totals, or null on a build without them. */
function compilationTotal(builtin: Array<number | null>): number | null {
  let total = 0;
  for (const index of PIPELINE_COMPILATION_MONITORS) {
    const value = builtin[index];
    if (value === null || value === undefined) return null;
    total += value;
  }
  return total;
}

function foldMonitorSample(
  monitors: MonitorCapture,
  sample: ReturnType<typeof readMonitorSample>,
  customNames: string[],
): void {
  monitors.samples += 1;
  for (const [name, index, scale] of MONITORS) {
    const value = sample.builtin[index];
    if (value !== null && value !== undefined) accumulate(monitors.named, name, value * scale);
  }
  const compilations = compilationTotal(sample.builtin);
  if (compilations !== null) {
    monitors.firstCompilations ??= compilations;
    monitors.lastCompilations = compilations;
  }
  customNames.forEach((name, i) => {
    const value = sample.custom[i];
    if (value === null || value === undefined) return;
    if (!monitors.custom.has(name) && monitors.custom.size >= MAX_CUSTOM_MONITORS) return;
    accumulate(monitors.custom, name, value);
  });
}

function summarizeMonitors(monitors: MonitorCapture): MonitorsResult | null {
  if (monitors.samples === 0) return null;
  const named = {} as Record<MonitorName, MonitorStat>;
  for (const [name] of MONITORS) named[name] = monitorStat(monitors.named.get(name));

  // Running totals since launch: what compiled is the growth from the last
  // sample before the capture (or its own first one) to its last one. With
  // neither a baseline nor a second sample there is nothing to count from,
  // and a 0 would read as "nothing compiled".
  const to = monitors.lastCompilations;
  const from =
    monitors.baselineCompilations ?? (monitors.samples > 1 ? monitors.firstCompilations : null);
  return {
    samples: monitors.samples,
    ...named,
    pipelineCompilations:
      to === null
        ? null
        : { duringCapture: from === null ? null : Math.max(0, to - from), total: to },
    custom: [...monitors.custom.entries()].map(([name, accumulator]) => ({
      name,
      ...monitorStat(accumulator),
    })),
  };
}

export class DebuggerProfiler {
  private socket: net.Socket | null = null;
  /** Pending bytes, joined only once a whole frame has arrived (see `receive`). */
  private rxChunks: Buffer[] = [];
  private rxLength = 0;
  private threadId: Variant = null;
  private processId: number | null = null;
  private state: ProfilerState = 'idle';
  private error: string | null = null;
  private closed = false;
  private lastMessage: string | null = null;
  private lastDecodeError: string | null = null;
  private undecodable = 0;
  private signatures: Map<number, string> = new Map();
  /**
   * Sent once per visual toggle and by `performance:profile_names` only when
   * the set changes — usually at startup, before any capture opens — so both
   * are kept for the session rather than per capture.
   */
  private hardware: VisualResult['hardware'] = null;
  private customMonitorNames: string[] = [];
  /** Pipeline compilations at the newest monitor sample, captured or not. */
  private lastCompilations: number | null = null;
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

  /**
   * A finished capture is readable even once the engine is gone — `stop` only
   * re-ranks data already folded, and the capture worth reading is often the
   * one taken right before a crash.
   */
  get hasResult(): boolean {
    return this.capture?.result !== null && this.capture !== null;
  }

  get connected(): boolean {
    return this.socket !== null && this.threadId !== null;
  }

  /**
   * Enable the engine profiler and return once frames are arriving. The
   * capture stops itself after `seconds` so a forgotten `start_profiler`
   * cannot profile the rest of the session. `options.visual` also turns on
   * the engine's render-stage timestamps for the same window.
   */
  async start(
    seconds: number,
    captureLimit: number,
    options: CaptureOptions = {},
  ): Promise<ProfileStartResult> {
    return (await this.open(seconds, captureLimit, options)).started;
  }

  /**
   * Throw whatever `start` would refuse before it reaches the engine: an
   * argument out of range, or a capture already open. The tools check this
   * before they ask the bridge for a track, because a track_start replaces
   * any track that is running - a refused call must not take a running
   * capture's track down with it.
   */
  assertCanStart(seconds: number, captureLimit: number, options: CaptureOptions = {}): void {
    const timelineMs = options.timelineMs ?? null;
    const targetFps = options.targetFps ?? DEFAULT_TARGET_FPS;
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > PROFILE_MAX_SECONDS) {
      throw new ProfilerError('bad_args', `seconds must be in (0, ${PROFILE_MAX_SECONDS}]`);
    }
    if (
      timelineMs !== null &&
      (!Number.isInteger(timelineMs) ||
        timelineMs < TIMELINE_MS_MIN ||
        timelineMs > TIMELINE_MS_MAX)
    ) {
      throw new ProfilerError(
        'bad_args',
        `timelineMs must be an integer in [${TIMELINE_MS_MIN}, ${TIMELINE_MS_MAX}]`,
      );
    }
    if (!Number.isFinite(targetFps) || targetFps <= 0 || targetFps > TARGET_FPS_MAX) {
      throw new ProfilerError('bad_args', `targetFps must be in (0, ${TARGET_FPS_MAX}]`);
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
    this.assertIdle();
  }

  /** `start`, handing back the capture it opened so no caller has to re-read `this.capture`. */
  private async open(
    seconds: number,
    captureLimit: number,
    options: CaptureOptions,
  ): Promise<{ started: ProfileStartResult; capture: Capture }> {
    this.assertCanStart(seconds, captureLimit, options);
    const visual = options.visual === true;
    const timelineMs = options.timelineMs ?? null;

    await this.wait(
      () => this.threadId !== null,
      WAIT_CONNECT_MS,
      'Godot never opened the debugger connection',
    );
    // Two tool calls read off one stdin chunk both pass the check above before
    // either reaches this point. Checking again here, where nothing can run
    // between the check and the state change, lets only the first one open.
    this.assertIdle();

    this.signatures = new Map();
    this.capture = {
      limit: captureLimit,
      maxSeconds: seconds,
      startedAt: Date.now(),
      lastFrameAt: 0,
      elapsedMs: 0,
      frames: 0,
      framesReceived: 0,
      frameGaps: 0,
      undecodablePackets: 0,
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
      monitors: newMonitorCapture(this.lastCompilations),
      visual: visual ? newVisualCapture() : null,
      targetFps: options.targetFps ?? DEFAULT_TARGET_FPS,
      slowFrames: 0,
      timeline:
        timelineMs === null
          ? null
          : newTimeline(timelineBucketMs(timelineMs, seconds), seconds, options.track ?? []),
    };
    const capture = this.capture;
    this.state = 'starting';
    this.send(true, captureLimit);
    if (visual) this.write(['profiler:visual', this.threadId, [true]]);

    try {
      // `result` satisfies this too: if the engine closes the capture before a
      // frame is folded, that is an answer, not a reason to sit out the wait
      // and then report a timeout for a capture the engine actually finished.
      await this.wait(
        () => capture.frames > 0 || capture.result !== null,
        WAIT_FIRST_FRAME_MS,
        'Godot sent no profiler frames',
      );
    } catch (err) {
      if (this.capture === capture) this.autoStop();
      throw err;
    }
    return {
      started: {
        active: this.isCapturing(),
        visual,
        timeline: capture.timeline !== null,
        timelineMs: capture.timeline === null ? null : capture.timeline.bucketMs,
        maxSeconds: seconds,
        firstFrame: capture.firstFrame,
        captureLimit: captureLimit,
      },
      capture,
    };
  }

  private assertIdle(): void {
    if (this.state === 'starting' || this.state === 'capturing' || this.state === 'stopping') {
      throw new ProfilerError('profile_busy', 'A capture is already active');
    }
  }

  /**
   * Hand a closed capture the track it asked for, fetched through `collect`.
   * Only the first hand-over counts, and overlapping stops share it: the
   * bridge gives its samples up once, so a second request would only get an
   * error back. Attached to `capture` itself, never to whichever capture is
   * current once the fetch returns.
   */
  private async collectTrack(capture: Capture, collect: TrackCollector | undefined): Promise<void> {
    const timeline = capture.timeline;
    if (collect === undefined || timeline === null || timeline.track.length === 0) return;
    if (timeline.samples !== null || timeline.trackError !== null) return;
    timeline.collecting ??= collect().then(
      ({ samples, error }) => {
        timeline.samples = samples;
        timeline.trackError = samples === null ? (error ?? 'No track samples arrived') : null;
      },
      (err: unknown) => {
        timeline.trackError = err instanceof Error ? err.message : String(err);
      },
    );
    await timeline.collecting;
  }

  /**
   * Stop an active capture (or re-read a finished one) and rank the functions.
   * The engine's own accumulated totals close the capture, so this waits for
   * the `profile_total` packet rather than summing the last frame. `collect`
   * fetches the capture's track, if it asked for one.
   */
  async stop(top: number, sort: ProfileSort, collect?: TrackCollector): Promise<ProfileResult> {
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
    return this.finish(this.capture, top, sort, collect, WAIT_TOTAL_MS);
  }

  /**
   * Wait out a known capture's close, collect its track, and rank it. Takes
   * the capture rather than re-reading `this.capture` so a caller that
   * snapshotted one cannot be handed a different capture's numbers.
   */
  private async finish(
    capture: Capture,
    top: number,
    sort: ProfileSort,
    collect: TrackCollector | undefined,
    timeoutMs: number,
  ): Promise<ProfileResult> {
    try {
      await this.wait(() => capture.result !== null, timeoutMs, 'Godot sent no profiler totals');
    } catch (err) {
      // Close the capture out either way, so it never sits in `stopping` and
      // stays re-readable. But only a timeout is recoverable here: the engine
      // went quiet while the connection held, and what we folded is still
      // good. A disconnect means the process died mid-capture, which the
      // caller needs told — a later stop_profiler re-reads the partial data.
      this.finalize(capture);
      const recoverable = err instanceof ProfilerError && err.code === 'profile_timeout';
      if (!recoverable || capture.frames === 0) throw err;
    }
    // Only now, with the profiler off: the bridge serializes every sample in
    // one frame, and that hitch must not land in the capture it describes.
    await this.collectTrack(capture, collect);
    return this.summarize(capture, top, sort);
  }

  /**
   * `start` + wait out the window + `stop`, for a one-shot capture. `collect`
   * fetches the track the bridge sampled alongside, once the window closed.
   */
  async captureWindow(
    seconds: number,
    top: number,
    sort: ProfileSort,
    captureLimit: number = CAPTURE_LIMIT_MAX,
    options: CaptureOptions = {},
    collect?: TrackCollector,
  ): Promise<ProfileResult> {
    const { capture } = await this.open(seconds, captureLimit, options);
    return this.finish(capture, top, sort, collect, seconds * 1000 + WAIT_TOTAL_MS);
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
    socket.on('close', () => {
      // Release the slot even when `fail` short-circuits on an earlier error,
      // so `connected` stops claiming a peer that is gone.
      if (this.socket === socket) this.socket = null;
      this.fail('Debugger disconnected');
    });
  }

  /** Read one pending byte without joining the chunk list. */
  private byteAt(index: number): number {
    let remaining = index;
    for (const chunk of this.rxChunks) {
      if (remaining < chunk.length) return chunk[remaining] as number;
      remaining -= chunk.length;
    }
    throw new Error('Debugger read past the pending buffer');
  }

  private receive(chunk: Buffer): void {
    this.rxChunks.push(chunk);
    this.rxLength += chunk.length;
    while (this.rxLength >= 4) {
      // Read the length prefix in place. Joining on every socket chunk would
      // make assembling one large packet quadratic in its size.
      const size =
        this.byteAt(0) +
        this.byteAt(1) * 0x100 +
        this.byteAt(2) * 0x10000 +
        this.byteAt(3) * 0x1000000;
      if (size === 0) {
        this.fail('Debugger sent a zero-length packet (framing desync)');
        return;
      }
      if (size > MAX_PACKET_BYTES) {
        this.fail(`Debugger packet of ${size} bytes exceeds the ${MAX_PACKET_BYTES}-byte limit`);
        return;
      }
      if (this.rxLength < 4 + size) return;
      const joined =
        this.rxChunks.length === 1
          ? (this.rxChunks[0] as Buffer)
          : Buffer.concat(this.rxChunks, this.rxLength);
      const payload = joined.subarray(4, 4 + size);
      const rest = joined.subarray(4 + size);
      this.rxChunks = rest.length > 0 ? [rest] : [];
      this.rxLength = rest.length;
      let message: Variant;
      try {
        message = decodeVariant(payload);
      } catch (err) {
        // Unrelated debugger packets carry objects and vectors we don't decode.
        this.lastDecodeError = err instanceof Error ? err.message : String(err);
        this.undecodable += 1;
        if (this.capture !== null) this.capture.undecodablePackets += 1;
        continue;
      }
      try {
        this.handle(message);
      } catch (err) {
        // A frame we cannot parse is a stream we cannot trust, but it is not a
        // dropped connection — report it as what it is.
        const code = err instanceof ProfilerError ? err.code : 'profile_disconnected';
        this.fail(err instanceof Error ? err.message : String(err), code);
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
    if (name === 'visual:hardware_info') {
      if (typeof data[0] === 'string' && typeof data[1] === 'string') {
        this.hardware = { cpu: data[0], gpu: data[1] };
      }
      return;
    }
    if (name === 'performance:profile_names') {
      // 4.6+ sends `[names, types]`; earlier builds send the names alone.
      const names = Array.isArray(data[0]) ? data[0] : data;
      this.customMonitorNames = names.map((entry) => String(entry));
      return;
    }
    const capturing =
      this.state === 'starting' || this.state === 'capturing' || this.state === 'stopping';
    if (name === 'performance:profile_frame') {
      // Every sample moves the compilation baseline, so the next capture can
      // count from the sample just before it opened.
      const sample = readMonitorSample(data, this.customMonitorNames);
      this.lastCompilations = compilationTotal(sample.builtin) ?? this.lastCompilations;
      if (capturing && this.capture !== null) {
        foldMonitorSample(this.capture.monitors, sample, this.customMonitorNames);
        const drawCalls = sample.builtin[DRAW_CALLS_MONITOR];
        const bucket = this.timelineBucket(this.capture);
        if (bucket !== null && drawCalls !== null && drawCalls !== undefined) {
          bucket.drawCalls = drawCalls;
        }
      }
      return;
    }
    if (!capturing || this.capture === null) return;
    const capture = this.capture;

    if (name === 'servers:function_signature') {
      if (typeof data[0] === 'string' && typeof data[1] === 'number') {
        this.signatures.set(data[1], data[0]);
      }
      return;
    }
    if (name === 'visual:profile_frame') {
      const visual = capture.visual;
      // Frames still in flight when the profiler was switched off go with it.
      if (visual === null || visual.stoppedAt !== null) return;
      const render = foldVisualFrame(visual, parseVisualFrame(data));
      if (render === null) return;
      visual.truncatedRun = render.truncated ? visual.truncatedRun + 1 : 0;
      // Once stopping, the capture has switched visual off already.
      if (visual.truncatedRun >= VISUAL_OVERFLOW_STOP_FRAMES && this.state !== 'stopping') {
        visual.stoppedAt = capture.frames > 0 ? (Date.now() - capture.startedAt) / 1000 : 0;
        this.write(['profiler:visual', this.threadId, [false]]);
      }
      const bucket = this.timelineBucket(capture);
      if (bucket !== null) foldTimelineRender(bucket, render);
      return;
    }
    if (name !== 'servers:profile_frame' && name !== 'servers:profile_total') return;

    const sample = parseFrame(data, this.signatures);
    const rows = sample.rows;

    if (name === 'servers:profile_total') {
      // The engine's own accumulated rows are capped by `captureLimit` exactly
      // as the frame packets are, and carry nothing the frames did not already
      // deliver — while top-N membership rotates between frames, so summing
      // them covers strictly more functions. Verified against Godot: at a limit
      // of 16 the frames saw 37 distinct functions and this packet only 16, and
      // its call counts match our sums exactly. So this is a completion
      // sentinel, not the source of the totals.
      this.finalize(capture);
      return;
    }
    if (this.state === 'starting') this.state = 'capturing';
    capture.framesReceived += 1;
    // Enabling the profiler inside a running VM call gives that first sample a
    // zero start timestamp, so its elapsed time is fiction. Drop it — and with
    // it any truncation it reported, which describes numbers we discarded.
    if (capture.framesReceived === 1) return;

    // The engine fills each frame packet up to `captureLimit` rows, chosen by
    // inclusive time, before we drop the zero-call ones — so the raw count is
    // what says whether this frame was truncated.
    capture.capped = capture.capped || sample.rawRowCount >= capture.limit;

    const frame = sample.frame;
    capture.frames += 1;
    if (capture.frames === 1) {
      // Measure the window from real data, not from the enable round trip: the
      // handshake and first-frame latency are not time the game was profiled.
      capture.startedAt = Date.now();
      this.armAutoStop();
    }
    if (capture.firstFrame === null) capture.firstFrame = frame;
    if (capture.lastFrame !== null) {
      capture.frameGaps += Math.max(0, frame - capture.lastFrame - 1);
    }
    capture.lastFrame = frame;
    capture.lastFrameAt = Date.now();
    const slow = sample.timings.frameMs > 1000 / capture.targetFps;
    if (slow) capture.slowFrames += 1;
    const bucket = this.timelineBucket(capture);
    if (bucket !== null) foldTimelineFrame(bucket, sample, slow);

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
    if (capture.frames === 0) {
      // Dividing by a synthetic 1 here would return a well-formed payload of
      // zeroes and an empty `rows`, which reads exactly like "nothing in this
      // game is slow" rather than "nothing was measured".
      throw new ProfilerError(
        'profile_no_frames',
        `The capture folded no usable frames (received ${capture.framesReceived}; the first is ` +
          `always discarded), so there is nothing to rank`,
      );
    }
    const frames = capture.frames;
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
    const spanMs = capture.lastFrameAt - capture.startedAt;
    const spanFrames = (capture.lastFrame ?? 0) - (capture.firstFrame ?? 0);
    return roundNumbers({
      seconds: capture.elapsedMs / 1000,
      frames: capture.frames,
      fps: spanMs > 0 && spanFrames > 0 ? spanFrames / (spanMs / 1000) : null,
      targetFps: capture.targetFps,
      slowFrames: capture.slowFrames,
      framesReceived: capture.framesReceived,
      firstFrame: capture.firstFrame,
      lastFrame: capture.lastFrame,
      frameGaps: capture.frameGaps,
      undecodablePackets: capture.undecodablePackets,
      captureLimit: capture.limit,
      limitReached: capture.capped,
      sort,
      functionsReceived: rows.length,
      unresolvedFunctions: rows.filter((r) => !r.sourceResolved).length,
      frame,
      servers,
      rows: rows.slice(0, top),
      worstFrame: capture.worst,
      monitors: summarizeMonitors(capture.monitors),
      visual: capture.visual === null ? null : summarizeVisual(capture.visual, this.hardware, top),
      timeline: capture.timeline === null ? null : summarizeTimeline(capture.timeline, spanMs),
    });
  }

  /**
   * The timeline bucket for something arriving now. Nothing is placed before
   * the first folded frame: that frame starts the clock the buckets count from.
   */
  private timelineBucket(capture: Capture): Bucket | null {
    if (capture.timeline === null || capture.frames === 0) return null;
    return bucketAt(capture.timeline, Date.now() - capture.startedAt);
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
    if (this.capture) {
      this.send(false, this.capture.limit);
      const visual = this.capture.visual;
      if (visual !== null && visual.stoppedAt === null) {
        this.write(['profiler:visual', this.threadId, [false]]);
      }
    }
    this.notify();
  }

  private armAutoStop(): void {
    this.clearAutoStop();
    const seconds = this.capture?.maxSeconds ?? PROFILE_MAX_SECONDS;
    this.autoStopTimer = setTimeout(() => this.autoStop(), seconds * 1000);
  }

  private clearAutoStop(): void {
    if (this.autoStopTimer === null) return;
    clearTimeout(this.autoStopTimer);
    this.autoStopTimer = null;
  }

  /**
   * Close a capture out. Called on the engine's `profile_total`, and again if
   * that packet never arrives — a capture left in `stopping` would reject every
   * later `start` as busy while `stop` kept timing out, and the advice on that
   * error points straight back at `stop`.
   */
  private finalize(capture: Capture): void {
    if (capture.result === null) {
      capture.result = [...capture.totals.values()];
      capture.elapsedMs = Date.now() - capture.startedAt;
    }
    this.state = 'finished';
    this.clearAutoStop();
  }

  private fail(reason: string, code: ProfilerErrorCode = 'profile_disconnected'): void {
    // A clean teardown destroys the socket, which fires `close` — that is not a
    // disconnect worth reporting or logging.
    if (this.error !== null || this.closed) return;
    this.error = reason;
    logDebug(`[Profiler] ${reason}`);
    // Stop reading: leaving the socket subscribed after a framing error means
    // the bad header stays at offset 0 and the pending buffer never drains.
    this.socket?.destroy();
    this.socket = null;
    this.rxChunks = [];
    this.rxLength = 0;
    this.rejectWaiters(new ProfilerError(code, reason));
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
