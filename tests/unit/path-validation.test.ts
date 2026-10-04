import { describe, it, expect } from 'vitest';
import { resolve, sep, join } from 'path';
import { resolveProjectPath } from '../../src/utils/path-validation.js';

describe('resolveProjectPath', () => {
  const project = resolve('/project');

  function expectResolved(input: string, relPath: string) {
    const resolved = resolveProjectPath(project, input);
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
    expect(resolveProjectPath(project, '')).toBeNull();
    expect(resolveProjectPath(project, undefined as unknown as string)).toBeNull();
  });

  it('rejects paths containing ..', () => {
    expect(resolveProjectPath(project, '../etc/passwd')).toBeNull();
    expect(resolveProjectPath(project, 'foo/../../bar')).toBeNull();
    expect(resolveProjectPath(project, 'res://../x')).toBeNull();
  });

  it('rejects absolute paths outside the project', () => {
    expect(resolveProjectPath(project, '/etc/passwd')).toBeNull();
    expect(resolveProjectPath(project, resolve('/elsewhere/file.gd'))).toBeNull();
  });

  it('rejects a sibling directory that shares the project name as a prefix', () => {
    expect(resolveProjectPath(project, '../project-evil/file.gd')).toBeNull();
    expect(resolveProjectPath(project, resolve('/project-evil/file.gd'))).toBeNull();
  });

  it('rejects res:// on its own', () => {
    expect(resolveProjectPath(project, 'res://')).toBeNull();
  });

  it('rejects a second URI scheme', () => {
    expect(resolveProjectPath(project, 'res://res://x')).toBeNull();
    expect(resolveProjectPath(project, 'uid://abc')).toBeNull();
  });

  it('rejects the project root itself', () => {
    expect(resolveProjectPath(project, '.')).toBeNull();
    expect(resolveProjectPath(project, project)).toBeNull();
  });

  it('resolves under a filesystem-root project', () => {
    const root = resolve(sep);
    const resolved = resolveProjectPath(root, 'etc/passwd');
    expect(resolved).not.toBeNull();
    expect(resolved!.relPath).toBe('etc/passwd');
    expect(resolved!.absPath).toBe(resolve(root, 'etc/passwd'));
    expect(resolved!.resPath).toBe('res://etc/passwd');
    expect(resolveProjectPath(root, root)).toBeNull();
  });
});
