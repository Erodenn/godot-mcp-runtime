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
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import { GodotRunner, GodotServerConfig } from './utils/godot-runner.js';

// Project tools
import {
  projectToolDefinitions,
  handleLaunchEditor,
  handleRunProject,
  handleAttachProject,
  handleDetachProject,
  handleGetDebugOutput,
  handleStopProject,
  handleListProjects,
  handleGetProjectInfo,
  handleTakeScreenshot,
  handleSimulateInput,
  handleGetUiElements,
  handleRunScript,
  handleListAutoloads,
  handleAddAutoload,
  handleRemoveAutoload,
  handleUpdateAutoload,
  handleGetProjectFiles,
  handleSearchProject,
  handleGetSceneDependencies,
  handleGetProjectSettings,
} from './tools/project-tools.js';

// Scene tools
import {
  sceneToolDefinitions,
  handleCreateScene,
  handleAddNode,
  handleLoadSprite,
  handleSaveScene,
  handleExportMeshLibrary,
  handleBatchSceneOperations,
  handleManageUids,
} from './tools/scene-tools.js';

// Node tools
import {
  nodeToolDefinitions,
  handleDeleteNode,
  handleSetNodeProperty,
  handleBatchSetNodeProperties,
  handleGetNodeProperties,
  handleBatchGetNodeProperties,
  handleAttachScript,
  handleGetSceneTree,
  handleDuplicateNode,
  handleGetNodeSignals,
  handleConnectSignal,
  handleDisconnectSignal,
} from './tools/node-tools.js';

// Validate tools
import {
  validateToolDefinitions,
  handleValidate,
} from './tools/validate-tools.js';

class GodotMcpServer {
  private server: Server;
  private runner: GodotRunner;

