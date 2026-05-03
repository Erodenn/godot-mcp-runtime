import { existsSync } from 'fs';
import { join } from 'path';
import type { GodotRunner, OperationParams, ToolDefinition } from '../utils/godot-runner.js';
import {
  normalizeParameters,
  convertCamelToSnakeCase,
  validatePath,
  createErrorResponse,
  extractGdError,
  validateSceneArgs,
} from '../utils/godot-runner.js';

// --- Tool definitions ---

export const nodeToolDefinitions: ToolDefinition[] = [
  {
    name: 'delete_node',
    description:
      'Remove a node and all its children from a Godot scene file. Use when pruning the scene tree; for replacing a node in place, pair with add_node. Saves automatically. Cannot delete the scene root. Errors if nodePath does not exist. Returns { success, nodePath }.',
    annotations: { destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
        scenePath: {
          type: 'string',
          description: 'Scene file path relative to the project (e.g. "scenes/main.tscn")',
        },
        nodePath: {
          type: 'string',
          description: 'Node path from scene root (e.g. "root/Player/Sprite2D")',
        },
      },
      required: ['projectPath', 'scenePath', 'nodePath'],
    },
  },
  {
    name: 'set_node_property',
    description:
      'Set a single property on a node in a Godot scene file. For multiple properties on the same or different nodes, use batch_set_node_properties — one Godot process instead of N. Saves automatically. Primitives pass through; Vector2 ({x,y}), Vector3 ({x,y,z}), and Color ({r,g,b,a}) auto-convert. For other complex GDScript types (Resource, NodePath, etc.), use run_script. Errors if nodePath or property does not exist. Returns { success, nodePath, property }.',
    annotations: { idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
        scenePath: { type: 'string', description: 'Scene file path relative to the project' },
        nodePath: { type: 'string', description: 'Node path from scene root (e.g. "root/Player")' },
        property: {
          type: 'string',
          description:
            'GDScript property name in snake_case (e.g. "position", "modulate", "collision_layer"). Use get_node_properties to discover valid names.',
        },
        value: { description: 'New property value' },
      },
      required: ['projectPath', 'scenePath', 'nodePath', 'property', 'value'],
    },
  },
  {
    name: 'batch_set_node_properties',
    description:
      'Set multiple node properties in a single Godot process — preferred over chained set_node_property calls (avoids ~3s startup per call). Same value-conversion rules as set_node_property. abortOnError stops on first failure (default false continues). Saves once at the end. Returns { results: [{ nodePath, property, success?, error? }] }.',
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
              nodePath: { type: 'string', description: 'Node path from scene root' },
              property: { type: 'string', description: 'GDScript property name in snake_case' },
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
  },
  {
    name: 'get_node_properties',
    description:
      "Read a node's current property values from a scene file. For multiple nodes, use batch_get_node_properties (one process). changedOnly:true filters out properties matching their class defaults — useful for compact diffs. Errors if nodePath does not exist. Returns { nodePath, nodeType, properties: { [key]: value } }.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
        scenePath: { type: 'string', description: 'Scene file path relative to the project' },
        nodePath: { type: 'string', description: 'Node path from scene root (e.g. "root/Player")' },
        changedOnly: {
          type: 'boolean',
          description:
            'Only return properties whose values differ from their class defaults (default: false)',
        },
      },
      required: ['projectPath', 'scenePath', 'nodePath'],
    },
  },
  {
    name: 'batch_get_node_properties',
    description:
      'Get properties from multiple nodes in a single Godot process — preferred over chained get_node_properties calls. Per-node changedOnly toggles default-filtering individually. Returns { results: [{ nodePath, nodeType, properties?, error? }] }; failed reads include error and omit properties.',
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
              nodePath: { type: 'string', description: 'Node path from scene root' },
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
      'Attach an existing GDScript file to a node in a scene. Use after writing the script with the standard file tools and validating it via the validate tool. Replaces any previously attached script. Saves automatically. Errors if scriptPath does not exist or nodePath is not found. Returns { success, nodePath, scriptPath }.',
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
  },
  {
    name: 'get_scene_tree',
    description:
      'Get the scene hierarchy as a nested tree of { name, type, path, children }. Use maxDepth:1 for a shallow listing of direct children only; default -1 returns the full tree. parentPath scopes the result to a subtree. Errors if scene does not exist or parentPath is not found.',
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
      'Duplicate a node and its descendants in a Godot scene. Use to clone a configured subtree without re-creating it node-by-node via add_node. newName defaults to the original name + "2"; targetParentPath defaults to the original parent. Saves automatically. Errors if nodePath does not exist or targetParentPath cannot accept children. Returns { success, originalPath, newPath }.',
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
  },
  {
    name: 'get_node_signals',
    description:
      'List all signals defined on a node and their current connections. Use before connect_signal/disconnect_signal to verify signal/method names. Returns { nodePath, nodeType, signals: [{ name, connections: [{ signal, target, method }] }] }. The target field uses Godot absolute path format (/root/Scene/Node) — convert to scene-root-relative (root/Node) before passing to connect/disconnect_signal. Errors if node not found.',
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
  },
  {
    name: 'connect_signal',
    description:
      'Connect a signal from one node to a method on another node. Saves automatically. Errors if the signal does not exist on the source node or the method does not exist on the target node.',
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
      'Disconnect a signal connection between two nodes. Saves automatically. Errors if the connection does not exist — use get_node_signals first to verify.',
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
];

