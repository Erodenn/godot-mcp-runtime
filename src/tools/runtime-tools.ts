import { join, sep } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import type { GodotRunner, OperationParams, ToolDefinition } from '../utils/godot-runner.js';
import {
  normalizeParameters,
  validateProjectArgs,
  createErrorResponse,
  BRIDGE_WAIT_SPAWNED_TIMEOUT_MS,
} from '../utils/godot-runner.js';
import { logDebug } from '../utils/logger.js';
import { randomUUID } from 'crypto';

const MAX_RUNTIME_ERROR_CONTEXT_LINES = 30;
const SCREENSHOT_RESPONSE_MODES = ['full', 'preview', 'path_only'] as const;
const DEFAULT_PREVIEW_MAX_WIDTH = 960;
const DEFAULT_PREVIEW_MAX_HEIGHT = 540;

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

export const runtimeToolDefinitions: ToolDefinition[] = [
  {
    name: 'launch_editor',
    description:
      'Open the Godot editor GUI for a project for the human user. Use only when the user explicitly asks to "open the editor"; for any agent-driven work, use the headless scene/node tools (add_node, set_node_properties, etc.) instead — the editor cannot be controlled programmatically. Returns plain-text confirmation after spawning the editor process. Errors if projectPath has no project.godot.',
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
  },
  {
    name: 'run_project',
    description:
      'Spawn a Godot project as a child process with stdout/stderr captured. Preferred entry to runtime tools — required before take_screenshot, simulate_input, get_ui_elements, run_script, or get_debug_output. For a Godot process you launched yourself, use attach_project instead. Verifies MCP bridge readiness before returning success. Call stop_project when done. Returns plain-text status confirming the bridge is ready. Errors if projectPath is not a Godot project or another run is already active.',
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
            'Scene to run (path relative to project, e.g. "scenes/main.tscn"). Omit to use the project\'s main scene.',
        },
        background: {
          type: 'boolean',
          description:
            'If true, hides the Godot window off-screen and blocks all physical keyboard and mouse input, while keeping programmatic input (simulate_input, run_script) and screenshots fully active. Useful for automated agent-driven testing where the window should not be visible or interactive.',
        },
      },
      required: ['projectPath'],
    },
  },
  {
    name: 'attach_project',
    description:
      'Attach runtime MCP tools to a manually launched Godot process without spawning one. Use only when something other than MCP is running Godot (debugger attached, custom CLI flags, IDE run) — for the standard case, use run_project. Injects the McpBridge autoload, then waits up to 15s for the bridge to respond. If you are launching Godot in parallel, kick the launch off concurrently with this call so the wait absorbs startup. bridge.inject is idempotent, so retrying after a missed window is safe. Use detach_project or stop_project when done. get_debug_output is unavailable in attached mode (stdout/stderr not captured). Returns plain-text status confirming the bridge is ready in attached mode.',
    annotations: { destructiveHint: true },
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
  },
  {
    name: 'detach_project',
    description:
      'Clear attached-mode runtime state and remove the injected McpBridge autoload. Does NOT stop the manually launched Godot process — that stays running. Use after attach_project when you are done driving the game from MCP. For spawned sessions (run_project), use stop_project instead. Returns { message, externalProcessPreserved }. Errors if called outside an attached session.',
    annotations: { destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_debug_output',
    description:
      'Get captured stdout/stderr from a spawned Godot project. Use whenever runtime tools fail unexpectedly — script errors, missing nodes, and crash backtraces all surface here. Requires run_project (not attach_project; attached mode does not capture output). Returns { output, errors, running, exitCode? } with the last `limit` lines (default 200, from the end). Reports attached-mode unavailability gracefully.',
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
  },
  {
    name: 'stop_project',
    description:
      'Stop the spawned Godot project and clean up MCP bridge state. Always call when done with runtime testing — even after a crash — to free the single process slot so run_project can be called again. For attached sessions, this detaches without killing the externally launched process. Returns { message, mode, externalProcessPreserved, finalOutput, finalErrors }. Errors if no session is active.',
    annotations: { destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'take_screenshot',
    description:
      'Capture a PNG screenshot of the running Godot viewport. Use after simulate_input or run_script to verify visual changes. Requires an active runtime session (run_project or attach_project). responseMode defaults to full (current behavior: full inline PNG); preview saves the original and returns a bounded inline preview; path_only returns metadata only. Screenshots are saved under .mcp/screenshots. Errors if no session is active or the bridge does not respond within timeout (default 10000ms).',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds to wait for the screenshot (default: 10000)',
        },
        responseMode: {
          type: 'string',
          enum: ['full', 'preview', 'path_only'],
          description:
            'Response payload mode. "full" returns the full inline PNG (default). "preview" returns a bounded preview inline plus paths. "path_only" returns paths only.',
        },
        previewMaxWidth: {
          type: 'number',
          description:
            'Maximum preview width in pixels when responseMode is "preview" (default: 960)',
        },
        previewMaxHeight: {
          type: 'number',
          description:
            'Maximum preview height in pixels when responseMode is "preview" (default: 540)',
        },
      },
      required: [],
    },
  },
  {
    name: 'simulate_input',
    description:
      'Simulate batched sequential input in a running Godot project. Each action specifies its type ("key", "mouse_button", "mouse_motion", "click_element", "action", or "wait") plus per-type fields documented in inputSchema. For click_element, call get_ui_elements first to discover element node names and paths — element resolution is path/name only, not visible text. For text-entry into LineEdit/TextEdit, key actions auto-fill the InputEventKey.unicode field for ASCII letters and digits (respecting shift); for symbols or non-ASCII, pass the explicit "unicode" field. Press/release pairs require two separate actions; insert "wait" actions between them when the game needs frame ticks. Requires an active runtime session (run_project or attach_project). Returns { success, actions_processed, warnings? }. Errors if no session is active or any action fails parameter validation.',
    annotations: { destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          description:
            'Array of input actions to execute sequentially. Each object must have a "type" field.',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['key', 'mouse_button', 'mouse_motion', 'click_element', 'action', 'wait'],
                description: 'The type of input action',
              },
              key: {
                type: 'string',
                description: '[key] Key name (e.g. "W", "Space", "Escape", "Up")',
              },
              pressed: {
                type: 'boolean',
                description:
                  '[key, mouse_button, action] Whether the input is pressed (true) or released (false)',
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
                description: '[mouse_button, mouse_motion] X position in viewport pixels',
              },
              y: {
                type: 'number',
                description: '[mouse_button, mouse_motion] Y position in viewport pixels',
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
                description: '[action] Action strength (0–1, default 1.0)',
              },
              ms: {
                type: 'number',
                description: '[wait] Duration in milliseconds to pause before the next action',
              },
            },
            required: ['type'],
          },
        },
      },
      required: ['actions'],
    },
  },
  {
    name: 'get_ui_elements',
    description:
      'Walk the running scene tree and return all Control nodes with positions, sizes, types, and text content. Always call this before simulate_input click_element actions to discover valid element names and paths. Requires an active runtime session (run_project or attach_project). visibleOnly defaults true; pass false to include hidden Controls. filter narrows by class. Returns { elements: [{ name, path, type, rect, visible, text?, disabled?, tooltip? }] }.',
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
          description: 'Filter by Control node type (e.g. "Button", "Label", "LineEdit")',
        },
      },
      required: [],
    },
  },
  {
    name: 'run_script',
    description:
      'Execute a custom GDScript in the live running project with full scene tree access. Requires an active runtime session. Script must extend RefCounted and define func execute(scene_tree: SceneTree) -> Variant. Return values are JSON-serialized (primitives, Vector2/3, Color, Dictionary, Array, and Node path strings). Use print() for debug output — it appears in get_debug_output, not in the result. In spawned mode, stderr runtime errors escalate to errors (when the script returns null) or surface as warnings. Returns { success, result, warnings? } where result is the JSON-serialized return value of execute().',
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
          description: 'Timeout in ms (default: 30000). Increase for long-running scripts.',
        },
      },
      required: ['script'],
    },
  },
];

