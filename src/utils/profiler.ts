/** Receiver for the engine's remote-debugger profiler stream; only a launch with `--remote-debug` can profile, so attached sessions cannot. */

import * as net from 'net';
import {
  decodeVariant,
  encodeVariant,
  MAX_PACKET_BYTES,
  peekMessageName,
  type Variant,
} from './godot-variant.js';
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
/** Engine text when a frame runs out of render timestamp slots (RenderingDevice says so; Compatibility only fails the condition). */
export const TIMESTAMP_OVERFLOW_ERRORS = [
  'Tried capturing more timestamps than the configured maximum',
  'timestamp_count >= max_timestamp_query_elements',
] as const;
/** Remedy shared by every tool that surfaces it; the Compatibility renderer ignores the setting and stops at a compile-time MAX_QUERIES of 256. */
export const TIMESTAMP_OVERFLOW_FIX =
  'Forward+/Mobile: add settings/profiler/max_timestamp_query_elements=4096 under [debug] in project.godot and relaunch. Compatibility: the limit is fixed at 256 - profile this scene without visual.';
export const TIMELINE_MS_MIN = 250;
export const TIMELINE_MS_MAX = 5000;
/** Intervals a timeline splits its window into; a longer window gets wider intervals to bound the agent's context cost. */
export const MAX_TIMELINE_BUCKETS = 60;
const TIMELINE_MS_STEP = 50;
export const TARGET_FPS_MAX = 1000;
export const DEFAULT_TARGET_FPS = 60;
export const MS_PER_SECOND = 1000;
/** Intervals a timeline may grow past its window for frames arriving just after it closes; later ones are not placed. */
const TIMELINE_OVERRUN_BUCKETS = 2;
/** Share of an interval the trailing bucket must cover before its frame count is divided into a rate; shorter is noise. */
const TRAILING_BUCKET_MIN_SHARE = 1 / 4;

export function timelineBucketMs(timelineMs: number, seconds: number): number {
  const widest =
    Math.ceil((seconds * MS_PER_SECOND) / MAX_TIMELINE_BUCKETS / TIMELINE_MS_STEP) *
    TIMELINE_MS_STEP;
  return Math.min(TIMELINE_MS_MAX, Math.max(timelineMs, widest));
}

/** Bound on the rows kept for the slowest frame — a full frame is unbounded. */
const WORST_FRAME_ROWS = 30;
const WORST_FRAME_AREAS = 15;
/** Every visual row is `[name, cpu ms, gpu ms]`. */
const AREA_STRIDE = 3;
/** Written by `TIMESTAMP_BEGIN()` only while frame profiling is on; a frame without it was timed before the profiler was enabled. */
const FRAME_BEGIN = 'Frame Begin';
/** Visual frames skipped after each enable: readback rings of 2-3 frames can hold timing from before this capture (5 measured on 4.7). */
const VISUAL_SETTLE_FRAMES = 5;
/** Consecutive truncated frames after which the visual profiler is switched off: the per-marker error logging would slow the game and skew every timing. */
const VISUAL_OVERFLOW_STOP_FRAMES = 3;
/** Joins a stage to its groups. Engine stage names contain `/` but never this. */
const PATH_SEPARATOR = ' > ';
const OTHER_AREA = '(other)';
/** Uncovered group time at or below this is float noise, not an `(other)` row. */
const OTHER_AREA_MIN_MS = 1e-9;
const MIB = 1024 * 1024;
/** Custom monitors tracked per capture; the peer decides how many exist. */
const MAX_CUSTOM_MONITORS = 64;
/** Names of dropped custom monitors remembered, so a hostile peer cannot grow the set. */
const MAX_DROPPED_MONITOR_NAMES = 256;
const DROPPED_MONITOR_NAMES_SHOWN = 3;
/** Arrival lag beyond the engine's own frame times after which this process is blamed; network batching stays under it, a synchronous stretch here does not. */
const UNACCOUNTED_ARRIVAL_GAP_MS = 100;
/** Things kept per kind in a timeline bucket, so many script functions cannot crowd out render stages and server calls. */
const MAX_BUCKET_ITEMS = 512;
const BUCKET_TOP = 3;
/** Every engine row is `[signature id, calls, self, total, internal]`. */
const ROW_STRIDE = 5;
/** Milliseconds are reported to this many decimals; below it is float noise. */
const MS_DECIMALS = 4;
const MS_ROUNDING = 10 ** MS_DECIMALS;

const WAIT_CONNECT_MS = 5000;
const WAIT_FIRST_FRAME_MS = 5000;
const WAIT_TOTAL_MS = 10000;
/** Longest blocking-capture window: the call answers only at its end, and a client with no progress token drops requests after 60 s (MCP SDK default). */
export const PROFILE_WINDOW_MAX_SECONDS = 30;
/** Worst case a blocking capture takes: connection wait, first-frame wait, the window and the closing-packet wait. */
export const PROFILE_WINDOW_WORST_CASE_MS =
  WAIT_CONNECT_MS +
  WAIT_FIRST_FRAME_MS +
  PROFILE_WINDOW_MAX_SECONDS * MS_PER_SECOND +
  WAIT_TOTAL_MS;

/** The packet that answers a `profiler:servers` disable. Its body is never read. */
const SENTINEL_MESSAGE = 'servers:profile_total';
/** Messages this receiver reads; any other debugger message is recognised by name and its body never decoded. */
const CONSUMED_MESSAGES: ReadonlySet<string> = new Set([
  'set_pid',
  'debug_enter',
  'visual:hardware_info',
  'visual:profile_frame',
  'performance:profile_names',
  'performance:profile_frame',
  'servers:function_signature',
  'servers:profile_frame',
]);
/** Every debugger message this server understands is `[name, thread id, data]`. */
const MESSAGE_ARITY = 3;
/** Monitor samples after which an unanswered disable is given up on: past the two that can precede the sentinel,
 * it was sent and lost (the engine drops messages when its queue is full) and waiting would discard later captures' frames. */