// --- Handlers ---

export async function handleDeleteNode(runner: GodotRunner, args: OperationParams) {
  args = normalizeParameters(args);
  const v = validateSceneArgs(args);
  if ('isError' in v) return v;

  if (!args.nodePath || !validatePath(args.nodePath as string)) {
    return createErrorResponse('Valid nodePath is required', [
      'Provide the node path (e.g. "root/Player")',
    ]);
  }

  try {
    const params = { scenePath: args.scenePath, nodePath: args.nodePath };
    const { stdout, stderr } = await runner.executeOperation('delete_node', params, v.projectPath);
    if (!stdout.trim()) {
      return createErrorResponse(`Failed to delete node: ${extractGdError(stderr)}`, [
        'Check if the node path is correct',
      ]);
    }
    return { content: [{ type: 'text', text: stdout }] };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Failed to delete node: ${errorMessage}`, [
      'Ensure Godot is installed correctly',
    ]);
  }
}

export async function handleSetNodeProperty(runner: GodotRunner, args: OperationParams) {
  args = normalizeParameters(args);
  const v = validateSceneArgs(args);
  if ('isError' in v) return v;

  if (!args.nodePath || !validatePath(args.nodePath as string)) {
    return createErrorResponse('Valid nodePath is required', [
      'Provide the node path (e.g. "root/Player")',
    ]);
  }
  if (!args.property || args.value === undefined) {
    return createErrorResponse('property and value are required', [
      'Provide both property name and value',
    ]);
  }

  try {
    const params = {
      scenePath: args.scenePath,
      nodePath: args.nodePath,
      property: args.property,
      value: args.value,
    };
    const { stdout, stderr } = await runner.executeOperation(
      'set_node_property',
      params,
      v.projectPath,
    );
    if (!stdout.trim()) {
      return createErrorResponse(`Failed to update property: ${extractGdError(stderr)}`, [
        'Check if the property name is valid for this node type',
      ]);
    }
    return { content: [{ type: 'text', text: stdout }] };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Failed to set node property: ${errorMessage}`, [
      'Ensure Godot is installed correctly',
    ]);
  }
}

export async function handleBatchSetNodeProperties(runner: GodotRunner, args: OperationParams) {
  args = normalizeParameters(args);
  const v = validateSceneArgs(args);
  if ('isError' in v) return v;

  if (!args.updates || !Array.isArray(args.updates)) {
    return createErrorResponse('updates array is required', [
      'Provide an array of { nodePath, property, value }',
    ]);
  }

  try {
    const snakeUpdates = (args.updates as Array<Record<string, unknown>>).map((u) =>
      convertCamelToSnakeCase(u as OperationParams),
    );
    const params = {
      scenePath: args.scenePath,
      updates: snakeUpdates,
      abortOnError: args.abortOnError ?? false,
    };
    const { stdout, stderr } = await runner.executeOperation(
      'batch_set_node_properties',
      params,
      v.projectPath,
    );
    if (!stdout.trim()) {
      return createErrorResponse(`Batch update failed: ${extractGdError(stderr)}`, [
        'Check node paths and property names',
      ]);
    }
    return { content: [{ type: 'text', text: stdout }] };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Batch set properties failed: ${errorMessage}`, [
      'Ensure Godot is installed correctly',
    ]);
  }
}

export async function handleGetNodeProperties(runner: GodotRunner, args: OperationParams) {
  args = normalizeParameters(args);
  const v = validateSceneArgs(args);
  if ('isError' in v) return v;

  if (!args.nodePath || !validatePath(args.nodePath as string)) {
    return createErrorResponse('Valid nodePath is required', [
      'Provide the node path (e.g. "root/Player")',
    ]);
  }

  try {
    const params: OperationParams = { scenePath: args.scenePath, nodePath: args.nodePath };
    if (args.changedOnly) params.changedOnly = args.changedOnly;
    const { stdout, stderr } = await runner.executeOperation(
      'get_node_properties',
      params,
      v.projectPath,
    );
    if (!stdout.trim()) {
      return createErrorResponse(`Failed to get properties: ${extractGdError(stderr)}`, [
        'Check if the node path is correct',
      ]);
    }
    return { content: [{ type: 'text', text: stdout }] };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Failed to get node properties: ${errorMessage}`, [
      'Ensure Godot is installed correctly',
    ]);
  }
}