// --- Helpers ---

function ensureRuntimeSession(runner: GodotRunner, actionDescription: string) {
  if (!runner.activeSessionMode || !runner.activeProjectPath) {
    return createErrorResponse(
      `No active runtime session. A project must be running or attached to ${actionDescription}.`,
      [
        'Use run_project to start a Godot project first',
        'Or use attach_project before launching Godot manually',
      ],
    );
  }

  if (
    runner.activeSessionMode === 'spawned' &&
    (!runner.activeProcess || runner.activeProcess.hasExited)
  ) {
    return createErrorResponse(
      `The spawned Godot process has exited and cannot ${actionDescription}.`,
      [
        'Use get_debug_output to inspect the last captured logs',
        'Call stop_project to clean up, then run_project again',
      ],
    );
  }

  return null;
}

// --- Handlers ---

export async function handleLaunchEditor(runner: GodotRunner, args: OperationParams) {
  args = normalizeParameters(args);

  const v = validateProjectArgs(args);
  if ('isError' in v) return v;

  try {
    if (!runner.getGodotPath()) {
      await runner.detectGodotPath();
      if (!runner.getGodotPath()) {
        return createErrorResponse('Could not find a valid Godot executable path', [
          'Ensure Godot is installed correctly',
          'Set GODOT_PATH environment variable',
        ]);
      }
    }

    logDebug(`Launching Godot editor for project: ${v.projectPath}`);
    const process = runner.launchEditor(v.projectPath);

    process.on('error', (err: Error) => {
      console.error('Failed to start Godot editor:', err);
    });

    return {
      content: [
        {
          type: 'text',
          text: `Godot editor launched successfully for project at ${v.projectPath}.\nNote: the editor is a GUI application and cannot be controlled programmatically. Use the scene and node editing tools (add_node, set_node_properties, etc.) to modify the project headlessly without the editor.`,
        },
      ],
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Failed to launch Godot editor: ${errorMessage}`, [
      'Ensure Godot is installed correctly',
      'Check if the GODOT_PATH environment variable is set correctly',
    ]);
  }
}

export async function handleRunProject(runner: GodotRunner, args: OperationParams) {
  args = normalizeParameters(args);

  const v = validateProjectArgs(args);
  if ('isError' in v) return v;

  try {
    const background = args.background === true;
    runner.runProject(v.projectPath, args.scene as string | undefined, background);

    const bridgeResult = await runner.waitForBridge();

    if (!bridgeResult.ready) {
      if (runner.activeProcess && runner.activeProcess.hasExited) {
        return createErrorResponse(
          `Godot process exited before the MCP bridge could initialize.\n${bridgeResult.error || ''}`,
          [
            'Check get_debug_output for runtime errors',
            'Verify a display server is available (Wayland/X11)',
            'Check for broken autoloads with list_autoloads',
            'Call stop_project to clean up, then try again',
          ],
        );
      }

      const lines = [
        `Godot process started, but the MCP bridge did not respond within ${BRIDGE_WAIT_SPAWNED_TIMEOUT_MS / 1000} seconds.`,
        '- The process is still running but the bridge listener never came up — likely an early _ready error or a stuck process holding the port',
        '- Runtime tools will not work against this session',
        '- Call stop_project, then run_project again',
      ];
      if (background) {
        lines.push('- Background mode: window hidden, physical input blocked');
      }
      return createErrorResponse(lines.join('\n'), [
        'Use get_debug_output to inspect the last captured logs',
        'Check for broken autoloads with list_autoloads',
        'Check that the bridge port (default 9900) is not occupied by another Godot process',
        'Call stop_project to clean up, then run_project again',
      ]);
    }

    const lines = [
      'Godot project started and MCP bridge is ready.',
      '- Runtime tools (take_screenshot, simulate_input, get_ui_elements, run_script) are available now',
      '- Use get_debug_output to check runtime output and errors',
      '- Call stop_project when done',
    ];
    if (background) {
      lines.push('- Background mode: window hidden, physical input blocked');
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Failed to run Godot project: ${errorMessage}`, [
      'Ensure Godot is installed correctly',
      'Check if the GODOT_PATH environment variable is set correctly',
    ]);
  }
}

