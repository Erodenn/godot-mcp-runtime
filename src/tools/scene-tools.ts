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

export const sceneToolDefinitions: ToolDefinition[] = [
  {
    name: 'manage_scene',
    description: 'Manage Godot scene files. Operations:\n- create: Create new scene (optional: rootNodeType, default Node2D)\n- add_node: Add node to scene (required: nodeType, nodeName; optional: parentNodePath, properties)\n- load_sprite: Load texture into Sprite2D (required: nodePath, texturePath)\n- save: Save scene file (optional: newPath for save-as)\n- export_mesh_library: Export as MeshLibrary (required: outputPath; optional: meshItemNames)',
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['create', 'add_node', 'load_sprite', 'save', 'export_mesh_library'],
          description: 'The scene operation to perform',
        },
        projectPath: {
          type: 'string',
          description: 'Path to the Godot project directory',
        },
        scenePath: {
          type: 'string',
          description: 'Scene file path (relative to project, e.g. "scenes/main.tscn")',
        },
        rootNodeType: {
          type: 'string',
          description: '[create] Root node type (default: Node2D)',
        },
        nodeType: {
          type: 'string',
          description: '[add_node] Type of node to add (e.g. Sprite2D, CollisionShape2D)',
        },
        nodeName: {
          type: 'string',
          description: '[add_node] Name for the new node',
        },
        parentNodePath: {
          type: 'string',
          description: '[add_node] Parent node path (default: root)',
        },
        properties: {
          type: 'object',
          description: '[add_node] Properties to set on the node',
        },
        nodePath: {
          type: 'string',
          description: '[load_sprite] Path to the Sprite2D node',
        },
        texturePath: {
          type: 'string',
          description: '[load_sprite] Path to the texture file (relative to project)',
        },
        newPath: {
          type: 'string',
          description: '[save] New path to save as (for creating variants)',
        },
        outputPath: {
          type: 'string',
          description: '[export_mesh_library] Output path for the MeshLibrary .res file',
        },
        meshItemNames: {
          type: 'array',
          items: { type: 'string' },
          description: '[export_mesh_library] Names of specific mesh items to include',
        },
      },
      required: ['operation', 'projectPath', 'scenePath'],
    },
  },
  {
    name: 'manage_uids',
    description: 'Manage UIDs in a Godot 4.4+ project. Operations:\n- get: Get UID for a file (required: filePath)\n- update: Resave all resources to update UID references',
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['get', 'update'],
          description: 'The UID operation to perform',
        },
        projectPath: {
          type: 'string',
          description: 'Path to the Godot project directory',
        },
        filePath: {
          type: 'string',
          description: '[get] Path to the file (relative to project)',
        },
      },
      required: ['operation', 'projectPath'],
    },
  },
];

