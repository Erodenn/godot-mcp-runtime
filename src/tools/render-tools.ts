import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { randomUUID } from 'crypto';
import type { GodotRunner } from '../utils/godot-runner.js';
import type { HandlerResult, OperationParams, ToolDefinition, ToolResponse } from '../mcp.types.js';
import { normalizeParameters } from '../utils/parameter-conversion.js';
import { parseProjectArgs, optionalString } from '../utils/arg-parsing.js';
import {
  checkDisplayAvailable,
  isUnderDir,
  projectGodotPath,
  resolveProjectPath,
  type ResolvedProjectPath,
} from '../utils/path-validation.js';
import { createErrorResponse, getErrorMessage } from '../utils/error-response.js';
import { createStructuredResponse } from '../utils/structured-response.js';
import { condenseProcessTail } from '../utils/output-parsing.js';
import { ok, err, type Result } from '../utils/result.js';
import { logDebug } from '../utils/logger.js';
import { createNullContext, type McpContext } from '../utils/mcp-context.js';
import { rejectNonSceneLaunchArg, runLaunchGate } from '../utils/launch-gate.js';
import { findLiveSessionOnProject, type LiveSessionOnProject } from '../utils/headless-op.js';
import { liveSessionRemedy } from '../utils/session-report.js';
import {
  BRIDGE_AUTOLOAD_NAME,
  BridgeManager,
  BridgeRegistryUnreadableError,
} from '../utils/bridge-manager.js';
import { parseAutoloads } from '../utils/autoload-ini.js';
import {
  MOVIE_FRAME_BASENAME,
  isServerOwnedBridgePath,
  movieAudioPath,
  movieOutputPath,
  movieRunDir,
  moviesDir,
} from '../utils/artifact-paths.js';
import {
  MOVIE_KILL_GRACE_MS,
  runMovieProcess,
  type MovieProcessResult,
  type RunMovieProcess,
} from '../utils/movie-process.js';
import {
  computeFrameDifference,
  MOTION_CHANNEL_THRESHOLD,
  measurePngFile,
  showsMotion,
  type FrameDifference,
  type RgbaFrame,
} from '../utils/pixel-stats.js';
import { buildFramePreview } from '../utils/frame-preview.js';
import { DEFAULT_PREVIEW_MAX_HEIGHT, DEFAULT_PREVIEW_MAX_WIDTH } from './runtime-tools.js';

export const RENDER_MOVIE_MODES = ['check', 'frames', 'video'] as const;
export const MOVIE_VIDEO_FORMATS = ['avi', 'ogv'] as const;
type RenderMovieMode = (typeof RENDER_MOVIE_MODES)[number];
type MovieVideoFormat = (typeof MOVIE_VIDEO_FORMATS)[number];

export const DEFAULT_MOVIE_MODE: RenderMovieMode = 'check';
export const DEFAULT_MOVIE_VIDEO_FORMAT: MovieVideoFormat = 'avi';
export const DEFAULT_MOVIE_FRAMES = 30;
export const MIN_MOVIE_FRAMES = 2;
export const MAX_MOVIE_FRAMES = 600;
export const DEFAULT_MOVIE_FPS = 30;
export const MIN_MOVIE_FPS = 1;
export const MAX_MOVIE_FPS = 120;
export const DEFAULT_MOVIE_INLINE_FRAMES = 3;
export const MIN_MOVIE_INLINE_FRAMES = 0;
export const MAX_MOVIE_INLINE_FRAMES = 6;
export const MOVIE_INLINE_MAX_WIDTH = DEFAULT_PREVIEW_MAX_WIDTH;
export const MOVIE_INLINE_MAX_HEIGHT = DEFAULT_PREVIEW_MAX_HEIGHT;
export const MOVIE_INLINE_MAX_BYTES = 512 * 1024;
/** At most this many frames are decoded and measured per run, whatever the frame count. */
export const MOVIE_MEASURED_FRAMES_MAX = 8;
/** Leading frames skipped by the measure, which can be blank while the scene loads. */
export const MOVIE_WARMUP_FRAMES = 5;
/** Above this many frames, `frames` mode lists no per-frame paths. */
export const MOVIE_FRAME_PATHS_LISTED_MAX = 60;
export const MOVIE_TIMEOUT_BASE_MS = 30000;
export const MOVIE_TIMEOUT_PER_FRAME_MS = 250;
const MOVIE_STDERR_TAIL_LINES = 20;
/**
 * Cap on the warning lines taken from the run's stderr. Measurement and
 * launch-gate warnings are bounded by their own constants and are never cut,
 * so a project that floods stderr cannot push a scan finding out of the payload.
 */
export const MOVIE_RUNTIME_WARNINGS_MAX = 30;
const MOVIE_CLEANUP_MAX_RETRIES = 3;
const MOVIE_CLEANUP_RETRY_DELAY_MS = 100;

