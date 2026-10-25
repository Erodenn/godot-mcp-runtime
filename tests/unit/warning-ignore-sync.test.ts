// KEEP IN SYNC: the @warning_ignore_start lists that open mcp_bridge.gd and godot_operations.gd.
// An unknown warning name is a parse error, so the list holds only names Godot 4.5, the floor, knows.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

function readScript(name: string): string {
  return readFileSync(new URL(`../../src/scripts/${name}`, import.meta.url), 'utf8');
}

function ignoredWarnings(source: string, name: string): string[] {
  const match = source.match(/^@warning_ignore_start\(([\s\S]*?)\)/m);
  expect(match, `${name} must open with @warning_ignore_start(...)`).not.toBeNull();
  return [...match![1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
}

const bridge = ignoredWarnings(readScript('mcp_bridge.gd'), 'mcp_bridge.gd');
const operations = ignoredWarnings(readScript('godot_operations.gd'), 'godot_operations.gd');

describe('the @warning_ignore_start lists in the GDScript files', () => {
  it('are identical in mcp_bridge.gd and godot_operations.gd', () => {
    expect(operations).toEqual(bridge);
  });

  it('cover untyped_declaration, the setting strict typing raises', () => {
    expect(bridge).toContain('untyped_declaration');
  });

  it('list no name twice', () => {
    expect(new Set(bridge).size).toBe(bridge.length);
  });

  it('leave out the warnings Godot added after 4.5, which 4.5 would reject', () => {
    expect(bridge).not.toContain('missing_await');
    expect(bridge).not.toContain('confusable_temporary_modification');
  });
});
