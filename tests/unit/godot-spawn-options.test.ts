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

const ALL_KINDS: readonly GodotSpawnKind[] = [
  'headless',
  'run',
  'run-background',
  'movie',
  'editor',
];
const WINDOWED_KINDS: readonly GodotSpawnKind[] = ['run', 'editor'];
/** Kinds the server kills later, so they lead a process group a group signal can reach. */
const KILLED_KINDS: readonly GodotSpawnKind[] = ['headless', 'run', 'run-background', 'movie'];
const LEADS_OWN_GROUP = process.platform !== 'win32';

describe('godotSpawnOptions', () => {
  it('headless spawns hide their console window', () => {
    expect(godotSpawnOptions('headless')).toEqual({
      stdio: 'pipe',
      detached: LEADS_OWN_GROUP,
      windowsHide: true,
    });
  });

  it('the background run spawn hides its window', () => {
    expect(godotSpawnOptions('run-background')).toEqual({
      stdio: 'pipe',
      detached: LEADS_OWN_GROUP,
      windowsHide: true,
    });
  });

  it('the movie spawn hides its window and leads its own process group outside Windows', () => {
    expect(godotSpawnOptions('movie')).toEqual({
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: LEADS_OWN_GROUP,
      windowsHide: true,
    });
  });

  it('every kind the server kills leads its own process group outside Windows, and the editor never does', () => {
    for (const kind of KILLED_KINDS) {
      expect(godotSpawnOptions(kind).detached, kind).toBe(LEADS_OWN_GROUP);
    }
    expect(godotSpawnOptions('editor')).not.toHaveProperty('detached');
  });

  it('the run and editor spawns never ask for a hidden window', () => {
    for (const kind of WINDOWED_KINDS) {
      const options = godotSpawnOptions(kind);
      // Absent, not false: a caller spreading these options must not be able
      // to read the key as a decision that was made for a windowed process.
      expect(options, kind).not.toHaveProperty('windowsHide');
    }
    expect(godotSpawnOptions('run')).toEqual({ stdio: 'pipe', detached: LEADS_OWN_GROUP });
    expect(godotSpawnOptions('editor')).toEqual({ stdio: 'pipe' });
  });

  it('every kind keeps piped stdio', () => {
    for (const kind of ALL_KINDS) {
      const { stdio } = godotSpawnOptions(kind);
      // The movie run ignores stdin and pipes both output streams.
      const expected = kind === 'movie' ? ['ignore', 'pipe', 'pipe'] : 'pipe';
      expect(stdio, kind).toEqual(expected);
    }
  });

  it('returns a fresh object per call, so a caller adding env cannot leak it', () => {
    const first = godotSpawnOptions('run');
    first.env = { LEAKED: '1' };
    expect(godotSpawnOptions('run')).not.toHaveProperty('env');
  });
});