export async function handleAttachProject(runner: GodotRunner, args: OperationParams) {
  args = normalizeParameters(args);

  const v = validateProjectArgs(args);
  if ('isError' in v) return v;

  try {
    await runner.attachProject(v.projectPath);

    const bridgeResult = await runner.waitForBridgeAttached();

    if (!bridgeResult.ready) {
      return createErrorResponse(
        `Project attached but the MCP bridge is not ready.\n${bridgeResult.error || ''}`,
        [
          'If you are launching Godot yourself, run the launch in parallel with attach_project next time so the wait absorbs the startup — do not sequentialize',
          'If a human is launching Godot, retry attach_project once they have launched — bridge.inject is idempotent',
          'If Godot is already running but was launched before the bridge was injected, restart it (autoloads are read at startup)',
          'Check that no other Godot project is occupying the bridge port (default 9900)',
          'Use detach_project or stop_project when done',
        ],
      );
    }

    return {
      content: [
        {
          type: 'text',
          text: [
            'Project attached and MCP bridge is ready.',
            '- Runtime tools (take_screenshot, simulate_input, get_ui_elements, run_script) are available now',
            '- get_debug_output is unavailable in attached mode because MCP did not spawn the process',
            '- Use detach_project or stop_project when done to clean up the injected bridge state',
          ].join('\n'),
        },
      ],
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Failed to attach project: ${errorMessage}`, [
      'Check if project.godot is accessible',
      'Ensure MCP can write the bridge autoload into the project',
    ]);
  }
}

export async function handleDetachProject(runner: GodotRunner) {
  if (runner.activeSessionMode !== 'attached') {
    return createErrorResponse('No attached project to detach.', [
      'Use attach_project first for manual-launch workflows',
      'If MCP launched the game, use stop_project instead',
    ]);
  }

  const result = (await runner.stopProject())!;

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          message: 'Detached attached project and cleaned MCP bridge state',
          externalProcessPreserved: result.externalProcessPreserved === true,
        }),
      },
    ],
  };
}

export function handleGetDebugOutput(runner: GodotRunner, args: OperationParams = {}) {
  args = normalizeParameters(args);

  if (!runner.activeSessionMode) {
    return createErrorResponse('No active runtime session.', [
      'Use run_project to start a Godot project first',
      'Or use attach_project before launching Godot manually',
    ]);
  }

  if (runner.activeSessionMode === 'attached') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            output: [],
            errors: [],
            running: null,
            attached: true,
            tip: 'Attached mode does not capture stdout/stderr because Godot was launched outside MCP.',
          }),
        },
      ],
    };
  }

  const proc = runner.activeProcess;
  if (!proc) {
    return createErrorResponse('No active spawned process is available for debug output.', [
      'Use run_project to start a Godot project first',
      'Or use attach_project only when stdout/stderr capture is not needed',
    ]);
  }

  const limit = typeof args.limit === 'number' ? args.limit : 200;
  const response: {
    output: string[];
    errors: string[];
    running: boolean;
    exitCode?: number | null;
    tip?: string;
  } = {
    output: proc.output.slice(-limit),
    errors: proc.errors.slice(-limit),
    running: !proc.hasExited,
  };

  if (proc.hasExited) {
    response.exitCode = proc.exitCode;
    response.tip =
      'Process has exited. Call stop_project to clean up the process slot before starting a new one.';
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(response),
      },
    ],
  };
}

export async function handleStopProject(runner: GodotRunner) {
  const result = await runner.stopProject();

  if (!result) {
    return createErrorResponse('No active Godot process to stop.', [
      'Use run_project to start a Godot project first',
      'The process may have already terminated',
    ]);
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          message:
            result.mode === 'attached'
              ? 'Attached project detached and MCP bridge state cleaned up'
              : 'Godot project stopped',
          mode: result.mode,
          externalProcessPreserved: result.externalProcessPreserved === true,
          finalOutput: result.output.slice(-200),
          finalErrors: result.errors.slice(-200),
        }),
      },
    ],
  };
}

function parseScreenshotResponseMode(value: unknown): ScreenshotResponseMode | null {
  if (value === undefined) return 'full';
  if (typeof value !== 'string') return null;
  return SCREENSHOT_RESPONSE_MODES.includes(value as ScreenshotResponseMode)
    ? (value as ScreenshotResponseMode)
    : null;
}

function parsePreviewDimension(value: unknown, fallback: number): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.max(1, Math.floor(value));
}

function normalizeScreenshotPath(path: string): string {
  return sep === '\\' ? path.replace(/\//g, '\\') : path;
}

export async function handleTakeScreenshot(runner: GodotRunner, args: OperationParams) {
  args = normalizeParameters(args);

  const sessionError = ensureRuntimeSession(runner, 'take a screenshot');
  if (sessionError) {
    return sessionError;
  }

  const timeout = typeof args.timeout === 'number' ? args.timeout : 10000;
  const responseMode = parseScreenshotResponseMode(args.responseMode);
  if (responseMode === null) {
    return createErrorResponse('Invalid responseMode for take_screenshot', [
      'Use one of: "full", "preview", or "path_only"',
    ]);
  }

  const previewMaxWidth = parsePreviewDimension(args.previewMaxWidth, DEFAULT_PREVIEW_MAX_WIDTH);
  const previewMaxHeight = parsePreviewDimension(args.previewMaxHeight, DEFAULT_PREVIEW_MAX_HEIGHT);
  if (previewMaxWidth === null || previewMaxHeight === null) {
    return createErrorResponse('Invalid preview dimensions for take_screenshot', [
      'previewMaxWidth and previewMaxHeight must be positive numbers',
    ]);
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

    let parsed: ScreenshotBridgeResponse;
    try {
      parsed = JSON.parse(responseStr);
    } catch {
      return createErrorResponse(`Invalid response from screenshot server: ${responseStr}`, [
        'The bridge sent a non-JSON frame — check get_debug_output for runtime errors that may have aborted the response',
        'If the issue persists, call stop_project and run_project again',
      ]);
    }

    if (parsed.error) {
      return createErrorResponse(`Screenshot server error: ${parsed.error}`, [
        'Ensure the project has a viewport (a headless project with no display server cannot render)',
        'Check disk space and permissions on the project directory (.mcp/screenshots/)',
      ]);
    }

    if (!parsed.path) {
      return createErrorResponse('Screenshot server returned no file path', [
        'The bridge response is missing the expected `path` field — this is a bridge bug, not a timing issue',
        'Check get_debug_output for runtime errors during the screenshot save',
      ]);
    }

    // Normalize path for the local filesystem (forward slashes from GDScript)
    const screenshotPath = normalizeScreenshotPath(parsed.path);

    if (!existsSync(screenshotPath)) {
      return createErrorResponse(`Screenshot file not found at: ${screenshotPath}`, [
        'The screenshot may have failed to save',
        'Check disk space and permissions',
      ]);
    }

    const metadata: Record<string, unknown> = {
      responseMode,
      path: parsed.path,
    };
    if (typeof parsed.width === 'number' && typeof parsed.height === 'number') {
      metadata.size = { width: parsed.width, height: parsed.height };
    }

    const content: Array<{ type: string; [key: string]: unknown }> = [];

    if (responseMode === 'full') {
      const imageBuffer = readFileSync(screenshotPath);
      content.push({
        type: 'image',
        data: imageBuffer.toString('base64'),
        mimeType: 'image/png',
      });
    } else if (responseMode === 'preview') {
      if (!parsed.preview_path) {
        return createErrorResponse('Screenshot server returned no preview path', [
          'Ensure the running project has the current McpBridge autoload',
          'Restart the runtime after rebuilding the MCP server',
        ]);
      }
      const previewPath = normalizeScreenshotPath(parsed.preview_path);
      if (!existsSync(previewPath)) {
        return createErrorResponse(`Screenshot preview file not found at: ${previewPath}`, [
          'The preview may have failed to save',
          'Try again, or use responseMode "full" to return the original screenshot',
        ]);
      }
      const previewBuffer = readFileSync(previewPath);
      content.push({
        type: 'image',
        data: previewBuffer.toString('base64'),
        mimeType: 'image/png',
      });
      metadata.previewPath = parsed.preview_path;
      if (typeof parsed.preview_width === 'number' && typeof parsed.preview_height === 'number') {
        metadata.previewSize = { width: parsed.preview_width, height: parsed.preview_height };
      }
    }

    content.push({ type: 'text', text: JSON.stringify(metadata) });

    if (runtimeErrors.length > 0) {
      content.push({
        type: 'text',
        text: JSON.stringify({
          warnings: runtimeErrors.slice(0, MAX_RUNTIME_ERROR_CONTEXT_LINES),
        }),
      });
    }

    return { content };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Failed to take screenshot: ${errorMessage}`, [
      'Check get_debug_output for crash backtraces or runtime errors',
      'If the game has exited, call stop_project, then run_project again',
      'For slow renders, increase the timeout parameter',
    ]);
  }
}

