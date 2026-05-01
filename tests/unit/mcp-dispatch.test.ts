import { describe, it, expect } from 'vitest';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import { allToolDefinitions, serverInstructions } from '../../src/index.js';
import { toolDispatch, dispatchToolCall } from '../../src/dispatch.js';
import type { GodotRunner } from '../../src/utils/godot-runner.js';

// Minimal stub runner — parity tests never invoke handlers,
// and the unknown-tool test throws before reaching any handler.
const stubRunner = {} as GodotRunner;

// ---------------------------------------------------------------------------
// 1. Tool ↔ handler parity
// ---------------------------------------------------------------------------

describe('tool definition ↔ dispatch parity', () => {
  const definedNames = allToolDefinitions.map((t) => t.name);
  const dispatchedNames = Object.keys(toolDispatch);

  it.each(definedNames)('allToolDefinitions entry "%s" has a handler in toolDispatch', (name) => {
    expect(toolDispatch).toHaveProperty(name);
  });

  it.each(dispatchedNames)(
    'toolDispatch key "%s" has a matching entry in allToolDefinitions',
    (name) => {
      expect(definedNames).toContain(name);
    },
  );
});

// ---------------------------------------------------------------------------
// 2. Unknown tool
// ---------------------------------------------------------------------------

describe('unknown tool dispatch', () => {
  it('rejects with McpError(MethodNotFound) for an unregistered tool name', async () => {
    await expect(dispatchToolCall(stubRunner, 'no_such_tool', {})).rejects.toThrow(McpError);
  });

  it('error code is MethodNotFound', async () => {
    try {
      await dispatchToolCall(stubRunner, 'no_such_tool', {});
      expect.fail('expected dispatchToolCall to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).code).toBe(ErrorCode.MethodNotFound);
    }
  });

  it('error message contains the offending tool name', async () => {
    try {
      await dispatchToolCall(stubRunner, 'no_such_tool', {});
      expect.fail('expected dispatchToolCall to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).message).toContain('no_such_tool');
    }
  });
});

// ---------------------------------------------------------------------------
// 3. serverInstructions category coverage
//
// For each category named in the docstring, assert that at least one
// representative tool mentioned in that section also exists in toolDispatch.
// This catches silent docstring rot — a category line removed from instructions
// while the tools still live in the dispatch table.
// ---------------------------------------------------------------------------

describe('serverInstructions category coverage', () => {
  // Each tuple: [category label as it appears in instructions, representative tool]
  const categories: [string, string][] = [
    ['Project management', 'launch_editor'],
    ['Scene editing', 'create_scene'],
    ['Node editing', 'delete_node'],
    ['Runtime', 'take_screenshot'],
    ['Project config', 'list_autoloads'],
    ['Validation', 'validate'],
    ['UIDs', 'manage_uids'],
  ];

  it.each(categories)(
    'instructions mentions "%s" category and representative tool exists in dispatch',
    (category, representativeTool) => {
      expect(serverInstructions).toContain(category);
      expect(toolDispatch).toHaveProperty(representativeTool);
    },
  );
});
