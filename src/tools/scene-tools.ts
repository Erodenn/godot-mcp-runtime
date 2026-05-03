import { join } from 'path';
import { existsSync } from 'fs';
import type { GodotRunner, OperationParams, ToolDefinition } from '../utils/godot-runner.js';
import {
  normalizeParameters,
  convertCamelToSnakeCase,
  validatePath,
  createErrorResponse,
  extractGdError,
  validateProjectArgs,
  validateSceneArgs,
} from '../utils/godot-runner.js';

export const sceneToolDefinitions: ToolDefinition[] = [
  {
    name: 'create_scene',
    description:
      'Create a new Godot scene file with a single root node. Writes a fresh .tscn at scenePath. Use when starting a new scene from scratch; for adding nodes to an existing scene, use add_node. rootNodeType defaults to Node2D — pass "Node3D" for 3D scenes or "Control" for UI. Saves automatically. Overwrites silently if the file already exists. Returns { success, scenePath } as JSON text.',
    annotations: { idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
        scenePath: {
          type: 'string',
          description: 'Scene file path relative to the project (e.g. "scenes/main.tscn")',
        },
        rootNodeType: { type: 'string', description: 'Root node type (default: Node2D)' },
      },
      required: ['projectPath', 'scenePath'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        scenePath: { type: 'string' },
      },
    },
  },
  {
    name: 'add_node',
    description:
      'Add a node to a Godot scene. Saves automatically. Common spatial properties (position, position3d, rotation, scale, visible, modulate) can be set as top-level params; for any other property, pass it under properties. Vector2/Vector3/Color values auto-convert from {x,y}/{x,y,z}/{r,g,b,a}. parentNodePath defaults to the scene root. Errors if nodeType is not a registered Godot class or parentNodePath does not exist.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
        scenePath: { type: 'string', description: 'Scene file path relative to the project' },
        nodeType: {
          type: 'string',
          description:
            'Godot node class to instantiate (e.g. "Sprite2D", "CollisionShape2D", "Label")',
        },
        nodeName: {
          type: 'string',
          description: 'Name for the new node as it appears in the scene tree',
        },
        parentNodePath: {
          type: 'string',
          description:
            'Parent node path from scene root (e.g. "root/Player"). Defaults to the root node.',
        },
        position: {
          type: 'object',
          description: 'Vector2 position (e.g. {"x": 100, "y": 200})',
          properties: { x: { type: 'number' }, y: { type: 'number' } },
        },
        position3d: {
          type: 'object',
          description: 'Vector3 position for 3D nodes (e.g. {"x": 0, "y": 1, "z": 0})',
          properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
        },
        rotation: { type: 'number', description: 'Rotation in radians' },
        scale: {
          type: 'object',
          description: 'Vector2 scale (e.g. {"x": 2, "y": 2})',
          properties: { x: { type: 'number' }, y: { type: 'number' } },
        },
        visible: { type: 'boolean', description: 'Whether the node is visible' },
        modulate: {
          type: 'object',
          description: 'Color modulation (e.g. {"r": 1, "g": 0, "b": 0, "a": 1})',
          properties: {
            r: { type: 'number' },
            g: { type: 'number' },
            b: { type: 'number' },
            a: { type: 'number' },
          },
        },
        properties: {
          type: 'object',
          description:
            'Additional property values as a JSON object. Top-level params (position, rotation, etc.) take precedence over keys in this dict.',
        },
      },
      required: ['projectPath', 'scenePath', 'nodeType', 'nodeName'],
    },
  },
  {
    name: 'load_sprite',
    description:
      'Set the texture on an existing Sprite2D, Sprite3D, or TextureRect node. Use this when the node already exists; for new nodes, pass texture via add_node properties. Saves automatically. texturePath must be a real file under projectPath. Errors if the node is not one of those three classes, or the texture file does not exist.',
    annotations: { idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
        scenePath: { type: 'string', description: 'Scene file path relative to the project' },
        nodePath: {
          type: 'string',
          description: 'Path to the target node from scene root (e.g. "root/Player/Sprite2D")',
        },
        texturePath: {
          type: 'string',
          description:
            'Path to the texture file relative to the project (e.g. "assets/player.png")',
        },
      },
      required: ['projectPath', 'scenePath', 'nodePath', 'texturePath'],
    },
  },
  {
    name: 'save_scene',
    description:
      'Re-pack and save a scene, optionally to a different path (save-as). Most mutations (add_node, set_node_properties, delete_nodes, etc.) auto-save — only use this for save-as via newPath, or to re-canonicalize a hand-edited .tscn. Overwrites silently. Errors if the scene file does not exist.',
    annotations: { idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
        scenePath: { type: 'string', description: 'Scene file path relative to the project' },
        newPath: {
          type: 'string',
          description:
            'Save to a different path (relative to project) instead of overwriting the original',
        },
      },
      required: ['projectPath', 'scenePath'],
    },
  },
  {
    name: 'export_mesh_library',
    description:
      'Export a scene of MeshInstance3D nodes as a MeshLibrary .res file for use in GridMap. Use this when authoring tile palettes for grid-based 3D levels; ignore for 2D or general scene work. The source scene must contain MeshInstance3D children. Pass meshItemNames to export a subset, or omit to export all. Saves the .res to outputPath, overwriting silently. Errors if the scene contains no valid meshes.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
        scenePath: { type: 'string', description: 'Scene file path relative to the project' },
        outputPath: {
          type: 'string',
          description: 'Output path for the MeshLibrary .res file (relative to project)',
        },
        meshItemNames: {
          type: 'array',
          items: { type: 'string' },
          description: 'Names of specific mesh items to export. Omit to export all.',
        },
      },
      required: ['projectPath', 'scenePath', 'outputPath'],
    },
  },
  {
    name: 'batch_scene_operations',
    description:
      'Use this instead of chaining add_node / load_sprite / save_scene calls when you have multiple mutations on the same or related scenes — runs in one Godot process (~3s startup avoided per call) and shares an in-memory scene cache, saving once at the end. Each item picks its sub-operation (add_node, load_sprite, save) and supplies its own params; abortOnError stops on first failure (default false continues). Returns { results: [{ operation, scenePath, success?, error? }] }.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
        operations: {
          type: 'array',
          description:
            'Ordered list of scene operations. Each item has its own operation and scenePath.',
          items: {
            type: 'object',
            properties: {
              operation: {
                type: 'string',
                enum: ['add_node', 'load_sprite', 'save'],
                description: 'The sub-operation to perform',
              },
              scenePath: { type: 'string', description: 'Scene file path for this operation' },
              nodeType: { type: 'string', description: '[add_node] Node class to instantiate' },
              nodeName: { type: 'string', description: '[add_node] Name for the new node' },
              parentNodePath: {
                type: 'string',
                description: '[add_node] Parent node path (defaults to root)',
              },
              properties: { type: 'object', description: '[add_node] Initial property values' },
              nodePath: { type: 'string', description: '[load_sprite] Target node path' },
              texturePath: {
                type: 'string',
                description: '[load_sprite] Texture file path relative to project',
              },
              newPath: {
                type: 'string',
                description: '[save] Save to a different path instead of overwriting',
              },
            },
            required: ['operation'],
          },
        },
        abortOnError: {
          type: 'boolean',
          description: 'Stop processing on first error (default: false)',
        },
      },
      required: ['projectPath', 'operations'],
    },
  },
];

