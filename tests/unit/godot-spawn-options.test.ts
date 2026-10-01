/**
 * The options every Godot spawn is started with.
 *
 * What they are for (keeping a Windows Godot from writing onto the parent
 * terminal) cannot be observed from a test, so these cases pin only the
 * options themselves: which kind hides its console window, which kinds must
 * never ask for a hidden window, and that all of them keep piped stdio.
 */

import { describe, it, expect } from 'vitest';
import { godotSpawnOptions, type GodotSpawnKind } from '../../src/utils/godot-spawn-options.js';

const ALL_KINDS: readonly GodotSpawnKind[] = ['headless', 'run', 'editor'];
const WINDOWED_KINDS: readonly GodotSpawnKind[] = ['run', 'editor'];

describe('godotSpawnOptions', () => {
  it('headless spawns hide their console window', () => {
    expect(godotSpawnOptions('headless')).toEqual({ stdio: 'pipe', windowsHide: true });
  });

  it('the run and editor spawns never ask for a hidden window', () => {
    for (const kind of WINDOWED_KINDS) {
      const options = godotSpawnOptions(kind);
      // Absent, not false: a caller spreading these options must not be able
      // to read the key as a decision that was made for a windowed process.
      expect(options, kind).not.toHaveProperty('windowsHide');
      expect(options, kind).toEqual({ stdio: 'pipe' });
    }
  });

  it('every kind keeps piped stdio', () => {
    for (const kind of ALL_KINDS) {
      expect(godotSpawnOptions(kind).stdio, kind).toBe('pipe');
    }
  });

  it('returns a fresh object per call, so a caller adding env cannot leak it', () => {
    const first = godotSpawnOptions('run');
    first.env = { LEAKED: '1' };
    expect(godotSpawnOptions('run')).not.toHaveProperty('env');
  });
});
