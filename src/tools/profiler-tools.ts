import type { GodotRunner } from '../utils/godot-runner.js';
import type { HandlerResult, OperationParams, ToolDefinition, ToolResponse } from '../mcp.types.js';
import { normalizeParameters } from '../utils/parameter-conversion.js';
import { createErrorResponse, getErrorMessage } from '../utils/error-response.js';
import { createStructuredResponse, leadWithWarnings } from '../utils/structured-response.js';
import {
  optionalBoolean,
  optionalNumber,
  optionalString,
  optionalStringArray,
} from '../utils/arg-parsing.js';
import { ok, err, type Result } from '../utils/result.js';
import { noLiveCurrentSessionError, type NoSessionWording } from '../utils/session-report.js';
import {
  CAPTURE_LIMIT_MAX,
  DEFAULT_TARGET_FPS,
  MAX_TIMELINE_BUCKETS,
  MONITOR_NAMES,
  PROFILE_SORTS,
  PROFILE_TOP_MAX,
  ProfilerError,
  TARGET_FPS_MAX,
  TIMELINE_MS_MAX,
  TIMELINE_MS_MIN,
  TIMESTAMP_OVERFLOW_FIX,
  timelineBucketMs,
  type CaptureOptions,
  type DebuggerProfiler,
  type ProfileResult,
  type ProfileSort,
  type ProfileStartResult,
  type TrackCollector,
  type TrackSample,
} from '../utils/profiler.js';

const DEFAULT_WINDOW_SECONDS = 5;
const DEFAULT_MAX_SECONDS = 30;
const DEFAULT_TOP = 20;
const DEFAULT_SORT: ProfileSort = 'selfMs';
const DEFAULT_TIMELINE_MS = 500;

// KEEP IN SYNC: src/scripts/mcp_bridge.gd MAX_TRACK_ENTRIES and
// MIN_TRACK_INTERVAL_MS, which the bridge enforces independently.
export const TRACK_MAX_ENTRIES = 4;
export const TRACK_MIN_INTERVAL_MS = 50;
const TRACK_INTERVAL_MS = 250;
/** How long the bridge keeps sampling past the window if nobody stops it. */
const TRACK_GRACE_MS = 10000;
/** How much of an unrecognized bridge reply an error quotes. */
const TRACK_REPLY_PREVIEW_CHARS = 200;
const TRACK_OWNER_NOT_CURRENT =
  'The session that ran this capture is no longer the current one, so its track was not collected';

// --- Tool definitions ---

const sortProperty = {
  type: 'string',
  enum: [...PROFILE_SORTS],
  description:
    'Rank by own time ("selfMs", default), inclusive time ("totalMs"), or invocation count ("calls").',
} as const;

const captureLimitProperty = {
  type: 'number',
  description:
    'Rows the engine puts in each frame packet, 16..512 (default: 512). Godot selects them by inclusive time, so a lower limit hides cheap functions and sets limitReached.',
} as const;

const topProperty = {
  type: 'number',
  description:
    'How many functions to return, 1..100 (default: 20). Also caps visual.areas when the capture recorded render stages.',
} as const;

const visualProperty = {
  type: 'boolean',
  description:
    "Also record the editor's Visual Profiler: CPU and GPU milliseconds per render stage (culling, shadows, opaque pass, canvas, ...) in `visual` (default: false). GPU times are 0 on GLES/web builds of the Compatibility renderer; `visual.gpuTimed` says so. A frame holds 256 render markers by default; a scene that needs more makes the engine log an error per lost marker, slowing the game, so the capture switches visual off and its warnings say how to raise the limit.",
} as const;

const timelineProperty = {
  type: 'boolean',
  description:
    'Also record the capture over time in `timeline.buckets`: per interval the fps, frameMs avg/max, process/physics/script ms, slowFrames, draw calls, render CPU/GPU ms (with visual) and the 3 heaviest functions, server calls or render stages - where and when frames got slow (default: false).',
} as const;

const timelineMsProperty = {
  type: 'number',
  description: `Timeline interval in milliseconds, ${TIMELINE_MS_MIN}..${TIMELINE_MS_MAX} (default: ${DEFAULT_TIMELINE_MS}). A timeline has about ${MAX_TIMELINE_BUCKETS} intervals, so a longer capture uses wider ones (60 s: 1000 ms). Implies timeline.`,
} as const;

const targetFpsProperty = {
  type: 'number',
  description: `Frame rate to hold the game to (default: ${DEFAULT_TARGET_FPS}). slowFrames counts frames whose frameMs exceeds 1000/targetFps, over the capture and per timeline interval. Under vsync every frame lasts the refresh interval: disable vsync, or set targetFps a few percent below the refresh rate.`,
} as const;

