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

import type {
  GodotRunner,
  OperationParams,
  ToolHandler,
  ToolResponse,
} from './utils/godot-runner.js';

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

export const toolDispatch: Record<string, ToolHandler> = {
  // Project tools
  launch_editor: handleLaunchEditor,
  run_project: handleRunProject,
  attach_project: handleAttachProject,
  detach_project: handleDetachProject,
  get_debug_output: handleGetDebugOutput,
  stop_project: handleStopProject,
  list_projects: (_runner, args) => handleListProjects(args),
  get_project_info: handleGetProjectInfo,
  take_screenshot: handleTakeScreenshot,
  simulate_input: handleSimulateInput,
  get_ui_elements: handleGetUiElements,
  run_script: handleRunScript,
  list_autoloads: (_runner, args) => handleListAutoloads(args),
  add_autoload: (_runner, args) => handleAddAutoload(args),
  remove_autoload: (_runner, args) => handleRemoveAutoload(args),
  update_autoload: (_runner, args) => handleUpdateAutoload(args),
  get_project_files: (_runner, args) => handleGetProjectFiles(args),
  search_project: (_runner, args) => handleSearchProject(args),
  get_scene_dependencies: (_runner, args) => handleGetSceneDependencies(args),
  get_project_settings: (_runner, args) => handleGetProjectSettings(args),

  // Scene tools
  create_scene: handleCreateScene,
  add_node: handleAddNode,
  load_sprite: handleLoadSprite,
  save_scene: handleSaveScene,
  export_mesh_library: handleExportMeshLibrary,
  batch_scene_operations: handleBatchSceneOperations,

  // Node tools
  delete_nodes: handleDeleteNodes,
  set_node_properties: handleSetNodeProperties,
  get_node_properties: handleGetNodeProperties,
  attach_script: handleAttachScript,
  get_scene_tree: handleGetSceneTree,
  duplicate_node: handleDuplicateNode,
  get_node_signals: handleGetNodeSignals,
  connect_signal: handleConnectSignal,
  disconnect_signal: handleDisconnectSignal,

  // Validate tools
  validate: handleValidate,
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
