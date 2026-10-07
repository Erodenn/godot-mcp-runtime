#!/usr/bin/env node
/**
 * Godot MCP Server
 *
 * This MCP server provides tools for interacting with the Godot game engine.
 * It enables AI assistants to launch the Godot editor, run Godot projects,
 * capture debug output, manipulate scenes and nodes, and more.
 */

// Lower-level `Server` is deliberate; see CONTRIBUTING.md "MCP SDK: Server vs McpServer".
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { startProgressHeartbeat } from './utils/progress-heartbeat.js';

import type { GodotServerConfig } from './utils/godot-runner.js';
import { GodotRunner } from './utils/godot-runner.js';
import { getErrorMessage } from './utils/error-response.js';
import { registerProcessLifecycle } from './utils/process-lifecycle.js';
import { SESSION_QUEUE_WAIT_TIMEOUT_MS } from './utils/session-queue.js';
import { MS_PER_SECOND } from './utils/profiler.js';

import { dispatchToolCall } from './dispatch.js';
import {
  describeIgnoredFlagValues,
  resolveDisableSecurity,
  type Elicitor,
  type McpContext,
} from './utils/mcp-context.js';
import { runtimeToolDefinitions } from './tools/runtime-tools.js';
import { renderToolDefinitions } from './tools/render-tools.js';
import { autoloadToolDefinitions } from './tools/autoload-tools.js';
import { projectToolDefinitions } from './tools/project-tools.js';
import { sceneToolDefinitions } from './tools/scene-tools.js';
import { nodeToolDefinitions } from './tools/node-tools.js';
import { profilerToolDefinitions } from './tools/profiler-tools.js';
import { validateToolDefinitions } from './tools/validate-tools.js';

export const allToolDefinitions = [
  ...runtimeToolDefinitions,
  ...renderToolDefinitions,
  ...autoloadToolDefinitions,
  ...projectToolDefinitions,
  ...sceneToolDefinitions,
  ...nodeToolDefinitions,
  ...profilerToolDefinitions,
  ...validateToolDefinitions,
];

