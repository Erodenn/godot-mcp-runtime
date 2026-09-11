import { join, sep, resolve, relative } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import type { GodotRunner } from '../utils/godot-runner.js';
import { BRIDGE_WAIT_SPAWNED_TIMEOUT_MS } from '../utils/bridge-protocol.js';
import type { HandlerResult, OperationParams, ToolDefinition, ToolResponse } from '../mcp.types.js';
import { normalizeParameters } from '../utils/parameter-conversion.js';
import {
  validateSubPath,
  isUnderDir,
  projectGodotPath,
  stripResPrefix,
} from '../utils/path-validation.js';
import { createErrorResponse, getErrorMessage } from '../utils/error-response.js';
import { createStructuredResponse } from '../utils/structured-response.js';
import {
  parseProjectArgs,
  optionalString,
  optionalNumber,
  optionalBoolean,
  requireString,
  requireArray,
} from '../utils/arg-parsing.js';
import { ok, err, type Result } from '../utils/result.js';
import { logDebug } from '../utils/logger.js';
import { parseScriptDiagnostics, condenseProcessTail } from '../utils/output-parsing.js';
import { randomUUID } from 'crypto';
import {
  createNullContext,
  normalizeProjectKey,
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
import { parseAutoloads } from '../utils/autoload-ini.js';
import { collectSceneScriptsRecursive, resolveLaunchScene } from '../utils/scene-parsing.js';

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

export const runtimeToolDefinitions = [
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
      'Spawn a Godot project as a child process with stdout/stderr captured. Required before take_screenshot, simulate_input, get_ui_elements, run_script, or get_debug_output. Set profiling: true at launch to enable the profiler tools. Use attach_project for one you launched yourself. Verifies MCP bridge readiness before returning success. Returns status with the assigned bridge port. Call stop_project when done. Errors if projectPath is not a Godot project or another session is already active.',
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
        bridgePort: {
          type: 'number',
          minimum: 1,
          maximum: 65535,
          description:
            "TCP port for the MCP bridge. Omit to auto-select a free port (recommended). The chosen port is baked into the project's `mcp_bridge.gd` at inject time, so the running Godot listens on exactly this port.",
        },
        profiling: {
          type: 'boolean',
          description:
            "Attach Godot's own remote debugger so profile_project, start_profiler and stop_profiler can measure this session. Must be set at launch — a session already running cannot be profiled — and costs a little runtime overhead.",
        },
      },
      required: ['projectPath'],
    },
  },
  {
    name: 'attach_project',
    description:
      'Inject the MCP bridge into a Godot process you launch yourself, then wait up to 15s for the bridge to respond. Call BEFORE Godot launches — Godot reads autoloads only at process start, so a late call returns "bridge did not respond." Recommended pattern: kick off the Godot launch in parallel with this call so the wait absorbs startup. Prefer run_project unless MCP must not spawn Godot. Returns plain-text status with the resolved bridge port. Call detach_project or stop_project when done.',
    annotations: { destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Path to the Godot project directory',
        },
        bridgePort: {
          type: 'number',
          minimum: 1,
          maximum: 65535,
          description:
            "TCP port for the MCP bridge. Omit to auto-select a free port (recommended). The chosen port is baked into the project's `mcp_bridge.gd` at inject time, so the running Godot listens on exactly this port.",
        },
      },
      required: ['projectPath'],
    },
  },
  {
    name: 'detach_project',
    description:
      'Clear attached-mode runtime state and remove the injected McpBridge autoload. Does NOT stop the manually launched Godot process — that stays running. Use after attach_project when you are done driving the game from MCP. For spawned sessions (run_project), use stop_project instead. Returns: message confirming detach plus externalProcessPreserved (always true here — that is the point of detach vs stop_project). Errors if called outside an attached session.',
    annotations: { destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    outputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        externalProcessPreserved: { type: 'boolean' },
      },
    },
  },
  {
    name: 'get_debug_output',
    description:
      'Get captured stdout/stderr from a spawned Godot project. Use whenever runtime tools fail unexpectedly — script errors, missing nodes, and crash backtraces all surface here. Requires run_project (not attach_project; attached mode does not capture output). Returns: output/errors (last `limit` lines each, default 200), running (false after exit, null when attached), exitCode after exit, attached:true with empty arrays in attached mode.',
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
        output: { type: 'array', items: { type: 'string' } },
        errors: { type: 'array', items: { type: 'string' } },
        running: { type: ['boolean', 'null'] },
        exitCode: { type: ['number', 'null'] },
        attached: { type: 'boolean' },
        tip: { type: 'string' },
      },
    },
  },
  {
    name: 'stop_project',
    description:
      'Stop the spawned Godot project and clean up MCP bridge state. Always call when done with runtime testing, even after a crash, to free the process slot for run_project. Attached sessions detach without killing the external process. Returns: message, mode ("spawned"/"attached"), externalProcessPreserved (true only for attached), and condensed finalOutput/finalErrors (blank and startup-banner lines dropped, capped at 200 lines); get_debug_output has the full log. Errors if no session is active.',
    annotations: { destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    outputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        mode: { type: 'string' },
        externalProcessPreserved: { type: 'boolean' },
        finalOutput: { type: 'array', items: { type: 'string' } },
        finalErrors: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'take_screenshot',
    description:
      'Capture a PNG of the running viewport. responseMode: preview (default — saves full PNG, returns bounded inline preview at 960x540), full (full inline PNG; use for small text or pixel-level inspection), path_only (saved-path only, no inline image). Saved under .mcp/screenshots. Returns: inline image block (full/preview modes), plus path and size of the saved PNG; previewPath/previewSize in preview mode; warnings for non-fatal runtime errors. Errors if no session or bridge times out (default 10000ms).',
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
            'Response payload mode. "preview" returns a bounded inline preview plus paths (default). "full" returns the full inline PNG. "path_only" returns paths only.',
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
    // The handler also emits an inline `image` content block for full/preview modes;
    // outputSchema only describes the structured JSON text payload per MCP spec.
    outputSchema: {
      type: 'object',
      properties: {
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
        warnings: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'simulate_input',
    description:
      "Simulate sequential input in a running project. Each action's `type` (key, mouse_button, mouse_motion, click_element, action, wait) gates which other fields apply — see per-property docs. For click_element use get_ui_elements first; resolution is by path/name, not visible text. Press/release require two actions; insert wait between for frame ticks. Returns: success, actions_processed, warnings for runtime errors fired by input handlers. Errors if no session or any action fails validation.",
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
                description:
                  '[key] Godot KEY_* constant name without the prefix (e.g. "W", "Space", "Escape", "Enter", "Tab", "Up", "PageUp"). Errors on unrecognized names.',
              },
              pressed: {
                type: 'boolean',
                description:
                  '[key, mouse_button, action] Whether the input is pressed (true) or released (false). For mouse_button: omit to auto-click (press+release in one action); set explicitly only for hold/release. For key: defaults to true and does NOT auto-release — emit a second action with pressed:false to release.',
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
                description: '[action] Action strength (0–1, default 1.0)',
              },
              ms: {
                type: 'number',
                description:
                  '[wait] Duration in milliseconds to pause before the next action (~16ms = one frame at 60fps).',
              },
            },
            required: ['type'],
          },
        },
      },
      required: ['actions'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        actions_processed: { type: 'number' },
        warnings: { type: 'array', items: { type: 'string' } },
        tip: { type: 'string' },
      },
    },
  },
  {
    name: 'get_ui_elements',
    description:
      'Walk the running scene tree and return all Control nodes with positions, sizes, types, and text content. Always call this before simulate_input click_element actions to discover valid element names and paths. Requires an active runtime session (run_project or attach_project). visibleOnly defaults true; pass false to include hidden Controls. filter narrows by class. Returns: elements[] with path/type/rect/visible plus optional text/disabled/tooltip.',
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
    outputSchema: {
      type: 'object',
      properties: {
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
    },
  },
  {
    name: 'run_script',
    description:
      'Execute a custom GDScript in the live running project with full scene tree access. Requires an active runtime session. Script must extend RefCounted and define func execute(scene_tree: SceneTree) -> Variant. Return values are JSON-serialized (primitives, Vector2/3, Color, Dictionary, Array, and Node path strings). Use print() for debug output — it appears in get_debug_output, not in the result. In spawned mode, stderr runtime errors escalate to errors (when the script returns null) or surface as warnings. Returns: { success, result, warnings?, tip? } where result is the JSON-serialized return value of execute().',
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
    outputSchema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        result: {},
        warnings: { type: 'array', items: { type: 'string' } },
        tip: { type: 'string' },
      },
    },
  },
] as const satisfies readonly ToolDefinition[];

