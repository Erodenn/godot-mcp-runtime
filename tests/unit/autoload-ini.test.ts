/**
 * Direct unit tests for the [autoload] INI primitives.
 *
 * Both autoload-tools.ts (CRUD handlers) and bridge-manager.ts (McpBridge
 * inject/cleanup) consume these: when the grammar drifts, every consumer
 * silently breaks. Direct tests localize the failure to one function instead
 * of cascading through both call sites.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  parseAutoloads,
  parseAutoloadSection,
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

  it('does not read an unquoted path as an entry', () => {
    const dir = makeProject('config_version=5\n\n[autoload]\nA=*res://a.gd\n');
    const section = parseAutoloadSection(join(dir, 'project.godot'));
    expect(section.entries).toEqual([]);
    expect(section.unparsed).toEqual(['A=*res://a.gd']);
    expect(section.nonCanonical).toContain('line 4 (');
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

  it('appends to an existing [autoload] section directly after its last entry', () => {
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
    expect(readProject(dir)).toBe(
      [
        'config_version=5',
        '',
        '[autoload]',
        'First="*res://a.gd"',
        'Second="*res://b.gd"',
        '',
        '[rendering]',
        'renderer/x="y"',
        '',
      ].join('\n'),
    );
  });

  it('writes singleton:false entries without the leading * marker', () => {
    const dir = makeProject('config_version=5\n');
    const file = join(dir, 'project.godot');
    addAutoloadEntry(file, 'Plain', 'plain.gd', false);
    expect(readProject(dir)).toContain('Plain="res://plain.gd"');
    expect(readProject(dir)).not.toContain('Plain="*');
  });

  // The primitive itself is intentionally permissive about duplicates: handler
  // code (handleAddAutoload) guards via parseAutoloads first. This test pins
  // that contract so a future change to addAutoloadEntry that rejects duplicates
  // breaks loudly and prompts the reviewer to update both layers in lockstep.
  it('appends a second line when called twice with the same name, and the last one is the entry', () => {
    const dir = makeProject('config_version=5\n');
    const file = join(dir, 'project.godot');
    addAutoloadEntry(file, 'Dup', 'one.gd', true);
    addAutoloadEntry(file, 'Dup', 'two.gd', true);
    expect(readProject(dir)).toBe(
      'config_version=5\n\n[autoload]\nDup="*res://one.gd"\nDup="*res://two.gd"\n',
    );
    const section = parseAutoloadSection(file);
    expect(section.entries).toEqual([{ name: 'Dup', path: 'res://two.gd', singleton: true }]);
    expect(section.shadowed).toEqual(['Dup="*res://one.gd" (line 4, overridden by line 5)']);
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

  it('with a predicate removes only the assignments whose path satisfies it', () => {
    const dir = makeProject(
      'config_version=5\n\n[autoload]\nA="*res://keep.gd"\nA="*res://drop.gd"\nA="res://drop.gd"\n',
    );
    const file = join(dir, 'project.godot');
    expect(removeAutoloadEntry(file, 'A', (path) => path === 'res://drop.gd')).toBe(true);
    expect(readProject(dir)).toBe('config_version=5\n\n[autoload]\nA="*res://keep.gd"\n');
  });

  it('with a predicate nothing satisfies leaves the file untouched', () => {
    const dir = makeProject('config_version=5\n\n[autoload]\nA="*res://keep.gd"\n');
    const file = join(dir, 'project.godot');
    const before = readProject(dir);
    expect(removeAutoloadEntry(file, 'A', () => false)).toBe(false);
    expect(readProject(dir)).toBe(before);
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

// ---------------------------------------------------------------------------
// parseAutoloadSection
// ---------------------------------------------------------------------------

describe('parseAutoloadSection', () => {
  it('parses an entry with spaces around the equals sign', () => {
    const dir = makeProject('config_version=5\n\n[autoload]\nSpaced = "*res://a.gd"\n');
    expect(parseAutoloadSection(join(dir, 'project.godot'))).toEqual({
      entries: [{ name: 'Spaced', path: 'res://a.gd', singleton: true }],
      unparsed: [],
      shadowed: [],
      nonCanonical: null,
    });
  });

  it('returns the lines it could not parse', () => {
    const dir = makeProject(
      'config_version=5\n\n[autoload]\nGood="*res://a.gd"\nmy-auto="res://b.gd"\nnot an entry\n',
    );
    const section = parseAutoloadSection(join(dir, 'project.godot'));
    expect(section.entries).toEqual([{ name: 'Good', path: 'res://a.gd', singleton: true }]);
    expect(section.unparsed).toEqual(['my-auto="res://b.gd"', 'not an entry']);
  });

  it('parseAutoloads returns the same entries', () => {
    const dir = makeProject('config_version=5\n\n[autoload]\nA = "res://a.gd"\nbad-name="x"\n');
    const file = join(dir, 'project.godot');
    expect(parseAutoloads(file)).toEqual(parseAutoloadSection(file).entries);
  });

  it('removes and updates an entry written with spaces around the equals sign', () => {
    const dir = makeProject(
      'config_version=5\n\n[autoload]\nA = "*res://a.gd"\nB = "res://b.gd"\n',
    );
    const file = join(dir, 'project.godot');
    expect(updateAutoloadEntry(file, 'A', 'res://c.gd')).toBe(true);
    expect(readProject(dir)).toContain('A="*res://c.gd"');
    expect(removeAutoloadEntry(file, 'B')).toBe(true);
    expect(readProject(dir)).not.toContain('res://b.gd');
  });
});

// ---------------------------------------------------------------------------
// The project.godot grammar: comments, line endings, spans, repeated sections
// ---------------------------------------------------------------------------

/** A line feed with no carriage return before it: a mixed line ending in a CRLF file. */
const BARE_LF_REGEX = /(?<!\r)\n/;

