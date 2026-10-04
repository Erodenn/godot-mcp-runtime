import { existsSync } from 'fs';
import type { GodotRunner } from '../utils/godot-runner.js';
import type { HandlerResult, OperationParams, ToolDefinition, ToolResponse } from '../mcp.types.js';
import { normalizeParameters } from '../utils/parameter-conversion.js';
import { resolveProjectPath } from '../utils/path-validation.js';
import { createErrorResponse } from '../utils/error-response.js';
import {
  parseSceneArgs,
  parseRequiredNodePath,
  parseOptionalNodePath,
  parseNodePath,
  requireString,
  optionalString,
  requireStringArray,
  requireArray,
  optionalNumber,
  optionalBoolean,
  checkNodeReadItems,
  checkUpdateItems,
} from '../utils/arg-parsing.js';
import type { NodePath, ProjectPath, ScenePath } from '../utils/branded.js';
import type { Result } from '../utils/result.js';
import { ok, err } from '../utils/result.js';
import { executeSceneOp } from '../utils/headless-op.js';

// --- Tool definitions ---

/** Result of connect_signal and disconnect_signal. `connected` is read back from the saved scene. */
const SIGNAL_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    warnings: { type: 'array', items: { type: 'string' } },
    nodePath: { type: 'string' },
    signal: { type: 'string' },
    targetNodePath: { type: 'string' },
    method: { type: 'string' },
    connected: {
      type: ['boolean', 'null'],
      description:
        'Whether the saved scene holds the connection. Null when the scene could not be read back.',
    },
  },
  required: ['nodePath', 'signal', 'targetNodePath', 'method', 'connected'],
} as const;

