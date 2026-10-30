/** Field helpers and per-handler argument parsers, each returning `Result<T, ToolResponse>`. */

import { existsSync } from 'fs';
import type { OperationParams, ToolResponse } from '../mcp.types.js';
import { createErrorResponse } from './error-response.js';
import { ok, err, type Result } from './result.js';
import type { NodePath, ProjectPath, ScenePath } from './branded.js';
import { normalizeParameters } from './parameter-conversion.js';
import {
  validatePath,
  isSceneFileNodeType,
  resolveProjectPath,
  type PathAccess,
  type ResolvedProjectPath,
  validateNodePath as validateNodePathShape,
  projectGodotPath,
  projectSubPathError,
  PROJECT_SUB_PATH_SOLUTIONS,
} from './path-validation.js';

export function requireString(args: OperationParams, key: string): Result<string, ToolResponse> {
  const value = args[key];
  if (typeof value !== 'string' || value === '') {
    return err(
      createErrorResponse(`${key} is required and must be a non-empty string`, [
        `Provide a string value for ${key}`,
      ]),
    );
  }
  return ok(value);
}

export function optionalString(
  args: OperationParams,
  key: string,
): Result<string | undefined, ToolResponse> {
  const value = args[key];
  if (value === undefined) return ok(undefined);
  if (typeof value !== 'string') {
    return err(
      createErrorResponse(`${key} must be a string when provided`, [
        `Provide a string value for ${key} or omit it`,
      ]),
    );
  }
  return ok(value);
}

export function requireStringArray(
  args: OperationParams,
  key: string,
  opts?: { minLength?: number },
): Result<string[], ToolResponse> {
  const value = args[key];
  const minLength = opts?.minLength ?? 1;
  if (!Array.isArray(value) || value.length < minLength) {
    return err(
      createErrorResponse(`${key} must be an array of at least ${minLength} string(s)`, [
        `Provide an array of strings for ${key}`,
      ]),
    );
  }
  if (!value.every(isStringElement)) {
    return err(
      createErrorResponse(`${key} entries must all be strings`, [
        `Ensure every entry in ${key} is a string`,
      ]),
    );
  }
  return ok(value);
}

export function optionalStringArray(
  args: OperationParams,
  key: string,
): Result<string[] | undefined, ToolResponse> {
  const value = args[key];
  if (value === undefined) return ok(undefined);
  if (!Array.isArray(value)) {
    return err(
      createErrorResponse(`${key} must be an array when provided`, [
        `Provide an array of strings for ${key} or omit it`,
      ]),
    );
  }
  if (!value.every(isStringElement)) {
    return err(
      createErrorResponse(`${key} entries must all be strings`, [
        `Ensure every entry in ${key} is a string`,
      ]),
    );
  }
  return ok(value);
}

function isStringElement(v: unknown): v is string {
  return typeof v === 'string';
}

export function requireNumber(args: OperationParams, key: string): Result<number, ToolResponse> {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return err(
      createErrorResponse(`${key} is required and must be a finite number`, [
        `Provide a numeric value for ${key}`,
      ]),
    );
  }
  return ok(value);
}

export function optionalNumber(
  args: OperationParams,
  key: string,
): Result<number | undefined, ToolResponse> {
  const value = args[key];
  if (value === undefined) return ok(undefined);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return err(
      createErrorResponse(`${key} must be a finite number when provided`, [
        `Provide a numeric value for ${key} or omit it`,
      ]),
    );
  }
  return ok(value);
}

export function requireBoolean(args: OperationParams, key: string): Result<boolean, ToolResponse> {
  const value = args[key];
  if (typeof value !== 'boolean') {
    return err(
      createErrorResponse(`${key} is required and must be a boolean`, [
        `Provide a boolean value for ${key}`,
      ]),
    );
  }
  return ok(value);
}

export function optionalBoolean(
  args: OperationParams,
  key: string,
): Result<boolean | undefined, ToolResponse> {
  const value = args[key];
  if (value === undefined) return ok(undefined);
  if (typeof value !== 'boolean') {
    return err(
      createErrorResponse(`${key} must be a boolean when provided`, [
        `Provide a boolean value for ${key} or omit it`,
      ]),
    );
  }
  return ok(value);
}

export function requireObject(
  args: OperationParams,
  key: string,
): Result<Record<string, unknown>, ToolResponse> {
  const value = args[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return err(
      createErrorResponse(`${key} is required and must be an object`, [
        `Provide a JSON object for ${key}`,
      ]),
    );
  }
  return ok(value as Record<string, unknown>);
}

