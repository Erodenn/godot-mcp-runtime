import { readFileSync } from 'fs';
import type { HandlerResult, OperationParams, ToolDefinition } from '../mcp.types.js';
import { normalizeParameters } from '../utils/parameter-conversion.js';
import {
  projectGodotPath,
  projectSubPathError,
  PROJECT_SUB_PATH_SOLUTIONS,
  resolveProjectPath,
} from '../utils/path-validation.js';
import { createErrorResponse, getErrorMessage } from '../utils/error-response.js';
import {
  parseProjectArgs,
  requireString,
  optionalString,
  optionalBoolean,
} from '../utils/arg-parsing.js';
import { err } from '../utils/result.js';
import { createStructuredResponse, leadWithWarnings } from '../utils/structured-response.js';
import {
  parseAutoloads,
  parseAutoloadSection,
  addAutoloadEntry,
  AUTOLOAD_PATH_FORBIDDEN_REGEX,
  removeAutoloadEntry,
  updateAutoloadEntry,
} from '../utils/autoload-ini.js';

// --- Tool definitions ---

const ADD_AUTOLOAD_TIP =
  'Autoloads load in headless mode too: one that stops the engine before an operation is dispatched (it quits in _init, for example) fails every headless operation, while one that only errors in _ready does not. Run validate on the script to check it; remove_autoload undoes this.';

const AUTOLOAD_ENTRY_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    path: { type: 'string', description: 'res:// path of the script or scene.' },
    singleton: { type: 'boolean' },
  },
  required: ['name', 'path', 'singleton'],
} as const;

export const autoloadToolDefinitions = [
  {
    name: 'list_autoloads',
    description:
      'List the autoloads registered in a project, with their paths and singleton flags. Use first when diagnosing headless failures: an autoload that stops the engine before an operation is dispatched fails every headless operation. Reads project.godot directly, no Godot process. Returns: autoloads[], each { name, path, singleton }, one per name (the last assignment, which the engine keeps); empty when none. warnings leads when a line is not listed or is not in the form Godot writes.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
      },
      required: ['projectPath'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        warnings: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Present only when an autoload line could not be parsed, or assigns a name a later line assigns again (neither is listed in autoloads), or when project.godot holds lines that are not in the form Godot writes, named by line number: the engine may register an autoload from such a line that is not listed.',
        },
        autoloads: { type: 'array', items: AUTOLOAD_ENTRY_SCHEMA },
      },
      required: ['autoloads'],
    },
  },
  {
    name: 'add_autoload',
    description:
      'Register a new autoload in a project. autoloadPath takes res://... or a path inside the project. singleton defaults to true. No Godot process is used. An autoload that stops the engine before a headless operation is dispatched fails all of them (one that only errors in _ready does not): run validate on it first. Returns: autoload { name, path, singleton } read back from project.godot, and a tip. Errors if the name is already registered; use update_autoload to change it.',
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
    outputSchema: {
      type: 'object',
      properties: {
        autoload: AUTOLOAD_ENTRY_SCHEMA,
        tip: { type: 'string' },
      },
      required: ['autoload', 'tip'],
    },
  },
  {
    name: 'remove_autoload',
    description:
      'Unregister an autoload from a project by name. Use to recover from an autoload that stops the engine before headless operations are dispatched. No Godot process is used. Returns: removed (the name) and autoloads[], the entries that remain, read back from project.godot. Errors if no autoload has that name.',
    annotations: { destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
        autoloadName: { type: 'string', description: 'Name of the autoload to remove' },
      },
      required: ['projectPath', 'autoloadName'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        removed: { type: 'string', description: 'Name of the autoload that was removed.' },
        autoloads: {
          type: 'array',
          description: 'The entries that remain.',
          items: AUTOLOAD_ENTRY_SCHEMA,
        },
      },
      required: ['removed', 'autoloads'],
    },
  },
  {
    name: 'update_autoload',
    description:
      "Change an existing autoload's path or singleton flag. Pass autoloadPath, singleton or both; errors if neither is given. An omitted field keeps its current value. Use instead of remove_autoload plus add_autoload: one edit, no window where the autoload is missing. No Godot process is used. Returns: autoload { name, path, singleton } read back from project.godot. Errors if autoloadName is not registered.",
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
    outputSchema: {
      type: 'object',
      properties: {
        autoload: AUTOLOAD_ENTRY_SCHEMA,
      },
      required: ['autoload'],
    },
  },
] as const satisfies readonly ToolDefinition[];