export async function handleManageScene(runner: GodotRunner, args: OperationParams) {
  args = normalizeParameters(args);

  const operation = args.operation as string;
  if (!operation) {
    return createErrorResponse('operation is required', ['Provide one of: create, add_node, load_sprite, save, export_mesh_library']);
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

  // Scene file must exist for all operations except 'create'
  if (operation !== 'create') {
    const sceneFullPath = join(args.projectPath as string, args.scenePath as string);
    if (!existsSync(sceneFullPath)) {
      return createErrorResponse(
        `Scene file does not exist: ${args.scenePath}`,
        ['Ensure the scene path is correct', 'Use manage_scene with operation "create" to create a new scene first']
      );
    }
  }

  try {
    switch (operation) {
      case 'create': {
        const params = {
          scenePath: args.scenePath,
          rootNodeType: args.rootNodeType || 'Node2D',
        };
        const { stdout, stderr } = await runner.executeOperation('create_scene', params, args.projectPath as string);
        if (stderr && stderr.includes('Failed to')) {
          return createErrorResponse(`Failed to create scene: ${stderr}`, ['Check if the root node type is valid']);
        }
        return { content: [{ type: 'text', text: stdout }] };
      }

      case 'add_node': {
        if (!args.nodeType || !args.nodeName) {
          return createErrorResponse('nodeType and nodeName are required for add_node', ['Provide both nodeType and nodeName']);
        }
        const params: OperationParams = {
          scenePath: args.scenePath,
          nodeType: args.nodeType,
          nodeName: args.nodeName,
        };
        if (args.parentNodePath) params.parentNodePath = args.parentNodePath;
        if (args.properties) params.properties = args.properties;
        const { stdout, stderr } = await runner.executeOperation('add_node', params, args.projectPath as string);
        if (stderr && stderr.includes('Failed to')) {
          return createErrorResponse(`Failed to add node: ${stderr}`, ['Check if the node type is valid', 'Ensure the parent node path exists']);
        }
        return { content: [{ type: 'text', text: stdout }] };
      }

      case 'load_sprite': {
        if (!args.nodePath || !args.texturePath) {
          return createErrorResponse('nodePath and texturePath are required for load_sprite', ['Provide both nodePath and texturePath']);
        }
        if (!validatePath(args.nodePath as string) || !validatePath(args.texturePath as string)) {
          return createErrorResponse('Invalid path', ['Provide valid paths without ".." or other potentially unsafe characters']);
        }
        const textureFullPath = join(args.projectPath as string, args.texturePath as string);
        if (!existsSync(textureFullPath)) {
          return createErrorResponse(`Texture file does not exist: ${args.texturePath}`, ['Ensure the texture path is correct']);
        }
        const params = {
          scenePath: args.scenePath,
          nodePath: args.nodePath,
          texturePath: args.texturePath,
        };
        const { stdout, stderr } = await runner.executeOperation('load_sprite', params, args.projectPath as string);
        if (stderr && stderr.includes('Failed to')) {
          return createErrorResponse(`Failed to load sprite: ${stderr}`, ['Check if the node is a Sprite2D, Sprite3D, or TextureRect']);
        }
        return { content: [{ type: 'text', text: stdout }] };
      }

      case 'save': {
        if (args.newPath && !validatePath(args.newPath as string)) {
          return createErrorResponse('Invalid new path', ['Provide a valid path without ".."']);
        }
        const params: OperationParams = { scenePath: args.scenePath };
        if (args.newPath) params.newPath = args.newPath;
        const { stdout, stderr } = await runner.executeOperation('save_scene', params, args.projectPath as string);
        if (stderr && stderr.includes('Failed to')) {
          return createErrorResponse(`Failed to save scene: ${stderr}`, ['Check if the scene file is valid']);
        }
        const savePath = args.newPath || args.scenePath;
        return { content: [{ type: 'text', text: stdout }] };
      }

      case 'export_mesh_library': {
        if (!args.outputPath) {
          return createErrorResponse('outputPath is required for export_mesh_library', ['Provide the output path for the .res file']);
        }
        if (!validatePath(args.outputPath as string)) {
          return createErrorResponse('Invalid output path', ['Provide a valid path without ".."']);
        }
        const params: OperationParams = {
          scenePath: args.scenePath,
          outputPath: args.outputPath,
        };
        if (args.meshItemNames && Array.isArray(args.meshItemNames)) {
          params.meshItemNames = args.meshItemNames;
        }
        const { stdout, stderr } = await runner.executeOperation('export_mesh_library', params, args.projectPath as string);
        if (stderr && stderr.includes('Failed to')) {
          return createErrorResponse(`Failed to export mesh library: ${stderr}`, ['Check if the scene contains valid 3D meshes']);
        }
        return { content: [{ type: 'text', text: stdout }] };
      }

      default:
        return createErrorResponse(`Unknown operation: ${operation}`, ['Use one of: create, add_node, load_sprite, save, export_mesh_library']);
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(
      `Failed to ${operation} scene: ${errorMessage}`,
      ['Ensure Godot is installed correctly', 'Check if the GODOT_PATH environment variable is set correctly']
    );
  }
}

export async function handleManageUids(runner: GodotRunner, args: OperationParams) {
  args = normalizeParameters(args);

  const operation = args.operation as string;
  if (!operation) {
    return createErrorResponse('operation is required', ['Provide one of: get, update']);
  }

  if (!args.projectPath) {
    return createErrorResponse('projectPath is required', ['Provide a valid path to a Godot project directory']);
  }

  if (!validatePath(args.projectPath as string)) {
    return createErrorResponse('Invalid project path', ['Provide a valid path without ".."']);
  }

  const projectFile = join(args.projectPath as string, 'project.godot');
  if (!existsSync(projectFile)) {
    return createErrorResponse(
      `Not a valid Godot project: ${args.projectPath}`,
      ['Ensure the path points to a directory containing a project.godot file']
    );
  }

  try {
    const version = await runner.getVersion();
    if (!runner.isGodot44OrLater(version)) {
      return createErrorResponse(
        `UIDs are only supported in Godot 4.4 or later. Current version: ${version}`,
        ['Upgrade to Godot 4.4 or later to use UIDs']
      );
    }

    switch (operation) {
      case 'get': {
        if (!args.filePath) {
          return createErrorResponse('filePath is required for get operation', ['Provide the file path relative to the project']);
        }
        if (!validatePath(args.filePath as string)) {
          return createErrorResponse('Invalid file path', ['Provide a valid path without ".."']);
        }
        const fileFullPath = join(args.projectPath as string, args.filePath as string);
        if (!existsSync(fileFullPath)) {
          return createErrorResponse(`File does not exist: ${args.filePath}`, ['Ensure the file path is correct']);
        }
        const params = { filePath: args.filePath };
        const { stdout, stderr } = await runner.executeOperation('get_uid', params, args.projectPath as string);
        if (stderr && stderr.includes('Failed to')) {
          return createErrorResponse(`Failed to get UID: ${stderr}`, ['Check if the file is a valid Godot resource']);
        }
        return { content: [{ type: 'text', text: `UID for ${args.filePath}: ${stdout.trim()}` }] };
      }

      case 'update': {
        const params = { projectPath: args.projectPath };
        const { stdout, stderr } = await runner.executeOperation('resave_resources', params, args.projectPath as string);
        if (stderr && stderr.includes('Failed to')) {
          return createErrorResponse(`Failed to update project UIDs: ${stderr}`, ['Check if the project is valid']);
        }
        return { content: [{ type: 'text', text: stdout }] };
      }

      default:
        return createErrorResponse(`Unknown operation: ${operation}`, ['Use one of: get, update']);
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(
      `Failed to ${operation} UIDs: ${errorMessage}`,
      ['Ensure Godot is installed correctly', 'Check if the GODOT_PATH environment variable is set correctly']
    );
  }
}