const SENTINEL_LOST_AFTER_MONITOR_SAMPLES = 3;
/** Least spacing between counted monitor samples (half the engine's 1 s interval): samples queued behind a busy event loop
 * arrive together, some sent before the disable, so a burst counts once. */
const SENTINEL_LOST_SAMPLE_MIN_SPACING_MS = 500;
/** Least wait before a disable is given up on, whatever the sample count; shorter than a stop's sentinel wait so a lost sentinel still ends a stop early. */
const SENTINEL_LOST_MIN_WAIT_MS = 4_000;
/** Game-supplied values are reported exactly as sampled; rounding is for this server's own timing arithmetic. */
const GAME_VALUE_KEYS: ReadonlySet<string> = new Set(['track', 'custom']);

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
  percentOfFrame: number | null;
  peak: ProfilePeak | null;
}

export interface ProfileStat {
  avg: number;
  max: number;
}

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
  timelineMs: number | null;
  maxSeconds: number;
  firstFrame: number | null;
  captureLimit: number;
}

export interface CaptureOptions {
  visual?: boolean;
  /** Timeline bucket length in ms; absent or null records no timeline. */
  timelineMs?: number | null;
  targetFps?: number;
  /** NodePath:property specs the bridge samples; they reach the capture through the `TrackCollector` given to stop, never through this receiver. */
  track?: string[];
}

export interface TrackSample {
  frame: number;
  values: Record<string, unknown>;
}

/** Fetch a capture's track from the bridge once it has closed, so the hand-over lands outside measured frames; must not reject. */
export type TrackCollector = () => Promise<{ samples: TrackSample[] | null; error: string | null }>;

export interface TimelineItem {
  kind: 'script' | 'server' | 'render';
  name: string;
  /** Milliseconds per frame across the bucket; render stages use the heavier of CPU and GPU. */
  ms: number;
  maxMs: number;
}

export interface TimelineBucket {
  t: number;
  frames: number;
  /** Null for a trailing bucket too short to divide by. */
  fps: number | null;
  frameMs: ProfileStat | null;
  processMs: number | null;
  physicsMs: number | null;
  scriptMs: number | null;
  slowFrames: number;
  /** Render timeline per profiled frame; `gpuMs` is null when no GPU work was timed in the whole capture. */
  render: { cpuMs: number; gpuMs: number | null } | null;
  drawCalls: number | null;
  top: TimelineItem[];
  track: Record<string, unknown> | null;
}

export interface TimelineResult {
  bucketMs: number;
  track: string[];
  trackError: string | null;
  buckets: TimelineBucket[];
}

export interface VisualArea {
  /** The engine's group nesting, e.g. `Render Viewports > Render Viewport 0 > Render 3D Scene`. */
  path: string;
  name: string;
  /** A bracketed group: its times include everything inside it. */
  group: boolean;
  frames: number;
  cpuMs: ProfileStat;
  /** Null when the renderer timed no GPU work (`gpuTimed` false). */
  gpuMs: ProfileStat | null;
}

export interface VisualWorstFrame {
  frame: number;
  cpuMs: number;
  /** Null, here and in `areas`, when the renderer timed no GPU work. */
  gpuMs: number | null;
  areas: Array<{ path: string; cpuMs: number; gpuMs: number | null }>;
}

export interface VisualResult {
  hardware: { cpu: string; gpu: string } | null;
  framesReceived: number;
  frames: number;
  /** False when every GPU timestamp was zero: the renderer did not time the GPU. */
  gpuTimed: boolean;
  /** Frames that lost markers to `debug/settings/profiler/max_timestamp_query_elements`; the engine logs an error per dropped marker. */
  truncatedFrames: number;
  /** Seconds into the capture at which the visual profiler was switched off for repeated truncation; null if it ran throughout. */
  stoppedAt: number | null;
  /** The whole render timeline of a frame; `cpuMs` and `gpuMs` are null when no render frame was folded, and `gpuMs` also when `gpuTimed` is false. */
  cpuMs: ProfileStat | null;
  gpuMs: ProfileStat | null;
  areasReceived: number;
  areas: VisualArea[];
  worstFrame: VisualWorstFrame | null;
}

export interface MonitorStat {
  avg: number;
  min: number;
  max: number;
}

/** `Performance.Monitor` indices with the factor from bytes to the reported unit; the enum only grows at its end, so an index is stable across 4.x. */
// TIME_* (0-3) are left out: FPS lags up to two seconds and the process times are per-second maxima.
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
const DRAW_CALLS_MONITOR = MONITORS.find(([name]) => name === 'drawCallsInFrame')![1];

/** `PIPELINE_COMPILATIONS_*` (4.4+): running totals since launch, not per frame. */
const PIPELINE_COMPILATION_MONITORS = [34, 35, 36, 37, 38];

/** A named monitor is null when no sample carried a finite value: a 0 would read as 'no draw calls' rather than 'not measured'. */
export type MonitorsResult = { samples: number } & Record<MonitorName, MonitorStat | null> & {
    /** `duringCapture` is null when a single sample left nothing to count from. */
    pipelineCompilations: { duringCapture: number | null; total: number } | null;
    custom: Array<{ name: string } & MonitorStat>;
  };

