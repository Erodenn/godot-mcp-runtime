import { describe, it, expect } from 'vitest';
import { runtimeToolDefinitions } from '../../src/tools/runtime-tools.js';
import { autoloadToolDefinitions } from '../../src/tools/autoload-tools.js';
import { projectToolDefinitions } from '../../src/tools/project-tools.js';
import { sceneToolDefinitions } from '../../src/tools/scene-tools.js';
import { nodeToolDefinitions } from '../../src/tools/node-tools.js';
import { validateToolDefinitions } from '../../src/tools/validate-tools.js';
import type { ToolDefinition } from '../../src/utils/godot-runner.js';

const allDefinitions: ToolDefinition[] = [
  ...runtimeToolDefinitions,
  ...autoloadToolDefinitions,
  ...projectToolDefinitions,
  ...sceneToolDefinitions,
  ...nodeToolDefinitions,
  ...validateToolDefinitions,
];

describe('tool definitions — per-tool shape contract', () => {
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

describe('tool definitions — no duplicate names', () => {
  it('all tool names are unique across all definition arrays', () => {
    const names = allDefinitions.map((t) => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });
});