// --- Handlers ---

function rejectForbiddenPathCharacters(autoloadPath: string): HandlerResult | undefined {
  if (!AUTOLOAD_PATH_FORBIDDEN_REGEX.test(autoloadPath)) return undefined;
  return err(
    createErrorResponse('autoloadPath must not contain a double quote or a line break', [
      'Remove the double quote or line break from autoloadPath',
    ]),
  );
}

export function handleListAutoloads(args: OperationParams): HandlerResult {
  args = normalizeParameters(args);
  const parsed = parseProjectArgs(args);
  if (!parsed.ok) return parsed;

  try {
    const projectFile = projectGodotPath(parsed.value.projectPath);
    const { entries, unparsed, shadowed, nonCanonical } = parseAutoloadSection(projectFile);
    const warnings: string[] = [];
    if (nonCanonical !== null) {
      warnings.push(`${nonCanonical}. An autoload such a line registers may not be listed`);
    }
    if (unparsed.length > 0) {
      warnings.push(
        `[autoload] has ${unparsed.length} line(s) that could not be parsed and are not listed: ${unparsed.join(' | ')}`,
      );
    }
    if (shadowed.length > 0) {
      warnings.push(
        `${shadowed.length} autoload line(s) assign a name that a later line assigns again. The engine keeps the last assignment, so these are not listed: ${shadowed.join(' | ')}`,
      );
    }
    return createStructuredResponse(leadWithWarnings({ warnings, autoloads: entries }));
  } catch (error: unknown) {
    return err(
      createErrorResponse(`Failed to list autoloads: ${getErrorMessage(error)}`, [
        'Check if project.godot is accessible',
      ]),
    );
  }
}

export function handleAddAutoload(args: OperationParams): HandlerResult {
  args = normalizeParameters(args);
  const parsed = parseProjectArgs(args);
  if (!parsed.ok) return parsed;

  const autoloadName = requireString(args, 'autoloadName');
  if (!autoloadName.ok) return autoloadName;

  const autoloadPath = requireString(args, 'autoloadPath');
  if (!autoloadPath.ok) return autoloadPath;

  const forbiddenAdd = rejectForbiddenPathCharacters(autoloadPath.value);
  if (forbiddenAdd) return forbiddenAdd;

  const resolvedAutoload = resolveProjectPath(parsed.value.projectPath, autoloadPath.value, 'read');
  if (!resolvedAutoload) {
    return err(
      createErrorResponse(projectSubPathError('autoload path', autoloadPath.value), [
        ...PROJECT_SUB_PATH_SOLUTIONS,
      ]),
    );
  }

  const singleton = optionalBoolean(args, 'singleton');
  if (!singleton.ok) return singleton;

  try {
    const projectFile = projectGodotPath(parsed.value.projectPath);
    const projectFileContent = readFileSync(projectFile, 'utf8');
    const existing = parseAutoloads(projectFile, projectFileContent);
    if (existing.some((a) => a.name === autoloadName.value)) {
      return err(
        createErrorResponse(`Autoload '${autoloadName.value}' already exists`, [
          'Use update_autoload to modify it',
          'Use list_autoloads to see current autoloads',
        ]),
      );
    }
    const isSingleton = singleton.value !== false;
    addAutoloadEntry(
      projectFile,
      autoloadName.value,
      resolvedAutoload.resPath,
      isSingleton,
      projectFileContent,
    );
    const registered = parseAutoloads(projectFile).find((a) => a.name === autoloadName.value);
    if (registered === undefined) {
      return err(
        createErrorResponse(
          `Autoload '${autoloadName.value}' was written but is not in project.godot when it is read back`,
          [
            'Open project.godot and check the [autoload] section for a malformed line',
            'Use list_autoloads to see what is registered',
          ],
        ),
      );
    }
    return createStructuredResponse({ autoload: registered, tip: ADD_AUTOLOAD_TIP });
  } catch (error: unknown) {
    return err(
      createErrorResponse(`Failed to add autoload: ${getErrorMessage(error)}`, [
        'Check if project.godot is accessible',
      ]),
    );
  }
}