export function optionalObject(
  args: OperationParams,
  key: string,
): Result<Record<string, unknown> | undefined, ToolResponse> {
  const value = args[key];
  if (value === undefined) return ok(undefined);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return err(
      createErrorResponse(`${key} must be an object when provided`, [
        `Provide a JSON object for ${key} or omit it`,
      ]),
    );
  }
  return ok(value as Record<string, unknown>);
}

export function requireArray(
  args: OperationParams,
  key: string,
  opts?: { minLength?: number },
): Result<unknown[], ToolResponse> {
  const value = args[key];
  const minLength = opts?.minLength ?? 1;
  if (!Array.isArray(value) || value.length < minLength) {
    return err(
      createErrorResponse(`${key} must be an array of at least ${minLength} item(s)`, [
        `Provide an array for ${key}`,
      ]),
    );
  }
  return ok(value);
}

/** Parses `projectPath`; the brand confirms the path is shape-checked AND `project.godot` exists, so handlers use it verbatim. */
export function parseProjectArgs(
  args: OperationParams,
): Result<{ projectPath: ProjectPath }, ToolResponse> {
  const raw = args.projectPath;
  if (!raw) {
    return err(
      createErrorResponse('projectPath is required', [
        'Provide a valid path to a Godot project directory',
      ]),
    );
  }
  if (typeof raw !== 'string') {
    return err(
      createErrorResponse('projectPath must be a string', [
        'Provide a valid path to a Godot project directory',
      ]),
    );
  }
  if (!validatePath(raw)) {
    return err(
      createErrorResponse('Invalid project path', [
        'Provide the path of the project directory, without a ".." segment',
      ]),
    );
  }
  if (!existsSync(projectGodotPath(raw))) {
    return err(
      createErrorResponse(`Not a valid Godot project: ${raw}`, [
        'Ensure the path points to a directory containing a project.godot file',
      ]),
    );
  }
  return ok({ projectPath: raw as ProjectPath });
}

/** Parses `projectPath` + `scenePath`: `scenePath` is always required; `requireExists` (default true) demands the file exist, `{ requireExists: false }` for `create_scene`-style writes. `access` says whether the tool saves the scene (`'write'`) or only reads it (`PathAccess`). */
export function parseSceneArgs(
  args: OperationParams,
  access: PathAccess,
  opts?: { requireExists?: boolean },
): Result<
  { projectPath: ProjectPath; scenePath: ScenePath; scene: ResolvedProjectPath },
  ToolResponse
> {
  const project = parseProjectArgs(args);
  if (!project.ok) return project;

  const requireExists = opts?.requireExists !== false;
  const raw = args.scenePath;

  if (!raw) {
    return err(
      createErrorResponse('scenePath is required', [
        'Provide the path of the scene file inside the project',
      ]),
    );
  }
  if (typeof raw !== 'string') {
    return err(
      createErrorResponse('scenePath must be a string', [
        'Provide the path of the scene file inside the project',
      ]),
    );
  }
  const scene = resolveProjectPath(project.value.projectPath, raw, access);
  if (!scene) {
    return err(
      createErrorResponse(projectSubPathError('scene path', raw), [...PROJECT_SUB_PATH_SOLUTIONS]),
    );
  }
  if (requireExists) {
    if (!existsSync(scene.absPath)) {
      return err(
        createErrorResponse(`Scene file does not exist: ${raw}`, [
          'Ensure the scene path is correct',
          'Use create_scene to create a new scene first',
        ]),
      );
    }
  }
  return ok({
    projectPath: project.value.projectPath,
    scenePath: scene.relPath as ScenePath,
    scene,
  });
}

/** Brands a string as a scene-tree NodePath after a shape check; that namespace is separate from files, so project-root containment does not apply. */
export function parseNodePath(raw: string, fieldName = 'nodePath'): Result<NodePath, ToolResponse> {
  if (!validateNodePathShape(raw)) {
    return err(
      createErrorResponse(`Invalid ${fieldName}`, [
        'Provide a scene-tree path without ".." (e.g. "root/Player")',
      ]),
    );
  }
  return ok(raw as NodePath);
}

export function parseRequiredNodePath(
  args: OperationParams,
  key: string,
): Result<NodePath, ToolResponse> {
  const raw = args[key];
  if (typeof raw !== 'string' || raw === '') {
    return err(
      createErrorResponse(`${key} is required`, [
        `Provide a scene-tree path for ${key} (e.g. "root/Player")`,
      ]),
    );
  }
  return parseNodePath(raw, key);
}