describe('a commented [autoload] header', () => {
  const COMMENTED =
    'config_version=5\n\n[autoload] ; note\nA="*res://a.gd"\n\n[rendering]\nx="y"\n';

  it('parses the entries under it', () => {
    const dir = makeProject(COMMENTED);
    expect(parseAutoloadSection(join(dir, 'project.godot'))).toEqual({
      entries: [{ name: 'A', path: 'res://a.gd', singleton: true }],
      unparsed: [],
      shadowed: [],
      nonCanonical: null,
    });
  });

  it('add inserts into it and writes no second header', () => {
    const dir = makeProject(COMMENTED);
    addAutoloadEntry(join(dir, 'project.godot'), 'B', 'b.gd', false);
    expect(readProject(dir)).toBe(
      'config_version=5\n\n[autoload] ; note\nA="*res://a.gd"\nB="res://b.gd"\n\n[rendering]\nx="y"\n',
    );
  });

  it('survives the removal of its last entry', () => {
    const dir = makeProject(COMMENTED);
    expect(removeAutoloadEntry(join(dir, 'project.godot'), 'A')).toBe(true);
    expect(readProject(dir)).toBe('config_version=5\n\n[autoload] ; note\n\n[rendering]\nx="y"\n');
  });
});

describe('an entry with a trailing comment', () => {
  const CONTENT = 'config_version=5\n\n[autoload]\nA="*res://a.gd" ; the first\nB="res://b.gd"\n';

  it('parses', () => {
    const dir = makeProject(CONTENT);
    expect(parseAutoloadSection(join(dir, 'project.godot'))).toEqual({
      entries: [
        { name: 'A', path: 'res://a.gd', singleton: true },
        { name: 'B', path: 'res://b.gd', singleton: false },
      ],
      unparsed: [],
      shadowed: [],
      nonCanonical: null,
    });
  });

  it('updates, dropping the comment on the edited line', () => {
    const dir = makeProject(CONTENT);
    expect(updateAutoloadEntry(join(dir, 'project.godot'), 'A', undefined, false)).toBe(true);
    expect(readProject(dir)).toBe(
      'config_version=5\n\n[autoload]\nA="res://a.gd"\nB="res://b.gd"\n',
    );
  });

  it('removes', () => {
    const dir = makeProject(CONTENT);
    expect(removeAutoloadEntry(join(dir, 'project.godot'), 'A')).toBe(true);
    expect(readProject(dir)).toBe('config_version=5\n\n[autoload]\nB="res://b.gd"\n');
  });
});

