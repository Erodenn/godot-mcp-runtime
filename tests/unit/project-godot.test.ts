/**
 * Direct unit tests for the project.godot reader: the statement scan with its
 * line spans, and the settings view built on it.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import {
  GLOBAL_SECTION,
  describeNonCanonical,
  findSetting,
  findSettingByPath,
  readProjectSettings,
  scanProjectFile,
} from '../../src/utils/project-godot.js';

describe('scanProjectFile', () => {
  it('reports the line a single-line statement sits on', () => {
    const content = 'config_version=5\n\n[application]\nconfig/name="Game"\nrun/x=true\n';
    const scan = scanProjectFile(content);
    const lines = content.split('\n');

    expect(scan.statements.map((s) => [s.section, s.key, s.value, s.startLine, s.endLine])).toEqual(
      [
        [GLOBAL_SECTION, 'config_version', 5, 0, 0],
        ['application', 'config/name', 'Game', 3, 3],
        ['application', 'run/x', true, 4, 4],
      ],
    );
    expect(lines[scan.statements[1]!.startLine]).toBe('config/name="Game"');
    expect(scan.sections).toEqual([
      { name: 'application', headerLine: 2, endLine: lines.length, headerHasComment: false },
    ]);
  });

  it('reports every line a multi-line value covers', () => {
    const content = [
      '[input]',
      'jump={',
      '"deadzone": 0.5,',
      '"events": []',
      '}',
      'after=1',
      '',
      '[display]',
      'text="line one',
      'line two"',
      'last=2',
    ].join('\n');
    const scan = scanProjectFile(content);
    const spans = scan.statements.map((s) => [s.key, s.startLine, s.endLine]);

    expect(spans).toEqual([
      ['jump', 1, 4],
      ['after', 5, 5],
      ['text', 8, 9],
      ['last', 10, 10],
    ]);
    expect(scan.statements[2]!.value).toBe('line one\nline two');
    expect(scan.sections).toEqual([
      { name: 'input', headerLine: 0, endLine: 7, headerHasComment: false },
      { name: 'display', headerLine: 7, endLine: 11, headerHasComment: false },
    ]);
  });

  it('recognises a header with a trailing comment', () => {
    const scan = scanProjectFile('[autoload] ; managed by hand\nA="*res://a.gd"\n');

    expect(scan.sections).toEqual([
      { name: 'autoload', headerLine: 0, endLine: 3, headerHasComment: true },
    ]);
    expect(scan.statements[0]).toMatchObject({ section: 'autoload', key: 'A', startLine: 1 });
  });

  it('leaves a trailing comment out of a value and keeps the statement on its line', () => {
    const scan = scanProjectFile('[application]\nrun/main_scene="res://a.tscn" ; the menu\n');

    expect(scan.statements[0]).toMatchObject({
      raw: '"res://a.tscn"',
      value: 'res://a.tscn',
      startLine: 1,
      endLine: 1,
    });
  });

  it('lists a line that is not a statement, with its section and line', () => {
    const scan = scanProjectFile('[autoload]\nnot an entry\nA="res://a.gd"\n');

    expect(scan.unparsed).toEqual([{ section: 'autoload', line: 1, text: 'not an entry' }]);
    expect(scan.statements[0]!.startLine).toBe(2);
  });

  it('marks a value cut off by the next header as unterminated', () => {
    const scan = scanProjectFile('[a]\nx={\n"k": 1\n[b]\ny=1\n');

    expect(scan.statements[0]).toMatchObject({ key: 'x', unterminated: true, endLine: 2 });
    expect(scan.statements[1]).toMatchObject({ section: 'b', key: 'y', startLine: 4 });
  });

  it('reads the same statements from CRLF content', () => {
    const lf = 'config_version=5\n\n[autoload] ; note\nA="*res://a.gd"\nB={\n"k": 1\n}\n';
    const crlf = lf.replace(/\n/g, '\r\n');

    const fromCrlf = scanProjectFile(crlf);
    const fromLf = scanProjectFile(lf);
    const shape = (scan: typeof fromLf) =>
      scan.statements.map((s) => [s.section, s.key, s.startLine, s.endLine, s.unterminated]);
    expect(shape(fromCrlf)).toEqual(shape(fromLf));
    // Single-line values are identical; a multi-line raw value keeps its own line breaks.
    expect(fromCrlf.statements.slice(0, 2)).toEqual(fromLf.statements.slice(0, 2));
    expect(fromCrlf.sections).toEqual(fromLf.sections);
    expect(fromCrlf.unparsed).toEqual([]);
  });
});

describe('findSetting', () => {
  it('returns the last of two statements for one key', () => {
    const scan = scanProjectFile(
      '[application]\nrun/main_scene="res://first.tscn"\nrun/main_scene="res://second.tscn"\n',
    );

    expect(findSetting(scan, 'application', 'run/main_scene')).toMatchObject({
      value: 'res://second.tscn',
      startLine: 2,
    });
  });

  it('reads a key across two sections of the same name and ignores other sections', () => {
    const scan = scanProjectFile('[a]\nk=1\n\n[b]\nk=2\n\n[a]\nk=3\n');

    expect(findSetting(scan, 'a', 'k')?.value).toBe(3);
    expect(findSetting(scan, 'b', 'k')?.value).toBe(2);
    expect(findSetting(scan, 'c', 'k')).toBeUndefined();
  });
});

describe('readProjectSettings', () => {
  it('keeps [__proto__] and constructor sections off the prototype', () => {
    const { settings } = readProjectSettings(
      '[__proto__]\npolluted=true\n\n[constructor]\nprototype=1\n\n[a]\n__proto__=2\n',
    );

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(settings)).toBeNull();
    expect(Object.keys(settings)).toEqual(['__proto__', 'constructor', 'a']);
    expect(settings['__proto__']).toEqual({ polluted: true });
    expect(settings['constructor']).toEqual({ prototype: 1 });
    expect(Object.keys(settings['a']!)).toEqual(['__proto__']);
  });

  it('warns on empty and unterminated values and on skipped lines', () => {
    const { settings, warnings } = readProjectSettings('stray line\n[a]\nempty=\nopen="x\n');

    expect(settings['a']).toEqual({ empty: null, open: '"x' });
    expect(warnings).toEqual([
      'Value of a/empty is empty and is null',
      'Value of a/open is unterminated and was returned as far as it could be read',
      'project.godot has 3 line(s) that are not in the form Godot writes, so the engine may read them differently from what is reported here: line 1 (not a key=value statement); line 3 (no value follows the = on its line); line 4 (the value is not one complete value with nothing after it)',
    ]);
  });
});

describe('a setting is its full path', () => {
  it('gives every statement the path the engine assigns', () => {
    const scan = scanProjectFile(
      'config_version=5\nautoload/Top="x"\n\n[application]\nrun/main_scene="a"\n\n[application/run]\nmain_scene="b"\n',
    );
    expect(scan.statements.map((s) => s.path)).toEqual([
      'config_version',
      'autoload/Top',
      'application/run/main_scene',
      'application/run/main_scene',
    ]);
  });

  it('findSetting finds a setting written under another section split', () => {
    const scan = scanProjectFile('[application/run]\nmain_scene="res://b.tscn"\n');
    expect(findSetting(scan, 'application', 'run/main_scene')?.value).toBe('res://b.tscn');
    expect(findSettingByPath(scan, 'application/run/main_scene')?.value).toBe('res://b.tscn');
  });

  it('findSetting finds a setting written at the top level', () => {
    const scan = scanProjectFile('autoload/ProbeA="*res://probe_a.gd"\n\n[application]\nx=1\n');
    expect(findSetting(scan, 'autoload', 'ProbeA')?.value).toBe('*res://probe_a.gd');
  });

  it('the last assignment wins across spellings', () => {
    const scan = scanProjectFile(
      'application/run/main_scene="top"\n\n[application]\nrun/main_scene="mid"\n\n[application/run]\nmain_scene="last"\n',
    );
    expect(findSetting(scan, 'application', 'run/main_scene')).toMatchObject({
      value: 'last',
      section: 'application/run',
      key: 'main_scene',
    });
  });

  it('trims blanks inside the header brackets, as the engine does', () => {
    const scan = scanProjectFile('[ application ]\nrun/x=1\n');
    expect(scan.statements[0]).toMatchObject({ section: 'application', path: 'application/run/x' });
  });

  it('readProjectSettings lists only the assignment the engine keeps, and says what it left out', () => {
    const { settings, warnings } = readProjectSettings(
      '[application]\nrun/main_scene="first"\nconfig/name="G"\n\n[application/run]\nmain_scene="last"\n',
    );
    expect(settings['application']).toEqual({ 'config/name': 'G' });
    expect(settings['application/run']).toEqual({ main_scene: 'last' });
    expect(warnings).toEqual([
      'application/run/main_scene (line 2) is not listed: line 6 assigns the same setting as application/run/main_scene, and the engine keeps the last assignment',
    ]);
  });

  it('readProjectSettings stays silent about a key repeated in one section', () => {
    const { settings, warnings } = readProjectSettings('[a]\nk=1\nk=2\n');
    expect(settings['a']).toEqual({ k: 2 });
    expect(warnings).toEqual([]);
  });
});

describe('a value that starts after the line of its equals sign', () => {
  it('is read, and the statement covers every line down to it', () => {
    const scan = scanProjectFile('[autoload]\nNextLine=\n"*res://probe_c.gd"\nAfter="x"\n');
    expect(scan.statements.map((s) => [s.key, s.value, s.startLine, s.endLine])).toEqual([
      ['NextLine', '*res://probe_c.gd', 1, 2],
      ['After', 'x', 3, 3],
    ]);
    expect(scan.unparsed).toEqual([]);
  });

  it('is found past blank lines and comments', () => {
    const scan = scanProjectFile('[a]\nk=  ; soon\n\n; still coming\n  42\nnext=1\n');
    expect(scan.statements.map((s) => [s.key, s.value, s.endLine])).toEqual([
      ['k', 42, 4],
      ['next', 1, 5],
    ]);
  });

  it.each([
    ['a dictionary', '{\n"a": 1\n}', '{\n"a": 1\n}'],
    ['an array', '[1, 2]', '[1, 2]'],
    ['a one-element array', '[2]', '[2]'],
    ['a bare word', 'true', true],
    ['a constructor', 'Vector2(1, 2)', 'Vector2(1, 2)'],
    ['a resource reference', 'ExtResource("1_abc")', 'ExtResource("1_abc")'],
    ['a StringName', '&"name"', '&"name"'],
    ['a negative number', '-1.5', -1.5],
  ])('takes %s on the next line as the value', (_label, text, value) => {
    const scan = scanProjectFile(`[a]\nk=\n${text}\nnext=1\n`);
    expect(scan.statements[0]).toMatchObject({ key: 'k', value });
    expect(scan.statements[1]).toMatchObject({ key: 'next', value: 1 });
  });

  it.each([
    ['the next statement', 'other/key="x"\n', 'other/key'],
    ['a key that starts with a digit', '2d_physics/layer_1="x"\n', '2d_physics/layer_1'],
    ['a key named like a bare word', 'true_color="x"\n', 'true_color'],
  ])('leaves the value empty when %s follows', (_label, following, nextKey) => {
    const scan = scanProjectFile(`[a]\nempty=\n${following}`);
    expect(scan.statements.map((s) => [s.key, s.value])).toEqual([
      ['empty', null],
      [nextKey, 'x'],
    ]);
  });

  it('leaves the value empty when a section header or the end of the file follows', () => {
    const scan = scanProjectFile('[a]\nempty=\n\n[b]\nk=1\nlast=\n');
    expect(scan.statements.map((s) => [s.section, s.key, s.value])).toEqual([
      ['a', 'empty', null],
      ['b', 'k', 1],
      ['b', 'last', null],
    ]);
    expect(scan.sections.map((s) => s.name)).toEqual(['a', 'b']);
  });
});

describe('a bracketed line inside a multi-line value', () => {
  it('is part of the value when it is itself a value', () => {
    const content = '[input]\nmatrix=[\n[1]\n,\n[2]\n,\n[true]\n]\nafter=1\n\n[display]\nw=2\n';
    const scan = scanProjectFile(content);
    expect(
      scan.statements.map((s) => [s.section, s.key, s.unterminated, s.startLine, s.endLine]),
    ).toEqual([
      ['input', 'matrix', false, 1, 7],
      ['input', 'after', false, 8, 8],
      ['display', 'w', false, 11, 11],
    ]);
    expect(scan.sections.map((s) => s.name)).toEqual(['input', 'display']);
  });

  it('is part of the value inside a dictionary, too', () => {
    const scan = scanProjectFile('[a]\nd={\n"k":\n[2]\n}\nnext=1\n');
    expect(scan.statements.map((s) => [s.key, s.unterminated])).toEqual([
      ['d', false],
      ['next', false],
    ]);
  });

  it('is not a header inside a multi-line string', () => {
    const scan = scanProjectFile('[a]\ntext="one\n[b]\ntwo"\nnext=1\n');
    expect(scan.statements.map((s) => [s.section, s.key])).toEqual([
      ['a', 'text'],
      ['a', 'next'],
    ]);
    expect(scan.statements[0]!.value).toBe('one\n[b]\ntwo');
  });

  it('still ends a runaway value at a line that can only be a header', () => {
    const scan = scanProjectFile('[a]\nx=[\n1,\n[rendering/quality]\ny=1\n');
    expect(scan.statements[0]).toMatchObject({ key: 'x', unterminated: true, endLine: 2 });
    expect(scan.statements[1]).toMatchObject({ section: 'rendering/quality', key: 'y' });
  });
});

describe('anything that is not in the form Godot writes is flagged', () => {
  const BENIGN = 'run/main_scene="res://main.tscn"';
  const flagged = (content: string): Array<[number, boolean]> =>
    scanProjectFile(content).nonCanonical.map((item) => [item.line, item.isStatement]);

  it('a statement on the line of a header', () => {
    const content = `[application]\n${BENIGN}\n[application] run/main_scene="res://evil.tscn"\n`;
    expect(flagged(content)).toEqual([[2, true]]);
    expect(scanProjectFile(content).nonCanonical[0]!.reason).toMatch(/section header/);
  });

  it('an autoload entry on the line of its header', () => {
    expect(flagged('[autoload] Evil="*res://evil.gd"\n')).toEqual([[0, true]]);
  });

  it('two statements on one line', () => {
    const content = `[application]\n${BENIGN}\nconfig/name="x" run/main_scene="res://evil.tscn"\n`;
    const scan = scanProjectFile(content);
    expect(flagged(content)).toEqual([[2, true]]);
    expect(scan.statements[1]).toMatchObject({ canonical: false, quotedString: false });
    expect(scan.statements[0]).toMatchObject({ canonical: true, quotedString: true });
  });

  it.each([
    ['a blank inside the key', 'run/main_ scene="res://evil.tscn"'],
    ['a quoted key that needs no quotes', '"run/main_scene"="res://evil.tscn"'],
    ['a bracket in the key', 'run[0]="res://evil.tscn"'],
  ])('%s', (_name, line) => {
    const scan = scanProjectFile(`[application]\n${BENIGN}\n${line}\n`);
    expect(scan.nonCanonical).toMatchObject([
      { line: 2, isStatement: true, reason: expect.stringMatching(/key/) },
    ]);
  });

  it('a junk line before a header', () => {
    expect(flagged(`[application]\n${BENIGN}\nx\n[application]\n`)).toEqual([[2, false]]);
  });

  it('a # line, which the engine does not read as a comment', () => {
    const scan = scanProjectFile('[autoload]\n#Evil="*res://evil.gd"\n# a note\n');
    expect(scan.nonCanonical.map((item) => [item.line, item.section, item.reason])).toEqual([
      [1, 'autoload', expect.stringMatching(/'#' does not start a comment/)],
      [2, 'autoload', expect.stringMatching(/'#' does not start a comment/)],
    ]);
    expect(scan.statements).toEqual([]);
  });

  it.each([
    ['a value that starts on a later line', 'a=\n"x"\n', 0],
    ['an empty value', 'a=\n', 0],
    ['a bare word that is not a value', 'a=res://main.tscn\n', 0],
    ['content after a number', 'a=1 2\n', 0],
    ['a second statement after a number', 'a=1b=2\n', 0],
    ['content after a closed array', 'a=[1]]\n', 0],
    ['content after a constructor', 'a=Vector2(1, 2) b=3\n', 0],
    ['a hex colour', 'a=#ff0000\n', 0],
    ['an unterminated string', 'a="x\n', 0],
    ['an unbalanced dictionary', 'ok=1\na={\n"k": 1\n', 1],
    ['a header with blanks inside the brackets', '[ a ]\n', 0],
    ['a header with content after it', '[a] x\n', 0],
  ])('%s', (_name, content, line) => {
    expect(scanProjectFile(content).nonCanonical.map((item) => item.line)).toEqual([line]);
  });

  it.each([
    ['a quoted string', 'a="x"'],
    ['a string holding a quote, an equals sign and a semicolon', 'a="x \\" = ; [y]"'],
    ['a string that spans lines', 'a="one\n[b]\ntwo"'],
    ['a StringName', 'a=&"x"'],
    ['a number', 'a=-1.5e-05'],
    ['a bare word', 'a=null'],
    ['negative infinity', 'a=-inf'],
    ['a constructor', 'a=PackedStringArray("4.6", "Mobile")'],
    ['a typed array', 'a=Array[int]([1, 2])'],
    ['a typed dictionary', 'a=Dictionary[String, int]({\n"k": 1\n})'],
    ['an array', 'a=[1, [2], "]"]'],
    ['a value followed by a comment', 'a=1 ; note'],
    ['a header followed by a comment', '[s] ; note'],
    ['an indented statement', '  a=1'],
    ['blanks around the equals sign', 'a = "x"'],
    ['a key with dots, dashes and digits', '2d_physics/layer-1.mobile=1'],
    ['a key Godot quotes because it holds a blank', '"move left"={\n"deadzone": 0.5\n}'],
    ['a key Godot quotes because it holds a quote', '"say \\"hi\\""=1'],
  ])('%s is canonical', (_name, body) => {
    for (const eol of ['\n', '\r\n']) {
      const scan = scanProjectFile(`[s]${eol}${body.split('\n').join(eol)}${eol}next=1${eol}`);
      expect(scan.nonCanonical).toEqual([]);
      expect(scan.statements.at(-1)).toMatchObject({ key: 'next', value: 1, canonical: true });
    }
  });

  it('reads a quoted key as the name inside the quotes', () => {
    const scan = scanProjectFile('[input]\n"move left"=1\n"a=b"=2\n');
    expect(scan.statements.map((s) => [s.path, s.value])).toEqual([
      ['input/move left', 1],
      ['input/a=b', 2],
    ]);
  });

  it('describeNonCanonical names each line with its 1-based number and caps the list', () => {
    expect(describeNonCanonical(scanProjectFile('a=1\n'))).toBeNull();
    expect(describeNonCanonical(scanProjectFile('a=1\nx\n# y\n'))).toBe(
      "project.godot has 2 line(s) that are not in the form Godot writes, so the engine may read them differently from what is reported here: line 2 (not a key=value statement); line 3 ('#' does not start a comment in project.godot, only ';' does)",
    );
    const many = describeNonCanonical(scanProjectFile('x\n'.repeat(8)))!;
    expect(many).toContain('project.godot has 8 line(s)');
    expect(many).toContain('line 5 (');
    expect(many).not.toContain('line 6 (');
    expect(many.endsWith('; +3 more')).toBe(true);
  });

  it.each([
    'tests/fixtures/godot-project/project.godot',
    'tests/fixtures/godot-authored-project/project.godot',
  ])('%s, a file Godot wrote, has no flagged line', (relPath) => {
    const scan = scanProjectFile(readFileSync(join(process.cwd(), relPath), 'utf8'));
    expect(scan.nonCanonical).toEqual([]);
    expect(scan.statements.every((statement) => statement.canonical)).toBe(true);
  });

  // A real game's project file, present on a developer machine only.
  const LOCAL_GAME_PROJECT = join(process.cwd(), '.test-project', 'project.godot');
  it.skipIf(!existsSync(LOCAL_GAME_PROJECT))('a real project file has no flagged line', () => {
    const scan = scanProjectFile(readFileSync(LOCAL_GAME_PROJECT, 'utf8'));
    expect(scan.nonCanonical).toEqual([]);
    expect(scan.unparsed).toEqual([]);
    expect(scan.statements.find((s) => s.path === 'input/move_left')).toMatchObject({
      canonical: true,
      unterminated: false,
    });
    expect(findSettingByPath(scan, 'application/config/features')?.raw).toBe(
      'PackedStringArray("4.6", "Mobile")',
    );
  });
});