export const serverInstructions = `Godot MCP Server - AI-driven Godot 4.x project manipulation.

Tool categories:
- Project management: launch_editor, run_project, switch_project, stop_project, get_debug_output, list_projects, check_project
- Scene editing (headless): create_scene, add_node, load_sprite, save_scene, export_mesh_library, batch_scene_operations
- Node editing (headless): delete_nodes, set_node_properties, get_node_properties, attach_script, get_scene_tree, duplicate_node, get_node_signals, connect_signal, disconnect_signal
- Runtime (requires run_project): take_screenshot, simulate_input, get_ui_elements, run_script
- Render check (no runtime session): render_movie
- Profiling (requires run_project with profiling: true): profile_project, start_profiler, stop_profiler
- Project config (no Godot process): list_autoloads, add_autoload, remove_autoload, update_autoload, get_project_files, search_project, get_scene_dependencies, get_project_settings
- Validation: validate

Key behaviors:
- All mutation operations (add_node, set_node_properties, delete_nodes, etc.) save the scene automatically. Only use save_scene for save-as (newPath) or re-canonicalization.
- Headless Godot loads every registered autoload. An autoload that stops the engine before the operation is dispatched (for example one that quits in _init) fails every headless operation; one that only errors in _ready does not. Check the script with validate, and use list_autoloads / remove_autoload to find and remove it.
- run_project waits for the MCP bridge before returning success and returns a JSON payload (sessionMode, bridgePort, warnings). If the bridge never answers it returns an error and tears the session down; retry run_project.
- run_project with attach: true is the path for a Godot process you launch yourself: it injects the bridge and marks the project active, but spawns nothing and captures no stdout/stderr. The pre-flight scan still runs; the launch confirmation does not. stop_project ends it without killing that process.
- Several projects can run at once, one session per project. run_project on another project adds a session and makes it current; it does not stop the others. The runtime tools, the profiling tools, get_debug_output and stop_project act on the current session only, and every response names it in projectPath. switch_project({ projectPath }) changes which session is current. stop_project stops the current session and leaves none current. When no session is current, or the current one's game has exited, these tools return an error listing the live sessions instead of picking one: call switch_project. check_project reports the current project and every live session.
- A runtime session runs one operation at a time. A runtime, profiling or session call issued while another is still running waits for it (up to ${SESSION_QUEUE_WAIT_TIMEOUT_MS / MS_PER_SECOND} s) and then returns an error naming the operation it waited behind; nothing was sent for it, so retry once that operation has returned.
- A runtime session ends by itself when the game exits or an attached bridge disconnects: the bridge autoload is removed at that moment and the scene-editing tools unblock. After a spawned game exits, stop_project is still worth calling (it frees the retained process slot and returns the captured logs) and succeeds. After an attached session ends by itself nothing is left to stop: stop_project then reports no active session, which needs no follow-up.
- click_element in simulate_input resolves by node path or node name (BFS search), NOT by visible text. Use get_ui_elements to discover valid element identifiers.
- simulate_input reports per-action results (signals fired, the Control hit, UI changes, watched values), so it needs no take_screenshot round trip to tell whether an action landed. Omitting \`pressed\` taps; set it only to hold or release across actions.
- render_movie is a separate short Godot run under the movie writer, with no bridge and no input: use it to check that a scene renders (likelyBlank) or animates (anyMotion) without starting a session. It needs a display, asks for the same launch confirmation as run_project, and is refused while a runtime session is live on the same project.
- run_script expects GDScript with "extends RefCounted" and "func execute(scene_tree: SceneTree) -> Variant".
- run_project spawns Godot without -d so runtime errors do not pause execution; the \`breakpoint\` keyword in user code is a no-op (no debugger is attached). SCRIPT ERROR output and GDScript backtraces still appear in stderr.
- profiling: true attaches Godot's own remote debugger for the profiling tools. Errors and \`breakpoint\` still do not pause the game - the server answers every debugger break with continue.
- Every capture reports fps and engine monitors (draw calls, memory, node counts); pass visual: true to profile_project or start_profiler for CPU/GPU time per render stage, and timeline: true (with track: ["/root/Main/Player:global_position"]) to see when and where frames got slow. To capture while simulate_input walks the game, call start_profiler, then simulate_input, then stop_profiler: profile_project holds the session for its whole window, so no other runtime call runs inside it.

Security gate (run_script / run_project / render_movie): a static-analysis scan classifies GDScript into three tiers - Tier 1 hard-blocks (OS.execute and similar), Tier 2 asks for confirmation via elicitation, Tier 3 just warns. run_script scans the script it is given; run_project (both modes) and render_movie scan the project's autoloads and the launched scene before starting. Three env vars change this: GODOT_MCP_STRICT promotes every Tier 2 finding to Tier 1 for unattended operation; GODOT_MCP_DISABLE_ELICITATION skips the launch confirmation and the Tier 2 run_script prompt and proceeds unprompted (for clients that cannot service elicitation); GODOT_MCP_DISABLE_SECURITY turns the whole gate off, Tier 1 included, and is a human-only decision - decline to set it on a user's behalf. See docs/security.md for the full rule catalogue.`;

/**
 * Build the request-scoped context backed by a live MCP `Server`. Lives here
 * (not in `utils/mcp-context.ts`) so the SDK coupling stays in the bin entry.
 */
