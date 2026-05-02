/**
 * Shared assertion helpers for handler tests.
 *
 * Handlers return either a normal MCP response (`{ content: [...] }`) or an
 * error envelope (`{ content: [...], isError: true }`). `hasError` is the
 * canonical predicate — prefer it over inlining the shape check.
 */

import { expect } from 'vitest';

export function hasError(result: unknown): boolean {
  return typeof result === 'object' && result !== null && 'isError' in result;
}

/**
 * Extract the rendered error text from a handler error response.
 * Returns `null` if the result is not an error envelope or has no text content.
 */
export function errorText(result: unknown): string | null {
  if (!hasError(result)) return null;
  const content = (result as { content?: Array<{ text?: string }> }).content;
  if (!Array.isArray(content) || content.length === 0) return null;
  return content[0]?.text ?? null;
}

/**
 * Assert the handler returned an error envelope AND its rendered text matches
 * `pattern`. Use this in rejection tests so distinct branches stay
 * distinguishable — a refactor that misroutes an error path will fail loudly
 * instead of silently passing because both branches end in `isError: true`.
 */
export function expectErrorMatching(result: unknown, pattern: RegExp): void {
  expect(hasError(result)).toBe(true);
  const text = errorText(result);
  expect(text).not.toBeNull();
  expect(text as string).toMatch(pattern);
}