export async function handleSimulateInput(runner: GodotRunner, args: OperationParams) {
  args = normalizeParameters(args);

  const sessionError = ensureRuntimeSession(runner, 'simulate input');
  if (sessionError) {
    return sessionError;
  }

  const actions = args.actions;
  if (!Array.isArray(actions) || actions.length === 0) {
    return createErrorResponse('actions must be a non-empty array of input actions', [
      'Provide at least one action object with a "type" field',
    ]);
  }

  // Calculate timeout: sum of all wait durations + 10s buffer
  let totalWaitMs = 0;
  for (const action of actions) {
    if (
      typeof action === 'object' &&
      action !== null &&
      action.type === 'wait' &&
      typeof action.ms === 'number'
    ) {
      totalWaitMs += action.ms;
    }
  }
  const timeoutMs = totalWaitMs + 10000;

  try {
    const { response: responseStr, runtimeErrors } = await runner.sendCommandWithErrors(
      'input',
      { actions },
      timeoutMs,
    );

    let parsed: { success?: boolean; error?: string; actions_processed?: number };
    try {
      parsed = JSON.parse(responseStr);
    } catch {
      return createErrorResponse(`Invalid response from bridge: ${responseStr}`, [
        'The bridge sent a non-JSON frame — check get_debug_output for runtime errors that may have aborted the response',
        'If the issue persists, call stop_project and run_project again',
      ]);
    }

    if (parsed.error) {
      return createErrorResponse(`Input simulation error: ${parsed.error}`, [
        'Check action types and parameters',
        'Ensure key names are valid Godot key names',
      ]);
    }

    const payload: Record<string, unknown> = {
      success: true,
      actions_processed: parsed.actions_processed,
      tip: 'Call take_screenshot to verify the input had the intended visual effect.',
    };
    if (runtimeErrors.length > 0) {
      payload.warnings = runtimeErrors.slice(0, MAX_RUNTIME_ERROR_CONTEXT_LINES);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(payload),
        },
      ],
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Failed to simulate input: ${errorMessage}`, [
      'Check get_debug_output for crash backtraces or runtime errors (a signal handler firing on input may have crashed the game)',
      'If the game has exited, call stop_project, then run_project again',
    ]);
  }
}

export async function handleGetUiElements(runner: GodotRunner, args: OperationParams) {
  args = normalizeParameters(args);

  const sessionError = ensureRuntimeSession(runner, 'query UI elements');
  if (sessionError) {
    return sessionError;
  }

  const visibleOnly = args.visibleOnly !== false;

  try {
    const cmdParams: Record<string, unknown> = { visible_only: visibleOnly };
    if (args.filter) cmdParams.type_filter = args.filter;
    const { response: responseStr, runtimeErrors } = await runner.sendCommandWithErrors(
      'get_ui_elements',
      cmdParams,
    );

    let parsed: { elements?: unknown[]; error?: string };
    try {
      parsed = JSON.parse(responseStr);
    } catch {
      return createErrorResponse(`Invalid response from bridge: ${responseStr}`, [
        'The bridge sent a non-JSON frame — check get_debug_output for runtime errors that may have aborted the response',
        'If the issue persists, call stop_project and run_project again',
      ]);
    }

    if (parsed.error) {
      return createErrorResponse(`UI element query error: ${parsed.error}`, [
        'Ensure the game has a UI with Control nodes',
      ]);
    }

    const payload: Record<string, unknown> = {
      ...parsed,
      tip: "Use simulate_input with type 'click_element' and a node_path or node name from this list to interact with these elements.",
    };
    if (runtimeErrors.length > 0) {
      payload.warnings = runtimeErrors.slice(0, MAX_RUNTIME_ERROR_CONTEXT_LINES);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(payload),
        },
      ],
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Failed to get UI elements: ${errorMessage}`, [
      'Check get_debug_output for crash backtraces or runtime errors',
      'If the game has exited, call stop_project, then run_project again',
    ]);
  }
}