export const nodeToolDefinitions = [
  {
    name: 'delete_nodes',
    description:
      'Remove one or more nodes, with their descendants, from a scene. Always-array: pass a single-element nodePaths array for a one-off delete. Saves once at the end. The scene root, and any node inside an instanced scene, cannot be deleted: that entry reports an error and the rest still process. Returns: results[], one entry per nodePath in input order, each with success or error. Errors while a runtime session is live on this project.',
    annotations: { destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
        scenePath: {
          type: 'string',
          description: 'Scene file path relative to the project (e.g. "scenes/main.tscn")',
        },
        nodePaths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Node paths from scene root to delete (e.g. ["root/Player/Sprite2D"])',
        },
      },
      required: ['projectPath', 'scenePath', 'nodePaths'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        results: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              nodePath: { type: 'string' },
              success: { type: 'boolean' },
              error: { type: 'string' },
            },
          },
        },
      },
      required: ['results'],
    },
  },
  {
    name: 'set_node_properties',
    description:
      "Set node properties in a scene in one Godot process. Always-array: pass one update for a one-off edit. Each value is checked against the property's declared type and errors instead of storing a zero value (rules: Property Values in docs/tools.md). Saves once at the end. Returns: results[], one entry per update in input order, each with success, error or skipped (abortOnError); warnings leads when a value was set but is not saved. Errors while a runtime session is live on this project.",
    annotations: { idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
        scenePath: { type: 'string', description: 'Scene file path relative to the project' },
        updates: {
          type: 'array',
          description: 'Property updates to apply',
          items: {
            type: 'object',
            properties: {
              nodePath: {
                type: 'string',
                description: 'Node path from scene root (e.g. "root/Player")',
              },
              property: {
                type: 'string',
                description:
                  'GDScript property name in snake_case (e.g. "position", "modulate", "collision_layer"), or "metadata/<name>", or a slash key the node declares (e.g. "theme_override_colors/font_color")',
              },
              value: {
                description:
                  'New property value. Vector2/Vector3/Color auto-convert from {"x","y"} / {"x","y","z"} / {"r","g","b","a"} objects; primitives pass through. Packed*Array and script-declared Array[T] properties take a plain array and the element conversions apply per element (e.g. [{"x":10,"y":20}, ...] for Polygon2D.polygon); an element that cannot represent the element type errors with its index instead of silently storing zeros. Object-typed properties (e.g. CollisionShape2D.shape) take a res:// path, a {type: ClassName, ...props} dict that builds a Resource inline, or null to clear; slash-suffixed keys like shader_parameter/<uniform> go inside that dict, not on the node.',
              },
            },
            required: ['nodePath', 'property', 'value'],
          },
        },
        abortOnError: {
          type: 'boolean',
          description: 'Stop processing on first error (default: false)',
        },
      },
      required: ['projectPath', 'scenePath', 'updates'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        warnings: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Present when an update succeeded on the loaded scene but the scene file does not store it (a script variable declared without @export). Each entry names the update index.',
        },
        results: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              nodePath: { type: 'string' },
              property: { type: 'string' },
              success: { type: 'boolean' },
              error: { type: 'string' },
              skipped: {
                type: 'boolean',
                description: 'True when abortOnError stopped processing before this update.',
              },
            },
          },
        },
      },
      required: ['results'],
    },
  },
  {
    name: 'get_node_properties',
    description:
      'Read the current property values of one or more nodes from a scene file, in one Godot process. Always-array: pass a single-element nodes array for a one-off read. Per-node changedOnly: true leaves out properties that match the class defaults, for a compact diff. Returns: results[], one entry per node in input order: { nodePath, nodeType, properties }, or { nodePath, error } when the node was not found. Errors if the scene cannot be loaded.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
        scenePath: { type: 'string', description: 'Scene file path relative to the project' },
        nodes: {
          type: 'array',
          description: 'Nodes to read properties from',
          items: {
            type: 'object',
            properties: {
              nodePath: {
                type: 'string',
                description: 'Node path from scene root (e.g. "root/Player")',
              },
              changedOnly: {
                type: 'boolean',
                description: 'Only return properties differing from defaults (default: false)',
              },
            },
            required: ['nodePath'],
          },
        },
      },
      required: ['projectPath', 'scenePath', 'nodes'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        results: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              nodePath: { type: 'string' },
              nodeType: { type: 'string' },
              properties: { type: 'object' },
              error: { type: 'string' },
            },
            required: ['nodePath'],
          },
        },
      },
      required: ['results'],
    },
  },
  {
    name: 'attach_script',
    description:
      'Attach a GDScript or C# script to a node in a scene, replacing any script it had. Check the script with the validate tool first. C# needs the Godot .NET build with the class compiled into the project assembly. Saves automatically. Returns: success, nodePath and scriptPath. Errors if the script cannot be instantiated (parse errors, @abstract, or an unbuilt C# class), or if scriptPath or nodePath does not exist. Errors while a runtime session is live on this project.',
    annotations: { idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
        scenePath: { type: 'string', description: 'Scene file path relative to the project' },
        nodePath: { type: 'string', description: 'Node path from scene root (e.g. "root/Player")' },
        scriptPath: {
          type: 'string',
          description:
            'Path to the script file relative to the project (e.g. "scripts/player.gd" or "scripts/Player.cs"). A .cs file needs the Godot .NET build and its class compiled into the project assembly (dotnet build).',
        },
      },
      required: ['projectPath', 'scenePath', 'nodePath', 'scriptPath'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        nodePath: {
          type: 'string',
          description: 'Path from the scene root in "root/..." form, read from the node.',
        },
        scriptPath: {
          type: 'string',
          description: 'Project-relative path of the script that was attached.',
        },
      },
      required: ['success', 'nodePath', 'scriptPath'],
    },
  },
  {
    name: 'get_scene_tree',
    description:
      "Get a scene's node hierarchy as a nested tree. maxDepth: 1 lists only direct children; the default -1 is the whole tree. parentPath scopes to one subtree. Returns: the root node { name, type, path, script, children[] }, every child the same shape; path is a root/... node path the node tools accept, script a res:// path or an empty string. A node cut by maxDepth has children null and a childCount, and warnings leads. Errors if the scene or parentPath is not found.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
        scenePath: { type: 'string', description: 'Scene file path relative to the project' },
        parentPath: {
          type: 'string',
          description: 'Scope to a subtree starting at this node path (e.g. "root/Player")',
        },
        maxDepth: {
          type: 'number',
          description:
            'Maximum recursion depth. -1 for unlimited (default: -1). 1 returns only direct children.',
        },
      },
      required: ['projectPath', 'scenePath'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        warnings: {
          type: 'array',
          items: { type: 'string' },
          description: 'Root node only. Present when maxDepth cut the tree.',
        },
        name: { type: 'string' },
        type: { type: 'string' },
        path: {
          type: 'string',
          description:
            'Node path from the scene root in the "root/..." form the node tools accept.',
        },
        script: { type: 'string', description: 'res:// path of the attached script, or "".' },
        children: {
          type: ['array', 'null'],
          description:
            'Child nodes, each in this same shape. Null when maxDepth stopped the listing at a node that has children; childCount says how many.',
          items: { type: 'object' },
        },
        childCount: {
          type: 'number',
          description: 'Only when children is null: how many children were not listed.',
        },
      },
      required: ['name', 'type', 'path', 'script', 'children'],
    },
  },
  {
    name: 'duplicate_node',
    description:
      'Duplicate a node and its descendants in a scene, instead of rebuilding it node by node with add_node. newName defaults to the original name plus "2"; targetParentPath defaults to the parent of the original. Saves automatically. Returns: success, nodePath (the node that was copied) and newNodePath (where the duplicate is, read back after the add). Errors if nodePath does not exist or is the scene root, or if targetParentPath is not found. Errors while a runtime session is live on this project.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
        scenePath: { type: 'string', description: 'Scene file path relative to the project' },
        nodePath: { type: 'string', description: 'Node path from scene root to duplicate' },
        newName: {
          type: 'string',
          description: 'Name for the duplicated node (default: original name + "2")',
        },
        targetParentPath: {
          type: 'string',
          description: 'Parent node path for the duplicate (default: same parent as original)',
        },
      },
      required: ['projectPath', 'scenePath', 'nodePath'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        nodePath: { type: 'string' },
        newNodePath: { type: 'string' },
      },
      required: ['success', 'nodePath', 'newNodePath'],
    },
  },
  {
    name: 'get_node_signals',
    description:
      'List all signals defined on a node and their current connections. Use before connect_signal/disconnect_signal to verify signal/method names. The connections[].target field is already scene-root-relative in the "root/..." form connect_signal/disconnect_signal accept as targetNodePath (a self-connection reports as "root") - pass it straight through with no conversion. Returns: nodeType and signals[], each with name and current connections (signal/target/method). Errors if node not found.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
        scenePath: { type: 'string', description: 'Scene file path relative to the project' },
        nodePath: { type: 'string', description: 'Node path from scene root (e.g. "root/Button")' },
      },
      required: ['projectPath', 'scenePath', 'nodePath'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        nodePath: { type: 'string' },
        nodeType: { type: 'string' },
        signals: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              connections: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    signal: { type: 'string' },
                    target: {
                      type: 'string',
                      description:
                        'Scene-root-relative path in "root/..." form (a self-connection is "root"), directly usable as targetNodePath in connect_signal/disconnect_signal. "unknown" for a freed or null object.',
                    },
                    method: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
      required: ['nodePath', 'nodeType', 'signals'],
    },
  },
  {
    name: 'connect_signal',
    description:
      'Connect a signal on a source node to a method on a target node and persist it in the .tscn. Use get_node_signals first to confirm the names. Saves automatically. Returns: nodePath, signal, targetNodePath, method and connected, which is read back from the saved scene (null with a leading warning if that read failed). Errors if the signal or method does not exist or the connection already exists. Errors while a runtime session is live on this project.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
        scenePath: { type: 'string', description: 'Scene file path relative to the project' },
        nodePath: { type: 'string', description: 'Source node path from scene root' },
        signal: {
          type: 'string',
          description: 'Signal name on the source node (e.g. "pressed", "body_entered")',
        },
        targetNodePath: {
          type: 'string',
          description: 'Target node path from scene root that receives the signal',
        },
        method: {
          type: 'string',
          description: 'Method name on the target node to call when the signal fires',
        },
      },
      required: ['projectPath', 'scenePath', 'nodePath', 'signal', 'targetNodePath', 'method'],
    },
    outputSchema: SIGNAL_RESULT_SCHEMA,
  },
  {
    name: 'disconnect_signal',
    description:
      'Remove a signal connection between two nodes and persist the change in the .tscn. Use get_node_signals first to confirm the connection exists; connect_signal puts it back. Saves automatically. Returns: nodePath, signal, targetNodePath, method and connected, read back from the saved scene: false once the connection is gone, null with a leading warning if that read failed. Errors if the connection does not exist. Errors while a runtime session is live on this project.',
    annotations: { destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
        scenePath: { type: 'string', description: 'Scene file path relative to the project' },
        nodePath: { type: 'string', description: 'Source node path from scene root' },
        signal: { type: 'string', description: 'Signal name on the source node' },
        targetNodePath: { type: 'string', description: 'Target node path from scene root' },
        method: { type: 'string', description: 'Method name on the target node' },
      },
      required: ['projectPath', 'scenePath', 'nodePath', 'signal', 'targetNodePath', 'method'],
    },
    outputSchema: SIGNAL_RESULT_SCHEMA,
  },
] as const satisfies readonly ToolDefinition[];

