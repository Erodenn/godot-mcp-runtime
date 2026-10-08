import { join, sep, resolve } from 'path';
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'fs';
import {
  BRIDGE_PING_TIMEOUT_MS,
  BRIDGE_WAIT_ATTACHED_CONNECTED_TIMEOUT_MS,
  BRIDGE_WAIT_ATTACHED_TIMEOUT_MS,
  StartBudgetExhaustedError,
  type AttachedProbeOutcome,
  type GodotRunner,
  type ReplacedAttachedSession,
  type RuntimeSessionMode,
} from '../utils/godot-runner.js';
import {
  BRIDGE_WAIT_SPAWNED_TIMEOUT_MS,
  OVERSIZE_RESPONSE_FIELD,
} from '../utils/bridge-protocol.js';
import type { HandlerResult, OperationParams, ToolDefinition, ToolResponse } from '../mcp.types.js';
import { normalizeParameters } from '../utils/parameter-conversion.js';
import {
  checkDisplayAvailable,
  resolveProjectPath,
  isUnderDir,
  projectSubPathError,
  PROJECT_SUB_PATH_SOLUTIONS,
  type ResolvedProjectPath,
} from '../utils/path-validation.js';
import { createErrorResponse, getErrorMessage } from '../utils/error-response.js';
import { createStructuredResponse, leadWithWarnings } from '../utils/structured-response.js';
import {
  parseProjectArgs,
  optionalString,
  optionalNumber,
  optionalBoolean,
  optionalStringArray,
  requireString,
  requireArray,
} from '../utils/arg-parsing.js';
import { ok, err, type Result } from '../utils/result.js';
import { logDebug } from '../utils/logger.js';
import { parseScriptDiagnostics, condenseProcessTail } from '../utils/output-parsing.js';
import { randomUUID } from 'crypto';
import {
  createNullContext,
  isElicitAccepted,
  type McpContext,
  type ElicitorResult,
} from '../utils/mcp-context.js';
import {
  evaluateScript,
  matchesToWarnings,
  summarizeMatch,
  type PolicyDecision,
  type PolicyMatch,
} from '../utils/run-script-policy.js';
import { auditScriptsDir, screenshotsDir } from '../utils/artifact-paths.js';
import { TIMESTAMP_OVERFLOW_ERRORS, TIMESTAMP_OVERFLOW_FIX } from '../utils/profiler.js';
import {
  BridgeAttachConflictError,
  BridgeAutoloadCollisionError,
  BridgeRegistryUnreadableError,
} from '../utils/bridge-manager.js';
import { rejectNonSceneLaunchArg, runLaunchGate } from '../utils/launch-gate.js';
import { measurePngFile } from '../utils/pixel-stats.js';
import {
  noLiveCurrentSessionError,
  otherLiveSessionsClause,
  requireRuntimeSession,
  runSessionExclusive,
  runtimeCommandFailure,
  runtimeToolWording,
  type NoSessionWording,
} from '../utils/session-report.js';
import { commandWasNotSent, sessionKey } from '../utils/godot-runner.js';

const SCREENSHOT_RESPONSE_MODES = ['full', 'preview', 'path_only'] as const;
export const DEFAULT_PREVIEW_MAX_WIDTH = 960;
export const DEFAULT_PREVIEW_MAX_HEIGHT = 540;
/**
 * Largest preview box a caller may ask for. A preview is the cheap inline
 * image; past full HD the caller wants `full`, which returns the screenshot
 * itself. A larger request is clamped to this, not refused.
 */
export const PREVIEW_MAX_WIDTH_LIMIT = 1920;
export const PREVIEW_MAX_HEIGHT_LIMIT = 1080;
const BYTES_PER_MEBIBYTE = 1024 * 1024;
/**
 * Largest image file returned inline, for `full` and `preview` alike. Base64
 * adds a third, and a response of several megabytes is refused by some
 * clients and costs the others their context. Past this the path, size and
 * stats are still returned, with a leading warning in place of the image.
 */
export const SCREENSHOT_INLINE_MAX_BYTES = 3 * BYTES_PER_MEBIBYTE;
const STATS_NOT_MEASURED_WARNING_PREFIX = 'Pixel stats were not measured: ';
const STATS_NOT_MEASURED_WARNING_SUFFIX =
  '. The screenshot was saved; stats is null, which does not mean the frame is blank.';

// Input batch caps, mirrored in src/scripts/mcp_bridge.gd. Enforced here so an
// over-cap batch never reaches the bridge, and there so the bridge is safe on
// its own. Declared above the tool definitions because the input schema
// references MAX_WATCH_ENTRIES while that array is being built.
const MAX_WAIT_FRAMES = 600;
const MAX_HOLD_MS = 10000;
const MAX_TEXT_LENGTH = 1000;
const MAX_WATCH_ENTRIES = 16;

// Timeout math for simulate_input. The progress-heartbeat invariant makes the
// server-side timeout load-bearing, so every term is a named multiplier and the
// caps above are what keep the total bounded.
const INPUT_TIMEOUT_BUFFER_MS = 10000;
/**
 * Ceiling on one batch's computed time budget (`computeInputTimeoutMs`): its
 * waits and holds, its frames at the pessimistic frame time, and the buffer.
 * A batch over it is refused before anything is injected. The per-action caps
 * bound each wait, but not how many there are, and a wait in milliseconds had
 * no cap at all; with no ceiling the server-side timeout of the call is
 * whatever the caller asked for. Ten minutes is far past any batch that
 * drives a game step by step; longer waits belong in separate calls.
 *
 * KEEP IN SYNC: `MAX_BATCH_WAIT_MS` in src/scripts/mcp_bridge.gd bounds the
 * wall-clock waits of a batch at the same figure on the bridge side.
 */
export const MAX_INPUT_BATCH_BUDGET_MS = 600000;
const MS_PER_SECOND = 1000;
/**
 * Wall-clock charged per engine frame a batch waits on. It is a floor on the
 * frame rate, not an estimate of it: a batch that outruns this budget times out
 * on the Node side while the game is running correctly. 100 ms covers 10 fps,
 * which is the practical floor for a game under load or one whose window is
 * minimized (some platforms throttle `process_frame` there). At the
 * MAX_WAIT_FRAMES cap the computed budget exceeds the 60 s default per-request
 * timeout most MCP clients use, so a batch that waits hundreds of frames is
 * documented as a call the client may cut off first.
 */
const INPUT_PESSIMISTIC_FRAME_MS = 100;
const INPUT_SETTLE_FRAMES_PER_ACTION = 1;
// One process frame plus one physics frame, the tap hold for key and action.
const INPUT_TAP_HOLD_FRAMES = 2;
const INPUT_TEXT_PER_CHAR_MS = 1;

/** Bridge timeout for one screenshot command when the caller passes no `timeout`. */
export const SCREENSHOT_DEFAULT_TIMEOUT_MS = 10000;
/** How long run_script waits for the bridge when the caller passes no timeout. */
const RUN_SCRIPT_DEFAULT_TIMEOUT_MS = 30000;
/**
 * KEEP IN SYNC: `FRAME_RENDER_BUDGET_MS` in src/scripts/mcp_bridge.gd is the
 * twin of this constant. How long the bridge waits for one rendered frame
 * before it answers a screenshot with an error. It has to stay under
 * SCREENSHOT_DEFAULT_TIMEOUT_MS: past it the command timeout fires first, and
 * the caller gets a generic timeout in place of the bridge's own diagnosis.
 */
export const SCREENSHOT_FRAME_RENDER_BUDGET_MS = 5000;

// Valid TCP port range for the MCP bridge. Declared above the tool definitions
// because the run_project input schema and parseBridgePortArg share it.
const BRIDGE_PORT_MIN = 1;
const BRIDGE_PORT_MAX = 65535;

// run_project parameters that only mean something when this server spawns
// Godot itself. Attach mode rejects them instead of silently ignoring them.
/** What a background-mode run says about itself in its success and failure text. */
const BACKGROUND_MODE_NOTE =
  'Background mode: window not shown on Windows, moved off-screen elsewhere; mouse input passes through';

const SPAWN_ONLY_RUN_PROJECT_PARAMS = ['scene', 'background', 'profiling'] as const;

type ScreenshotResponseMode = (typeof SCREENSHOT_RESPONSE_MODES)[number];

interface ScreenshotBridgeResponse {
  path?: string;
  preview_path?: string;
  width?: number;
  height?: number;
  preview_width?: number;
  preview_height?: number;
  error?: string;
}

// --- Tool definitions ---

