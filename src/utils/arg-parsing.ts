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

import type { OperationParams, ToolResponse } from '../mcp.types.js';
import { createErrorResponse } from './error-response.js';
import { ok, err, type Result } from './result.js';

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
  for (const v of value) {
    if (typeof v !== 'string') {
      return err(
        createErrorResponse(`${key} entries must all be strings`, [
          `Ensure every entry in ${key} is a string`,
        ]),
      );
    }
  }
  return ok(value as string[]);
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
  for (const v of value) {
    if (typeof v !== 'string') {
      return err(
        createErrorResponse(`${key} entries must all be strings`, [
          `Ensure every entry in ${key} is a string`,
        ]),
      );
    }
  }
  return ok(value as string[]);
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
