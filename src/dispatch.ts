/**
 * Tool dispatch table.
 *
 * Maps every MCP tool name to a handler that takes the runner + raw args and
 * returns the tool response. Extracted from index.ts so tests can exercise
 * dispatch as a pure data structure (no Server / stdio / lifecycle setup).
 *
 * Behavioral contract preserved from the original switch in index.ts:
 *  - Each name routes to the same handler it did before.
 *  - Unknown tool names throw McpError(MethodNotFound, ...) — see
 *    `dispatchToolCall`.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import type { GodotRunner, OperationParams } from './utils/godot-runner.js';

import {
  handleLaunchEditor,
  handleRunProject,
  handleAttachProject,
  handleDetachProject,
  handleGetDebugOutput,
  handleStopProject,
  handleTakeScreenshot,
  handleSimulateInput,
  handleGetUiElements,
  handleRunScript,
} from './tools/runtime-tools.js';

import {
  handleListAutoloads,
  handleAddAutoload,
  handleRemoveAutoload,
  handleUpdateAutoload,
} from './tools/autoload-tools.js';

import {
  handleListProjects,
  handleGetProjectInfo,
  handleGetProjectFiles,
  handleSearchProject,
  handleGetSceneDependencies,
  handleGetProjectSettings,
} from './tools/project-tools.js';

import {
  handleCreateScene,
  handleAddNode,
  handleLoadSprite,
  handleSaveScene,
  handleExportMeshLibrary,
  handleBatchSceneOperations,
} from './tools/scene-tools.js';

import {
  handleDeleteNodes,
  handleSetNodeProperties,
  handleGetNodeProperties,
  handleAttachScript,
  handleGetSceneTree,
  handleDuplicateNode,
  handleGetNodeSignals,
  handleConnectSignal,
  handleDisconnectSignal,
} from './tools/node-tools.js';

import { handleValidate } from './tools/validate-tools.js';

export interface ToolResponse {
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
  [k: string]: unknown;
}
export type ToolHandler = (
  runner: GodotRunner,
  args: OperationParams,
) => Promise<ToolResponse> | ToolResponse;

export const toolDispatch: Record<string, ToolHandler> = {
  // Project tools
  launch_editor: (runner, args) => handleLaunchEditor(runner, args),
  run_project: (runner, args) => handleRunProject(runner, args),
  attach_project: (runner, args) => handleAttachProject(runner, args),
  detach_project: (runner) => handleDetachProject(runner),
  get_debug_output: (runner, args) => handleGetDebugOutput(runner, args),
  stop_project: (runner) => handleStopProject(runner),
  list_projects: (_runner, args) => handleListProjects(args),
  get_project_info: (runner, args) => handleGetProjectInfo(runner, args),
  take_screenshot: (runner, args) => handleTakeScreenshot(runner, args),
  simulate_input: (runner, args) => handleSimulateInput(runner, args),
  get_ui_elements: (runner, args) => handleGetUiElements(runner, args),
  run_script: (runner, args) => handleRunScript(runner, args),
  list_autoloads: (_runner, args) => handleListAutoloads(args),
  add_autoload: (_runner, args) => handleAddAutoload(args),
  remove_autoload: (_runner, args) => handleRemoveAutoload(args),
  update_autoload: (_runner, args) => handleUpdateAutoload(args),
  get_project_files: (_runner, args) => handleGetProjectFiles(args),
  search_project: (_runner, args) => handleSearchProject(args),
  get_scene_dependencies: (_runner, args) => handleGetSceneDependencies(args),
  get_project_settings: (_runner, args) => handleGetProjectSettings(args),

  // Scene tools
  create_scene: (runner, args) => handleCreateScene(runner, args),
  add_node: (runner, args) => handleAddNode(runner, args),
  load_sprite: (runner, args) => handleLoadSprite(runner, args),
  save_scene: (runner, args) => handleSaveScene(runner, args),
  export_mesh_library: (runner, args) => handleExportMeshLibrary(runner, args),
  batch_scene_operations: (runner, args) => handleBatchSceneOperations(runner, args),

  // Node tools
  delete_nodes: (runner, args) => handleDeleteNodes(runner, args),
  set_node_properties: (runner, args) => handleSetNodeProperties(runner, args),
  get_node_properties: (runner, args) => handleGetNodeProperties(runner, args),
  attach_script: (runner, args) => handleAttachScript(runner, args),
  get_scene_tree: (runner, args) => handleGetSceneTree(runner, args),
  duplicate_node: (runner, args) => handleDuplicateNode(runner, args),
  get_node_signals: (runner, args) => handleGetNodeSignals(runner, args),
  connect_signal: (runner, args) => handleConnectSignal(runner, args),
  disconnect_signal: (runner, args) => handleDisconnectSignal(runner, args),

  // Validate tools
  validate: (runner, args) => handleValidate(runner, args),
};

export async function dispatchToolCall(
  runner: GodotRunner,
  toolName: string,
  args: OperationParams,
): Promise<ToolResponse> {
  const handler = toolDispatch[toolName];
  if (!handler) {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
  }
  return await handler(runner, args);
}