const trackProperty = {
  type: 'array',
  items: { type: 'string' },
  maxItems: TRACK_MAX_ENTRIES,
  description: `Up to ${TRACK_MAX_ENTRIES} NodePath:property values the game samples during the capture (every ${TRACK_INTERVAL_MS} ms, or half the interval when shorter), placed on the timeline by frame number, e.g. "/root/Main/Player:global_position" - where the player was when frames got slow. Implies timeline. Uses the bridge: drive the game between start_profiler and stop_profiler, not in parallel with profile_project. Collected only while the session that started the capture is current.`,
} as const;

const statSchema = {
  type: 'object',
  properties: { avg: { type: 'number' }, max: { type: 'number' } },
} as const;

const monitorStatSchema = {
  type: 'object',
  properties: { avg: { type: 'number' }, min: { type: 'number' }, max: { type: 'number' } },
} as const;

const monitorsSchema = {
  type: ['object', 'null'],
  properties: {
    samples: { type: 'number' },
    ...Object.fromEntries(
      MONITOR_NAMES.map((name) => [name, { ...monitorStatSchema, type: ['object', 'null'] }]),
    ),
    pipelineCompilations: {
      type: ['object', 'null'],
      properties: { duringCapture: { type: ['number', 'null'] }, total: { type: 'number' } },
    },
    custom: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, ...monitorStatSchema.properties },
      },
    },
  },
} as const;

const visualSchema = {
  type: ['object', 'null'],
  properties: {
    hardware: {
      type: ['object', 'null'],
      properties: { cpu: { type: 'string' }, gpu: { type: 'string' } },
    },
    framesReceived: { type: 'number' },
    frames: { type: 'number' },
    gpuTimed: { type: 'boolean' },
    truncatedFrames: { type: 'number' },
    stoppedAt: { type: ['number', 'null'] },
    cpuMs: statSchema,
    gpuMs: statSchema,
    areasReceived: { type: 'number' },
    areas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          name: { type: 'string' },
          group: { type: 'boolean' },
          frames: { type: 'number' },
          cpuMs: statSchema,
          gpuMs: statSchema,
        },
      },
    },
    worstFrame: {
      type: ['object', 'null'],
      properties: {
        frame: { type: 'number' },
        cpuMs: { type: 'number' },
        gpuMs: { type: 'number' },
        areas: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              cpuMs: { type: 'number' },
              gpuMs: { type: 'number' },
            },
          },
        },
      },
    },
  },
} as const;

const frameTimingsSchema = {
  type: 'object',
  properties: {
    frameMs: statSchema,
    processMs: statSchema,
    physicsMs: statSchema,
    physicsFrameMs: statSchema,
    scriptMs: statSchema,
  },
} as const;

const rowSchema = {
  type: 'object',
  properties: {
    signature: { type: 'string' },
    function: { type: 'string' },
    file: { type: 'string' },
    line: { type: 'number' },
    sourceResolved: { type: 'boolean' },
    calls: { type: 'number' },
    selfMs: { type: 'number' },
    totalMs: { type: 'number' },
    callsPerFrame: { type: 'number' },
    selfMsPerFrame: { type: 'number' },
    totalMsPerFrame: { type: 'number' },
    msPerCall: { type: 'number' },
    percentOfFrame: { type: ['number', 'null'] },
    peak: {
      type: ['object', 'null'],
      properties: {
        frame: { type: 'number' },
        calls: { type: 'number' },
        selfMs: { type: 'number' },
        totalMs: { type: 'number' },
      },
    },
  },
} as const;

const timelineSchema = {
  type: ['object', 'null'],
  properties: {
    bucketMs: { type: 'number' },
    track: { type: 'array', items: { type: 'string' } },
    trackError: { type: ['string', 'null'] },
    buckets: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          t: { type: 'number' },
          frames: { type: 'number' },
          fps: { type: ['number', 'null'] },
          frameMs: { ...statSchema, type: ['object', 'null'] },
          processMs: { type: ['number', 'null'] },
          physicsMs: { type: ['number', 'null'] },
          scriptMs: { type: ['number', 'null'] },
          slowFrames: { type: 'number' },
          render: {
            type: ['object', 'null'],
            properties: { cpuMs: { type: 'number' }, gpuMs: { type: 'number' } },
          },
          drawCalls: { type: ['number', 'null'] },
          top: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['script', 'server', 'render'] },
                name: { type: 'string' },
                ms: { type: 'number' },
                maxMs: { type: 'number' },
              },
            },
          },
          track: { type: ['object', 'null'] },
        },
      },
    },
  },
} as const;