// --- Handlers ---

export async function handleDeleteNodes(
  runner: GodotRunner,
  args: OperationParams,
): Promise<HandlerResult> {
  args = normalizeParameters(args);
  const parsed = parseSceneArgs(args);
  if (!parsed.ok) return parsed;

  const rawPaths = requireStringArray(args, 'nodePaths');
  if (!rawPaths.ok) return rawPaths;
  const nodePaths: NodePath[] = [];
  for (let i = 0; i < rawPaths.value.length; i++) {
    const p = parseNodePath(rawPaths.value[i]!, `nodePaths[${i}]`);
    if (!p.ok) return p;
    nodePaths.push(p.value);
  }

  const params = { scenePath: parsed.value.scenePath, nodePaths };
  return executeSceneOp(
    runner,
    'delete_nodes',
    params,
    parsed.value.projectPath,
    'Failed to delete nodes',
    ['Check if the node paths are correct'],
    undefined,
    { parseStdoutAsJson: true, mutatesSceneFile: true },
  );
}

export async function handleSetNodeProperties(
  runner: GodotRunner,
  args: OperationParams,
): Promise<HandlerResult> {
  args = normalizeParameters(args);
  const parsed = parseSceneArgs(args);
  if (!parsed.ok) return parsed;

  const updates = requireArray(args, 'updates');
  if (!updates.ok) return updates;
  const checkedUpdates = checkUpdateItems(updates.value);
  if (!checkedUpdates.ok) return checkedUpdates;

  const abortOnError = optionalBoolean(args, 'abortOnError');
  if (!abortOnError.ok) return abortOnError;

  const params = {
    scenePath: parsed.value.scenePath,
    updates: updates.value,
    abortOnError: abortOnError.value ?? false,
  };
  return executeSceneOp(
    runner,
    'set_node_properties',
    params,
    parsed.value.projectPath,
    'Failed to set node properties',
    ['Check node paths and property names'],
    undefined,
    { parseStdoutAsJson: true, mutatesSceneFile: true },
  );
}

