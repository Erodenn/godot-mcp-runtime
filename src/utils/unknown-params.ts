import type { OperationParams, ToolDefinition, ToolResponse } from '../mcp.types.js';
import { createErrorResponse } from './error-response.js';

/** Edit distance at or under which an unknown key is offered the declared key it most resembles (`patern` -> `pattern`). */
const MAX_SUGGESTION_DISTANCE = 2;

/** The top-level parameter names a tool declares: the one list a refusal names, so it cannot drift from the schema an agent was given. */
export function declaredParameters(definition: Pick<ToolDefinition, 'inputSchema'>): string[] {
  return Object.keys(definition.inputSchema.properties);
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min(substitution, (previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** The declared key a wrong key was most likely meant to be: a tool's own `aliases` first, then a case-insensitive match, then the nearest within `MAX_SUGGESTION_DISTANCE`. */
function suggestParameter(
  unknown: string,
  allowed: readonly string[],
  aliases: Readonly<Record<string, string>>,
): string | undefined {
  const aliased = Object.hasOwn(aliases, unknown.toLowerCase())
    ? aliases[unknown.toLowerCase()]
    : undefined;
  if (aliased !== undefined && allowed.includes(aliased)) return aliased;
  const folded = unknown.toLowerCase().replace(/[_-]/g, '');
  const sameLetters = allowed.find((key) => key.toLowerCase() === folded);
  if (sameLetters !== undefined) return sameLetters;
  let best: { key: string; distance: number } | undefined;
  for (const key of allowed) {
    const distance = editDistance(folded, key.toLowerCase());
    if (distance <= MAX_SUGGESTION_DISTANCE && (best === undefined || distance < best.distance)) {
      best = { key, distance };
    }
  }
  return best?.key;
}

export interface UnknownParameterOptions {
  /** Wrong names agents are known to reach for, lower-case, to the declared name that was meant. */
  aliases?: Readonly<Record<string, string>>;
}

/**
 * An error response when `args` (already through `normalizeParameters`) holds a top-level key the tool does not declare, naming the declared keys and, when one is recognisable, the key that was meant; null when every key is declared.
 * Call it from a handler with `declaredParameters(definition)`; a tool that forwards free-form keys does not call it.
 */
export function unknownParameterError(
  args: OperationParams,
  allowed: readonly string[],
  options: UnknownParameterOptions = {},
): (ToolResponse & { isError: true }) | null {
  const unknown = Object.keys(args).find((key) => !allowed.includes(key));
  if (unknown === undefined) return null;
  const meant = suggestParameter(unknown, allowed, options.aliases ?? {});
  const hint = meant === undefined ? '' : `; did you mean "${meant}"?`;
  return createErrorResponse(
    `Unknown parameter "${unknown}" (allowed: ${allowed.join(', ')})${hint}`,
    [
      meant === undefined
        ? `Check the spelling of "${unknown}": an unknown parameter is refused instead of ignored`
        : `Pass the value as "${meant}" instead of "${unknown}"`,
    ],
  );
}
