import { existsSync } from 'fs';
import type { GodotRunner } from '../utils/godot-runner.js';
import type { HandlerResult, OperationParams, ToolDefinition, ToolResponse } from '../mcp.types.js';
import { normalizeParameters } from '../utils/parameter-conversion.js';
import {
  isSceneFileNodeType,
  resolveProjectPath,
  projectSubPathError,
  PROJECT_SUB_PATH_SOLUTIONS,
} from '../utils/path-validation.js';
import { createErrorResponse } from '../utils/error-response.js';
import {
  parseProjectArgs,
  parseSceneArgs,
  parseOptionalNodePath,
  parseRequiredNodePath,
  requireString,
  optionalString,
  optionalStringArray,
  optionalBoolean,
  requireArray,
  optionalObject,
  requireObject,
  checkBatchOperationItems,
} from '../utils/arg-parsing.js';
import { err, ok, type Result } from '../utils/result.js';
import { executeSceneOp } from '../utils/headless-op.js';
import { batchSceneWrites, inPlaceSceneWrite, loadSpriteTouch } from '../utils/scene-loss-guard.js';

const resourceFileOutputSchema = {
  type: 'object',
  properties: {
    warnings: { type: 'array', items: { type: 'string' } },
    resourcePath: {
      type: 'string',
      description: 'Project-relative path of the .tres file written.',
    },
    resourceType: {
      type: 'string',
      description: 'Engine class of the saved resource (Resource for a script class).',
    },
    scriptPath: {
      type: ['string', 'null'],
      description: 'Project-relative path of its script, or null.',
    },
    properties: {
      type: 'object',
      description:
        'Each property the call set, read back from the saved file, in the shapes set_node_properties accepts.',
    },
  },
  required: ['resourcePath', 'resourceType', 'scriptPath', 'properties'],
} as const;

