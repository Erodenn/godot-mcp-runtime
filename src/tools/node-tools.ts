import { existsSync } from 'fs';
import { join } from 'path';
import type { GodotRunner } from '../utils/godot-runner.js';
import type { OperationParams, ToolDefinition, ToolResponse } from '../mcp.types.js';
import { normalizeParameters } from '../utils/parameter-conversion.js';
import { validateSubPath } from '../utils/path-validation.js';
import { createErrorResponse } from '../utils/error-response.js';
import {
  parseSceneArgs,
  parseRequiredNodePath,
  parseOptionalNodePath,
  requireString,
  optionalString,
  requireStringArray,
  requireArray,
  optionalNumber,
  optionalBoolean,
} from '../utils/arg-parsing.js';
import type { NodePath, ProjectPath, ScenePath } from '../utils/branded.js';
import type { Result } from '../utils/result.js';
import { ok } from '../utils/result.js';
import { executeSceneOp } from '../utils/headless-op.js';

// --- Tool definitions ---

export const nodeToolDefinitions = [
  {
    name: 'delete_nodes',
    description:
      'Remove one or more nodes (and their descendants) from a scene file. Always-array: pass a single-element nodePaths array for one-off deletes. Saves once at the end. Cannot delete the scene root — that entry returns an error and the rest still process. Returns: results array with one entry per nodePath in input order (success or error message).',
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
    },
  },
  {
    name: 'set_node_properties',
    description:
      'Set one or more node properties on a scene in a single Godot process. Always-array: pass a single-element updates array for one-off edits. Vector2 ({x,y}), Vector3 ({x,y,z}), and Color ({r,g,b,a}) auto-convert; primitives pass through. For other complex GDScript types (Resource, NodePath, etc.), use run_script. abortOnError stops on first failure (default false continues). Saves once at the end. Returns: results[] with one entry per update in input order (success or error).',
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
                  'GDScript property name in snake_case (e.g. "position", "modulate", "collision_layer")',
              },
              value: { description: 'New property value' },
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
        results: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              nodePath: { type: 'string' },
              property: { type: 'string' },
              success: { type: 'boolean' },
              error: { type: 'string' },
            },
          },
        },
      },
    },
  },
  {
    name: 'get_node_properties',
    description:
      "Read one or more nodes' current property values from a scene file in a single Godot process. Always-array: pass a single-element nodes array for one-off reads. Per-node changedOnly:true filters out properties matching class defaults (useful for compact diffs). Returns: { results: [{ nodePath, nodeType, properties?, error? }] }; failed reads include error and omit properties.",
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
  },
  {
    name: 'attach_script',
    description:
      'Attach an existing GDScript file to a node in a scene. Use after writing the script with the standard file tools and validating it via the validate tool. Replaces any previously attached script. Saves automatically. Returns: success with the resolved nodePath and scriptPath that were attached. Errors if scriptPath does not exist or nodePath is not found.',
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
            'Path to the GDScript file relative to the project (e.g. "scripts/player.gd")',
        },
      },
      required: ['projectPath', 'scenePath', 'nodePath', 'scriptPath'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        nodePath: { type: 'string' },
        scriptPath: { type: 'string' },
      },
    },
  },
  {
    name: 'get_scene_tree',
    description:
      'Get the scene hierarchy as a nested tree of { name, type, path, script, children }. Use maxDepth:1 for a shallow listing of direct children only; default -1 returns the full tree. parentPath scopes the result to a subtree. Returns the nested tree as JSON text. Errors if scene does not exist or parentPath is not found.',
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
  },
  {
    name: 'duplicate_node',
    description:
      'Duplicate a node and its descendants in a Godot scene. Use to clone a configured subtree without re-creating it node-by-node via add_node. newName defaults to the original name + "2"; targetParentPath defaults to the original parent. Saves automatically. Returns: success with originalPath and the newPath where the duplicate now lives — use newPath for follow-up edits. Errors if nodePath does not exist or targetParentPath cannot accept children.',
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
        originalPath: { type: 'string' },
        newPath: { type: 'string' },
      },
    },
  },
  {
    name: 'get_node_signals',
    description:
      'List all signals defined on a node and their current connections. Use before connect_signal/disconnect_signal to verify signal/method names. The connections[].target field uses Godot absolute path format (/root/Scene/Node) — convert to scene-root-relative (root/Node) before passing to connect/disconnect_signal. Returns: nodeType and signals[], each with name and current connections (signal/target/method). Errors if node not found.',
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
                    target: { type: 'string' },
                    method: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  {
    name: 'connect_signal',
    description:
      'Connect a signal on a source node to a method on a target node, persisting the connection in the .tscn. Use after get_node_signals to confirm the signal name on the source and the method name on the target. Connecting the same signal+method pair twice creates a duplicate connection — call get_node_signals first if uncertain. Saves automatically. Returns a plain-text confirmation naming the source, signal, target, and method. Errors if the signal does not exist on the source node or the method does not exist on the target node.',
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
  },
  {
    name: 'disconnect_signal',
    description:
      'Remove an existing signal connection between two nodes, persisting the change in the .tscn. Use get_node_signals first to confirm the connection exists; recovery requires reconnecting via connect_signal. Saves automatically. Returns a plain-text confirmation naming the disconnected signal and target. Errors if the connection does not exist.',
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
  },
] as const satisfies readonly ToolDefinition[];

// --- Handlers ---