export interface ProfileResult {
  /** Present only when the numbers need a caveat; always the first key. */
  warnings?: string[];
  /** False when the capture closed without the engine's totals packet or after a disconnect. */
  complete: boolean;
  seconds: number;
  frames: number;
  /** Engine frames per second: the frame-number span over the wall time between first and last folded frame; null when that span is empty. */
  fps: number | null;
  targetFps: number;
  slowFrames: number;
  framesReceived: number;
  firstFrame: number | null;
  lastFrame: number | null;
  frameGaps: number;
  /** Debugger packets the codec could not represent; non-zero means the capture may be missing frames. */
  undecodablePackets: number;
  captureLimit: number;
  limitReached: boolean;
  sort: ProfileSort;
  functionsReceived: number;
  unresolvedFunctions: number;
  frame: Record<keyof FrameTimings, ProfileStat>;
  servers: ProfileServer[];
  rows: ProfileRow[];
  worstFrame: ({ frame: number } & FrameTimings & { rows: FrameRow[] }) | null;
  monitors: MonitorsResult | null;
  visual: VisualResult | null;
  timeline: TimelineResult | null;
}

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
  maxSeconds: number;
  startedAt: number;
  /** Arrival time of the newest folded frame (0 before the first); ends the `fps` span and, for a capture closed without totals, the window. */
  lastFrameAt: number;
  elapsedMs: number;
  /** Frames folded into the totals (excludes the discarded boundary frame). */
  frames: number;
  framesReceived: number;
  frameGaps: number;
  undecodablePackets: number;
  firstFrame: number | null;
  lastFrame: number | null;
  capped: boolean;
  totals: Map<string, FrameRow>;
  peaks: Map<string, ProfilePeak>;
  timingSums: FrameTimings;
  timingMax: FrameTimings;
  servers: Map<string, Map<string, number>>;
  worst: ({ frame: number } & FrameTimings & { rows: FrameRow[] }) | null;
  result: FrameRow[] | null;
  /** How the capture was closed out; null while open. `no_start` means the first frame never arrived and nothing was recorded. */
  closedBy: 'sentinel' | 'timeout' | 'disconnect' | 'no_start' | null;
  monitors: MonitorCapture;
  visual: VisualCapture | null;
  targetFps: number;
  slowFrames: number;
  timeline: TimelineCapture | null;
  /** Frames that arrived later than the engine's frame times account for; see `UNACCOUNTED_ARRIVAL_GAP_MS`. */
  arrivalStalls: number;
  /** Why the receiver itself closed the capture as `disconnect` (an unreadable stream); null when the game ended it. */
  receiverFault: string | null;
}

interface BucketItem {
  kind: TimelineItem['kind'];
  name: string;
  sum: number;
  max: number;
}

/** A bucket's candidates for its `top`, per kind; display names are built once per item, not once per frame. */
interface BucketItems {
  scripts: Map<string, BucketItem>;
  servers: Map<string, Map<string, BucketItem>>;
  serverCount: number;
  render: Map<string, BucketItem>;
}

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
  /** Totals while the bucket fills; dropped once ranked into `top`, so a long capture keeps one bucket's totals, not one per interval. */
  items: BucketItems | null;
  top: TimelineItem[];
  renderFrames: number;
  renderCpuSum: number;
  renderGpuSum: number;
  drawCalls: number | null;
  /** True when this server's event loop was busy during the interval: frames were read late, so the count over its length says nothing about the game. */
  stalled: boolean;
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

interface Accumulator {
  count: number;
  sum: number;
  min: number;
  max: number;
}

/** Monitor samples folded as they arrive; the peer decides how many and how wide, so none is kept whole. */
interface MonitorCapture {
  samples: number;
  named: Map<MonitorName, Accumulator>;
  custom: Map<string, Accumulator>;
  droppedCustom: Set<string>;
  /** Pipeline compilations at the last sample before the capture opened, so even a one-sample capture can report what compiled. */
  baselineCompilations: number | null;
  firstCompilations: number | null;
  lastCompilations: number | null;
}

interface FrameArea {
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
  /** GPU times as the engine sent them; `summarizeVisual` decides whether they were measured. */
  worst: WorstRenderFrame | null;
}

interface WorstRenderFrame {
  frame: number;
  cpuMs: number;
  gpuMs: number;
  areas: Array<{ path: string; cpuMs: number; gpuMs: number }>;
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

/** Engine timings are finite integer ticks; a NaN or infinity would serialize as `null` and break the output schema, so it is treated as an unknown layout. */
function asNumber(value: Variant | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw badFrame('expected a finite number');
  }
  return value;
}

/** Counts and loop bounds must be non-negative integers: a float from a layout shift would make `for (i < 0.016)` run once instead of throwing. */
function asCount(value: Variant | undefined, limit: number): number {
  const count = asNumber(value);
  if (!Number.isSafeInteger(count) || count < 0 || count > limit) {
    throw badFrame(`expected a count in [0, ${limit}], got ${count}`);
  }
  return count;
}

/** Trims float noise from the summary's own millisecond arithmetic; a subtree under `GAME_VALUE_KEYS` is returned untouched. */
function roundNumbers<T>(value: T): T {
  if (typeof value === 'number') return (Math.round(value * MS_ROUNDING) / MS_ROUNDING) as T;
  if (Array.isArray(value)) return value.map(roundNumbers) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        key,
        GAME_VALUE_KEYS.has(key) ? inner : roundNumbers(inner),
      ]),
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

interface FrameSample {
  frame: number;
  timings: FrameTimings;
  servers: Array<{ name: string; functions: Array<{ name: string; ms: number }> }>;
  rows: FrameRow[];
  /** Rows the engine sent before zero-call rows are dropped; `captureLimit` applies to this count, so the truncation check needs it. */
  rawRowCount: number;
}

/** Splits the engine's per-frame array (verified against `ServersProfilerFrame::serialize()`). */
// `internal_time` at `i + 4` is deliberately skipped (the editor's 'internal functions' toggle).
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

/** Splits the engine's visual frame: `name, cpu ms, gpu ms` per marker (verified against `VisualProfilerFrame::serialize()`, unchanged since 4.0). */
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

/** A marker's stage lasts until the next; `>name` opens a group and `<name` closes it. Unlike the editor, uncovered group time becomes an `(other)` row. */
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
    if (otherCpu > OTHER_AREA_MIN_MS || otherGpu > OTHER_AREA_MIN_MS) {
      add(childPath(group, OTHER_AREA), OTHER_AREA, false, otherCpu, otherGpu);
    }
    const parent = stack[stack.length - 1];
    if (parent !== undefined) {
      parent.childCpuMs += cpuMs;
      parent.childGpuMs += gpuMs;
    }
  };
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
      // A group opened while one of its name is open is that stage's next pass, not a child: the engine opens 'Render DirectionalLight2D Shadows'
      // once per light but closes it once (renderer_viewport.cpp), so nesting would let the first pass claim the swap and vsync wait.
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
      // A close with no open group of its name is dropped so it cannot wreck the rest of the frame.
      closeTo(marker.name.slice(1).trim(), marker);
      return;
    }
    const parent = stack[stack.length - 1];
    // The first and last markers bound the timeline and start no stage, as in the editor; the Compatibility 'Internal Begin' ahead of 'Frame Begin' is none either.
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
  // A group still open here means the frame ran out of timestamp slots and lost its remaining markers, closes included.
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

