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
import { useTmpDirs } from '../../helpers/tmp.js';

function readProjectGodot(dir: string): string {
  return readFileSync(join(dir, 'project.godot'), 'utf8');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmp = useTmpDirs();

/** Create a minimal tmp Godot project (project.godot only). */
function makeTmpProject(): string {
  return tmp.makeProject('mcp-test-');
}

/** Create a minimal project with one autoload registered. */
function makeTmpProjectWithAutoload(name: string, path: string): string {
  const dir = makeTmpProject();
  const content = `config_version=5\n\n[autoload]\n${name}="*res://${path}"\n`;
  writeFileSync(join(dir, 'project.godot'), content, 'utf8');
  return dir;
}

// ---------------------------------------------------------------------------
// handleListAutoloads
// ---------------------------------------------------------------------------

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
});

// ---------------------------------------------------------------------------
// handleAddAutoload
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// handleRemoveAutoload
// ---------------------------------------------------------------------------

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
});

// ---------------------------------------------------------------------------
// handleUpdateAutoload
// ---------------------------------------------------------------------------

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
