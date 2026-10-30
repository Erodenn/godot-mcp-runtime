import type { HandlerResult } from '../mcp.types.js';
import { ok } from './result.js';

/** Wraps a structured payload as a handler success satisfying the MCP outputSchema contract: emitted as a JSON text block (lenient clients) and as `structuredContent` (strict clients, spec 2025-06-18); `extraContent` is prepended for non-text blocks like an inline image. */
export function createStructuredResponse<T extends Record<string, unknown>>(
  payload: T,
  extraContent: Array<{ type: string; [k: string]: unknown }> = [],
): HandlerResult {
  return ok({
    content: [...extraContent, { type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  });
}

/** Puts a non-empty `warnings` array first and drops an empty one: GDScript's JSON.stringify sorts keys, so a payload from godot_operations.gd arrives with `warnings` last, and the contract is that it leads. */
export function leadWithWarnings(payload: Record<string, unknown>): Record<string, unknown> {
  const { warnings, ...rest } = payload;
  if (!Array.isArray(warnings)) return payload;
  return warnings.length > 0 ? { warnings, ...rest } : rest;
}
