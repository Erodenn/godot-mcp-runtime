import { describe, it, expect } from 'vitest';
import { runtimeToolDefinitions } from '../../src/tools/runtime-tools.js';
import { renderToolDefinitions } from '../../src/tools/render-tools.js';
import { autoloadToolDefinitions } from '../../src/tools/autoload-tools.js';
import { projectToolDefinitions } from '../../src/tools/project-tools.js';
import { sceneToolDefinitions } from '../../src/tools/scene-tools.js';
import { nodeToolDefinitions } from '../../src/tools/node-tools.js';
import { profilerToolDefinitions } from '../../src/tools/profiler-tools.js';
import { validateToolDefinitions } from '../../src/tools/validate-tools.js';
import type { ToolDefinition } from '../../src/mcp.types.js';
import { normalizeParameters } from '../../src/utils/parameter-conversion.js';

const allDefinitions: ToolDefinition[] = [
  ...runtimeToolDefinitions,
  ...renderToolDefinitions,
  ...autoloadToolDefinitions,
  ...projectToolDefinitions,
  ...sceneToolDefinitions,
  ...nodeToolDefinitions,
  ...profilerToolDefinitions,
  ...validateToolDefinitions,
];

describe('tool definitions: per-tool shape contract', () => {
  it.each(allDefinitions.map((t) => [t.name, t] as [string, ToolDefinition]))(
    '%s has a non-empty name',
    (name) => {
      expect(typeof name).toBe('string');
      expect(name.length).toBeGreaterThan(0);
    },
  );

  it.each(allDefinitions.map((t) => [t.name, t] as [string, ToolDefinition]))(
    '%s has a non-empty description',
    (_name, tool) => {
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
    },
  );

  it.each(allDefinitions.map((t) => [t.name, t] as [string, ToolDefinition]))(
    '%s inputSchema.type is "object"',
    (_name, tool) => {
      expect(tool.inputSchema.type).toBe('object');
    },
  );

  it.each(allDefinitions.map((t) => [t.name, t] as [string, ToolDefinition]))(
    '%s inputSchema.properties is a non-null object',
    (_name, tool) => {
      expect(tool.inputSchema.properties).not.toBeNull();
      expect(typeof tool.inputSchema.properties).toBe('object');
    },
  );

  it.each(allDefinitions.map((t) => [t.name, t] as [string, ToolDefinition]))(
    '%s inputSchema.required is an array of strings',
    (_name, tool) => {
      expect(Array.isArray(tool.inputSchema.required)).toBe(true);
      for (const entry of tool.inputSchema.required) {
        expect(typeof entry).toBe('string');
      }
    },
  );

  it.each(allDefinitions.map((t) => [t.name, t] as [string, ToolDefinition]))(
    '%s every required key exists in properties',
    (_name, tool) => {
      for (const key of tool.inputSchema.required) {
        expect(tool.inputSchema.properties).toHaveProperty(key);
      }
    },
  );
});

describe('tool definitions: no duplicate names', () => {
  it('all tool names are unique across all definition arrays', () => {
    const names = allDefinitions.map((t) => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });
});

describe('tool definitions: every tool declares an outputSchema', () => {
  it.each(allDefinitions.map((t) => [t.name, t] as [string, ToolDefinition]))(
    '%s declares an object outputSchema',
    (_name, tool) => {
      expect(tool.outputSchema).toBeDefined();
      expect(tool.outputSchema?.type).toBe('object');
    },
  );
});

/** Hard cap on a tool description, in characters: it ships on every handshake. */
const DESCRIPTION_MAX_CHARS = 500;

describe('tool definitions: description budget', () => {
  const cases = allDefinitions.map((t) => [t.name, t] as [string, ToolDefinition]);

  it.each(cases)(`%s description is at most ${DESCRIPTION_MAX_CHARS} characters`, (_name, tool) => {
    expect(tool.description.length).toBeLessThanOrEqual(DESCRIPTION_MAX_CHARS);
  });

  it.each(cases)(
    '%s description does not promise that stop_project clears an edit refusal',
    (_name, tool) => {
      // Only true when the blocking session is the current one.
      expect(tool.description).not.toMatch(/stop_project clears/);
    },
  );

  it.each(cases)('%s description has no em-dash or en-dash', (_name, tool) => {
    expect(tool.description).not.toMatch(/[\u2013\u2014]/);
  });
});

describe('tool definitions: snake_case spellings', () => {
  /** Collect every property name an input schema declares, at any nesting depth. */
  function collectPropertyNames(schema: unknown, names: Set<string>): void {
    if (typeof schema !== 'object' || schema === null) return;
    const node = schema as { properties?: Record<string, unknown>; items?: unknown };
    for (const [name, child] of Object.entries(node.properties ?? {})) {
      names.add(name);
      collectPropertyNames(child, names);
    }
    collectPropertyNames(node.items, names);
  }

  it('every camelCase input property has a snake_case mapping', () => {
    const names = new Set<string>();
    for (const tool of allDefinitions) collectPropertyNames(tool.inputSchema, names);
    const unmapped = [...names]
      .filter((name) => /[A-Z]/.test(name))
      .filter((name) => {
        const snake = name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
        return !(name in normalizeParameters({ [snake]: 1 }));
      });
    expect(unmapped).toEqual([]);
  });
});

describe('simulate_input actions property description', () => {
  const actions = (
    runtimeToolDefinitions.find((t) => t.name === 'simulate_input')!.inputSchema
      .properties as Record<string, { description: string }>
  ).actions.description;

  it('names the action cap and the reduced tail entries', () => {
    expect(actions).toMatch(/at most 5900 actions/);
    expect(actions).toMatch(/details_dropped/);
  });

  it(`stays within ${DESCRIPTION_MAX_CHARS} characters`, () => {
    expect(actions.length).toBeLessThanOrEqual(DESCRIPTION_MAX_CHARS);
  });
});