const MS_PER_SECOND = 1000;
const MOVIE_PNG_EXTENSION = 'png' as const;
const MOVIE_FRAME_FILE_PATTERN = new RegExp(`^${MOVIE_FRAME_BASENAME}(\\d+)\\.png$`);
const STATS_NOTE =
  'Pixel stats, likelyBlank and motion are measured from PNG frames. Run mode "check" or "frames" to get them.';

// --- Tool definition ---

export const renderToolDefinitions = [
  {
    name: 'render_movie',
    description:
      'Render the project (or `scene`) for a set number of frames in a separate movie-writer run: no bridge, no session, no input (to interact: run_project + simulate_input + take_screenshot). mode check (default): stats, likelyBlank, motion, inline frames; files deleted. frames: keeps PNGs. video: .avi/.ogv, no stats. Returns: frameCount, likelyBlank, anyMotion, samples, paths; warnings leads if anything was unmeasured. Needs a display. Errors on timeout, failed run, or a live session on the project.',
    annotations: { destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Path to the Godot project directory',
        },
        scene: {
          type: 'string',
          description:
            'Scene to render (path relative to project, e.g. "scenes/main.tscn"). Omit to use the project\'s main scene.',
        },
        mode: {
          type: 'string',
          enum: ['check', 'frames', 'video'],
          description:
            '"check" (default) measures a sample of frames, returns a few inline, and deletes every file. "frames" keeps the PNG sequence (and frame.wav) under .mcp/godot-runtime/movies/ and returns paths plus stats for a sample. "video" writes one movie file and returns its path; it has no pixel stats.',
        },
        frames: {
          type: 'integer',
          minimum: MIN_MOVIE_FRAMES,
          maximum: MAX_MOVIE_FRAMES,
          description: `Frames to render before Godot quits (default ${DEFAULT_MOVIE_FRAMES}, max ${MAX_MOVIE_FRAMES}). The first frames can be blank while the scene loads; likelyBlank is judged on the last one. The run is budgeted at ${MOVIE_TIMEOUT_BASE_MS / MS_PER_SECOND}s plus ${MOVIE_TIMEOUT_PER_FRAME_MS}ms per frame, and a run that overruns it takes up to 10s more to stop, so above about 80 frames a client with a 60s request timeout may cut the call off before this server can report the timeout.`,
        },
        fps: {
          type: 'integer',
          minimum: MIN_MOVIE_FPS,
          maximum: MAX_MOVIE_FPS,
          description: `Fixed simulation and capture rate (default ${DEFAULT_MOVIE_FPS}, max ${MAX_MOVIE_FPS}). Game time covered is frames / fps seconds, whatever the wall-clock speed.`,
        },
        inlineFrames: {
          type: 'integer',
          minimum: MIN_MOVIE_INLINE_FRAMES,
          maximum: MAX_MOVIE_INLINE_FRAMES,
          description: `[check] Inline images to return, evenly spaced and ending at the last frame (default ${DEFAULT_MOVIE_INLINE_FRAMES}, max ${MAX_MOVIE_INLINE_FRAMES}; 0 for none). Each is downscaled to fit ${MOVIE_INLINE_MAX_WIDTH}x${MOVIE_INLINE_MAX_HEIGHT}; stats are measured at full size. Rejected in other modes.`,
        },
        format: {
          type: 'string',
          enum: ['avi', 'ogv'],
          description:
            '[video] Movie container (default "avi"). "ogv" needs an engine that can write it; the error names the format and engine version when it cannot. Rejected in other modes.',
        },
      },
      required: ['projectPath'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        warnings: { type: 'array', items: { type: 'string' } },
        mode: { type: 'string', enum: ['check', 'frames', 'video'] },
        projectPath: { type: 'string' },
        scene: { type: 'string' },
        fps: { type: 'number' },
        framesRequested: { type: 'number' },
        statsAvailable: {
          type: 'boolean',
          description: 'False in video mode: stats need PNG frames.',
        },
        statsNote: { type: 'string' },
        frameCount: { type: 'number', description: 'PNG frames found on disk after the run.' },
        measuredFrames: {
          type: 'number',
          description: 'Sampled frames whose stats were measured.',
        },
        likelyBlank: {
          type: ['boolean', 'null'],
          description: 'Judged on the last frame; null when it was not measured.',
        },
        motion: {
          type: ['number', 'null'],
          description:
            'Largest mean RGB difference between consecutive sampled frames, 0 to 1. A small mover can read near 0 here; anyMotion is decided by changed sample count, not by this mean.',
        },
        anyMotion: {
          type: ['boolean', 'null'],
          description: `True when some pair had at least one sampled point whose R, G or B changed by more than ${MOTION_CHANNEL_THRESHOLD} of 255. Null when no measured pair moved and a pair was not measured, or fewer than two frames were sampled.`,
        },
        motionPairs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              from: { type: 'number' },
              to: { type: 'number' },
              difference: {
                type: ['number', 'null'],
                description: 'Mean absolute RGB difference over the sampling grid, 0 to 1.',
              },
              changedSamples: {
                type: ['number', 'null'],
                description: `Sampled points where R, G or B changed by more than ${MOTION_CHANNEL_THRESHOLD} of 255. Null exactly where difference is null.`,
              },
              changedFraction: {
                type: ['number', 'null'],
                description:
                  'changedSamples divided by the sampled points, 0 to 1. Null exactly where difference is null.',
              },
            },
            required: ['from', 'to', 'difference', 'changedSamples', 'changedFraction'],
          },
        },
        samples: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              index: { type: 'number' },
              path: { type: 'string' },
              stats: {
                type: ['object', 'null'],
                properties: {
                  width: { type: 'number' },
                  height: { type: 'number' },
                  chromatic: { type: 'number' },
                  dominant: { type: 'number' },
                  distinct: { type: 'number' },
                  likelyBlank: { type: 'boolean' },
                },
                required: ['width', 'height', 'chromatic', 'dominant', 'distinct', 'likelyBlank'],
              },
            },
            required: ['index', 'stats'],
          },
        },
        inlineFrames: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              index: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' },
            },
            required: ['index', 'width', 'height'],
          },
        },
        framesKept: { type: 'boolean' },
        directory: { type: 'string' },
        framePattern: { type: 'string' },
        framePaths: {
          type: 'array',
          items: { type: 'string' },
          description: `Omitted above ${MOVIE_FRAME_PATHS_LISTED_MAX} frames; use framePattern and frameCount.`,
        },
        audioPath: { type: 'string' },
        format: { type: 'string', enum: ['avi', 'ogv'] },
        path: { type: 'string' },
        byteSize: { type: 'number' },
      },
      required: ['mode', 'projectPath', 'fps', 'framesRequested', 'statsAvailable'],
    },
  },
] as const satisfies readonly ToolDefinition[];

