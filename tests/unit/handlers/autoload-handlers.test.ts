import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  handleListAutoloads,
  handleAddAutoload,
  handleRemoveAutoload,
  handleUpdateAutoload,
} from '../../../src/tools/autoload-tools.js';
import { parseAutoloads } from '../../../src/utils/autoload-ini.js';
import { hasError, expectErrorMatching } from '../../helpers/assertions.js';
import { fixtureProjectPath } from '../../helpers/fixture-paths.js';
import { expectMatchesOutputSchema } from '../../helpers/schema-assert.js';
import { useTmpDirs } from '../../helpers/tmp.js';

function readProjectGodot(dir: string): string {
  return readFileSync(join(dir, 'project.godot'), 'utf8');
}

const tmp = useTmpDirs();

function makeTmpProject(): string {
  return tmp.makeProject('mcp-test-');
}

function makeTmpProjectWithAutoload(name: string, path: string): string {
  const dir = makeTmpProject();
  const content = `config_version=5\n\n[autoload]\n${name}="*res://${path}"\n`;
  writeFileSync(join(dir, 'project.godot'), content, 'utf8');
  return dir;
}

describe('handleListAutoloads', () => {
  it('rejects missing projectPath', async () => {
    const result = await handleListAutoloads({});
    expectErrorMatching(result, /projectPath/i);
  });

  it('rejects projectPath containing ..', async () => {
    const result = await handleListAutoloads({ projectPath: '../evil' });
    expectErrorMatching(result, /invalid project path/i);
  });

  it('rejects nonexistent project directory', async () => {
    const result = await handleListAutoloads({ projectPath: '/does/not/exist' });
    expectErrorMatching(result, /not a valid godot project/i);
  });

  it('returns autoloads list for valid project', async () => {
    const result = await handleListAutoloads({ projectPath: fixtureProjectPath });
    expect(hasError(result)).toBe(false);
  });

  it('returns the registered autoloads wrapped in an autoloads field', async () => {
    const dir = makeTmpProjectWithAutoload('TestManager', 'scripts/test.gd');
    const result = await handleListAutoloads({ projectPath: dir });
    expect(expectMatchesOutputSchema('list_autoloads', result)).toEqual({
      autoloads: [{ name: 'TestManager', path: 'res://scripts/test.gd', singleton: true }],
    });
  });

  it('lists one entry per name and reports the overridden line in warnings, which lead', async () => {
    const dir = makeTmpProject();
    writeFileSync(
      join(dir, 'project.godot'),
      'config_version=5\nautoload/Top="*res://top.gd"\n\n[autoload]\nDup="*res://first.gd"\nDup="res://second.gd"\n',
      'utf8',
    );
    const result = await handleListAutoloads({ projectPath: dir });
    const payload = expectMatchesOutputSchema('list_autoloads', result) as {
      warnings: string[];
      autoloads: unknown[];
    };
    expect(Object.keys(payload)).toEqual(['warnings', 'autoloads']);
    expect(payload.autoloads).toEqual([
      { name: 'Top', path: 'res://top.gd', singleton: true },
      { name: 'Dup', path: 'res://second.gd', singleton: false },
    ]);
    expect(payload.warnings).toEqual([
      '1 autoload line(s) assign a name that a later line assigns again. The engine keeps the last assignment, so these are not listed: Dup="*res://first.gd" (line 5, overridden by line 6)',
    ]);
  });

  it('update_autoload and remove_autoload act on a top-level autoload/Name line where it is', async () => {
    const dir = makeTmpProject();
    const original = 'config_version=5\nautoload/Top="*res://top.gd"\n\n[application]\nx=1\n';
    writeFileSync(join(dir, 'project.godot'), original, 'utf8');
    writeFileSync(join(dir, 'new.gd'), 'extends Node\n', 'utf8');

    const updated = await handleUpdateAutoload({
      projectPath: dir,
      autoloadName: 'Top',
      autoloadPath: 'new.gd',
    });
    expect(expectMatchesOutputSchema('update_autoload', updated)).toEqual({
      autoload: { name: 'Top', path: 'res://new.gd', singleton: true },
    });
    expect(readProjectGodot(dir)).toBe(original.replace('res://top.gd', 'res://new.gd'));

    const removed = await handleRemoveAutoload({ projectPath: dir, autoloadName: 'Top' });
    expect(expectMatchesOutputSchema('remove_autoload', removed)).toEqual({
      removed: 'Top',
      autoloads: [],
    });
    expect(readProjectGodot(dir)).toBe('config_version=5\n\n[application]\nx=1\n');
  });

  it('add_autoload refuses a name a top-level autoload/Name line already registers', async () => {
    const dir = makeTmpProject();
    writeFileSync(join(dir, 'project.godot'), 'autoload/Top="*res://top.gd"\n', 'utf8');
    const result = await handleAddAutoload({
      projectPath: dir,
      autoloadName: 'Top',
      autoloadPath: 'other.gd',
    });
    expectErrorMatching(result, /already exists/);
  });

  it('accepts an autoload file whose name holds two dots', async () => {
    const dir = makeTmpProject();
    const result = await handleAddAutoload({
      projectPath: dir,
      autoloadName: 'Dotted',
      autoloadPath: 'res://boot..old.gd',
    });
    expect(hasError(result)).toBe(false);
    expect(parseAutoloads(join(dir, 'project.godot'))).toEqual([
      { name: 'Dotted', path: 'res://boot..old.gd', singleton: true },
    ]);
  });

  it('returns an empty autoloads array for a project with no [autoload] section', async () => {
    const dir = makeTmpProject();
    const result = await handleListAutoloads({ projectPath: dir });
    expect(expectMatchesOutputSchema('list_autoloads', result)).toEqual({ autoloads: [] });
  });
});

