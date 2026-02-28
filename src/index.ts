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
  handleGetDebugOutput,
  handleStopProject,
  handleListProjects,
  handleGetProjectInfo,
  handleTakeScreenshot,
  handleSimulateInput,
  handleGetUiElements,
  handleRunScript,
} from './tools/project-tools.js';

// Scene tools
import {
  sceneToolDefinitions,
  handleManageScene,
  handleManageUids,
} from './tools/scene-tools.js';

// Node tools
import {
  nodeToolDefinitions,
  handleManageNode,
} from './tools/node-tools.js';

class GodotMcpServer {
  private server: Server;
  private runner: GodotRunner;

  constructor(config?: GodotServerConfig) {
    this.runner = new GodotRunner(config);

    this.server = new Server(
      {
        name: 'godot-mcp',
        version: '0.3.0',
      },
      {
        capabilities: {
          tools: {},
        },
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

        // Scene tools
        case 'manage_scene':
          return await handleManageScene(this.runner, args);
        case 'manage_uids':
          return await handleManageUids(this.runner, args);

        // Node tools
        case 'manage_node':
          return await handleManageNode(this.runner, args);

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
        console.error('[SERVER] Failed to find a valid Godot executable path');
        console.error('[SERVER] Please set GODOT_PATH environment variable or provide a valid path');
        process.exit(1);
      }

      console.error(`[SERVER] Using Godot at: ${godotPath}`);

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