export function parseOptionalNodePath(
  args: OperationParams,
  key: string,
): Result<NodePath | undefined, ToolResponse> {
  const raw = args[key];
  if (raw === undefined || raw === null || raw === '') return ok(undefined);
  if (typeof raw !== 'string') {
    return err(
      createErrorResponse(`${key} must be a string when provided`, [
        `Provide a scene-tree path for ${key} or omit it`,
      ]),
    );
  }
  return parseNodePath(raw, key);
}

// `normalizeParameters` does not descend into arrays, so items reach a handler spelled however the caller wrote them. Each validator normalizes an item's keys once and returns it
// for forwarding: an item checked in one spelling and forwarded raw lets a key spelled both ways run as the value nobody checked.

type ItemRecord = Record<string, unknown>;

function asItemRecord(item: unknown): ItemRecord | null {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
  return item as ItemRecord;
}

function itemError(message: string, solution: string): Result<never, ToolResponse> {
  return err(createErrorResponse(message, [solution]));
}

function checkItemNodePath(item: ItemRecord, where: string): Result<void, ToolResponse> {
  const raw = item.nodePath;
  if (typeof raw !== 'string' || raw === '') {
    return itemError(
      `${where}.nodePath is required and must be a non-empty string`,
      'Provide a scene-tree path such as "root/Player"',
    );
  }
  const parsed = parseNodePath(raw, `${where}.nodePath`);
  if (!parsed.ok) return parsed;
  return ok(undefined);
}

/** Validate the items of get_node_properties `nodes`: { nodePath, changedOnly? }. Returns the items to forward. */
export function checkNodeReadItems(
  items: unknown[],
  field = 'nodes',
): Result<ItemRecord[], ToolResponse> {
  const checked: ItemRecord[] = [];
  for (let i = 0; i < items.length; i++) {
    const where = `${field}[${i}]`;
    const rawItem = asItemRecord(items[i]);
    if (!rawItem) {
      return itemError(`${where} must be an object with a nodePath`, 'Each item is { nodePath }');
    }
    const item: ItemRecord = normalizeParameters(rawItem);
    const nodePath = checkItemNodePath(item, where);
    if (!nodePath.ok) return nodePath;
    if (item.changedOnly !== undefined && typeof item.changedOnly !== 'boolean') {
      return itemError(
        `${where}.changedOnly must be a boolean when provided`,
        'Provide true or false for changedOnly, or omit it',
      );
    }
    checked.push(item);
  }
  return ok(checked);
}

/** Validate the items of set_node_properties `updates`: { nodePath, property, value }. Returns the items to forward. */
export function checkUpdateItems(
  items: unknown[],
  field = 'updates',
): Result<ItemRecord[], ToolResponse> {
  const checked: ItemRecord[] = [];
  for (let i = 0; i < items.length; i++) {
    const where = `${field}[${i}]`;
    const rawItem = asItemRecord(items[i]);
    if (!rawItem) {
      return itemError(
        `${where} must be an object with nodePath, property and value`,
        'Each update is { nodePath, property, value }',
      );
    }
    const item: ItemRecord = normalizeParameters(rawItem);
    const nodePath = checkItemNodePath(item, where);
    if (!nodePath.ok) return nodePath;
    if (typeof item.property !== 'string' || item.property === '') {
      return itemError(
        `${where}.property is required and must be a non-empty string`,
        'Provide the property name, for example "position"',
      );
    }
    if (item.value === undefined) {
      return itemError(
        `${where}.value is required`,
        'Provide a value for the property, or null to clear an Object-typed one',
      );
    }
    checked.push(item);
  }
  return ok(checked);
}

/** String-valued fields of a batch operation item: the script reads each into a typed parameter, so another type raises inside the script and takes every other operation in the batch down with it, with no per-operation result. */
const BATCH_ITEM_STRING_FIELDS: readonly string[] = [
  'nodeType',
  'nodeName',
  'parentNodePath',
  'nodePath',
  'texturePath',
  'newPath',
];

/** The batch item fields that hold a project path, with what the operation does to the file (scenes are saved, a `save` item's `newPath` is written, a texture or scene named as `nodeType` is only read); `applies` narrows a field that is a path for some values only. */
const BATCH_ITEM_PATH_FIELDS: ReadonlyArray<{
  key: string;
  access: PathAccess;
  applies?: (value: string) => boolean;
}> = [
  { key: 'scenePath', access: 'write' },
  { key: 'newPath', access: 'write' },
  { key: 'texturePath', access: 'read' },
  { key: 'nodeType', access: 'read', applies: isSceneFileNodeType },
];