export async function handleBatchGetNodeProperties(runner: GodotRunner, args: OperationParams) {
  args = normalizeParameters(args);
  const v = validateSceneArgs(args);
  if ('isError' in v) return v;

  if (!args.nodes || !Array.isArray(args.nodes)) {
    return createErrorResponse('nodes array is required', [
      'Provide an array of { nodePath, changedOnly? }',
    ]);
  }

  try {
    const snakeNodes = (args.nodes as Array<Record<string, unknown>>).map((n) =>
      convertCamelToSnakeCase(n as OperationParams),
    );
    const params = { scenePath: args.scenePath, nodes: snakeNodes };
    const { stdout, stderr } = await runner.executeOperation(
      'batch_get_node_properties',
      params,
      v.projectPath,
    );
    if (!stdout.trim()) {
      return createErrorResponse(`Batch get_properties failed: ${extractGdError(stderr)}`, [
        'Check node paths',
      ]);
    }
    return { content: [{ type: 'text', text: stdout }] };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Batch get properties failed: ${errorMessage}`, [
      'Ensure Godot is installed correctly',
    ]);
  }
}

export async function handleAttachScript(runner: GodotRunner, args: OperationParams) {
  args = normalizeParameters(args);
  const v = validateSceneArgs(args);
  if ('isError' in v) return v;

  if (!args.nodePath || !validatePath(args.nodePath as string)) {
    return createErrorResponse('Valid nodePath is required', [
      'Provide the node path (e.g. "root/Player")',
    ]);
  }
  if (!args.scriptPath || !validatePath(args.scriptPath as string)) {
    return createErrorResponse('Valid scriptPath is required', [
      'Provide the script path relative to the project',
    ]);
  }
  const scriptFullPath = join(v.projectPath, args.scriptPath as string);
  if (!existsSync(scriptFullPath)) {
    return createErrorResponse(`Script file does not exist: ${args.scriptPath}`, [
      'Create the script file first',
    ]);
  }

  try {
    const params = {
      scenePath: args.scenePath,
      nodePath: args.nodePath,
      scriptPath: args.scriptPath,
    };
    const { stdout, stderr } = await runner.executeOperation(
      'attach_script',
      params,
      v.projectPath,
    );
    if (!stdout.trim()) {
      return createErrorResponse(`Failed to attach script: ${extractGdError(stderr)}`, [
        'Ensure the script is valid for this node type',
      ]);
    }
    return { content: [{ type: 'text', text: stdout }] };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Failed to attach script: ${errorMessage}`, [
      'Ensure Godot is installed correctly',
    ]);
  }
}

export async function handleGetSceneTree(runner: GodotRunner, args: OperationParams) {
  args = normalizeParameters(args);
  const v = validateSceneArgs(args);
  if ('isError' in v) return v;

  if (args.parentPath && !validatePath(args.parentPath as string)) {
    return createErrorResponse('Invalid parentPath', ['Provide a valid path without ".."']);
  }

  try {
    const params: OperationParams = { scenePath: args.scenePath };
    if (args.parentPath) params.parentPath = args.parentPath;
    if (typeof args.maxDepth === 'number') params.maxDepth = args.maxDepth;
    const { stdout, stderr } = await runner.executeOperation(
      'get_scene_tree',
      params,
      v.projectPath,
    );
    if (!stdout.trim()) {
      return createErrorResponse(`Failed to get scene tree: ${extractGdError(stderr)}`, [
        'Ensure the scene is valid',
      ]);
    }
    return { content: [{ type: 'text', text: stdout }] };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Failed to get scene tree: ${errorMessage}`, [
      'Ensure Godot is installed correctly',
    ]);
  }
}

export async function handleDuplicateNode(runner: GodotRunner, args: OperationParams) {
  args = normalizeParameters(args);
  const v = validateSceneArgs(args);
  if ('isError' in v) return v;

  if (!args.nodePath || !validatePath(args.nodePath as string)) {
    return createErrorResponse('Valid nodePath is required', [
      'Provide the node path to duplicate',
    ]);
  }
  if (args.targetParentPath && !validatePath(args.targetParentPath as string)) {
    return createErrorResponse('Invalid targetParentPath', ['Provide a valid path without ".."']);
  }

  try {
    const params: OperationParams = { scenePath: args.scenePath, nodePath: args.nodePath };
    if (args.newName) params.newName = args.newName;
    if (args.targetParentPath) params.targetParentPath = args.targetParentPath;
    const { stdout, stderr } = await runner.executeOperation(
      'duplicate_node',
      params,
      v.projectPath,
    );
    if (!stdout.trim()) {
      return createErrorResponse(`Failed to duplicate node: ${extractGdError(stderr)}`, [
        'Check if the node path and target parent path are correct',
      ]);
    }
    return { content: [{ type: 'text', text: stdout }] };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Failed to duplicate node: ${errorMessage}`, [
      'Ensure Godot is installed correctly',
    ]);
  }
}