export const sceneToolDefinitions = [
  {
    name: 'create_scene',
    description:
      'Create a new scene file with a single root node, written to scenePath. Use to start a scene from scratch; to add nodes to an existing scene use add_node. rootNodeType defaults to Node2D: pass "Node3D" for 3D or "Control" for UI. Saves automatically and overwrites an existing file silently. Returns: the scenePath that was written. Errors while a runtime session is live on this project.',
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
        warnings: { type: 'array', items: { type: 'string' } },
        scenePath: {
          type: 'string',
          description: 'Project-relative path of the scene file that was written.',
        },
      },
      required: ['scenePath'],
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
            'Parent node path from scene root (e.g. "root/Player"). Defaults to the root node; an empty string also means the root.',
        },
        position: {
          type: 'object',
          description:
            'Position: {"x": 100, "y": 200} on a 2D node, {"x": 0, "y": 1, "z": 0} on a 3D node. Shorthand for properties.position; properties wins on a conflict.',
          properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
        },
        rotation: {
          type: 'number',
          description:
            'Rotation in radians, for a 2D node. On a 3D node rotation is a vector: pass it as properties.rotation, {"x", "y", "z"} in radians. Shorthand for properties.rotation; properties wins on a conflict.',
        },
        scale: {
          type: 'object',
          description:
            'Scale: {"x": 2, "y": 2} on a 2D node, {"x": 2, "y": 2, "z": 2} on a 3D node. Shorthand for properties.scale; properties wins on a conflict.',
          properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
        },
        visible: {
          type: 'boolean',
          description:
            'Whether the node is visible. Shorthand for properties.visible; properties wins on a conflict.',
        },
        modulate: {
          type: 'object',
          description:
            'Color modulation (e.g. {"r": 1, "g": 0, "b": 0, "a": 1}). Shorthand for properties.modulate; properties wins on a conflict.',
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
            'Additional property values as a JSON object. A key here wins over the same top-level shorthand (position, rotation, scale, visible, modulate). An Object-typed property takes a res:// path, a {type: ClassName, ...props} dict that builds a Resource inline, or null; slash-suffixed keys like shader_parameter/<uniform> go inside that dict, not on the node; metadata/<name> and slash keys the node declares go straight into properties. Coercion and Packed*Array / Array[T] / Dictionary[K, V] element rules: Property Values in docs/tools.md.',
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
        warnings: { type: 'array', items: { type: 'string' } },
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
      'Re-pack and save a scene, optionally to another path (save-as). The mutation tools save by themselves: use this only for save-as via newPath, or to re-canonicalize a hand-edited .tscn. Overwrites silently. A newPath file gets no uid of its own. Returns: scenePath (loaded) and savedScenePath (written, confirmed on disk); warnings leads if the save dropped content. Errors while a runtime session is live on this project.',
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
        warnings: { type: 'array', items: { type: 'string' } },
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
      "Export a scene's MeshInstance3D children as a MeshLibrary for GridMap. The outputPath extension sets the format: .tres is text (prefer it), .res is binary. Not for 2D scenes. meshItemNames picks a subset, else all. Overwrites silently. Returns: outputPath, itemCount, itemNames read from the saved library; warnings leads when a requested name was not exported. Errors if no valid meshes, or while a runtime session is live.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
        scenePath: { type: 'string', description: 'Scene file path relative to the project' },
        outputPath: {
          type: 'string',
          description:
            'Output path for the MeshLibrary (relative to project). Its extension sets the format: .tres writes text, .res writes binary. Prefer .tres.',
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
                description: 'Required. The sub-operation to perform',
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
                description:
                  '[add_node] Rotation in radians on a 2D node - shorthand for properties.rotation. A 3D node takes {"x","y","z"} under properties.rotation',
              },
              scale: {
                type: 'object',
                description:
                  '[add_node] Scale - {"x","y"} for 2D nodes, {"x","y","z"} for 3D. Shorthand for properties.scale',
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
                    resolvedNodePath: {
                      type: 'string',
                      description:
                        'Where nodePath led, in root/... form. Present when the node was found; differs from nodePath for a %Name path.',
                    },
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
  {
    name: 'create_resource',
    description:
      'Create a .tres resource file from an engine Resource class or a GDScript resource script (class_name or path), with property values set. Values are checked against declared types as in set_node_properties (Property Values in docs/tools.md). Refuses an existing file unless overwrite is true. Returns: resourcePath, resourceType, scriptPath and properties read back from the saved file. Errors on an unknown type or property, and while a runtime session is live on this project.',
    annotations: { destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
        resourcePath: {
          type: 'string',
          description:
            'Path of the .tres file inside the project, e.g. "items/sword.tres". Created with its folders.',
        },
        type: {
          type: 'string',
          description:
            'Engine Resource class such as "StyleBoxFlat", a registered class_name, or a GDScript path such as "items/item_stats.gd". A class_name is known only after the editor or an import has scanned the project.',
        },
        properties: {
          type: 'object',
          description:
            'Property values to set, keyed by property name as written, with the same value rules as set_node_properties. script and resource_path are refused.',
        },
        overwrite: {
          type: 'boolean',
          description: 'Replace an existing file at resourcePath (default: false).',
        },
      },
      required: ['projectPath', 'resourcePath', 'type'],
    },
    outputSchema: resourceFileOutputSchema,
  },
  {
    name: 'set_resource_properties',
    description:
      'Set property values in an existing .tres resource file and save it. Properties not named, sub-resources and uids stay as the file has them. A Dictionary or Array value replaces the stored one whole; send every key. Values are checked against declared types as in set_node_properties (Property Values in docs/tools.md); one invalid name or value errors and writes nothing. Returns: resourcePath, resourceType, scriptPath, the named properties read back. Errors while a runtime session is live.',
    annotations: { idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
        resourcePath: {
          type: 'string',
          description: 'Path of the .tres file inside the project, e.g. "items/sword.tres".',
        },
        properties: {
          type: 'object',
          description:
            'Property values to set, at least one, keyed by property name as written, with the same value rules as set_node_properties. script and resource_path are refused.',
        },
      },
      required: ['projectPath', 'resourcePath', 'properties'],
    },
    outputSchema: resourceFileOutputSchema,
  },
] as const satisfies readonly ToolDefinition[];

