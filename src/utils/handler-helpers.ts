import type { GodotRunner } from './godot-runner.js';
import type { OperationParams, ToolResponse } from '../mcp.types.js';
import { createErrorResponse, extractGdError, getErrorMessage } from './error-response.js';

export const MAX_RUNTIME_ERROR_CONTEXT_LINES = 30;

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

export type ParseResult<T> = { ok: true; data: T } | { ok: false; response: ToolResponse };

/**
 * Parse a JSON frame returned by the McpBridge. On failure, returns a
 * structured error response so handlers can short-circuit with one branch.
 * `context` should describe which bridge command produced the frame.
 */
export function parseBridgeJson<T = unknown>(responseStr: string, context: string): ParseResult<T> {
  try {
    return { ok: true, data: JSON.parse(responseStr) as T };
  } catch (error) {
    return {
      ok: false,
      response: createErrorResponse(
        `Invalid response from bridge (${context}): ${getErrorMessage(error)}`,
        [
          'The bridge returned non-JSON data — check Godot stderr via get_debug_output',
          'Restart the project with stop_project followed by run_project',
        ],
      ),
    };
  }
}

/**
 * Attach captured runtime errors as a `warnings` array on a tool response
 * payload. No-op when there are no runtime errors. Truncates to
 * `MAX_RUNTIME_ERROR_CONTEXT_LINES` to keep payloads bounded.
 */
export function attachRuntimeWarnings(
  target: Record<string, unknown>,
  runtimeErrors: string[],
): void {
  if (runtimeErrors.length > 0) {
    target.warnings = runtimeErrors.slice(0, MAX_RUNTIME_ERROR_CONTEXT_LINES);
  }
}