export const runtimeToolDefinitions = [
  {
    name: 'launch_editor',
    description:
      'Open the Godot editor GUI for a project, for the human user. Use only when the user asks to open the editor; for agent-driven work use the headless scene and node tools (add_node, set_node_properties, etc.), since the editor cannot be controlled programmatically. Returns: projectPath, the editor process pid and message. Errors if projectPath has no project.godot or the editor process does not start.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Path to the Godot project directory',
        },
      },
      required: ['projectPath'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string' },
        pid: { type: 'number', description: 'Process id of the editor.' },
        message: { type: 'string' },
      },
      required: ['projectPath', 'pid', 'message'],
    },
  },
  {
    name: 'run_project',
    description:
      'Start a runtime session: spawn the project (stdout/stderr captured), or with attach: true wait for a Godot you launch yourself (nothing spawned or captured). Required before take_screenshot, simulate_input, get_ui_elements and run_script; returns once the bridge answers. The new session becomes current; sessions on other projects keep running. Returns: projectPath, sessionMode, bridgePort, message; warnings leads on a scan finding or a start caveat. Errors if the bridge never answers.',
    annotations: { destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Path to the Godot project directory',
        },
        attach: {
          type: 'boolean',
          description: `If true, do not spawn Godot: inject the bridge and wait for a Godot process you launch yourself (up to ${BRIDGE_WAIT_ATTACHED_TIMEOUT_MS / 1000}s for it to start listening, ${BRIDGE_WAIT_ATTACHED_CONNECTED_TIMEOUT_MS / 1000}s total once it has). Call before Godot launches, or start the launch in parallel, because Godot reads autoloads only at startup. One attach session per project; attaching again keeps this server's attached session unless its bridge is gone, and says so in warnings. Cannot be combined with scene, background or profiling. Nothing is captured: get_debug_output returns null logs with a warning, and the profiler is unavailable.`,
        },
        scene: {
          type: 'string',
          description:
            'Scene to run (path relative to project, e.g. "scenes/main.tscn"). Omit to use the project\'s main scene. Not valid with attach: true.',
        },
        background: {
          type: 'boolean',
          description:
            'If true, the game window is never shown on Windows and is moved off-screen after startup on other platforms; mouse input passes through to whatever is beneath it. Programmatic input (simulate_input, run_script) and screenshots stay fully active. It does not guarantee the game never takes keyboard focus. Not valid with attach: true.',
        },
        bridgePort: {
          type: 'integer',
          minimum: BRIDGE_PORT_MIN,
          maximum: BRIDGE_PORT_MAX,
          description:
            'TCP port for the MCP bridge. Omit to auto-select a free port (recommended). Spawned sessions receive it through an environment variable; attach mode bakes it into the injected bridge script, so the Godot you launch listens on exactly this port. A port held by a live session on another project is refused.',
        },
        profiling: {
          type: 'boolean',
          description:
            "Attach Godot's own remote debugger so profile_project, start_profiler and stop_profiler can measure this session. Must be set at launch - a session already running cannot be profiled - and costs a little runtime overhead. Not valid with attach: true.",
        },
      },
      required: ['projectPath'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        warnings: { type: 'array', items: { type: 'string' } },
        projectPath: { type: 'string' },
        sessionMode: { type: 'string', enum: ['spawned', 'attached'] },
        bridgePort: { type: 'number' },
        message: { type: 'string' },
      },
      required: ['projectPath', 'sessionMode', 'bridgePort', 'message'],
    },
  },
  {
    name: 'switch_project',
    description:
      "Point the runtime tools (screenshots, input, UI, run_script, debug output, profiling, stop_project) at another project's session. Needed only when several sessions exist; run_project makes its own session current. A session whose game exited can be selected to read its logs or stop it: live is then false and warnings leads. Returns: projectPath, previousProjectPath, live, sessionMode, bridgePort, bridgeResponsive, message. Errors if the project has no session, listing the live ones.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description:
            'Path to the Godot project directory whose session becomes the current one. check_project lists the live sessions.',
        },
      },
      required: ['projectPath'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        warnings: { type: 'array', items: { type: 'string' } },
        projectPath: { type: 'string' },
        previousProjectPath: { type: ['string', 'null'] },
        live: { type: 'boolean' },
        sessionMode: { type: ['string', 'null'], enum: ['spawned', 'attached', null] },
        bridgePort: { type: ['number', 'null'] },
        bridgeResponsive: { type: ['boolean', 'null'] },
        exitCode: { type: ['number', 'null'] },
        message: { type: 'string' },
      },
      required: [
        'projectPath',
        'previousProjectPath',
        'live',
        'sessionMode',
        'bridgePort',
        'bridgeResponsive',
        'message',
      ],
    },
  },
  {
    name: 'get_debug_output',
    description:
      'Read captured stdout/stderr from a spawned Godot project. Use whenever a runtime tool fails unexpectedly: script errors, missing nodes and crash backtraces surface here. Still works after the process exits or crashes; the logs are kept until stop_project. Returns: projectPath, sessionMode, output and errors (last `limit` lines each, default 200), running (false after exit) and exitCode after exit. An attached session captures nothing: output, errors and running are null and warnings leads.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Max lines to return (default: 200, from end of output)',
        },
      },
      required: [],
    },
    outputSchema: {
      type: 'object',
      properties: {
        warnings: { type: 'array', items: { type: 'string' } },
        projectPath: { type: 'string' },
        sessionMode: { type: 'string', enum: ['spawned', 'attached'] },
        output: {
          type: ['array', 'null'],
          items: { type: 'string' },
          description: 'Null in an attached session, which captures nothing.',
        },
        errors: {
          type: ['array', 'null'],
          items: { type: 'string' },
          description: 'Null in an attached session, which captures nothing.',
        },
        running: { type: ['boolean', 'null'] },
        exitCode: { type: ['number', 'null'] },
        tip: { type: 'string' },
      },
      required: ['projectPath', 'sessionMode', 'output', 'errors', 'running'],
    },
  },
  {
    name: 'stop_project',
    description:
      'End the current session now and remove the bridge, cutting off a runtime call in progress. A spawned Godot is stopped; an attached one is detached, not killed. Other sessions keep running; none becomes current. Also frees a spawned game that exited by itself (alreadyExited). Returns: projectPath, message, sessionMode, externalProcessPreserved, alreadyExited, exitCode, killUnconfirmed, finalOutput, finalErrors; warnings leads if the kill or cleanup was unconfirmed. Errors if nothing is running.',
    annotations: { destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    outputSchema: {
      type: 'object',
      properties: {
        warnings: { type: 'array', items: { type: 'string' } },
        projectPath: { type: 'string' },
        message: { type: 'string' },
        sessionMode: { type: 'string', enum: ['spawned', 'attached'] },
        externalProcessPreserved: { type: 'boolean' },
        alreadyExited: { type: 'boolean' },
        exitCode: { type: ['number', 'null'] },
        killUnconfirmed: {
          type: 'boolean',
          description:
            'Present and true when the kill was sent and the process did not report its exit in time: it may still be running. warnings names the pid.',
        },
        pid: { type: 'number', description: 'Pid the unconfirmed kill was sent to.' },
        finalOutput: {
          type: ['array', 'null'],
          items: { type: 'string' },
          description:
            'Condensed to the diagnostic lines. Null when no logs are held: an attached session captures nothing, and a record that kept only a finished profiler capture gave its logs to the earlier stop.',
        },
        finalErrors: {
          type: ['array', 'null'],
          items: { type: 'string' },
          description: 'Null in the same cases as finalOutput.',
        },
      },
      required: [
        'projectPath',
        'message',
        'sessionMode',
        'externalProcessPreserved',
        'alreadyExited',
        'finalOutput',
        'finalErrors',
      ],
    },
  },
  {
    name: 'take_screenshot',
    description:
      'Save a PNG of the running viewport under .mcp/godot-runtime/screenshots/ (kept after stop_project). responseMode: preview (default; inline, fits default 960x540, max 1920x1080), full (inline PNG, for small text), path_only (no image). Returns: projectPath, path, size, stats {chromatic, dominant, distinct, likelyBlank} from the full PNG, so a blank frame shows without vision. warnings leads if stats is null or the image is too big to inline. Errors: no session, no frame rendered, bridge timeout.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        timeout: {
          type: 'number',
          description: `Timeout in milliseconds to wait for the screenshot (default: ${SCREENSHOT_DEFAULT_TIMEOUT_MS}). The game gives up on a frame that never renders after ${SCREENSHOT_FRAME_RENDER_BUDGET_MS} ms and reports that; a lower timeout expires first.`,
        },
        responseMode: {
          type: 'string',
          enum: ['full', 'preview', 'path_only'],
          description: `Response payload mode. "preview" returns a bounded inline preview plus paths (default). "full" returns the full inline PNG. "path_only" returns paths only. An image file over ${SCREENSHOT_INLINE_MAX_BYTES / BYTES_PER_MEBIBYTE} MiB, or a full PNG that could not be decoded, is not inlined: the path is returned with a leading warning.`,
        },
        previewMaxWidth: {
          type: 'number',
          description: `Width in pixels of the box the preview is fitted into when responseMode is "preview". Default: ${DEFAULT_PREVIEW_MAX_WIDTH}. Maximum: ${PREVIEW_MAX_WIDTH_LIMIT}; a larger value is clamped to it, not refused. Use responseMode "full" for the screenshot at its own size.`,
        },
        previewMaxHeight: {
          type: 'number',
          description: `Height in pixels of the box the preview is fitted into when responseMode is "preview". Default: ${DEFAULT_PREVIEW_MAX_HEIGHT}. Maximum: ${PREVIEW_MAX_HEIGHT_LIMIT}; a larger value is clamped to it, not refused.`,
        },
      },
      required: [],
    },
    // The handler also emits an inline `image` content block for full/preview modes;
    // outputSchema only describes the structured JSON text payload per MCP spec.
    outputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string' },
        responseMode: { type: 'string' },
        path: { type: 'string' },
        size: {
          type: 'object',
          properties: {
            width: { type: 'number' },
            height: { type: 'number' },
          },
        },
        previewPath: { type: 'string' },
        previewSize: {
          type: 'object',
          properties: {
            width: { type: 'number' },
            height: { type: 'number' },
          },
        },
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
        warnings: { type: 'array', items: { type: 'string' } },
      },
      required: ['projectPath', 'responseMode', 'path', 'stats'],
    },
  },
  {
    name: 'simulate_input',
    description:
      'Send input actions in order; report what each did. Action types: see the `actions` schema. For key, mouse_button, action: omit `pressed` to tap, set it to hold or release. click_element takes a node path or name (see get_ui_elements), not visible text. Returns: projectPath, success, results[] per action: ok, hit, signals, UI `changes`, `watch` samples, handler `errors` (spawned only); warnings leads when `errors` is incomplete. An invalid batch injects nothing; a runtime failure skips the rest.',
    annotations: { destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          description: `Array of input actions to execute sequentially. Each object must have a "type" field. A batch whose time budget (its waits and holds, plus every frame it spends counted at 10fps) exceeds ${MAX_INPUT_BATCH_BUDGET_MS / MS_PER_SECOND}s is rejected before anything is injected: split it across calls. At most 10000 actions per call. When results outgrow one reply (about 4 MiB), later entries keep only index, type, ok, frame, elapsed_ms and error, with details_dropped: true; the action still ran.`,
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: [
                  'key',
                  'mouse_button',
                  'mouse_motion',
                  'click_element',
                  'action',
                  'text',
                  'wait',
                ],
                description: 'The type of input action',
              },
              key: {
                type: 'string',
                description:
                  '[key] Godot KEY_* constant name without the prefix (e.g. "W", "Space", "Escape", "Enter", "Tab", "Up", "PageUp"). Errors on unrecognized names.',
              },
              pressed: {
                type: 'boolean',
                description:
                  '[key, mouse_button, action] Omit to tap: the action presses, holds briefly, and releases by itself. Set true to press and hold across later actions (reported in still_held), false to release an earlier hold. Cannot be combined with hold_ms.',
              },
              hold_ms: {
                type: 'number',
                description: `[key, mouse_button, action] Tap hold duration in milliseconds, overriding the default (one process frame plus one physics frame for key/action, zero gap for mouse_button). Use it for code polling is_action_pressed over real time. Rejected when pressed is also set. Max ${MAX_HOLD_MS}.`,
              },
              shift: { type: 'boolean', description: '[key] Shift modifier' },
              ctrl: { type: 'boolean', description: '[key] Ctrl modifier' },
              alt: { type: 'boolean', description: '[key] Alt modifier' },
              unicode: {
                type: 'number',
                description:
                  '[key] Unicode codepoint for text-entry Controls (LineEdit, TextEdit). Auto-derived for ASCII letters/digits (respecting shift); pass explicitly for symbols or non-ASCII. E.g. 33 for "!", 64 for "@".',
              },
              button: {
                type: 'string',
                enum: ['left', 'right', 'middle'],
                description: '[mouse_button, click_element] Mouse button (default: left)',
              },
              x: {
                type: 'number',
                description:
                  '[mouse_button, mouse_motion] X position in viewport pixels (0,0 = top-left)',
              },
              y: {
                type: 'number',
                description:
                  '[mouse_button, mouse_motion] Y position in viewport pixels (0,0 = top-left)',
              },
              relative_x: {
                type: 'number',
                description: '[mouse_motion] Relative X movement in pixels',
              },
              relative_y: {
                type: 'number',
                description: '[mouse_motion] Relative Y movement in pixels',
              },
              double_click: {
                type: 'boolean',
                description: '[mouse_button, click_element] Double click',
              },
              element: {
                type: 'string',
                description:
                  '[click_element] Identifies the UI element to click. Accepts: absolute node path (e.g. "/root/HUD/Button"), relative node path, or node name (BFS matched). Use get_ui_elements to discover valid names and paths.',
              },
              action: {
                type: 'string',
                description:
                  '[action] Godot input action name (as defined in Project Settings > Input Map)',
              },
              strength: {
                type: 'number',
                description: '[action] Action strength (0 to 1, default 1.0)',
              },
              text: {
                type: 'string',
                description: `[text] String to type into whatever Control currently holds focus, expanded to one key press+release per character. Fails when nothing holds focus - click or focus the LineEdit first. Max ${MAX_TEXT_LENGTH} characters.`,
              },
              ms: {
                type: 'number',
                description: `[wait] Real-time pause in milliseconds, for time-driven things such as cooldowns and animations (~16ms = one frame at 60fps). Exactly one of ms or frames is required. Counts toward the batch's ${MAX_INPUT_BATCH_BUDGET_MS / MS_PER_SECOND}s time budget, and a batch whose total wait approaches 60s may be cut off by your client before the server answers: split it across calls.`,
              },
              frames: {
                type: 'number',
                description: `[wait] Deterministic pause of N engine process frames, for stepping game logic rather than waiting on the clock. Exactly one of ms or frames is required. Max ${MAX_WAIT_FRAMES}, budgeted at a 10fps floor, so a wait of several hundred frames may be cut off by your client before the server answers.`,
              },
            },
            required: ['type'],
          },
        },
        watch: {
          type: 'array',
          items: { type: 'string' },
          maxItems: MAX_WATCH_ENTRIES,
          description:
            'Godot NodePath:property strings sampled after every action and reported per result, e.g. "/root/Main/Player:position". Property subnames are allowed ("/root/Main/Player:position:x"). Read-only; an unresolvable path samples as null instead of failing the batch.',
        },
      },
      required: ['actions'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        warnings: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Present when the per-action errors could not be attributed completely: some may sit on the wrong entry or be missing.',
        },
        projectPath: { type: 'string' },
        success: {
          type: 'boolean',
          description: 'False when an action failed and the remaining actions were skipped.',
        },
        results: {
          type: 'array',
          description: 'One entry per requested action, in order.',
          items: {
            type: 'object',
            properties: {
              index: { type: 'number' },
              type: { type: 'string' },
              ok: { type: 'boolean' },
              skipped: {
                type: 'boolean',
                description: 'Present when an earlier failure ended the batch before this action.',
              },
              frame: { type: 'number', description: 'Process frames elapsed since batch start.' },
              elapsed_ms: { type: 'number', description: 'Milliseconds since batch start.' },
              error: { type: 'string' },
              hit: {
                type: 'string',
                description: 'Path of the Control under the pointer after the action settled.',
              },
              focus: { type: 'string', description: 'Path of the focus owner after the action.' },
              value: { type: 'string', description: 'Resulting text of the focused text Control.' },
              position: {
                type: 'object',
                properties: { x: { type: 'number' }, y: { type: 'number' } },
              },
              pressed: {
                type: 'boolean',
                description: 'Whether the input action is still held after this entry.',
              },
              signals: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Which of pressed, toggled, item_selected, text_submitted the target emitted within the settle frame. A signal emitted later (call_deferred, a tween, a timer) is not observed, so an absent entry means "not within one frame", not "never".',
              },
              errors: { type: 'array', items: { type: 'string' } },
              changes: {
                type: 'object',
                properties: {
                  appeared: { type: 'array', items: { type: 'string' } },
                  disappeared: { type: 'array', items: { type: 'string' } },
                  changed: { type: 'array', items: { type: 'object' } },
                  scene: { type: 'string' },
                  focus: { type: 'string' },
                  truncated: { type: 'number' },
                },
              },
              watch: { type: 'object', additionalProperties: true },
              details_dropped: {
                type: 'boolean',
                description:
                  'Present when the results of the batch outgrew what one reply can carry: this entry keeps only index, type, ok, frame, elapsed_ms and error. The action still ran. Read the state it left with get_ui_elements or take_screenshot.',
              },
            },
            required: ['index', 'type'],
          },
        },
        still_held: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Inputs this batch pressed and did not release, e.g. "key:W", "action:jump".',
        },
      },
      required: ['projectPath', 'success', 'results'],
    },
  },
  {
    name: 'get_ui_elements',
    description:
      'Walk the running scene tree and return all Control nodes with positions, sizes, types, and text content. Always call this before simulate_input click_element actions to discover valid element names and paths. Requires an active runtime session (run_project). visibleOnly defaults true; pass false to include hidden Controls. filter narrows by class. Returns: projectPath and elements[] with path/type/rect/visible plus optional text/disabled/tooltip. Errors if filter is not a Control class name.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        visibleOnly: {
          type: 'boolean',
          description:
            'Only return nodes where Control.visible is true (default: true). Set false to include hidden elements.',
        },
        filter: {
          type: 'string',
          description:
            'Filter by native Control class name (e.g. "Button", "Label", "LineEdit"); subclasses match. A class Control inherits from (CanvasItem, Node) lists every Control. Any other name, including a script class_name, is an error.',
        },
      },
      required: [],
    },
    outputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string' },
        elements: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              path: { type: 'string' },
              type: { type: 'string' },
              rect: {
                type: 'object',
                properties: {
                  x: { type: 'number' },
                  y: { type: 'number' },
                  width: { type: 'number' },
                  height: { type: 'number' },
                },
              },
              visible: { type: 'boolean' },
              text: { type: 'string' },
              placeholder: { type: 'string' },
              disabled: { type: 'boolean' },
              tooltip: { type: 'string' },
            },
          },
        },
        warnings: { type: 'array', items: { type: 'string' } },
        tip: { type: 'string' },
      },
      required: ['projectPath', 'elements', 'tip'],
    },
  },
  {
    name: 'run_script',
    description:
      'Run GDScript in the running game with scene tree access. It must extend RefCounted and define func execute(scene_tree: SceneTree) -> Variant; the return value is JSON-serialized (primitives, Vector2/3, Color, Dictionary, Array, Node paths). print() goes to get_debug_output, not the result. Returns: projectPath, success, result, warnings, tip. Spawned: a stderr runtime error is an error if result is null, else a warning. Attached: errors are unobservable; a null result leads with a warning.',
    annotations: { destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        script: {
          type: 'string',
          description:
            'GDScript source code. Must contain "extends RefCounted" and "func execute(scene_tree: SceneTree) -> Variant".',
        },
        timeout: {
          type: 'number',
          description: `Timeout in ms (default: ${RUN_SCRIPT_DEFAULT_TIMEOUT_MS}). Increase for long-running scripts.`,
        },
      },
      required: ['script'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string' },
        success: { type: 'boolean' },
        result: {},
        warnings: { type: 'array', items: { type: 'string' } },
        tip: { type: 'string' },
      },
      required: ['projectPath', 'success', 'result', 'tip'],
    },
  },
] as const satisfies readonly ToolDefinition[];

