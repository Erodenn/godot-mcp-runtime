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
  checkBatchOperationItems,
} from '../utils/arg-parsing.js';
import { err } from '../utils/result.js';
import { executeSceneOp } from '../utils/headless-op.js';

export const sceneToolDefinitions = [
  {
    name: 'create_scene',
    description:
      'Create a new scene file with a single root node, written to scenePath. Use to start a scene from scratch; to add nodes to an existing scene use add_node. rootNodeType defaults to Node2D: pass "Node3D" for 3D or "Control" for UI. Saves automatically and overwrites an existing file silently. Returns: success and the scenePath that was written. Errors while a runtime session is live on this project.',
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
      "Add a node to a scene, or instance another scene when nodeType is a scene path. Saves automatically. Values in properties are checked against each property's declared type; a mismatch errors (Property Values in docs/tools.md). Returns: nodeName, nodeType and nodePath, read back after the add; warnings leads when Godot renamed the node or a value will not be saved. Errors and adds nothing if the type, parent or a property is invalid. Errors while a runtime session is live on this project.",
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
        scenePath: { type: 'string', description: 'Scene file path relative to the project' },
        nodeType: {
          type: 'string',
          description:
            'Godot node class to instantiate (e.g. "Sprite2D", "CollisionShape2D", "Label"), or a project-relative scene path (.tscn or .scn, e.g. "scenes/enemy.tscn") to instance an existing scene as a child - instanced children serialize as `instance=ExtResource(...)` on save',
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
          description:
            'Position: {"x": 100, "y": 200} on a 2D node, {"x": 0, "y": 1, "z": 0} on a 3D node',
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
            'Additional property values as a JSON object. Top-level params (position, rotation, etc.) take precedence over keys in this dict. An Object-typed property takes a res:// path, a {type: ClassName, ...props} dict that builds a Resource inline, or null; slash-suffixed keys like shader_parameter/<uniform> go inside that dict, not on the node; metadata/<name> and slash keys the node declares go straight into properties. Coercion and Packed*Array / Array[T] element rules: Property Values in docs/tools.md.',
        },
      },
      required: ['projectPath', 'scenePath', 'nodeType', 'nodeName'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        warnings: { type: 'array', items: { type: 'string' } },
        nodeName: {
          type: 'string',
          description:
            'Name the node has after the add. Differs from the requested nodeName when Godot renamed it.',
        },
        nodeType: {
          type: 'string',
          description: 'Class of the added node, or of the root of an instanced scene.',
        },
        nodePath: {
          type: 'string',
          description: 'Path from the scene root in "root/..." form, usable as nodePath elsewhere.',
        },
      },
      required: ['nodeName', 'nodeType', 'nodePath'],
    },
  },
  {
    name: 'load_sprite',
    description:
      'Set the texture on an existing Sprite2D, Sprite3D or TextureRect. For a new node, pass texture in add_node properties instead. Saves automatically. texturePath must be a file under projectPath. Returns: nodePath, nodeType and texturePath, read back from the node after the assignment. Errors if the node is not one of those three classes or the texture file does not exist. Errors while a runtime session is live on this project.',
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
    outputSchema: {
      type: 'object',
      properties: {
        nodePath: { type: 'string' },
        nodeType: { type: 'string' },
        texturePath: {
          type: 'string',
          description: 'Project-relative path of the texture the node holds after the assignment.',
        },
      },
      required: ['nodePath', 'nodeType', 'texturePath'],
    },
  },
  {
    name: 'save_scene',
    description:
      'Re-pack and save a scene, optionally to another path (save-as). The mutation tools (add_node, set_node_properties, delete_nodes, etc.) save by themselves: use this only for save-as via newPath, or to re-canonicalize a hand-edited .tscn. Overwrites silently. Returns: scenePath (the scene that was loaded) and savedScenePath (the file written, confirmed on disk). Errors if the scene file does not exist. Errors while a runtime session is live on this project.',
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
    outputSchema: {
      type: 'object',
      properties: {
        scenePath: { type: 'string', description: 'The scene that was loaded.' },
        savedScenePath: {
          type: 'string',
          description: 'The file that was written. Equal to scenePath unless newPath was given.',
        },
      },
      required: ['scenePath', 'savedScenePath'],
    },
  },
  {
    name: 'export_mesh_library',
    description:
      "Export a scene's MeshInstance3D children as a MeshLibrary .res file for GridMap. For grid-based 3D tile palettes only, not 2D scenes. Pass meshItemNames for a subset, or omit it for all. Saves to outputPath, overwriting silently. Returns: outputPath, itemCount and itemNames, read from the saved library; warnings leads when a requested name was not exported. Errors if the scene holds no valid meshes. Errors while a runtime session is live on this project.",
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
    outputSchema: {
      type: 'object',
      properties: {
        warnings: { type: 'array', items: { type: 'string' } },
        outputPath: { type: 'string' },
        itemCount: { type: 'number' },
        itemNames: { type: 'array', items: { type: 'string' } },
      },
      required: ['outputPath', 'itemCount', 'itemNames'],
    },
  },
  {
    name: 'batch_scene_operations',
    description:
      "Run several scene mutations in one process; every mutated scene is saved at the end. Use instead of chaining add_node, load_sprite, set_node_properties or save_scene. Each item sets operation (save stands for save_scene) and takes that tool's params. abortOnError stops at the first failure; later items return skipped: true. Returns: results[] in input order: operation, scenePath, success, error or skipped, plus the operation's own fields. Errors while a runtime session is live on this project.",
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
                enum: ['add_node', 'load_sprite', 'set_node_properties', 'save'],
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
              updates: {
                type: 'array',
                description: '[set_node_properties] Property updates to apply in this operation',
                items: {
                  type: 'object',
                  properties: {
                    nodePath: { type: 'string', description: 'Node path from scene root' },
                    property: { type: 'string', description: 'Property name in snake_case' },
                    value: {
                      description:
                        'New value. Vector2/Vector3/Color auto-convert from {"x","y"} / {"x","y","z"} / {"r","g","b","a"} objects; primitives pass through. For Packed*Array properties, a plain array applies the same conversions element-wise (e.g. [{"x":10,"y":20}, ...] for Polygon2D.polygon); an element that cannot represent the packed element type errors instead of silently storing zeros.',
                    },
                  },
                  required: ['nodePath', 'property', 'value'],
                },
              },
              abortOnError: {
                type: 'boolean',
                description: '[set_node_properties] Stop processing on first error',
              },
              position: {
                type: 'object',
                description:
                  '[add_node] Position - {"x","y"} for 2D nodes, {"x","y","z"} for 3D. Shorthand for properties.position',
              },
              rotation: {
                type: 'number',
                description: '[add_node] Rotation in radians - shorthand for properties.rotation',
              },
              scale: {
                type: 'object',
                description: '[add_node] Vector2 scale - shorthand for properties.scale',
              },
              visible: {
                type: 'boolean',
                description: '[add_node] Visibility - shorthand for properties.visible',
              },
              modulate: {
                type: 'object',
                description: '[add_node] Color modulation - shorthand for properties.modulate',
              },
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
        warnings: { type: 'array', items: { type: 'string' } },
        results: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              operation: { type: 'string' },
              scenePath: { type: 'string' },
              success: { type: 'boolean' },
              error: { type: 'string' },
              skipped: {
                type: 'boolean',
                description: 'True when abortOnError stopped the batch before this operation ran.',
              },
              nodeName: { type: 'string', description: '[add_node] Name after the add.' },
              nodeType: { type: 'string', description: '[add_node, load_sprite]' },
              nodePath: { type: 'string', description: '[add_node, load_sprite]' },
              texturePath: { type: 'string', description: '[load_sprite]' },
              savedScenePath: { type: 'string', description: '[save] The file written.' },
              updates: {
                type: 'array',
                description: '[set_node_properties] One entry per update, in input order.',
                items: {
                  type: 'object',
                  properties: {
                    nodePath: { type: 'string' },
                    property: { type: 'string' },
                    success: { type: 'boolean' },
                    error: { type: 'string' },
                    skipped: {
                      type: 'boolean',
                      description:
                        'True when abortOnError stopped this operation before this update.',
                    },
                  },
                },
              },
            },
          },
        },
      },
      required: ['results'],
    },
  },
] as const satisfies readonly ToolDefinition[];