// --- Handlers ---

export async function handleCreateScene(runner: GodotRunner, args: OperationParams) {
  args = normalizeParameters(args);
  const v = validateSceneArgs(args, { sceneRequired: false });
  if ('isError' in v) return v;

  try {
    const params = {
      scenePath: args.scenePath,
      rootNodeType: args.rootNodeType || 'Node2D',
    };
    const { stdout, stderr } = await runner.executeOperation('create_scene', params, v.projectPath);
    if (!stdout.trim()) {
      return createErrorResponse(`Failed to create scene: ${extractGdError(stderr)}`, [
        'Check if the root node type is valid',
      ]);
    }
    return { content: [{ type: 'text', text: stdout }] };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Failed to create scene: ${errorMessage}`, [
      'Ensure Godot is installed correctly',
    ]);
  }
}

export async function handleAddNode(runner: GodotRunner, args: OperationParams) {
  args = normalizeParameters(args);
  const v = validateSceneArgs(args);
  if ('isError' in v) return v;

  if (!args.nodeType || !args.nodeName) {
    return createErrorResponse('nodeType and nodeName are required', [
      'Provide both nodeType and nodeName',
    ]);
  }

  // Merge promoted top-level params into properties dict
  const promotedKeys = [
    'position',
    'position3d',
    'rotation',
    'scale',
    'visible',
    'modulate',
  ] as const;
  const mergedProps: OperationParams = (args.properties as OperationParams) || {};
  for (const key of promotedKeys) {
    if (args[key] !== undefined) {
      mergedProps[key] = args[key];
    }
  }

  try {
    const params: OperationParams = {
      scenePath: args.scenePath,
      nodeType: args.nodeType,
      nodeName: args.nodeName,
    };
    if (args.parentNodePath) params.parentNodePath = args.parentNodePath;
    if (Object.keys(mergedProps).length > 0) params.properties = mergedProps;
    const { stdout, stderr } = await runner.executeOperation('add_node', params, v.projectPath);
    if (!stdout.trim()) {
      return createErrorResponse(`Failed to add node: ${extractGdError(stderr)}`, [
        'Check if the node type is valid',
        'Ensure the parent node path exists',
      ]);
    }
    return { content: [{ type: 'text', text: stdout }] };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Failed to add node: ${errorMessage}`, [
      'Ensure Godot is installed correctly',
    ]);
  }
}