describe('autoload path characters and empty updates', () => {
  const FORBIDDEN = [
    ['a double quote', 'x".gd'],
    ['a carriage return', 'x\r.gd'],
    ['a line feed', 'x\n.gd'],
  ] as const;

  it.each(FORBIDDEN)(
    'add_autoload rejects %s and leaves project.godot untouched',
    async (_l, p) => {
      const dir = makeTmpProject();
      const before = readProjectGodot(dir);
      const result = await handleAddAutoload({
        projectPath: dir,
        autoloadName: 'Thing',
        autoloadPath: p,
      });
      expectErrorMatching(result, /double quote or a line break/i);
      expect(readProjectGodot(dir)).toBe(before);
    },
  );

  it.each(FORBIDDEN)(
    'update_autoload rejects %s and leaves project.godot untouched',
    async (_l, p) => {
      const dir = makeTmpProjectWithAutoload('Thing', 'old.gd');
      const before = readProjectGodot(dir);
      const result = await handleUpdateAutoload({
        projectPath: dir,
        autoloadName: 'Thing',
        autoloadPath: p,
      });
      expectErrorMatching(result, /double quote or a line break/i);
      expect(readProjectGodot(dir)).toBe(before);
    },
  );

  it('update_autoload with neither field errors naming both and leaves the file unchanged', async () => {
    const dir = makeTmpProjectWithAutoload('Thing', 'old.gd');
    const before = readProjectGodot(dir);
    const result = await handleUpdateAutoload({ projectPath: dir, autoloadName: 'Thing' });
    expectErrorMatching(result, /autoloadPath.*singleton/i);
    expect(readProjectGodot(dir)).toBe(before);
  });

  it('stores a backslash path with forward slashes', async () => {
    const dir = makeTmpProject();
    const result = await handleAddAutoload({
      projectPath: dir,
      autoloadName: 'Thing',
      autoloadPath: 'sub\\x.gd',
    });
    expect(hasError(result)).toBe(false);
    expect(readProjectGodot(dir)).toContain('Thing="*res://sub/x.gd"');
  });
});

describe('handleAddAutoload path spellings', () => {
  it.each([
    ['res://', 'res://x.gd'],
    ['bare', 'x.gd'],
  ])('writes one res:// line for a %s path', async (_label, spelling) => {
    const dir = makeTmpProject();
    const result = await handleAddAutoload({
      projectPath: dir,
      autoloadName: 'Thing',
      autoloadPath: spelling,
    });
    expect(hasError(result)).toBe(false);
    expect(readProjectGodot(dir)).toContain('Thing="*res://x.gd"');
  });

  it('writes a res:// line for an absolute path inside the project', async () => {
    const dir = makeTmpProject();
    const result = await handleAddAutoload({
      projectPath: dir,
      autoloadName: 'Thing',
      autoloadPath: join(dir, 'x.gd'),
    });
    expect(hasError(result)).toBe(false);
    expect(readProjectGodot(dir)).toContain('Thing="*res://x.gd"');
  });

  it('update_autoload with an absolute path inside the project writes res://', async () => {
    const dir = makeTmpProjectWithAutoload('Thing', 'old.gd');
    const result = await handleUpdateAutoload({
      projectPath: dir,
      autoloadName: 'Thing',
      autoloadPath: join(dir, 'new.gd'),
    });
    expect(hasError(result)).toBe(false);
    expect(readProjectGodot(dir)).toContain('Thing="*res://new.gd"');
  });
});

