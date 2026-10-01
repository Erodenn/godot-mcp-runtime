import type { HandlerResult } from '../mcp.types.js';
import { ok } from './result.js';

/**
 * Wrap a structured payload as a handler success that satisfies the MCP
 * outputSchema contract. The same payload is emitted both as a JSON text
 * content block (for lenient clients) and as `structuredContent` (required
 * by strict clients per MCP spec revision 2025-06-18).
 *
 * `extraContent` is prepended for handlers that also return non-text blocks
 * (e.g. `take_screenshot`'s inline image).
 */
export function createStructuredResponse<T extends Record<string, unknown>>(
  payload: T,
  extraContent: Array<{ type: string; [k: string]: unknown }> = [],
): HandlerResult {
  return ok({
    content: [...extraContent, { type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  });
}

/**
 * Put a non-empty `warnings` array first and drop an empty one. GDScript's
 * JSON.stringify sorts keys, so a payload that crossed from
 * godot_operations.gd arrives with `warnings` last; the contract is that it
 * leads the payload whenever it is present.
 */
export function leadWithWarnings(payload: Record<string, unknown>): Record<string, unknown> {
  const { warnings, ...rest } = payload;
  if (!Array.isArray(warnings)) return payload;
  return warnings.length > 0 ? { warnings, ...rest } : rest;
}