export async function handleRunScript(runner: GodotRunner, args: OperationParams) {
  args = normalizeParameters(args);

  const sessionError = ensureRuntimeSession(runner, 'execute scripts');
  if (sessionError) {
    return sessionError;
  }

  const script = args.script;
  if (typeof script !== 'string' || script.trim() === '') {
    return createErrorResponse('script is required and must be a non-empty string', [
      'Provide GDScript source code with extends RefCounted and func execute(scene_tree: SceneTree) -> Variant',
    ]);
  }

  if (!script.includes('func execute')) {
    return createErrorResponse(
      'Script must define func execute(scene_tree: SceneTree) -> Variant',
      ['Add a func execute(scene_tree: SceneTree) -> Variant method to your script'],
    );
  }

  // Write script to .mcp/scripts/ for audit trail
  try {
    const projectPath = runner.activeProjectPath;
    if (projectPath) {
      const scriptsDir = join(projectPath, '.mcp', 'scripts');
      mkdirSync(scriptsDir, { recursive: true });
      const timestamp = Date.now();
      const scriptFile = join(scriptsDir, `${timestamp}-${randomUUID()}.gd`);
      writeFileSync(scriptFile, script, 'utf8');
      logDebug(`Saved script to ${scriptFile}`);
    }
  } catch (error) {
    logDebug(`Failed to save script for audit: ${error}`);
  }

  const timeout = typeof args.timeout === 'number' ? args.timeout : 30000;

  try {
    const { response: responseStr, runtimeErrors } = await runner.sendCommandWithErrors(
      'run_script',
      { source: script },
      timeout,
    );

    let parsed: { success?: boolean; result?: unknown; error?: string };
    try {
      parsed = JSON.parse(responseStr);
    } catch {
      return createErrorResponse(`Invalid response from bridge: ${responseStr}`, [
        'The script may have produced non-JSON output',
        'Check get_debug_output for print() statements',
      ]);
    }

    if (parsed.error) {
      return createErrorResponse(`Script execution error: ${parsed.error}`, [
        'Check your GDScript syntax',
        'Ensure the script extends RefCounted',
        'Check get_debug_output for details',
      ]);
    }

    // Detect false-positive success: GDScript has no try-catch, so runtime errors
    // return null and the real error only appears in stderr.
    if (parsed.success && parsed.result === null && runner.activeSessionMode === 'spawned') {
      if (runtimeErrors.length > 0) {
        const errorContext = runtimeErrors.slice(0, MAX_RUNTIME_ERROR_CONTEXT_LINES).join('\n');
        return createErrorResponse(`Script runtime error detected:\n${errorContext}`, [
          'Fix the GDScript error in your script and retry',
          'Use get_debug_output for full process output',
        ]);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              result: null,
              warning:
                'Script returned null. If unexpected, check get_debug_output for runtime errors — GDScript does not propagate exceptions.',
              tip: 'Call take_screenshot to verify any visual changes, or get_debug_output to review print() output from your script.',
            }),
          },
        ],
      };
    }

    const payload: Record<string, unknown> = {
      success: true,
      result: parsed.result,
      tip: 'Call take_screenshot to verify any visual changes, or get_debug_output to review print() output from your script.',
    };
    if (runtimeErrors.length > 0) {
      payload.warnings = runtimeErrors.slice(0, MAX_RUNTIME_ERROR_CONTEXT_LINES);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(payload),
        },
      ],
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Failed to execute script: ${errorMessage}`, [
      'Check get_debug_output for crash backtraces or runtime errors raised inside the script',
      'If the game has exited, call stop_project, then run_project again',
      'For long-running scripts, increase the timeout parameter',
    ]);
  }
}