// --- Helpers ---

const MAX_RUNTIME_ERROR_CONTEXT_LINES = 30;
const MAX_POLICY_SOLUTIONS = 4;

function formatMoreFindingsSuffix(total: number): string {
  if (total <= 1) return '';
  const extra = total - 1;
  return ` (+${extra} more finding${extra > 1 ? 's' : ''})`;
}

/**
 * Parse a JSON frame returned by the McpBridge. On failure, returns the
 * canonical `Result<T, ToolResponse>` so handlers can short-circuit with
 * `return parsed` on the err branch (the inner `error` is already a structured
 * MCP error response). `context` should describe which bridge command produced
 * the frame.
 *
 * `oversize` is what to tell the caller when the bridge sent its oversize
 * error in place of the reply. It is required, so every handler that reads a
 * bridge reply says what that means for its own command: the command ran, and
 * a handler that took the flat `error` for a refusal would tell the caller to
 * repeat work that already landed.
 */
function parseBridgeJson<T = unknown>(
  responseStr: string,
  context: string,
  oversize: { ran: string; solutions: string[] },
): Result<T, ToolResponse> {
  try {
    const parsed: unknown = JSON.parse(responseStr);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as Record<string, unknown>)[OVERSIZE_RESPONSE_FIELD] === true
    ) {
      const detail = (parsed as { error?: unknown }).error;
      return err(
        createErrorResponse(
          `${oversize.ran} Its result was too large to deliver${typeof detail === 'string' ? `: ${detail}` : '.'}`,
          oversize.solutions,
        ),
      );
    }
    return ok(parsed as T);
  } catch (error) {
    return err(
      createErrorResponse(`Invalid response from bridge (${context}): ${getErrorMessage(error)}`, [
        'The bridge returned non-JSON data - check Godot stderr via get_debug_output',
        'Restart the project with stop_project followed by run_project',
      ]),
    );
  }
}

/**
 * The error for a bridge frame that parsed as JSON and lacks what its command
 * always answers with. The shipped bridge never sends one, so this is the
 * guard against a frame from something else (an older bridge script left in a
 * project, a different listener on the port): reading it as an empty result
 * would report a success for work nobody observed.
 */
function malformedBridgeFrame(context: string, problem: string): ToolResponse {
  return createErrorResponse(`Invalid response from bridge (${context}): ${problem}`, [
    'The bridge answered with a frame this server does not recognize - check Godot stderr via get_debug_output',
    'Restart the project with stop_project followed by run_project',
  ]);
}

/**
 * Bound a list of runtime-error lines for a payload: the first
 * `MAX_RUNTIME_ERROR_CONTEXT_LINES`, then one entry counting what was cut and
 * naming where the rest is. A list at or under the limit comes back whole. The
 * cut is never silent: thirty lines out of a hundred must not read as thirty.
 */
function capRuntimeErrorLines(lines: string[]): string[] {
  const cut = lines.length - MAX_RUNTIME_ERROR_CONTEXT_LINES;
  if (cut <= 0) return lines;
  return [
    ...lines.slice(0, MAX_RUNTIME_ERROR_CONTEXT_LINES),
    `+${cut} more runtime error lines (get_debug_output has the full log)`,
  ];
}

/**
 * Attach captured runtime errors as a `warnings` array on a tool response
 * payload. No-op when there are no runtime errors. Bounded by
 * `capRuntimeErrorLines`.
 */
function attachRuntimeWarnings(target: Record<string, unknown>, runtimeErrors: string[]): void {
  if (runtimeErrors.length > 0) {
    target.warnings = capRuntimeErrorLines(runtimeErrors);
  }
}

/** KEEP IN SYNC with the same solution in `runLaunchGate` (src/utils/launch-gate.ts). */
const ELICITATION_OPT_OUT_SOLUTION =
  'If your client cannot display confirmation prompts, set GODOT_MCP_DISABLE_ELICITATION=true to skip them';

/**
 * Type used for the `decision` field of the audit sidecar. Adds four synthetic
 * values that `PolicyDecision.decision` never carries — `elicit_denied`,
 * `elicit_cancelled`, `elicit_accepted`, and `elicit_bypassed` are derived from
 * the elicitation outcome by the handler. `elicit_cancelled` is a prompt the
 * client dismissed without a choice, which is not a person saying no. `elicit_bypassed` records a Tier 2 finding that ran
 * without a prompt because elicitation was disabled (GODOT_MCP_DISABLE_ELICITATION),
 * distinct from a user-confirmed `elicit_accepted`. Keeping them distinct from
 * `warn` preserves the confirmation event in the audit trail.
 *
 * `not_sent` is a script the policy admitted that never reached the bridge:
 * the session ended or changed, or the call gave up waiting for its turn,
 * between the policy decision and the send, or the send itself failed before
 * its frame was written (the admitted record is then rewritten in place).
 * `admitted_as` then holds what the
 * decision would have been (`ok`, `warn`, `elicit_accepted`,
 * `elicit_bypassed`), so a confirmation a person gave is still on record.
 */
type AdmittedAuditDecision = 'elicit_accepted' | 'elicit_bypassed' | 'warn' | 'ok';
type AuditDecision =
  | 'hard_block'
  | 'elicit_denied'
  | 'elicit_cancelled'
  | 'not_sent'
  | AdmittedAuditDecision;

interface AuditSidecar {
  decision: AuditDecision;
  /** Present only with `decision: 'not_sent'`. */
  admitted_as?: AdmittedAuditDecision;
  tier: 1 | 2 | 3 | null;
  strict_mode: boolean;
  promoted_by_strict: boolean;
  findings: Array<{
    rule: string;
    line: number;
    column: number;
    matched_text: string;
  }>;
  timestamp: string;
}

/**
 * Write the audit pair (.gd + .policy.json) to `.mcp/godot-runtime/scripts/`.
 * The directory persists across sessions — session cleanup removes `bridge/`
 * only, so the audit trail survives `stop_project`. Both writes
 * are best-effort — failures are logged via `logDebug` and never propagate,
 * matching the pre-existing `run_script` audit contract.
 */
function writeAuditSidecar(
  projectPath: string,
  script: string,
  decision: AuditDecision,
  policy: PolicyDecision,
  strictMode: boolean,
  admittedAs?: AdmittedAuditDecision,
  /** Overwrite this sidecar (and keep its script file) instead of writing a new pair. */
  rewriteSidecarFile?: string,
): string | null {
  try {
    const projectRoot = resolve(projectPath);
    const scriptsDir = resolve(auditScriptsDir(projectRoot));
    if (!isUnderDir(projectRoot, scriptsDir)) {
      logDebug(
        `Sidecar write skipped: resolved script dir ${scriptsDir} escapes projectRoot ${projectRoot}`,
      );
      return null;
    }
    mkdirSync(scriptsDir, { recursive: true });
    const baseName = `${Date.now()}-${randomUUID()}`;
    const scriptFile = join(scriptsDir, `${baseName}.gd`);
    if (rewriteSidecarFile === undefined) writeFileSync(scriptFile, script, 'utf8');

    const sidecar: AuditSidecar = {
      decision,
      ...(admittedAs !== undefined ? { admitted_as: admittedAs } : {}),
      tier: policy.effectiveTier,
      strict_mode: strictMode,
      promoted_by_strict: policy.promotedByStrict,
      findings: policy.matches.map((m) => ({
        rule: m.ruleId,
        line: m.line,
        column: m.column,
        matched_text: m.matchedText,
      })),
      timestamp: new Date().toISOString(),
    };
    const sidecarFile = rewriteSidecarFile ?? join(scriptsDir, `${baseName}.policy.json`);
    writeFileSync(sidecarFile, JSON.stringify(sidecar, null, 2), 'utf8');
    logDebug(`Saved script + policy sidecar to ${sidecarFile}`);
    return sidecarFile;
  } catch (error) {
    logDebug(`Failed to write audit sidecar: ${error}`);
    return null;
  }
}

/**
 * Build the agent-facing message for a Tier 1 block. Names the first match
 * + a `+N more` suffix when applicable. The message is intentionally short
 * and self-contained — it stands alone in the error response.
 */
function formatBlockMessage(matches: readonly PolicyMatch[]): string {
  if (matches.length === 0) return 'Blocked by run_script security policy.';
  const head = summarizeMatch(matches[0]!);
  return `Blocked: ${head}.${formatMoreFindingsSuffix(matches.length)} The script was not executed.`;
}

function collectSolutions(matches: readonly PolicyMatch[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    for (const sol of m.solutions) {
      if (!seen.has(sol)) {
        seen.add(sol);
        out.push(sol);
      }
    }
    if (out.length >= MAX_POLICY_SOLUTIONS) break;
  }
  return out;
}

const SESSION_ENDED_AT_READY_MESSAGE =
  'The session ended as the bridge became ready; no session is running.';
/** Trailing stderr lines quoted in a run_project error about a game that did not stay up. */
const RECENT_STDERR_LINES_IN_ERROR = 20;

const EDITOR_LAUNCH_MESSAGE =
  'Godot editor launched. It is a GUI application and cannot be controlled programmatically: use the headless scene and node tools (add_node, set_node_properties, etc.) to change the project.';

/**
 * Build the `run_project` success payload. `warnings` is the first key and is
 * omitted when empty. `bridgePort` is the port of a session that exists: a
 * caller that found none after the readiness check returns an error instead
 * of reaching here (see `SESSION_ENDED_AT_READY_MESSAGE`).
 */
function buildRunProjectResponse(session: {
  projectPath: string;
  sessionMode: RuntimeSessionMode;
  bridgePort: number;
  warnings: readonly string[];
  message: string;
}): HandlerResult {
  const warnings = [...session.warnings];
  return createStructuredResponse({
    ...(warnings.length > 0 ? { warnings } : {}),
    projectPath: resolve(session.projectPath),
    sessionMode: session.sessionMode,
    bridgePort: session.bridgePort,
    message: session.message,
  });
}

const REPLACED_ATTACHED_NOTE =
  "This server's attached session on the project was detached first; the Godot process launched outside MCP is still running and is no longer controlled.";

/**
 * How a spawned start words the attached session it replaced, for each place
 * an outcome is reported. Everything is empty when nothing was replaced. An
 * unacknowledged shutdown is reported the way stop_project reports it: the
 * replaced session's bridge is still listening.
 */
function describeReplacedAttached(replaced: ReplacedAttachedSession | null): {
  warnings: string[];
  messageNote: string;
  errorLine: string;
} {
  if (replaced === null) return { warnings: [], messageNote: '', errorLine: '' };
  const warnings = replaced.shutdownAcknowledged
    ? []
    : [
        `${SHUTDOWN_UNACKNOWLEDGED_WARNING} It was this server's attached session on this project (bridge port ${replaced.bridgePort ?? 'unknown'}), replaced by this spawned one.`,
      ];
  return {
    warnings,
    messageNote: ` ${REPLACED_ATTACHED_NOTE}`,
    errorLine: `\n${[REPLACED_ATTACHED_NOTE, ...warnings].join(' ')}`,
  };
}

/**
 * Read and range-check the optional `bridgePort` argument. The one place the
 * port range is enforced for both session modes.
 */
function parseBridgePortArg(args: OperationParams): Result<number | undefined, ToolResponse> {
  const bridgePort = optionalNumber(args, 'bridgePort');
  if (!bridgePort.ok) return bridgePort;
  if (
    bridgePort.value !== undefined &&
    (!Number.isInteger(bridgePort.value) ||
      bridgePort.value < BRIDGE_PORT_MIN ||
      bridgePort.value > BRIDGE_PORT_MAX)
  ) {
    return err(
      createErrorResponse(
        `Invalid bridgePort: must be an integer in [${BRIDGE_PORT_MIN}, ${BRIDGE_PORT_MAX}] (got: ${String(bridgePort.value)})`,
        ['Omit bridgePort to auto-select a free port', 'Pass a valid TCP port number'],
      ),
    );
  }
  return bridgePort;
}

/**
 * Refuse a spawn-only parameter combined with `attach: true`. `scene` is
 * refused whenever present. `background` and `profiling` are refused only when
 * true: false is their default and is exactly what attach mode does, so
 * nothing is being ignored. A wrong type still fails as a type error.
 */
function rejectSpawnOnlyParams(args: OperationParams): ToolResponse | null {
  const scene = optionalString(args, 'scene');
  if (!scene.ok) return scene.error;
  const background = optionalBoolean(args, 'background');
  if (!background.ok) return background.error;
  const profiling = optionalBoolean(args, 'profiling');
  if (!profiling.ok) return profiling.error;

  const requested: Record<(typeof SPAWN_ONLY_RUN_PROJECT_PARAMS)[number], boolean> = {
    scene: scene.value !== undefined,
    background: background.value === true,
    profiling: profiling.value === true,
  };
  for (const param of SPAWN_ONLY_RUN_PROJECT_PARAMS) {
    if (requested[param]) {
      return createErrorResponse(
        `"${param}" applies only to a spawned session and cannot be combined with attach: true.`,
        [
          `Remove ${param} to attach to a Godot process you launch yourself`,
          'Remove attach to let run_project spawn Godot',
        ],
      );
    }
  }
  return null;
}

// --- Handlers ---

