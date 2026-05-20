import { readFileSync } from 'fs';
import type { OperationParams, ToolDefinition, ToolResponse } from '../mcp.types.js';
import { normalizeParameters } from '../utils/parameter-conversion.js';
import { validateSubPath, projectGodotPath } from '../utils/path-validation.js';
import { createErrorResponse, getErrorMessage } from '../utils/error-response.js';
import {
  parseProjectArgs,
  requireString,
  optionalString,
  optionalBoolean,
} from '../utils/arg-parsing.js';
import {
  parseAutoloads,
  addAutoloadEntry,
  removeAutoloadEntry,
  updateAutoloadEntry,
} from '../utils/autoload-ini.js';

// --- Tool definitions ---

export const autoloadToolDefinitions = [
  {
    name: 'list_autoloads',
    description:
      'List all registered autoloads in a project with paths and singleton status. Use first when diagnosing headless failures — broken autoloads crash all headless ops, so this tells you what is loaded. No Godot process required (reads project.godot directly). Returns: [{ name, path, singleton }].',
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
] as const satisfies readonly ToolDefinition[];

// --- Handlers ---

export function handleListAutoloads(args: OperationParams): ToolResponse {
  args = normalizeParameters(args);
  const parsed = parseProjectArgs(args);
  if (!parsed.ok) return parsed.error;

  try {
    const projectFile = projectGodotPath(parsed.value.projectPath);
    const autoloads = parseAutoloads(projectFile);
    return { content: [{ type: 'text', text: JSON.stringify(autoloads) }] };
  } catch (error: unknown) {
    return createErrorResponse(`Failed to list autoloads: ${getErrorMessage(error)}`, [
      'Check if project.godot is accessible',
    ]);
  }
}

export function handleAddAutoload(args: OperationParams): ToolResponse {
  args = normalizeParameters(args);
  const parsed = parseProjectArgs(args);
  if (!parsed.ok) return parsed.error;

  const autoloadName = requireString(args, 'autoloadName');
  if (!autoloadName.ok) return autoloadName.error;

  const autoloadPath = requireString(args, 'autoloadPath');
  if (!autoloadPath.ok) return autoloadPath.error;

  if (!validateSubPath(parsed.value.projectPath, autoloadPath.value)) {
    return createErrorResponse('Invalid autoload path', [
      'Provide a valid relative path or res:// URI that stays inside the project directory',
    ]);
  }

  const singleton = optionalBoolean(args, 'singleton');
  if (!singleton.ok) return singleton.error;

  try {
    const projectFile = projectGodotPath(parsed.value.projectPath);
    const projectFileContent = readFileSync(projectFile, 'utf8');
    const existing = parseAutoloads(projectFile, projectFileContent);
    if (existing.some((a) => a.name === autoloadName.value)) {
      return createErrorResponse(`Autoload '${autoloadName.value}' already exists`, [
        'Use update_autoload to modify it',
        'Use list_autoloads to see current autoloads',
      ]);
    }
    const isSingleton = singleton.value !== false;
    addAutoloadEntry(
      projectFile,
      autoloadName.value,
      autoloadPath.value,
      isSingleton,
      projectFileContent,
    );
    return {
      content: [
        {
          type: 'text',
          text: `Autoload '${autoloadName.value}' registered at '${autoloadPath.value}' (singleton: ${isSingleton}).\nWarning: autoloads initialize in headless mode too. If this script has errors, all headless operations will fail. Verify by running get_scene_tree — if it fails, use remove_autoload to remove it.`,
        },
      ],
    };
  } catch (error: unknown) {
    return createErrorResponse(`Failed to add autoload: ${getErrorMessage(error)}`, [
      'Check if project.godot is accessible',
    ]);
  }
}

export function handleRemoveAutoload(args: OperationParams): ToolResponse {
  args = normalizeParameters(args);
  const parsed = parseProjectArgs(args);
  if (!parsed.ok) return parsed.error;

  const autoloadName = requireString(args, 'autoloadName');
  if (!autoloadName.ok) return autoloadName.error;

  try {
    const projectFile = projectGodotPath(parsed.value.projectPath);
    const removed = removeAutoloadEntry(projectFile, autoloadName.value);
    if (!removed) {
      return createErrorResponse(`Autoload '${autoloadName.value}' not found`, [
        'Use list_autoloads to see existing autoloads',
      ]);
    }
    return {
      content: [{ type: 'text', text: `Autoload '${autoloadName.value}' removed successfully.` }],
    };
  } catch (error: unknown) {
    return createErrorResponse(`Failed to remove autoload: ${getErrorMessage(error)}`, [
      'Check if project.godot is accessible',
    ]);
  }
}

export function handleUpdateAutoload(args: OperationParams): ToolResponse {
  args = normalizeParameters(args);
  const parsed = parseProjectArgs(args);
  if (!parsed.ok) return parsed.error;

  const autoloadName = requireString(args, 'autoloadName');
  if (!autoloadName.ok) return autoloadName.error;

  const autoloadPath = optionalString(args, 'autoloadPath');
  if (!autoloadPath.ok) return autoloadPath.error;

  if (
    autoloadPath.value !== undefined &&
    !validateSubPath(parsed.value.projectPath, autoloadPath.value)
  ) {
    return createErrorResponse('Invalid autoload path', [
      'Provide a valid relative path or res:// URI that stays inside the project directory',
    ]);
  }

  const singleton = optionalBoolean(args, 'singleton');
  if (!singleton.ok) return singleton.error;

  try {
    const projectFile = projectGodotPath(parsed.value.projectPath);
    const updated = updateAutoloadEntry(
      projectFile,
      autoloadName.value,
      autoloadPath.value,
      singleton.value,
    );
    if (!updated) {
      return createErrorResponse(`Autoload '${autoloadName.value}' not found`, [
        'Use list_autoloads to see existing autoloads',
        'Use add_autoload to register a new one',
      ]);
    }
    return {
      content: [{ type: 'text', text: `Autoload '${autoloadName.value}' updated successfully.` }],
    };
  } catch (error: unknown) {
    return createErrorResponse(`Failed to update autoload: ${getErrorMessage(error)}`, [
      'Check if project.godot is accessible',
    ]);
  }
}