// --- Handlers ---

export async function handleCreateScene(
  runner: GodotRunner,
  args: OperationParams,
): Promise<HandlerResult> {
  args = normalizeParameters(args);
  const parsed = parseSceneArgs(args, { requireExists: false });
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
    undefined,
    { parseStdoutAsJson: true, mutatesSceneFile: true },
  );
}

/**
 * Spatial properties `add_node` accepts as top-level params instead of under
 * `properties`. Mirrored by `_PROMOTED_SPATIAL_PARAMS` in
 * `src/scripts/godot_operations.gd`, which applies them on the batch path --
 * KEEP IN SYNC.
 */
const PROMOTED_SPATIAL_PARAMS = ['position', 'rotation', 'scale', 'visible', 'modulate'] as const;

/**
 * Scene-file suffixes `add_node` accepts in place of a Godot class name.
 * Mirrored by `_SCENE_SUFFIXES` in `src/scripts/godot_operations.gd` --
 * KEEP IN SYNC.
 */
const SCENE_PATH_SUFFIXES = ['.tscn', '.scn'];

function isScenePath(nodeType: string): boolean {
  const lowered = nodeType.toLowerCase();
  return SCENE_PATH_SUFFIXES.some((suffix) => lowered.endsWith(suffix));
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
  // A scene-path nodeType is a filesystem path, so it gets the same
  // project-root containment check every other path input does -- Godot
  // resolves `res://../x.tscn` to a real file outside the project.
  if (isScenePath(nodeType.value) && !validateSubPath(parsed.value.projectPath, nodeType.value)) {
    return err(
      createErrorResponse(`Scene path escapes the project root: ${nodeType.value}`, [
        'Use a path relative to the project root (e.g. "scenes/enemy.tscn")',
        'Remove any ".." segments from the path',
      ]),
    );
  }
  const nodeName = requireString(args, 'nodeName');
  if (!nodeName.ok) return nodeName;

  const properties = optionalObject(args, 'properties');
  if (!properties.ok) return properties;

  // Merge promoted top-level params into properties dict
  const mergedProps: OperationParams = { ...(properties.value ?? {}) };
  for (const key of PROMOTED_SPATIAL_PARAMS) {
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
    [
      'Check if the node type is valid',
      'Ensure the parent node path exists',
      'If nodeType is a scene path, verify the file exists and loads (.tscn or .scn)',
    ],
    undefined,
    { parseStdoutAsJson: true, mutatesSceneFile: true },
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
    undefined,
    { parseStdoutAsJson: true, mutatesSceneFile: true },
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
    undefined,
    { parseStdoutAsJson: true, mutatesSceneFile: true },
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
    undefined,
    { parseStdoutAsJson: true, mutatesSceneFile: true },
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
  const checkedOperations = checkBatchOperationItems(operations.value);
  if (!checkedOperations.ok) return checkedOperations;

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
    undefined,
    { parseStdoutAsJson: true, mutatesSceneFile: true },
  );
}