export async function handleCreateScene(
  runner: GodotRunner,
  args: OperationParams,
): Promise<HandlerResult> {
  args = normalizeParameters(args);
  const parsed = parseSceneArgs(args, 'write', { requireExists: false });
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
    {
      parseStdoutAsJson: true,
      mutatesSceneFile: true,
      // The new file replaces whatever the path held, so it is not compared; naming it lets the call say once the engine writing it is newer than the project.
      sceneWrites: inPlaceSceneWrite(parsed.value.scenePath, { replacesFile: true }),
    },
  );
}

// KEEP IN SYNC: `_PROMOTED_SPATIAL_PARAMS` in src/scripts/godot_operations.gd applies these on the batch path.
const PROMOTED_SPATIAL_PARAMS = ['position', 'rotation', 'scale', 'visible', 'modulate'] as const;

export async function handleAddNode(
  runner: GodotRunner,
  args: OperationParams,
): Promise<HandlerResult> {
  args = normalizeParameters(args);
  const parsed = parseSceneArgs(args, 'write');
  if (!parsed.ok) return parsed;

  const nodeType = requireString(args, 'nodeType');
  if (!nodeType.ok) return nodeType;
  // A scene-path nodeType is a filesystem path and Godot resolves `res://../x.tscn` outside the project, so it gets the same containment check.
  const nodeTypeScene = isSceneFileNodeType(nodeType.value)
    ? resolveProjectPath(parsed.value.projectPath, nodeType.value, 'read')
    : undefined;
  if (nodeTypeScene === null) {
    return err(
      createErrorResponse(projectSubPathError('nodeType scene path', nodeType.value), [
        ...PROJECT_SUB_PATH_SOLUTIONS,
      ]),
    );
  }
  const nodeName = requireString(args, 'nodeName');
  if (!nodeName.ok) return nodeName;

  const properties = optionalObject(args, 'properties');
  if (!properties.ok) return properties;

  // `properties` wins over promoted top-level params, as on the batch path and in docs/tools.md.
  const mergedProps: OperationParams = {};
  for (const key of PROMOTED_SPATIAL_PARAMS) {
    if (args[key] !== undefined) {
      mergedProps[key] = args[key];
    }
  }
  Object.assign(mergedProps, properties.value ?? {});

  const params: OperationParams = {
    scenePath: parsed.value.scenePath,
    nodeType: nodeTypeScene ? nodeTypeScene.relPath : nodeType.value,
    nodeName: nodeName.value,
  };
  const parentNodePath = parseOptionalNodePath(args, 'parentNodePath');
  if (!parentNodePath.ok) return parentNodePath;
  if (parentNodePath.value !== undefined) params.parentNodePath = parentNodePath.value;
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
    {
      parseStdoutAsJson: true,
      mutatesSceneFile: true,
      sceneWrites: inPlaceSceneWrite(parsed.value.scenePath),
    },
  );
}