// --- Pure helpers ---

/** The run is budgeted at a fixed base plus a per-frame allowance. */
export function computeMovieTimeoutMs(frames: number): number {
  return MOVIE_TIMEOUT_BASE_MS + frames * MOVIE_TIMEOUT_PER_FRAME_MS;
}

/**
 * The full Godot argument list for one movie run. No `--headless` (the movie
 * writer does not render under it) and no `--resolution` (the run keeps the
 * project's own size, so the measured frame is the real frame).
 */
export function buildMovieArgs(o: {
  projectPath: string;
  outputPath: string;
  fps: number;
  frames: number;
  scene?: ResolvedProjectPath;
}): string[] {
  const args = [
    '--path',
    resolve(o.projectPath),
    '--write-movie',
    o.outputPath.replace(/\\/g, '/'),
    '--fixed-fps',
    String(o.fps),
    '--disable-vsync',
    '--quit-after',
    String(o.frames),
  ];
  if (o.scene !== undefined) {
    args.push(o.scene.resPath);
  }
  return args;
}

/**
 * Up to `want` positions in 0..total-1, evenly spaced, always ending at the
 * last one. All positions when `want` covers them.
 */
export function pickEvenly(total: number, want: number): number[] {
  if (total <= 0 || want <= 0) return [];
  if (want >= total) return Array.from({ length: total }, (_, i) => i);
  if (want === 1) return [total - 1];
  const picks = new Set<number>();
  for (let j = 0; j < want; j++) {
    picks.add(Math.round((j * (total - 1)) / (want - 1)));
  }
  return [...picks];
}

/**
 * Frame indices (positions in the sorted frame list) the measure decodes. The
 * warm-up skip keeps load-time frames out of the motion measure; the last
 * written frame is always measured.
 */
export function measuredFramePositions(frameCount: number): number[] {
  if (frameCount <= 0) return [];
  const start = Math.min(MOVIE_WARMUP_FRAMES, Math.floor((frameCount - 1) / 2));
  return pickEvenly(frameCount - start, MOVIE_MEASURED_FRAMES_MAX).map((p) => p + start);
}

// --- Argument parsing ---

interface RenderOptions {
  scene: ResolvedProjectPath | undefined;
  mode: RenderMovieMode;
  frames: number;
  fps: number;
  inlineFrames: number;
  format: MovieVideoFormat;
}

function parseBoundedInt(
  args: OperationParams,
  key: string,
  min: number,
  max: number,
  fallback: number,
): Result<number, ToolResponse> {
  const value = args[key];
  if (value === undefined) return ok(fallback);
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    return err(
      createErrorResponse(
        `Invalid ${key}: must be an integer in [${min}, ${max}] (got: ${String(value)})`,
        [`Omit ${key} to use the default (${fallback})`],
      ),
    );
  }
  return ok(value);
}

function wrongModeError(param: string, ownMode: string, mode: string): ToolResponse {
  return createErrorResponse(
    `"${param}" applies only to mode "${ownMode}" and cannot be combined with mode "${mode}".`,
    [`Remove ${param}, or set mode to "${ownMode}"`],
  );
}