describe('a CRLF project.godot', () => {
  const CRLF_CONTENT = [
    'config_version=5',
    '',
    '[application]',
    'config/name="Game"',
    '',
    '[autoload]',
    'A="*res://a.gd"',
    'B="res://b.gd"',
    '',
    '[rendering]',
    'x="y"',
    '',
  ].join('\r\n');

  it('add keeps every other line and writes no bare line feed', () => {
    const dir = makeProject(CRLF_CONTENT);
    addAutoloadEntry(join(dir, 'project.godot'), 'C', 'c.gd', true);
    const after = readProject(dir);
    expect(after).toBe(
      CRLF_CONTENT.replace('B="res://b.gd"\r\n', 'B="res://b.gd"\r\nC="*res://c.gd"\r\n'),
    );
    expect(after).not.toMatch(BARE_LF_REGEX);
  });

  it('update keeps every other line and writes no bare line feed', () => {
    const dir = makeProject(CRLF_CONTENT);
    expect(updateAutoloadEntry(join(dir, 'project.godot'), 'A', 'a2.gd')).toBe(true);
    const after = readProject(dir);
    expect(after).toBe(CRLF_CONTENT.replace('A="*res://a.gd"', 'A="*res://a2.gd"'));
    expect(after).not.toMatch(BARE_LF_REGEX);
  });

  it('remove keeps every other line and writes no bare line feed', () => {
    const dir = makeProject(CRLF_CONTENT);
    expect(removeAutoloadEntry(join(dir, 'project.godot'), 'A')).toBe(true);
    const after = readProject(dir);
    expect(after).toBe(CRLF_CONTENT.replace('A="*res://a.gd"\r\n', ''));
    expect(after).not.toMatch(BARE_LF_REGEX);
  });

  it('creates the section with CRLF endings when there is none', () => {
    const dir = makeProject('config_version=5\r\n');
    addAutoloadEntry(join(dir, 'project.godot'), 'A', 'a.gd', true);
    expect(readProject(dir)).toBe('config_version=5\r\n\r\n[autoload]\r\nA="*res://a.gd"\r\n');
  });

  it('terminates a last line that had no line break before adding after it', () => {
    const dir = makeProject('config_version=5\r\n\r\n[autoload]\r\nA="*res://a.gd"');
    addAutoloadEntry(join(dir, 'project.godot'), 'B', 'b.gd', true);
    expect(readProject(dir)).toBe(
      'config_version=5\r\n\r\n[autoload]\r\nA="*res://a.gd"\r\nB="*res://b.gd"\r\n',
    );
  });
});

describe('the end of the file', () => {
  it('add and update keep the trailing newline', () => {
    const dir = makeProject('config_version=5\n\n[autoload]\nA="*res://a.gd"\n');
    const file = join(dir, 'project.godot');
    addAutoloadEntry(file, 'B', 'b.gd', true);
    expect(readProject(dir)).toBe(
      'config_version=5\n\n[autoload]\nA="*res://a.gd"\nB="*res://b.gd"\n',
    );
    updateAutoloadEntry(file, 'B', 'b2.gd');
    expect(readProject(dir)).toBe(
      'config_version=5\n\n[autoload]\nA="*res://a.gd"\nB="*res://b2.gd"\n',
    );
  });

  it('add into a file ending in the header line ends with a newline', () => {
    const dir = makeProject('config_version=5\n\n[autoload]\n');
    addAutoloadEntry(join(dir, 'project.godot'), 'A', 'a.gd', true);
    expect(readProject(dir)).toBe('config_version=5\n\n[autoload]\nA="*res://a.gd"\n');
  });

  it('add after a last line with no line break terminates it and ends with a newline', () => {
    const dir = makeProject('config_version=5\n\n[autoload]');
    addAutoloadEntry(join(dir, 'project.godot'), 'A', 'a.gd', true);
    expect(readProject(dir)).toBe('config_version=5\n\n[autoload]\nA="*res://a.gd"\n');
  });

  it('update of a last line with no line break adds none', () => {
    const dir = makeProject('config_version=5\n\n[autoload]\nA="*res://a.gd"');
    expect(updateAutoloadEntry(join(dir, 'project.godot'), 'A', 'a2.gd')).toBe(true);
    expect(readProject(dir)).toBe('config_version=5\n\n[autoload]\nA="*res://a2.gd"');
  });
});

