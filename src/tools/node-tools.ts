import { join } from 'path';
import { existsSync } from 'fs';
import {
  GodotRunner,
  normalizeParameters,
  validatePath,
  createErrorResponse,
  OperationParams,
  ToolDefinition,
} from '../utils/godot-runner.js';

export const nodeToolDefinitions: ToolDefinition[] = [
  {
    name: 'manage_node',
    description: 'Manage nodes within a Godot scene. Operations:\n- delete: Remove a node (required: nodePath)\n- update_property: Set a property value (required: nodePath, property, value)\n- get_properties: Get all properties of a node (required: nodePath)\n- attach_script: Attach/change a script on a node (required: nodePath, scriptPath)\n- list: List child nodes (optional: parentPath)\n- get_tree: Get full hierarchical tree (optional: parentPath to scope)',
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['delete', 'update_property', 'get_properties', 'attach_script', 'list', 'get_tree'],
          description: 'The node operation to perform',
        },
        projectPath: {
          type: 'string',
          description: 'Path to the Godot project directory',
        },
        scenePath: {
          type: 'string',
          description: 'Path to the scene file (relative to project)',
        },
        nodePath: {
          type: 'string',
          description: 'Node path within scene (e.g. "root/Player/Sprite2D"). Required for delete, update_property, get_properties, attach_script.',
        },
        property: {
          type: 'string',
          description: '[update_property] Name of the property to update',
        },
        value: {
          description: '[update_property] New value for the property (any type)',
        },
        scriptPath: {
          type: 'string',
          description: '[attach_script] Path to the GDScript file (relative to project)',
        },
        parentPath: {
          type: 'string',
          description: '[list, get_tree] Parent node path to scope results (default: root)',
        },
        changedOnly: {
          type: 'boolean',
          description: '[get_properties] Only return properties that differ from defaults (default: false)',
        },
        maxDepth: {
          type: 'number',
          description: '[get_tree] Max depth to recurse (-1 for unlimited, default: -1)',
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
    return createErrorResponse('operation is required', ['Provide one of: delete, update_property, get_properties, attach_script, list, get_tree']);
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
  const needsNodePath = ['delete', 'update_property', 'get_properties', 'attach_script'];
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
        if (stderr && stderr.includes('Failed to')) {
          return createErrorResponse(`Failed to delete node: ${stderr}`, ['Check if the node path is correct']);
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
        if (stderr && stderr.includes('Failed to')) {
          return createErrorResponse(`Failed to update property: ${stderr}`, ['Check if the property name is valid for this node type']);
        }
        return { content: [{ type: 'text', text: stdout }] };
      }

      case 'get_properties': {
        const params: OperationParams = { scenePath: args.scenePath, nodePath: args.nodePath };
        if (args.changedOnly) params.changedOnly = args.changedOnly;
        const { stdout, stderr } = await runner.executeOperation('get_node_properties', params, args.projectPath as string);
        if (stderr && stderr.includes('Failed to')) {
          return createErrorResponse(`Failed to get properties: ${stderr}`, ['Check if the node path is correct']);
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
        if (stderr && stderr.includes('Failed to')) {
          return createErrorResponse(`Failed to attach script: ${stderr}`, ['Ensure the script is valid for this node type']);
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
        if (stderr && stderr.includes('Failed to')) {
          return createErrorResponse(`Failed to list nodes: ${stderr}`, ['Check if the parent path is correct']);
        }
        return { content: [{ type: 'text', text: stdout }] };
      }

      case 'get_tree': {
        const params: OperationParams = { scenePath: args.scenePath };
        if (args.parentPath) params.parentPath = args.parentPath;
        if (typeof args.maxDepth === 'number') params.maxDepth = args.maxDepth;
        const { stdout, stderr } = await runner.executeOperation('get_scene_tree', params, args.projectPath as string);
        if (stderr && stderr.includes('Failed to')) {
          return createErrorResponse(`Failed to get scene tree: ${stderr}`, ['Ensure the scene is valid']);
        }
        return { content: [{ type: 'text', text: stdout }] };
      }

      default:
        return createErrorResponse(`Unknown operation: ${operation}`, ['Use one of: delete, update_property, get_properties, attach_script, list, get_tree']);
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(
      `Failed to ${operation} node: ${errorMessage}`,
      ['Ensure Godot is installed correctly', 'Check if the GODOT_PATH environment variable is set correctly']
    );
  }
}