function parseRenderOptions(
  args: OperationParams,
  projectRoot: string,
): Result<RenderOptions, ToolResponse> {
  const scene = optionalString(args, 'scene');
  if (!scene.ok) return scene;
  let resolvedScene: ResolvedProjectPath | undefined;
  if (scene.value !== undefined) {
    const resolved = resolveProjectPath(projectRoot, scene.value);
    if (!resolved) {
      return err(
        createErrorResponse(
          `Invalid scene path: must be project-relative without ".." (got: ${scene.value})`,
          ['Pass scene as a path relative to the project root, e.g. "scenes/main.tscn"'],
        ),
      );
    }
    const notAScene = rejectNonSceneLaunchArg(resolved.relPath);
    if (notAScene) return err(notAScene);
    if (!existsSync(resolved.absPath)) {
      return err(
        createErrorResponse(`Scene file does not exist: ${scene.value}`, [
          'Check the path with get_project_files',
          'Omit scene to render the project main scene',
        ]),
      );
    }
    resolvedScene = resolved;
  }

  const rawMode = args.mode ?? DEFAULT_MOVIE_MODE;
  if (typeof rawMode !== 'string' || !(RENDER_MOVIE_MODES as readonly string[]).includes(rawMode)) {
    return err(
      createErrorResponse(`Invalid mode for render_movie: "${String(rawMode)}"`, [
        'Use one of: "check", "frames", "video"',
      ]),
    );
  }
  const mode = rawMode as RenderMovieMode;

  const frames = parseBoundedInt(
    args,
    'frames',
    MIN_MOVIE_FRAMES,
    MAX_MOVIE_FRAMES,
    DEFAULT_MOVIE_FRAMES,
  );
  if (!frames.ok) return frames;
  const fps = parseBoundedInt(args, 'fps', MIN_MOVIE_FPS, MAX_MOVIE_FPS, DEFAULT_MOVIE_FPS);
  if (!fps.ok) return fps;
  const inlineFrames = parseBoundedInt(
    args,
    'inlineFrames',
    MIN_MOVIE_INLINE_FRAMES,
    MAX_MOVIE_INLINE_FRAMES,
    DEFAULT_MOVIE_INLINE_FRAMES,
  );
  if (!inlineFrames.ok) return inlineFrames;

  const rawFormat = args.format ?? DEFAULT_MOVIE_VIDEO_FORMAT;
  if (
    typeof rawFormat !== 'string' ||
    !(MOVIE_VIDEO_FORMATS as readonly string[]).includes(rawFormat)
  ) {
    return err(
      createErrorResponse(`Invalid format for render_movie: "${String(rawFormat)}"`, [
        'Use "avi" or "ogv"',
      ]),
    );
  }

  if (args.format !== undefined && mode !== 'video') {
    return err(wrongModeError('format', 'video', mode));
  }
  if (args.inlineFrames !== undefined && mode !== 'check') {
    return err(wrongModeError('inlineFrames', 'check', mode));
  }

  return ok({
    scene: resolvedScene,
    mode,
    frames: frames.value,
    fps: fps.value,
    inlineFrames: inlineFrames.value,
    format: rawFormat as MovieVideoFormat,
  });
}

// --- Refusals ---

function refuseNoDisplay(): ToolResponse {
  return createErrorResponse(
    'render_movie needs a display server: DISPLAY and WAYLAND_DISPLAY are both unset. The movie writer renders with the real renderer and does not work under --headless.',
    ['Set DISPLAY or WAYLAND_DISPLAY', 'On a headless machine, start the server under xvfb-run'],
  );
}

function refuseOwnSession(runner: GodotRunner, root: string): ToolResponse {
  const remedy = liveSessionRemedy(runner, root, 'render_movie');
  return createErrorResponse(
    `render_movie cannot run while a runtime session is active on this project.${remedy.note} The movie run is a second Godot process that would load the injected McpBridge autoload next to the live game.`,
    [
      ...remedy.solutions,
      'To check rendering inside the live session, use take_screenshot: its stats report likelyBlank',
    ],
  );
}

function refuseOtherSession(pid: number, mode: string): ToolResponse {
  return createErrorResponse(
    `Another MCP session (server pid ${pid}, ${mode} mode) is running this project's game. That game belongs to the other session, not this one, and only it can stop it. render_movie would start a second Godot process that loads that session's McpBridge autoload, so it is refused while that session lives. Wait for the other session to finish (stop_project there), then retry.`,
    [
      'Wait and retry once the other MCP session has stopped or detached its game',
      "check_project on this project shows this session's own state, not the other session's",
    ],
  );
}

function refuseStrandedBridge(registeredPath: string): ToolResponse {
  return createErrorResponse(
    `project.godot registers the McpBridge autoload (${registeredPath}) but no live MCP session owns it. render_movie does not run with the bridge loaded and does not edit project.godot.`,
    [
      'Call remove_autoload with name "McpBridge" on this project, then retry render_movie',
      'If an older server version is running this project, stop it first',
    ],
  );
}

/** The registered path of a server-owned McpBridge autoload, or null. Never throws. */
function findServerOwnedBridgeEntry(projectRoot: string): string | null {
  try {
    const entry = parseAutoloads(projectGodotPath(projectRoot)).find(
      (a) => a.name === BRIDGE_AUTOLOAD_NAME,
    );
    return entry !== undefined && isServerOwnedBridgePath(entry.path) ? entry.path : null;
  } catch (error) {
    logDebug(`render_movie could not read the autoload section: ${getErrorMessage(error)}`);
    return null;
  }
}

