import { join } from 'path';
import { existsSync } from 'fs';
import {
  GodotRunner,
  normalizeParameters,
  validatePath,
  createErrorResponse,
  extractGdError,
  OperationParams,
  ToolDefinition,
} from '../utils/godot-runner.js';

export const nodeToolDefinitions: ToolDefinition[] = [
  {
    name: 'manage_node',
    description: 'Read or modify nodes in a Godot scene file using headless Godot. All mutation operations (delete, update_property, attach_script, duplicate, connect_signal, disconnect_signal) save automatically — no explicit save call needed.\n\nOperations:\n- delete: Remove a node from the scene (required: nodePath)\n- update_property: Set a property on a node (required: nodePath, property, value)\n- get_properties: Read a node\'s current property values (required: nodePath; optional: changedOnly)\n- attach_script: Attach a GDScript file to a node (required: nodePath, scriptPath)\n- list: List direct child node names and types (optional: parentPath)\n- get_tree: Get the full scene hierarchy as a tree structure, always from root (optional: maxDepth)\n- duplicate: Duplicate a node and its children (required: nodePath; optional: newName, targetParentPath)\n- get_signals: List all signals defined on a node and their current connections (required: nodePath). Returns { nodePath, nodeType, signals: [{ name, connections: [{ signal, target, method }] }] }. Note: the target field uses Godot absolute path format (e.g. /root/Scene/Node) — convert to scene-root-relative (e.g. root/Node) before passing to connect_signal or disconnect_signal.\n- connect_signal: Connect a signal from one node to a method on another (required: nodePath, signal, targetNodePath, method). Errors if the signal does not exist on the source node or the method does not exist on the target node.\n- disconnect_signal: Disconnect a signal connection (required: nodePath, signal, targetNodePath, method). Errors if the connection does not exist — use get_signals first to verify it is present.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['delete', 'update_property', 'get_properties', 'attach_script', 'list', 'get_tree', 'duplicate', 'get_signals', 'connect_signal', 'disconnect_signal'],
          description: 'The node operation to perform',
        },
        projectPath: {
          type: 'string',
          description: 'Path to the Godot project directory',
        },
        scenePath: {
          type: 'string',
          description: 'Path to the scene file relative to the project (e.g. "scenes/main.tscn")',
        },
        nodePath: {
          type: 'string',
          description: 'Node path from scene root (e.g. "root/Player/Sprite2D"). Required for delete, update_property, get_properties, attach_script, duplicate, get_signals, connect_signal, disconnect_signal.',
        },
        property: {
          type: 'string',
          description: '[update_property] GDScript property name in snake_case (e.g. "position", "modulate", "collision_layer"). Use get_properties to discover valid property names.',
        },
        value: {
          description: '[update_property] New property value. Primitives (string, number, boolean, array, object) are passed as-is. Vector2 ({"x","y"}), Vector3 ({"x","y","z"}), and Color ({"r","g","b","a"}) are automatically converted. Use run_script for other complex GDScript types.',
        },
        scriptPath: {
          type: 'string',
          description: '[attach_script] Path to the GDScript file relative to the project (e.g. "scripts/player.gd")',
        },
        parentPath: {
          type: 'string',
          description: '[list] Scope results to this node path from scene root (e.g. "root/Player"). Defaults to the root node. Note: ignored by get_tree, which always starts from the scene root.',
        },
        changedOnly: {
          type: 'boolean',
          description: '[get_properties] Only return properties whose values differ from their class defaults (default: false)',
        },
        maxDepth: {
          type: 'number',
          description: '[get_tree] Maximum recursion depth. -1 for unlimited (default: -1). 1 returns only direct children.',
        },
        newName: {
          type: 'string',
          description: '[duplicate] Name for the duplicated node. Defaults to the original name + "2".',
        },
        targetParentPath: {
          type: 'string',
          description: '[duplicate] Node path of the parent to add the duplicate to. Defaults to the same parent as the original.',
        },
        signal: {
          type: 'string',
          description: '[connect_signal, disconnect_signal] Signal name on the source node (e.g. "pressed", "body_entered")',
        },
        targetNodePath: {
          type: 'string',
          description: '[connect_signal, disconnect_signal] Path of the target node that receives the signal (from scene root)',
        },
        method: {
          type: 'string',
          description: '[connect_signal, disconnect_signal] Method name on the target node to call when the signal fires',
        },
      },
      required: ['operation', 'projectPath', 'scenePath'],
    },
  },
];

