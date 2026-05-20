/**
 * Shared assertion helpers for handler tests.
 *
 * After Phase 3 commit 4, handlers return `Result<ToolSuccessPayload, ToolResponse>`
 * instead of `ToolResponse` directly — the dispatch edge in `src/dispatch.ts`
 * maps the Result back to the MCP wire envelope. These helpers accept either
 * shape so tests written before or after the flip stay readable.
 *
 * `hasError` is the canonical predicate. `unwrap` returns the underlying
 * envelope (the success `value` or the error `error`) so test code that needs
 * to inspect `content[i].text` directly can do so without knowing whether the
 * handler returned a Result or a raw response.
 */

import { expect } from 'vitest';

interface ContentEntry {
  type: string;
  text?: string;
  [k: string]: unknown;
}

interface EnvelopeShape {
  content: ContentEntry[];
  isError?: boolean;
  [k: string]: unknown;
}

function isResult(value: unknown): value is { ok: boolean; value?: unknown; error?: unknown } {
  return typeof value === 'object' && value !== null && 'ok' in (value as Record<string, unknown>);
}

/**
 * Return the wire-shaped envelope from either a Result-wrapped handler return
 * or a raw `ToolResponse`. Use in tests that need to read `content[i].text`
 * directly — `unwrap(result).content[0].text` works regardless of which side
 * of the Phase-3 boundary the handler under test is on.
 */
export function unwrap(result: unknown): EnvelopeShape {
  if (isResult(result)) {
    return (result.ok ? result.value : result.error) as EnvelopeShape;
  }
  return result as EnvelopeShape;
}

export function hasError(result: unknown): boolean {
  if (isResult(result)) {
    return !result.ok;
  }
  return typeof result === 'object' && result !== null && 'isError' in result;
}

/**
 * Extract the rendered error text from a handler error response.
 * Returns `null` if the result is not an error envelope or has no text content.
 */
export function errorText(result: unknown): string | null {
  if (!hasError(result)) return null;
  const envelope = unwrap(result);
  const content = envelope.content;
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