export async function handleLoadSprite(
  runner: GodotRunner,
  args: OperationParams,
): Promise<HandlerResult> {
  args = normalizeParameters(args);
  const parsed = parseSceneArgs(args, 'write');
  if (!parsed.ok) return parsed;

  const nodePath = parseRequiredNodePath(args, 'nodePath');
  if (!nodePath.ok) return nodePath;

  const texturePath = requireString(args, 'texturePath');
  if (!texturePath.ok) return texturePath;
  const texture = resolveProjectPath(parsed.value.projectPath, texturePath.value, 'read');
  if (!texture) {
    return err(
      createErrorResponse(projectSubPathError('texturePath', texturePath.value), [
        ...PROJECT_SUB_PATH_SOLUTIONS,
      ]),
    );
  }
  if (!existsSync(texture.absPath)) {
    return err(
      createErrorResponse(`Texture file does not exist: ${texturePath.value}`, [
        'Ensure the texture path is correct',
      ]),
    );
  }

  const params = {
    scenePath: parsed.value.scenePath,
    nodePath: nodePath.value,
    texturePath: texture.relPath,
  };
  return executeSceneOp(
    runner,
    'load_sprite',
    params,
    parsed.value.projectPath,
    'Failed to load sprite',
    ['Check if the node is a Sprite2D, Sprite3D, or TextureRect'],
    undefined,
    {
      parseStdoutAsJson: true,
      mutatesSceneFile: true,
      sceneWrites: inPlaceSceneWrite(parsed.value.scenePath, {
        touchedProperties: [loadSpriteTouch(nodePath.value)],
      }),
    },
  );
}

export async function handleSaveScene(
  runner: GodotRunner,
  args: OperationParams,
): Promise<HandlerResult> {
  args = normalizeParameters(args);
  const parsed = parseSceneArgs(args, 'write');
  if (!parsed.ok) return parsed;

  const newPath = optionalString(args, 'newPath');
  if (!newPath.ok) return newPath;
  const newScene = newPath.value
    ? resolveProjectPath(parsed.value.projectPath, newPath.value, 'write')
    : undefined;
  if (newScene === null) {
    return err(
      createErrorResponse(projectSubPathError('newPath', newPath.value ?? ''), [
        ...PROJECT_SUB_PATH_SOLUTIONS,
      ]),
    );
  }

  const params: OperationParams = { scenePath: parsed.value.scenePath };
  if (newScene) params.newPath = newScene.relPath;
  return executeSceneOp(
    runner,
    'save_scene',
    params,
    parsed.value.projectPath,
    'Failed to save scene',
    ['Check if the scene file is valid'],
    undefined,
    {
      parseStdoutAsJson: true,
      mutatesSceneFile: true,
      sceneWrites: [
        {
          source: parsed.value.scenePath,
          target: newScene ? newScene.relPath : parsed.value.scenePath,
          touchedNodes: [],
          deletedNodes: [],
        },
      ],
    },
  );
}

