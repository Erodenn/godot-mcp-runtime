import type { ToolResponse } from '../mcp.types.js';
import { logError } from './logger.js';

/** `error.message` for an `Error`, else 'Unknown error'. */
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

/** What `extractGdError` answers when stderr has no [ERROR] line; it names no tool to read more from, since a headless operation keeps no log and get_debug_output reads runtime sessions only. */
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

/** The first [ERROR] message from GDScript stderr; without one it says the script gave no reason and carries the end of stderr (the only other account of why the run stopped), or that stderr was empty. */
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