describe('handleAddAutoload', () => {
  it('rejects missing projectPath', async () => {
    const result = await handleAddAutoload({
      autoloadName: 'MyManager',
      autoloadPath: 'autoload/my.gd',
    });
    expectErrorMatching(result, /projectPath/i);
  });

  it('rejects projectPath containing ..', async () => {
    const result = await handleAddAutoload({
      projectPath: '../evil',
      autoloadName: 'MyManager',
      autoloadPath: 'autoload/my.gd',
    });
    expectErrorMatching(result, /invalid project path/i);
  });

  it('rejects nonexistent project', async () => {
    const result = await handleAddAutoload({
      projectPath: '/ghost',
      autoloadName: 'MyManager',
      autoloadPath: 'autoload/my.gd',
    });
    expectErrorMatching(result, /not a valid godot project/i);
  });

  it('rejects missing autoloadName', async () => {
    const result = await handleAddAutoload({
      projectPath: fixtureProjectPath,
      autoloadPath: 'autoload/my.gd',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects missing autoloadPath', async () => {
    const result = await handleAddAutoload({
      projectPath: fixtureProjectPath,
      autoloadName: 'MyManager',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects autoloadPath containing ..', async () => {
    const result = await handleAddAutoload({
      projectPath: fixtureProjectPath,
      autoloadName: 'MyManager',
      autoloadPath: '../outside.gd',
    });
    expect(hasError(result)).toBe(true);
  });

  it('registers autoload in a fresh tmp project and writes the singleton entry to project.godot', async () => {
    const dir = makeTmpProject();
    const result = await handleAddAutoload({
      projectPath: dir,
      autoloadName: 'TestManager',
      autoloadPath: 'scripts/test.gd',
    });
    expect(hasError(result)).toBe(false);
    expect(readProjectGodot(dir)).toContain('TestManager="*res://scripts/test.gd"');
    expect(parseAutoloads(join(dir, 'project.godot'))).toContainEqual({
      name: 'TestManager',
      path: 'res://scripts/test.gd',
      singleton: true,
    });
  });

  it('returns the entry read back from project.godot and a tip', async () => {
    const dir = makeTmpProject();
    const result = await handleAddAutoload({
      projectPath: dir,
      autoloadName: 'TestManager',
      autoloadPath: 'scripts/test.gd',
    });
    expect(expectMatchesOutputSchema('add_autoload', result)).toEqual({
      autoload: { name: 'TestManager', path: 'res://scripts/test.gd', singleton: true },
      tip: expect.any(String),
    });
  });

  it('reports singleton: false in the returned entry when opted out', async () => {
    const dir = makeTmpProject();
    const result = await handleAddAutoload({
      projectPath: dir,
      autoloadName: 'NotSingleton',
      autoloadPath: 'b.gd',
      singleton: false,
    });
    const payload = expectMatchesOutputSchema('add_autoload', result);
    expect(payload.autoload).toMatchObject({ name: 'NotSingleton', singleton: false });
  });

  it('defaults singleton to true when the param is omitted', async () => {
    const dir = makeTmpProject();
    await handleAddAutoload({
      projectPath: dir,
      autoloadName: 'DefaultSingleton',
      autoloadPath: 'a.gd',
    });
    const entry = parseAutoloads(join(dir, 'project.godot')).find(
      (a) => a.name === 'DefaultSingleton',
    );
    expect(entry?.singleton).toBe(true);
  });

  it('writes singleton:false when explicitly opted out', async () => {
    const dir = makeTmpProject();
    await handleAddAutoload({
      projectPath: dir,
      autoloadName: 'NotSingleton',
      autoloadPath: 'b.gd',
      singleton: false,
    });
    expect(readProjectGodot(dir)).toContain('NotSingleton="res://b.gd"');
    expect(readProjectGodot(dir)).not.toContain('NotSingleton="*');
  });

  it('rejects a duplicate name and leaves project.godot unchanged', async () => {
    const dir = makeTmpProjectWithAutoload('Dupe', 'orig.gd');
    const before = readProjectGodot(dir);
    const result = await handleAddAutoload({
      projectPath: dir,
      autoloadName: 'Dupe',
      autoloadPath: 'overwrite.gd',
    });
    expectErrorMatching(result, /already exists/i);
    expect(readProjectGodot(dir)).toBe(before);
  });
});

describe('handleRemoveAutoload', () => {
  it('rejects missing projectPath', async () => {
    const result = await handleRemoveAutoload({ autoloadName: 'MyManager' });
    expectErrorMatching(result, /projectPath/i);
  });

  it('rejects projectPath containing ..', async () => {
    const result = await handleRemoveAutoload({
      projectPath: '../evil',
      autoloadName: 'MyManager',
    });
    expectErrorMatching(result, /invalid project path/i);
  });

  it('rejects nonexistent project', async () => {
    const result = await handleRemoveAutoload({
      projectPath: '/ghost',
      autoloadName: 'MyManager',
    });
    expectErrorMatching(result, /not a valid godot project/i);
  });

  it('rejects missing autoloadName', async () => {
    const result = await handleRemoveAutoload({ projectPath: fixtureProjectPath });
    expect(hasError(result)).toBe(true);
  });

  it('returns isError when named autoload does not exist', async () => {
    const result = await handleRemoveAutoload({
      projectPath: fixtureProjectPath,
      autoloadName: 'NonExistentAutoload',
    });
    expect(hasError(result)).toBe(true);
  });

  it('removes an existing autoload and the entry is gone from project.godot', async () => {
    const dir = makeTmpProjectWithAutoload('TestManager', 'scripts/test.gd');
    const result = await handleRemoveAutoload({ projectPath: dir, autoloadName: 'TestManager' });
    expect(hasError(result)).toBe(false);
    expect(readProjectGodot(dir)).not.toContain('TestManager');
    expect(parseAutoloads(join(dir, 'project.godot'))).toEqual([]);
  });

  it('returns the removed name and the entries that remain', async () => {
    const dir = makeTmpProjectWithAutoload('TestManager', 'scripts/test.gd');
    const result = await handleRemoveAutoload({ projectPath: dir, autoloadName: 'TestManager' });
    expect(expectMatchesOutputSchema('remove_autoload', result)).toEqual({
      removed: 'TestManager',
      autoloads: [],
    });
  });
});

describe('handleUpdateAutoload', () => {
  it('rejects missing projectPath', async () => {
    const result = await handleUpdateAutoload({ autoloadName: 'MyManager' });
    expectErrorMatching(result, /projectPath/i);
  });

  it('rejects projectPath containing ..', async () => {
    const result = await handleUpdateAutoload({
      projectPath: '../evil',
      autoloadName: 'MyManager',
    });
    expectErrorMatching(result, /invalid project path/i);
  });

  it('rejects nonexistent project', async () => {
    const result = await handleUpdateAutoload({
      projectPath: '/ghost',
      autoloadName: 'MyManager',
    });
    expectErrorMatching(result, /not a valid godot project/i);
  });

  it('rejects missing autoloadName', async () => {
    const result = await handleUpdateAutoload({ projectPath: fixtureProjectPath });
    expect(hasError(result)).toBe(true);
  });

  it('rejects autoloadPath containing ..', async () => {
    const result = await handleUpdateAutoload({
      projectPath: fixtureProjectPath,
      autoloadName: 'MyManager',
      autoloadPath: '../escape.gd',
    });
    expect(hasError(result)).toBe(true);
  });

  it('returns isError when named autoload does not exist', async () => {
    const result = await handleUpdateAutoload({
      projectPath: fixtureProjectPath,
      autoloadName: 'NonExistentAutoload',
      autoloadPath: 'scripts/new.gd',
    });
    expect(hasError(result)).toBe(true);
  });

  it('updates the path of an existing autoload and writes the new path to project.godot', async () => {
    const dir = makeTmpProjectWithAutoload('TestManager', 'scripts/old.gd');
    const result = await handleUpdateAutoload({
      projectPath: dir,
      autoloadName: 'TestManager',
      autoloadPath: 'scripts/new.gd',
    });
    expect(hasError(result)).toBe(false);
    const entries = parseAutoloads(join(dir, 'project.godot'));
    expect(entries).toEqual([
      { name: 'TestManager', path: 'res://scripts/new.gd', singleton: true },
    ]);
  });

  it('returns the entry read back after the edit', async () => {
    const dir = makeTmpProjectWithAutoload('TestManager', 'scripts/old.gd');
    const result = await handleUpdateAutoload({
      projectPath: dir,
      autoloadName: 'TestManager',
      autoloadPath: 'scripts/new.gd',
    });
    expect(expectMatchesOutputSchema('update_autoload', result)).toEqual({
      autoload: { name: 'TestManager', path: 'res://scripts/new.gd', singleton: true },
    });
  });

  it('flips singleton to false without touching the path when only singleton is provided', async () => {
    const dir = makeTmpProjectWithAutoload('TestManager', 'scripts/keep.gd');
    const result = await handleUpdateAutoload({
      projectPath: dir,
      autoloadName: 'TestManager',
      singleton: false,
    });
    expect(hasError(result)).toBe(false);
    expect(readProjectGodot(dir)).toContain('TestManager="res://scripts/keep.gd"');
    expect(readProjectGodot(dir)).not.toContain('TestManager="*');
  });
});

describe('handleListAutoloads unparsed lines', () => {
  it('list_autoloads leads with a warning for an unparsed line', async () => {
    const dir = makeTmpProject();
    writeFileSync(
      join(dir, 'project.godot'),
      'config_version=5\n\n[autoload]\nGood="*res://a.gd"\nmy-auto="res://b.gd"\n',
      'utf8',
    );
    const result = await handleListAutoloads({ projectPath: dir });
    const payload = expectMatchesOutputSchema('list_autoloads', result) as Record<string, unknown>;
    expect(Object.keys(payload)[0]).toBe('warnings');
    expect(payload.warnings).toEqual([
      '[autoload] has 1 line(s) that could not be parsed and are not listed: my-auto="res://b.gd"',
    ]);
    expect(payload.autoloads).toEqual([{ name: 'Good', path: 'res://a.gd', singleton: true }]);
  });

  it('list_autoloads returns the entries under a commented header', async () => {
    const dir = makeTmpProject();
    writeFileSync(
      join(dir, 'project.godot'),
      'config_version=5\n\n[autoload] ; managed by hand\nGood="*res://a.gd" ; first\nPlain="res://b.gd"\n',
      'utf8',
    );
    const result = await handleListAutoloads({ projectPath: dir });
    const payload = expectMatchesOutputSchema('list_autoloads', result) as Record<string, unknown>;
    expect(payload).not.toHaveProperty('warnings');
    expect(payload.autoloads).toEqual([
      { name: 'Good', path: 'res://a.gd', singleton: true },
      { name: 'Plain', path: 'res://b.gd', singleton: false },
    ]);
  });

  it('list_autoloads has no warnings key when every line parses', async () => {
    const dir = makeTmpProjectWithAutoload('Ok', 'ok.gd');
    const result = await handleListAutoloads({ projectPath: dir });
    expect(expectMatchesOutputSchema('list_autoloads', result)).not.toHaveProperty('warnings');
  });
});

describe('autoload tools accept the snake_case spellings of their parameters', () => {
  it('update_autoload accepts autoload_path', async () => {
    const dir = makeTmpProjectWithAutoload('Game', 'game.gd');
    const result = await handleUpdateAutoload({
      project_path: dir,
      autoload_name: 'Game',
      autoload_path: 'res://new_game.gd',
    });
    expect(hasError(result)).toBe(false);
    expect(readProjectGodot(dir)).toContain('Game="*res://new_game.gd"');
    expect(readProjectGodot(dir)).not.toContain('res://game.gd');
  });

  it('add_autoload accepts autoload_name and autoload_path', async () => {
    const dir = makeTmpProject();
    const result = await handleAddAutoload({
      project_path: dir,
      autoload_name: 'Manager',
      autoload_path: 'res://manager.gd',
    });
    expect(hasError(result)).toBe(false);
    expect(readProjectGodot(dir)).toContain('Manager="*res://manager.gd"');
  });
});

describe('handleListAutoloads lines Godot did not write', () => {
  const projectWith = (content: string): string => {
    const dir = makeTmpProject();
    writeFileSync(join(dir, 'project.godot'), content, 'utf8');
    return dir;
  };

  it('names the line of an entry written on the line of its header', async () => {
    const dir = projectWith('config_version=5\n\n[autoload] Evil="*res://evil.gd"\n');
    const result = await handleListAutoloads({ projectPath: dir });
    const payload = expectMatchesOutputSchema('list_autoloads', result) as {
      warnings: string[];
      autoloads: unknown[];
    };
    expect(payload.autoloads).toEqual([]);
    expect(payload.warnings).toHaveLength(1);
    expect(payload.warnings[0]).toContain('line 3 (a section header must be alone on its line');
    expect(payload.warnings[0]).toContain('may not be listed');
  });

  it('update_autoload refuses an entry that shares its line with a second statement', async () => {
    const content = 'config_version=5\n\n[autoload]\nA="*res://a.gd" Evil="*res://evil.gd"\n';
    const dir = projectWith(content);
    const result = await handleUpdateAutoload({
      projectPath: dir,
      autoloadName: 'A',
      singleton: false,
    });
    expectErrorMatching(result, /not found/i);
    expect(readProjectGodot(dir)).toBe(content);
  });
});