export async function handleLaunchEditor(
  runner: GodotRunner,
  args: OperationParams,
): Promise<HandlerResult> {
  args = normalizeParameters(args);

  const parsed = parseProjectArgs(args);
  if (!parsed.ok) return parsed;

  try {
    if (!runner.getGodotPath()) {
      await runner.detectGodotPath();
      if (!runner.getGodotPath()) {
        return err(
          createErrorResponse('Could not find a valid Godot executable path', [
            'Ensure Godot is installed correctly',
            'Set GODOT_PATH environment variable',
          ]),
        );
      }
    }

    logDebug(`Launching Godot editor for project: ${parsed.value.projectPath}`);
    const process = runner.launchEditor(parsed.value.projectPath);

    process.on('error', (spawnErr: Error) => {
      console.error('Failed to start Godot editor:', spawnErr);
    });

    // The pid is the only thing the spawn reports synchronously. A spawn that
    // fails (bad executable path) leaves it undefined and raises 'error' later,
    // so no pid means nothing was launched: an error, never a launch message.
    if (typeof process.pid !== 'number') {
      return err(
        createErrorResponse('The Godot editor process did not start (the spawn reported no pid).', [
          'Check that GODOT_PATH points at a Godot 4.x executable, not its installation folder',
          'Check that the file is executable and matches this machine (permissions, architecture)',
        ]),
      );
    }
    return createStructuredResponse({
      projectPath: resolve(parsed.value.projectPath),
      pid: process.pid,
      message: EDITOR_LAUNCH_MESSAGE,
    });
  } catch (error: unknown) {
    return err(
      createErrorResponse(`Failed to launch Godot editor: ${getErrorMessage(error)}`, [
        'Ensure Godot is installed correctly',
        'Check if the GODOT_PATH environment variable is set correctly',
      ]),
    );
  }
}

export async function handleRunProject(
  runner: GodotRunner,
  args: OperationParams,
  ctx: McpContext = createNullContext(),
): Promise<HandlerResult> {
  args = normalizeParameters(args);

  const parsed = parseProjectArgs(args);
  if (!parsed.ok) return parsed;
  const { projectPath } = parsed.value;

  const attach = optionalBoolean(args, 'attach');
  if (!attach.ok) return attach;

  return attach.value === true
    ? startAttachedSession(runner, projectPath, args, ctx)
    : startSpawnedSession(runner, projectPath, args, ctx);
}

/**
 * The spawn path of run_project: launch gate with the session confirmation,
 * spawn Godot, wait for the bridge. `args` is already normalized and
 * `projectPath` already validated.
 */
async function startSpawnedSession(
  runner: GodotRunner,
  projectPath: string,
  args: OperationParams,
  ctx: McpContext,
): Promise<HandlerResult> {
  const scene = optionalString(args, 'scene');
  if (!scene.ok) return scene;

  let resolvedScene: ResolvedProjectPath | undefined;
  if (scene.value !== undefined) {
    const resolved = resolveProjectPath(projectPath, scene.value, 'read');
    if (!resolved) {
      return err(
        createErrorResponse(projectSubPathError('scene path', scene.value), [
          ...PROJECT_SUB_PATH_SOLUTIONS,
        ]),
      );
    }
    const notAScene = rejectNonSceneLaunchArg(resolved.relPath);
    if (notAScene) return err(notAScene);
    resolvedScene = resolved;
  }

  // Every argument is read before the gate (see below).
  const bridgePort = parseBridgePortArg(args);
  if (!bridgePort.ok) return bridgePort;

  const background = optionalBoolean(args, 'background');
  if (!background.ok) return background;
  const isBackground = background.value === true;

  const profiling = optionalBoolean(args, 'profiling');
  if (!profiling.ok) return profiling;
  const isProfiling = profiling.value === true;

  // Everything that can already say no comes before the gate, which asks a
  // human to confirm: a launch that cannot happen must never ask, and must not
  // record the project as confirmed.
  if (!runner.getGodotPath()) {
    await runner.detectGodotPath();
    if (!runner.getGodotPath()) {
      return err(
        createErrorResponse('Could not find a valid Godot executable path', [
          'Set GODOT_PATH in your MCP client config to your Godot 4.x executable',
          'Ensure the path points at the Godot binary, not its installation folder',
          'On Windows, escape backslashes in JSON (e.g. "D:\\\\Godot\\\\Godot.exe")',
        ]),
      );
    }
  }

  if (!checkDisplayAvailable()) {
    return err(
      createErrorResponse(
        'Failed to run Godot project: No display server available (DISPLAY and WAYLAND_DISPLAY are both unset). Godot requires a display to run a project window.',
        [
          'Use run_project with attach: true and launch Godot yourself',
          'Set DISPLAY or WAYLAND_DISPLAY environment variables',
          'Run from a graphical shell session',
        ],
      ),
    );
  }

  const gate = await runLaunchGate(
    {
      projectPath,
      scene: resolvedScene,
      confirm: true,
      launchedByServer: true,
      toolName: 'run_project',
    },
    ctx,
  );
  if (!gate.ok) return gate;
  const { warnings } = gate.value;

  // The start, the wait for its bridge and the teardown of a start that did
  // not come up are one operation: no other runtime call runs in between, and
  // every step acts on the record this start created (`started`), never on
  // whichever session is current by then. The launch gate above stays
  // outside: a confirmation prompt can be held open for minutes.
  return runSessionExclusive(runner, 'run_project', () =>
    launchSpawnedSession(runner, projectPath, warnings, {
      scene: resolvedScene,
      background: isBackground,
      bridgePort: bridgePort.value,
      profiling: isProfiling,
    }),
  );
}

async function launchSpawnedSession(
  runner: GodotRunner,
  projectPath: string,
  warnings: readonly string[],
  opts: {
    scene: ResolvedProjectPath | undefined;
    background: boolean;
    bridgePort: number | undefined;
    profiling: boolean;
  },
): Promise<HandlerResult> {
  const isBackground = opts.background;
  const isProfiling = opts.profiling;
  try {
    const started = await runner.runProject(
      projectPath,
      opts.scene,
      isBackground,
      opts.bridgePort,
      isProfiling,
    );

    // Read off the started record, and before the wait: every outcome below
    // has to say what happened to the session this start replaced, the
    // failures included.
    const atStart = runner.describeSessionRef(started);
    const replaced = describeReplacedAttached(atStart.replacedAttached ?? null);
    const startWarnings = atStart.startWarnings ?? [];
    const startWarningsLine = startWarnings.length > 0 ? `\n${startWarnings.join(' ')}` : '';

    const bridgeResult = await runner.waitForBridge(undefined, undefined, started);
    // The record as the wait left it: a game that exited meanwhile has
    // cleared its own mode and port.
    const session = runner.describeSessionRef(started);

    if (bridgeResult.stopped === true) {
      return err(startCutOffByStop(projectPath, 'run_project'));
    }
    if (!bridgeResult.ready) {
      if (session.processExited) {
        // A process that exited by itself has already cleared its own session
        // (mode, port, token, bridge artifacts) and kept its logs, and
        // runProject replaces such a record on a retry. Stopping it here would
        // only throw those logs away. A session that still has a mode is the
        // other case: the process never started (a spawn 'error'), nothing
        // cleared it, and the stop is what removes the injected bridge.
        const logsRetained = session.mode === null;
        if (!logsRetained) await runner.stopSessionRef(started);
        return err(
          createErrorResponse(
            `Godot process exited before the MCP bridge could initialize.\n${bridgeResult.error || ''}${replaced.errorLine}${startWarningsLine}`,
            [
              logsRetained
                ? 'Call get_debug_output for the full captured output of the exited process: it is kept until the next run_project or stop_project'
                : 'The stderr quoted above is everything that was captured: the session was torn down, so get_debug_output has nothing more',
              'Verify a display server is available (Wayland/X11)',
              'Check for broken autoloads with list_autoloads',
              'Retry run_project once the underlying issue is resolved',
            ],
          ),
        );
      }

      // Read the log tail and the port before the teardown: the stop
      // releases both.
      const recentErrors = runner.recentErrorsFor(started, RECENT_STDERR_LINES_IN_ERROR);
      const errorTail = recentErrors.length > 0 ? `\nLast stderr:\n${recentErrors.join('\n')}` : '';
      const bridgeRegistered = runner.isBridgeAutoloadRegistered(projectPath);
      const assignedPort = session.bridgePort;
      // Tear down before returning so the project has no session and the next
      // run_project starts clean. The stop reports what it observed.
      const stopped = await runner.stopSessionRef(started);
      const lines = [
        `Godot process started, but the MCP bridge did not respond within ${Math.round((bridgeResult.waitedMs ?? BRIDGE_WAIT_SPAWNED_TIMEOUT_MS) / MS_PER_SECOND)} seconds.`,
        // Surface the precise poll failure (token/path mismatch, abort reason)
        // instead of burying it behind the generic timeout narrative.
        ...(bridgeResult.error ? [`- Actual reason: ${bridgeResult.error}`] : []),
        bridgeRegistered
          ? '- The bridge listener never came up - likely an early _ready error or a stuck process holding the port'
          : '- project.godot has no McpBridge autoload entry, so the game started without the bridge (something removed it after inject - another tool, a git checkout, or an older server version sharing this project)',
        stopped?.killUnconfirmed === true
          ? `- ${killUnconfirmedWarning(stopped.pid)}`
          : '- Session has been torn down; retry run_project to start a new one',
        errorTail,
      ];
      if (isBackground) {
        lines.push(`- ${BACKGROUND_MODE_NOTE}`);
      }
      const solutions = [
        'Check for broken autoloads with list_autoloads',
        `Check that the assigned bridge port (${assignedPort}) is not occupied by another Godot process`,
        'Retry run_project',
      ];
      return err(
        createErrorResponse(lines.join('\n') + replaced.errorLine + startWarningsLine, solutions),
      );
    }

    // Read after readiness, not assumed from it: a game that exits in between
    // clears its port, and a session with no port is no session. Reporting
    // that as a start with `bridgePort: null` would be a success for nothing.
    const readyPort = session.bridgePort;
    if (readyPort === null) {
      // Read the log tail before the teardown: the stop releases it.
      const lastErrors = runner.recentErrorsFor(started, RECENT_STDERR_LINES_IN_ERROR);
      const errorTail = lastErrors.length > 0 ? `\nLast stderr:\n${lastErrors.join('\n')}` : '';
      await runner.stopSessionRef(started);
      return err(
        createErrorResponse(
          `${SESSION_ENDED_AT_READY_MESSAGE}${errorTail}${replaced.errorLine}${startWarningsLine}`,
          [
            'Retry run_project',
            'If the game keeps exiting right after it starts, check its startup scripts and autoloads (list_autoloads)',
          ],
        ),
      );
    }

    let message = 'Godot project started and the MCP bridge is ready.';
    if (isBackground) {
      message += ` ${BACKGROUND_MODE_NOTE}.`;
    }
    if (isProfiling) {
      message += ' Profiling enabled: use profile_project or start_profiler.';
    }
    message += replaced.messageNote;
    // Null this early is not a clean bill: the engine may have sent nothing
    // yet. The profiler tools report the same problem once it shows.
    const streamProblem = isProfiling ? runner.profilerStreamProblemFor(started) : null;
    return buildRunProjectResponse({
      projectPath,
      sessionMode: 'spawned',
      bridgePort: readyPort,
      warnings: [
        ...(streamProblem !== null ? [streamProblem] : []),
        ...startWarnings,
        ...replaced.warnings,
        ...warnings,
      ],
      message,
    });
  } catch (error: unknown) {
    const errorMessage = getErrorMessage(error);
    if (error instanceof BridgeAutoloadCollisionError) {
      return err(
        createErrorResponse(`Failed to run Godot project: ${errorMessage}`, [
          'Rename the existing McpBridge autoload in project.godot, then retry run_project',
          'Use list_autoloads to see what the project currently registers',
        ]),
      );
    }
    if (error instanceof StartBudgetExhaustedError) return err(startBudgetExhausted(error));
    if (error instanceof BridgeRegistryUnreadableError) {
      // Nothing was launched: which sessions own the shared bridge is unknown,
      // so the bridge was not injected.
      return err(
        createErrorResponse(`Failed to run Godot project: ${errorMessage}`, [
          'Retry run_project: a registry file that another session was writing at that moment is readable again a moment later',
          'If it keeps failing, check the permissions on .mcp/godot-runtime/bridge/owners/ in the project',
        ]),
      );
    }
    if (errorMessage.includes('No display server available')) {
      return err(
        createErrorResponse(`Failed to run Godot project: ${errorMessage}`, [
          'Use run_project with attach: true and launch Godot yourself',
          'Set DISPLAY or WAYLAND_DISPLAY environment variables',
          'Run from a graphical shell session',
        ]),
      );
    }
    return err(
      createErrorResponse(`Failed to run Godot project: ${errorMessage}`, [
        'Nothing was launched. If the message names project.godot or the .mcp folder, check that the project directory is writable',
        'Ensure Godot is installed correctly',
        'Check if the GODOT_PATH environment variable is set correctly',
      ]),
    );
  }
}

/** The error for a start whose session a stop ended while its bridge was awaited. */
function startCutOffByStop(projectPath: string, retryWhat: string): ToolResponse {
  return createErrorResponse(
    `The session on ${projectPath} was stopped while it was starting (stop_project, or the server shutting down), so this start was abandoned.`,
    [
      'Nothing is left running for this start and its bridge was removed from the project: no stop_project is needed',
      `Call ${retryWhat} again to start a new session`,
    ],
  );
}

/** The error for a start that got its turn with too little time left to wait for the bridge. */
function startBudgetExhausted(error: StartBudgetExhaustedError): ToolResponse {
  return createErrorResponse(error.message, [
    error.behind !== null
      ? `Retry once ${error.behind} has returned`
      : 'Retry: nothing was stopped or launched',
    'A runtime session runs one operation at a time: issue runtime calls one after another, not in parallel',
  ]);
}

/**
 * How run_project reports an attached session it kept, by what the session's
 * bridge did with the probe ping. Only a bridge seen to be gone is replaced.
 */