/**
 * The refusals that keep a movie run from loading the McpBridge autoload: a
 * live session on the project (this server's or another's), an owner registry
 * that cannot be read, or a server-owned entry no live session owns. Null
 * when the project is clear. Reads only; nothing is written.
 */
function refuseIfBridgeMayLoad(runner: GodotRunner, root: string): ToolResponse | null {
  let live: LiveSessionOnProject | null;
  try {
    live = findLiveSessionOnProject(runner, root);
  } catch (error: unknown) {
    // An unreadable owner registry is "unknown", never "nobody is running".
    if (!(error instanceof BridgeRegistryUnreadableError)) throw error;
    return createErrorResponse(
      `Could not read this project's bridge owner registry (${error.reason}), so it is unknown whether another MCP session is running its game. Refusing to start a movie run.`,
      [
        'Retry: a registry file that another session was writing at that moment is readable again a moment later',
        'If it keeps failing, check the permissions on .mcp/godot-runtime/bridge/owners/ in the project',
      ],
    );
  }
  if (live !== null) {
    return live.owner === 'self'
      ? refuseOwnSession(runner, root)
      : refuseOtherSession(live.info.pid, live.info.mode);
  }
  const strandedPath = findServerOwnedBridgeEntry(root);
  return strandedPath !== null ? refuseStrandedBridge(strandedPath) : null;
}

// --- Run interpretation ---

function stderrTail(stderr: string): string {
  const lines = condenseProcessTail(stderr.split('\n'), MOVIE_STDERR_TAIL_LINES);
  return lines.length === 0 ? '' : `\nLast stderr:\n${lines.join('\n')}`;
}

interface FrameFile {
  index: number;
  name: string;
  digits: number;
}

/** PNG frames in a run directory, sorted by the frame index parsed from the file name. */
function discoverFrames(runDir: string): FrameFile[] {
  const found: FrameFile[] = [];
  for (const name of readdirSync(runDir)) {
    const match = MOVIE_FRAME_FILE_PATTERN.exec(name);
    if (match) found.push({ index: Number(match[1]), name, digits: match[1]!.length });
  }
  return found.sort((a, b) => a.index - b.index);
}

/** Remove a run directory. Returns the failure message, or null when it is gone. */
function removeRunDir(runDir: string): string | null {
  try {
    rmSync(runDir, {
      recursive: true,
      force: true,
      maxRetries: MOVIE_CLEANUP_MAX_RETRIES,
      retryDelay: MOVIE_CLEANUP_RETRY_DELAY_MS,
    });
    return null;
  } catch (error) {
    return getErrorMessage(error);
  }
}

interface SampleStats {
  width: number;
  height: number;
  chromatic: number;
  dominant: number;
  distinct: number;
  likelyBlank: boolean;
}

interface Sample {
  index: number;
  path: string;
  stats: SampleStats | null;
  reason: string | null;
}

interface MotionPair {
  from: number;
  to: number;
  difference: number | null;
  /** Sampled points that changed beyond the per-channel threshold; null where difference is. */
  changedSamples: number | null;
  /** changedSamples over the sampled points, 0 to 1; null where difference is. */
  changedFraction: number | null;
  reason: string | null;
}

interface InlineEntry {
  index: number;
  width: number;
  height: number;
}

interface Measurement {
  samples: Sample[];
  pairs: MotionPair[];
  inlineEntries: InlineEntry[];
  inlineBlocks: Array<{ type: string; [k: string]: unknown }>;
  inlineMissing: number[];
}

const PAIR_UNMEASURED_REASON = 'a frame of the pair was not measured';
const PAIR_SIZE_REASON = 'the frames differ in size';

/**
 * Decode and measure the sampled frames in order, holding only the previous
 * decoded frame. In check mode the chosen positions also yield an inline image.
 */
