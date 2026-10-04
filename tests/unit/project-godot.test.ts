/**
 * Direct unit tests for the project.godot reader: the statement scan with its
 * line spans, and the settings view built on it.
 */

import { describe, it, expect } from 'vitest';
import {
  GLOBAL_SECTION,
  findSetting,
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
      '1 line(s) could not be parsed and were skipped; first: stray line',
    ]);
  });
});