function keptAttachedSessionWording(probe: AttachedProbeOutcome): {
  warning: string;
  message: string;
} {
  const kept = 'the existing session was kept and made current; nothing was injected again.';
  if (probe === 'silent') {
    return {
      warning: `This server was already attached to this project. Its bridge did not answer a ping within ${BRIDGE_PING_TIMEOUT_MS} ms, which a busy game (loading, a long frame) also does, so ${kept} If the next runtime call fails as well, the game is stuck or gone.`,
      message:
        'Already attached to the project; the MCP bridge did not answer the probe in time and was left as it is.',
    };
  }
  if (probe === 'unexpected-reply') {
    return {
      warning: `This server was already attached to this project. Something answered on its bridge port, but not with a pong for this session, so ${kept} If runtime calls keep failing, another process holds the port: stop_project, then attach again.`,
      message:
        'Already attached to the project; its bridge port answered the probe with something other than a pong.',
    };
  }
  return {
    warning: `This server was already attached to this project and its bridge answered, so ${kept}`,
    message: 'Already attached to the project and the MCP bridge is answering.',
  };
}

/**
 * The attach path of run_project: inject the bridge and wait for a Godot
 * process the caller launches. Nothing is spawned, so there is no Godot
 * executable to resolve and no launch to confirm; the pre-flight scan still
 * runs, because the scanned scripts are about to execute with the bridge
 * attached. `args` is already normalized and `projectPath` already validated.
 */
async function startAttachedSession(
  runner: GodotRunner,
  projectPath: string,
  args: OperationParams,
  ctx: McpContext,
): Promise<HandlerResult> {
  const spawnOnlyRefusal = rejectSpawnOnlyParams(args);
  if (spawnOnlyRefusal) return err(spawnOnlyRefusal);

  const bridgePort = parseBridgePortArg(args);
  if (!bridgePort.ok) return bridgePort;

  const gate = await runLaunchGate(
    {
      projectPath,
      scene: undefined,
      confirm: false,
      launchedByServer: false,
      toolName: 'run_project',
    },
    ctx,
  );
  if (!gate.ok) return gate;
  const { warnings } = gate.value;

  // One operation, like the spawned start: the attach, the wait and the
  // teardown of an attach that did not come up, all on the record `attached`
  // names.
  return runSessionExclusive(runner, 'run_project', () =>
    attachSession(runner, projectPath, warnings, bridgePort.value),
  );
}

async function attachSession(
  runner: GodotRunner,
  projectPath: string,
  warnings: readonly string[],
  requestedPort: number | undefined,
): Promise<HandlerResult> {
  try {
    const attached = await runner.attachProject(projectPath, requestedPort);
    const started = attached.session;

    if (attached.alreadyAttached) {
      // This server already holds a live attached session here and its
      // bridge was not seen to be gone. Nothing was injected: a new token and
      // port would never reach the Godot that is already running.
      const existing = runner.describeSessionRef(started);
      if (existing.bridgePort !== null) {
        const portNote =
          requestedPort !== undefined && requestedPort !== existing.bridgePort
            ? ` The requested bridgePort ${requestedPort} was not applied: the running Godot listens on ${existing.bridgePort}.`
            : '';
        const kept = keptAttachedSessionWording(attached.existingBridge ?? 'answered');
        return buildRunProjectResponse({
          projectPath,
          sessionMode: 'attached',
          bridgePort: existing.bridgePort,
          warnings: [
            `${kept.warning}${portNote} To attach afresh, call stop_project first, then run_project with attach: true, and restart Godot while that call waits.`,
            ...warnings,
          ],
          message: `${kept.message} stdout/stderr are not captured in attach mode; stop_project detaches without stopping Godot.`,
        });
      }
    }

    const bridgeResult = await runner.waitForBridgeAttached(undefined, undefined, started);
    const session = runner.describeSessionRef(started);

    if (bridgeResult.stopped === true) {
      return err(startCutOffByStop(projectPath, 'run_project with attach: true'));
    }
    if (!bridgeResult.ready) {
      const bridgeRegistered = runner.isBridgeAutoloadRegistered(projectPath);
      // Read the port before the teardown: the stop clears it.
      const assignedPort = session.bridgePort;
      // Tear down the attached-mode session state so a retry of run_project
      // works without an intervening stop_project.
      await runner.stopSessionRef(started);
      // What is true after this failure: the teardown above removed the bridge
      // script and the autoload entry, and every attach bakes a new token (and
      // a new port unless bridgePort is given). A Godot that started during
      // this wait therefore holds values no retry will accept.
      const solutions = [
        'Retry run_project with attach: true and launch Godot while that call is waiting (in parallel, or right after issuing it), so Godot reads the freshly injected autoload at startup',
        'A Godot process started before or during this failed attempt cannot be attached to: this attempt removed its bridge, and a retry injects a new token. Close it, or restart it once the retry is waiting',
        'Passing the same bridgePort on the retry does not help, because the token changes with every attach',
        `Check that no other process is occupying the assigned bridge port (${assignedPort})`,
      ];
      const registeredLine = bridgeRegistered
        ? ''
        : '\nproject.godot has no McpBridge autoload entry, so the game started without the bridge (something removed it after inject - another tool, a git checkout, or an older server version sharing this project).';
      return err(
        createErrorResponse(
          `Project attached but the MCP bridge is not ready.\n${bridgeResult.error || ''}${registeredLine}`,
          solutions,
        ),
      );
    }

    // Same read as the spawned path: an attached session whose bridge went
    // away as it became ready has been cleared and has no port.
    const readyPort = session.bridgePort;
    if (readyPort === null) {
      await runner.stopSessionRef(started);
      return err(
        createErrorResponse(SESSION_ENDED_AT_READY_MESSAGE, [
          'Retry run_project with attach: true and launch Godot while that call is waiting: the bridge was removed, so a Godot already running cannot be attached to',
          'If Godot closed right after it started, check its own output for the reason',
        ]),
      );
    }

    return buildRunProjectResponse({
      projectPath,
      sessionMode: 'attached',
      bridgePort: readyPort,
      warnings,
      message:
        'Attached to the project and the MCP bridge is ready. stdout/stderr are not captured in attach mode; stop_project detaches without stopping Godot.',
    });
  } catch (error: unknown) {
    if (error instanceof StartBudgetExhaustedError) return err(startBudgetExhausted(error));
    if (error instanceof BridgeAttachConflictError) {
      return err(
        createErrorResponse(`Failed to attach project: ${error.message}`, [
          `Stop the other session first (server pid ${error.conflictingOwner.pid}; stop_project there), then retry run_project with attach: true`,
          'Only one attach session per project is supported',
          ...(error.foreignHostSolution !== undefined ? [error.foreignHostSolution] : []),
        ]),
      );
    }
    const solutions =
      error instanceof BridgeAutoloadCollisionError
        ? [
            'Rename the existing McpBridge autoload in project.godot, then retry run_project with attach: true',
            'Use list_autoloads to see what the project currently registers',
          ]
        : error instanceof BridgeRegistryUnreadableError
          ? [
              'Retry run_project with attach: true: a registry file that another session was writing at that moment is readable again a moment later',
              'If it keeps failing, check the permissions on .mcp/godot-runtime/bridge/owners/ in the project',
            ]
          : [
              'Nothing was attached and any session this server had on the project is as it was, unless the message says otherwise',
              'Check if project.godot is accessible',
              'Ensure MCP can write the bridge autoload into the project',
            ];
    return err(
      createErrorResponse(`Failed to attach project: ${getErrorMessage(error)}`, solutions),
    );
  }
}

/** One ping after a switch: a fresh TCP connect plus one engine frame. Far below the 60 s client ceiling. */
const SWITCH_PROBE_TIMEOUT_MS = 3000;

export async function handleSwitchProject(
  runner: GodotRunner,
  args: OperationParams,
): Promise<HandlerResult> {
  args = normalizeParameters(args);
  const parsed = parseProjectArgs(args);
  if (!parsed.ok) return parsed;
  const target = resolve(parsed.value.projectPath);

  // The pointer move and the probe that follows it are one operation: moving
  // the pointer closes the bridge socket, which must not happen under a
  // command another call has in flight.
  return runSessionExclusive(runner, 'switch_project', () => switchToSession(runner, target));
}

async function switchToSession(runner: GodotRunner, target: string): Promise<HandlerResult> {
  const previousProjectPath = runner.getCurrentSessionInfo()?.projectPath ?? null;
  const session = runner.switchSession(target);
  if (session === null) {
    const live = runner.listLiveSessions().map((info) => info.projectPath);
    const liveClause =
      live.length > 0 ? ` Live sessions: ${live.join(', ')}.` : ' No session is live.';
    return err(
      createErrorResponse(
        `No runtime session on ${target}: this server has not started one there, or it was stopped.${liveClause}`,
        live.length > 0
          ? [
              'Pass one of the listed project paths to switch_project',
              'Or call run_project on this project to start a session, which becomes the current one',
            ]
          : ['Call run_project on this project to start a session, which becomes the current one'],
      ),
    );
  }

  const warnings: string[] = [];
  let bridgeResponsive: boolean | null = null;
  if (session.live) {
    try {
      const { response } = await runner.sendCommandWithErrors('ping', {}, SWITCH_PROBE_TIMEOUT_MS);
      bridgeResponsive = (JSON.parse(response) as { status?: string }).status === 'pong';
      if (!bridgeResponsive) {
        warnings.push(
          'The session answered the probe with an unexpected payload, so its bridge may not be usable.',
        );
      }
    } catch (error: unknown) {
      bridgeResponsive = false;
      warnings.push(
        `The session did not answer a ping after the switch: ${getErrorMessage(error)}. It is still the current session; if its game was closed, the next runtime call reports that.`,
      );
    }
  } else if (session.processExited) {
    warnings.push(
      `This session is not live: its Godot process exited with code ${session.exitCode ?? 'unknown'}. get_debug_output reads its captured logs and stop_project frees it; the other runtime tools will error.`,
    );
  } else {
    warnings.push(
      'This session is not live: only a finished profiler capture is retained. stop_profiler can still read it and stop_project frees it.',
    );
  }

  const message =
    previousProjectPath === session.projectPath
      ? `${session.projectPath} was already the current session.`
      : session.live
        ? `Runtime tools now act on ${session.projectPath}.`
        : `Selected ${session.projectPath}; its session is not live.`;

  return createStructuredResponse({
    ...(warnings.length > 0 ? { warnings } : {}),
    projectPath: session.projectPath,
    previousProjectPath,
    live: session.live,
    sessionMode: session.mode,
    bridgePort: session.bridgePort,
    bridgeResponsive,
    ...(session.processExited ? { exitCode: session.exitCode } : {}),
    message,
  });
}

/**
 * The warning that leads a payload whose log fields are null because the
 * session is attached. Names the two fields the caller is looking at.
 */
function attachedNothingCapturedWarning(outputField: string, errorsField: string): string {
  return `An attached session captures no stdout or stderr (Godot was launched outside MCP), so ${outputField} and ${errorsField} are null, not empty.`;
}

export function handleGetDebugOutput(
  runner: GodotRunner,
  args: OperationParams = {},
): HandlerResult {
  args = normalizeParameters(args);

  // The mode is nulled the moment a spawned process exits, but its logs
  // live on the retained process and are exactly what the caller is here
  // for. Gate on the current record, not on a live session.
  const status = runner.getRuntimeSessionStatus();
  const current = status.current;
  if (current === null || (current.mode === null && !current.hasRetainedLogs)) {
    return err(
      noLiveCurrentSessionError(status, {
        action: 'read debug output',
        noneMessage: 'No active runtime session.',
        noneSolutions: [
          'Use run_project to start a Godot project first',
          'Or pass attach: true to run_project before launching Godot yourself',
        ],
        exitedSolutions: [],
      }),
    );
  }

  if (current.mode === 'attached') {
    // Nothing was captured, which is not the same as nothing was printed. An
    // empty `errors` list would read as "no errors", so both are null and the
    // reason leads.
    return createStructuredResponse({
      warnings: [attachedNothingCapturedWarning('output', 'errors')],
      projectPath: current.projectPath,
      sessionMode: 'attached',
      output: null,
      errors: null,
      running: null,
    });
  }

  const proc = runner.activeProcess;
  if (!proc) {
    return err(
      createErrorResponse('No active spawned process is available for debug output.', [
        'Use run_project to start a Godot project first',
        'Attach mode (run_project with attach: true) does not capture stdout/stderr',
      ]),
    );
  }

  const limitResult = optionalNumber(args, 'limit');
  if (!limitResult.ok) return limitResult;
  const limit = limitResult.value ?? 200;
  const response: {
    projectPath: string;
    sessionMode: 'spawned';
    output: string[];
    errors: string[];
    running: boolean;
    exitCode?: number | null;
    tip?: string;
  } = {
    projectPath: current.projectPath,
    // Only a spawned session has a process, so logs read from one are a spawned
    // session's logs even after the exit cleared the session's mode.
    sessionMode: 'spawned',
    output: proc.output.slice(-limit),
    errors: proc.errors.slice(-limit),
    running: !proc.hasExited,
  };

  if (proc.hasExited) {
    response.exitCode = proc.exitCode;
    response.tip =
      'Process has exited. These logs are kept until stop_project, which frees the process slot, or until run_project starts this project again.';
  }
  // A visual profiling capture of a heavy scene floods stderr with an engine
  // error. Read cold, it looks like a game bug; say what it is where it shows.
  const overflow = TIMESTAMP_OVERFLOW_ERRORS.find((error) =>
    response.errors.some((line) => line.includes(error)),
  );
  if (overflow !== undefined) {
    const advice = `The "${overflow}" errors come from a profiler capture with visual: true, not from the game: frames needed more render timestamps than the per-frame limit, so they lost render stages and ran slower while the engine logged every lost one. The flood can push earlier lines out of this log, so a game error from before it may be missing here. ${TIMESTAMP_OVERFLOW_FIX}`;
    response.tip = response.tip === undefined ? advice : `${response.tip} ${advice}`;
  }

  return createStructuredResponse(response);
}

export function handleStopProject(runner: GodotRunner): Promise<HandlerResult> {
  // Not queued: a stop cuts off whatever runtime call is running on the
  // session (an input batch, a script, a start waiting for its bridge), which
  // then fails saying the session was stopped. Waiting for it instead would
  // leave a wedged game unstoppable for as long as that call's own timeout.
  return stopCurrentSession(runner);
}