const captureResultSchema = {
  type: 'object',
  properties: {
    warnings: { type: 'array', items: { type: 'string' } },
    projectPath: { type: 'string' },
    complete: { type: 'boolean' },
    seconds: { type: 'number' },
    frames: { type: 'number' },
    fps: { type: ['number', 'null'] },
    targetFps: { type: 'number' },
    slowFrames: { type: 'number' },
    framesReceived: { type: 'number' },
    firstFrame: { type: ['number', 'null'] },
    lastFrame: { type: ['number', 'null'] },
    frameGaps: { type: 'number' },
    undecodablePackets: { type: 'number' },
    captureLimit: { type: 'number' },
    limitReached: { type: 'boolean' },
    sort: { type: 'string', enum: [...PROFILE_SORTS] },
    functionsReceived: { type: 'number' },
    unresolvedFunctions: { type: 'number' },
    frame: frameTimingsSchema,
    servers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          msPerFrame: { type: 'number' },
          functions: {
            type: 'array',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, msPerFrame: { type: 'number' } },
            },
          },
        },
      },
    },
    rows: { type: 'array', items: rowSchema },
    worstFrame: { type: ['object', 'null'] },
    monitors: monitorsSchema,
    visual: visualSchema,
    timeline: timelineSchema,
  },
  // Every field of a capture result is always present. A capture that folded
  // no frame is an error, never a payload with fields left out.
  required: [
    'projectPath',
    'complete',
    'seconds',
    'frames',
    'fps',
    'targetFps',
    'slowFrames',
    'framesReceived',
    'firstFrame',
    'lastFrame',
    'frameGaps',
    'undecodablePackets',
    'captureLimit',
    'limitReached',
    'sort',
    'functionsReceived',
    'unresolvedFunctions',
    'frame',
    'servers',
    'rows',
    'worstFrame',
    'monitors',
    'visual',
    'timeline',
  ],
} as const;

export const profilerToolDefinitions = [
  {
    name: 'profile_project',
    description:
      'Capture a profiler window: GDScript function costs, fps, monitors; visual: true adds CPU/GPU time per render stage, timeline: true the same over time. Requires run_project with profiling: true. Blocks for `seconds` (default 5). Times are elapsed, not CPU; inclusive rows overlap, never sum totalMs. Returns: warnings first, projectPath, complete (false if cut short), fps, slowFrames, rows, frame, servers, worstFrame, monitors, visual, timeline. Errors if profiling was off or a capture is open.',
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        seconds: {
          type: 'number',
          description: 'Capture duration in seconds, greater than 0 and at most 60 (default: 5).',
        },
        top: topProperty,
        sort: sortProperty,
        captureLimit: captureLimitProperty,
        visual: visualProperty,
        timeline: timelineProperty,
        timelineMs: timelineMsProperty,
        targetFps: targetFpsProperty,
        track: trackProperty,
      },
      required: [],
    },
    outputSchema: captureResultSchema,
  },
  {
    name: 'start_profiler',
    description:
      'Start a profiler capture and return at once, so simulate_input, run_script and screenshots drive the game while it records; timeline and track show where frames drop. Requires run_project with profiling: true. Stops itself after `seconds` (default 30, max 60); read it with stop_profiler. Unattended window: use profile_project. Returns: warnings if any, projectPath, active, visual, timeline, timelineMs, firstFrame, captureLimit, maxSeconds. Errors if a capture is running or profiling was off.',
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        seconds: {
          type: 'number',
          description:
            'Maximum capture duration before the automatic stop, greater than 0 and at most 60 (default: 30).',
        },
        captureLimit: captureLimitProperty,
        visual: visualProperty,
        timeline: timelineProperty,
        timelineMs: timelineMsProperty,
        targetFps: targetFpsProperty,
        track: trackProperty,
      },
      required: [],
    },
    outputSchema: {
      type: 'object',
      properties: {
        warnings: { type: 'array', items: { type: 'string' } },
        projectPath: { type: 'string' },
        active: { type: 'boolean' },
        visual: { type: 'boolean' },
        timeline: { type: 'boolean' },
        timelineMs: { type: ['number', 'null'] },
        maxSeconds: { type: 'number' },
        firstFrame: { type: ['number', 'null'] },
        captureLimit: { type: 'number' },
      },
      required: [
        'projectPath',
        'active',
        'visual',
        'timeline',
        'timelineMs',
        'maxSeconds',
        'firstFrame',
        'captureLimit',
      ],
    },
  },
  {
    name: 'stop_profiler',
    description:
      'Stop the start_profiler capture of the current session and rank what it recorded; one that hit its time limit is read back as-is, re-readable with another sort. Times are elapsed, not CPU; inclusive rows overlap, never sum totalMs. Returns: the profile_project payload: warnings first, projectPath, complete (false if cut short), fps, slowFrames, rows, frame, servers, worstFrame, monitors, plus visual and timeline when started with them. Errors if no capture was started.',
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        top: topProperty,
        sort: sortProperty,
      },
      required: [],
    },
    outputSchema: captureResultSchema,
  },
] as const satisfies readonly ToolDefinition[];