function measureFrames(runDir: string, frameFiles: FrameFile[], inlineWanted: number): Measurement {
  const positions = measuredFramePositions(frameFiles.length);
  const inlineAt = new Set(pickEvenly(positions.length, inlineWanted));
  const result: Measurement = {
    samples: [],
    pairs: [],
    inlineEntries: [],
    inlineBlocks: [],
    inlineMissing: [],
  };
  let previous: { index: number; frame: RgbaFrame | null } | null = null;

  positions.forEach((position, order) => {
    const file = frameFiles[position]!;
    const path = join(runDir, file.name);
    const measured = measurePngFile(path);
    const frame: RgbaFrame | null = measured.ok ? measured.value.frame : null;
    result.samples.push({
      index: file.index,
      path,
      stats: measured.ok
        ? { ...measured.value.stats, likelyBlank: measured.value.likelyBlank }
        : null,
      reason: measured.ok ? null : measured.error,
    });

    if (previous !== null) {
      let difference: FrameDifference | null = null;
      let reason: string | null = PAIR_UNMEASURED_REASON;
      if (previous.frame !== null && frame !== null) {
        difference = computeFrameDifference(previous.frame, frame);
        reason = difference === null ? PAIR_SIZE_REASON : null;
      }
      result.pairs.push({
        from: previous.index,
        to: file.index,
        difference: difference?.mean ?? null,
        changedSamples: difference?.changedSamples ?? null,
        changedFraction: difference ? difference.changedSamples / difference.sampledPoints : null,
        reason,
      });
    }

    if (inlineAt.has(order)) {
      if (frame === null) {
        result.inlineMissing.push(file.index);
      } else {
        const preview = buildFramePreview(
          frame,
          MOVIE_INLINE_MAX_WIDTH,
          MOVIE_INLINE_MAX_HEIGHT,
          MOVIE_INLINE_MAX_BYTES,
        );
        result.inlineBlocks.push({
          type: 'image',
          data: preview.png.toString('base64'),
          mimeType: 'image/png',
        });
        result.inlineEntries.push({
          index: file.index,
          width: preview.width,
          height: preview.height,
        });
      }
    }

    previous = { index: file.index, frame };
  });

  return result;
}

function summarizeMotion(pairs: MotionPair[]): {
  motion: number | null;
  anyMotion: boolean | null;
} {
  const differences = pairs.flatMap((p) => (p.difference === null ? [] : [p.difference]));
  const motion = differences.length > 0 ? Math.max(...differences) : null;
  if (
    pairs.some(
      (p) => p.changedSamples !== null && showsMotion({ changedSamples: p.changedSamples }),
    )
  ) {
    return { motion, anyMotion: true };
  }
  const everyPairMeasured = pairs.length > 0 && differences.length === pairs.length;
  return { motion, anyMotion: everyPairMeasured ? false : null };
}

function measurementWarnings(
  m: Measurement,
  frameCount: number,
  framesRequested: number,
): string[] {
  const warnings: string[] = [];
  const last = m.samples[m.samples.length - 1];
  if (last !== undefined && last.stats === null) {
    warnings.push(
      `likelyBlank was not determined: the last frame (${last.index}) was not measured.`,
    );
  }
  for (const sample of m.samples) {
    if (sample.stats === null) {
      warnings.push(
        `Frame ${sample.index} was not measured: ${sample.reason}. Its stats are null, which does not mean the frame is blank.`,
      );
    }
  }
  if (m.pairs.length === 0) {
    warnings.push('Motion was not measured: fewer than two frames were sampled.');
  }
  for (const pair of m.pairs) {
    if (pair.difference === null) {
      warnings.push(
        `Motion between frames ${pair.from} and ${pair.to} was not measured: ${pair.reason}.`,
      );
    }
  }
  for (const index of m.inlineMissing) {
    warnings.push(`Inline frame ${index} was not produced: the frame was not measured.`);
  }
  if (frameCount !== framesRequested) {
    warnings.push(
      `The movie writer wrote ${frameCount} frames, not the ${framesRequested} requested.`,
    );
  }
  return warnings;
}

// --- Handler ---

export interface RenderMovieDeps {
  runProcess: RunMovieProcess;
  displayAvailable: () => boolean;
}

interface RunContext {
  runner: GodotRunner;
  root: string;
  scene: ResolvedProjectPath | undefined;
  options: RenderOptions;
  runId: string;
  runDir: string;
  outputPath: string;
  timeoutMs: number;
  gateWarnings: string[];
}

async function engineVersion(runner: GodotRunner): Promise<string> {
  try {
    return await runner.getVersion();
  } catch {
    return 'unknown version';
  }
}

function runtimeErrorWarnings(runner: GodotRunner, stderr: string): string[] {
  const lines = runner
    .extractRuntimeErrors(stderr.split('\n'))
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length <= MOVIE_RUNTIME_WARNINGS_MAX) return lines;
  const kept = lines.slice(0, MOVIE_RUNTIME_WARNINGS_MAX);
  kept.push(`+${lines.length - MOVIE_RUNTIME_WARNINGS_MAX} more runtime error lines`);
  return kept;
}

