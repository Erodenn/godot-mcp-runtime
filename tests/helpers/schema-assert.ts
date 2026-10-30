/** Every tool returns one JSON object as `structuredContent`, repeated as JSON in a text block; this checks the success, the schema and that both carry the same payload. */

import Ajv from 'ajv';
import { expect } from 'vitest';
import { allToolDefinitions } from '../../src/index.js';
import { hasError, unwrap } from './assertions.js';

const ajv = new Ajv({ strict: false });

export function expectMatchesOutputSchema(
  toolName: string,
  result: unknown,
): Record<string, unknown> {
  const definition = allToolDefinitions.find((tool) => tool.name === toolName);
  if (!definition) throw new Error(`No tool definition named ${toolName}`);
  const schema = (definition as { outputSchema?: object }).outputSchema;
  if (!schema) throw new Error(`${toolName} declares no outputSchema`);

  const envelope = unwrap(result);
  expect(hasError(result), JSON.stringify(envelope.content)).toBe(false);
  const payload = envelope.structuredContent as Record<string, unknown> | undefined;
  expect(payload, `${toolName} returned no structuredContent`).toBeDefined();
  expect(Array.isArray(payload)).toBe(false);

  const validate = ajv.compile(schema);
  expect(validate(payload), JSON.stringify(validate.errors)).toBe(true);

  const text = envelope.content.find((entry) => entry.type === 'text')?.text;
  expect(JSON.parse(text ?? 'null')).toEqual(payload);
  return payload as Record<string, unknown>;
}