describe('an entry that spans lines', () => {
  const MULTI_LINE = [
    'config_version=5',
    '',
    '[autoload]',
    'Before="*res://before.gd"',
    'Odd={',
    '"path": "res://odd.gd"',
    '}',
    'After="res://after.gd"',
    '',
  ].join('\n');

  it('is reported as unparsed and does not hide its neighbours', () => {
    const dir = makeProject(MULTI_LINE);
    const section = parseAutoloadSection(join(dir, 'project.godot'));
    expect(section.entries.map((a) => a.name)).toEqual(['Before', 'After']);
    expect(section.unparsed).toEqual(['Odd={']);
    expect(section.nonCanonical).toBeNull();
  });

  it('is removed whole', () => {
    const dir = makeProject(MULTI_LINE);
    expect(removeAutoloadEntry(join(dir, 'project.godot'), 'Odd')).toBe(true);
    expect(readProject(dir)).toBe(
      'config_version=5\n\n[autoload]\nBefore="*res://before.gd"\nAfter="res://after.gd"\n',
    );
  });

  it('a string value across two lines is removed and updated whole', () => {
    const content = 'config_version=5\n\n[autoload]\nA="*res://a\nb.gd"\nB="res://b.gd"\n';
    const removed = makeProject(content);
    expect(removeAutoloadEntry(join(removed, 'project.godot'), 'A')).toBe(true);
    expect(readProject(removed)).toBe('config_version=5\n\n[autoload]\nB="res://b.gd"\n');

    const updated = makeProject(content);
    expect(updateAutoloadEntry(join(updated, 'project.godot'), 'A', 'a.gd')).toBe(true);
    expect(readProject(updated)).toBe(
      'config_version=5\n\n[autoload]\nA="*res://a.gd"\nB="res://b.gd"\n',
    );
  });

  it('an unterminated value is unparsed, reported by its first line', () => {
    const dir = makeProject('config_version=5\n\n[autoload]\nOpen="*res://a.gd\n');
    expect(parseAutoloadSection(join(dir, 'project.godot'))).toEqual({
      entries: [],
      unparsed: ['Open="*res://a.gd'],
      shadowed: [],
      nonCanonical:
        'project.godot has 1 line(s) that are not in the form Godot writes, so the engine may read them differently from what is reported here: line 4 (the value is not one complete value with nothing after it)',
    });
  });
});

describe('a retained path with escapes', () => {
  it('reads back to the same value after a singleton-only update', () => {
    const dir = makeProject(
      'config_version=5\n\n[autoload]\nA="*res://a \\"quoted\\" \\\\ dir/a.gd"\n',
    );
    const file = join(dir, 'project.godot');
    const before = parseAutoloads(file);
    expect(before).toEqual([{ name: 'A', path: 'res://a "quoted" \\ dir/a.gd', singleton: true }]);

    expect(updateAutoloadEntry(file, 'A', undefined, false)).toBe(true);
    expect(parseAutoloads(file)).toEqual([{ ...before[0]!, singleton: false }]);
  });
});

describe('two [autoload] sections', () => {
  const TWO_SECTIONS = [
    'config_version=5',
    '',
    '[autoload]',
    'A="*res://a.gd"',
    '',
    '[rendering]',
    'x="y"',
    '',
    '[autoload]',
    'B="res://b.gd"',
    '',
  ].join('\n');

  it('lists the entries of both', () => {
    const dir = makeProject(TWO_SECTIONS);
    expect(parseAutoloads(join(dir, 'project.godot')).map((a) => a.name)).toEqual(['A', 'B']);
  });

  it('add targets the last one', () => {
    const dir = makeProject(TWO_SECTIONS);
    addAutoloadEntry(join(dir, 'project.godot'), 'C', 'c.gd', true);
    expect(readProject(dir)).toBe(
      TWO_SECTIONS.replace('B="res://b.gd"\n', 'B="res://b.gd"\nC="*res://c.gd"\n'),
    );
  });

  it('update reaches an entry in the first one', () => {
    const dir = makeProject(TWO_SECTIONS);
    expect(updateAutoloadEntry(join(dir, 'project.godot'), 'A', 'a2.gd')).toBe(true);
    expect(readProject(dir)).toBe(TWO_SECTIONS.replace('A="*res://a.gd"', 'A="*res://a2.gd"'));
  });

  it('remove drops only the section it emptied', () => {
    const dir = makeProject(TWO_SECTIONS);
    expect(removeAutoloadEntry(join(dir, 'project.godot'), 'A')).toBe(true);
    expect(readProject(dir)).toBe(
      'config_version=5\n\n[rendering]\nx="y"\n\n[autoload]\nB="res://b.gd"\n',
    );
  });

  it('remove takes a name registered in both', () => {
    const dir = makeProject(TWO_SECTIONS.replace('B="res://b.gd"', 'A="res://again.gd"'));
    expect(removeAutoloadEntry(join(dir, 'project.godot'), 'A')).toBe(true);
    expect(readProject(dir)).toBe('config_version=5\n\n[rendering]\nx="y"\n');
  });
});