async function stopCurrentSession(runner: GodotRunner): Promise<HandlerResult> {
  const result = await runner.stopProject();

  if (!result) {
    const others = otherLiveSessionsClause(runner.getRuntimeSessionStatus());
    return err(
      createErrorResponse(
        `Nothing to stop: no runtime session is current.${others}`,
        others === ''
          ? [
              'No follow-up is needed: nothing is running and no bridge is left in a project. An attached session that ended by itself, or a session already stopped, looks like this',
            ]
          : [
              'Call switch_project with one of the listed project paths, then stop_project, to stop that session',
              'If the session you meant to stop is not listed, it has already ended and needs no stop',
            ],
      ),
    );
  }

  if (result.releasedCaptureOnly === true) {
    // The record held only a finished profiler capture: the game had exited
    // and an earlier stop_project returned its logs. Releasing the capture is
    // what switch_project and check_project send the caller here for, so it is
    // a success, and the logs are null because none are held any more.
    const others = otherLiveSessionsClause(runner.getRuntimeSessionStatus());
    const released =
      'Released the finished profiler capture retained for this project. Its Godot process had already exited';
    return createStructuredResponse({
      warnings: [CAPTURE_ONLY_NO_LOGS_WARNING],
      projectPath: result.projectPath,
      message:
        others === '' ? released : `${released}.${others} Call switch_project to select one.`,
      sessionMode: result.mode,
      externalProcessPreserved: false,
      alreadyExited: true,
      finalOutput: null,
      finalErrors: null,
    });
  }

  const alreadyExited = result.alreadyExited === true;
  // Each teardown step that was attempted and not confirmed leads the payload.
  // The stop itself still happened, so this stays a success.
  // An unconfirmed kill leads everything: the game may still be running.
  const killUnconfirmed = result.killUnconfirmed === true;
  const warnings = [
    ...(killUnconfirmed ? [killUnconfirmedWarning(result.pid)] : []),
    ...result.cleanupProblems.map((problem) => CLEANUP_INCOMPLETE_PREFIX + problem),
  ];
  if (result.mode === 'attached' && result.shutdownAcknowledged === false) {
    warnings.push(SHUTDOWN_UNACKNOWLEDGED_WARNING);
  }
  // Null logs mean nothing was captured (an attached session), and the
  // payload says so instead of handing back lists that look like silence.
  const nothingCaptured = result.output === null || result.errors === null;
  if (nothingCaptured) {
    warnings.push(attachedNothingCapturedWarning('finalOutput', 'finalErrors'));
  }
  // The message says the bridge was cleaned up only when every step was
  // confirmed: with a problem on record it says so instead.
  const cleanupComplete = result.cleanupProblems.length === 0;
  let base: string;
  if (result.mode === 'attached') {
    base = cleanupComplete
      ? 'Attached project detached and MCP bridge state cleaned up'
      : 'Attached project detached; MCP bridge cleanup was incomplete (see warnings)';
  } else if (alreadyExited) {
    base = cleanupComplete
      ? 'The Godot process had already exited; MCP bridge state was cleaned up at that time and the process slot is now free'
      : 'The Godot process had already exited; MCP bridge cleanup at that time was incomplete (see warnings) and the process slot is now free';
  } else if (killUnconfirmed) {
    // The stop is reported as what was observed: a kill that was sent.
    base = cleanupComplete
      ? 'The Godot process was sent a kill but did not report its exit (see warnings); the session was released and MCP bridge state cleaned up'
      : 'The Godot process was sent a kill but did not report its exit, and MCP bridge cleanup was incomplete (see warnings); the session was released';
  } else {
    base = cleanupComplete
      ? 'Godot project stopped'
      : 'Godot project stopped; MCP bridge cleanup was incomplete (see warnings)';
  }
  const remaining = otherLiveSessionsClause(runner.getRuntimeSessionStatus());
  return createStructuredResponse({
    ...(warnings.length > 0 ? { warnings } : {}),
    projectPath: result.projectPath,
    message: remaining === '' ? base : `${base}.${remaining} Call switch_project to select one.`,
    sessionMode: result.mode,
    externalProcessPreserved: result.externalProcessPreserved === true,
    alreadyExited,
    ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
    ...(killUnconfirmed ? { killUnconfirmed: true } : {}),
    ...(killUnconfirmed && result.pid !== undefined ? { pid: result.pid } : {}),
    finalOutput:
      result.output === null ? null : condenseProcessTail(result.output, STOP_OUTPUT_MAX_LINES),
    finalErrors:
      result.errors === null ? null : condenseProcessTail(result.errors, STOP_OUTPUT_MAX_LINES),
  });
}

const CLEANUP_INCOMPLETE_PREFIX = 'Bridge cleanup incomplete: ';

function killUnconfirmedWarning(pid: number | undefined): string {
  return `The Godot process (pid ${pid ?? 'unknown'}) was sent a kill and did not report its exit in time, so it may still be running and may still hold its bridge port. Check for it by that pid and end it by hand if it is still there.`;
}
const CAPTURE_ONLY_NO_LOGS_WARNING =
  'finalOutput and finalErrors are null, not empty: the logs of the exited process were returned by the earlier stop_project call and are no longer held.';
const SHUTDOWN_UNACKNOWLEDGED_WARNING =
  'The bridge inside the still-running Godot did not acknowledge shutdown, so it keeps listening on its port until that Godot process is closed.';

// stop_project is routine housekeeping whose success result previously
// re-dumped up to this many raw lines into the caller's context on every
// call; get_debug_output remains the full-log path. Preserves the size
// bound of the prior `.slice(-200)` behavior after condensing to
// diagnostic lines.
const STOP_OUTPUT_MAX_LINES = 200;

function parseScreenshotResponseMode(value: unknown): ScreenshotResponseMode | null {
  if (value === undefined) return 'preview';
  if (typeof value !== 'string') return null;
  return SCREENSHOT_RESPONSE_MODES.includes(value as ScreenshotResponseMode)
    ? (value as ScreenshotResponseMode)
    : null;
}

/**
 * A preview bound in whole pixels: the default when omitted, null when it is
 * not a positive number, and never above `limit` (a larger request is
 * clamped, as the property description says).
 */
function parsePreviewDimension(value: unknown, fallback: number, limit: number): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.min(limit, Math.max(1, Math.floor(value)));
}

/**
 * The inline image block for a saved PNG, or the warning that takes its
 * place when the file is too large to inline or cannot be read. `what` names
 * the image in that warning ("The screenshot", "The preview").
 */
function inlineImageOrWarning(
  filePath: string,
  what: string,
): { block: { type: string; [key: string]: unknown } } | { warning: string } {
  try {
    const bytes = statSync(filePath).size;
    if (bytes > SCREENSHOT_INLINE_MAX_BYTES) {
      return {
        warning: `${what} was not returned inline: the file is ${bytes} bytes, over the ${SCREENSHOT_INLINE_MAX_BYTES} byte inline limit. It is saved at the returned path.`,
      };
    }
    return {
      block: {
        type: 'image',
        data: readFileSync(filePath).toString('base64'),
        mimeType: 'image/png',
      },
    };
  } catch (error) {
    return {
      warning: `${what} was not returned inline: the file could not be read (${getErrorMessage(error)}).`,
    };
  }
}