export async function handleManageNode(runner: GodotRunner, args: OperationParams) {
  args = normalizeParameters(args);

  const operation = args.operation as string;
  if (!operation) {
    return createErrorResponse('operation is required', ['Provide one of: delete, update_property, get_properties, attach_script, list, get_tree, duplicate, get_signals, connect_signal, disconnect_signal']);
  }

  if (!args.projectPath || !args.scenePath) {
    return createErrorResponse('projectPath and scenePath are required', ['Provide valid paths for both']);
  }

  if (!validatePath(args.projectPath as string) || !validatePath(args.scenePath as string)) {
    return createErrorResponse('Invalid path', ['Provide valid paths without ".." or other potentially unsafe characters']);
  }

  const projectFile = join(args.projectPath as string, 'project.godot');
  if (!existsSync(projectFile)) {
    return createErrorResponse(
      `Not a valid Godot project: ${args.projectPath}`,
      ['Ensure the path points to a directory containing a project.godot file']
    );
  }

  const sceneFullPath = join(args.projectPath as string, args.scenePath as string);
  if (!existsSync(sceneFullPath)) {
    return createErrorResponse(
      `Scene file does not exist: ${args.scenePath}`,
      ['Ensure the scene path is correct']
    );
  }

  // Operations that require nodePath
  const needsNodePath = ['delete', 'update_property', 'get_properties', 'attach_script', 'duplicate', 'get_signals', 'connect_signal', 'disconnect_signal'];
  if (needsNodePath.includes(operation)) {
    if (!args.nodePath) {
      return createErrorResponse(`nodePath is required for ${operation}`, ['Provide the node path (e.g. "root/Player")']);
    }
    if (!validatePath(args.nodePath as string)) {
      return createErrorResponse('Invalid node path', ['Provide a valid path without ".."']);
    }
  }

  try {
    switch (operation) {
      case 'delete': {
        const params = { scenePath: args.scenePath, nodePath: args.nodePath };
        const { stdout, stderr } = await runner.executeOperation('delete_node', params, args.projectPath as string);
        if (!stdout.trim()) {
          return createErrorResponse(`Failed to delete node: ${extractGdError(stderr)}`, ['Check if the node path is correct']);
        }
        return { content: [{ type: 'text', text: stdout }] };
      }

      case 'update_property': {
        if (!args.property || args.value === undefined) {
          return createErrorResponse('property and value are required for update_property', ['Provide both property name and value']);
        }
        const params = {
          scenePath: args.scenePath,
          nodePath: args.nodePath,
          property: args.property,
          value: args.value,
        };
        const { stdout, stderr } = await runner.executeOperation('update_node_property', params, args.projectPath as string);
        if (!stdout.trim()) {
          return createErrorResponse(`Failed to update property: ${extractGdError(stderr)}`, ['Check if the property name is valid for this node type']);
        }
        return { content: [{ type: 'text', text: stdout }] };
      }

      case 'get_properties': {
        const params: OperationParams = { scenePath: args.scenePath, nodePath: args.nodePath };
        if (args.changedOnly) params.changedOnly = args.changedOnly;
        const { stdout, stderr } = await runner.executeOperation('get_node_properties', params, args.projectPath as string);
        if (!stdout.trim()) {
          return createErrorResponse(`Failed to get properties: ${extractGdError(stderr)}`, ['Check if the node path is correct']);
        }
        return { content: [{ type: 'text', text: stdout }] };
      }

      case 'attach_script': {
        if (!args.scriptPath) {
          return createErrorResponse('scriptPath is required for attach_script', ['Provide the script path relative to the project']);
        }
        if (!validatePath(args.scriptPath as string)) {
          return createErrorResponse('Invalid script path', ['Provide a valid path without ".."']);
        }
        const scriptFullPath = join(args.projectPath as string, args.scriptPath as string);
        if (!existsSync(scriptFullPath)) {
          return createErrorResponse(`Script file does not exist: ${args.scriptPath}`, ['Create the script file first']);
        }
        const params = {
          scenePath: args.scenePath,
          nodePath: args.nodePath,
          scriptPath: args.scriptPath,
        };
        const { stdout, stderr } = await runner.executeOperation('attach_script', params, args.projectPath as string);
        if (!stdout.trim()) {
          return createErrorResponse(`Failed to attach script: ${extractGdError(stderr)}`, ['Ensure the script is valid for this node type']);
        }
        return { content: [{ type: 'text', text: stdout }] };
      }

      case 'list': {
        if (args.parentPath && !validatePath(args.parentPath as string)) {
          return createErrorResponse('Invalid parent path', ['Provide a valid path without ".."']);
        }
        const params: OperationParams = { scenePath: args.scenePath };
        if (args.parentPath) params.parentPath = args.parentPath;
        const { stdout, stderr } = await runner.executeOperation('list_nodes', params, args.projectPath as string);
        if (!stdout.trim()) {
          return createErrorResponse(`Failed to list nodes: ${extractGdError(stderr)}`, ['Check if the parent path is correct']);
        }
        return { content: [{ type: 'text', text: stdout }] };
      }

      case 'get_tree': {
        const params: OperationParams = { scenePath: args.scenePath };
        if (args.parentPath) params.parentPath = args.parentPath;
        if (typeof args.maxDepth === 'number') params.maxDepth = args.maxDepth;
        const { stdout, stderr } = await runner.executeOperation('get_scene_tree', params, args.projectPath as string);
        if (!stdout.trim()) {
          return createErrorResponse(`Failed to get scene tree: ${extractGdError(stderr)}`, ['Ensure the scene is valid']);
        }
        return { content: [{ type: 'text', text: stdout }] };
      }

      case 'duplicate': {
        if (args.targetParentPath && !validatePath(args.targetParentPath as string)) {
          return createErrorResponse('Invalid targetParentPath', ['Provide a valid path without ".."']);
        }
        const params: OperationParams = { scenePath: args.scenePath, nodePath: args.nodePath };
        if (args.newName) params.newName = args.newName;
        if (args.targetParentPath) params.targetParentPath = args.targetParentPath;
        const { stdout, stderr } = await runner.executeOperation('duplicate_node', params, args.projectPath as string);
        if (!stdout.trim()) {
          return createErrorResponse(`Failed to duplicate node: ${extractGdError(stderr)}`, ['Check if the node path and target parent path are correct']);
        }
        return { content: [{ type: 'text', text: stdout }] };
      }

      case 'get_signals': {
        const params = { scenePath: args.scenePath, nodePath: args.nodePath };
        const { stdout, stderr } = await runner.executeOperation('get_node_signals', params, args.projectPath as string);
        if (!stdout.trim()) {
          return createErrorResponse(`Failed to get signals: ${extractGdError(stderr)}`, ['Check if the node path is correct']);
        }
        return { content: [{ type: 'text', text: stdout }] };
      }

      case 'connect_signal': {
        if (!args.signal || !args.targetNodePath || !args.method) {
          return createErrorResponse('signal, targetNodePath, and method are required for connect_signal', ['Provide all three parameters']);
        }
        if (!validatePath(args.targetNodePath as string)) {
          return createErrorResponse('Invalid targetNodePath', ['Provide a valid path without ".."']);
        }
        const params = {
          scenePath: args.scenePath,
          nodePath: args.nodePath,
          signal: args.signal,
          targetNodePath: args.targetNodePath,
          method: args.method,
        };
        const { stdout, stderr } = await runner.executeOperation('connect_node_signal', params, args.projectPath as string);
        if (!stdout.trim()) {
          return createErrorResponse(`Failed to connect signal: ${extractGdError(stderr)}`, ['Ensure the signal exists on the source node and the method exists on the target node']);
        }
        return { content: [{ type: 'text', text: stdout }] };
      }

      case 'disconnect_signal': {
        if (!args.signal || !args.targetNodePath || !args.method) {
          return createErrorResponse('signal, targetNodePath, and method are required for disconnect_signal', ['Provide all three parameters']);
        }
        if (!validatePath(args.targetNodePath as string)) {
          return createErrorResponse('Invalid targetNodePath', ['Provide a valid path without ".."']);
        }
        const params = {
          scenePath: args.scenePath,
          nodePath: args.nodePath,
          signal: args.signal,
          targetNodePath: args.targetNodePath,
          method: args.method,
        };
        const { stdout, stderr } = await runner.executeOperation('disconnect_node_signal', params, args.projectPath as string);
        if (!stdout.trim()) {
          return createErrorResponse(`Failed to disconnect signal: ${extractGdError(stderr)}`, ['Ensure the signal connection exists before trying to disconnect it']);
        }
        return { content: [{ type: 'text', text: stdout }] };
      }

      default:
        return createErrorResponse(`Unknown operation: ${operation}`, ['Use one of: delete, update_property, get_properties, attach_script, list, get_tree, duplicate, get_signals, connect_signal, disconnect_signal']);
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(
      `Failed to ${operation} node: ${errorMessage}`,
      ['Ensure Godot is installed correctly', 'Check if the GODOT_PATH environment variable is set correctly']
    );
  }
}
