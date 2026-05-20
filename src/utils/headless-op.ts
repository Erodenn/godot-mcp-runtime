import type { GodotRunner } from './godot-runner.js';
import type { HandlerResult, OperationParams } from '../mcp.types.js';
import { createErrorResponse, extractGdError, getErrorMessage } from './error-response.js';
import { ok, err } from './result.js';

/**
 * Wraps the execute + empty-stdout-check + try/catch around a headless GDScript
 * operation. Used by the 15 scene/node mutation handlers in tools/scene-tools.ts
 * and tools/node-tools.ts to eliminate identical error-handling duplication.
 *
 * Handlers retain control of: parameter normalization, project/scene validation,
 * field validation, and constructing the `params` object — those run before the
 * call. Returns the canonical `Result<ToolSuccessPayload, ToolResponse>` shape;
 * the dispatch edge maps it back to the MCP wire envelope.
 */
export async function executeSceneOp(
  runner: GodotRunner,
  operation: string,
  params: OperationParams,
  projectPath: string,
  failurePrefix: string,
  emptyStdoutSolutions: string[],
  exceptionSolutions: string[] = ['Ensure Godot is installed correctly'],
): Promise<HandlerResult> {
  try {
    const { stdout, stderr } = await runner.executeOperation(operation, params, projectPath);
    if (!stdout.trim()) {
      return err(
        createErrorResponse(`${failurePrefix}: ${extractGdError(stderr)}`, emptyStdoutSolutions),
      );
    }
    return ok({ content: [{ type: 'text', text: stdout }] });
  } catch (error: unknown) {
    return err(
      createErrorResponse(`${failurePrefix}: ${getErrorMessage(error)}`, exceptionSolutions),
    );
  }
}
