import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import { allToolDefinitions } from '../../src/index.js';
import type { ToolDefinition } from '../../src/mcp.types.js';

const ajv = new Ajv({ strict: false });

const toolsWithOutputSchema: Array<[string, ToolDefinition]> = allToolDefinitions
  .filter(
    (t): t is ToolDefinition & { outputSchema: NonNullable<ToolDefinition['outputSchema']> } =>
      Boolean(t.outputSchema),
  )
  .map((t) => [t.name, t] as [string, ToolDefinition]);

describe('outputSchema — every declared schema is valid', () => {
  it.each(toolsWithOutputSchema)('%s outputSchema compiles under ajv', (_name, tool) => {
    const compile = () => ajv.compile(tool.outputSchema as object);
    expect(compile).not.toThrow();
  });

  it.each(toolsWithOutputSchema)('%s outputSchema.type is "object"', (_name, tool) => {
    expect(tool.outputSchema!.type).toBe('object');
  });
});

describe('outputSchema and Returns: prose are complementary, not exclusive', () => {
  // Per docs/tool-authoring.md §3, when a tool has an outputSchema it must also
  // carry a Returns: sentence in its description — the schema is invisible to
  // the agent, so the prose is the only return-shape signal the LLM ever sees.
  it.each(toolsWithOutputSchema)(
    '%s description has a Returns: sentence alongside its outputSchema',
    (_name, tool) => {
      expect(tool.description).toMatch(/\bReturns:/);
    },
  );
});

describe('outputSchema — expected coverage', () => {
  it('at least 15 tools have an outputSchema (14 added + create_scene)', () => {
    expect(toolsWithOutputSchema.length).toBeGreaterThanOrEqual(15);
  });
});