export async function handleExportMeshLibrary(
  runner: GodotRunner,
  args: OperationParams,
): Promise<HandlerResult> {
  args = normalizeParameters(args);
  // The scene is only read; the library is the file this call writes.
  const parsed = parseSceneArgs(args, 'read');
  if (!parsed.ok) return parsed;

  const outputPath = requireString(args, 'outputPath');
  if (!outputPath.ok) return outputPath;
  const output = resolveProjectPath(parsed.value.projectPath, outputPath.value, 'write');
  if (!output) {
    return err(
      createErrorResponse(projectSubPathError('outputPath', outputPath.value), [
        ...PROJECT_SUB_PATH_SOLUTIONS,
      ]),
    );
  }

  const meshItemNames = optionalStringArray(args, 'meshItemNames');
  if (!meshItemNames.ok) return meshItemNames;

  const params: OperationParams = {
    scenePath: parsed.value.scenePath,
    outputPath: output.relPath,
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
    // Writes a .tres or .res and no scene file, so there are no sceneWrites to compare.
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
  // Every item path is resolved here by the single-call rules; the resolved operations go to both the script and the loss guard.
  const checkedOperations = checkBatchOperationItems(operations.value, parsed.value.projectPath);
  if (!checkedOperations.ok) return checkedOperations;
  const resolvedOperations = checkedOperations.value;

  const abortOnError = optionalBoolean(args, 'abortOnError');
  if (!abortOnError.ok) return abortOnError;

  const params = {
    operations: resolvedOperations,
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
    {
      parseStdoutAsJson: true,
      mutatesSceneFile: true,
      sceneWrites: batchSceneWrites(resolvedOperations, parsed.value.projectPath),
      refineSceneWrites: (payload) =>
        batchSceneWrites(resolvedOperations, parsed.value.projectPath, payload.results),
    },
  );
}

const TEXT_RESOURCE_SUFFIX = '.tres';

/** Resolves `resourcePath` for a write; only a text resource can be checked and edited key by key, so a `.res` or any other suffix is refused. */
function parseResourcePathArg(
  args: OperationParams,
): Result<{ projectPath: string; raw: string; relPath: string; absPath: string }, ToolResponse> {
  const parsed = parseProjectArgs(args);
  if (!parsed.ok) return parsed;
  const raw = requireString(args, 'resourcePath');
  if (!raw.ok) return raw;
  const resolved = resolveProjectPath(parsed.value.projectPath, raw.value, 'write');
  if (!resolved) {
    return err(
      createErrorResponse(projectSubPathError('resource path', raw.value), [
        ...PROJECT_SUB_PATH_SOLUTIONS,
      ]),
    );
  }
  if (!resolved.relPath.toLowerCase().endsWith(TEXT_RESOURCE_SUFFIX)) {
    return err(
      createErrorResponse('resourcePath must name a .tres file', [
        'Pass a path ending in .tres. A binary .res file cannot be checked as text',
      ]),
    );
  }
  return ok({
    projectPath: parsed.value.projectPath,
    raw: raw.value,
    relPath: resolved.relPath,
    absPath: resolved.absPath,
  });
}

export async function handleCreateResource(
  runner: GodotRunner,
  args: OperationParams,
): Promise<HandlerResult> {
  args = normalizeParameters(args);
  const resource = parseResourcePathArg(args);
  if (!resource.ok) return resource;
  const type = requireString(args, 'type');
  if (!type.ok) return type;
  const properties = optionalObject(args, 'properties');
  if (!properties.ok) return properties;
  const overwrite = optionalBoolean(args, 'overwrite');
  if (!overwrite.ok) return overwrite;

  if (existsSync(resource.value.absPath) && overwrite.value !== true) {
    return err(
      createErrorResponse(`Resource file already exists: ${resource.value.raw}`, [
        'Pass overwrite: true to replace it',
        'Use set_resource_properties to change values in the existing file',
      ]),
    );
  }

  const params: OperationParams = {
    resourcePath: resource.value.relPath,
    type: type.value,
    properties: properties.value ?? {},
    overwrite: overwrite.value ?? false,
  };
  return executeSceneOp(
    runner,
    'create_resource',
    params,
    resource.value.projectPath,
    'Failed to create resource',
    ['Check the type and the property names'],
    undefined,
    // The loss guard reads .tscn text only; the GDScript side keeps a .tres whole instead.
    { parseStdoutAsJson: true, mutatesSceneFile: true },
  );
}

export async function handleSetResourceProperties(
  runner: GodotRunner,
  args: OperationParams,
): Promise<HandlerResult> {
  args = normalizeParameters(args);
  const resource = parseResourcePathArg(args);
  if (!resource.ok) return resource;
  const properties = requireObject(args, 'properties');
  if (!properties.ok) return properties;
  if (Object.keys(properties.value).length === 0) {
    return err(
      createErrorResponse('properties must name at least one property', [
        'Pass the properties to change, e.g. {"power": 20}',
      ]),
    );
  }

  if (!existsSync(resource.value.absPath)) {
    return err(
      createErrorResponse(`Resource file does not exist: ${resource.value.raw}`, [
        'Use create_resource to create it',
      ]),
    );
  }

  const params: OperationParams = {
    resourcePath: resource.value.relPath,
    properties: properties.value,
  };
  return executeSceneOp(
    runner,
    'set_resource_properties',
    params,
    resource.value.projectPath,
    'Failed to set resource properties',
    ['Check the property names and values'],
    undefined,
    { parseStdoutAsJson: true, mutatesSceneFile: true },
  );
}
