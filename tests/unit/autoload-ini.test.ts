/**
 * Direct unit tests for the [autoload] INI primitives.
 *
 * Both autoload-tools.ts (CRUD handlers) and bridge-manager.ts (McpBridge
 * inject/cleanup) consume these — when the regex drifts, every consumer
 * silently breaks. Direct tests localize the failure to one function instead
 * of cascading through both call sites.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  parseAutoloads,
  addAutoloadEntry,
  removeAutoloadEntry,
  updateAutoloadEntry,
  normalizeAutoloadPath,
} from '../../src/utils/autoload-ini.js';
import { useTmpDirs } from '../helpers/tmp.js';

const tmp = useTmpDirs();

function makeProject(content: string): string {
  return tmp.makeProject('autoload-ini-', content);
}

function readProject(dir: string): string {
  return readFileSync(join(dir, 'project.godot'), 'utf8');
}

// ---------------------------------------------------------------------------
// normalizeAutoloadPath
// ---------------------------------------------------------------------------

describe('normalizeAutoloadPath', () => {
  it('prefixes a project-relative path with res://', () => {
    expect(normalizeAutoloadPath('autoload/foo.gd')).toBe('res://autoload/foo.gd');
  });

  it('preserves an already-prefixed res:// path', () => {
    expect(normalizeAutoloadPath('res://autoload/foo.gd')).toBe('res://autoload/foo.gd');
  });
});

// ---------------------------------------------------------------------------
// parseAutoloads
// ---------------------------------------------------------------------------

describe('parseAutoloads', () => {
  it('returns [] when [autoload] section is absent', () => {
    const dir = makeProject('config_version=5\n\n[application]\nconfig/name="X"\n');
    expect(parseAutoloads(join(dir, 'project.godot'))).toEqual([]);
  });

  it('returns [] for an empty [autoload] section', () => {
    const dir = makeProject('config_version=5\n\n[autoload]\n');
    expect(parseAutoloads(join(dir, 'project.godot'))).toEqual([]);
  });

  it('parses singleton entries (leading * preserved as singleton: true)', () => {
    const dir = makeProject(
      'config_version=5\n\n[autoload]\nManagerA="*res://a.gd"\nManagerB="*res://b.gd"\n',
    );
    const result = parseAutoloads(join(dir, 'project.godot'));
    expect(result).toEqual([
      { name: 'ManagerA', path: 'res://a.gd', singleton: true },
      { name: 'ManagerB', path: 'res://b.gd', singleton: true },
    ]);
  });

  it('parses non-singleton entries (no * prefix → singleton: false)', () => {
    const dir = makeProject('config_version=5\n\n[autoload]\nNotASingleton="res://a.gd"\n');
    const result = parseAutoloads(join(dir, 'project.godot'));
    expect(result).toEqual([{ name: 'NotASingleton', path: 'res://a.gd', singleton: false }]);
  });

  it('skips ; and # comment lines inside the [autoload] section', () => {
    const dir = makeProject(
      'config_version=5\n\n[autoload]\n; ini-style comment\n# hash comment\nA="*res://a.gd"\n',
    );
    expect(parseAutoloads(join(dir, 'project.godot'))).toEqual([
      { name: 'A', path: 'res://a.gd', singleton: true },
    ]);
  });

  it('tolerates an unquoted path (hand-edited project.godot)', () => {
    const dir = makeProject('config_version=5\n\n[autoload]\nA=*res://a.gd\n');
    expect(parseAutoloads(join(dir, 'project.godot'))).toEqual([
      { name: 'A', path: 'res://a.gd', singleton: true },
    ]);
  });

  it('stops parsing entries when a new section header begins', () => {
    const dir = makeProject(
      [
        'config_version=5',
        '',
        '[autoload]',
        'A="*res://a.gd"',
        '',
        '[rendering]',
        'B="*res://b.gd"',
        '',
      ].join('\n'),
    );
    const result = parseAutoloads(join(dir, 'project.godot'));
    expect(result).toEqual([{ name: 'A', path: 'res://a.gd', singleton: true }]);
  });
});

// ---------------------------------------------------------------------------
// addAutoloadEntry
// ---------------------------------------------------------------------------

describe('addAutoloadEntry', () => {
  it('creates the [autoload] section when missing', () => {
    const dir = makeProject('config_version=5\n\n[application]\nconfig/name="X"\n');
    const file = join(dir, 'project.godot');
    addAutoloadEntry(file, 'Mgr', 'autoload/mgr.gd', true);
    const content = readProject(dir);
    expect(content).toContain('[autoload]');
    expect(content).toContain('Mgr="*res://autoload/mgr.gd"');
  });

  it('appends to an existing [autoload] section above the next header', () => {
    const dir = makeProject(
      [
        'config_version=5',
        '',
        '[autoload]',
        'First="*res://a.gd"',
        '',
        '[rendering]',
        'renderer/x="y"',
        '',
      ].join('\n'),
    );
    const file = join(dir, 'project.godot');
    addAutoloadEntry(file, 'Second', 'b.gd', true);
    const content = readProject(dir);
    const autoloadIdx = content.indexOf('[autoload]');
    const renderingIdx = content.indexOf('[rendering]');
    const secondIdx = content.indexOf('Second="*res://b.gd"');
    expect(autoloadIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(autoloadIdx);
    expect(secondIdx).toBeLessThan(renderingIdx);
  });

  it('writes singleton:false entries without the leading * marker', () => {
    const dir = makeProject('config_version=5\n');
    const file = join(dir, 'project.godot');
    addAutoloadEntry(file, 'Plain', 'plain.gd', false);
    expect(readProject(dir)).toContain('Plain="res://plain.gd"');
    expect(readProject(dir)).not.toContain('Plain="*');
  });

  // The primitive itself is intentionally permissive about duplicates — handler
  // code (handleAddAutoload) guards via parseAutoloads first. This test pins
  // that contract so a future change to addAutoloadEntry that rejects duplicates
  // breaks loudly and prompts the reviewer to update both layers in lockstep.
  it('appends a duplicate entry when called twice with the same name', () => {
    const dir = makeProject('config_version=5\n');
    const file = join(dir, 'project.godot');
    addAutoloadEntry(file, 'Dup', 'one.gd', true);
    addAutoloadEntry(file, 'Dup', 'two.gd', true);
    const entries = parseAutoloads(file).filter((e) => e.name === 'Dup');
    expect(entries).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// removeAutoloadEntry
// ---------------------------------------------------------------------------

describe('removeAutoloadEntry', () => {
  it('returns false and leaves the file untouched when the name is unknown', () => {
    const dir = makeProject('config_version=5\n\n[autoload]\nKept="*res://a.gd"\n');
    const file = join(dir, 'project.godot');
    const before = readProject(dir);
    expect(removeAutoloadEntry(file, 'Missing')).toBe(false);
    expect(readProject(dir)).toBe(before);
  });

  it('removes the named entry while preserving siblings', () => {
    const dir = makeProject(
      'config_version=5\n\n[autoload]\nA="*res://a.gd"\nB="*res://b.gd"\nC="*res://c.gd"\n',
    );
    const file = join(dir, 'project.godot');
    expect(removeAutoloadEntry(file, 'B')).toBe(true);
    const remaining = parseAutoloads(file).map((a) => a.name);
    expect(remaining).toEqual(['A', 'C']);
  });

  it('drops the [autoload] section header when the last entry is removed', () => {
    const dir = makeProject(
      'config_version=5\n\n[autoload]\nOnly="*res://only.gd"\n\n[rendering]\nx="y"\n',
    );
    const file = join(dir, 'project.godot');
    expect(removeAutoloadEntry(file, 'Only')).toBe(true);
    const content = readProject(dir);
    expect(content).not.toContain('[autoload]');
    expect(content).toContain('[rendering]');
  });
});

// ---------------------------------------------------------------------------
// updateAutoloadEntry
// ---------------------------------------------------------------------------

describe('updateAutoloadEntry', () => {
  it('returns false when the named autoload is absent', () => {
    const dir = makeProject('config_version=5\n\n[autoload]\nA="*res://a.gd"\n');
    expect(updateAutoloadEntry(join(dir, 'project.godot'), 'Ghost', 'x.gd', true)).toBe(false);
  });

  it('updates only the path when singleton is omitted (preserves * flag)', () => {
    const dir = makeProject('config_version=5\n\n[autoload]\nA="*res://old.gd"\n');
    const file = join(dir, 'project.godot');
    expect(updateAutoloadEntry(file, 'A', 'new.gd', undefined)).toBe(true);
    const entries = parseAutoloads(file);
    expect(entries).toEqual([{ name: 'A', path: 'res://new.gd', singleton: true }]);
  });

  it('updates only the singleton flag when path is omitted (preserves path)', () => {
    const dir = makeProject('config_version=5\n\n[autoload]\nA="*res://kept.gd"\n');
    const file = join(dir, 'project.godot');
    expect(updateAutoloadEntry(file, 'A', undefined, false)).toBe(true);
    const entries = parseAutoloads(file);
    expect(entries).toEqual([{ name: 'A', path: 'res://kept.gd', singleton: false }]);
  });

  it('flips singleton:false → singleton:true and writes the * prefix', () => {
    const dir = makeProject('config_version=5\n\n[autoload]\nA="res://a.gd"\n');
    const file = join(dir, 'project.godot');
    expect(updateAutoloadEntry(file, 'A', undefined, true)).toBe(true);
    expect(readProject(dir)).toContain('A="*res://a.gd"');
  });

  it('only mutates the named entry, leaving siblings intact', () => {
    const dir = makeProject('config_version=5\n\n[autoload]\nA="*res://a.gd"\nB="*res://b.gd"\n');
    const file = join(dir, 'project.godot');
    updateAutoloadEntry(file, 'A', 'a-new.gd', undefined);
    const entries = parseAutoloads(file);
    expect(entries).toEqual([
      { name: 'A', path: 'res://a-new.gd', singleton: true },
      { name: 'B', path: 'res://b.gd', singleton: true },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: add → parse → update → remove
// ---------------------------------------------------------------------------

describe('add/update/remove round-trip', () => {
  it('full lifecycle leaves a clean project.godot', () => {
    const dir = makeProject('config_version=5\n');
    const file = join(dir, 'project.godot');
    addAutoloadEntry(file, 'Alpha', 'alpha.gd', true);
    addAutoloadEntry(file, 'Beta', 'beta.gd', false);
    expect(parseAutoloads(file)).toEqual([
      { name: 'Alpha', path: 'res://alpha.gd', singleton: true },
      { name: 'Beta', path: 'res://beta.gd', singleton: false },
    ]);

    updateAutoloadEntry(file, 'Beta', 'beta2.gd', true);
    expect(parseAutoloads(file)).toEqual([
      { name: 'Alpha', path: 'res://alpha.gd', singleton: true },
      { name: 'Beta', path: 'res://beta2.gd', singleton: true },
    ]);

    removeAutoloadEntry(file, 'Alpha');
    removeAutoloadEntry(file, 'Beta');
    expect(parseAutoloads(file)).toEqual([]);
    expect(readProject(dir)).not.toContain('[autoload]');
  });

  it('add → manual edit → parse still finds the entry (regex stable across whitespace)', () => {
    const dir = makeProject('config_version=5\n');
    const file = join(dir, 'project.godot');
    addAutoloadEntry(file, 'X', 'x.gd', true);
    // Insert a stray blank line + comment inside the section.
    const content = readFileSync(file, 'utf8').replace(
      '[autoload]\n',
      '[autoload]\n\n; user comment\n',
    );
    writeFileSync(file, content, 'utf8');
    expect(parseAutoloads(file)).toEqual([{ name: 'X', path: 'res://x.gd', singleton: true }]);
  });
});