export async function handleGetNodeProperties(
  runner: GodotRunner,
  args: OperationParams,
): Promise<HandlerResult> {
  args = normalizeParameters(args);
  const parsed = parseSceneArgs(args);
  if (!parsed.ok) return parsed;

  const nodes = requireArray(args, 'nodes');
  if (!nodes.ok) return nodes;
  const checkedNodes = checkNodeReadItems(nodes.value);
  if (!checkedNodes.ok) return checkedNodes;

  const params = { scenePath: parsed.value.scenePath, nodes: nodes.value };
  return executeSceneOp(
    runner,
    'get_node_properties',
    params,
    parsed.value.projectPath,
    'Failed to get node properties',
    ['Check node paths'],
    undefined,
    { parseStdoutAsJson: true },
  );
}

export async function handleAttachScript(
  runner: GodotRunner,
  args: OperationParams,
): Promise<HandlerResult> {
  args = normalizeParameters(args);
  const parsed = parseSceneArgs(args);
  if (!parsed.ok) return parsed;

  const nodePath = parseRequiredNodePath(args, 'nodePath');
  if (!nodePath.ok) return nodePath;

  const scriptPath = requireString(args, 'scriptPath');
  if (!scriptPath.ok) return scriptPath;
  const script = resolveProjectPath(parsed.value.projectPath, scriptPath.value);
  if (!script) {
    return err(
      createErrorResponse('Valid scriptPath is required', [
        'Provide a relative script path that stays inside the project directory',
      ]),
    );
  }
  if (!existsSync(script.absPath)) {
    return err(
      createErrorResponse(`Script file does not exist: ${scriptPath.value}`, [
        'Create the script file first',
      ]),
    );
  }

  const params = {
    scenePath: parsed.value.scenePath,
    nodePath: nodePath.value,
    scriptPath: script.relPath,
  };
  return executeSceneOp(
    runner,
    'attach_script',
    params,
    parsed.value.projectPath,
    'Failed to attach script',
    [
      'Ensure the script is valid for this node type',
      'If the script has parse errors, run validate with scriptPath to see them; a script declared @abstract cannot be attached directly',
      'For a C# script, build the project (dotnet build, or Build in the Godot editor) so the class is in the compiled assembly, and make sure GODOT_PATH points at the Godot .NET build',
    ],
    undefined,
    { parseStdoutAsJson: true, mutatesSceneFile: true },
  );
}