// --- Helpers ---

const PROFILER_WORDING: NoSessionWording = {
  action: 'capture a profile',
  noneMessage: 'No active runtime session. A project must be running to profile it.',
  noneSolutions: [
    'Use run_project with profiling: true to start a Godot project first',
    'Profiling cannot be added to a session that is already running',
  ],
  exitedSolutions: [
    'Use get_debug_output to inspect the last captured logs',
    'Call stop_project to clean up, then run_project with profiling: true again',
  ],
};

/**
 * The profiler lives on the runner for as long as the spawned session does.
 * Its absence is always the same user-facing story: this session was not
 * launched with the debugger channel, so there is nothing to measure.
 */
function requireProfiler(
  runner: GodotRunner,
): Result<{ profiler: DebuggerProfiler; projectPath: string }, ToolResponse> {
  const status = runner.getRuntimeSessionStatus();
  const profiler = runner.activeProfiler;
  if (status.current === null) return err(noLiveCurrentSessionError(status, PROFILER_WORDING));
  if (profiler === null) {
    // "Nothing is running" and "running without profiling" have different
    // fixes, and every sibling runtime tool already draws this line.
    if (status.state !== 'live') return err(noLiveCurrentSessionError(status, PROFILER_WORDING));
    return err(
      createErrorResponse('Profiling is not enabled for this session.', [
        'Call run_project with profiling: true - the debugger channel is set at launch and cannot be added later',
        'Attached sessions cannot profile; call run_project without attach: true',
      ]),
    );
  }
  // A finished capture outlives the engine: re-ranking folded data needs no
  // process, and the capture taken just before a crash is the one worth having.
  if (status.state !== 'live' && !profiler.hasResult) {
    return err(noLiveCurrentSessionError(status, PROFILER_WORDING));
  }
  return ok({ profiler, projectPath: status.current.projectPath });
}

/**
 * Range-check `top` here rather than leaving it to `stop()`. A capture window
 * runs for seconds before that check is reached, so a bad value would cost the
 * whole window before erroring.
 */
function parseTop(args: OperationParams): Result<number, ToolResponse> {
  const raw = optionalNumber(args, 'top');
  if (!raw.ok) return raw;
  if (raw.value === undefined) return ok(DEFAULT_TOP);
  if (!Number.isInteger(raw.value) || raw.value < 1 || raw.value > PROFILE_TOP_MAX) {
    return err(
      createErrorResponse(
        `Invalid top: must be an integer in [1, ${PROFILE_TOP_MAX}] (got: ${raw.value})`,
        [`Omit top to return the default of ${DEFAULT_TOP} rows`],
      ),
    );
  }
  return ok(raw.value);
}

function parseSort(args: OperationParams): Result<ProfileSort, ToolResponse> {
  const raw = optionalString(args, 'sort');
  if (!raw.ok) return raw;
  if (raw.value === undefined) return ok(DEFAULT_SORT);
  if (!PROFILE_SORTS.includes(raw.value as ProfileSort)) {
    return err(
      createErrorResponse(
        `Invalid sort: must be one of ${PROFILE_SORTS.join(', ')} (got: ${raw.value})`,
        ['Omit sort to rank by own time'],
      ),
    );
  }
  return ok(raw.value as ProfileSort);
}

interface ParsedCaptureOptions {
  options: CaptureOptions & { track: string[] };
  /** `timelineMs` as the caller gave it, to say so when a long window widens it. */
  requestedTimelineMs: number | undefined;
}

/**
 * `visual`, `timeline`, `timelineMs`, `targetFps` and `track`, checked here
 * for the same reason as `top`: a bad value found after the window would
 * cost the whole window. `timelineMs` or a `track` imply a timeline.
 */
