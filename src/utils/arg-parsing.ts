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
import { join } from 'path';
import type { OperationParams, ToolResponse } from '../mcp.types.js';
import { createErrorResponse } from './error-response.js';
import { ok, err, type Result } from './result.js';
import type { NodePath, ProjectPath, ScenePath } from './branded.js';
import {
  validatePath,
  validateSubPath,
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
 * Parse and validate `projectPath` + `scenePath`. When `sceneRequired` is
 * true (default), the scene file must exist on disk. When false, an empty
 * `scenePath` is permitted and `scenePath` is returned as an empty string
 * branded as `ScenePath` for shape parity (the caller knows the scene-not-
 * required path means "no scene to load yet" — e.g. `create_scene`).
 */
export function parseSceneArgs(
  args: OperationParams,
  opts?: { sceneRequired?: boolean },
): Result<{ projectPath: ProjectPath; scenePath: ScenePath }, ToolResponse> {
  const project = parseProjectArgs(args);
  if (!project.ok) return project;

  const sceneRequired = opts?.sceneRequired !== false;
  const raw = args.scenePath;

  if (!raw) {
    if (sceneRequired) {
      return err(
        createErrorResponse('scenePath is required', [
          'Provide the scene file path relative to the project',
        ]),
      );
    }
    return ok({ projectPath: project.value.projectPath, scenePath: '' as ScenePath });
  }
  if (typeof raw !== 'string') {
    return err(
      createErrorResponse('scenePath must be a string', [
        'Provide the scene file path relative to the project',
      ]),
    );
  }
  if (!validateSubPath(project.value.projectPath, raw)) {
    return err(
      createErrorResponse('Invalid scene path', [
        'Provide a valid relative path without ".." that stays inside the project directory',
      ]),
    );
  }
  if (sceneRequired) {
    const sceneFullPath = join(project.value.projectPath, raw);
    if (!existsSync(sceneFullPath)) {
      return err(
        createErrorResponse(`Scene file does not exist: ${raw}`, [
          'Ensure the scene path is correct',
          'Use create_scene to create a new scene first',
        ]),
      );
    }
  }
  return ok({ projectPath: project.value.projectPath, scenePath: raw as ScenePath });
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
