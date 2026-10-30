import { describe, it, expect } from 'vitest';
import { mkdirSync, symlinkSync, writeFileSync } from 'fs';
import { resolve, sep, join } from 'path';
import {
  fileIdentityKey,
  isUnderDir,
  resolveProjectPath,
  validatePath,
} from '../../src/utils/path-validation.js';
import { removeTmpDir as rmDir, useTmpDirs } from '../helpers/tmp.js';

const tmp = useTmpDirs();
const IS_WINDOWS = process.platform === 'win32';

describe('resolveProjectPath', () => {
  const project = resolve('/project');

  function expectResolved(input: string, relPath: string) {
    const resolved = resolveProjectPath(project, input, 'write');
    expect(resolved).toEqual({
      input,
      relPath,
      absPath: join(project, ...relPath.split('/')),
      resPath: `res://${relPath}`,
    });
  }

  it('resolves a bare relative path', () => {
    expectResolved('scenes/main.tscn', 'scenes/main.tscn');
  });

  it('resolves a nested relative path', () => {
    expectResolved('a/b/c/d.gd', 'a/b/c/d.gd');
  });

  it('drops a leading ./', () => {
    expectResolved('./main.tscn', 'main.tscn');
  });

  it('strips a leading res://', () => {
    expectResolved('res://autoload/foo.gd', 'autoload/foo.gd');
  });

  it('treats backslashes as separators', () => {
    expectResolved('a\\b.tscn', 'a/b.tscn');
  });

  it('resolves an absolute path inside the project to its project-relative form', () => {
    expectResolved(resolve(project, 'sub/file.gd'), 'sub/file.gd');
  });

  it('rejects empty and non-string input', () => {
    expect(resolveProjectPath(project, '', 'write')).toBeNull();
    expect(resolveProjectPath(project, undefined as unknown as string, 'write')).toBeNull();
  });

  it('rejects a path whose .. segments leave the project', () => {
    expect(resolveProjectPath(project, '..', 'write')).toBeNull();
    expect(resolveProjectPath(project, '../etc/passwd', 'write')).toBeNull();
    expect(resolveProjectPath(project, '..\\x', 'write')).toBeNull();
    expect(resolveProjectPath(project, 'foo/../../bar', 'write')).toBeNull();
    expect(resolveProjectPath(project, 'res://../x', 'write')).toBeNull();
  });

  it('resolves .. segments that stay inside the project', () => {
    expectResolved('a/../b', 'b');
    expectResolved('res://a/../b.tscn', 'b.tscn');
    expectResolved('a/b/../../c/d.gd', 'c/d.gd');
  });

  it('rejects a path that resolves to the project root through ..', () => {
    expect(resolveProjectPath(project, 'a/..', 'write')).toBeNull();
    expect(resolveProjectPath(project, 'res://a/..', 'write')).toBeNull();
  });

  it('accepts a file name that contains two dots', () => {
    expectResolved('a..b', 'a..b');
    expectResolved('a..b.gd', 'a..b.gd');
    expectResolved('ui/menu..old.tscn', 'ui/menu..old.tscn');
    expectResolved('res://..hidden/x.gd', '..hidden/x.gd');
  });

  it('rejects a segment that ends in a dot or a space, or is blank', () => {
    for (const input of [
      'main.tscn.',
      'main.tscn ',
      '...',
      ' ',
      '\t',
      'a /b.gd',
      'a./b.gd',
      'res://scenes/main.tscn.',
      resolve(project, 'main.tscn.'),
    ]) {
      expect(resolveProjectPath(project, input, 'write'), JSON.stringify(input)).toBeNull();
    }
  });

  it('keeps a leading space and an inner dot or space, which every platform preserves', () => {
    expectResolved('my scenes/ main.v2.tscn', 'my scenes/ main.v2.tscn');
  });

  it('rejects a colon after the scheme or drive prefix', () => {
    for (const input of [
      'a.tscn:x',
      'a.tscn:x:$DATA',
      'res://a.tscn:x',
      'dir:stream/a.tscn',
      'c:x.gd',
      resolve(project, 'a.tscn:x'),
    ]) {
      expect(resolveProjectPath(project, input, 'write'), JSON.stringify(input)).toBeNull();
    }
  });

  it('rejects absolute paths outside the project', () => {
    expect(resolveProjectPath(project, '/etc/passwd', 'write')).toBeNull();
    expect(resolveProjectPath(project, resolve('/elsewhere/file.gd'), 'write')).toBeNull();
  });

  it('rejects a sibling directory that shares the project name as a prefix', () => {
    expect(resolveProjectPath(project, '../project-evil/file.gd', 'write')).toBeNull();
    expect(resolveProjectPath(project, resolve('/project-evil/file.gd'), 'write')).toBeNull();
  });

  it('rejects res:// on its own', () => {
    expect(resolveProjectPath(project, 'res://', 'write')).toBeNull();
  });

  it('rejects a second URI scheme', () => {
    expect(resolveProjectPath(project, 'res://res://x', 'write')).toBeNull();
    expect(resolveProjectPath(project, 'uid://abc', 'write')).toBeNull();
  });

  it('rejects the project root itself', () => {
    expect(resolveProjectPath(project, '.', 'write')).toBeNull();
    expect(resolveProjectPath(project, project, 'write')).toBeNull();
  });

  it('resolves under a filesystem-root project', () => {
    const root = resolve(sep);
    const resolved = resolveProjectPath(root, 'etc/passwd', 'write');
    expect(resolved).not.toBeNull();
    expect(resolved!.relPath).toBe('etc/passwd');
    expect(resolved!.absPath).toBe(resolve(root, 'etc/passwd'));
    expect(resolved!.resPath).toBe('res://etc/passwd');
    expect(resolveProjectPath(root, root, 'write')).toBeNull();
  });
});