function parseCaptureOptions(args: OperationParams): Result<ParsedCaptureOptions, ToolResponse> {
  const visual = optionalBoolean(args, 'visual');
  if (!visual.ok) return visual;
  const timeline = optionalBoolean(args, 'timeline');
  if (!timeline.ok) return timeline;
  const timelineMs = optionalNumber(args, 'timelineMs');
  if (!timelineMs.ok) return timelineMs;
  const targetFps = optionalNumber(args, 'targetFps');
  if (!targetFps.ok) return targetFps;
  const track = optionalStringArray(args, 'track');
  if (!track.ok) return track;

  if (
    timelineMs.value !== undefined &&
    (!Number.isInteger(timelineMs.value) ||
      timelineMs.value < TIMELINE_MS_MIN ||
      timelineMs.value > TIMELINE_MS_MAX)
  ) {
    return err(
      createErrorResponse(
        `Invalid timelineMs: must be an integer in [${TIMELINE_MS_MIN}, ${TIMELINE_MS_MAX}] (got: ${timelineMs.value})`,
        [`Omit timelineMs for ${DEFAULT_TIMELINE_MS} ms intervals`],
      ),
    );
  }
  if (targetFps.value !== undefined && (targetFps.value <= 0 || targetFps.value > TARGET_FPS_MAX)) {
    return err(
      createErrorResponse(
        `Invalid targetFps: must be greater than 0 and at most ${TARGET_FPS_MAX} (got: ${targetFps.value})`,
        [`Omit targetFps to count frames slower than ${DEFAULT_TARGET_FPS} fps`],
      ),
    );
  }
  const specs = track.value ?? [];
  if (specs.length > TRACK_MAX_ENTRIES) {
    return err(
      createErrorResponse(
        `Invalid track: at most ${TRACK_MAX_ENTRIES} entries (got: ${specs.length})`,
        ['Track only the node that moves, usually the player'],
      ),
    );
  }
  const malformed = specs.find((spec) => {
    const separator = spec.indexOf(':');
    return separator <= 0 || separator >= spec.length - 1;
  });
  if (malformed !== undefined) {
    return err(
      createErrorResponse(`Invalid track entry: expected NodePath:property (got: ${malformed})`, [
        'Use an absolute node path and a property, e.g. "/root/Main/Player:global_position"',
      ]),
    );
  }

  const wantsTimeline =
    timeline.value === true || timelineMs.value !== undefined || specs.length > 0;
  return ok({
    options: {
      visual: visual.value === true,
      timelineMs: wantsTimeline ? (timelineMs.value ?? DEFAULT_TIMELINE_MS) : null,
      targetFps: targetFps.value ?? DEFAULT_TARGET_FPS,
      track: specs,
    },
    requestedTimelineMs: timelineMs.value,
  });
}

/**
 * Refuse a capture the profiler would refuse anyway (a bad argument, or one
 * already open) before the bridge is asked for a track: track_start replaces
 * any running track, so a refused call would take the running capture's
 * track down with it.
 */
function checkCanStart(
  profiler: DebuggerProfiler,
  seconds: number,
  captureLimit: number,
  options: CaptureOptions,
): Result<void, ToolResponse> {
  try {
    profiler.assertCanStart(seconds, captureLimit, options);
    return ok(undefined);
  } catch (error: unknown) {
    return err(profilerFailure(error));
  }
}

/**
 * Have the bridge start sampling the tracked properties. It runs inside the
 * game on its own clock, so it keeps sampling while simulate_input or any
 * other command holds the bridge, and stops by itself if nobody collects it.
 * The bucket interval it samples for is the one the capture will use, a long
 * window's widened one included: the timeline keeps one sample per interval.
 */
async function startTrack(
  runner: GodotRunner,
  track: string[],
  seconds: number,
  timelineMs: number,
): Promise<Result<void, ToolResponse>> {
  if (track.length === 0) return ok(undefined);
  const intervalMs = Math.max(
    TRACK_MIN_INTERVAL_MS,
    Math.min(TRACK_INTERVAL_MS, Math.floor(timelineBucketMs(timelineMs, seconds) / 2)),
  );
  try {
    const raw = await runner.sendCommand('track_start', {
      watch: track,
      interval_ms: intervalMs,
      max_ms: Math.ceil(seconds * 1000) + TRACK_GRACE_MS,
    });
    const reply = JSON.parse(raw) as { status?: unknown; error?: unknown };
    if (reply.status === 'tracking') return ok(undefined);
    // Anything but the bridge's own acknowledgement is a refusal: treating an
    // unrecognized reply as success would profile with a track nobody runs.
    const reason =
      typeof reply.error === 'string'
        ? reply.error
        : `unexpected bridge reply ${raw.slice(0, TRACK_REPLY_PREVIEW_CHARS)}`;
    return err(
      createErrorResponse(`Could not start the track: ${reason}`, [
        'Check each entry is NodePath:property',
      ]),
    );
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    // The runner takes one bridge command at a time and refuses the rest.
    const busy = message.includes('in flight');
    const unreadable = error instanceof SyntaxError;
    return err(
      createErrorResponse(`Could not start the track: ${message}`, [
        busy
          ? 'Another bridge command (simulate_input, run_script, ...) was still running - start the capture before driving the game, or retry once it finished'
          : unreadable
            ? 'The game bridge answered with something that is not JSON - check get_debug_output'
            : 'The game bridge did not answer - check get_debug_output',
        'Retry without track to profile without positions',
      ]),
    );
  }
}