// --- Helpers ---

const MAX_RUNTIME_ERROR_CONTEXT_LINES = 30;
const MAX_POLICY_SOLUTIONS = 4;
const MAX_STRICT_REJECT_LINES_SHOWN = 5;
const MAX_SCAN_WARNINGS_SHOWN = 10;

function formatMoreFindingsSuffix(total: number): string {
  if (total <= 1) return '';
  const extra = total - 1;
  return ` (+${extra} more finding${extra > 1 ? 's' : ''})`;
}

function isElicitAccepted(result: ElicitorResult): boolean {
  return (
    result.action === 'accept' && (result.content === undefined || result.content.confirm === true)
  );
}

/**
 * Parse a JSON frame returned by the McpBridge. On failure, returns the
 * canonical `Result<T, ToolResponse>` so handlers can short-circuit with
 * `return parsed` on the err branch (the inner `error` is already a structured
 * MCP error response). `context` should describe which bridge command produced
 * the frame.
 */
function parseBridgeJson<T = unknown>(
  responseStr: string,
  context: string,
): Result<T, ToolResponse> {
  try {
    return ok(JSON.parse(responseStr) as T);
  } catch (error) {
    return err(
      createErrorResponse(`Invalid response from bridge (${context}): ${getErrorMessage(error)}`, [
        'The bridge returned non-JSON data — check Godot stderr via get_debug_output',
        'Restart the project with stop_project followed by run_project',
      ]),
    );
  }
}

/**
 * Attach captured runtime errors as a `warnings` array on a tool response
 * payload. No-op when there are no runtime errors. Truncates to
 * `MAX_RUNTIME_ERROR_CONTEXT_LINES` to keep payloads bounded.
 */
function attachRuntimeWarnings(target: Record<string, unknown>, runtimeErrors: string[]): void {
  if (runtimeErrors.length > 0) {
    target.warnings = runtimeErrors.slice(0, MAX_RUNTIME_ERROR_CONTEXT_LINES);
  }
}