describe('resolveProjectPath across links', () => {
  /** Link `linkPath` to the directory `target`: a junction on Windows, a symlink elsewhere. */
  function linkDir(target: string, linkPath: string): void {
    symlinkSync(target, linkPath, 'junction');
  }

  it('rejects a path through a link inside the project that points outside it', () => {
    const projectDir = tmp.makeProject('path-link-out-');
    const shared = tmp.make('path-link-shared-');
    writeFileSync(join(shared, 'existing.tscn'), '', 'utf8');
    linkDir(shared, join(projectDir, 'assets'));

    expect(resolveProjectPath(projectDir, 'assets/existing.tscn', 'write')).toBeNull();
    expect(resolveProjectPath(projectDir, 'assets/new.tscn', 'write')).toBeNull();
    expect(resolveProjectPath(projectDir, 'assets/sub/deeper/new.tscn', 'write')).toBeNull();
    expect(resolveProjectPath(projectDir, 'res://assets', 'write')).toBeNull();
    expect(resolveProjectPath(projectDir, 'other/new.tscn', 'write')).not.toBeNull();
  });

  it('accepts a path through a link that stays inside the project', () => {
    const projectDir = tmp.makeProject('path-link-in-');
    mkdirSync(join(projectDir, 'real'));
    linkDir(join(projectDir, 'real'), join(projectDir, 'alias'));

    expect(resolveProjectPath(projectDir, 'alias/new.tscn', 'write')?.relPath).toBe(
      'alias/new.tscn',
    );
  });

  it('accepts paths in a project that is itself reached through a link', () => {
    const realProject = tmp.makeProject('path-link-root-real-');
    mkdirSync(join(realProject, 'scenes'));
    const holder = tmp.make('path-link-root-holder-');
    const linkedProject = join(holder, 'game');
    linkDir(realProject, linkedProject);

    const resolved = resolveProjectPath(linkedProject, 'scenes/new.tscn', 'write');
    expect(resolved?.relPath).toBe('scenes/new.tscn');
    expect(resolved?.absPath).toBe(join(linkedProject, 'scenes', 'new.tscn'));
  });

  it('rejects a path through a link whose target is gone', () => {
    const projectDir = tmp.makeProject('path-link-dangling-');
    const gone = join(tmp.make('path-link-gone-'), 'missing');
    mkdirSync(gone);
    linkDir(gone, join(projectDir, 'assets'));
    tmp.track(gone);
    // Remove the target, leaving the link dangling.
    rmDir(gone);

    expect(resolveProjectPath(projectDir, 'assets/new.tscn', 'write')).toBeNull();
  });
});

describe('resolveProjectPath access intent across links', () => {
  function linkedOut(): { projectDir: string; shared: string } {
    const projectDir = tmp.makeProject('path-intent-');
    const shared = tmp.make('path-intent-shared-');
    writeFileSync(join(shared, 'plugin.gd'), 'extends Node\n', 'utf8');
    mkdirSync(join(projectDir, 'addons'));
    symlinkSync(shared, join(projectDir, 'addons', 'plugin'), 'junction');
    return { projectDir, shared };
  }

  it('a read follows a link that leaves the project and returns the path as given', () => {
    const { projectDir } = linkedOut();
    expect(resolveProjectPath(projectDir, 'res://addons/plugin/plugin.gd', 'read')).toEqual({
      input: 'res://addons/plugin/plugin.gd',
      relPath: 'addons/plugin/plugin.gd',
      absPath: join(projectDir, 'addons', 'plugin', 'plugin.gd'),
      resPath: 'res://addons/plugin/plugin.gd',
    });
  });

  it('a write through the same link is refused', () => {
    const { projectDir } = linkedOut();
    expect(resolveProjectPath(projectDir, 'addons/plugin/plugin.gd', 'write')).toBeNull();
    expect(resolveProjectPath(projectDir, 'addons/plugin/new.tscn', 'write')).toBeNull();
  });

  it('a read is still held to the project by its spelling and to the name rules', () => {
    const { projectDir } = linkedOut();
    expect(resolveProjectPath(projectDir, '../outside.gd', 'read')).toBeNull();
    expect(resolveProjectPath(projectDir, 'addons/plugin/../../../x.gd', 'read')).toBeNull();
    expect(resolveProjectPath(projectDir, 'addons/plugin/a.gd.', 'read')).toBeNull();
    expect(resolveProjectPath(projectDir, 'addons/plugin/NUL', 'read')).toBeNull();
  });
});