function isTrackSample(value: unknown): value is TrackSample {
  if (value === null || typeof value !== 'object') return false;
  const sample = value as { frame?: unknown; values?: unknown };
  return (
    typeof sample.frame === 'number' &&
    Number.isFinite(sample.frame) &&
    sample.values !== null &&
    typeof sample.values === 'object' &&
    !Array.isArray(sample.values)
  );
}

/** Stop the bridge's track and hand over what it sampled, or why there is nothing. */
async function collectTrack(
  runner: GodotRunner,
  owner: DebuggerProfiler,
): Promise<{ samples: TrackSample[] | null; error: string | null }> {
  // A capture belongs to one session, and sendCommand addresses whichever
  // session is current. Each session has its own profiler, so its identity
  // says whether the current session is still the one that ran this capture.
  // A track_stop sent anywhere else would take another game's samples.
  if (runner.activeProfiler !== owner) return { samples: null, error: TRACK_OWNER_NOT_CURRENT };
  // Once the game has exited the session has no bridge port left, and the
  // runner would refuse the send. Say what happened in the capture's terms.
  if (!runner.hasActiveRuntimeSession()) {
    return { samples: null, error: 'The game exited before its track was collected' };
  }
  try {
    const raw = await runner.sendCommand('track_stop', {});
    const reply = JSON.parse(raw) as { samples?: unknown; error?: unknown };
    if (typeof reply.error === 'string') return { samples: null, error: reply.error };
    if (!Array.isArray(reply.samples)) {
      return { samples: null, error: 'The bridge returned no track samples' };
    }
    // The bridge writes every sample in one shape, so a malformed one means
    // the two sides disagree; dropping it quietly would thin the track with
    // nothing saying why.
    const malformed = reply.samples.filter((sample) => !isTrackSample(sample)).length;
    if (malformed > 0) {
      return {
        samples: null,
        error: `The bridge returned ${malformed} of ${reply.samples.length} track samples in an unrecognized shape`,
      };
    }
    return { samples: reply.samples as TrackSample[], error: null };
  } catch (error: unknown) {
    return { samples: null, error: getErrorMessage(error) };
  }
}

/**
 * How a capture fetches its track. The profiler calls it once the capture has
 * closed, and only for a capture that asked for a track.
 */
function trackCollector(runner: GodotRunner, owner: DebuggerProfiler): TrackCollector {
  return () => collectTrack(runner, owner);
}

/**
 * What compromised this capture's numbers, and what to do about it. Said in
 * the result because that is where the agent is looking when it matters; the
 * parameter descriptions were read once, at the handshake.
 */
function captureWarnings(result: ProfileResult): string[] {
  const warnings: string[] = [];
  const visual = result.visual ?? null;
  if (visual !== null && visual.frames === 0) {
    warnings.push(
      `visual: true recorded no usable render frames (${visual.framesReceived} received; the first few after the enable and any without a "Frame Begin" marker are skipped). Its zero timings mean nothing was measured, not that rendering is free. Capture for longer, and check the window is visible and not minimized.`,
    );
  }
  if (visual !== null && visual.truncatedFrames > 0) {
    const effect =
      visual.stoppedAt === null
        ? 'Those frames can show up in frameMs.max, worstFrame and slowFrames, and lower fps.'
        : `It kept happening, so visual profiling was switched off ${visual.stoppedAt} s into the capture: the render stages only cover the frames before that, and the slowed frames around that point inflate frameMs.max, worstFrame and slowFrames, lower fps a little, and show in the timeline interval they fall in.`;
    warnings.push(
      `${visual.truncatedFrames} of ${visual.frames} rendered frames ran out of render timestamp slots: their later render stages are missing, and the engine logged an error for every lost marker, which made those frames several times slower. ${effect} Those errors in get_debug_output come from this capture, not from the game, and they can push earlier lines out of it. ${TIMESTAMP_OVERFLOW_FIX}`,
    );
  }
  warnings.push(...trackWarnings(result.timeline ?? null));
  warnings.push(...unmeasuredWarnings(result));
  return warnings;
}