export async function handleDeleteNodes(
  runner: GodotRunner,
  args: OperationParams,
): Promise<ToolResponse> {
  args = normalizeParameters(args);
  const parsed = parseSceneArgs(args);
  if (!parsed.ok) return parsed.error;

  const nodePaths = requireStringArray(args, 'nodePaths');
  if (!nodePaths.ok) return nodePaths.error;
  for (const p of nodePaths.value) {
    if (p.includes('..')) {
      return createErrorResponse('Invalid nodePath in nodePaths', [
        'Provide a scene-tree path without ".." (e.g. "root/Player")',
      ]);
    }
  }

  const params = { scenePath: parsed.value.scenePath, nodePaths: nodePaths.value };
  return executeSceneOp(
    runner,
    'delete_nodes',
    params,
    parsed.value.projectPath,
    'Failed to delete nodes',
    ['Check if the node paths are correct'],
  );
}

export async function handleSetNodeProperties(
  runner: GodotRunner,
  args: OperationParams,
): Promise<ToolResponse> {
  args = normalizeParameters(args);
  const parsed = parseSceneArgs(args);
  if (!parsed.ok) return parsed.error;

  const updates = requireArray(args, 'updates');
  if (!updates.ok) return updates.error;

  const abortOnError = optionalBoolean(args, 'abortOnError');
  if (!abortOnError.ok) return abortOnError.error;

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
  );
}

export async function handleGetNodeProperties(
  runner: GodotRunner,
  args: OperationParams,
): Promise<ToolResponse> {
  args = normalizeParameters(args);
  const parsed = parseSceneArgs(args);
  if (!parsed.ok) return parsed.error;

  const nodes = requireArray(args, 'nodes');
  if (!nodes.ok) return nodes.error;

  const params = { scenePath: parsed.value.scenePath, nodes: nodes.value };
  return executeSceneOp(
    runner,
    'get_node_properties',
    params,
    parsed.value.projectPath,
    'Failed to get node properties',
    ['Check node paths'],
  );
}

export async function handleAttachScript(
  runner: GodotRunner,
  args: OperationParams,
): Promise<ToolResponse> {
  args = normalizeParameters(args);
  const parsed = parseSceneArgs(args);
  if (!parsed.ok) return parsed.error;

  const nodePath = parseRequiredNodePath(args, 'nodePath');
  if (!nodePath.ok) return nodePath.error;

  const scriptPath = requireString(args, 'scriptPath');
  if (!scriptPath.ok) return scriptPath.error;
  if (!validateSubPath(parsed.value.projectPath, scriptPath.value)) {
    return createErrorResponse('Valid scriptPath is required', [
      'Provide a relative script path that stays inside the project directory',
    ]);
  }
  const scriptFullPath = join(parsed.value.projectPath, scriptPath.value);
  if (!existsSync(scriptFullPath)) {
    return createErrorResponse(`Script file does not exist: ${scriptPath.value}`, [
      'Create the script file first',
    ]);
  }

  const params = {
    scenePath: parsed.value.scenePath,
    nodePath: nodePath.value,
    scriptPath: scriptPath.value,
  };
  return executeSceneOp(
    runner,
    'attach_script',
    params,
    parsed.value.projectPath,
    'Failed to attach script',
    ['Ensure the script is valid for this node type'],
  );
}

export async function handleGetSceneTree(
  runner: GodotRunner,
  args: OperationParams,
): Promise<ToolResponse> {
  args = normalizeParameters(args);
  const parsed = parseSceneArgs(args);
  if (!parsed.ok) return parsed.error;

  const parentPath = parseOptionalNodePath(args, 'parentPath');
  if (!parentPath.ok) return parentPath.error;

  const maxDepth = optionalNumber(args, 'maxDepth');
  if (!maxDepth.ok) return maxDepth.error;

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
  );
}

export async function handleDuplicateNode(
  runner: GodotRunner,
  args: OperationParams,
): Promise<ToolResponse> {
  args = normalizeParameters(args);
  const parsed = parseSceneArgs(args);
  if (!parsed.ok) return parsed.error;

  const nodePath = parseRequiredNodePath(args, 'nodePath');
  if (!nodePath.ok) return nodePath.error;

  const targetParentPath = parseOptionalNodePath(args, 'targetParentPath');
  if (!targetParentPath.ok) return targetParentPath.error;

  const newName = optionalString(args, 'newName');
  if (!newName.ok) return newName.error;

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
  );
}

export async function handleGetNodeSignals(
  runner: GodotRunner,
  args: OperationParams,
): Promise<ToolResponse> {
  args = normalizeParameters(args);
  const parsed = parseSceneArgs(args);
  if (!parsed.ok) return parsed.error;

  const nodePath = parseRequiredNodePath(args, 'nodePath');
  if (!nodePath.ok) return nodePath.error;

  const params = { scenePath: parsed.value.scenePath, nodePath: nodePath.value };
  return executeSceneOp(
    runner,
    'get_node_signals',
    params,
    parsed.value.projectPath,
    'Failed to get node signals',
    ['Check if the node path is correct'],
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
): Promise<ToolResponse> {
  args = normalizeParameters(args);
  const parsed = parseSignalArgs(args);
  if (!parsed.ok) return parsed.error;

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
  );
}

export async function handleDisconnectSignal(
  runner: GodotRunner,
  args: OperationParams,
): Promise<ToolResponse> {
  args = normalizeParameters(args);
  const parsed = parseSignalArgs(args);
  if (!parsed.ok) return parsed.error;

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
  );
}
