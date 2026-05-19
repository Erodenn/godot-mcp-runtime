import type { GodotRunner } from './godot-runner.js';
import type { OperationParams, ToolResponse } from '../mcp.types.js';
import { createErrorResponse, extractGdError, getErrorMessage } from './error-response.js';

/**
 * Wraps the execute + empty-stdout-check + try/catch around a headless GDScript
 * operation. Used by the 15 scene/node mutation handlers in tools/scene-tools.ts
 * and tools/node-tools.ts to eliminate identical error-handling duplication.
 *
 * Handlers retain control of: parameter normalization, project/scene validation,
 * field validation, and constructing the `params` object — those run before the
 * call. Success-shape construction (the JSON wrapping the GDScript stdout) is
 * also unchanged: this helper just returns `{ content: [{ type: 'text', text: stdout }] }`,
 * which is the exact shape every handler produced previously.
 */
export async function executeSceneOp(
  runner: GodotRunner,
  operation: string,
  params: OperationParams,
  projectPath: string,
  failurePrefix: string,
  emptyStdoutSolutions: string[],
  exceptionSolutions: string[] = ['Ensure Godot is installed correctly'],
): Promise<ToolResponse> {
  try {
    const { stdout, stderr } = await runner.executeOperation(operation, params, projectPath);
    if (!stdout.trim()) {
      return createErrorResponse(
        `${failurePrefix}: ${extractGdError(stderr)}`,
        emptyStdoutSolutions,
      );
    }
    return { content: [{ type: 'text', text: stdout }] };
  } catch (error: unknown) {
    return createErrorResponse(`${failurePrefix}: ${getErrorMessage(error)}`, exceptionSolutions);
  }
}