describe('resolveProjectPath and Windows device names', () => {
  const project = resolve('/project');

  it.each([
    'NUL',
    'nul',
    'CON',
    'PRN',
    'AUX',
    'COM1',
    'com9.gd',
    'LPT1.tscn',
    'NUL.tar.gz',
    'a/NUL/b.gd',
    'a\\con\\b.gd',
    'res://scenes/aux.tscn',
    'CONIN$',
    'COM².gd',
    'NUL .gd',
  ])('refuses %j for a read and for a write', (path) => {
    expect(resolveProjectPath(project, path, 'read')).toBeNull();
    expect(resolveProjectPath(project, path, 'write')).toBeNull();
  });

  it.each([
    'null.gd',
    'console.gd',
    'COM10.gd',
    'com.gd',
    'a.nul',
    'my_con.tscn',
    'LPT0.gd',
    'auxiliary/x.gd',
  ])('accepts %j, which only resembles one', (path) => {
    expect(resolveProjectPath(project, path, 'read')).not.toBeNull();
  });
});

describe('fileIdentityKey', () => {
  const upper = resolve('project', 'Scenes', 'Main.tscn');
  const lower = resolve('project', 'scenes', 'main.tscn');

  it.each(['win32', 'darwin'] as const)('folds case on %s, where it names one file', (platform) => {
    expect(fileIdentityKey(upper, platform)).toBe(fileIdentityKey(lower, platform));
  });

  it('keeps case on linux, where the two names are two files', () => {
    expect(fileIdentityKey(upper, 'linux')).not.toBe(fileIdentityKey(lower, 'linux'));
    expect(fileIdentityKey(upper, 'linux')).toBe(fileIdentityKey(upper, 'linux'));
  });

  it('gives one key for a relative and an absolute spelling, with forward slashes', () => {
    const key = fileIdentityKey(join('project', 'scenes', 'main.tscn'), 'linux');
    expect(key).toBe(fileIdentityKey(lower, 'linux'));
    expect(key).not.toContain('\\');
  });
});

describe('validatePath', () => {
  it('rejects an empty path and a .. segment under either separator', () => {
    expect(validatePath('')).toBe(false);
    expect(validatePath('..')).toBe(false);
    expect(validatePath('a/../b')).toBe(false);
    expect(validatePath('a\\..\\b')).toBe(false);
    expect(validatePath('/games/..')).toBe(false);
  });

  it('accepts a name that merely contains two dots', () => {
    expect(validatePath('/games/my..game')).toBe(true);
    expect(validatePath('C:\\games\\..hidden\\proj')).toBe(true);
    expect(validatePath('a...b/c')).toBe(true);
  });
});

describe('isUnderDir', () => {
  const parent = resolve('/proj');

  it('is true for the directory itself and for a path beneath it', () => {
    expect(isUnderDir(parent, parent)).toBe(true);
    expect(isUnderDir(parent, join(parent, 'a', 'b.png'))).toBe(true);
    expect(isUnderDir(parent, join(parent, 'a', '..', 'b.png'))).toBe(true);
  });

  it('is false for a parent, a sibling and a sibling that shares the name as a prefix', () => {
    expect(isUnderDir(parent, resolve('/'))).toBe(false);
    expect(isUnderDir(parent, resolve('/other/x.png'))).toBe(false);
    expect(isUnderDir(parent, resolve('/proj-evil/x.png'))).toBe(false);
    expect(isUnderDir(resolve('/proj-evil'), join(parent, 'x.png'))).toBe(false);
    expect(isUnderDir(parent, join(parent, '..', 'proj-evil', 'x.png'))).toBe(false);
  });

  it('accepts a name beneath the directory that starts with two dots', () => {
    expect(isUnderDir(parent, join(parent, '..cache', 'x.png'))).toBe(true);
  });

  it.runIf(IS_WINDOWS)(
    'folds drive-letter and directory case on Windows, in both directions',
    () => {
      expect(isUnderDir('d:/my programs/game/.mcp', 'D:/My Programs/game/.mcp/x.png')).toBe(true);
      expect(isUnderDir('D:/My Programs/game/.mcp', 'd:/my programs/game/.mcp/x.png')).toBe(true);
      expect(
        isUnderDir('D:\\My Programs\\game\\.mcp', 'd:/my programs/GAME/.MCP/shots/x.png'),
      ).toBe(true);
      expect(isUnderDir('d:/my programs/game', 'D:/My Programs/game-evil/x.png')).toBe(false);
      expect(isUnderDir('d:/my programs/game', 'E:/My Programs/game/x.png')).toBe(false);
    },
  );

  it.runIf(IS_WINDOWS)('resolveProjectPath folds case the same way', () => {
    const resolved = resolveProjectPath(
      'D:/My Programs/game',
      'd:/my programs/GAME/scenes/a.tscn',
      'write',
    );
    expect(resolved?.relPath).toBe('scenes/a.tscn');
  });

  it.runIf(!IS_WINDOWS)('compares case exactly where the filesystem does', () => {
    expect(isUnderDir('/proj/.mcp', '/proj/.MCP/x.png')).toBe(false);
  });
});
