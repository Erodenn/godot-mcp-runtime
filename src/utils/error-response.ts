import { existsSync } from 'fs';
import { join } from 'path';
import type { OperationParams, ToolResponse } from '../mcp.types.js';
import { validatePath, validateSubPath, projectGodotPath } from './path-validation.js';
import { logError } from './logger.js';

/**
 * Return `error.message` when `error` is an `Error`, otherwise `'Unknown error'`.
 * Centralizes the catch-block boilerplate so handlers can build error responses
 * without repeating the `instanceof Error` ternary.
 */
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

/**
 * Extract the first [ERROR] message from GDScript stderr output.
 * Falls back to a generic message if no [ERROR] line is found.
 */
export function extractGdError(stderr: string): string {
  const errLine = stderr.split('\n').find((l) => l.includes('[ERROR]'));
  return errLine
    ? errLine.replace(/.*\[ERROR\]\s*/, '').trim()
    : 'see get_debug_output for details';
}

export function createErrorResponse(
  message: string,
  possibleSolutions: string[] = [],
): ToolResponse & { isError: true } {
  logError(`Error response: ${message}`);
  if (possibleSolutions.length > 0) {
    logError(`Possible solutions: ${possibleSolutions.join(', ')}`);
  }

  const response: {
    content: Array<{ type: 'text'; text: string }>;
    isError: true;
  } = {
    content: [{ type: 'text', text: message }],
    isError: true,
  };

  if (possibleSolutions.length > 0) {
    response.content.push({
      type: 'text',
      text: 'Possible solutions:\n- ' + possibleSolutions.join('\n- '),
    });
  }

  return response;
}

// --- Shared validation helpers ---

export interface ValidatedProjectArgs {
  projectPath: string;
}

export interface ValidatedSceneArgs {
  projectPath: string;
  scenePath: string;
}

// Strict subtype of ToolResponse with isError required, so callers can narrow
// validator returns via `'isError' in v`. ToolResponse itself declares
// `isError?: boolean` plus a `[k: string]: unknown` index signature, which
// would collapse `v.projectPath` to `unknown` after narrowing.
type ValidationErrorResult = ToolResponse & { isError: true };

export function validateProjectArgs(
  args: OperationParams,
): ValidatedProjectArgs | ValidationErrorResult {
  if (!args.projectPath) {
    return createErrorResponse('projectPath is required', [
      'Provide a valid path to a Godot project directory',
    ]);
  }

  if (!validatePath(args.projectPath as string)) {
    return createErrorResponse('Invalid project path', [
      'Provide a valid path without ".." or other potentially unsafe characters',
    ]);
  }

  const projectFile = projectGodotPath(args.projectPath as string);
  if (!existsSync(projectFile)) {
    return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`, [
      'Ensure the path points to a directory containing a project.godot file',
    ]);
  }

  return { projectPath: args.projectPath as string };
}

export function validateSceneArgs(
  args: OperationParams,
  opts?: { sceneRequired?: boolean },
): ValidatedSceneArgs | ValidationErrorResult {
  const projectResult = validateProjectArgs(args);
  if ('isError' in projectResult) return projectResult;

  const sceneRequired = opts?.sceneRequired !== false;

  if (!args.scenePath) {
    if (sceneRequired) {
      return createErrorResponse('scenePath is required', [
        'Provide the scene file path relative to the project',
      ]);
    }
    return { projectPath: projectResult.projectPath, scenePath: '' };
  }

  if (!validateSubPath(projectResult.projectPath, args.scenePath as string)) {
    return createErrorResponse('Invalid scene path', [
      'Provide a valid relative path without ".." that stays inside the project directory',
    ]);
  }

  if (sceneRequired) {
    const sceneFullPath = join(projectResult.projectPath, args.scenePath as string);
    if (!existsSync(sceneFullPath)) {
      return createErrorResponse(`Scene file does not exist: ${args.scenePath}`, [
        'Ensure the scene path is correct',
        'Use create_scene to create a new scene first',
      ]);
    }
  }

  return { projectPath: projectResult.projectPath, scenePath: args.scenePath as string };
}