/**
 * Type used for the `decision` field of the audit sidecar. Adds three synthetic
 * values that `PolicyDecision.decision` never carries — `elicit_denied`,
 * `elicit_accepted`, and `elicit_bypassed` are derived from the elicitation
 * outcome by the handler. `elicit_bypassed` records a Tier 2 finding that ran
 * without a prompt because elicitation was disabled (GODOT_MCP_DISABLE_ELICITATION),
 * distinct from a user-confirmed `elicit_accepted`. Keeping them distinct from
 * `warn` preserves the confirmation event in the audit trail.
 */
type AuditDecision =
  | 'hard_block'
  | 'elicit_denied'
  | 'elicit_accepted'
  | 'elicit_bypassed'
  | 'warn'
  | 'ok';

interface AuditSidecar {
  decision: AuditDecision;
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
 * Write the audit pair (.gd + .policy.json) to `.mcp/scripts/`. Both writes
 * are best-effort — failures are logged via `logDebug` and never propagate,
 * matching the pre-existing `run_script` audit contract.
 */
function writeAuditSidecar(
  projectPath: string,
  script: string,
  decision: AuditDecision,
  policy: PolicyDecision,
  strictMode: boolean,
): void {
  try {
    const projectRoot = resolve(projectPath);
    const scriptsDir = resolve(join(projectRoot, '.mcp', 'scripts'));
    if (!isUnderDir(projectRoot, scriptsDir)) {
      logDebug(
        `Sidecar write skipped: resolved script dir ${scriptsDir} escapes projectRoot ${projectRoot}`,
      );
      return;
    }
    mkdirSync(scriptsDir, { recursive: true });
    const baseName = `${Date.now()}-${randomUUID()}`;
    const scriptFile = join(scriptsDir, `${baseName}.gd`);
    writeFileSync(scriptFile, script, 'utf8');

    const sidecar: AuditSidecar = {
      decision,
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
    const sidecarFile = join(scriptsDir, `${baseName}.policy.json`);
    writeFileSync(sidecarFile, JSON.stringify(sidecar, null, 2), 'utf8');
    logDebug(`Saved script + policy sidecar to ${scriptFile}`);
  } catch (error) {
    logDebug(`Failed to write audit sidecar: ${error}`);
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

/**
 * Build a one-line summary of a project-scan finding so `run_project` can
 * attach a `warnings` array without flooding the response. Out-of-tree paths
 * are surfaced verbatim (path.relative would emit `..`-prefixed strings that
 * obscure where the file actually lives).
 */
function formatScanFinding(sourcePath: string, projectPath: string, match: PolicyMatch): string {
  const rel = isUnderDir(projectPath, sourcePath) ? relative(projectPath, sourcePath) : sourcePath;
  return `${rel}:${match.line} ${match.matchedText} — ${match.reason}`;
}

/**
 * Scan a single .gd file. Missing/unreadable files are reported as a single
 * warning string (the second tuple element); the caller decides whether to
 * surface them. Tier and strict promotion semantics match `evaluateScript`.
 */
function scanScriptFile(
  filePath: string,
  strict: boolean,
): { findings: PolicyMatch[]; warning: string | null } {
  let source: string;
  try {
    source = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { findings: [], warning: `Could not scan ${filePath} (file not found)` };
    }
    return {
      findings: [],
      warning: `Could not scan ${filePath}: ${getErrorMessage(error)}`,
    };
  }
  const decision = evaluateScript(source, strict);
  return { findings: decision.matches, warning: null };
}

function ensureRuntimeSession(
  runner: GodotRunner,
  actionDescription: string,
): HandlerResult | null {
  if (!runner.activeSessionMode || !runner.activeProjectPath) {
    return err(
      createErrorResponse(
        `No active runtime session. A project must be running or attached to ${actionDescription}.`,
        [
          'Use run_project to start a Godot project first',
          'Or use attach_project before launching Godot manually',
        ],
      ),
    );
  }

  if (
    runner.activeSessionMode === 'spawned' &&
    (!runner.activeProcess || runner.activeProcess.hasExited)
  ) {
    return err(
      createErrorResponse(`The spawned Godot process has exited and cannot ${actionDescription}.`, [
        'Use get_debug_output to inspect the last captured logs',
        'Call stop_project to clean up, then run_project again',
      ]),
    );
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

    return ok({
      content: [
        {
          type: 'text',
          text: `Godot editor launched successfully for project at ${parsed.value.projectPath}.\nNote: the editor is a GUI application and cannot be controlled programmatically. Use the scene and node editing tools (add_node, set_node_properties, etc.) to modify the project headlessly without the editor.`,
        },
      ],
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

  const scene = optionalString(args, 'scene');
  if (!scene.ok) return scene;

  if (scene.value !== undefined) {
    if (!validateSubPath(projectPath, scene.value)) {
      return err(
        createErrorResponse(
          `Invalid scene path: must be project-relative without ".." (got: ${scene.value})`,
          ['Pass scene as a path relative to the project root, e.g. "scenes/main.tscn"'],
        ),
      );
    }
  }

  // Pre-flight security scan: autoloads + the launched scene's scripts,
  // scanning transitively into every PackedScene it instances (subscene
  // recursion — see collectSceneScriptsRecursive). Result is a list of
  // findings + a list of scan warnings (file-not-found, read errors,
  // "no launchable scene"); both flow into the response warnings array.
  // Strict mode + any Tier 1 finding → hard reject before launch.
  const scanWarnings: string[] = [];
  const scanFindings: Array<{ sourcePath: string; match: PolicyMatch }> = [];
  const absProjectPath = resolve(projectPath);
  try {
    const projectGodot = projectGodotPath(absProjectPath);
    if (existsSync(projectGodot)) {
      const autoloads = parseAutoloads(projectGodot);
      for (const entry of autoloads) {
        const stripped = stripResPrefix(entry.path);
        if (!stripped.endsWith('.gd')) continue;
        if (!validateSubPath(absProjectPath, stripped)) {
          scanWarnings.push(
            `Skipped autoload ${entry.name}: path "${entry.path}" escapes project root.`,
          );
          continue;
        }
        const filePath = join(absProjectPath, stripped);
        const { findings, warning } = scanScriptFile(filePath, ctx.strictMode);
        if (warning) scanWarnings.push(warning);
        for (const m of findings) {
          scanFindings.push({ sourcePath: filePath, match: m });
        }
      }
    }
    const launchScene = resolveLaunchScene(absProjectPath, scene.value);
    if (launchScene === null) {
      scanWarnings.push(
        'No launchable scene found (no `run/main_scene` and no explicit scene arg); scene-script scan skipped.',
      );
    } else if (!existsSync(launchScene)) {
      scanWarnings.push(
        `Configured launch scene not found at ${launchScene}; scene-script scan skipped.`,
      );
    } else {
      const scripts = collectSceneScriptsRecursive(launchScene, absProjectPath);
      for (const filePath of scripts) {
        if (!isUnderDir(absProjectPath, filePath)) {
          scanWarnings.push(`Skipped scene script: "${filePath}" escapes project root.`);
          continue;
        }
        const { findings, warning } = scanScriptFile(filePath, ctx.strictMode);
        if (warning) scanWarnings.push(warning);
        for (const m of findings) {
          scanFindings.push({ sourcePath: filePath, match: m });
        }
      }
    }
  } catch (error) {
    scanWarnings.push(`run_project pre-flight scan failed: ${getErrorMessage(error)}`);
  }

  const hasTier1 = scanFindings.some((f) => f.match.tier === 1);
  if (ctx.strictMode && hasTier1) {
    const top = scanFindings
      .filter((f) => f.match.tier === 1)
      .slice(0, MAX_STRICT_REJECT_LINES_SHOWN);
    const summary = top.map((f) => formatScanFinding(f.sourcePath, absProjectPath, f.match));
    const more =
      scanFindings.length > top.length ? ` (+${scanFindings.length - top.length} more)` : '';
    return err(
      createErrorResponse(
        [
          `Strict mode: refusing to launch project because autoload or launched-scene scripts contain Tier 1 primitives${more}.`,
          ...summary.map((s) => `- ${s}`),
        ].join('\n'),
        [
          'Remove or refactor the flagged primitives',
          'Unset GODOT_MCP_STRICT to launch with warnings (Tier 1 findings will surface in `warnings`)',
        ],
      ),
    );
  }

  // Session-confirmation gate: one elicitation per absolute projectPath per
  // server session. Skipped when an active runtime session already targets
  // the same project (the user just attached/ran).
  const projectKey = normalizeProjectKey(absProjectPath);
  if (!ctx.sessionState.runProjectConfirmed.has(projectKey)) {
    if (ctx.disableElicitation) {
      // Elicitation disabled by the operator (GODOT_MCP_DISABLE_ELICITATION). Skip the
      // blanket confirmation gate and launch with a recorded warning. The
      // tiered scan above is the real security boundary; the gate is UX.
      scanWarnings.push(
        'Elicitation disabled (GODOT_MCP_DISABLE_ELICITATION); launching without user confirmation.',
      );
      ctx.sessionState.runProjectConfirmed.add(projectKey);
    } else {
      let elicitResult: ElicitorResult;
      try {
        elicitResult = await ctx.elicitor({
          message:
            'Launching a Godot project executes arbitrary code in its autoloads and main scene. Proceed?',
          requestedSchema: {
            type: 'object',
            properties: {
              confirm: { type: 'boolean', description: 'Allow run_project to launch the project' },
            },
            required: ['confirm'],
          },
        });
      } catch (error) {
        const elicitMsg = `Elicitation unavailable (${getErrorMessage(error)})`;
        if (ctx.strictMode) {
          return err(
            createErrorResponse(
              `${elicitMsg}; strict mode refuses to launch without explicit user confirmation.`,
              [
                'Unset GODOT_MCP_STRICT to launch without confirmation',
                'Use an MCP client that supports elicitation',
              ],
            ),
          );
        }
        // Elicitation unsupported — fall through with a recorded warning. The
        // tiered scan above is the real security boundary; the gate is UX.
        scanWarnings.push(`${elicitMsg}; launching without explicit user confirmation.`);
        elicitResult = { action: 'accept', content: { confirm: true } };
      }
      if (!isElicitAccepted(elicitResult)) {
        // A `cancel` action means the client dismissed the prompt without an
        // explicit choice. Some clients (e.g. Claude Desktop) auto-cancel
        // elicitation without ever displaying it, so distinguish it from an
        // explicit `decline` and point the user at the opt-out.
        const cancelled = elicitResult.action === 'cancel';
        return err(
          createErrorResponse(
            cancelled
              ? 'run_project confirmation was cancelled without an explicit choice. Some MCP clients (e.g. Claude Desktop) auto-cancel elicitation prompts instead of displaying them.'
              : 'User declined run_project. The project was not launched.',
            [
              'Retry run_project once you intend to launch the project',
              'If your client cannot display confirmation prompts, set GODOT_MCP_DISABLE_ELICITATION=true to skip them',
            ],
          ),
        );
      }
      ctx.sessionState.runProjectConfirmed.add(projectKey);
    }
  }

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

  const bridgePort = optionalNumber(args, 'bridgePort');
  if (!bridgePort.ok) return bridgePort;
  if (bridgePort.value !== undefined) {
    if (!Number.isInteger(bridgePort.value) || bridgePort.value < 1 || bridgePort.value > 65535) {
      return err(
        createErrorResponse(
          `Invalid bridgePort: must be an integer in [1, 65535] (got: ${String(bridgePort.value)})`,
          ['Omit bridgePort to auto-select a free port', 'Pass a valid TCP port number'],
        ),
      );
    }
  }

  const background = optionalBoolean(args, 'background');
  if (!background.ok) return background;
  const isBackground = background.value === true;

  const profiling = optionalBoolean(args, 'profiling');
  if (!profiling.ok) return profiling;
  const isProfiling = profiling.value === true;

  try {
    await runner.runProject(projectPath, scene.value, isBackground, bridgePort.value, isProfiling);

    const bridgeResult = await runner.waitForBridge();

    if (!bridgeResult.ready) {
      if (runner.activeProcess && runner.activeProcess.hasExited) {
        // Tear down the spawned-mode session state so a retry of run_project
        // works without an intervening stop_project.
        await runner.stopProject();
        return err(
          createErrorResponse(
            `Godot process exited before the MCP bridge could initialize.\n${bridgeResult.error || ''}`,
            [
              'Check get_debug_output for runtime errors',
              'Verify a display server is available (Wayland/X11)',
              'Check for broken autoloads with list_autoloads',
              'Retry run_project once the underlying issue is resolved',
            ],
          ),
        );
      }

      const recentErrors = runner.getRecentErrors(20);
      const errorTail = recentErrors.length > 0 ? `\nLast stderr:\n${recentErrors.join('\n')}` : '';
      const expected = runner.activeBridgePort;
      const onDisk = runner.readBakedBridgePort(projectPath);
      const raceDetected = onDisk !== null && expected !== null && onDisk !== expected;
      const racePrefix = raceDetected
        ? `Bridge timeout: expected port ${expected}, but on-disk script now has ${onDisk}. Another MCP client likely re-injected concurrently in the same project.\n`
        : '';
      const lines = [
        `${racePrefix}Godot process started, but the MCP bridge did not respond within ${BRIDGE_WAIT_SPAWNED_TIMEOUT_MS / 1000} seconds.`,
        // Surface the precise poll failure (token/path mismatch, abort reason)
        // instead of burying it behind the generic timeout narrative.
        ...(bridgeResult.error ? [`- Actual reason: ${bridgeResult.error}`] : []),
        '- The bridge listener never came up — likely an early _ready error or a stuck process holding the port',
        '- Session has been torn down; retry run_project to start a new one',
        errorTail,
      ];
      if (isBackground) {
        lines.push('- Background mode: window hidden, physical input blocked');
      }
      // Tear down before returning so hasActiveRuntimeSession() reports false
      // and the next run_project lazy-reconnects cleanly.
      await runner.stopProject();
      const solutions = [
        'Check for broken autoloads with list_autoloads',
        `Check that the assigned bridge port (${runner.activeBridgePort}) is not occupied by another Godot process`,
        'Retry run_project',
      ];
      if (raceDetected) {
        solutions.push(
          'Concurrent MCP clients in the same project are not supported — run them in separate projects or sequence the calls',
        );
      }
      return err(createErrorResponse(lines.join('\n'), solutions));
    }

    const port = runner.activeBridgePort;
    const lines = [
      `Godot project started and MCP bridge is ready (port ${port}).`,
      '- Runtime tools (take_screenshot, simulate_input, get_ui_elements, run_script) are available now',
      '- Use get_debug_output to check runtime output and errors',
      '- Call stop_project when done',
    ];
    if (isBackground) {
      lines.push('- Background mode: window hidden, physical input blocked');
    }
    if (isProfiling) {
      lines.push('- Profiling enabled: use profile_project or start_profiler');
    }
    const allWarnings = [
      ...scanFindings.map((f) => formatScanFinding(f.sourcePath, absProjectPath, f.match)),
      ...scanWarnings,
    ];
    if (allWarnings.length > 0) {
      lines.push('', 'Security scan findings:');
      for (const w of allWarnings.slice(0, MAX_SCAN_WARNINGS_SHOWN)) lines.push(`- ${w}`);
      if (allWarnings.length > MAX_SCAN_WARNINGS_SHOWN) {
        lines.push(`- +${allWarnings.length - MAX_SCAN_WARNINGS_SHOWN} more`);
      }
    }

    const content: Array<{ type: string; [k: string]: unknown }> = [
      { type: 'text', text: lines.join('\n') },
    ];

    return ok({ content });
  } catch (error: unknown) {
    const errorMessage = getErrorMessage(error);
    if (errorMessage.includes('No display server available')) {
      return err(
        createErrorResponse(`Failed to run Godot project: ${errorMessage}`, [
          'Use attach_project with an externally launched Godot process',
          'Set DISPLAY or WAYLAND_DISPLAY environment variables',
          'Run from a graphical shell session',
        ]),
      );
    }
    return err(
      createErrorResponse(`Failed to run Godot project: ${errorMessage}`, [
        'Ensure Godot is installed correctly',
        'Check if the GODOT_PATH environment variable is set correctly',
      ]),
    );
  }
}

export async function handleAttachProject(
  runner: GodotRunner,
  args: OperationParams,
): Promise<HandlerResult> {
  args = normalizeParameters(args);

  const parsed = parseProjectArgs(args);
  if (!parsed.ok) return parsed;
  const { projectPath } = parsed.value;

  const attachBridgePort = optionalNumber(args, 'bridgePort');
  if (!attachBridgePort.ok) return attachBridgePort;
  if (attachBridgePort.value !== undefined) {
    if (
      !Number.isInteger(attachBridgePort.value) ||
      attachBridgePort.value < 1 ||
      attachBridgePort.value > 65535
    ) {
      return err(
        createErrorResponse(
          `Invalid bridgePort: must be an integer in [1, 65535] (got: ${String(attachBridgePort.value)})`,
          [
            'Omit bridgePort to auto-select a free port',
            'Pass a valid TCP port number matching the externally launched Godot',
          ],
        ),
      );
    }
  }

  try {
    await runner.attachProject(projectPath, attachBridgePort.value);

    const bridgeResult = await runner.waitForBridgeAttached();

    if (!bridgeResult.ready) {
      const expected = runner.activeBridgePort;
      const onDisk = runner.readBakedBridgePort(projectPath);
      const raceDetected = onDisk !== null && expected !== null && onDisk !== expected;
      const racePrefix = raceDetected
        ? `Bridge timeout: expected port ${expected}, but on-disk script now has ${onDisk}. Another MCP client likely re-injected concurrently in the same project.\n`
        : '';
      // Tear down the attached-mode session state so retrying with
      // attach_project (or run_project) works without a manual detach first.
      await runner.stopProject();
      const solutions = [
        'If you are launching Godot yourself, run the launch in parallel with attach_project next time so the wait absorbs the startup — do not sequentialize',
        'If a human is launching Godot, retry attach_project once they have launched — bridge.inject is idempotent',
        'If Godot is already running but was launched before the bridge was injected, restart it (autoloads are read at startup)',
        `Check that no other Godot project is occupying the assigned bridge port (${runner.activeBridgePort})`,
      ];
      if (raceDetected) {
        solutions.push(
          'Concurrent MCP clients in the same project are not supported — run them in separate projects or sequence the calls',
        );
      }
      return err(
        createErrorResponse(
          `${racePrefix}Project attached but the MCP bridge is not ready.\n${bridgeResult.error || ''}`,
          solutions,
        ),
      );
    }

    const attachedPort = runner.activeBridgePort;
    return ok({
      content: [
        {
          type: 'text',
          text: [
            `Project attached and MCP bridge is ready (port ${attachedPort}).`,
            '- Runtime tools (take_screenshot, simulate_input, get_ui_elements, run_script) are available now',
            '- get_debug_output is unavailable in attached mode because MCP did not spawn the process',
            '- Use detach_project or stop_project when done to clean up the injected bridge state',
          ].join('\n'),
        },
      ],
    });
  } catch (error: unknown) {
    return err(
      createErrorResponse(`Failed to attach project: ${getErrorMessage(error)}`, [
        'Check if project.godot is accessible',
        'Ensure MCP can write the bridge autoload into the project',
      ]),
    );
  }
}

export async function handleDetachProject(runner: GodotRunner): Promise<HandlerResult> {
  if (runner.activeSessionMode !== 'attached') {
    return err(
      createErrorResponse('No attached project to detach.', [
        'Use attach_project first for manual-launch workflows',
        'If MCP launched the game, use stop_project instead',
      ]),
    );
  }

  const result = (await runner.stopProject())!;

  return createStructuredResponse({
    message: 'Detached attached project and cleaned MCP bridge state',
    externalProcessPreserved: result.externalProcessPreserved === true,
  });
}

export function handleGetDebugOutput(
  runner: GodotRunner,
  args: OperationParams = {},
): HandlerResult {
  args = normalizeParameters(args);

  if (!runner.activeSessionMode) {
    return err(
      createErrorResponse('No active runtime session.', [
        'Use run_project to start a Godot project first',
        'Or use attach_project before launching Godot manually',
      ]),
    );
  }

  if (runner.activeSessionMode === 'attached') {
    return createStructuredResponse({
      output: [],
      errors: [],
      running: null,
      attached: true,
      tip: 'Attached mode does not capture stdout/stderr because Godot was launched outside MCP.',
    });
  }

  const proc = runner.activeProcess;
  if (!proc) {
    return err(
      createErrorResponse('No active spawned process is available for debug output.', [
        'Use run_project to start a Godot project first',
        'Or use attach_project only when stdout/stderr capture is not needed',
      ]),
    );
  }

  const limitResult = optionalNumber(args, 'limit');
  if (!limitResult.ok) return limitResult;
  const limit = limitResult.value ?? 200;
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

  return createStructuredResponse(response);
}

export async function handleStopProject(runner: GodotRunner): Promise<HandlerResult> {
  const result = await runner.stopProject();

  if (!result) {
    return err(
      createErrorResponse('No active Godot process to stop.', [
        'Use run_project to start a Godot project first',
        'The process may have already terminated',
      ]),
    );
  }

  return createStructuredResponse({
    message:
      result.mode === 'attached'
        ? 'Attached project detached and MCP bridge state cleaned up'
        : 'Godot project stopped',
    mode: result.mode,
    externalProcessPreserved: result.externalProcessPreserved === true,
    finalOutput: condenseProcessTail(result.output, STOP_OUTPUT_MAX_LINES),
    finalErrors: condenseProcessTail(result.errors, STOP_OUTPUT_MAX_LINES),
  });
}

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

function parsePreviewDimension(value: unknown, fallback: number): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.max(1, Math.floor(value));
}

function normalizeScreenshotPath(path: string): string {
  return sep === '\\' ? path.replace(/\//g, '\\') : path;
}

export async function handleTakeScreenshot(
  runner: GodotRunner,
  args: OperationParams,
): Promise<HandlerResult> {
  args = normalizeParameters(args);

  const sessionError = ensureRuntimeSession(runner, 'take a screenshot');
  if (sessionError) {
    return sessionError;
  }

  const timeoutResult = optionalNumber(args, 'timeout');
  if (!timeoutResult.ok) return timeoutResult;
  const timeout = timeoutResult.value ?? 10000;
  const responseMode = parseScreenshotResponseMode(args.responseMode);
  if (responseMode === null) {
    return err(
      createErrorResponse('Invalid responseMode for take_screenshot', [
        'Use one of: "full", "preview", or "path_only"',
      ]),
    );
  }

  const previewMaxWidth = parsePreviewDimension(args.previewMaxWidth, DEFAULT_PREVIEW_MAX_WIDTH);
  const previewMaxHeight = parsePreviewDimension(args.previewMaxHeight, DEFAULT_PREVIEW_MAX_HEIGHT);
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

    const parsedResult = parseBridgeJson<ScreenshotBridgeResponse>(responseStr, 'screenshot');
    if (!parsedResult.ok) return parsedResult;
    const parsed = parsedResult.value;

    if (parsed.error) {
      return err(
        createErrorResponse(`Screenshot server error: ${parsed.error}`, [
          'Ensure the project has a viewport (a headless project with no display server cannot render)',
          'Check disk space and permissions on the project directory (.mcp/screenshots/)',
        ]),
      );
    }

    if (!parsed.path) {
      return err(
        createErrorResponse('Screenshot server returned no file path', [
          'The bridge response is missing the expected `path` field — this is a bridge bug, not a timing issue',
          'Check get_debug_output for runtime errors during the screenshot save',
        ]),
      );
    }

    // Normalize path for the local filesystem (forward slashes from GDScript)
    const screenshotPath = normalizeScreenshotPath(parsed.path);

    // Defense-in-depth: the bridge runs in user-controlled GDScript and could
    // be patched to return any path. Refuse to read anything outside the
    // project's own .mcp/screenshots/ directory.
    const screenshotsRoot = resolve(runner.activeProjectPath!, '.mcp', 'screenshots');
    if (!isUnderDir(screenshotsRoot, screenshotPath)) {
      return err(
        createErrorResponse(
          'Bridge returned a screenshot path outside .mcp/screenshots/. Refusing to read.',
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

    const metadata: Record<string, unknown> = {
      responseMode,
      path: parsed.path,
      size: { width: parsed.width, height: parsed.height },
    };

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
            'Bridge returned a screenshot preview path outside .mcp/screenshots/. Refusing to read.',
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
      const previewBuffer = readFileSync(previewPath);
      content.push({
        type: 'image',
        data: previewBuffer.toString('base64'),
        mimeType: 'image/png',
      });
      metadata.previewPath = parsed.preview_path;
      metadata.previewSize = { width: parsed.preview_width, height: parsed.preview_height };
    }

    attachRuntimeWarnings(metadata, runtimeErrors);

    return createStructuredResponse(metadata, content);
  } catch (error: unknown) {
    return err(
      createErrorResponse(`Failed to take screenshot: ${getErrorMessage(error)}`, [
        'Check get_debug_output for crash backtraces or runtime errors',
        'If the game has exited, call stop_project, then run_project again',
        'For slow renders, increase the timeout parameter',
      ]),
    );
  }
}

export async function handleSimulateInput(
  runner: GodotRunner,
  args: OperationParams,
): Promise<HandlerResult> {
  args = normalizeParameters(args);

  const sessionError = ensureRuntimeSession(runner, 'simulate input');
  if (sessionError) {
    return sessionError;
  }

  const actionsResult = requireArray(args, 'actions', { minLength: 1 });
  if (!actionsResult.ok) return actionsResult;
  const actions = actionsResult.value;

  // Calculate timeout: sum of all wait durations + 10s buffer
  let totalWaitMs = 0;
  for (const action of actions) {
    const rec = action as Record<string, unknown>;
    if (typeof action === 'object' && action !== null && rec.type === 'wait') {
      const ms = rec.ms;
      if (typeof ms === 'number') {
        totalWaitMs += ms;
      }
    }
  }
  const timeoutMs = totalWaitMs + 10000;

  try {
    const { response: responseStr, runtimeErrors } = await runner.sendCommandWithErrors(
      'input',
      { actions },
      timeoutMs,
    );

    const parsedResult = parseBridgeJson<{
      success?: boolean;
      error?: string;
      actions_processed?: number;
    }>(responseStr, 'simulate_input');
    if (!parsedResult.ok) return parsedResult;
    const parsed = parsedResult.value;

    if (parsed.error) {
      return err(
        createErrorResponse(`Input simulation error: ${parsed.error}`, [
          'Check action types and parameters',
          'Ensure key names are valid Godot key names',
        ]),
      );
    }

    const payload: Record<string, unknown> = {
      success: true,
      actions_processed: parsed.actions_processed,
      tip: 'Call take_screenshot to verify the input had the intended visual effect.',
    };
    attachRuntimeWarnings(payload, runtimeErrors);

    return createStructuredResponse(payload);
  } catch (error: unknown) {
    return err(
      createErrorResponse(`Failed to simulate input: ${getErrorMessage(error)}`, [
        'Check get_debug_output for crash backtraces or runtime errors (a signal handler firing on input may have crashed the game)',
        'If the game has exited, call stop_project, then run_project again',
      ]),
    );
  }
}

export async function handleGetUiElements(
  runner: GodotRunner,
  args: OperationParams,
): Promise<HandlerResult> {
  args = normalizeParameters(args);

  const sessionError = ensureRuntimeSession(runner, 'query UI elements');
  if (sessionError) {
    return sessionError;
  }

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
    );
    if (!parsedResult.ok) return parsedResult;
    const parsed = parsedResult.value;

    if (parsed.error) {
      return err(
        createErrorResponse(`UI element query error: ${parsed.error}`, [
          'Ensure the game has a UI with Control nodes',
        ]),
      );
    }

    const payload: Record<string, unknown> = {
      ...parsed,
      tip: "Use simulate_input with type 'click_element' and a node_path or node name from this list to interact with these elements.",
    };
    attachRuntimeWarnings(payload, runtimeErrors);

    return createStructuredResponse(payload);
  } catch (error: unknown) {
    return err(
      createErrorResponse(`Failed to get UI elements: ${getErrorMessage(error)}`, [
        'Check get_debug_output for crash backtraces or runtime errors',
        'If the game has exited, call stop_project, then run_project again',
      ]),
    );
  }
}

export async function handleRunScript(
  runner: GodotRunner,
  args: OperationParams,
  ctx: McpContext = createNullContext(),
): Promise<HandlerResult> {
  args = normalizeParameters(args);

  const sessionError = ensureRuntimeSession(runner, 'execute scripts');
  if (sessionError) {
    return sessionError;
  }

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

  // Static-analysis gate. Decision drives audit + dispatch.
  const policy = evaluateScript(script, ctx.strictMode);
  const projectPath = runner.activeProjectPath;

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
  let warningsFromPolicy: string[] = [];
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
        if (projectPath) {
          writeAuditSidecar(projectPath, script, 'elicit_denied', policy, ctx.strictMode);
        }
        return err(
          createErrorResponse(
            `User declined: ${summarizeMatch(policy.matches[0]!)}. The script was not executed.`,
            collectSolutions(policy.matches),
          ),
        );
      }
      // Accept proceeds — record warnings for the success payload.
      warningsFromPolicy = matchesToWarnings(policy.matches);
    }
  } else if (policy.decision === 'warn') {
    warningsFromPolicy = matchesToWarnings(policy.matches);
  }

  // Audit successful / warn paths. Tier 2 accept lands here and is recorded
  // distinctly from a plain Tier 3 warn so the audit trail preserves the
  // user-confirmation event. A Tier 2 finding that ran unprompted because
  // elicitation was disabled is recorded as `elicit_bypassed`.
  if (projectPath) {
    let auditDecision: AuditDecision;
    if (policy.decision === 'ok') auditDecision = 'ok';
    else if (policy.decision === 'elicit_required')
      auditDecision = elicitBypassed ? 'elicit_bypassed' : 'elicit_accepted';
    else auditDecision = 'warn';
    writeAuditSidecar(projectPath, script, auditDecision, policy, ctx.strictMode);
  }

  const timeoutResult = optionalNumber(args, 'timeout');
  if (!timeoutResult.ok) return timeoutResult;
  const timeout = timeoutResult.value ?? 30000;

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
    }>(responseStr, 'run_script');
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

    // Detect false-positive success: GDScript has no try-catch, so runtime errors
    // return null and the real error only appears in stderr.
    if (parsed.success && parsed.result === null && runner.activeSessionMode === 'spawned') {
      if (runtimeErrors.length > 0) {
        const errorContext = runtimeErrors.slice(0, MAX_RUNTIME_ERROR_CONTEXT_LINES).join('\n');
        return err(
          createErrorResponse(`Script runtime error detected:\n${errorContext}`, [
            'Fix the GDScript error in your script and retry',
            'Use get_debug_output for full process output',
          ]),
        );
      }

      const nullPayload: Record<string, unknown> = {
        success: true,
        result: null,
        warnings: [
          'Script returned null. If unexpected, check get_debug_output for runtime errors — GDScript does not propagate exceptions.',
          ...warningsFromPolicy,
        ],
        tip: 'Call take_screenshot to verify any visual changes, or get_debug_output to review print() output from your script.',
      };
      return createStructuredResponse(nullPayload);
    }

    const payload: Record<string, unknown> = {
      success: true,
      result: parsed.result,
      tip: 'Call take_screenshot to verify any visual changes, or get_debug_output to review print() output from your script.',
    };
    const combinedWarnings = [...warningsFromPolicy, ...runtimeErrors];
    if (combinedWarnings.length > 0) {
      payload.warnings = combinedWarnings.slice(0, MAX_RUNTIME_ERROR_CONTEXT_LINES);
    }

    return createStructuredResponse(payload);
  } catch (error: unknown) {
    return err(
      createErrorResponse(`Failed to execute script: ${getErrorMessage(error)}`, [
        'Check get_debug_output for crash backtraces or runtime errors raised inside the script',
        'If the game has exited, call stop_project, then run_project again',
        'For long-running scripts, increase the timeout parameter',
      ]),
    );
  }
}
