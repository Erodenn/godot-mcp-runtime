// Lower-level `Server` is deliberate; see CONTRIBUTING.md "MCP SDK: Server vs McpServer".
import { Server, type CallToolResult, type ListToolsResult } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { startProgressHeartbeat } from './utils/progress-heartbeat.js';

import type { GodotServerConfig } from './utils/godot-runner.js';
import { GodotRunner } from './utils/godot-runner.js';
import { getErrorMessage } from './utils/error-response.js';
import { registerProcessLifecycle, shutDownRunner } from './utils/process-lifecycle.js';
import { SESSION_QUEUE_WAIT_TIMEOUT_MS } from './utils/session-queue.js';
import { MS_PER_SECOND } from './utils/profiler.js';

import { dispatchToolCall } from './dispatch.js';
import { createElicitor, describeIgnoredFlagValues, type McpContext } from './utils/mcp-context.js';
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

export const serverInstructions = `Godot MCP Server - AI-driven Godot 4.5+ project manipulation.

Tool categories:
- Project management: launch_editor, run_project, switch_project, stop_project, get_debug_output, list_projects, check_project
- Scene editing (headless): create_scene, add_node, load_sprite, save_scene, export_mesh_library, batch_scene_operations
- Node editing (headless): delete_nodes, set_node_properties, get_node_properties, attach_script, get_scene_tree, duplicate_node, move_nodes, get_node_signals, connect_signal, disconnect_signal
- Resource files (headless): create_resource, set_resource_properties
- Runtime (requires run_project): take_screenshot, simulate_input, get_ui_elements, run_script
- Render check (no runtime session): render_movie
- Profiling (requires run_project with profiling: true): profile_project, start_profiler, stop_profiler
- Project config (no Godot process): list_autoloads, add_autoload, remove_autoload, update_autoload, get_project_files, search_project, get_scene_dependencies, get_project_settings, set_project_setting
- Validation: validate

Key behaviors:
- All mutation operations (add_node, set_node_properties, delete_nodes, etc.) save the scene automatically. Only use save_scene for save-as (newPath) or re-canonicalization.
- Headless Godot loads every registered autoload. An autoload that stops the engine before the operation is dispatched (for example one that quits in _init) fails every headless operation; one that only errors in _ready does not. Check the script with validate, and use list_autoloads / remove_autoload to find and remove it.
- run_project waits for the MCP bridge before returning success and returns a JSON payload (sessionMode, bridgePort, warnings). If the bridge never answers it returns an error and tears the session down; retry run_project.
- run_project with attach: true is the path for a Godot process you launch yourself: it injects the bridge and marks the project active, but spawns nothing and captures no stdout/stderr. It asks no launch confirmation; run_script still asks once per project. stop_project ends it without killing that process.
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

Confirmation prompts: the first run_project (spawn mode) or render_movie on a project in a server session asks the user to confirm, because the project's code runs with the user's permissions. The first run_script on a project asks too, because agent-written GDScript runs with those permissions; a launch confirmation does not cover it, and an attached session asks as well. Each prompt is asked once per project per server session, and nothing is scanned. If the user declines, do not call the tool again on that project unless they ask. GODOT_MCP_DISABLE_ELICITATION=true skips the prompts for clients that cannot display them. See SECURITY.md.`;

function createContextFromServer(server: Server): McpContext {
  const elicitor = createElicitor({
    getClientCapabilities: () => server.getClientCapabilities(),
    elicitInput: async (params, options) => {
      // The SDK's param type is a strict inferred shape; the request matches the protocol at runtime.
      const result = await server.elicitInput(
        params as unknown as Parameters<typeof server.elicitInput>[0],
        options,
      );
      return result.content
        ? { action: result.action, content: result.content as Record<string, unknown> }
        : { action: result.action };
    },
  });
  // A flag set to anything but the exact string "true" is off; say so, or "1" leaves the operator believing it took effect.
  for (const line of describeIgnoredFlagValues(process.env)) console.error(line);
  const disableElicitation = process.env.GODOT_MCP_DISABLE_ELICITATION === 'true';
  return {
    elicitor,
    disableElicitation,
    sessionState: { runProjectConfirmed: new Set<string>(), runScriptConfirmed: new Set<string>() },
    now: () => Date.now(),
  };
}

export class GodotMcpServer {
  private server: Server;
  private runner: GodotRunner;
  private ctx: McpContext;

  constructor(config?: GodotServerConfig) {
    this.runner = new GodotRunner(config);

    this.server = new Server(
      {
        name: 'godot-mcp',
        version: '4.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
        instructions: serverInstructions,
      },
    );

    this.ctx = createContextFromServer(this.server);
    if (this.ctx.disableElicitation) {
      console.error(
        '[SERVER] Elicitation disabled (GODOT_MCP_DISABLE_ELICITATION=true); launch and run_script confirmation prompts are skipped',
      );
    }

    this.setupToolHandlers();

    this.server.onerror = (error) => console.error('[MCP Error]', error);

    registerProcessLifecycle({ runner: this.runner, cleanup: () => this.cleanup() });
  }

  private async cleanup() {
    console.error('[SERVER] Cleaning up resources');
    await shutDownRunner(this.runner);
    await this.server.close();
  }

  private setupToolHandlers() {
    // The SDK's wire types are mutable and literal-typed; the definitions are `as const` and ToolResponse is looser, so both are cast at this one edge.
    this.server.setRequestHandler('tools/list', async () => ({
      tools: allToolDefinitions as unknown as ListToolsResult['tools'],
    }));

    this.server.setRequestHandler('tools/call', async (request, ctx) => {
      const toolName = request.params.name;
      const args = request.params.arguments || {};

      console.error(`[SERVER] Handling tool request: ${toolName}`);

      // Heartbeat progress notifications keep clients that set `resetTimeoutOnProgress` alive past the SDK's 60 s default on long calls.
      const stopHeartbeat = startProgressHeartbeat(ctx, request);
      try {
        return (await dispatchToolCall(this.runner, toolName, args, this.ctx)) as CallToolResult;
      } finally {
        stopHeartbeat();
      }
    });
  }

  async run(): Promise<void> {
    try {
      await this.runner.detectGodotPath();

      const godotPath = this.runner.getGodotPath();
      if (godotPath) {
        console.error(`[SERVER] Using Godot at: ${godotPath}`);
      }
      // detectGodotPath() already logs the specific failure; a generic warning here would hide the actual cause.

      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.error('Godot MCP server running on stdio');
    } catch (error: unknown) {
      console.error('[SERVER] Failed to start:', getErrorMessage(error));
      process.exit(1);
    }
  }
}
