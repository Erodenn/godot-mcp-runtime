import { describe, it, expect } from 'vitest';
import { isServerOwnedBridgePath } from '../../src/utils/artifact-paths.js';

describe('isServerOwnedBridgePath', () => {
  it('accepts the legacy root script with a lowercase res:// scheme', () => {
    expect(isServerOwnedBridgePath('res://mcp_bridge.gd')).toBe(true);
  });

  it('accepts anything under .mcp/', () => {
    expect(isServerOwnedBridgePath('res://.mcp/godot-runtime/bridge/mcp_bridge.gd')).toBe(true);
  });

  it('accepts an uppercase RES:// scheme', () => {
    expect(isServerOwnedBridgePath('RES://.mcp/godot-runtime/bridge/mcp_bridge.gd')).toBe(true);
  });

  it('accepts a mixed-case scheme on the legacy root script', () => {
    expect(isServerOwnedBridgePath('Res://mcp_bridge.gd')).toBe(true);
  });

  it('still rejects a path with .mcp below the root', () => {
    expect(isServerOwnedBridgePath('res://addons/.mcp/mcp_bridge.gd')).toBe(false);
  });

  it('still rejects a uid:// form', () => {
    expect(isServerOwnedBridgePath('uid://abc123')).toBe(false);
  });

  it('still rejects a user script sharing the name outside .mcp/', () => {
    expect(isServerOwnedBridgePath('res://game/my_own_bridge.gd')).toBe(false);
  });
});
