import { join } from 'path';
import { existsSync } from 'fs';
import type { GodotRunner } from '../utils/godot-runner.js';
import type { HandlerResult, OperationParams, ToolDefinition } from '../mcp.types.js';
import { normalizeParameters } from '../utils/parameter-conversion.js';
import { validateSubPath } from '../utils/path-validation.js';
import { createErrorResponse } from '../utils/error-response.js';
import {
  parseProjectArgs,
  parseSceneArgs,
  parseRequiredNodePath,
  requireString,
  optionalString,
  optionalStringArray,
  optionalBoolean,
  requireArray,
  optionalObject,
} from '../utils/arg-parsing.js';
import { err } from '../utils/result.js';
import { executeSceneOp } from '../utils/headless-op.js';

export const sceneToolDefinitions = [
  {
    name: 'create_scene',
    description:
      'Create a new Godot scene file with a single root node. Writes a fresh .tscn at scenePath. Use when starting a new scene from scratch; for adding nodes to an existing scene, use add_node. rootNodeType defaults to Node2D — pass "Node3D" for 3D scenes or "Control" for UI. Saves automatically. Overwrites silently if the file already exists. Returns: success and the scenePath that was written.',
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
      'Add a node to a Godot scene. Saves automatically. Common spatial properties (position, position3d, rotation, scale, visible, modulate) can be set as top-level params; for any other property, pass it under properties. Vector2/Vector3/Color values auto-convert from {x,y}/{x,y,z}/{r,g,b,a}. parentNodePath defaults to the scene root. Returns a plain-text confirmation message naming the new node and type. Errors if nodeType is not a registered Godot class or parentNodePath does not exist.',
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
      'Set the texture on an existing Sprite2D, Sprite3D, or TextureRect node. Use this when the node already exists; for new nodes, pass texture via add_node properties. Saves automatically. texturePath must be a real file under projectPath. Returns a plain-text confirmation message naming the loaded texture. Errors if the node is not one of those three classes, or the texture file does not exist.',
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
      'Re-pack and save a scene, optionally to a different path (save-as). Most mutations (add_node, set_node_properties, delete_nodes, etc.) auto-save — only use this for save-as via newPath, or to re-canonicalize a hand-edited .tscn. Overwrites silently. Returns a plain-text confirmation naming the save path. Errors if the scene file does not exist.',
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
      'Export a scene of MeshInstance3D nodes as a MeshLibrary .res file for use in GridMap. Use this when authoring tile palettes for grid-based 3D levels; ignore for 2D or general scene work. The source scene must contain MeshInstance3D children. Pass meshItemNames to export a subset, or omit to export all. Saves the .res to outputPath, overwriting silently. Returns a plain-text confirmation with the exported item count. Errors if the scene contains no valid meshes.',
    annotations: { destructiveHint: true },
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
      'Use this instead of chaining add_node / load_sprite / save_scene calls when you have multiple mutations on the same or related scenes — runs in one Godot process (~3s startup avoided per call) and shares an in-memory scene cache, saving once at the end. Each item picks its sub-operation (add_node, load_sprite, save) and supplies its own params; abortOnError stops on first failure (default false continues). Returns: results[] in input order, each tagged with operation and scenePath plus success or error.',
    annotations: { destructiveHint: true },
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
    outputSchema: {
      type: 'object',
      properties: {
        results: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              operation: { type: 'string' },
              scenePath: { type: 'string' },
              success: { type: 'boolean' },
              error: { type: 'string' },
            },
          },
        },
      },
    },
  },
] as const satisfies readonly ToolDefinition[];

// --- Handlers ---

export async function handleCreateScene(
  runner: GodotRunner,
  args: OperationParams,
): Promise<HandlerResult> {
  args = normalizeParameters(args);
  const parsed = parseSceneArgs(args, { sceneRequired: false });
  if (!parsed.ok) return parsed;
  const rootNodeType = optionalString(args, 'rootNodeType');
  if (!rootNodeType.ok) return rootNodeType;

  const params = {
    scenePath: parsed.value.scenePath,
    rootNodeType: rootNodeType.value || 'Node2D',
  };
  return executeSceneOp(
    runner,
    'create_scene',
    params,
    parsed.value.projectPath,
    'Failed to create scene',
    ['Check if the root node type is valid'],
  );
}