/**
 * Why a requested track shows nothing, said where a truncating client still
 * sees it: `timeline.trackError` sits at the end of a long payload. A track
 * that came back but never lands on an interval, or an entry that is null in
 * every interval, is as empty as one that failed, and says nothing by itself.
 */
function trackWarnings(timeline: ProfileResult['timeline']): string[] {
  if (timeline === null || timeline.track.length === 0) return [];
  if (timeline.trackError !== null) {
    return [`The tracked values are missing: ${timeline.trackError}.`];
  }
  const placed = timeline.buckets
    .map((bucket) => bucket.track)
    .filter((values): values is Record<string, unknown> => values !== null);
  if (placed.length === 0) {
    return [
      'No track sample landed on a timeline interval, so every interval has track: null. Capture for longer than one sampling interval.',
    ];
  }
  const unresolved = timeline.track.filter((spec) =>
    placed.every((values) => values[spec] === null || values[spec] === undefined),
  );
  if (unresolved.length === 0) return [];
  return [
    `Track entries null in every interval: ${unresolved.join(', ')}. The node path or property probably does not resolve - use an absolute path from /root, e.g. "/root/Main/Player:global_position".`,
  ];
}

/**
 * A null that stands for "not measured" gets a sentence saying so, the same
 * as percentOfFrame does. Nulls inside one timeline interval are left alone:
 * they are per interval by design and would bury everything else.
 */
function unmeasuredWarnings(result: ProfileResult): string[] {
  const warnings: string[] = [];
  if (result.fps === null) {
    warnings.push(
      'fps is null: fewer than two frames were folded, so there is no span to measure a rate over. Capture for longer.',
    );
  }
  if (result.monitors === null) {
    warnings.push(
      'monitors is null: no monitor sample arrived while the capture was open. The engine sends one a second, so capture for two seconds or more.',
    );
  } else {
    const monitors = result.monitors;
    const missing = MONITOR_NAMES.filter((name) => monitors[name] === null);
    if (missing.length > 0) {
      warnings.push(`Monitors with no finite sample, reported as null: ${missing.join(', ')}.`);
    }
  }
  return warnings;
}

/** Say so when a long window made the timeline coarser than the caller asked. */
function widenedTimelineWarning(
  requestedMs: number | undefined,
  actualMs: number | null | undefined,
  seconds: number,
): string[] {
  if (requestedMs === undefined || actualMs === null || actualMs === undefined) return [];
  if (actualMs <= requestedMs) return [];
  return [
    `The timeline uses ${actualMs} ms intervals, not the requested ${requestedMs} ms: it holds about ${MAX_TIMELINE_BUCKETS} intervals, and ${seconds} s needs wider ones. Capture fewer seconds for finer intervals.`,
  ];
}

/**
 * The one exit for every success. The capture's own warnings (an incomplete
 * capture, a null percentOfFrame) come first, then what this handler found.
 * `leadWithWarnings` puts the list ahead of everything else, or drops it when
 * empty, so a client that cuts a long result short still shows it.
 */
function profilerResponse(
  projectPath: string,
  payload: ProfileResult | ProfileStartResult,
  handlerWarnings: string[],
): HandlerResult {
  const own = 'warnings' in payload ? (payload.warnings ?? []) : [];
  return createStructuredResponse(
    leadWithWarnings({ projectPath, ...payload, warnings: [...own, ...handlerWarnings] }),
  );
}

function profilerFailure(error: unknown): ToolResponse {
  const message = getErrorMessage(error);
  if (!(error instanceof ProfilerError)) {
    return createErrorResponse(`Profiling failed: ${message}`, [
      'Check get_debug_output for runtime errors',
    ]);
  }
  const solutions: Record<ProfilerError['code'], string[]> = {
    bad_args: ['Pass values inside the documented ranges'],
    profile_busy: ['Call stop_profiler to close the running capture first'],
    profile_not_started: ['Call start_profiler first, or profile_project for a one-shot capture'],
    profile_timeout: [
      'Godot only emits profiler frames while it renders - make sure the window is not minimized or paused',
      'Check get_debug_output for runtime errors',
    ],
    profile_disconnected: [
      'The Godot process ended or dropped the debugger connection',
      'Call stop_project, then run_project with profiling: true again',
    ],
    profile_no_frames: [
      'Capture for longer - a window shorter than two rendered frames has nothing to average',
      'Godot only emits profiler frames while it renders; make sure the window is not minimized or paused',
    ],
    profile_bad_frame: [
      'This Godot version may lay out profiler frames differently than the server expects',
      'Report the Godot version - check_project returns it',
    ],
  };
  return createErrorResponse(message, solutions[error.code]);
}