export async function handleGetSceneTree(
  runner: GodotRunner,
  args: OperationParams,
): Promise<HandlerResult> {
  args = normalizeParameters(args);
  const parsed = parseSceneArgs(args);
  if (!parsed.ok) return parsed;

  const parentPath = parseOptionalNodePath(args, 'parentPath');
  if (!parentPath.ok) return parentPath;

  const maxDepth = optionalNumber(args, 'maxDepth');
  if (!maxDepth.ok) return maxDepth;

  const params: OperationParams = { scenePath: parsed.value.scenePath };
  if (parentPath.value) params.parentPath = parentPath.value;
  if (maxDepth.value !== undefined) params.maxDepth = maxDepth.value;
  return executeSceneOp(
    runner,
    'get_scene_tree',
    params,
    parsed.value.projectPath,
    'Failed to get scene tree',
    ['Ensure the scene is valid'],
    undefined,
    { parseStdoutAsJson: true },
  );
}

export async function handleDuplicateNode(
  runner: GodotRunner,
  args: OperationParams,
): Promise<HandlerResult> {
  args = normalizeParameters(args);
  const parsed = parseSceneArgs(args);
  if (!parsed.ok) return parsed;

  const nodePath = parseRequiredNodePath(args, 'nodePath');
  if (!nodePath.ok) return nodePath;

  const targetParentPath = parseOptionalNodePath(args, 'targetParentPath');
  if (!targetParentPath.ok) return targetParentPath;

  const newName = optionalString(args, 'newName');
  if (!newName.ok) return newName;

  const params: OperationParams = {
    scenePath: parsed.value.scenePath,
    nodePath: nodePath.value,
  };
  if (newName.value) params.newName = newName.value;
  if (targetParentPath.value) params.targetParentPath = targetParentPath.value;
  return executeSceneOp(
    runner,
    'duplicate_node',
    params,
    parsed.value.projectPath,
    'Failed to duplicate node',
    ['Check if the node path and target parent path are correct'],
    undefined,
    { parseStdoutAsJson: true, mutatesSceneFile: true },
  );
}

