import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  declaredClassName,
  findClassNameDeclarations,
  MAX_CLASS_SCAN_FILE_BYTES,
} from '../../src/utils/class-name-scan.js';
import { useTmpDirs } from '../helpers/tmp.js';

const tmp = useTmpDirs();

function writeScript(dir: string, rel: string, text: string): void {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, text, 'utf8');
}

describe('declaredClassName', () => {
  it.each([
    ['class_name Foo\nextends Node\n', 'Foo'],
    ['extends Node\nclass_name Foo\n', 'Foo'],
    ['class_name Foo extends Node\n', 'Foo'],
    ['@tool\n@icon("res://icon.svg")\nclass_name Foo\nextends Node\n', 'Foo'],
    ['@icon("res://icon.svg") class_name Foo\nextends Node\n', 'Foo'],
    ['class_name Foo, "res://x.svg"\n', 'Foo'],
  ])('reads the declared name from %j', (source, expected) => {
    expect(declaredClassName(source)).toBe(expected);
  });

  it.each([
    ['extends Node\n'],
    ['# class_name Foo\nextends Node\n'],
    ['var s = "class_name Foo"\n'],
    ['extends Foo\n'],
    ['class_name\n'],
  ])('finds no declaration in %j', (source) => {
    expect(declaredClassName(source)).toBeNull();
  });
});

describe('findClassNameDeclarations', () => {
  it('names every project script that declares the class, however deep', () => {
    const dir = tmp.makeProject('mcp-class-scan-');
    writeScript(dir, 'a.gd', 'class_name Game\nextends Node\n');
    writeScript(dir, 'sub/deep/b.gd', 'extends Node\nclass_name Game\n');
    writeScript(dir, 'c.gd', 'class_name Other\nextends Node\n');
    const scan = findClassNameDeclarations(dir, 'Game');
    expect([...scan.declaredIn].sort()).toEqual(['a.gd', 'sub/deep/b.gd']);
    expect(scan.complete).toBe(true);
  });

  it('does not count a mention in a comment, a string or an extends clause', () => {
    const dir = tmp.makeProject('mcp-class-scan-');
    writeScript(dir, 'a.gd', '# class_name Game\nextends Game\nvar s = "class_name Game"\n');
    expect(findClassNameDeclarations(dir, 'Game').declaredIn).toEqual([]);
  });

  it('skips dot-prefixed directories and non-gd files', () => {
    const dir = tmp.makeProject('mcp-class-scan-');
    writeScript(dir, '.godot/cache.gd', 'class_name Game\n');
    writeScript(dir, 'notes.txt', 'class_name Game\n');
    expect(findClassNameDeclarations(dir, 'Game').declaredIn).toEqual([]);
  });

  it('reads an extra script given by absolute path', () => {
    const dir = tmp.makeProject('mcp-class-scan-');
    const other = tmp.makeProject('mcp-class-scan-extra-');
    writeScript(other, 'x.gd', 'class_name Game\n');
    const abs = join(other, 'x.gd');
    expect(findClassNameDeclarations(dir, 'Game', [abs]).declaredIn).toEqual([abs]);
  });

  it('reports itself incomplete when a script is too large to read', () => {
    const dir = tmp.makeProject('mcp-class-scan-');
    writeScript(
      dir,
      'huge.gd',
      `class_name Game
${'#'.repeat(MAX_CLASS_SCAN_FILE_BYTES)}
`,
    );
    const scan = findClassNameDeclarations(dir, 'Game');
    expect(scan.complete).toBe(false);
    expect(scan.declaredIn).toEqual([]);
  });

  it('does not treat an extra script that does not exist as a gap', () => {
    const dir = tmp.makeProject('mcp-class-scan-');
    expect(findClassNameDeclarations(dir, 'Game', [join(dir, 'missing.gd')]).complete).toBe(true);
  });
});
