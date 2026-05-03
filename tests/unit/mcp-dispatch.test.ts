import { describe, it, expect } from 'vitest';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import { allToolDefinitions, serverInstructions } from '../../src/index.js';
import { toolDispatch, dispatchToolCall } from '../../src/dispatch.js';
import type { GodotRunner } from '../../src/utils/godot-runner.js';

// Dummy runner — never invoked. Parity tests don't call handlers, and the
// unknown-tool dispatch path throws before reaching any handler.
const dummyRunner = {} as GodotRunner;

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
  it('rejects with McpError(MethodNotFound) naming the offending tool', async () => {
    await expect(dispatchToolCall(dummyRunner, 'no_such_tool', {})).rejects.toMatchObject({
      code: ErrorCode.MethodNotFound,
      message: expect.stringContaining('no_such_tool'),
    });
  });

  it('throws an instance of McpError', async () => {
    await expect(dispatchToolCall(dummyRunner, 'no_such_tool', {})).rejects.toBeInstanceOf(
      McpError,
    );
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
    ['Node editing', 'delete_nodes'],
    ['Runtime', 'take_screenshot'],
    ['Project config', 'list_autoloads'],
    ['Validation', 'validate'],
  ];

  it.each(categories)(
    'instructions mentions "%s" category and representative tool exists in dispatch',
    (category, representativeTool) => {
      expect(serverInstructions).toContain(category);
      expect(toolDispatch).toHaveProperty(representativeTool);
    },
  );
});
