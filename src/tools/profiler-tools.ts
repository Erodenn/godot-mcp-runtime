import type { GodotRunner } from '../utils/godot-runner.js';
import type { HandlerResult, OperationParams, ToolDefinition, ToolResponse } from '../mcp.types.js';
import { normalizeParameters } from '../utils/parameter-conversion.js';
import { createErrorResponse, getErrorMessage } from '../utils/error-response.js';
import { createStructuredResponse } from '../utils/structured-response.js';
import { optionalNumber, optionalString } from '../utils/arg-parsing.js';
import { ok, err, type Result } from '../utils/result.js';
import {
  CAPTURE_LIMIT_MAX,
  PROFILE_SORTS,
  PROFILE_TOP_MAX,
  ProfilerError,
  type DebuggerProfiler,
  type ProfileSort,
} from '../utils/profiler.js';

const DEFAULT_WINDOW_SECONDS = 5;
const DEFAULT_MAX_SECONDS = 30;
const DEFAULT_TOP = 20;
const DEFAULT_SORT: ProfileSort = 'selfMs';

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
  description: 'How many functions to return, 1..100 (default: 20).',
} as const;

const statSchema = {
  type: 'object',
  properties: { avg: { type: 'number' }, max: { type: 'number' } },
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
    percentOfFrame: { type: 'number' },
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

const captureResultSchema = {
  type: 'object',
  properties: {
    seconds: { type: 'number' },
    frames: { type: 'number' },
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
  },
} as const;

export const profilerToolDefinitions = [
  {
    name: 'profile_project',
    description:
      "Capture a window of Godot's function profiler — the editor's Profiler tab numbers. Requires run_project with profiling: true. Blocks for `seconds` (default 5). Times are elapsed, not CPU; inclusive rows overlap — never sum totalMs. Returns: rows (function, file, line, calls, selfMs/totalMs, per-frame averages, percentOfFrame, peak), the frame budget, servers, worstFrame, plus frames/frameGaps/limitReached for capture quality. Errors if profiling was off at launch or a capture is already open.",
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
      },
      required: [],
    },
    outputSchema: captureResultSchema,
  },
  {
    name: 'start_profiler',
    description:
      'Start a profiler capture and return immediately, so simulate_input, run_script and screenshots can drive the game while it records. Requires run_project with profiling: true. Stops itself after `seconds` (default 30, max 60); call stop_profiler for the results. Returns: active, firstFrame, captureLimit, maxSeconds. Use profile_project instead for an unattended window. Errors if a capture is already running or profiling was not enabled at launch.',
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
      },
      required: [],
    },
    outputSchema: {
      type: 'object',
      properties: {
        active: { type: 'boolean' },
        maxSeconds: { type: 'number' },
        firstFrame: { type: ['number', 'null'] },
        captureLimit: { type: 'number' },
      },
    },
  },
  {
    name: 'stop_profiler',
    description:
      'Stop the capture started by start_profiler and rank the recorded functions; a capture that already hit its time limit is read back as-is, and can be re-read with a different sort. Times are elapsed, not CPU; inclusive rows overlap — never sum totalMs. Returns: the same payload as profile_project — rows (file, line, function, calls, selfMs/totalMs, per-frame averages, percentOfFrame, peak frame), frame budget, servers, worstFrame, frames, frameGaps, limitReached. Errors if no capture was started.',
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

/**
 * The profiler lives on the runner for as long as the spawned session does.
 * Its absence is always the same user-facing story: this session was not
 * launched with the debugger channel, so there is nothing to measure.
 */
function requireProfiler(runner: GodotRunner): Result<DebuggerProfiler, ToolResponse> {
  if (runner.activeProfiler === null) {
    // "Nothing is running" and "running without profiling" have different
    // fixes, and every sibling runtime tool already draws this line.
    if (!runner.activeSessionMode || !runner.activeProjectPath) {
      return err(
        createErrorResponse('No active runtime session. A project must be running to profile it.', [
          'Use run_project with profiling: true to start a Godot project first',
          'Profiling cannot be added to a session that is already running',
        ]),
      );
    }
    return err(
      createErrorResponse('Profiling is not enabled for this session.', [
        'Call run_project with profiling: true — the debugger channel is set at launch and cannot be added later',
        'Attached sessions cannot profile; use run_project instead of attach_project',
      ]),
    );
  }
  const profiler = runner.activeProfiler;
  // A finished capture outlives the engine: re-ranking folded data needs no
  // process, and the capture taken just before a crash is the one worth having.
  if (runner.activeProcess?.hasExited === true && !profiler.hasResult) {
    return err(
      createErrorResponse('The spawned Godot process has exited and cannot be profiled.', [
        'Use get_debug_output to inspect the last captured logs',
        'Call stop_project to clean up, then run_project with profiling: true again',
      ]),
    );
  }
  return ok(profiler);
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
      'Godot only emits profiler frames while it renders — make sure the window is not minimized or paused',
      'Check get_debug_output for runtime errors',
    ],
    profile_disconnected: [
      'The Godot process ended or dropped the debugger connection',
      'Call stop_project, then run_project with profiling: true again',
    ],
    profile_no_frames: [
      'Capture for longer — a window shorter than two rendered frames has nothing to average',
      'Godot only emits profiler frames while it renders; make sure the window is not minimized or paused',
    ],
    profile_bad_frame: [
      'This Godot version may lay out profiler frames differently than the server expects',
      'Report the Godot version — get_project_info returns it',
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

  const profiler = requireProfiler(runner);
  if (!profiler.ok) return profiler;

  try {
    const result = await profiler.value.captureWindow(
      seconds.value ?? DEFAULT_WINDOW_SECONDS,
      top.value,
      sort.value,
      captureLimit.value ?? CAPTURE_LIMIT_MAX,
    );
    return createStructuredResponse({ ...result });
  } catch (error: unknown) {
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

  const profiler = requireProfiler(runner);
  if (!profiler.ok) return profiler;

  try {
    const result = await profiler.value.start(
      seconds.value ?? DEFAULT_MAX_SECONDS,
      captureLimit.value ?? CAPTURE_LIMIT_MAX,
    );
    return createStructuredResponse({ ...result });
  } catch (error: unknown) {
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

  try {
    const result = await profiler.value.stop(top.value, sort.value);
    return createStructuredResponse({ ...result });
  } catch (error: unknown) {
    return err(profilerFailure(error));
  }
}