function normalizeScreenshotPath(path: string): string {
  return sep === '\\' ? path.replace(/\//g, '\\') : path;
}

export function handleTakeScreenshot(
  runner: GodotRunner,
  args: OperationParams,
): Promise<HandlerResult> {
  // Gate and command are one step: the session the gate admitted is the one
  // the command goes to, with no other runtime call in between.
  return runSessionExclusive(runner, 'take_screenshot', () => takeScreenshot(runner, args));
}

async function takeScreenshot(runner: GodotRunner, args: OperationParams): Promise<HandlerResult> {
  args = normalizeParameters(args);

  const wording = runtimeToolWording('take a screenshot');
  const session = requireRuntimeSession(runner, wording);
  if (!session.ok) return session;
  const sessionProjectPath = session.value.projectPath;

  const timeoutResult = optionalNumber(args, 'timeout');
  if (!timeoutResult.ok) return timeoutResult;
  const timeout = timeoutResult.value ?? SCREENSHOT_DEFAULT_TIMEOUT_MS;
  const responseMode = parseScreenshotResponseMode(args.responseMode);
  if (responseMode === null) {
    return err(
      createErrorResponse('Invalid responseMode for take_screenshot', [
        'Use one of: "full", "preview", or "path_only"',
      ]),
    );
  }

  const previewMaxWidth = parsePreviewDimension(
    args.previewMaxWidth,
    DEFAULT_PREVIEW_MAX_WIDTH,
    PREVIEW_MAX_WIDTH_LIMIT,
  );
  const previewMaxHeight = parsePreviewDimension(
    args.previewMaxHeight,
    DEFAULT_PREVIEW_MAX_HEIGHT,
    PREVIEW_MAX_HEIGHT_LIMIT,
  );
  if (previewMaxWidth === null || previewMaxHeight === null) {
    return err(
      createErrorResponse('Invalid preview dimensions for take_screenshot', [
        'previewMaxWidth and previewMaxHeight must be positive numbers',
      ]),
    );
  }

  const commandParams: Record<string, unknown> = {};
  if (responseMode === 'preview') {
    commandParams.preview_max_width = previewMaxWidth;
    commandParams.preview_max_height = previewMaxHeight;
  }

  try {
    const { response: responseStr, runtimeErrors } = await runner.sendCommandWithErrors(
      'screenshot',
      commandParams,
      timeout,
    );

    const parsedResult = parseBridgeJson<ScreenshotBridgeResponse>(responseStr, 'screenshot', {
      ran: 'The screenshot was taken.',
      solutions: [
        'Look for the saved PNG under .mcp/godot-runtime/screenshots/ in the project',
        'Retry take_screenshot with responseMode "path_only"',
      ],
    });
    if (!parsedResult.ok) return parsedResult;
    const parsed = parsedResult.value;

    if (parsed.error) {
      return err(
        createErrorResponse(`Screenshot server error: ${parsed.error}`, [
          'Ensure the project has a viewport (a headless project with no display server cannot render)',
          'If the game window is minimized or fully covered, restore it and retry',
          'Check disk space and permissions on the project directory (.mcp/godot-runtime/screenshots/)',
        ]),
      );
    }

    if (!parsed.path) {
      return err(
        createErrorResponse('Screenshot server returned no file path', [
          'The bridge response is missing the expected `path` field - this is a bridge bug, not a timing issue',
          'Check get_debug_output for runtime errors during the screenshot save',
        ]),
      );
    }

    // Normalize path for the local filesystem (forward slashes from GDScript)
    const screenshotPath = normalizeScreenshotPath(parsed.path);

    // Defense-in-depth: the bridge runs in user-controlled GDScript and could
    // be patched to return any path. Refuse to read anything outside the
    // project's own screenshots directory.
    //
    // KEEP IN SYNC: src/scripts/mcp_bridge.gd `SCREENSHOT_DIR_RES_PATH` names
    // the directory the bridge saves into; this is the containment root that
    // decides what comes back. The two MUST move together.
    //
    // The root is the project captured at the gate, the session the command
    // was sent to. Reading the current session here, after the await, would
    // validate against whatever is current by now, or against nothing when
    // the game exited the moment it had answered: the file it saved is still
    // this session's screenshot.
    const screenshotsRoot = resolve(screenshotsDir(sessionProjectPath));
    if (!isUnderDir(screenshotsRoot, screenshotPath)) {
      return err(
        createErrorResponse(
          'Bridge returned a screenshot path outside .mcp/godot-runtime/screenshots/. Refusing to read.',
          [
            'This indicates a tampered or misbehaving McpBridge autoload',
            'Stop the project, verify the bridge script is the one shipped with this server, and retry',
          ],
        ),
      );
    }

    if (!existsSync(screenshotPath)) {
      return err(
        createErrorResponse(`Screenshot file not found at: ${screenshotPath}`, [
          'The screenshot may have failed to save',
          'Check disk space and permissions',
        ]),
      );
    }

    const measured = measurePngFile(screenshotPath);

    const metadata: Record<string, unknown> = {
      responseMode,
      path: parsed.path,
      size: { width: parsed.width, height: parsed.height },
      stats: measured.ok
        ? { ...measured.value.stats, likelyBlank: measured.value.likelyBlank }
        : null,
    };

    const content: Array<{ type: string; [key: string]: unknown }> = [];
    const inlineWarnings: string[] = [];

    if (responseMode === 'full') {
      const inline = inlineImageOrWarning(screenshotPath, 'The screenshot');
      if (!('block' in inline)) {
        inlineWarnings.push(
          `${inline.warning} Use responseMode "preview" for a smaller inline image.`,
        );
      } else if (!measured.ok) {
        // The file did not decode as a PNG, so it is not handed to the client
        // as an image. The stats warning says why.
        inlineWarnings.push(
          'The screenshot was not returned inline: the saved file could not be decoded as a PNG. It is saved at the returned path.',
        );
      } else {
        content.push(inline.block);
      }
    } else if (responseMode === 'preview') {
      if (!parsed.preview_path) {
        return err(
          createErrorResponse('Screenshot server returned no preview path', [
            'Ensure the running project has the current McpBridge autoload',
            'Restart the runtime after rebuilding the MCP server',
          ]),
        );
      }
      const previewPath = normalizeScreenshotPath(parsed.preview_path);
      if (!isUnderDir(screenshotsRoot, previewPath)) {
        return err(
          createErrorResponse(
            'Bridge returned a screenshot preview path outside .mcp/godot-runtime/screenshots/. Refusing to read.',
            [
              'This indicates a tampered or misbehaving McpBridge autoload',
              'Stop the project, verify the bridge script is the one shipped with this server, and retry',
            ],
          ),
        );
      }
      if (!existsSync(previewPath)) {
        return err(
          createErrorResponse(`Screenshot preview file not found at: ${previewPath}`, [
            'The preview may have failed to save',
            'Try again, or use responseMode "full" to return the original screenshot',
          ]),
        );
      }
      const inline = inlineImageOrWarning(previewPath, 'The preview');
      if ('block' in inline) content.push(inline.block);
      else inlineWarnings.push(inline.warning);
      metadata.previewPath = parsed.preview_path;
      metadata.previewSize = { width: parsed.preview_width, height: parsed.preview_height };
    }

    // A stats warning leads: a null stats must not be read as a blank frame.
    const statsWarnings = measured.ok
      ? []
      : [STATS_NOT_MEASURED_WARNING_PREFIX + measured.error + STATS_NOT_MEASURED_WARNING_SUFFIX];
    const warnings = [...statsWarnings, ...inlineWarnings, ...capRuntimeErrorLines(runtimeErrors)];

    return createStructuredResponse(
      {
        ...(warnings.length > 0 ? { warnings } : {}),
        projectPath: sessionProjectPath,
        ...metadata,
      },
      content,
    );
  } catch (error: unknown) {
    return err(
      runtimeCommandFailure(
        runner,
        error,
        'Failed to take screenshot',
        [
          'Check get_debug_output for crash backtraces or runtime errors',
          'If the game has exited, call stop_project, then run_project again',
          'For slow renders, increase the timeout parameter',
        ],
        wording,
      ),
    );
  }
}

/**
 * Server-side timeout for one input batch, derived from the batch itself.
 *
 * Exported for direct unit testing. A tap is a key/action/mouse_button action
 * with neither `pressed` nor `hold_ms`, which is the only shape that spends the
 * default tap-hold frames. The per-action settle term is charged for every
 * action, including `wait`, which adds no settle frame of its own: erring high
 * costs nothing, while erring low wedges the call.
 */
export function computeInputTimeoutMs(actions: unknown[]): number {
  let waitMs = 0;
  let holdMs = 0;
  let waitFrames = 0;
  let textChars = 0;
  let tapCount = 0;

  for (const action of actions) {
    if (typeof action !== 'object' || action === null) continue;
    const rec = action as Record<string, unknown>;
    const type = rec.type;
    // Only positive terms are summed. A negative duration is a validation error
    // the bridge reports, but subtracting it here would shrink the timeout below
    // the buffer and time the call out before the refusal could come back.
    if (type === 'wait') {
      if (typeof rec.ms === 'number' && rec.ms > 0) waitMs += rec.ms;
      if (typeof rec.frames === 'number' && rec.frames > 0) waitFrames += rec.frames;
      continue;
    }
    if (typeof rec.hold_ms === 'number' && rec.hold_ms > 0) holdMs += rec.hold_ms;
    if (type === 'text' && typeof rec.text === 'string') textChars += rec.text.length;
    if (
      (type === 'key' || type === 'action' || type === 'mouse_button') &&
      rec.pressed === undefined &&
      rec.hold_ms === undefined
    ) {
      tapCount += 1;
    }
  }

  const frames =
    waitFrames + actions.length * INPUT_SETTLE_FRAMES_PER_ACTION + tapCount * INPUT_TAP_HOLD_FRAMES;
  return (
    waitMs +
    holdMs +
    INPUT_PESSIMISTIC_FRAME_MS * frames +
    textChars * INPUT_TEXT_PER_CHAR_MS +
    INPUT_TIMEOUT_BUFFER_MS
  );
}

/**
 * Node-side cap enforcement, returning a message naming the offending action
 * index or null when the batch may go to the bridge. The bridge validates
 * independently; this is what keeps the computed timeout bounded and gives the
 * agent the error without a round trip.
 */
function findInputCapViolation(actions: unknown[], watch: string[]): string | null {
  if (watch.length > MAX_WATCH_ENTRIES) {
    return `watch accepts at most ${MAX_WATCH_ENTRIES} entries (got ${watch.length})`;
  }
  for (let i = 0; i < actions.length; i += 1) {
    const action = actions[i];
    if (typeof action !== 'object' || action === null) {
      return `action ${i}: must be an object`;
    }
    const rec = action as Record<string, unknown>;
    const type = rec.type;
    if (type === 'wait') {
      const hasMs = rec.ms !== undefined;
      const hasFrames = rec.frames !== undefined;
      if (hasMs === hasFrames) {
        return `action ${i} (wait): set exactly one of ms or frames`;
      }
      if (hasFrames && (typeof rec.frames !== 'number' || rec.frames > MAX_WAIT_FRAMES)) {
        return `action ${i} (wait): frames must be a number no greater than ${MAX_WAIT_FRAMES}`;
      }
      continue;
    }
    if (rec.hold_ms !== undefined) {
      if (rec.pressed !== undefined) {
        return `action ${i} (${String(type)}): hold_ms cannot be combined with pressed`;
      }
      if (typeof rec.hold_ms !== 'number' || rec.hold_ms > MAX_HOLD_MS) {
        return `action ${i} (${String(type)}): hold_ms must be a number no greater than ${MAX_HOLD_MS}`;
      }
    }
    if (typeof rec.text === 'string' && rec.text.length > MAX_TEXT_LENGTH) {
      return `action ${i} (${String(type)}): text exceeds ${MAX_TEXT_LENGTH} characters`;
    }
  }
  // The whole batch, after the per-action caps: its count and its waits in
  // milliseconds are bounded only here.
  const budgetMs = computeInputTimeoutMs(actions);
  if (!(budgetMs <= MAX_INPUT_BATCH_BUDGET_MS)) {
    return `the batch's time budget is ${budgetMs} ms, over the ${MAX_INPUT_BATCH_BUDGET_MS} ms ceiling for one call (its waits and holds, plus ${INPUT_PESSIMISTIC_FRAME_MS} ms for every frame it spends); split it across calls`;
  }
  return null;
}

/**
 * Attach per-action runtime errors to the entries that produced them. Lines
 * after the last boundary belong to the last executed entry. An entry with no
 * errors keeps no `errors` key at all, so payloads stay small.
 */
function attachActionErrors(
  results: Record<string, unknown>[],
  buckets: string[][],
  trailing: string[],
): void {
  let lastExecuted = -1;
  for (let i = 0; i < results.length; i += 1) {
    if (results[i]?.skipped !== true) lastExecuted = i;
  }
  for (let i = 0; i < results.length; i += 1) {
    const entry = results[i];
    if (!entry || entry.skipped === true) continue;
    let lines = buckets[i] ?? [];
    if (i === lastExecuted && trailing.length > 0) lines = [...lines, ...trailing];
    if (lines.length > 0) entry.errors = capRuntimeErrorLines(lines);
  }
}

const PARTIAL_ERROR_ATTRIBUTION_WARNING =
  "Runtime errors raised during this batch may be attributed to the wrong action or be missing: Godot's stderr had not delivered every action boundary in time. Read get_debug_output for the full log.";

export function handleSimulateInput(
  runner: GodotRunner,
  args: OperationParams,
): Promise<HandlerResult> {
  // One step from the gate to the last stderr line: the error capture window
  // opened for this batch must not receive another call's boundaries.
  return runSessionExclusive(runner, 'simulate_input', () => simulateInput(runner, args));
}

async function simulateInput(runner: GodotRunner, args: OperationParams): Promise<HandlerResult> {
  args = normalizeParameters(args);

  const wording = runtimeToolWording('simulate input');
  const session = requireRuntimeSession(runner, wording);
  if (!session.ok) return session;
  const sessionProjectPath = session.value.projectPath;

  const actionsResult = requireArray(args, 'actions', { minLength: 1 });
  if (!actionsResult.ok) return actionsResult;
  const actions = actionsResult.value;

  const watchResult = optionalStringArray(args, 'watch');
  if (!watchResult.ok) return watchResult;
  const watch = watchResult.value ?? [];

  const capViolation = findInputCapViolation(actions, watch);
  if (capViolation) {
    return err(
      createErrorResponse(`Input simulation error: ${capViolation}`, [
        'Fix the named action and resend the batch - nothing was injected',
        'Check the per-property descriptions for the caps on frames, hold_ms, text, watch and the batch time budget',
      ]),
    );
  }

  const timeoutMs = computeInputTimeoutMs(actions);
  const params: Record<string, unknown> = watch.length > 0 ? { actions, watch } : { actions };

  try {
    // Opened before the bridge call so every boundary this batch prints is
    // inside the capture window.
    const capture = runner.beginActionErrorCapture();
    const { response: responseStr } = await runner.sendCommandWithErrors(
      'input',
      params,
      timeoutMs,
    );

    const parsedResult = parseBridgeJson<{
      success?: boolean;
      error?: string;
      results?: unknown[];
      still_held?: string[];
    }>(responseStr, 'simulate_input', {
      ran: 'The batch ran: its actions were injected and are not undone.',
      solutions: [
        'Do not resend the batch: its inputs already landed. Read the state they left with get_ui_elements or take_screenshot',
        'For a result that fits, send fewer actions per call or fewer watch entries',
      ],
    });
    if (!parsedResult.ok) return parsedResult;
    const parsed = parsedResult.value;

    // A flat `error` is a pre-validation refusal: nothing was injected. The
    // one flat error sent after the actions ran, the oversize reply, never
    // gets here: parseBridgeJson has already reported it as such.
    if (parsed.error) {
      return err(
        createErrorResponse(`Input simulation error: ${parsed.error}`, [
          'Fix the named action and resend the batch - nothing was injected',
          'Ensure key names are valid Godot key names and action names exist in the Input Map',
        ]),
      );
    }

    // One entry per action is what the bridge always sends. A frame without
    // the list, or with an entry that is not an object, says nothing about
    // what was injected, and dropping it would leave a shorter timeline that
    // reads as complete.
    if (
      !Array.isArray(parsed.results) ||
      parsed.results.some((entry) => typeof entry !== 'object' || entry === null)
    ) {
      return err(
        malformedBridgeFrame(
          'simulate_input',
          'the frame has no results array of per-action entries, so what was injected is not known',
        ),
      );
    }
    const results = parsed.results as Record<string, unknown>[];
    const executed = results.filter((entry) => entry.skipped !== true).length;
    const { buckets, trailing, sentinelTimedOut } = await runner.collectActionErrors(
      capture,
      executed,
    );
    if (sentinelTimedOut) {
      logDebug(
        `[simulate_input] stderr drained without all ${executed} action boundaries; error attribution is partial`,
      );
    }
    attachActionErrors(results, buckets, trailing);

    // A partially failed batch still returns a success-shaped response so the
    // timeline survives; createErrorResponse is reserved for session errors,
    // pre-validation refusals, and transport failures.
    const payload: Record<string, unknown> = {
      // Not every action boundary arrived before the drain deadline. Lines
      // that did arrive may sit on the wrong entry, and lines still in flight
      // are on no entry at all, so the per-action `errors` cannot be read as
      // complete. That has to lead the payload, not sit in a debug log.
      ...(sentinelTimedOut ? { warnings: [PARTIAL_ERROR_ATTRIBUTION_WARNING] } : {}),
      projectPath: sessionProjectPath,
      success: parsed.success === true,
      results,
    };
    if (Array.isArray(parsed.still_held) && parsed.still_held.length > 0) {
      payload.still_held = parsed.still_held;
    }

    return createStructuredResponse(payload);
  } catch (error: unknown) {
    return err(
      runtimeCommandFailure(
        runner,
        error,
        'Failed to simulate input',
        [
          'Check get_debug_output for crash backtraces or runtime errors (a signal handler firing on input may have crashed the game)',
          'If the game has exited, call stop_project, then run_project again',
        ],
        wording,
      ),
    );
  }
}

export function handleGetUiElements(
  runner: GodotRunner,
  args: OperationParams,
): Promise<HandlerResult> {
  return runSessionExclusive(runner, 'get_ui_elements', () => queryUiElements(runner, args));
}

async function queryUiElements(runner: GodotRunner, args: OperationParams): Promise<HandlerResult> {
  args = normalizeParameters(args);

  const wording = runtimeToolWording('query UI elements');
  const session = requireRuntimeSession(runner, wording);
  if (!session.ok) return session;
  const sessionProjectPath = session.value.projectPath;

  const visibleOnlyResult = optionalBoolean(args, 'visibleOnly');
  if (!visibleOnlyResult.ok) return visibleOnlyResult;
  const visibleOnly = visibleOnlyResult.value ?? true;

  const filterResult = optionalString(args, 'filter');
  if (!filterResult.ok) return filterResult;

  try {
    const cmdParams: Record<string, unknown> = { visible_only: visibleOnly };
    if (filterResult.value) cmdParams.type_filter = filterResult.value;
    const { response: responseStr, runtimeErrors } = await runner.sendCommandWithErrors(
      'get_ui_elements',
      cmdParams,
    );

    const parsedResult = parseBridgeJson<{ elements?: unknown[]; error?: string }>(
      responseStr,
      'get_ui_elements',
      {
        ran: 'The UI was read and nothing was changed.',
        solutions: [
          'Pass filter with a Control class name (Button, Label, LineEdit) to narrow the list',
          'Leave visibleOnly at true',
        ],
      },
    );
    if (!parsedResult.ok) return parsedResult;
    const parsed = parsedResult.value;

    if (parsed.error) {
      return err(
        createErrorResponse(`UI element query error: ${parsed.error}`, [
          'Pass a native Control class name (Button, Label, LineEdit), or omit filter',
        ]),
      );
    }

    // No list is not an empty list: an empty one says the scene has no
    // matching Control, and a frame without one says nothing.
    if (!Array.isArray(parsed.elements)) {
      return err(
        malformedBridgeFrame('get_ui_elements', 'the frame has no elements array to report'),
      );
    }

    const payload: Record<string, unknown> = {
      ...parsed,
      projectPath: sessionProjectPath,
      tip: "Use simulate_input with type 'click_element' and a path or node name from this list to interact with these elements.",
    };
    attachRuntimeWarnings(payload, runtimeErrors);

    return createStructuredResponse(leadWithWarnings(payload));
  } catch (error: unknown) {
    return err(
      runtimeCommandFailure(
        runner,
        error,
        'Failed to get UI elements',
        [
          'Check get_debug_output for crash backtraces or runtime errors',
          'If the game has exited, call stop_project, then run_project again',
        ],
        wording,
      ),
    );
  }
}

const ATTACHED_NULL_RESULT_WARNING =
  "Script returned null in an attached session. Runtime errors cannot be observed there (Godot's output is not captured), so this may be a script that raised; check the Godot process's own output.";
const RUN_SCRIPT_TIP =
  'Call take_screenshot to verify any visual changes, or get_debug_output to review print() output from your script.';
const RUN_SCRIPT_TIP_ATTACHED =
  "Call take_screenshot to verify any visual changes. print() output from your script goes to the Godot process's own output: an attached session captures none of it, so get_debug_output has nothing to show.";

export async function handleRunScript(
  runner: GodotRunner,
  args: OperationParams,
  ctx: McpContext = createNullContext(),
): Promise<HandlerResult> {
  args = normalizeParameters(args);

  const wording = runtimeToolWording('execute scripts');
  const session = requireRuntimeSession(runner, wording);
  if (!session.ok) return session;
  const sessionProjectPath = session.value.projectPath;
  // Captured at the gate with the path: what the payload says about the
  // session is what the session was when the call was admitted.
  const sessionMode = session.value.mode;
  const tip = sessionMode === 'attached' ? RUN_SCRIPT_TIP_ATTACHED : RUN_SCRIPT_TIP;

  const scriptResult = requireString(args, 'script');
  if (!scriptResult.ok) return scriptResult;
  const script = scriptResult.value;

  if (!script.includes('func execute')) {
    return err(
      createErrorResponse('Script must define func execute(scene_tree: SceneTree) -> Variant', [
        'Add a func execute(scene_tree: SceneTree) -> Variant method to your script',
      ]),
    );
  }

  // Read before the gate: a call that cannot be sent must not prompt a human
  // or leave an audit record saying the script ran.
  const timeoutResult = optionalNumber(args, 'timeout');
  if (!timeoutResult.ok) return timeoutResult;
  const timeout = timeoutResult.value ?? RUN_SCRIPT_DEFAULT_TIMEOUT_MS;

  // Static-analysis gate. Decision drives audit + dispatch. Completely
  // skipped when GODOT_MCP_DISABLE_SECURITY is set: no scan, no Tier 1/2/3
  // decision, no elicitation, no warnings, no audit sidecar. Tier 1 hard
  // blocks are included in the no-op — see McpContext.disableSecurity.
  let warningsFromPolicy: string[] = [];
  // Set when the policy admits the script. The record of an admitted script
  // is written at the send, not here: see `auditAdmitted` below.
  let admitted: { policy: PolicyDecision; decision: AdmittedAuditDecision } | null = null;
  if (!ctx.disableSecurity) {
    const policy = evaluateScript(script, ctx.strictMode);
    const projectPath = sessionProjectPath;

    // Tier 1: hard block. Write audit, refuse to forward to the bridge.
    if (policy.decision === 'hard_block') {
      if (projectPath) {
        writeAuditSidecar(projectPath, script, 'hard_block', policy, ctx.strictMode);
      }
      return err(
        createErrorResponse(formatBlockMessage(policy.matches), collectSolutions(policy.matches)),
      );
    }

    // Tier 2: elicit. Single prompt for the script — name the first finding +
    // `+N more` suffix. Decline / cancel / elicitation-unavailable all map to
    // denial. The audit sidecar records the actual outcome. When elicitation is
    // disabled (GODOT_MCP_DISABLE_ELICITATION), the finding proceeds unprompted and is
    // audited as `elicit_bypassed`. Note: strict mode promotes Tier 2 to
    // `hard_block` in `evaluateScript` above, so this branch is never reached
    // under strict — there is no strict/disableElicitation conflict to resolve here.
    let elicitBypassed = false;
    if (policy.decision === 'elicit_required') {
      if (ctx.disableElicitation) {
        elicitBypassed = true;
        warningsFromPolicy = matchesToWarnings(policy.matches);
      } else {
        let elicitResult: ElicitorResult;
        try {
          const head = summarizeMatch(policy.matches[0]!);
          elicitResult = await ctx.elicitor({
            message: `run_script wants to call ${head}.${formatMoreFindingsSuffix(policy.matches.length)} Proceed?`,
            requestedSchema: {
              type: 'object',
              properties: {
                confirm: { type: 'boolean', description: 'Allow the script to run' },
              },
              required: ['confirm'],
            },
          });
        } catch (error) {
          if (projectPath) {
            writeAuditSidecar(projectPath, script, 'elicit_denied', policy, ctx.strictMode);
          }
          return err(
            createErrorResponse(
              `Elicitation unavailable: ${policy.matches[0]?.matchedText ?? 'Tier 2 primitive'} requires user confirmation but the client does not support elicitation. Cause: ${getErrorMessage(error)}`,
              [
                'Restructure the script to avoid the flagged primitive',
                'Use an MCP client that supports the elicitation/create capability',
              ],
            ),
          );
        }

        if (!isElicitAccepted(elicitResult)) {
          // A `cancel` means the client dismissed the prompt without an
          // explicit choice. Some clients auto-cancel elicitation without ever
          // displaying it, so it is told apart from a `decline`, in the same
          // words the launch gate uses, and it points at the opt-out. The
          // audit record keeps the two apart as well: nobody decided.
          const cancelled = elicitResult.action === 'cancel';
          if (projectPath) {
            writeAuditSidecar(
              projectPath,
              script,
              cancelled ? 'elicit_cancelled' : 'elicit_denied',
              policy,
              ctx.strictMode,
            );
          }
          const finding = summarizeMatch(policy.matches[0]!);
          return err(
            createErrorResponse(
              cancelled
                ? `run_script confirmation was cancelled without an explicit choice (${finding}). Some MCP clients (e.g. Claude Desktop) auto-cancel elicitation prompts instead of displaying them. The script was not executed.`
                : `User declined: ${finding}. The script was not executed.`,
              cancelled
                ? [...collectSolutions(policy.matches), ELICITATION_OPT_OUT_SOLUTION]
                : collectSolutions(policy.matches),
            ),
          );
        }
        // Accept proceeds — record warnings for the success payload.
        warningsFromPolicy = matchesToWarnings(policy.matches);
      }
    } else if (policy.decision === 'warn') {
      warningsFromPolicy = matchesToWarnings(policy.matches);
    }

    // The successful / warn paths. A Tier 2 accept is recorded distinctly from
    // a plain Tier 3 warn so the audit trail preserves the user-confirmation
    // event. A Tier 2 finding that ran unprompted because elicitation was
    // disabled is recorded as `elicit_bypassed`.
    let decision: AdmittedAuditDecision;
    if (policy.decision === 'ok') decision = 'ok';
    else if (policy.decision === 'elicit_required')
      decision = elicitBypassed ? 'elicit_bypassed' : 'elicit_accepted';
    else decision = 'warn';
    admitted = { policy, decision };
  }

  // One record per admitted call, saying what happened to the script: the
  // admitted decision when it is about to be sent, `not_sent` when the call
  // ended before that. Written once; nothing when the gate is disabled.
  let audited = false;
  let admittedSidecarFile: string | null = null;
  const auditAdmitted = (sent: boolean): void => {
    if (admitted === null || audited || !sessionProjectPath) return;
    audited = true;
    if (sent) {
      admittedSidecarFile = writeAuditSidecar(
        sessionProjectPath,
        script,
        admitted.decision,
        admitted.policy,
        ctx.strictMode,
      );
    } else {
      writeAuditSidecar(
        sessionProjectPath,
        script,
        'not_sent',
        admitted.policy,
        ctx.strictMode,
        admitted.decision,
      );
    }
  };

  // The record is written before the send. A send that fails with the frame
  // never written means the script did not run, so the same record is
  // rewritten as `not_sent`.
  const markNotSent = (): void => {
    if (admitted === null || admittedSidecarFile === null || !sessionProjectPath) return;
    writeAuditSidecar(
      sessionProjectPath,
      script,
      'not_sent',
      admitted.policy,
      ctx.strictMode,
      admitted.decision,
      admittedSidecarFile,
    );
  };

  const result = await runSessionExclusive(runner, 'run_script', async () => {
    // The gate at the top admitted this call, but a confirmation prompt can
    // be held open for minutes and the queue wait comes on top of it. The
    // session is checked again now that the turn has come: the script was
    // judged and confirmed for that session and runs on no other. The audit
    // record is written only once this check has passed.
    const current = requireRuntimeSession(runner, wording);
    if (!current.ok) return current;
    if (
      sessionKey(current.value.projectPath) !== sessionKey(sessionProjectPath) ||
      current.value.mode !== sessionMode
    ) {
      return err(
        createErrorResponse(
          `The current session changed while this call was waiting (it was ${sessionProjectPath}, it is now ${current.value.projectPath}). The script was not executed.`,
          [
            'Call run_script again to run it on the session that is current now',
            'Or call switch_project first if it should run on the other session',
          ],
        ),
      );
    }
    auditAdmitted(true);
    return executeAdmittedScript(runner, {
      script,
      timeout,
      sessionProjectPath,
      sessionMode,
      tip,
      warningsFromPolicy,
      wording,
      markNotSent,
    });
  });
  // Reached without a record only when the script was never sent: the turn
  // did not come, or the session was gone or another one by the time it did.
  auditAdmitted(false);
  return result;
}

/** The send and the reading of its reply, for a script the gate and the policy have admitted. */
async function executeAdmittedScript(
  runner: GodotRunner,
  admitted: {
    script: string;
    timeout: number;
    sessionProjectPath: string;
    sessionMode: RuntimeSessionMode | null;
    tip: string;
    warningsFromPolicy: string[];
    wording: NoSessionWording;
    /** Called when the send rejected and its frame never reached the bridge. */
    markNotSent: () => void;
  },
): Promise<HandlerResult> {
  const {
    script,
    timeout,
    sessionProjectPath,
    sessionMode,
    tip,
    warningsFromPolicy,
    wording,
    markNotSent,
  } = admitted;
  try {
    const {
      response: responseStr,
      runtimeErrors,
      stderrWindow,
    } = await runner.sendCommandWithErrors('run_script', { source: script }, timeout);

    const parsedResult = parseBridgeJson<{
      success?: boolean;
      result?: unknown;
      error?: string;
    }>(responseStr, 'run_script', {
      ran: 'The script ran to completion and whatever it changed stays changed.',
      solutions: [
        'Do not rerun the script only to read its value if it changes state',
        'Return less from execute(): a count, a slice, or only the fields you need',
      ],
    });
    if (!parsedResult.ok) return parsedResult;
    const parsed = parsedResult.value;

    if (parsed.error) {
      // Compilation failures (error 43 class): the bridge returns a bare
      // "Script compilation failed (error N). Check syntax." with no location,
      // while the actual parser diagnostic (message + line) is on the engine
      // process stderr — captured by sendCommandWithErrors in stderrWindow
      // (unfiltered, so the "at: <path>:<line>" lines survive).
      // Surface it directly instead of sending the agent hunting through
      // get_debug_output for it.
      let compileDetail = '';
      if (/Script compilation failed/.test(parsed.error)) {
        const diagnostics = parseScriptDiagnostics(stderrWindow.join('\n'));
        if (diagnostics.length > 0) {
          const parts = diagnostics.map(
            (d) =>
              `${d.filePath ?? 'submitted script'}${d.line !== undefined ? `:${d.line}` : ''}: ${d.message}`,
          );
          compileDetail = `\nCompiler diagnostics:\n${parts.join('\n')}`;
        }
      }
      return err(
        createErrorResponse(`Script execution error: ${parsed.error}${compileDetail}`, [
          ...(compileDetail
            ? ['Fix the reported line in the submitted script source']
            : ['Check your GDScript syntax']),
          'Ensure the script extends RefCounted',
          'Check get_debug_output for details',
        ]),
      );
    }

    // The bridge answers a run with `success: true` and the `result`, or with
    // an `error`. A frame without them does not say the script ran, or what it
    // returned: a missing result is not the null a script returns.
    if (parsed.success !== true || !('result' in parsed)) {
      return err(
        malformedBridgeFrame(
          'run_script',
          'the frame reports neither a successful run with its result nor an error, so it is not known whether the script ran',
        ),
      );
    }

    // Detect false-positive success: GDScript has no try-catch, so runtime errors
    // return null and the real error only appears in stderr.
    if (parsed.success && parsed.result === null && sessionMode === 'spawned') {
      if (runtimeErrors.length > 0) {
        const errorContext = capRuntimeErrorLines(runtimeErrors).join('\n');
        return err(
          createErrorResponse(`Script runtime error detected:\n${errorContext}`, [
            'Fix the GDScript error in your script and retry',
            'Use get_debug_output for full process output',
          ]),
        );
      }

      const nullPayload: Record<string, unknown> = {
        projectPath: sessionProjectPath,
        success: true,
        result: null,
        warnings: [
          'Script returned null. If unexpected, check get_debug_output for runtime errors - GDScript does not propagate exceptions.',
          ...warningsFromPolicy,
        ],
        tip,
      };
      return createStructuredResponse(leadWithWarnings(nullPayload));
    }

    // An attached session captures no stderr, so the check above cannot run
    // there: a script that raised and a script that returned null produce the
    // same frame. The result is reported, and so is what could not be seen.
    if (parsed.success && parsed.result === null && sessionMode === 'attached') {
      return createStructuredResponse({
        warnings: [ATTACHED_NULL_RESULT_WARNING, ...warningsFromPolicy],
        projectPath: sessionProjectPath,
        success: true,
        result: null,
        tip,
      });
    }

    const payload: Record<string, unknown> = {
      projectPath: sessionProjectPath,
      success: true,
      result: parsed.result,
      tip,
    };
    // Only the runtime-error lines are capped: they are the unbounded part,
    // and the count entry names the log that holds the rest of them.
    const combinedWarnings = [...warningsFromPolicy, ...capRuntimeErrorLines(runtimeErrors)];
    if (combinedWarnings.length > 0) {
      payload.warnings = combinedWarnings;
    }

    return createStructuredResponse(leadWithWarnings(payload));
  } catch (error: unknown) {
    if (commandWasNotSent(error)) markNotSent();
    return err(
      runtimeCommandFailure(
        runner,
        error,
        'Failed to execute script',
        [
          'Check get_debug_output for crash backtraces or runtime errors raised inside the script',
          'If the game has exited, call stop_project, then run_project again',
          'For long-running scripts, increase the timeout parameter',
        ],
        wording,
      ),
    );
  }
}