export function handleRemoveAutoload(args: OperationParams): HandlerResult {
  args = normalizeParameters(args);
  const parsed = parseProjectArgs(args);
  if (!parsed.ok) return parsed;

  const autoloadName = requireString(args, 'autoloadName');
  if (!autoloadName.ok) return autoloadName;

  try {
    const projectFile = projectGodotPath(parsed.value.projectPath);
    const removed = removeAutoloadEntry(projectFile, autoloadName.value);
    if (!removed) {
      return err(
        createErrorResponse(`Autoload '${autoloadName.value}' not found`, [
          'Use list_autoloads to see existing autoloads',
        ]),
      );
    }
    const remaining = parseAutoloads(projectFile);
    if (remaining.some((a) => a.name === autoloadName.value)) {
      return err(
        createErrorResponse(
          `Autoload '${autoloadName.value}' is still in project.godot after the removal was written`,
          ['Open project.godot and remove the entry from the [autoload] section by hand'],
        ),
      );
    }
    return createStructuredResponse({ removed: autoloadName.value, autoloads: remaining });
  } catch (error: unknown) {
    return err(
      createErrorResponse(`Failed to remove autoload: ${getErrorMessage(error)}`, [
        'Check if project.godot is accessible',
      ]),
    );
  }
}

export function handleUpdateAutoload(args: OperationParams): HandlerResult {
  args = normalizeParameters(args);
  const parsed = parseProjectArgs(args);
  if (!parsed.ok) return parsed;

  const autoloadName = requireString(args, 'autoloadName');
  if (!autoloadName.ok) return autoloadName;

  const autoloadPath = optionalString(args, 'autoloadPath');
  if (!autoloadPath.ok) return autoloadPath;

  if (autoloadPath.value !== undefined) {
    const forbidden = rejectForbiddenPathCharacters(autoloadPath.value);
    if (forbidden) return forbidden;
  }

  const resolvedAutoload =
    autoloadPath.value === undefined
      ? undefined
      : resolveProjectPath(parsed.value.projectPath, autoloadPath.value, 'read');
  if (autoloadPath.value !== undefined && !resolvedAutoload) {
    return err(
      createErrorResponse(projectSubPathError('autoload path', autoloadPath.value), [
        ...PROJECT_SUB_PATH_SOLUTIONS,
      ]),
    );
  }

  const singleton = optionalBoolean(args, 'singleton');
  if (!singleton.ok) return singleton;

  if (autoloadPath.value === undefined && singleton.value === undefined) {
    return err(
      createErrorResponse('update_autoload changes nothing: pass autoloadPath, singleton or both', [
        'Pass autoloadPath to change the path',
        'Pass singleton to change the singleton flag',
      ]),
    );
  }

  try {
    const projectFile = projectGodotPath(parsed.value.projectPath);
    const updated = updateAutoloadEntry(
      projectFile,
      autoloadName.value,
      resolvedAutoload?.resPath,
      singleton.value,
    );
    if (!updated) {
      return err(
        createErrorResponse(`Autoload '${autoloadName.value}' not found`, [
          'Use list_autoloads to see existing autoloads; a line it reports as not parsed cannot be updated, remove_autoload removes it',
          'Use add_autoload to register a new one',
        ]),
      );
    }
    const current = parseAutoloads(projectFile).find((a) => a.name === autoloadName.value);
    if (current === undefined) {
      return err(
        createErrorResponse(
          `Autoload '${autoloadName.value}' was updated but is not in project.godot when it is read back`,
          ['Use list_autoloads to see what is registered'],
        ),
      );
    }
    return createStructuredResponse({ autoload: current });
  } catch (error: unknown) {
    return err(
      createErrorResponse(`Failed to update autoload: ${getErrorMessage(error)}`, [
        'Check if project.godot is accessible',
      ]),
    );
  }
}