describe('a section that is not empty after a removal', () => {
  it('keeps its header when a comment line is left under it', () => {
    const dir = makeProject('config_version=5\n\n[autoload]\n; keep me\nA="*res://a.gd"\n');
    expect(removeAutoloadEntry(join(dir, 'project.godot'), 'A')).toBe(true);
    expect(readProject(dir)).toBe('config_version=5\n\n[autoload]\n; keep me\n');
  });
});

// ---------------------------------------------------------------------------
// The engine's reading: a setting is its path, and the last assignment wins
// ---------------------------------------------------------------------------

describe('the project.godot the engine experiment used', () => {
  // Godot 4.6 loaded probe_a, probe_second and probe_c from this file, and
  // refused the [autoload/] entry with "Trying to add autoload with no name".
  // probe_c is registered by a value on the line after its `=`, a form Godot
  // never writes: it is reported as unparsed and flagged, not listed.
  const EXPERIMENT = [
    'config_version=5',
    'autoload/ProbeA="*res://probe_a.gd"',
    '',
    '[autoload]',
    'Dup="*res://probe_first.gd"',
    'Dup="*res://probe_second.gd"',
    'NextLine=',
    '"*res://probe_c.gd"',
    '',
    '[autoload/]',
    'ProbeD="*res://probe_d.gd"',
    '',
  ].join('\n');

  it('lists the canonical entries, one per name, and reports the rest', () => {
    const dir = makeProject(EXPERIMENT);
    const section = parseAutoloadSection(join(dir, 'project.godot'));
    expect(section.entries).toEqual([
      { name: 'ProbeA', path: 'res://probe_a.gd', singleton: true },
      { name: 'Dup', path: 'res://probe_second.gd', singleton: true },
    ]);
    expect(section.nonCanonical).toContain('line 7 (no value follows the = on its line)');
    expect(section.shadowed).toEqual([
      'Dup="*res://probe_first.gd" (line 5, overridden by line 6)',
    ]);
    expect(section.unparsed).toEqual(['NextLine=', 'ProbeD="*res://probe_d.gd"']);
  });
});

describe('an autoload written as a top-level autoload/Name line', () => {
  const TOP_LEVEL = 'config_version=5\nautoload/Top="*res://top.gd"\n\n[application]\nx=1\n';

  it('is updated where it is, under the key it is written with', () => {
    const dir = makeProject(TOP_LEVEL);
    expect(updateAutoloadEntry(join(dir, 'project.godot'), 'Top', 'top2.gd', false)).toBe(true);
    expect(readProject(dir)).toBe(
      'config_version=5\nautoload/Top="res://top2.gd"\n\n[application]\nx=1\n',
    );
  });

  it('is removed, and every other line is kept', () => {
    const dir = makeProject(TOP_LEVEL);
    expect(removeAutoloadEntry(join(dir, 'project.godot'), 'Top')).toBe(true);
    expect(readProject(dir)).toBe('config_version=5\n\n[application]\nx=1\n');
  });

  it('is overridden by a later [autoload] line of the same name', () => {
    const dir = makeProject(`${TOP_LEVEL}\n[autoload]\nTop="res://later.gd"\n`);
    const file = join(dir, 'project.godot');
    expect(parseAutoloads(file)).toEqual([
      { name: 'Top', path: 'res://later.gd', singleton: false },
    ]);
    expect(removeAutoloadEntry(file, 'Top')).toBe(true);
    expect(readProject(dir)).toBe('config_version=5\n\n[application]\nx=1\n');
  });
});

describe('a name assigned twice', () => {
  const TWICE =
    'config_version=5\n\n[autoload]\nA="*res://first.gd"\nB="res://b.gd"\nA="res://last.gd"\n';

  it('is listed once, at the position of the first line with the value of the last', () => {
    const dir = makeProject(TWICE);
    expect(parseAutoloads(join(dir, 'project.godot'))).toEqual([
      { name: 'A', path: 'res://last.gd', singleton: false },
      { name: 'B', path: 'res://b.gd', singleton: false },
    ]);
  });

  it('update rewrites the line the engine keeps and leaves the overridden one', () => {
    const dir = makeProject(TWICE);
    expect(updateAutoloadEntry(join(dir, 'project.godot'), 'A', undefined, true)).toBe(true);
    expect(readProject(dir)).toBe(TWICE.replace('A="res://last.gd"', 'A="*res://last.gd"'));
  });

  it('remove takes both lines, so the earlier one does not take over', () => {
    const dir = makeProject(TWICE);
    const file = join(dir, 'project.godot');
    expect(removeAutoloadEntry(file, 'A')).toBe(true);
    expect(readProject(dir)).toBe('config_version=5\n\n[autoload]\nB="res://b.gd"\n');
  });
});

