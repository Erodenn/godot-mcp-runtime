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

export const sceneToolDefinitions: ToolDefinition[] = [
  {
    name: 'manage_scene',
    description: 'Manage Godot scene files using headless Godot. All mutation operations (create, add_node, load_sprite) save automatically — no explicit save call needed. Use the save operation only for save-as (newPath) or to re-canonicalize a .tscn file.\n\nOperations:\n- create: Create a new scene file (optional: rootNodeType, default Node2D)\n- add_node: Add a node to the scene (required: nodeType, nodeName; optional: parentNodePath, properties)\n- load_sprite: Set the texture on a Sprite2D, Sprite3D, or TextureRect node (required: nodePath, texturePath)\n- save: Re-pack and save the scene, optionally to a different path (optional: newPath for save-as)\n- export_mesh_library: Export scene as a MeshLibrary .res file (required: outputPath; optional: meshItemNames)',
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
          description: 'Scene file path relative to the project (e.g. "scenes/main.tscn")',
        },
        rootNodeType: {
          type: 'string',
          description: '[create] Root node type (default: Node2D)',
        },
        nodeType: {
          type: 'string',
          description: '[add_node] Godot node class to instantiate (e.g. "Sprite2D", "CollisionShape2D", "Label")',
        },
        nodeName: {
          type: 'string',
          description: '[add_node] Name for the new node as it appears in the scene tree',
        },
        parentNodePath: {
          type: 'string',
          description: '[add_node] Parent node path from scene root (e.g. "root/Player"). Defaults to the root node.',
        },
        properties: {
          type: 'object',
          description: '[add_node] Initial property values as a JSON object (e.g. {"position": {"x": 100, "y": 200}}). Supports primitives and nested objects for Vector2/Color.',
        },
        nodePath: {
          type: 'string',
          description: '[load_sprite] Path to the target node from scene root (e.g. "root/Player/Sprite2D")',
        },
        texturePath: {
          type: 'string',
          description: '[load_sprite] Path to the texture file relative to the project (e.g. "assets/player.png")',
        },
        newPath: {
          type: 'string',
          description: '[save] Save to a different path (relative to project) instead of overwriting the original',
        },
        outputPath: {
          type: 'string',
          description: '[export_mesh_library] Output path for the MeshLibrary .res file (relative to project)',
        },
        meshItemNames: {
          type: 'array',
          items: { type: 'string' },
          description: '[export_mesh_library] Names of specific mesh items to export. Omit to export all.',
        },
      },
      required: ['operation', 'projectPath', 'scenePath'],
    },
  },
  {
    name: 'manage_uids',
    description: 'Manage resource UIDs in a Godot 4.4+ project. Requires Godot 4.4 or later — will error on older versions. UIDs are stable identifiers that let resources reference each other across renames and moves.\n\nOperations:\n- get: Get the UID string for a specific file (required: filePath)\n- update: Resave all project resources to regenerate UID references (use after reorganizing files)',
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
          description: '[get] Path to the file relative to the project (e.g. "scenes/player.tscn")',
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
        if (!stdout.trim()) {
          return createErrorResponse(`Failed to create scene: ${extractGdError(stderr)}`, ['Check if the root node type is valid']);
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
        if (!stdout.trim()) {
          return createErrorResponse(`Failed to add node: ${extractGdError(stderr)}`, ['Check if the node type is valid', 'Ensure the parent node path exists']);
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
        if (!stdout.trim()) {
          return createErrorResponse(`Failed to load sprite: ${extractGdError(stderr)}`, ['Check if the node is a Sprite2D, Sprite3D, or TextureRect']);
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
        if (!stdout.trim()) {
          return createErrorResponse(`Failed to save scene: ${extractGdError(stderr)}`, ['Check if the scene file is valid']);
        }
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
        if (!stdout.trim()) {
          return createErrorResponse(`Failed to export mesh library: ${extractGdError(stderr)}`, ['Check if the scene contains valid 3D meshes']);
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
        if (!stdout.trim()) {
          return createErrorResponse(`Failed to get UID: ${extractGdError(stderr)}`, ['Check if the file is a valid Godot resource']);
        }
        return { content: [{ type: 'text', text: `UID for ${args.filePath}: ${stdout.trim()}` }] };
      }

      case 'update': {
        const params = { projectPath: args.projectPath };
        const { stdout, stderr } = await runner.executeOperation('resave_resources', params, args.projectPath as string);
        if (!stdout.trim()) {
          return createErrorResponse(`Failed to update project UIDs: ${extractGdError(stderr)}`, ['Check if the project is valid']);
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