export async function handleAddNode(
  runner: GodotRunner,
  args: OperationParams,
): Promise<HandlerResult> {
  args = normalizeParameters(args);
  const parsed = parseSceneArgs(args);
  if (!parsed.ok) return parsed;

  const nodeType = requireString(args, 'nodeType');
  if (!nodeType.ok) return nodeType;
  const nodeName = requireString(args, 'nodeName');
  if (!nodeName.ok) return nodeName;

  const properties = optionalObject(args, 'properties');
  if (!properties.ok) return properties;

  // Merge promoted top-level params into properties dict
  const promotedKeys = [
    'position',
    'position3d',
    'rotation',
    'scale',
    'visible',
    'modulate',
  ] as const;
  const mergedProps: OperationParams = properties.value ?? {};
  for (const key of promotedKeys) {
    if (args[key] !== undefined) {
      mergedProps[key] = args[key];
    }
  }

  const params: OperationParams = {
    scenePath: parsed.value.scenePath,
    nodeType: nodeType.value,
    nodeName: nodeName.value,
  };
  if (args.parentNodePath !== undefined) {
    const parentNodePath = parseRequiredNodePath(args, 'parentNodePath');
    if (!parentNodePath.ok) return parentNodePath;
    params.parentNodePath = parentNodePath.value;
  }
  if (Object.keys(mergedProps).length > 0) params.properties = mergedProps;
  return executeSceneOp(
    runner,
    'add_node',
    params,
    parsed.value.projectPath,
    'Failed to add node',
    ['Check if the node type is valid', 'Ensure the parent node path exists'],
  );
}

export async function handleLoadSprite(
  runner: GodotRunner,
  args: OperationParams,
): Promise<HandlerResult> {
  args = normalizeParameters(args);
  const parsed = parseSceneArgs(args);
  if (!parsed.ok) return parsed;

  const nodePath = parseRequiredNodePath(args, 'nodePath');
  if (!nodePath.ok) return nodePath;

  const texturePath = requireString(args, 'texturePath');
  if (!texturePath.ok) return texturePath;
  if (!validateSubPath(parsed.value.projectPath, texturePath.value)) {
    return err(
      createErrorResponse('Valid texturePath is required', [
        'Provide a relative texture path that stays inside the project directory',
      ]),
    );
  }
  const textureFullPath = join(parsed.value.projectPath, texturePath.value);
  if (!existsSync(textureFullPath)) {
    return err(
      createErrorResponse(`Texture file does not exist: ${texturePath.value}`, [
        'Ensure the texture path is correct',
      ]),
    );
  }

  const params = {
    scenePath: parsed.value.scenePath,
    nodePath: nodePath.value,
    texturePath: texturePath.value,
  };
  return executeSceneOp(
    runner,
    'load_sprite',
    params,
    parsed.value.projectPath,
    'Failed to load sprite',
    ['Check if the node is a Sprite2D, Sprite3D, or TextureRect'],
  );
}

export async function handleSaveScene(
  runner: GodotRunner,
  args: OperationParams,
): Promise<HandlerResult> {
  args = normalizeParameters(args);
  const parsed = parseSceneArgs(args);
  if (!parsed.ok) return parsed;

  const newPath = optionalString(args, 'newPath');
  if (!newPath.ok) return newPath;
  if (newPath.value && !validateSubPath(parsed.value.projectPath, newPath.value)) {
    return err(
      createErrorResponse('Invalid newPath', [
        'Provide a valid relative path without ".." that stays inside the project directory',
      ]),
    );
  }

  const params: OperationParams = { scenePath: parsed.value.scenePath };
  if (newPath.value) params.newPath = newPath.value;
  return executeSceneOp(
    runner,
    'save_scene',
    params,
    parsed.value.projectPath,
    'Failed to save scene',
    ['Check if the scene file is valid'],
  );
}

export async function handleExportMeshLibrary(
  runner: GodotRunner,
  args: OperationParams,
): Promise<HandlerResult> {
  args = normalizeParameters(args);
  const parsed = parseSceneArgs(args);
  if (!parsed.ok) return parsed;

  const outputPath = requireString(args, 'outputPath');
  if (!outputPath.ok) return outputPath;
  if (!validateSubPath(parsed.value.projectPath, outputPath.value)) {
    return err(
      createErrorResponse('Valid outputPath is required', [
        'Provide an output path for the .res file that stays inside the project directory',
      ]),
    );
  }

  const meshItemNames = optionalStringArray(args, 'meshItemNames');
  if (!meshItemNames.ok) return meshItemNames;

  const params: OperationParams = {
    scenePath: parsed.value.scenePath,
    outputPath: outputPath.value,
  };
  if (meshItemNames.value) {
    params.meshItemNames = meshItemNames.value;
  }
  return executeSceneOp(
    runner,
    'export_mesh_library',
    params,
    parsed.value.projectPath,
    'Failed to export mesh library',
    ['Check if the scene contains valid 3D meshes'],
  );
}

export async function handleBatchSceneOperations(
  runner: GodotRunner,
  args: OperationParams,
): Promise<HandlerResult> {
  args = normalizeParameters(args);
  const parsed = parseProjectArgs(args);
  if (!parsed.ok) return parsed;

  const operations = requireArray(args, 'operations');
  if (!operations.ok) return operations;

  const abortOnError = optionalBoolean(args, 'abortOnError');
  if (!abortOnError.ok) return abortOnError;

  const params = {
    operations: operations.value,
    abortOnError: abortOnError.value ?? false,
  };
  return executeSceneOp(
    runner,
    'batch_scene_operations',
    params,
    parsed.value.projectPath,
    'Batch scene operations failed',
    ['Check that all scene paths exist', 'Ensure node types are valid'],
  );
}