// --- Handlers ---

export async function handleProfileProject(
  runner: GodotRunner,
  args: OperationParams,
): Promise<HandlerResult> {
  args = normalizeParameters(args);

  const seconds = optionalNumber(args, 'seconds');
  if (!seconds.ok) return seconds;
  const captureLimit = optionalNumber(args, 'captureLimit');
  if (!captureLimit.ok) return captureLimit;
  const top = parseTop(args);
  if (!top.ok) return top;
  const sort = parseSort(args);
  if (!sort.ok) return sort;
  const options = parseCaptureOptions(args);
  if (!options.ok) return options;

  const profiler = requireProfiler(runner);
  if (!profiler.ok) return profiler;
  const { profiler: receiver, projectPath } = profiler.value;

  const windowSeconds = seconds.value ?? DEFAULT_WINDOW_SECONDS;
  const limit = captureLimit.value ?? CAPTURE_LIMIT_MAX;
  const { options: capture, requestedTimelineMs } = options.value;
  const startable = checkCanStart(receiver, windowSeconds, limit, capture);
  if (!startable.ok) return startable;
  const tracking = await startTrack(
    runner,
    capture.track,
    windowSeconds,
    capture.timelineMs ?? DEFAULT_TIMELINE_MS,
  );
  if (!tracking.ok) return tracking;

  try {
    const result = await receiver.captureWindow(
      windowSeconds,
      top.value,
      sort.value,
      limit,
      capture,
      trackCollector(runner, receiver),
    );
    return profilerResponse(projectPath, result, [
      ...captureWarnings(result),
      ...widenedTimelineWarning(requestedTimelineMs, result.timeline?.bucketMs, windowSeconds),
    ]);
  } catch (error: unknown) {
    // Stop the bridge sampling for a capture that will never read it.
    if (capture.track.length > 0) await collectTrack(runner, receiver);
    return err(profilerFailure(error));
  }
}

export async function handleStartProfiler(
  runner: GodotRunner,
  args: OperationParams,
): Promise<HandlerResult> {
  args = normalizeParameters(args);

  const seconds = optionalNumber(args, 'seconds');
  if (!seconds.ok) return seconds;
  const captureLimit = optionalNumber(args, 'captureLimit');
  if (!captureLimit.ok) return captureLimit;
  const options = parseCaptureOptions(args);
  if (!options.ok) return options;

  const profiler = requireProfiler(runner);
  if (!profiler.ok) return profiler;
  const { profiler: receiver, projectPath } = profiler.value;

  const maxSeconds = seconds.value ?? DEFAULT_MAX_SECONDS;
  const limit = captureLimit.value ?? CAPTURE_LIMIT_MAX;
  const { options: capture, requestedTimelineMs } = options.value;
  const startable = checkCanStart(receiver, maxSeconds, limit, capture);
  if (!startable.ok) return startable;
  const tracking = await startTrack(
    runner,
    capture.track,
    maxSeconds,
    capture.timelineMs ?? DEFAULT_TIMELINE_MS,
  );
  if (!tracking.ok) return tracking;

  try {
    const result = await receiver.start(maxSeconds, limit, capture);
    return profilerResponse(
      projectPath,
      result,
      widenedTimelineWarning(requestedTimelineMs, result.timelineMs, maxSeconds),
    );
  } catch (error: unknown) {
    if (capture.track.length > 0) await collectTrack(runner, receiver);
    return err(profilerFailure(error));
  }
}

export async function handleStopProfiler(
  runner: GodotRunner,
  args: OperationParams,
): Promise<HandlerResult> {
  args = normalizeParameters(args);

  const top = parseTop(args);
  if (!top.ok) return top;
  const sort = parseSort(args);
  if (!sort.ok) return sort;

  const profiler = requireProfiler(runner);
  if (!profiler.ok) return profiler;
  const { profiler: receiver, projectPath } = profiler.value;

  try {
    const result = await receiver.stop(top.value, sort.value, trackCollector(runner, receiver));
    return profilerResponse(projectPath, result, captureWarnings(result));
  } catch (error: unknown) {
    return err(profilerFailure(error));
  }
}
