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
import {
  validatePath,
  resolveProjectPath,
  type ResolvedProjectPath,
  validateNodePath as validateNodePathShape,
  projectGodotPath,
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
        'Provide a valid path without ".." or other potentially unsafe characters',
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
 */
export function parseSceneArgs(
  args: OperationParams,
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
        'Provide the scene file path relative to the project',
      ]),
    );
  }
  if (typeof raw !== 'string') {
    return err(
      createErrorResponse('scenePath must be a string', [
        'Provide the scene file path relative to the project',
      ]),
    );
  }
  const scene = resolveProjectPath(project.value.projectPath, raw);
  if (!scene) {
    return err(
      createErrorResponse('Invalid scene path', [
        'Provide a valid relative path without ".." that stays inside the project directory',
      ]),
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
// them: camelCase from the tool schema, or snake_case from a client that
// mirrors the engine's names. Each validator accepts both spellings and refuses
// what the script would otherwise read as a different request (a mistyped key
// defaulting to the scene root) or abort on (a missing key). The error names
// the index, and nothing reaches Godot.

type ItemRecord = Record<string, unknown>;

function asItemRecord(item: unknown): ItemRecord | null {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
  return item as ItemRecord;
}

/** Read a key an item may spell in camelCase or snake_case. */
function itemField(item: ItemRecord, camelKey: string, snakeKey: string): unknown {
  return item[camelKey] !== undefined ? item[camelKey] : item[snakeKey];
}

function itemError(message: string, solution: string): Result<void, ToolResponse> {
  return err(createErrorResponse(message, [solution]));
}

function checkItemNodePath(item: ItemRecord, where: string): Result<void, ToolResponse> {
  const raw = itemField(item, 'nodePath', 'node_path');
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

/** Validate the items of get_node_properties `nodes`: { nodePath, changedOnly? }. */
export function checkNodeReadItems(items: unknown[], field = 'nodes'): Result<void, ToolResponse> {
  for (let i = 0; i < items.length; i++) {
    const where = `${field}[${i}]`;
    const item = asItemRecord(items[i]);
    if (!item) {
      return itemError(`${where} must be an object with a nodePath`, 'Each item is { nodePath }');
    }
    const nodePath = checkItemNodePath(item, where);
    if (!nodePath.ok) return nodePath;
    const changedOnly = itemField(item, 'changedOnly', 'changed_only');
    if (changedOnly !== undefined && typeof changedOnly !== 'boolean') {
      return itemError(
        `${where}.changedOnly must be a boolean when provided`,
        'Provide true or false for changedOnly, or omit it',
      );
    }
  }
  return ok(undefined);
}

/** Validate the items of set_node_properties `updates`: { nodePath, property, value }. */
export function checkUpdateItems(items: unknown[], field = 'updates'): Result<void, ToolResponse> {
  for (let i = 0; i < items.length; i++) {
    const where = `${field}[${i}]`;
    const item = asItemRecord(items[i]);
    if (!item) {
      return itemError(
        `${where} must be an object with nodePath, property and value`,
        'Each update is { nodePath, property, value }',
      );
    }
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
  }
  return ok(undefined);
}

/**
 * The string-valued fields of a batch operation item, in both spellings. The
 * script reads each of them into a typed parameter or a string comparison, so
 * a value of another type raises inside the script and takes every other
 * operation in the batch down with it, with no per-operation result.
 */
const BATCH_ITEM_STRING_FIELDS: ReadonlyArray<readonly [camel: string, snake: string]> = [
  ['nodeType', 'node_type'],
  ['nodeName', 'node_name'],
  ['parentNodePath', 'parent_node_path'],
  ['nodePath', 'node_path'],
  ['texturePath', 'texture_path'],
  ['newPath', 'new_path'],
];

/**
 * Validate the items of batch_scene_operations `operations`. An item with no
 * `operation` key still goes through: the script names the index and hints the
 * intended operation, which is more useful than a generic refusal here.
 */
export function checkBatchOperationItems(
  items: unknown[],
  field = 'operations',
): Result<void, ToolResponse> {
  for (let i = 0; i < items.length; i++) {
    const where = `${field}[${i}]`;
    const item = asItemRecord(items[i]);
    if (!item) {
      return itemError(
        `${where} must be an object`,
        'Each operation is an object with an operation key',
      );
    }
    if (item.operation !== undefined && typeof item.operation !== 'string') {
      return itemError(
        `${where}.operation must be a string`,
        'Use one of: add_node, load_sprite, set_node_properties, save',
      );
    }
    const scenePath = itemField(item, 'scenePath', 'scene_path');
    if (scenePath !== undefined && typeof scenePath !== 'string') {
      return itemError(
        `${where}.scenePath must be a string when provided`,
        'Provide the scene file path relative to the project',
      );
    }
    for (const [camelKey, snakeKey] of BATCH_ITEM_STRING_FIELDS) {
      const value = itemField(item, camelKey, snakeKey);
      if (value !== undefined && typeof value !== 'string') {
        return itemError(
          `${where}.${camelKey} must be a string when provided`,
          `Provide a string for ${camelKey}, or omit it`,
        );
      }
    }
    if (item.properties !== undefined && asItemRecord(item.properties) === null) {
      return itemError(
        `${where}.properties must be an object when provided`,
        'Provide a JSON object of property values, or omit properties',
      );
    }
    const abortOnError = itemField(item, 'abortOnError', 'abort_on_error');
    if (abortOnError !== undefined && typeof abortOnError !== 'boolean') {
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
    }
  }
  return ok(undefined);
}