interface FoldedRender {
  cpuMs: number;
  gpuMs: number;
  areas: FrameArea[];
  truncated: boolean;
}

function foldVisualFrame(visual: VisualCapture, sample: VisualSample): FoldedRender | null {
  visual.framesReceived += 1;
  if (visual.framesReceived <= VISUAL_SETTLE_FRAMES) return null;
  // Timed while profiling was off: the Compatibility renderer writes 'Internal Begin/End' regardless.
  if (!sample.markers.some((marker) => marker.name === FRAME_BEGIN)) return null;
  // While nothing draws, the engine re-sends the last frame under the same number; only a new draw advances it.
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
  // No folded frame means no area or worst frame, so only the two whole-frame stats could divide by zero.
  const frames = visual.frames;
  // A renderer that times no GPU work sends 0 for every GPU timestamp: null, not a free GPU.
  const gpu = <T>(measured: T): T | null => (visual.gpuTimed ? measured : null);
  const areas: VisualArea[] = [];
  for (const totals of visual.areas.values()) {
    if (totals.cpuMax <= 0 && totals.gpuMax <= 0) continue;
    areas.push({
      path: totals.path,
      name: totals.name,
      group: totals.group,
      frames: totals.frames,
      cpuMs: { avg: totals.cpuSum / frames, max: totals.cpuMax },
      gpuMs: gpu({ avg: totals.gpuSum / frames, max: totals.gpuMax }),
    });
  }
  const cost = (area: VisualArea): number => Math.max(area.cpuMs.avg, area.gpuMs?.avg ?? 0);
  areas.sort((a, b) => cost(b) - cost(a) || a.path.localeCompare(b.path));
  const worst = visual.worst;
  return {
    hardware,
    framesReceived: visual.framesReceived,
    frames,
    gpuTimed: visual.gpuTimed,
    truncatedFrames: visual.truncatedFrames,
    stoppedAt: visual.stoppedAt,
    cpuMs: frames > 0 ? { avg: visual.cpuSum / frames, max: visual.cpuMax } : null,
    gpuMs: frames > 0 ? gpu({ avg: visual.gpuSum / frames, max: visual.gpuMax }) : null,
    areasReceived: areas.length,
    areas: areas.slice(0, top),
    worstFrame:
      worst === null
        ? null
        : {
            frame: worst.frame,
            cpuMs: worst.cpuMs,
            gpuMs: gpu(worst.gpuMs),
            areas: worst.areas.map((area) => ({ ...area, gpuMs: gpu(area.gpuMs) })),
          },
  };
}

function newTimeline(bucketMs: number, maxSeconds: number, track: string[]): TimelineCapture {
  return {
    bucketMs,
    maxBuckets: Math.ceil((maxSeconds * MS_PER_SECOND) / bucketMs) + TIMELINE_OVERRUN_BUCKETS,
    buckets: [],
    track,
    samples: null,
    trackError: null,
    collecting: null,
  };
}

/** Bucket for something arriving `elapsedMs` after the first frame. Only frames grow the timeline: a late monitor sample or visual frame lands in the newest bucket instead of opening a frameless trailing one that reads as a freeze. Null past the window's end. */
function bucketAt(timeline: TimelineCapture, elapsedMs: number, grow: boolean): Bucket | null {
  const index = Math.max(0, Math.floor(elapsedMs / timeline.bucketMs));
  if (index >= timeline.maxBuckets) return null;
  if (!grow && index >= timeline.buckets.length) {
    return timeline.buckets[timeline.buckets.length - 1] ?? null;
  }
  while (timeline.buckets.length <= index) {
    // A later bucket existing means nothing more lands before it: rank this one now.
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
      stalled: false,
    });
  }
  return timeline.buckets[index] ?? null;
}

function markStalled(timeline: TimelineCapture, fromMs: number, toMs: number): void {
  const first = Math.max(0, Math.floor(fromMs / timeline.bucketMs));
  const last = Math.min(Math.floor(toMs / timeline.bucketMs), timeline.buckets.length - 1);
  for (let index = first; index <= last; index++) timeline.buckets[index]!.stalled = true;
}

function bump(item: BucketItem, ms: number): void {
  item.sum += ms;
  if (ms > item.max) item.max = ms;
}

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

function summarizeTimeline(
  timeline: TimelineCapture,
  spanMs: number,
  gpuTimed: boolean,
): TimelineResult {
  const samples = [...(timeline.samples ?? [])].sort((a, b) => a.frame - b.frame);
  const last = timeline.buckets.length - 1;
  const buckets = timeline.buckets.map((bucket, index): TimelineBucket => {
    const startMs = index * timeline.bucketMs;
    // Only the trailing bucket is partial: from its start to the last frame it is too short to divide by if the capture ended just inside it.
    const durationMs = index === last ? spanMs - startMs : timeline.bucketMs;
    const fps =
      !bucket.stalled && durationMs >= timeline.bucketMs * TRAILING_BUCKET_MIN_SHARE
        ? bucket.frames / (durationMs / MS_PER_SECOND)
        : null;
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
      t: startMs / MS_PER_SECOND,
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
              gpuMs: gpuTimed ? bucket.renderGpuSum / bucket.renderFrames : null,
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
    droppedCustom: new Set(),
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

function monitorStat(accumulator: Accumulator): MonitorStat {
  return {
    avg: accumulator.sum / accumulator.count,
    min: accumulator.min,
    max: accumulator.max,
  };
}

/** One `performance:profile_frame` read against the custom monitor names in force when it arrived; a non-finite value is absent (the engine forwards any `is_num()` value, infinities included). */
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
    if (!monitors.custom.has(name) && monitors.custom.size >= MAX_CUSTOM_MONITORS) {
      if (monitors.droppedCustom.size < MAX_DROPPED_MONITOR_NAMES) monitors.droppedCustom.add(name);
      return;
    }
    accumulate(monitors.custom, name, value);
  });
}