export async function handleGetNodeSignals(
  runner: GodotRunner,
  args: OperationParams,
): Promise<HandlerResult> {
  args = normalizeParameters(args);
  const parsed = parseSceneArgs(args);
  if (!parsed.ok) return parsed;

  const nodePath = parseRequiredNodePath(args, 'nodePath');
  if (!nodePath.ok) return nodePath;

  const params = { scenePath: parsed.value.scenePath, nodePath: nodePath.value };
  return executeSceneOp(
    runner,
    'get_node_signals',
    params,
    parsed.value.projectPath,
    'Failed to get node signals',
    ['Check if the node path is correct'],
    undefined,
    { parseStdoutAsJson: true },
  );
}

interface ParsedSignalArgs {
  projectPath: ProjectPath;
  scenePath: ScenePath;
  nodePath: NodePath;
  signal: string;
  targetNodePath: NodePath;
  method: string;
}

function parseSignalArgs(args: OperationParams): Result<ParsedSignalArgs, ToolResponse> {
  const parsed = parseSceneArgs(args);
  if (!parsed.ok) return parsed;

  const nodePath = parseRequiredNodePath(args, 'nodePath');
  if (!nodePath.ok) return nodePath;

  const signal = requireString(args, 'signal');
  if (!signal.ok) return signal;

  const targetNodePath = parseRequiredNodePath(args, 'targetNodePath');
  if (!targetNodePath.ok) return targetNodePath;

  const method = requireString(args, 'method');
  if (!method.ok) return method;

  return ok({
    projectPath: parsed.value.projectPath,
    scenePath: parsed.value.scenePath,
    nodePath: nodePath.value,
    signal: signal.value,
    targetNodePath: targetNodePath.value,
    method: method.value,
  });
}

export async function handleConnectSignal(
  runner: GodotRunner,
  args: OperationParams,
): Promise<HandlerResult> {
  args = normalizeParameters(args);
  const parsed = parseSignalArgs(args);
  if (!parsed.ok) return parsed;

  const params = {
    scenePath: parsed.value.scenePath,
    nodePath: parsed.value.nodePath,
    signal: parsed.value.signal,
    targetNodePath: parsed.value.targetNodePath,
    method: parsed.value.method,
  };
  return executeSceneOp(
    runner,
    'connect_signal',
    params,
    parsed.value.projectPath,
    'Failed to connect signal',
    ['Ensure the signal exists on the source node and the method exists on the target node'],
    undefined,
    { parseStdoutAsJson: true, mutatesSceneFile: true },
  );
}

export async function handleDisconnectSignal(
  runner: GodotRunner,
  args: OperationParams,
): Promise<HandlerResult> {
  args = normalizeParameters(args);
  const parsed = parseSignalArgs(args);
  if (!parsed.ok) return parsed;

  const params = {
    scenePath: parsed.value.scenePath,
    nodePath: parsed.value.nodePath,
    signal: parsed.value.signal,
    targetNodePath: parsed.value.targetNodePath,
    method: parsed.value.method,
  };
  return executeSceneOp(
    runner,
    'disconnect_signal',
    params,
    parsed.value.projectPath,
    'Failed to disconnect signal',
    ['Ensure the signal connection exists before trying to disconnect it'],
    undefined,
    { parseStdoutAsJson: true, mutatesSceneFile: true },
  );
}
