import { describe, expect, it } from 'vitest';
import { LAUNCH_TARGET_ENV_VAR } from '../helpers/private-desktop.js';

// Proves the globalSetup substitution reached this worker. Passes in both modes:
// with the launcher on, GODOT_PATH is the launcher and the target is the real
// Godot; with it off (non-Windows, opt-out, no compiler, no GODOT_PATH), the
// target variable is unset and nothing is asserted about GODOT_PATH.
describe('private desktop substitution', () => {
  it('points GODOT_PATH at something other than the launch target when a target is set', () => {
    const target = process.env[LAUNCH_TARGET_ENV_VAR];
    if (!target) return;
    expect(process.env.GODOT_PATH).toBeTruthy();
    expect(process.env.GODOT_PATH).not.toBe(target);
  });
});
