import type { ToolResponse } from '../mcp.types.js';
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
 * What `extractGdError` answers when stderr holds no [ERROR] line. It names no
 * tool to read more from: a headless operation keeps no log, and
 * get_debug_output reads a runtime session, never one of these runs.
 */
export const NO_SCRIPT_ERROR_LINE_MESSAGE =
  'the operation gave no reason (it printed no [ERROR] line)';

/** Trailing stderr lines shown when nothing more specific was found in it. */
export const STDERR_TAIL_LINES = 5;

/** The last `count` lines of `stderr` that hold anything, in order. */
export function stderrTailLines(stderr: string, count: number = STDERR_TAIL_LINES): string[] {
  return stderr
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
    .slice(-count);
}

/**
 * Extract the first [ERROR] message from GDScript stderr output. Without one
 * the script gave no reason, and the answer says so and carries the end of
 * the engine's stderr, the only other account of why the run stopped, or
 * states that stderr was empty.
 */
export function extractGdError(stderr: string): string {
  const errLine = stderr.split('\n').find((l) => l.includes('[ERROR]'));
  if (errLine) return errLine.replace(/.*\[ERROR\]\s*/, '').trim();
  const tail = stderrTailLines(stderr);
  return tail.length === 0
    ? `${NO_SCRIPT_ERROR_LINE_MESSAGE}; its stderr was empty`
    : `${NO_SCRIPT_ERROR_LINE_MESSAGE}\nstderr (last lines): ${tail.join('\n')}`;
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
