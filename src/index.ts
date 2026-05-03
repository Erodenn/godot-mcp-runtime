#!/usr/bin/env node
/**
 * Godot MCP Server
 *
 * This MCP server provides tools for interacting with the Godot game engine.
 * It enables AI assistants to launch the Godot editor, run Godot projects,
 * capture debug output, manipulate scenes and nodes, and more.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import type { GodotServerConfig } from './utils/godot-runner.js';
import { GodotRunner } from './utils/godot-runner.js';

import { dispatchToolCall } from './dispatch.js';
import { projectToolDefinitions } from './tools/project-tools.js';
import { sceneToolDefinitions } from './tools/scene-tools.js';
import { nodeToolDefinitions } from './tools/node-tools.js';
import { validateToolDefinitions } from './tools/validate-tools.js';

export const allToolDefinitions = [
  ...projectToolDefinitions,
  ...sceneToolDefinitions,
  ...nodeToolDefinitions,
  ...validateToolDefinitions,
];

export const serverInstructions = `Godot MCP Server — AI-driven Godot 4.x project manipulation.

Tool categories:
- Project management: launch_editor, run_project, attach_project, detach_project, stop_project, get_debug_output, list_projects, get_project_info
- Scene editing (headless): create_scene, add_node, load_sprite, save_scene, export_mesh_library, batch_scene_operations
- Node editing (headless): delete_nodes, set_node_properties, get_node_properties, attach_script, get_scene_tree, duplicate_node, get_node_signals, connect_signal, disconnect_signal
- Runtime (requires run_project or attach_project): take_screenshot, simulate_input, get_ui_elements, run_script
- Project config (no Godot process): list_autoloads, add_autoload, remove_autoload, update_autoload, get_project_files, search_project, get_scene_dependencies, get_project_settings
- Validation: validate

Key behaviors:
- All mutation operations (add_node, set_node_properties, delete_nodes, etc.) save the scene automatically. Only use save_scene for save-as (newPath) or re-canonicalization.
- Headless Godot initializes ALL registered autoloads. If any autoload is broken, headless operations will fail. Use list_autoloads / remove_autoload to diagnose.
- run_project verifies bridge readiness before returning success. If it reports degraded status, retry runtime tools after a moment or check get_debug_output.
- attach_project is the fallback path for a manually launched Godot process. It injects the bridge and marks the project active, but it does not spawn Godot or capture stdout/stderr.
- click_element in simulate_input resolves by node path or node name (BFS search), NOT by visible text. Use get_ui_elements to discover valid element identifiers.
- run_script expects GDScript with "extends RefCounted" and "func execute(scene_tree: SceneTree) -> Variant".
- run_project spawns Godot without -d so runtime errors do not pause execution; the \`breakpoint\` keyword in user code is a no-op (no debugger is attached). SCRIPT ERROR output and GDScript backtraces still appear in stderr.`;

class GodotMcpServer {
  private server: Server;
  private runner: GodotRunner;

  constructor(config?: GodotServerConfig) {
    this.runner = new GodotRunner(config);

    this.server = new Server(
      {
        name: 'godot-mcp',
        version: '3.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
        instructions: serverInstructions,
      },
    );

    this.setupToolHandlers();

    this.server.onerror = (error) => console.error('[MCP Error]', error);

    process.on('SIGINT', async () => {
      await this.cleanup();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      await this.cleanup();
      process.exit(0);
    });
  }

  private async cleanup() {
    console.error('[SERVER] Cleaning up resources');
    this.runner.stopProject();
    await this.server.close();
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: allToolDefinitions,
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;
      const args = request.params.arguments || {};

      console.error(`[SERVER] Handling tool request: ${toolName}`);

      return await dispatchToolCall(this.runner, toolName, args);
    });
  }

  async run() {
    try {
      await this.runner.detectGodotPath();

      const godotPath = this.runner.getGodotPath();
      if (!godotPath) {
        console.error(
          '[SERVER] Warning: Godot executable not found. Set GODOT_PATH to enable Godot tools.',
        );
      } else {
        console.error(`[SERVER] Using Godot at: ${godotPath}`);
      }

      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.error('Godot MCP server running on stdio');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[SERVER] Failed to start:', errorMessage);
      process.exit(1);
    }
  }
}

// Create and run the server
const server = new GodotMcpServer();
server.run().catch((error: unknown) => {
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';
  console.error('Failed to run server:', errorMessage);
  process.exit(1);
});
