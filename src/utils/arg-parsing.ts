/**
 * Generic field helpers + per-handler argument parsers.
 *
 * Each helper returns `Result<T, ToolResponse>` so handlers can compose
 * parsing with `if (!parsed.ok) return parsed.error` and never touch the
 * raw `OperationParams` index signature.
 *
 * Path-shaped helpers (`parseProjectArgs`, `parseSceneArgs`, `parseNodePath`)
 * are added in the same module alongside the generic kit so handlers have a
 * single import for argument parsing.
 */

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

// --- Generic field helpers ---

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

// --- Path-shaped helpers ---

/**
 * Parse and validate `projectPath` from raw args. The returned brand confirms
 * the path has been shape-checked AND the `project.godot` manifest exists on
 * disk — handlers can use the value verbatim without re-validating.
 */
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

/**
 * Parse and validate `projectPath` + `scenePath`. Two independent concerns:
 *
 * - Presence: `scenePath` must always be provided (you must say *where* the
 *   scene is or will be) — there is no opt-out.
 * - Existence: when `requireExists` is true (default), the scene file must
 *   already exist on disk. Pass `{ requireExists: false }` for operations
 *   like `create_scene` that write a scene to a path that need not exist yet.
 *
 * `access` says what the tool does with the scene: `'write'` for every tool
 * that saves it, `'read'` for one that only reads it. See `PathAccess`.
 */
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

/**
 * Brand a string as a scene-tree NodePath after validating its shape. Use
 * for fields that hold a node path (e.g. `nodePath`, `parentNodePath`,
 * `targetNodePath`) — scene-tree paths live in a separate namespace from
 * filesystem paths and the project-root containment check does not apply.
 */
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

// --- Array item validators ---
//
// `normalizeParameters` does not descend into arrays, so the items of `nodes`,
// `updates` and `operations` reach a handler spelled however the caller wrote
// them. Each validator normalizes an item's keys once, checks that object and
// returns it for the handler to forward: an item checked in one spelling and
// forwarded raw lets a key spelled both ways run as the value nobody checked.

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

/**
 * The string-valued fields of a batch operation item. The script reads each of
 * them into a typed parameter or a string comparison, so a value of another
 * type raises inside the script and takes every other operation in the batch
 * down with it, with no per-operation result.
 */
const BATCH_ITEM_STRING_FIELDS: readonly string[] = [
  'nodeType',
  'nodeName',
  'parentNodePath',
  'nodePath',
  'texturePath',
  'newPath',
];

/**
 * The fields of a batch operation item that hold a path inside the project,
 * with what the operation does to the file: each scene an operation works on
 * is saved, and a `save` item's `newPath` is the copy it writes; a texture and
 * a scene named as a `nodeType` are only read. `applies` narrows a field that
 * is a path for some values only.
 */
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

/**
 * Resolve every path field of one batch item by the rules a single call
 * applies. Returns the item with each path replaced by its project-relative
 * form, or the refusal naming the item and the field.
 */
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

/**
 * Validate the items of batch_scene_operations `operations`. An item whose
 * `operation` is missing, empty, not a string or not one of the four batch
 * operations is refused before Godot starts, so no other item in the batch runs
 * on a call that is malformed. A missing one names the operation the item's
 * other keys suggest. The script keeps its own hint branch for callers that
 * reach `executeOperation` without this check.
 *
 * Every path an item carries (`BATCH_ITEM_PATH_FIELDS`) goes through
 * `resolveProjectPath` with the intent a single call gives it, so a batch
 * accepts and refuses exactly the paths the single tools do. The value
 * returned is the operations to forward: the same items with camelCase keys
 * and each path in its resolved project-relative form.
 *
 * Keys are normalized before anything is checked: with one key spelled both
 * ways, one spelling would be checked and the other could be the one the
 * script reads, since the runner folds both to the same snake_case key.
 */
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
