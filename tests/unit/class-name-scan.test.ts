import { describe, it, expect } from 'vitest';
import { mkdirSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  declaredClassName,
  declaredExtends,
  findInheritedClassName,
  MAX_CLASS_SCAN_FILE_BYTES,
  MAX_EXTENDS_CHAIN_DEPTH,
  scanClassNames,
  type InheritedClassNameScan,
} from '../../src/utils/class-name-scan.js';
import { useTmpDirs } from '../helpers/tmp.js';

const tmp = useTmpDirs();

function findClassNameDeclarations(
  dir: string,
  name: string,
  extraScripts: readonly string[] = [],
) {
  const map = scanClassNames(dir, extraScripts);
  return { declaredIn: map.byName.get(name) ?? [], complete: map.complete };
}

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

describe('scanClassNames folder cap', () => {
  // Red when the walk stops counting folders: it would read all three scripts and report complete.
  it('stops at the folder cap and reports itself incomplete, siblings included', () => {
    const dir = tmp.makeProject('mcp-class-scan-');
    for (const folder of ['a', 'b', 'c']) {
      writeScript(dir, `${folder}/s.gd`, `class_name Cls${folder}\nextends Node\n`);
    }
    const capped = scanClassNames(dir, [], 2);
    expect(capped.complete).toBe(false);
    expect(capped.byName.size).toBeLessThan(3);

    const open = scanClassNames(dir, [], 4);
    expect(open.complete).toBe(true);
    expect(open.byName.size).toBe(3);
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

describe('declaredExtends', () => {
  it.each([
    ['extends Node\n', { kind: 'class', name: 'Node' }],
    ['extends "res://base.gd"\n', { kind: 'path', path: 'res://base.gd' }],
    ["extends 'base.gd'\n", { kind: 'path', path: 'base.gd' }],
    ['class_name Foo extends Bar\n', { kind: 'class', name: 'Bar' }],
    ['@tool\n@icon("x.svg") class_name Foo\nextends Bar\n', { kind: 'class', name: 'Bar' }],
    ['@tool extends Bar\n', { kind: 'class', name: 'Bar' }],
    ['extends Base.Inner\n', { kind: 'inner', text: 'Base.Inner' }],
  ])('reads the script-level target from %j', (source, expected) => {
    expect(declaredExtends(source)).toEqual(expected);
  });

  it.each([
    ['class_name Foo\n'],
    ['# extends Bar\nclass_name Foo\n'],
    ['var s = "extends Bar"\n'],
    ['class Inner extends Other:\n\tpass\n'],
    ['class Inner:\n\textends Other\n'],
  ])('finds no script-level target in %j', (source) => {
    expect(declaredExtends(source)).toBeNull();
  });

  it('prefers the script clause over an inner class that comes first', () => {
    expect(declaredExtends('class Inner extends Other:\n\tpass\nextends Outer\n')).toEqual({
      kind: 'class',
      name: 'Outer',
    });
  });
});

describe('findInheritedClassName', () => {
  /** A project and a directory outside it, joined by a link the project walk does not follow. */
  function projectWithLinkedBase(): { dir: string; shared: string } {
    const dir = tmp.makeProject('mcp-class-scan-');
    const shared = tmp.make('mcp-class-shared-');
    symlinkSync(shared, join(dir, 'linked'), 'junction');
    return { dir, shared };
  }

  function inherited(dir: string, start: string, name = 'Game'): InheritedClassNameScan {
    const abs = join(dir, start);
    return findInheritedClassName(dir, abs, name, scanClassNames(dir, [abs]));
  }

  it('finds a base reached by path through a link the project walk skips', () => {
    const { dir, shared } = projectWithLinkedBase();
    writeScript(shared, 'base.gd', 'class_name Game\nextends Node\n');
    writeScript(dir, 'child.gd', 'extends "res://linked/base.gd"\n');
    expect(findClassNameDeclarations(dir, 'Game').declaredIn).toEqual([]);
    expect(inherited(dir, 'child.gd')).toEqual({ declaredIn: ['linked/base.gd'], resolved: true });
  });

  it('follows a class name through the map and on by path', () => {
    const { dir, shared } = projectWithLinkedBase();
    writeScript(shared, 'base.gd', 'class_name Game\nextends Node\n');
    writeScript(dir, 'mid.gd', 'class_name Mid\nextends "res://linked/base.gd"\n');
    writeScript(dir, 'child.gd', 'extends Mid\n');
    expect(inherited(dir, 'child.gd')).toEqual({ declaredIn: ['linked/base.gd'], resolved: true });
  });

  it('reads a path relative to the script that holds it', () => {
    const { dir, shared } = projectWithLinkedBase();
    writeScript(shared, 'base.gd', 'class_name Game\nextends Node\n');
    writeScript(dir, 'sub/child.gd', 'extends "../linked/base.gd"\n');
    expect(inherited(dir, 'sub/child.gd').declaredIn).toEqual(['linked/base.gd']);
  });

  it('does not count the starting script itself, which the walk already reads', () => {
    const dir = tmp.makeProject('mcp-class-scan-');
    writeScript(dir, 'game.gd', 'class_name Game\nextends Node\n');
    expect(inherited(dir, 'game.gd')).toEqual({ declaredIn: [], resolved: true });
  });

  it('ends cleanly at an engine class when the project walk was complete', () => {
    const dir = tmp.makeProject('mcp-class-scan-');
    writeScript(dir, 'child.gd', 'extends Node2D\n');
    writeScript(dir, 'plain.gd', 'var x = 1\n');
    expect(inherited(dir, 'child.gd')).toEqual({ declaredIn: [], resolved: true });
    expect(inherited(dir, 'plain.gd')).toEqual({ declaredIn: [], resolved: true });
  });

  it.each([
    ['a path to a script that does not exist', 'extends "res://missing.gd"\n'],
    ['a path that is not a script', 'extends "res://other.tscn"\n'],
    ['a path outside the project', 'extends "../outside.gd"\n'],
    ['a dotted inner class', 'extends Base.Inner\n'],
  ])('reports %s as unresolved', (_label, source) => {
    const dir = tmp.makeProject('mcp-class-scan-');
    writeScript(dir, 'child.gd', source);
    expect(inherited(dir, 'child.gd').resolved).toBe(false);
  });

  it('reports a class the incomplete walk may have missed as unresolved', () => {
    const dir = tmp.makeProject('mcp-class-scan-');
    writeScript(dir, 'huge.gd', `class_name Hidden\n${'#'.repeat(MAX_CLASS_SCAN_FILE_BYTES)}\n`);
    writeScript(dir, 'child.gd', 'extends Hidden\n');
    expect(inherited(dir, 'child.gd').resolved).toBe(false);
  });

  it('reports a base too large to read as unresolved', () => {
    const dir = tmp.makeProject('mcp-class-scan-');
    writeScript(dir, 'huge.gd', `class_name Game\n${'#'.repeat(MAX_CLASS_SCAN_FILE_BYTES)}\n`);
    writeScript(dir, 'child.gd', 'extends "res://huge.gd"\n');
    expect(inherited(dir, 'child.gd')).toEqual({ declaredIn: [], resolved: false });
  });

  it('terminates on a cycle and reports it unresolved', () => {
    const dir = tmp.makeProject('mcp-class-scan-');
    writeScript(dir, 'a.gd', 'extends "res://b.gd"\n');
    writeScript(dir, 'b.gd', 'extends "res://a.gd"\n');
    expect(inherited(dir, 'a.gd')).toEqual({ declaredIn: [], resolved: false });
  });

  it('stops a chain longer than the bound and reports it unresolved', () => {
    const dir = tmp.makeProject('mcp-class-scan-');
    const length = MAX_EXTENDS_CHAIN_DEPTH + 5;
    for (let i = 0; i < length; i++) {
      writeScript(
        dir,
        `s${i}.gd`,
        i + 1 < length ? `extends "res://s${i + 1}.gd"\n` : 'extends Node\n',
      );
    }
    expect(inherited(dir, 's0.gd').resolved).toBe(false);
  });
});
