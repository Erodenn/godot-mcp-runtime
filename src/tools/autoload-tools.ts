import { join } from 'path';
import { readFileSync } from 'fs';
import type { OperationParams, ToolDefinition } from '../utils/godot-runner.js';
import {
  normalizeParameters,
  validatePath,
  validateProjectArgs,
  createErrorResponse,
} from '../utils/godot-runner.js';
import {
  parseAutoloads,
  addAutoloadEntry,
  removeAutoloadEntry,
  updateAutoloadEntry,
} from '../utils/autoload-ini.js';

// --- Tool definitions ---

export const autoloadToolDefinitions: ToolDefinition[] = [
  {
    name: 'list_autoloads',
    description:
      'List all registered autoloads in a project with paths and singleton status. Use first when diagnosing headless failures — broken autoloads crash all headless ops, so this tells you what is loaded. No Godot process required (reads project.godot directly). Returns { autoloads: [{ name, path, singleton }] }.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
      },
      required: ['projectPath'],
    },
  },
  {
    name: 'add_autoload',
    description:
      'Register a new autoload in a project. autoloadPath accepts "res://..." or a project-relative path (auto-prefixed). singleton defaults true (accessible globally by name). No Godot process required. Warning: autoloads initialize in headless mode — a broken script will crash every subsequent headless op; validate before adding. Returns plain-text confirmation with the registered name, path, and singleton flag. Errors if an autoload with the same name already exists; use update_autoload to modify.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
        autoloadName: {
          type: 'string',
          description: 'Name of the autoload node (e.g. "MyManager")',
        },
        autoloadPath: {
          type: 'string',
          description:
            'Path to the script or scene (e.g. "res://autoload/my_manager.gd" or "autoload/my_manager.gd")',
        },
        singleton: {
          type: 'boolean',
          description: 'Register as a globally accessible singleton by name (default: true)',
        },
      },
      required: ['projectPath', 'autoloadName', 'autoloadPath'],
    },
  },
  {
    name: 'remove_autoload',
    description:
      'Unregister an autoload from a project by name. Use to recover from a broken autoload that is crashing headless ops. No Godot process required. Returns plain-text confirmation on success. Errors if no autoload with that name exists.',
    annotations: { destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
        autoloadName: { type: 'string', description: 'Name of the autoload to remove' },
      },
      required: ['projectPath', 'autoloadName'],
    },
  },
  {
    name: 'update_autoload',
    description:
      "Modify an existing autoload's path or singleton flag. Pass either or both — omitted fields keep their current value. Use instead of remove_autoload + add_autoload (single edit, no orphan window). No Godot process required. Returns plain-text confirmation on success. Errors if autoloadName is not registered.",
    annotations: { idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
        autoloadName: { type: 'string', description: 'Name of the autoload to update' },
        autoloadPath: { type: 'string', description: 'New path to the script or scene' },
        singleton: { type: 'boolean', description: 'New singleton flag' },
      },
      required: ['projectPath', 'autoloadName'],
    },
  },
];

// --- Handlers ---

export async function handleListAutoloads(args: OperationParams) {
  args = normalizeParameters(args);
  const v = validateProjectArgs(args);
  if ('isError' in v) return v;

  try {
    const projectFile = join(v.projectPath, 'project.godot');
    const autoloads = parseAutoloads(projectFile);
    return { content: [{ type: 'text', text: JSON.stringify({ autoloads }) }] };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Failed to list autoloads: ${errorMessage}`, [
      'Check if project.godot is accessible',
    ]);
  }
}

export async function handleAddAutoload(args: OperationParams) {
  args = normalizeParameters(args);
  const v = validateProjectArgs(args);
  if ('isError' in v) return v;

  if (!args.autoloadName || !args.autoloadPath) {
    return createErrorResponse('autoloadName and autoloadPath are required', [
      'Provide the autoload node name and script/scene path',
    ]);
  }
  if (!validatePath(args.autoloadPath as string)) {
    return createErrorResponse('Invalid autoload path', ['Provide a valid path without ".."']);
  }

  try {
    const projectFile = join(v.projectPath, 'project.godot');
    const projectFileContent = readFileSync(projectFile, 'utf8');
    const existing = parseAutoloads(projectFile, projectFileContent);
    if (existing.some((a) => a.name === (args.autoloadName as string))) {
      return createErrorResponse(`Autoload '${args.autoloadName}' already exists`, [
        'Use update_autoload to modify it',
        'Use list_autoloads to see current autoloads',
      ]);
    }
    const isSingleton = args.singleton !== false;
    addAutoloadEntry(
      projectFile,
      args.autoloadName as string,
      args.autoloadPath as string,
      isSingleton,
      projectFileContent,
    );
    return {
      content: [
        {
          type: 'text',
          text: `Autoload '${args.autoloadName}' registered at '${args.autoloadPath}' (singleton: ${isSingleton}).\nWarning: autoloads initialize in headless mode too. If this script has errors, all headless operations will fail. Verify by running get_scene_tree — if it fails, use remove_autoload to remove it.`,
        },
      ],
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Failed to add autoload: ${errorMessage}`, [
      'Check if project.godot is accessible',
    ]);
  }
}

export async function handleRemoveAutoload(args: OperationParams) {
  args = normalizeParameters(args);
  const v = validateProjectArgs(args);
  if ('isError' in v) return v;

  if (!args.autoloadName) {
    return createErrorResponse('autoloadName is required', [
      'Provide the name of the autoload to remove',
    ]);
  }

  try {
    const projectFile = join(v.projectPath, 'project.godot');
    const removed = removeAutoloadEntry(projectFile, args.autoloadName as string);
    if (!removed) {
      return createErrorResponse(`Autoload '${args.autoloadName}' not found`, [
        'Use list_autoloads to see existing autoloads',
      ]);
    }
    return {
      content: [{ type: 'text', text: `Autoload '${args.autoloadName}' removed successfully.` }],
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Failed to remove autoload: ${errorMessage}`, [
      'Check if project.godot is accessible',
    ]);
  }
}

export async function handleUpdateAutoload(args: OperationParams) {
  args = normalizeParameters(args);
  const v = validateProjectArgs(args);
  if ('isError' in v) return v;

  if (!args.autoloadName) {
    return createErrorResponse('autoloadName is required', [
      'Provide the name of the autoload to update',
    ]);
  }
  if (args.autoloadPath && !validatePath(args.autoloadPath as string)) {
    return createErrorResponse('Invalid autoload path', ['Provide a valid path without ".."']);
  }

  try {
    const projectFile = join(v.projectPath, 'project.godot');
    const updated = updateAutoloadEntry(
      projectFile,
      args.autoloadName as string,
      args.autoloadPath as string | undefined,
      args.singleton as boolean | undefined,
    );
    if (!updated) {
      return createErrorResponse(`Autoload '${args.autoloadName}' not found`, [
        'Use list_autoloads to see existing autoloads',
        'Use add_autoload to register a new one',
      ]);
    }
    return {
      content: [{ type: 'text', text: `Autoload '${args.autoloadName}' updated successfully.` }],
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Failed to update autoload: ${errorMessage}`, [
      'Check if project.godot is accessible',
    ]);
  }
}
