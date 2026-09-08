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
  // Exact allowlist so adding/removing a tool from the structuredContent
  // contract is a deliberate one-line edit, not a silent drift. Update this
  // list whenever a tool grows or loses an outputSchema.
  const TOOLS_WITH_OUTPUT_SCHEMA: readonly string[] = [
    'attach_script',
    'batch_scene_operations',
    'create_scene',
    'delete_nodes',
    'detach_project',
    'duplicate_node',
    'get_debug_output',
    'get_node_signals',
    'get_scene_dependencies',
    'get_ui_elements',
    'profile_project',
    'run_script',
    'search_project',
    'start_profiler',
    'set_node_properties',
    'simulate_input',
    'stop_profiler',
    'stop_project',
    'take_screenshot',
  ];

  it('every tool with outputSchema is on the explicit allowlist', () => {
    expect(toolsWithOutputSchema.map(([name]) => name).sort()).toEqual(
      [...TOOLS_WITH_OUTPUT_SCHEMA].sort(),
    );
  });
});
