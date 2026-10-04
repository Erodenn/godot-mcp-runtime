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

// ---------------------------------------------------------------------------
// parseAutoloadSection
// ---------------------------------------------------------------------------

describe('parseAutoloadSection', () => {
  it('parses an entry with spaces around the equals sign', () => {
    const dir = makeProject('config_version=5\n\n[autoload]\nSpaced = "*res://a.gd"\n');
    expect(parseAutoloadSection(join(dir, 'project.godot'))).toEqual({
      entries: [{ name: 'Spaced', path: 'res://a.gd', singleton: true }],
      unparsed: [],
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

  it('is not hidden and does not hide its neighbours', () => {
    const dir = makeProject(MULTI_LINE);
    const names = parseAutoloads(join(dir, 'project.godot')).map((a) => a.name);
    expect(names).toEqual(['Before', 'Odd', 'After']);
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