describe('remove leaves untouched lines byte for byte', () => {
  it('keeps trailing blank lines and adds no final line break', () => {
    const dir = makeProject('[autoload]\nA="res://a.gd"\nB="res://b.gd"\n\n[x]\ny=1  \n\n\n');
    expect(removeAutoloadEntry(join(dir, 'project.godot'), 'A')).toBe(true);
    expect(readProject(dir)).toBe('[autoload]\nB="res://b.gd"\n\n[x]\ny=1  \n\n\n');

    const unterminated = makeProject('[autoload]\nA="res://a.gd"\nB="res://b.gd"\n\n[x]\ny=1');
    expect(removeAutoloadEntry(join(unterminated, 'project.godot'), 'A')).toBe(true);
    expect(readProject(unterminated)).toBe('[autoload]\nB="res://b.gd"\n\n[x]\ny=1');
  });

  it('keeps the line ending of the line before a removed last line', () => {
    const dir = makeProject('[autoload]\r\nA="res://a.gd"\r\nB="res://b.gd"');
    expect(removeAutoloadEntry(join(dir, 'project.godot'), 'B')).toBe(true);
    expect(readProject(dir)).toBe('[autoload]\r\nA="res://a.gd"\r\n');
  });

  it('add then remove gives back the original file', () => {
    for (const original of [
      'config_version=5\n',
      'config_version=5\r\n\r\n[a]\r\nx=1\r\n',
      'x=1',
    ]) {
      const dir = makeProject(original);
      const file = join(dir, 'project.godot');
      addAutoloadEntry(file, 'Bridge', 'bridge.gd', true);
      expect(removeAutoloadEntry(file, 'Bridge')).toBe(true);
      const expected = original.endsWith('\n') ? original : `${original}\n`;
      expect(readProject(dir)).toBe(expected);
    }
  });
});

describe('an autoload line Godot did not write', () => {
  const parse = (body: string): ReturnType<typeof parseAutoloadSection> =>
    parseAutoloadSection(join(makeProject(`config_version=5\n\n${body}\n`), 'project.godot'));

  it('a second registration after an entry on its line makes the line unparsed', () => {
    const line = 'A="*res://a.gd" Evil="*res://evil.gd"';
    const section = parse(`[autoload]\n${line}`);
    expect(section.entries).toEqual([]);
    expect(section.unparsed).toEqual([line]);
    expect(section.nonCanonical).toContain('line 4 (');
  });

  it('update and remove-by-path leave such a line as it is', () => {
    const content = 'config_version=5\n\n[autoload]\nA="*res://a.gd" Evil="*res://evil.gd"\n';
    const dir = makeProject(content);
    const file = join(dir, 'project.godot');
    expect(updateAutoloadEntry(file, 'A', 'res://b.gd')).toBe(false);
    expect(removeAutoloadEntry(file, 'A', () => true)).toBe(false);
    expect(readProject(dir)).toBe(content);
  });

  it('a StringName value is unparsed', () => {
    const section = parse('[autoload]\nA=&"*res://a.gd"');
    expect(section.entries).toEqual([]);
    expect(section.unparsed).toEqual(['A=&"*res://a.gd"']);
    expect(section.nonCanonical).toBeNull();
  });

  it('an entry on the line of the header is flagged, with no entry', () => {
    const section = parse('[autoload] Evil="*res://evil.gd"');
    expect(section.entries).toEqual([]);
    expect(section.nonCanonical).toContain('line 3 (a section header must be alone on its line');
  });

  it('a # line under [autoload] is unparsed, not a comment', () => {
    const section = parse('[autoload]\n#Evil="*res://evil.gd"\nGood="*res://a.gd"');
    expect(section.entries).toEqual([{ name: 'Good', path: 'res://a.gd', singleton: true }]);
    expect(section.unparsed).toEqual(['#Evil="*res://evil.gd"']);
    expect(section.nonCanonical).toContain("line 4 ('#' does not start a comment");
  });

  it('a line outside [autoload] that is not canonical is still passed on', () => {
    const section = parse('[application]\nx\n\n[autoload]\nGood="*res://a.gd"');
    expect(section.entries).toHaveLength(1);
    expect(section.unparsed).toEqual([]);
    expect(section.nonCanonical).toContain('line 4 (not a key=value statement)');
  });
});