/** The error for a run that did not produce what the mode needs, or null. */
async function findRunFailure(
  rc: RunContext,
  result: MovieProcessResult,
  frameFileCount: number,
): Promise<ToolResponse | null> {
  if (result.spawnError !== undefined) {
    return createErrorResponse(`render_movie could not start Godot: ${result.spawnError}`, [
      'Set GODOT_PATH to your Godot 4.x executable',
      'Ensure the path points at the Godot binary, not its installation folder',
    ]);
  }
  const tail = stderrTail(result.stderr);
  if (result.timedOut) {
    const solutions = [
      'Request fewer frames',
      'A project that blocks at startup never reaches the frame limit: start it with run_project and read get_debug_output',
    ];
    // "Killed" is only said when the process reported closing after the kill.
    if (result.killUnconfirmed === true) {
      return createErrorResponse(
        `render_movie timed out after ${rc.timeoutMs} ms. A kill was sent to the Godot process tree, but it did not report exiting within ${MOVIE_KILL_GRACE_MS} ms, so a Godot process may still be running.${tail}`,
        ['Check for a leftover Godot process and end it before retrying', ...solutions],
      );
    }
    return createErrorResponse(
      `render_movie timed out after ${rc.timeoutMs} ms and the Godot process tree was killed.${tail}`,
      solutions,
    );
  }

  if (rc.options.mode === 'video') {
    let reason: string | null = null;
    if (result.exitCode !== 0) {
      reason = `exit code ${result.exitCode}`;
    } else if (!existsSync(rc.outputPath)) {
      reason = 'no output file';
    } else if (statSync(rc.outputPath).size === 0) {
      reason = 'empty output file';
    }
    if (reason === null) return null;
    const format = rc.options.format;
    const version = await engineVersion(rc.runner);
    const ogvNote =
      format === 'ogv' ? ' This engine version may not support the ogv movie format.' : '';
    return createErrorResponse(
      `render_movie: Godot ${version} did not write an ${format} movie (${reason}).${ogvNote}${tail}`,
      [
        'Use format "avi"',
        'Use mode "frames" for a PNG sequence',
        'Check for broken autoloads with list_autoloads',
      ],
    );
  }

  if (result.exitCode !== 0) {
    return createErrorResponse(
      `render_movie: Godot exited with code ${result.exitCode} before finishing the movie run.${tail}`,
      [
        'Check for broken autoloads with list_autoloads',
        'Start the project with run_project and read get_debug_output for the full log',
      ],
    );
  }
  if (frameFileCount === 0) {
    return createErrorResponse(
      `render_movie: the movie writer exited cleanly but wrote no frames.${tail}`,
      [
        'Start the project with run_project and read get_debug_output',
        'A project that quits by itself at startup writes nothing',
      ],
    );
  }
  return null;
}

function buildVideoResponse(rc: RunContext, result: MovieProcessResult): HandlerResult {
  const warnings = [...runtimeErrorWarnings(rc.runner, result.stderr), ...rc.gateWarnings];
  return createStructuredResponse({
    ...(warnings.length > 0 ? { warnings } : {}),
    mode: rc.options.mode,
    projectPath: rc.root,
    ...(rc.scene !== undefined ? { scene: rc.scene.relPath } : {}),
    fps: rc.options.fps,
    framesRequested: rc.options.frames,
    statsAvailable: false,
    statsNote: STATS_NOTE,
    format: rc.options.format,
    path: rc.outputPath,
    byteSize: statSync(rc.outputPath).size,
  });
}

function buildPngResponse(
  rc: RunContext,
  result: MovieProcessResult,
  frameFiles: FrameFile[],
): HandlerResult {
  const isCheck = rc.options.mode === 'check';
  const frameCount = frameFiles.length;
  const measurement = measureFrames(rc.runDir, frameFiles, isCheck ? rc.options.inlineFrames : 0);
  const { motion, anyMotion } = summarizeMotion(measurement.pairs);
  const lastSample = measurement.samples[measurement.samples.length - 1];
  const likelyBlank = lastSample?.stats?.likelyBlank ?? null;
  const measuredFrames = measurement.samples.filter((s) => s.stats !== null).length;

  const audioExists = existsSync(movieAudioPath(rc.root, rc.runId));
  const framePaths = frameFiles.map((f) => join(rc.runDir, f.name));
  const firstFrame = frameFiles[0]!;

  const warnings = measurementWarnings(measurement, frameCount, rc.options.frames);
  warnings.push(...runtimeErrorWarnings(rc.runner, result.stderr));
  warnings.push(...rc.gateWarnings);

  // A check run keeps nothing: remove the directory now, so a removal failure
  // can still be reported in this response.
  if (isCheck) {
    const failure = removeRunDir(rc.runDir);
    if (failure !== null) {
      warnings.push(`Could not remove the run directory ${rc.runDir}: ${failure}`);
    }
  }
  const samples = measurement.samples.map((s) => ({
    index: s.index,
    ...(isCheck ? {} : { path: s.path }),
    stats: s.stats,
  }));

  const payload: Record<string, unknown> = {
    ...(warnings.length > 0 ? { warnings } : {}),
    mode: rc.options.mode,
    projectPath: rc.root,
    ...(rc.scene !== undefined ? { scene: rc.scene.relPath } : {}),
    fps: rc.options.fps,
    framesRequested: rc.options.frames,
    statsAvailable: true,
    frameCount,
    measuredFrames,
    likelyBlank,
    motion,
    anyMotion,
    motionPairs: measurement.pairs.map((p) => ({
      from: p.from,
      to: p.to,
      difference: p.difference,
      changedSamples: p.changedSamples,
      changedFraction: p.changedFraction,
    })),
    samples,
  };
  if (isCheck) {
    payload.inlineFrames = measurement.inlineEntries;
    payload.framesKept = false;
    return createStructuredResponse(payload, measurement.inlineBlocks);
  }
  payload.framesKept = true;
  payload.directory = rc.runDir;
  payload.framePattern = join(
    rc.runDir,
    `${MOVIE_FRAME_BASENAME}%0${firstFrame.digits}d.${MOVIE_PNG_EXTENSION}`,
  );
  if (frameCount <= MOVIE_FRAME_PATHS_LISTED_MAX) payload.framePaths = framePaths;
  if (audioExists) payload.audioPath = movieAudioPath(rc.root, rc.runId);
  return createStructuredResponse(payload);
}

