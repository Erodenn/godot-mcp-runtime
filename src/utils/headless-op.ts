import type { GodotRunner } from './godot-runner.js';
import type { HandlerResult, OperationParams } from '../mcp.types.js';
import { createErrorResponse, extractGdError, getErrorMessage } from './error-response.js';
import { createStructuredResponse } from './structured-response.js';
import { ok, err } from './result.js';

/**
 * Heuristic: does this non-JSON stdout look like the operation quit(1) before
 * emitting its payload? Canonical shape: a script compile error makes the
 * headless operation exit early, so stdout contains ONLY engine exit noise —
 * RID-leak warnings are the usual content — with no `{` or `[` anywhere. In
 * that case the "invalid JSON" blame is wrong (nothing was ever emitted to
 * parse); the offending stdout and stderr diagnostics are the real diagnosis.
 */
function stdoutLooksLikeEarlyQuitNoise(stdout: string): boolean {
  return !stdout.includes('{') && !stdout.includes('[');
}

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
  options: { parseStdoutAsJson?: boolean } = {},
): Promise<HandlerResult> {
  try {
    const { stdout, stderr } = await runner.executeOperation(operation, params, projectPath);
    if (!stdout.trim()) {
      return err(
        createErrorResponse(`${failurePrefix}: ${extractGdError(stderr)}`, emptyStdoutSolutions),
      );
    }
    if (options.parseStdoutAsJson) {
      let jsonCandidate = stdout.trim();
      if (jsonCandidate.startsWith('ERROR:') || jsonCandidate.startsWith('WARNING:')) {
        // Leading engine noise before the payload — strip to the first JSON
        // opener and retry, so noise-masking doesn't fake an early-quit read.
        const braceIdx = stdout.indexOf('{');
        const bracketIdx = stdout.indexOf('[');
        const first =
          braceIdx === -1
            ? bracketIdx
            : bracketIdx === -1
              ? braceIdx
              : Math.min(braceIdx, bracketIdx);
        if (first !== -1) jsonCandidate = stdout.substring(first).trim();
      }
      try {
        const payload = JSON.parse(jsonCandidate) as Record<string, unknown>;
        return createStructuredResponse(payload);
      } catch (parseErr) {
        if (stdoutLooksLikeEarlyQuitNoise(stdout)) {
          // The operation exited before emitting its JSON payload (early
          // quit on error): stdout contains only engine exit noise. Surface
          // the offending output instead of blaming the operation script's
          // JSON emission. stderr carries the actual failure (compile
          // errors print to stderr in Godot's canonical format).
          const parts = [
            `${failurePrefix}: no JSON payload was emitted - the operation likely exited early on an error.`,
          ];
          const errLines = stderr
            .split('\n')
            .filter((l) => /^(ERROR|SCRIPT ERROR|USER SCRIPT ERROR):/.test(l.trim()));
          if (errLines.length > 0) parts.push(`stderr: ${errLines.slice(0, 5).join('\n')}`);
          const cleanedStdout = stdout.trim().split('\n').slice(-10).join('\n');
          if (cleanedStdout) parts.push(`stdout (last lines): ${cleanedStdout}`);
          return err(
            createErrorResponse(parts.join('\n'), [
              'Check the surfaced stdout/stderr above - this is the operation failing before it could emit its JSON payload, not a JSON formatting bug',
              'Check get_debug_output for the raw output',
            ]),
          );
        }
        return err(
          createErrorResponse(
            `${failurePrefix}: GDScript returned invalid JSON (${getErrorMessage(parseErr)})`,
            [
              'This indicates a bug in godot_operations.gd — the operation should emit a JSON payload matching its outputSchema',
              'Check get_debug_output for the raw stdout and stderr',
            ],
          ),
        );
      }
    }
    return ok({ content: [{ type: 'text', text: stdout }] });
  } catch (error: unknown) {
    return err(
      createErrorResponse(`${failurePrefix}: ${getErrorMessage(error)}`, exceptionSolutions),
    );
  }
}