function summarizeMonitors(monitors: MonitorCapture): MonitorsResult | null {
  if (monitors.samples === 0) return null;
  const named = {} as Record<MonitorName, MonitorStat | null>;
  for (const [name] of MONITORS) {
    const accumulator = monitors.named.get(name);
    named[name] = accumulator === undefined ? null : monitorStat(accumulator);
  }

  // Running totals since launch: compiled = growth from the last sample before the capture to its last. With no baseline and one sample
  // there is nothing to count from, and a 0 would read as 'nothing compiled'.
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

interface PendingDisable {
  capture: Capture;
  monitorSamples: number;
  writtenAt: number;
  lastCountedAt: number;
}

const SHAPE_PREVIEW_ITEMS = 4;

function describeShape(message: Variant): string {
  const kind = (value: Variant | undefined): string => {
    if (value === null || value === undefined) return 'null';
    if (Array.isArray(value)) return `array(${value.length})`;
    if (typeof value === 'object') return 'packed array';
    return typeof value;
  };
  if (!Array.isArray(message)) return kind(message);
  const items = message.slice(0, SHAPE_PREVIEW_ITEMS).map(kind).join(', ');
  return `array(${message.length}) [${items}${message.length > SHAPE_PREVIEW_ITEMS ? ', ...' : ''}]`;
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
  /** Sent once per visual toggle and by `performance:profile_names` only when the set changes, usually before any capture opens, so both are kept for the session. */
  private hardware: VisualResult['hardware'] = null;
  private customMonitorNames: string[] = [];
  private lastCompilations: number | null = null;
  private capture: Capture | null = null;
  /** Disables written and not yet answered, oldest first: the engine answers each `profiler:servers` disable with one sentinel, in order.
   * An entry outlives a capture closed by timeout so its late frames and sentinel are dropped, not read as the next capture's. */
  private pendingDisables: PendingDisable[] = [];
  private wellFormedMessages = 0;
  private malformedMessages = 0;
  private firstMalformedShape: string | null = null;
  private autoStopTimer: NodeJS.Timeout | null = null;
  private waiters: Waiter[] = [];

  private constructor(
    private readonly server: net.Server,
    readonly port: number,
  ) {
    server.on('connection', (socket) => this.accept(socket));
    server.on('error', (err) => this.fail(err.message));
  }

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

  /** A finished capture stays readable once the engine is gone: `stop` only re-ranks folded data, and the capture worth reading is often the one before a crash. */
  get hasResult(): boolean {
    return this.capture?.result !== null && this.capture !== null;
  }

  get hasFrames(): boolean {
    return this.capture !== null && this.capture.frames > 0;
  }

  get connected(): boolean {
    return this.socket !== null && this.threadId !== null;
  }

  /** Set when packets arrived and none read as a message: the debugger protocol differs, nothing can be profiled and `debug_enter` goes unanswered, so the first script error pauses the game. */
  get streamProblem(): string | null {
    const unread = this.malformedMessages + this.undecodable;
    if (unread === 0 || this.wellFormedMessages > 0) return null;
    const seen =
      this.firstMalformedShape !== null
        ? `first layout seen: ${this.firstMalformedShape}`
        : `decode error: ${this.lastDecodeError ?? 'none'}`;
    return (
      `Godot sent ${unread} debugger message(s) and none could be read as [name, thread id, data] (${seen}). ` +
      `This Godot version's debugger protocol is not one this server supports: nothing can be profiled, ` +
      `and a script error or breakpoint will pause the game for good because the pause cannot be answered. ` +
      `Run the project without profiling: true.`
    );
  }

  /** Enable the engine profiler; the capture stops itself after `seconds` so a forgotten `start_profiler` cannot profile the rest of the session. */
  async start(
    seconds: number,
    captureLimit: number,
    options: CaptureOptions = {},
  ): Promise<ProfileStartResult> {
    return (await this.open(seconds, captureLimit, options)).started;
  }

  /** Throws what `start` would refuse; the tools check first because a track_start replaces a running track, and a refused call must not take it down. */
  assertCanStart(
    seconds: number,
    captureLimit: number,
    options: CaptureOptions = {},
    maxSeconds: number = PROFILE_MAX_SECONDS,
  ): void {
    const timelineMs = options.timelineMs ?? null;
    const targetFps = options.targetFps ?? DEFAULT_TARGET_FPS;
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > maxSeconds) {
      throw new ProfilerError('bad_args', `seconds must be in (0, ${maxSeconds}]`);
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
    // A dropped connection can open nothing, and opening would replace the finished capture that stays readable.
    if (this.error !== null || this.closed) {
      throw new ProfilerError('profile_disconnected', this.error ?? 'Profiler closed');
    }
    this.assertIdle();
  }

  private async open(
    seconds: number,
    captureLimit: number,
    options: CaptureOptions,
    maxSeconds: number = PROFILE_MAX_SECONDS,
  ): Promise<{ started: ProfileStartResult; capture: Capture }> {
    this.assertCanStart(seconds, captureLimit, options, maxSeconds);
    const visual = options.visual === true;
    const timelineMs = options.timelineMs ?? null;

    await this.wait(
      () => this.threadId !== null,
      WAIT_CONNECT_MS,
      'Godot never opened the debugger connection',
    );
    // Two calls read off one stdin chunk both pass the check above; checking again here, with nothing able to run between check and state change, lets only the first open.
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
      closedBy: null,
      monitors: newMonitorCapture(this.lastCompilations),
      visual: visual ? newVisualCapture() : null,
      targetFps: options.targetFps ?? DEFAULT_TARGET_FPS,
      slowFrames: 0,
      arrivalStalls: 0,
      receiverFault: null,
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
      // `result` also satisfies this: a capture the engine closes before any frame is an answer, not a timeout.
      await this.wait(
        () => capture.frames > 0 || capture.result !== null,
        WAIT_FIRST_FRAME_MS,
        'Godot sent no profiler frames',
      );
    } catch (err) {
      // With no frame folded the engine's answer adds nothing: close out here, or a frozen game would hold the receiver in `stopping`, refusing later starts as busy.
      if (capture.result === null) {
        if (this.capture === capture) this.autoStop();
        this.finalize(capture, 'no_start');
      }
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

  /** Hands a closed capture its track; only the first hand-over counts and overlapping stops share it, since the bridge gives its samples up once. */
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

  /** Stop an active capture (or re-read a finished one); waits for the engine's `profile_total` rather than summing the last frame. */
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

  /** Takes the capture rather than re-reading `this.capture`, so a caller that snapshotted one cannot be handed another's numbers. */
  private async finish(
    capture: Capture,
    top: number,
    sort: ProfileSort,
    collect: TrackCollector | undefined,
    waitMs: number = WAIT_TOTAL_MS,
  ): Promise<ProfileResult> {
    try {
      await this.wait(() => capture.result !== null, waitMs, 'Godot sent no profiler totals');
    } catch (err) {
      // Close out either way so it never sits in `stopping`; only a timeout is recoverable (what was folded is good), a disconnect must be reported.
      const recoverable = err instanceof ProfilerError && err.code === 'profile_timeout';
      this.finalize(capture, recoverable ? 'timeout' : 'disconnect');
      if (!recoverable || capture.frames === 0) throw err;
    }
    // Only with the profiler off: the bridge serializes every sample in one frame, and that hitch must not land in the capture.
    await this.collectTrack(capture, collect);
    return this.summarize(capture, top, sort);
  }

  async captureWindow(
    seconds: number,
    top: number,
    sort: ProfileSort,
    captureLimit: number = CAPTURE_LIMIT_MAX,
    options: CaptureOptions = {},
    collect?: TrackCollector,
  ): Promise<ProfileResult> {
    const { capture } = await this.open(seconds, captureLimit, options, PROFILE_WINDOW_MAX_SECONDS);
    // One wait, inside `finish`: a wait here would reject past its handling when totals never arrive, withholding folded frames and leaving the capture in `stopping`.
    return this.finish(capture, top, sort, collect, seconds * MS_PER_SECOND + WAIT_TOTAL_MS);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.state === 'starting' || this.state === 'capturing') {
      this.autoStop();
    }
    this.clearAutoStop();
    this.finalizeOpenCapture();
    this.rejectWaiters(new ProfilerError('profile_disconnected', 'Profiler closed'));
    this.socket?.destroy();
    this.socket = null;
    this.pendingDisables = [];
    this.server.close();
  }

  private accept(socket: net.Socket): void {
    if (this.socket !== null || this.closed) {
      socket.destroy();
      return;
    }
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => this.receive(chunk));
    socket.on('error', (err) => this.fail(err.message));
    socket.on('close', () => {
      // Release the slot even when `fail` short-circuits, so `connected` stops claiming a gone peer.
      if (this.socket === socket) this.socket = null;
      this.fail('Debugger disconnected');
    });
  }

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
      // Read the length prefix in place: joining on every chunk makes assembling a large packet quadratic.
      const size =
        this.byteAt(0) +
        this.byteAt(1) * 0x100 +
        this.byteAt(2) * 0x10000 +
        this.byteAt(3) * 0x1000000;
      if (size === 0) {
        this.fail(
          'Debugger sent a zero-length packet (framing desync)',
          'profile_disconnected',
          true,
        );
        return;
      }
      if (size > MAX_PACKET_BYTES) {
        this.fail(
          `Debugger packet of ${size} bytes exceeds the ${MAX_PACKET_BYTES}-byte limit`,
          'profile_disconnected',
          true,
        );
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
      // The name says whether the body is worth decoding: `output` and `error` arrive all session and the sentinel carries rows nobody reads.
      const name = peekMessageName(payload);
      if (name !== null) {
        this.lastMessage = name;
        if (name === SENTINEL_MESSAGE) {
          this.wellFormedMessages += 1;
          this.handleSentinel();
          this.notify();
          continue;
        }
        if (!CONSUMED_MESSAGES.has(name)) continue;
      }
      let message: Variant;
      try {
        message = decodeVariant(payload);
      } catch (err) {
        // A message this receiver reads, in an encoding the codec does not.
        this.lastDecodeError = err instanceof Error ? err.message : String(err);
        this.undecodable += 1;
        if (this.capture !== null) this.capture.undecodablePackets += 1;
        continue;
      }
      try {
        this.handle(message);
      } catch (err) {
        // An unparseable frame is a stream we cannot trust, not a dropped connection.
        const code = err instanceof ProfilerError ? err.code : 'profile_disconnected';
        this.fail(err instanceof Error ? err.message : String(err), code, true);
        return;
      }
      this.notify();
    }
  }

  /** Close the capture the oldest outstanding disable belongs to; one a timeout already closed out is left as it is. */
  // The engine's totals are capped by `captureLimit` and add nothing the frames did not (16 vs 37 functions measured): a completion sentinel only, layout never parsed.
  private handleSentinel(): void {
    const answered = this.pendingDisables.shift();
    if (answered === undefined) {
      logDebug('[Profiler] A profile_total arrived with no disable outstanding; ignored');
      return;
    }
    if (answered.capture.result === null) this.finalize(answered.capture, 'sentinel');
  }

  /** The open capture a frame packet arriving now belongs to, or null if it belongs to one already closed out. */
  private packetOwner(): Capture | null {
    const pending = this.pendingDisables[0];
    const open =
      this.state === 'starting' || this.state === 'capturing' || this.state === 'stopping';
    const owner = pending !== undefined ? pending.capture : open ? this.capture : null;
    return owner !== null && owner.result === null ? owner : null;
  }

  /** Gives up on disables the engine has provably iterated past; neither sample count nor elapsed time alone is proof, since samples are counted when received, not sent. */
  private countMonitorSampleAgainstDisables(): void {
    const now = Date.now();
    for (const pending of this.pendingDisables) {
      if (now - pending.lastCountedAt < SENTINEL_LOST_SAMPLE_MIN_SPACING_MS) continue;
      pending.monitorSamples += 1;
      pending.lastCountedAt = now;
    }
    let oldest = this.pendingDisables[0];
    while (
      oldest !== undefined &&
      oldest.monitorSamples >= SENTINEL_LOST_AFTER_MONITOR_SAMPLES &&
      now - oldest.writtenAt >= SENTINEL_LOST_MIN_WAIT_MS
    ) {
      this.pendingDisables.shift();
      logDebug(
        `[Profiler] No profile_total answered a disable within ${SENTINEL_LOST_AFTER_MONITOR_SAMPLES} monitor samples and ${SENTINEL_LOST_MIN_WAIT_MS} ms; treating it as lost`,
      );
      if (oldest.capture.result === null) this.finalize(oldest.capture, 'timeout');
      oldest = this.pendingDisables[0];
    }
  }

  private noteMalformed(message: Variant): void {
    this.malformedMessages += 1;
    if (this.firstMalformedShape !== null) return;
    this.firstMalformedShape = describeShape(message);
    logDebug(
      `[Profiler] Debugger message is not [name, thread id, data] and was dropped: ${this.firstMalformedShape}`,
    );
  }

  private handle(message: Variant): void {
    if (!Array.isArray(message) || message.length !== MESSAGE_ARITY) {
      this.noteMalformed(message);
      return;
    }
    const [name, data] = [message[0], message[2]];
    const threadId = message[1] ?? null;
    if (typeof name !== 'string' || !Array.isArray(data)) {
      this.noteMalformed(message);
      return;
    }
    this.wellFormedMessages += 1;
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
      // Every sample moves the baseline so the next capture counts from the sample just before it opened.
      const sample = readMonitorSample(data, this.customMonitorNames);
      this.lastCompilations = compilationTotal(sample.builtin) ?? this.lastCompilations;
      if (capturing && this.capture !== null) {
        foldMonitorSample(this.capture.monitors, sample, this.customMonitorNames);
        const drawCalls = sample.builtin[DRAW_CALLS_MONITOR];
        const bucket = this.timelineBucket(this.capture, false);
        if (bucket !== null && drawCalls !== null && drawCalls !== undefined) {
          bucket.drawCalls = drawCalls;
        }
      }
      this.countMonitorSampleAgainstDisables();
      return;
    }
    const capture = this.packetOwner();
    if (capture === null) return;

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
        visual.stoppedAt =
          capture.frames > 0 ? (Date.now() - capture.startedAt) / MS_PER_SECOND : 0;
        this.write(['profiler:visual', this.threadId, [false]]);
      }
      const bucket = this.timelineBucket(capture, false);
      if (bucket !== null) foldTimelineRender(bucket, render);
      return;
    }
    if (name !== 'servers:profile_frame') return;

    const sample = parseFrame(data, this.signatures);
    const rows = sample.rows;

    if (this.state === 'starting') this.state = 'capturing';
    capture.framesReceived += 1;
    // Enabling the profiler inside a running VM call gives that first sample a zero start timestamp; drop it and any truncation it reported.
    if (capture.framesReceived === 1) return;

    // The engine fills a packet to `captureLimit` rows before zero-call rows are dropped, so the raw count says whether the frame was truncated.
    capture.capped = capture.capped || sample.rawRowCount >= capture.limit;

    const frame = sample.frame;
    capture.frames += 1;
    const arrivedAt = Date.now();
    const previousArrivalAt = capture.frames === 1 ? null : capture.lastFrameAt;
    const previousFrame = capture.lastFrame;
    capture.lastFrameAt = arrivedAt;
    if (capture.frames === 1) {
      // Measure from real data, not the enable round trip: handshake and first-frame latency are not profiled time.
      capture.startedAt = Date.now();
      this.armAutoStop();
    }
    if (capture.firstFrame === null) capture.firstFrame = frame;
    if (capture.lastFrame !== null) {
      capture.frameGaps += Math.max(0, frame - capture.lastFrame - 1);
    }
    capture.lastFrame = frame;
    const slow = sample.timings.frameMs > MS_PER_SECOND / capture.targetFps;
    if (slow) capture.slowFrames += 1;
    const bucket = this.timelineBucket(capture, true);
    if (bucket !== null) foldTimelineFrame(bucket, sample, slow);
    if (capture.timeline !== null && previousArrivalAt !== null && previousFrame !== null) {
      // Wall time beyond the engine's reported frame times is time this process did not read its socket.
      const engineMs = sample.timings.frameMs * Math.max(1, frame - previousFrame);
      if (arrivedAt - previousArrivalAt - engineMs > UNACCOUNTED_ARRIVAL_GAP_MS) {
        capture.arrivalStalls += 1;
        markStalled(
          capture.timeline,
          previousArrivalAt - capture.startedAt,
          arrivedAt - capture.startedAt,
        );
      }
    }

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
      // A synthetic 1 would return well-formed zeroes and an empty `rows`, which reads as 'nothing is slow' rather than 'nothing was measured'.
      const why =
        capture.closedBy === 'no_start'
          ? `The capture never started: Godot sent no usable profiler frame within ${WAIT_FIRST_FRAME_MS / MS_PER_SECOND} s of being asked`
          : 'The capture folded no usable frames';
      throw new ProfilerError(
        'profile_no_frames',
        `${why} (received ${capture.framesReceived}; the first is always discarded), so there is ` +
          `nothing to rank`,
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

    const warnings: string[] = [];
    if (capture.arrivalStalls > 0) {
      warnings.push(
        `This server's event loop was busy while ${capture.arrivalStalls} frame packet(s) waited, so the timeline intervals covering that time report fps: null and may hold no frames; the game was not measured as slow there.`,
      );
    }
    if (capture.closedBy === 'timeout') {
      warnings.push(
        'The capture is incomplete: Godot did not send its closing totals, so this covers only the frames received and seconds is measured to the last of them.',
      );
    } else if (capture.closedBy === 'disconnect' && capture.receiverFault !== null) {
      warnings.push(
        `The capture is incomplete: the profiler stopped reading the debugger stream (${capture.receiverFault}), so this covers only the frames received before that. The game may still be running; relaunch the session with run_project (profiling: true) to profile again.`,
      );
    } else if (capture.closedBy === 'disconnect') {
      warnings.push(
        'The capture is incomplete: the debugger connection dropped before Godot closed it (the game exited or crashed), so this covers only the frames received before that.',
      );
    }
    const dropped = capture.monitors.droppedCustom;
    if (dropped.size > 0) {
      const shown = [...dropped].slice(0, DROPPED_MONITOR_NAMES_SHOWN).join(', ');
      const more = dropped.size > DROPPED_MONITOR_NAMES_SHOWN ? ', ...' : '';
      const atLeast = dropped.size >= MAX_DROPPED_MONITOR_NAMES ? 'at least ' : '';
      warnings.push(
        `Only the first ${MAX_CUSTOM_MONITORS} custom monitors are tracked; ${atLeast}${dropped.size} more were dropped (${shown}${more}).`,
      );
    }
    const rows: ProfileRow[] = [];
    let zeroFrameTime = false;
    for (const row of capture.result ?? []) {
      if (row.calls <= 0) continue;
      const totalMsPerFrame = row.totalMs / frames;
      if (!(frame.frameMs.avg > 0)) zeroFrameTime = true;
      rows.push({
        ...row,
        callsPerFrame: row.calls / frames,
        selfMsPerFrame: row.selfMs / frames,
        totalMsPerFrame,
        msPerCall: row.totalMs / row.calls,
        percentOfFrame: frame.frameMs.avg > 0 ? (totalMsPerFrame / frame.frameMs.avg) * 100 : null,
        peak: capture.peaks.get(row.signature) ?? null,
      });
    }
    rows.sort((a, b) => b[sort] - a[sort]);
    if (zeroFrameTime) {
      warnings.push(
        'percentOfFrame is null: the engine reported a frame time of 0, so the share could not be computed.',
      );
    }
    const spanMs = capture.lastFrameAt - capture.startedAt;
    const spanFrames = (capture.lastFrame ?? 0) - (capture.firstFrame ?? 0);
    return roundNumbers({
      ...(warnings.length > 0 ? { warnings } : {}),
      complete: capture.closedBy === 'sentinel',
      seconds: capture.elapsedMs / 1000,
      frames: capture.frames,
      fps: spanMs > 0 && spanFrames > 0 ? spanFrames / (spanMs / MS_PER_SECOND) : null,
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
      timeline:
        capture.timeline === null
          ? null
          : summarizeTimeline(capture.timeline, spanMs, capture.visual?.gpuTimed === true),
    });
  }

  /** The timeline bucket for something arriving now; nothing is placed before the first folded frame, which starts the clock. */
  private timelineBucket(capture: Capture, grow: boolean): Bucket | null {
    if (capture.timeline === null || capture.frames === 0) return null;
    return bucketAt(capture.timeline, Date.now() - capture.startedAt, grow);
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
    // With no connection nothing is written, so no sentinel is owed.
    if (this.capture && this.socket !== null) {
      // Recorded before the write: a failed write drops the connection and clears every outstanding disable, this one included.
      const writtenAt = Date.now();
      this.pendingDisables.push({
        capture: this.capture,
        monitorSamples: 0,
        writtenAt,
        lastCountedAt: writtenAt,
      });
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

  /** Close a capture out, on `profile_total` or when it never arrives: one left in `stopping` would reject every later `start` as busy. */
  private finalize(
    capture: Capture,
    closedBy: NonNullable<Capture['closedBy']>,
    receiverFault: string | null = null,
  ): void {
    if (capture.result === null) {
      capture.result = [...capture.totals.values()];
      capture.closedBy = closedBy;
      capture.receiverFault = receiverFault;
      // Without the closing packet the window ends at the last folded frame, not at this call; never below zero, as the first frame is stamped just before it restarts the window.
      if (closedBy === 'sentinel') capture.elapsedMs = Date.now() - capture.startedAt;
      else if (capture.frames > 0) {
        capture.elapsedMs = Math.max(0, capture.lastFrameAt - capture.startedAt);
      }
    }
    // The receiver's state follows the current capture only.
    if (capture !== this.capture) return;
    this.state = 'finished';
    this.clearAutoStop();
  }

  private fail(
    reason: string,
    code: ProfilerErrorCode = 'profile_disconnected',
    receiverFault = false,
  ): void {
    // A clean teardown destroys the socket, whose `close` is not a disconnect worth reporting.
    if (this.error !== null || this.closed) return;
    this.error = reason;
    logDebug(`[Profiler] ${reason}`);
    // Stop reading: after a framing error the bad header stays at offset 0 and the buffer never drains.
    this.socket?.destroy();
    this.socket = null;
    this.rxChunks = [];
    this.rxLength = 0;
    // No sentinel can arrive on a connection that is gone.
    this.pendingDisables = [];
    // A capture nobody awaits (`start_profiler`) would stay open forever: its totals can no longer arrive and `finalize` has no other caller.
    this.finalizeOpenCapture(receiverFault ? reason : null);
    this.rejectWaiters(new ProfilerError(code, reason));
  }

  /** Close out a capture left open by a gone connection so what it folded stays readable; one with no frame closes empty (`profile_no_frames`). */
  private finalizeOpenCapture(receiverFault: string | null = null): void {
    const capture = this.capture;
    if (capture === null || capture.result !== null) return;
    if (this.state !== 'starting' && this.state !== 'capturing' && this.state !== 'stopping') {
      return;
    }
    this.finalize(capture, 'disconnect', receiverFault);
  }

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
                `signatures: ${this.signatures.size}; decode: ${this.lastDecodeError ?? 'none'})` +
                (this.streamProblem === null ? '' : `. ${this.streamProblem}`),
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