/**
 * Build the `render_movie` handler around an injected process runner and
 * display probe, so tests exercise the whole handler without spawning Godot.
 */
export function createRenderMovieHandler(
  deps: RenderMovieDeps,
): (runner: GodotRunner, args: OperationParams, ctx?: McpContext) => Promise<HandlerResult> {
  return async (runner, rawArgs, ctx = createNullContext()) => {
    const args = normalizeParameters(rawArgs);

    const parsed = parseProjectArgs(args);
    if (!parsed.ok) return parsed;
    const root = resolve(parsed.value.projectPath);

    const options = parseRenderOptions(args, root);
    if (!options.ok) return options;
    const { scene, mode, frames, fps, format } = options.value;

    // Refusals come before anything that could prompt a human or touch disk:
    // a launch that cannot happen must never ask for confirmation.
    if (!deps.displayAvailable()) return err(refuseNoDisplay());

    const busy = refuseIfBridgeMayLoad(runner, root);
    if (busy !== null) return err(busy);

    let godotPath = runner.getGodotPath();
    if (!godotPath) {
      await runner.detectGodotPath();
      godotPath = runner.getGodotPath();
    }
    if (!godotPath) {
      return err(
        createErrorResponse('Could not find a valid Godot executable path', [
          'Set GODOT_PATH in your MCP client config to your Godot 4.x executable',
          'Ensure the path points at the Godot binary, not its installation folder',
          'On Windows, escape backslashes in JSON (e.g. "D:\\\\Godot\\\\Godot.exe")',
        ]),
      );
    }

    const gate = await runLaunchGate(
      { projectPath: root, scene, confirm: true, toolName: 'render_movie' },
      ctx,
    );
    if (!gate.ok) return gate;

    // The gate can hold a confirmation prompt open for as long as a human
    // takes to answer it. A session started on this project in that time has
    // injected the bridge, and the movie process would load it with no session
    // token and no port of its own. Asked again, now that the wait is over.
    const busyAfterGate = refuseIfBridgeMayLoad(runner, root);
    if (busyAfterGate !== null) return err(busyAfterGate);

    const runId = `${Date.now()}-${randomUUID()}`;
    const runDir = movieRunDir(root, runId);
    try {
      if (!isUnderDir(moviesDir(root), runDir)) {
        throw new Error('the run directory is outside the movies directory');
      }
      BridgeManager.ensureArtifactRoot(root);
      mkdirSync(runDir, { recursive: true });
    } catch (error) {
      return err(
        createErrorResponse(
          `render_movie could not prepare its output directory: ${getErrorMessage(error)}`,
          ['Check write permissions on the project directory (.mcp/godot-runtime/movies/)'],
        ),
      );
    }

    const outputPath = movieOutputPath(
      root,
      runId,
      mode === 'video' ? format : MOVIE_PNG_EXTENSION,
    );
    const rc: RunContext = {
      runner,
      root,
      scene,
      options: options.value,
      runId,
      runDir,
      outputPath,
      timeoutMs: computeMovieTimeoutMs(frames),
      gateWarnings: gate.value.warnings,
    };

    let response: HandlerResult;
    try {
      const result = await deps.runProcess(
        godotPath,
        buildMovieArgs({
          projectPath: root,
          outputPath,
          fps,
          frames,
          ...(scene !== undefined ? { scene } : {}),
        }),
        rc.timeoutMs,
      );
      const frameFiles = mode === 'video' ? [] : discoverFrames(runDir);
      const failure = await findRunFailure(rc, result, frameFiles.length);
      if (failure !== null) {
        response = err(failure);
      } else if (mode === 'video') {
        response = buildVideoResponse(rc, result);
      } else {
        response = buildPngResponse(rc, result, frameFiles);
      }
    } catch (error) {
      response = err(
        createErrorResponse(`render_movie failed: ${getErrorMessage(error)}`, [
          'Start the project with run_project and read get_debug_output for the full log',
        ]),
      );
    }

    if (!response.ok) {
      const failure = removeRunDir(runDir);
      if (failure !== null) {
        logDebug(`render_movie could not remove ${runDir} after an error: ${failure}`);
        // Said in the response too: a silent leak would leave frames in the
        // project that the caller was told nothing about.
        response.error.content.push({
          type: 'text',
          text: `The run directory could not be removed and may still hold files from this run: ${runDir} (${failure})`,
        });
      }
    }
    return response;
  };
}

export const handleRenderMovie = createRenderMovieHandler({
  runProcess: runMovieProcess,
  displayAvailable: checkDisplayAvailable,
});