  constructor(config?: GodotServerConfig) {
    this.runner = new GodotRunner(config);

    this.server = new Server(
      {
        name: 'godot-mcp',
        version: '2.2.0',
      },
      {
        capabilities: {
          tools: {},
        },
        instructions: `Godot MCP Server — AI-driven Godot 4.x project manipulation.

Tool categories:
- Project management: launch_editor, run_project, attach_project, detach_project, stop_project, get_debug_output, list_projects, get_project_info
- Scene editing (headless): create_scene, add_node, load_sprite, save_scene, export_mesh_library, batch_scene_operations
- Node editing (headless): delete_node, set_node_property, batch_set_node_properties, get_node_properties, batch_get_node_properties, attach_script, get_scene_tree, duplicate_node, get_node_signals, connect_signal, disconnect_signal
- Runtime (requires run_project or attach_project): take_screenshot, simulate_input, get_ui_elements, run_script
- Project config (no Godot process): list_autoloads, add_autoload, remove_autoload, update_autoload, get_project_files, search_project, get_scene_dependencies, get_project_settings
- Validation: validate
- UIDs (Godot 4.4+): manage_uids

Key behaviors:
- All mutation operations (add_node, set_node_property, delete_node, etc.) save the scene automatically. Only use save_scene for save-as (newPath) or re-canonicalization.
- Headless Godot initializes ALL registered autoloads. If any autoload is broken, headless operations will fail. Use list_autoloads / remove_autoload to diagnose.
- After run_project, wait 2-3 seconds before using runtime tools (take_screenshot, simulate_input, get_ui_elements, run_script). The MCP bridge needs time to initialize.
- attach_project is the fallback path for a manually launched Godot process. It injects the bridge and marks the project active, but it does not spawn Godot or capture stdout/stderr.
- click_element in simulate_input resolves by node path or node name (BFS search), NOT by visible text. Use get_ui_elements to discover valid element identifiers.
- run_script expects GDScript with "extends RefCounted" and "func execute(scene_tree: SceneTree) -> Variant".
- run_project spawns Godot without -d so runtime errors do not pause execution; the \`breakpoint\` keyword in user code is a no-op (no debugger is attached). SCRIPT ERROR output and GDScript backtraces still appear in stderr.`,
      }
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
    // Combine all tool definitions
    const allTools = [
      ...projectToolDefinitions,
      ...sceneToolDefinitions,
      ...nodeToolDefinitions,
      ...validateToolDefinitions,
    ];

    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: allTools,
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;
      const args = request.params.arguments || {};

      console.error(`[SERVER] Handling tool request: ${toolName}`);

      switch (toolName) {
        // Project tools
        case 'launch_editor':
          return await handleLaunchEditor(this.runner, args);
        case 'run_project':
          return await handleRunProject(this.runner, args);
        case 'attach_project':
          return await handleAttachProject(this.runner, args);
        case 'detach_project':
          return handleDetachProject(this.runner);
        case 'get_debug_output':
          return handleGetDebugOutput(this.runner, args);
        case 'stop_project':
          return handleStopProject(this.runner);
        case 'list_projects':
          return await handleListProjects(args);
        case 'get_project_info':
          return await handleGetProjectInfo(this.runner, args);
        case 'take_screenshot':
          return await handleTakeScreenshot(this.runner, args);
        case 'simulate_input':
          return await handleSimulateInput(this.runner, args);
        case 'get_ui_elements':
          return await handleGetUiElements(this.runner, args);
        case 'run_script':
          return await handleRunScript(this.runner, args);
        case 'list_autoloads':
          return await handleListAutoloads(args);
        case 'add_autoload':
          return await handleAddAutoload(args);
        case 'remove_autoload':
          return await handleRemoveAutoload(args);
        case 'update_autoload':
          return await handleUpdateAutoload(args);
        case 'get_project_files':
          return await handleGetProjectFiles(args);
        case 'search_project':
          return await handleSearchProject(args);
        case 'get_scene_dependencies':
          return await handleGetSceneDependencies(args);
        case 'get_project_settings':
          return await handleGetProjectSettings(args);

        // Scene tools
        case 'create_scene':
          return await handleCreateScene(this.runner, args);
        case 'add_node':
          return await handleAddNode(this.runner, args);
        case 'load_sprite':
          return await handleLoadSprite(this.runner, args);
        case 'save_scene':
          return await handleSaveScene(this.runner, args);
        case 'export_mesh_library':
          return await handleExportMeshLibrary(this.runner, args);
        case 'batch_scene_operations':
          return await handleBatchSceneOperations(this.runner, args);
        case 'manage_uids':
          return await handleManageUids(this.runner, args);

        // Node tools
        case 'delete_node':
          return await handleDeleteNode(this.runner, args);
        case 'set_node_property':
          return await handleSetNodeProperty(this.runner, args);
        case 'batch_set_node_properties':
          return await handleBatchSetNodeProperties(this.runner, args);
        case 'get_node_properties':
          return await handleGetNodeProperties(this.runner, args);
        case 'batch_get_node_properties':
          return await handleBatchGetNodeProperties(this.runner, args);
        case 'attach_script':
          return await handleAttachScript(this.runner, args);
        case 'get_scene_tree':
          return await handleGetSceneTree(this.runner, args);
        case 'duplicate_node':
          return await handleDuplicateNode(this.runner, args);
        case 'get_node_signals':
          return await handleGetNodeSignals(this.runner, args);
        case 'connect_signal':
          return await handleConnectSignal(this.runner, args);
        case 'disconnect_signal':
          return await handleDisconnectSignal(this.runner, args);

        // Validate tools
        case 'validate':
          return await handleValidate(this.runner, args);

        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${toolName}`
          );
      }
    });
  }

  async run() {
    try {
      await this.runner.detectGodotPath();

      const godotPath = this.runner.getGodotPath();
      if (!godotPath) {
        console.error('[SERVER] Warning: Godot executable not found. Set GODOT_PATH to enable Godot tools.');
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