/** Resolves every path field of one batch item by the rules a single call applies; returns the item with project-relative paths, or the refusal naming the item and field. */
function resolveBatchItemPaths(
  item: ItemRecord,
  where: string,
  projectPath: string,
): Result<ItemRecord, ToolResponse> {
  const resolved: ItemRecord = { ...item };
  for (const field of BATCH_ITEM_PATH_FIELDS) {
    const value = item[field.key];
    if (typeof value !== 'string' || value === '') continue;
    if (field.applies !== undefined && !field.applies(value)) continue;
    const path = resolveProjectPath(projectPath, value, field.access);
    if (path === null) {
      return err(
        createErrorResponse(projectSubPathError(`${where}.${field.key}`, value), [
          ...PROJECT_SUB_PATH_SOLUTIONS,
        ]),
      );
    }
    resolved[field.key] = path.relPath;
  }
  return ok(resolved);
}

/** The sub-operations a batch item may name. KEEP IN SYNC with the match in batch_scene_operations. */
const BATCH_OPERATION_NAMES = ['add_node', 'load_sprite', 'set_node_properties', 'save'] as const;

/** The operation an item's other keys suggest, worded as a hint appended to a missing-operation error. */
function batchOperationHint(item: Record<string, unknown>): string {
  const didYouMean = (keys: string, operation: string): string =>
    ` (${keys} present: did you mean operation '${operation}'?)`;
  if (item.nodeName !== undefined || item.nodeType !== undefined) {
    return didYouMean('nodeName/nodeType', 'add_node');
  }
  if (item.updates !== undefined) return didYouMean('updates', 'set_node_properties');
  if (item.texturePath !== undefined) return didYouMean('texturePath', 'load_sprite');
  return '';
}

/** Validates `operations` of batch_scene_operations. An item with a missing, empty or unknown `operation` is refused before Godot starts, so no item runs on a malformed call (the script keeps its own hint branch for callers that skip this check). Every path goes through `resolveProjectPath` with a single call's intent, so a batch accepts and refuses what the single tools do.
 * Keys are normalized first: the runner folds both spellings to one snake_case key, so with a key spelled both ways one spelling could be checked and the other read by the script. */
export function checkBatchOperationItems(
  items: unknown[],
  projectPath: string,
  field = 'operations',
): Result<ItemRecord[], ToolResponse> {
  const operationList = BATCH_OPERATION_NAMES.join(', ');
  const resolvedItems: ItemRecord[] = [];
  for (let i = 0; i < items.length; i++) {
    const where = `${field}[${i}]`;
    const rawItem = asItemRecord(items[i]);
    if (!rawItem) {
      return itemError(
        `${where} must be an object`,
        'Each operation is an object with an operation key',
      );
    }
    const item: ItemRecord = normalizeParameters(rawItem);
    if (item.operation === undefined || item.operation === null || item.operation === '') {
      return itemError(
        `${where} is missing the required 'operation' key (one of: ${operationList}).${batchOperationHint(item)}`,
        `Add an operation key to ${where}`,
      );
    }
    if (typeof item.operation !== 'string') {
      return itemError(`${where}.operation must be a string`, `Use one of: ${operationList}`);
    }
    if (!(BATCH_OPERATION_NAMES as readonly string[]).includes(item.operation)) {
      return itemError(
        `${where}.operation "${item.operation}" is not a batch operation (one of: ${operationList})`,
        `Use one of: ${operationList}`,
      );
    }
    if (item.scenePath !== undefined && typeof item.scenePath !== 'string') {
      return itemError(
        `${where}.scenePath must be a string when provided`,
        'Provide the path of the scene file inside the project',
      );
    }
    for (const key of BATCH_ITEM_STRING_FIELDS) {
      if (item[key] !== undefined && typeof item[key] !== 'string') {
        return itemError(
          `${where}.${key} must be a string when provided`,
          `Provide a string for ${key}, or omit it`,
        );
      }
    }
    if (item.properties !== undefined && asItemRecord(item.properties) === null) {
      return itemError(
        `${where}.properties must be an object when provided`,
        'Provide a JSON object of property values, or omit properties',
      );
    }
    if (item.abortOnError !== undefined && typeof item.abortOnError !== 'boolean') {
      return itemError(
        `${where}.abortOnError must be a boolean when provided`,
        'Provide true or false for abortOnError, or omit it',
      );
    }
    if (item.updates !== undefined) {
      if (!Array.isArray(item.updates)) {
        return itemError(`${where}.updates must be an array`, 'Provide an array of updates');
      }
      const updates = checkUpdateItems(item.updates, `${where}.updates`);
      if (!updates.ok) return updates;
      item.updates = updates.value;
    }
    const resolved = resolveBatchItemPaths(item, where, projectPath);
    if (!resolved.ok) return resolved;
    resolvedItems.push(resolved.value);
  }
  return ok(resolvedItems);
}