export async function handleLoadSprite(runner: GodotRunner, args: OperationParams) {
  args = normalizeParameters(args);
  const v = validateSceneArgs(args);
  if ('isError' in v) return v;

  if (!args.nodePath || !validatePath(args.nodePath as string)) {
    return createErrorResponse('Valid nodePath is required', ['Provide the target node path']);
  }
  if (!args.texturePath || !validatePath(args.texturePath as string)) {
    return createErrorResponse('Valid texturePath is required', [
      'Provide the texture path relative to the project',
    ]);
  }
  const textureFullPath = join(v.projectPath, args.texturePath as string);
  if (!existsSync(textureFullPath)) {
    return createErrorResponse(`Texture file does not exist: ${args.texturePath}`, [
      'Ensure the texture path is correct',
    ]);
  }

  try {
    const params = {
      scenePath: args.scenePath,
      nodePath: args.nodePath,
      texturePath: args.texturePath,
    };
    const { stdout, stderr } = await runner.executeOperation('load_sprite', params, v.projectPath);
    if (!stdout.trim()) {
      return createErrorResponse(`Failed to load sprite: ${extractGdError(stderr)}`, [
        'Check if the node is a Sprite2D, Sprite3D, or TextureRect',
      ]);
    }
    return { content: [{ type: 'text', text: stdout }] };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Failed to load sprite: ${errorMessage}`, [
      'Ensure Godot is installed correctly',
    ]);
  }
}

export async function handleSaveScene(runner: GodotRunner, args: OperationParams) {
  args = normalizeParameters(args);
  const v = validateSceneArgs(args);
  if ('isError' in v) return v;

  if (args.newPath && !validatePath(args.newPath as string)) {
    return createErrorResponse('Invalid newPath', ['Provide a valid path without ".."']);
  }

  try {
    const params: OperationParams = { scenePath: args.scenePath };
    if (args.newPath) params.newPath = args.newPath;
    const { stdout, stderr } = await runner.executeOperation('save_scene', params, v.projectPath);
    if (!stdout.trim()) {
      return createErrorResponse(`Failed to save scene: ${extractGdError(stderr)}`, [
        'Check if the scene file is valid',
      ]);
    }
    return { content: [{ type: 'text', text: stdout }] };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Failed to save scene: ${errorMessage}`, [
      'Ensure Godot is installed correctly',
    ]);
  }
}

export async function handleExportMeshLibrary(runner: GodotRunner, args: OperationParams) {
  args = normalizeParameters(args);
  const v = validateSceneArgs(args);
  if ('isError' in v) return v;

  if (!args.outputPath || !validatePath(args.outputPath as string)) {
    return createErrorResponse('Valid outputPath is required', [
      'Provide the output path for the .res file',
    ]);
  }

  try {
    const params: OperationParams = {
      scenePath: args.scenePath,
      outputPath: args.outputPath,
    };
    if (args.meshItemNames && Array.isArray(args.meshItemNames)) {
      params.meshItemNames = args.meshItemNames;
    }
    const { stdout, stderr } = await runner.executeOperation(
      'export_mesh_library',
      params,
      v.projectPath,
    );
    if (!stdout.trim()) {
      return createErrorResponse(`Failed to export mesh library: ${extractGdError(stderr)}`, [
        'Check if the scene contains valid 3D meshes',
      ]);
    }
    return { content: [{ type: 'text', text: stdout }] };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Failed to export mesh library: ${errorMessage}`, [
      'Ensure Godot is installed correctly',
    ]);
  }
}

export async function handleBatchSceneOperations(runner: GodotRunner, args: OperationParams) {
  args = normalizeParameters(args);
  const v = validateProjectArgs(args);
  if ('isError' in v) return v;

  if (!args.operations || !Array.isArray(args.operations)) {
    return createErrorResponse('operations array is required', [
      'Provide an operations array with at least one item',
    ]);
  }

  try {
    const snakeOps = (args.operations as Array<Record<string, unknown>>).map((op) =>
      convertCamelToSnakeCase(op as OperationParams),
    );
    const params = {
      operations: snakeOps,
      abortOnError: args.abortOnError ?? false,
    };
    const { stdout, stderr } = await runner.executeOperation(
      'batch_scene_operations',
      params,
      v.projectPath,
    );
    if (!stdout.trim()) {
      return createErrorResponse(`Batch scene operations failed: ${extractGdError(stderr)}`, [
        'Check that all scene paths exist',
        'Ensure node types are valid',
      ]);
    }
    return { content: [{ type: 'text', text: stdout }] };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Batch scene operations failed: ${errorMessage}`, [
      'Ensure Godot is installed correctly',
    ]);
  }
}