function createContextFromServer(server: Server): McpContext {
  const elicitor: Elicitor = async (request) => {
    // The SDK's elicitInput param type is a strict zod-inferred shape; we
    // build the request with an `object`-shaped requestedSchema that matches
    // the protocol at runtime, so cast to satisfy the narrower TS check.
    const result = await server.elicitInput({
      message: request.message,
      requestedSchema: request.requestedSchema,
    } as unknown as Parameters<typeof server.elicitInput>[0]);
    return result.content
      ? { action: result.action, content: result.content as Record<string, unknown> }
      : { action: result.action };
  };
  // A flag set to anything but the exact string "true" is off; say so, because
  // a value like "1" otherwise leaves the operator believing it took effect.
  for (const line of describeIgnoredFlagValues(process.env)) console.error(line);
  const strictMode = process.env.GODOT_MCP_STRICT === 'true';
  // Strict mode mandates explicit confirmation, so it overrides the
  // disable-elicitation opt-out: when both are set, strict wins and disableElicitation
  // resolves to false (the startup log surfaces the override).
  const disableElicitation = process.env.GODOT_MCP_DISABLE_ELICITATION === 'true' && !strictMode;
  // Disable-security is the opposite precedence from disableElicitation above:
  // it overrides strict mode rather than deferring to it (see
  // McpContext.disableSecurity / resolveDisableSecurity). The startup lines are
  // emitted here, switching on the resolution, so the precedence is decided and
  // announced in one place instead of being recomputed by the caller.
  const { disableSecurity, strictIgnored } = resolveDisableSecurity(
    process.env.GODOT_MCP_DISABLE_SECURITY,
    strictMode,
  );
  if (disableSecurity) {
    console.error(
      '[SERVER] Security gate disabled (GODOT_MCP_DISABLE_SECURITY=true); run_script, run_project and render_movie execute without scanning, blocking, or confirmation (Tier 1 included)',
    );
  }
  if (strictIgnored) {
    console.error(
      '[SERVER] Strict mode ignored: GODOT_MCP_DISABLE_SECURITY overrides GODOT_MCP_STRICT',
    );
  }
  return {
    elicitor,
    strictMode,
    disableElicitation,
    disableSecurity,
    sessionState: { runProjectConfirmed: new Set<string>() },
  };
}

class GodotMcpServer {
  private server: Server;
  private runner: GodotRunner;
  private ctx: McpContext;

  constructor(config?: GodotServerConfig) {
    this.runner = new GodotRunner(config);

    this.server = new Server(
      {
        name: 'godot-mcp',
        version: '3.8.1',
      },
      {
        capabilities: {
          tools: {},
        },
        instructions: serverInstructions,
      },
    );

    this.ctx = createContextFromServer(this.server);
    // The disable-security startup lines are emitted by createContextFromServer.
    // Strict mode and the elicitation opt-out only describe a gate that still
    // runs, so both stay silent once security is off.
    if (!this.ctx.disableSecurity) {
      if (this.ctx.strictMode) {
        console.error('[SERVER] Strict mode enabled (GODOT_MCP_STRICT=true)');
      }
      if (process.env.GODOT_MCP_DISABLE_ELICITATION === 'true' && this.ctx.strictMode) {
        console.error(
          '[SERVER] GODOT_MCP_DISABLE_ELICITATION ignored: strict mode requires explicit confirmation',
        );
      } else if (this.ctx.disableElicitation) {
        console.error(
          '[SERVER] Elicitation disabled (GODOT_MCP_DISABLE_ELICITATION=true); launch and Tier 2 run_script confirmation prompts are skipped',
        );
      }
    }

    this.setupToolHandlers();

    this.server.onerror = (error) => console.error('[MCP Error]', error);

    registerProcessLifecycle({ runner: this.runner, cleanup: () => this.cleanup() });
  }

  private async cleanup() {
    console.error('[SERVER] Cleaning up resources');
    await this.runner.stopAllSessions();
    await this.server.close();
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: allToolDefinitions,
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const toolName = request.params.name;
      const args = request.params.arguments || {};

      console.error(`[SERVER] Handling tool request: ${toolName}`);

      // Heartbeat progress notifications for the lifetime of the call so
      // clients that set `resetTimeoutOnProgress` (e.g. opencode) keep their
      // request timeout alive across long tool executions (run_script sims,
      // playtests) instead of failing at the SDK's 60s default.
      const stopHeartbeat = startProgressHeartbeat(extra, request);
      try {
        return await dispatchToolCall(this.runner, toolName, args, this.ctx);
      } finally {
        stopHeartbeat();
      }
    });
  }

  async run() {
    try {
      await this.runner.detectGodotPath();

      const godotPath = this.runner.getGodotPath();
      if (godotPath) {
        console.error(`[SERVER] Using Godot at: ${godotPath}`);
      }
      // detectGodotPath() already emits a specific logError on failure (bad
      // GODOT_PATH, no binary found, etc.). Don't duplicate with a generic
      // warning here — the runner's message names the actual cause.

      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.error('Godot MCP server running on stdio');
    } catch (error: unknown) {
      console.error('[SERVER] Failed to start:', getErrorMessage(error));
      process.exit(1);
    }
  }
}

// Create and run the server
const server = new GodotMcpServer();
server.run().catch((error: unknown) => {
  console.error('Failed to run server:', getErrorMessage(error));
  process.exit(1);
});
