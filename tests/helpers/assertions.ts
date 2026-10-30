/** Handlers return `Result<ToolSuccessPayload, ToolResponse>`; these helpers accept either that or a raw ToolResponse. */

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

/** Returns the wire-shaped envelope from a Result-wrapped or raw handler return. */
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

/** Null when the result is not an error envelope or has no text content. */
export function errorText(result: unknown): string | null {
  if (!hasError(result)) return null;
  const envelope = unwrap(result);
  const content = envelope.content;
  if (!Array.isArray(content) || content.length === 0) return null;
  return content[0]?.text ?? null;
}

/** Asserts both the error envelope and its text, so a misrouted error path fails instead of passing on `isError: true` alone. */
export function expectErrorMatching(result: unknown, pattern: RegExp): void {
  expect(hasError(result)).toBe(true);
  const text = errorText(result);
  expect(text).not.toBeNull();
  expect(text as string).toMatch(pattern);
}
