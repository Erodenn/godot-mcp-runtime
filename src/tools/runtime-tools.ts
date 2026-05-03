import { join, sep } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import type { GodotRunner, OperationParams, ToolDefinition } from '../utils/godot-runner.js';
import {
  normalizeParameters,
  validateProjectArgs,
  createErrorResponse,
  logDebug,
} from '../utils/godot-runner.js';

const MAX_RUNTIME_ERROR_CONTEXT_LINES = 30;

// --- Tool definitions ---

export const runtimeToolDefinitions: ToolDefinition[] = [
  {
    name: 'launch_editor',
    description:
      'Open the Godot editor GUI for a project for the human user. Use only when the user explicitly asks to "open the editor"; for any agent-driven work, use the headless scene/node tools (add_node, set_node_properties, etc.) instead — the editor cannot be controlled programmatically. Returns immediately after spawning. Errors if projectPath has no project.godot.',
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
      'Spawn a Godot project as a child process with stdout/stderr captured. This is the preferred entry to runtime tools — use whenever MCP can launch the game itself. Required before take_screenshot, simulate_input, get_ui_elements, run_script, or get_debug_output. For a Godot process you launched yourself (debugger attached, custom flags, IDE run), use attach_project instead. Verifies MCP bridge readiness before returning success. Call stop_project when done. Errors if projectPath is not a Godot project or another run is already active.',
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
      'Attach runtime MCP tools to a manually launched Godot process without spawning one. Use this only when the user is running Godot themselves (debugger attached, custom CLI flags, IDE run) — for the standard case, use run_project. Injects the McpBridge autoload and marks the project active. Call once before launching Godot, then again with waitForBridge:true after launch to confirm the bridge is listening (up to 15s). Use detach_project or stop_project when done. get_debug_output is unavailable in attached mode (stdout/stderr not captured).',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Path to the Godot project directory',
        },
        waitForBridge: {
          type: 'boolean',
          description:
            'If true, poll the bridge until it responds (up to 15 seconds). Use this after Godot is already running to confirm runtime tools are ready. Defaults to false.',
        },
      },
      required: ['projectPath'],
    },
  },
  {
    name: 'detach_project',
    description:
      'Clear attached-mode runtime state and remove the injected McpBridge autoload. Does NOT stop the manually launched Godot process — that stays running. Use after attach_project when you are done driving the game from MCP. For spawned sessions (run_project), use stop_project instead. No-op if no attached session exists.',
    annotations: { destructiveHint: true, idempotentHint: true },
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
      'Stop the spawned Godot project and clean up MCP bridge state. Always call when done with runtime testing — even after a crash — to free the single process slot so run_project can be called again. For attached sessions, this detaches without killing the externally launched process. No-op if no session is active.',
    annotations: { destructiveHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'take_screenshot',
    description:
      'Capture a PNG screenshot of the running Godot viewport. Use after simulate_input or run_script to verify visual changes. Requires an active runtime session (run_project or attach_project). Returns the image inline as base64. Also saved to .mcp/screenshots/ in the project directory for later reference. Errors if no session is active or the bridge does not respond within timeout (default 10000ms).',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds to wait for the screenshot (default: 10000)',
        },
      },
      required: [],
    },
  },
  {
    name: 'simulate_input',
    description:
      'Simulate batched sequential input in a running Godot project. Requires an active runtime session (run_project or attach_project). Use get_ui_elements first to discover element names and paths for click_element actions.\n\nEach action object requires a "type" field. Valid types and their specific fields:\n- key: keyboard event (key: string, pressed: bool, shift/ctrl/alt: bool)\n- mouse_button: click at coordinates (x, y: number, button: "left"|"right"|"middle", pressed: bool, double_click: bool)\n- mouse_motion: move cursor (x, y: number, relative_x, relative_y: number)\n- click_element: click a UI element by node path or node name (element: string, button, double_click)\n- action: fire a Godot input action (action: string, pressed: bool, strength: 0–1)\n- wait: pause between actions (ms: number)\n\nExamples:\n1. Press and release Space: [{type:"key",key:"Space",pressed:true},{type:"wait",ms:100},{type:"key",key:"Space",pressed:false}]\n2. Click a UI button (discover path with get_ui_elements first): [{type:"click_element",element:"StartButton"}]\n3. Left-click at viewport coordinates: [{type:"mouse_button",x:400,y:300,button:"left",pressed:true},{type:"mouse_button",x:400,y:300,button:"left",pressed:false}]\n4. Fire a Godot action: [{type:"action",action:"jump",pressed:true},{type:"wait",ms:200},{type:"action",action:"jump",pressed:false}]\n5. Type "hello": [{type:"key",key:"H",pressed:true},{type:"key",key:"H",pressed:false},{type:"key",key:"E",pressed:true},{type:"key",key:"E",pressed:false},{type:"key",key:"L",pressed:true},{type:"key",key:"L",pressed:false},{type:"key",key:"L",pressed:true},{type:"key",key:"L",pressed:false},{type:"key",key:"O",pressed:true},{type:"key",key:"O",pressed:false}]\n\nReturns { success, actions_processed, warnings? }. Errors if no runtime session is active.',
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
      'Execute a custom GDScript in the live running project with full scene tree access. Requires run_project first. Script must extend RefCounted and define func execute(scene_tree: SceneTree) -> Variant. Return values are JSON-serialized (primitives, Vector2/3, Color, Dictionary, Array, and Node path strings are supported). Use print() for debug output — it appears in get_debug_output, not in the script result. In spawned mode, runtime errors emitted to stderr are detected and either escalated (when the script returns null) or surfaced as warnings. In attached mode a null result includes a caveat since stderr is not captured.',
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
        'Godot process started, but the MCP bridge did not respond within 8 seconds.',
        '- The process is running — bridge may still be initializing',
        '- Use get_debug_output to investigate',
        '- Runtime tools may work if you retry after a moment',
        '- Call stop_project when done',
      ];
      if (background) {
        lines.push('- Background mode: window hidden, physical input blocked');
      }
      return createErrorResponse(lines.join('\n'), [
        'Use get_debug_output to inspect the last captured logs',
        'Check that UDP port 9900 is not occupied by another Godot process',
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
    runner.attachProject(v.projectPath);

    if (args.waitForBridge === true) {
      const bridgeResult = await runner.waitForBridgeAttached();

      if (!bridgeResult.ready) {
        return createErrorResponse(
          `Project attached but the MCP bridge is not ready.\n${bridgeResult.error || ''}`,
          [
            'Verify Godot is running with this project',
            'The McpBridge autoload must be initialized and listening on UDP port 9900',
            'Check that no other Godot project is occupying port 9900',
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
    }

    return {
      content: [
        {
          type: 'text',
          text: [
            'Project attached for manual runtime use.',
            '- Launch Godot yourself, then call attach_project again with waitForBridge: true to confirm readiness',
            '- Or use runtime tools directly — they will fail with a clear error if the bridge is not yet listening',
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

export function handleDetachProject(runner: GodotRunner) {
  if (runner.activeSessionMode !== 'attached') {
    return createErrorResponse('No attached project to detach.', [
      'Use attach_project first for manual-launch workflows',
      'If MCP launched the game, use stop_project instead',
    ]);
  }

  const result = runner.stopProject()!;

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

export function handleStopProject(runner: GodotRunner) {
  const result = runner.stopProject();

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

export async function handleTakeScreenshot(runner: GodotRunner, args: OperationParams) {
  args = normalizeParameters(args);

  const sessionError = ensureRuntimeSession(runner, 'take a screenshot');
  if (sessionError) {
    return sessionError;
  }

  const timeout = typeof args.timeout === 'number' ? args.timeout : 10000;

  try {
    const { response: responseStr, runtimeErrors } = await runner.sendCommandWithErrors(
      'screenshot',
      {},
      timeout,
    );

    let parsed: { path?: string; error?: string };
    try {
      parsed = JSON.parse(responseStr);
    } catch {
      return createErrorResponse(`Invalid response from screenshot server: ${responseStr}`, [
        'The game may not have fully initialized yet',
        'Try again after a few seconds',
      ]);
    }

    if (parsed.error) {
      return createErrorResponse(`Screenshot server error: ${parsed.error}`, [
        'Ensure the game viewport is active',
        'Try again after a moment',
      ]);
    }

    if (!parsed.path) {
      return createErrorResponse('Screenshot server returned no file path', [
        'Try again after a few seconds',
      ]);
    }

    // Normalize path for the local filesystem (forward slashes from GDScript)
    const screenshotPath = sep === '\\' ? parsed.path.replace(/\//g, '\\') : parsed.path;

    if (!existsSync(screenshotPath)) {
      return createErrorResponse(`Screenshot file not found at: ${screenshotPath}`, [
        'The screenshot may have failed to save',
        'Check disk space and permissions',
      ]);
    }

    const imageBuffer = readFileSync(screenshotPath);
    const base64Data = imageBuffer.toString('base64');

    const content: Array<{ type: string; [key: string]: unknown }> = [
      {
        type: 'image',
        data: base64Data,
        mimeType: 'image/png',
      },
      {
        type: 'text',
        text: `Screenshot saved to: ${parsed.path}`,
      },
    ];

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
      'Ensure the project is running (use run_project first)',
      'The bridge may not be ready yet — use get_debug_output to investigate',
      'Check that UDP port 9900 is not blocked',
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
        'The game may not have fully initialized yet',
        'Try again after a few seconds',
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
      'Ensure the project is running (use run_project first)',
      'The bridge may not be ready yet — use get_debug_output to investigate',
      'Check that UDP port 9900 is not blocked',
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
        'The game may not have fully initialized yet',
        'Try again after a few seconds',
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
      'Ensure the project is running (use run_project first)',
      'The bridge may not be ready yet — use get_debug_output to investigate',
      'Check that UDP port 9900 is not blocked',
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
      const scriptFile = join(scriptsDir, `${timestamp}.gd`);
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
      'Ensure the project is running (use run_project first)',
      'The bridge may not be ready yet — wait 2-3 seconds after starting, then check get_debug_output if the issue persists',
      'Check that UDP port 9900 is not blocked',
      'For long-running scripts, increase the timeout parameter',
    ]);
  }
}