export async function handleGetNodeSignals(runner: GodotRunner, args: OperationParams) {
  args = normalizeParameters(args);
  const v = validateSceneArgs(args);
  if ('isError' in v) return v;

  if (!args.nodePath || !validatePath(args.nodePath as string)) {
    return createErrorResponse('Valid nodePath is required', [
      'Provide the node path (e.g. "root/Button")',
    ]);
  }

  try {
    const params = { scenePath: args.scenePath, nodePath: args.nodePath };
    const { stdout, stderr } = await runner.executeOperation(
      'get_node_signals',
      params,
      v.projectPath,
    );
    if (!stdout.trim()) {
      return createErrorResponse(`Failed to get signals: ${extractGdError(stderr)}`, [
        'Check if the node path is correct',
      ]);
    }
    return { content: [{ type: 'text', text: stdout }] };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Failed to get node signals: ${errorMessage}`, [
      'Ensure Godot is installed correctly',
    ]);
  }
}

export async function handleConnectSignal(runner: GodotRunner, args: OperationParams) {
  args = normalizeParameters(args);
  const v = validateSceneArgs(args);
  if ('isError' in v) return v;

  if (!args.nodePath || !validatePath(args.nodePath as string)) {
    return createErrorResponse('Valid nodePath is required', ['Provide the source node path']);
  }
  if (!args.signal || !args.targetNodePath || !args.method) {
    return createErrorResponse('signal, targetNodePath, and method are required', [
      'Provide all three parameters',
    ]);
  }
  if (!validatePath(args.targetNodePath as string)) {
    return createErrorResponse('Invalid targetNodePath', ['Provide a valid path without ".."']);
  }

  try {
    const params = {
      scenePath: args.scenePath,
      nodePath: args.nodePath,
      signal: args.signal,
      targetNodePath: args.targetNodePath,
      method: args.method,
    };
    const { stdout, stderr } = await runner.executeOperation(
      'connect_signal',
      params,
      v.projectPath,
    );
    if (!stdout.trim()) {
      return createErrorResponse(`Failed to connect signal: ${extractGdError(stderr)}`, [
        'Ensure the signal exists on the source node and the method exists on the target node',
      ]);
    }
    return { content: [{ type: 'text', text: stdout }] };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Failed to connect signal: ${errorMessage}`, [
      'Ensure Godot is installed correctly',
    ]);
  }
}

export async function handleDisconnectSignal(runner: GodotRunner, args: OperationParams) {
  args = normalizeParameters(args);
  const v = validateSceneArgs(args);
  if ('isError' in v) return v;

  if (!args.nodePath || !validatePath(args.nodePath as string)) {
    return createErrorResponse('Valid nodePath is required', ['Provide the source node path']);
  }
  if (!args.signal || !args.targetNodePath || !args.method) {
    return createErrorResponse('signal, targetNodePath, and method are required', [
      'Provide all three parameters',
    ]);
  }
  if (!validatePath(args.targetNodePath as string)) {
    return createErrorResponse('Invalid targetNodePath', ['Provide a valid path without ".."']);
  }

  try {
    const params = {
      scenePath: args.scenePath,
      nodePath: args.nodePath,
      signal: args.signal,
      targetNodePath: args.targetNodePath,
      method: args.method,
    };
    const { stdout, stderr } = await runner.executeOperation(
      'disconnect_signal',
      params,
      v.projectPath,
    );
    if (!stdout.trim()) {
      return createErrorResponse(`Failed to disconnect signal: ${extractGdError(stderr)}`, [
        'Ensure the signal connection exists before trying to disconnect it',
      ]);
    }
    return { content: [{ type: 'text', text: stdout }] };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Failed to disconnect signal: ${errorMessage}`, [
      'Ensure Godot is installed correctly',
    ]);
  }
}
