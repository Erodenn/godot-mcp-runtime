import { describe, it, expect } from 'vitest';
import { mkdirSync, symlinkSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { handleGetProjectFiles, handleListProjects } from '../../src/tools/project-tools.js';
import { expectErrorMatching } from '../helpers/assertions.js';
import { expectMatchesOutputSchema } from '../helpers/schema-assert.js';
import { useTmpDirs } from '../helpers/tmp.js';

const tmp = useTmpDirs();

interface Node {
  name: string;
  type: 'file' | 'dir' | 'link';
  path: string;
  children?: Node[] | null;
}

function put(root: string, rel: string, content = ''): void {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

function paths(node: Node): string[] {
  return [node.path, ...(node.children ?? []).flatMap(paths)];
}

function makeTree(): string {
  const dir = tmp.makeProject('mcp-scope-');
  put(dir, 'ui/themes/dark.tres');
  put(dir, 'ui/themes/deep/more.tres');
  put(dir, 'ui/art/icon.png');
  put(dir, 'ui/menu.tscn');
  put(dir, 'scripts/a.gd');
  mkdirSync(join(dir, 'empty'), { recursive: true });
  return dir;
}

describe('get_project_files subfolder', () => {
  // Red when the subfolder argument is ignored: the root listing returns.
  it('lists the named folder as the root, with project-relative paths', async () => {
    const dir = makeTree();
    const payload = expectMatchesOutputSchema(
      'get_project_files',
      await handleGetProjectFiles({ projectPath: dir, subfolder: 'ui/themes' }),
    ) as unknown as Node;
    expect(payload.name).toBe('themes');
    expect(payload.path).toBe('ui/themes');
    expect(paths(payload).sort()).toEqual([
      'ui/themes',
      'ui/themes/dark.tres',
      'ui/themes/deep',
      'ui/themes/deep/more.tres',
    ]);
  });

  it('accepts a res:// spelling and counts maxDepth from the subfolder', async () => {
    const dir = makeTree();
    const payload = expectMatchesOutputSchema(
      'get_project_files',
      await handleGetProjectFiles({ projectPath: dir, subfolder: 'res://ui', maxDepth: 1 }),
    ) as unknown as Node;
    expect(payload.path).toBe('ui');
    const themes = payload.children?.find((child) => child.name === 'themes');
    expect(themes?.children).toBeNull();
  });

  // Red when the subfolder skips resolveProjectPath containment.
  it.each(['..', '../outside', 'ui/../../outside', 'C:/Windows', '/etc', 'file:///x'])(
    'refuses %s',
    async (subfolder) => {
      const dir = makeTree();
      expectErrorMatching(
        await handleGetProjectFiles({ projectPath: dir, subfolder }),
        /Invalid subfolder/,
      );
    },
  );

  it('refuses a dot-prefixed segment, which the listing never shows', async () => {
    const dir = makeTree();
    mkdirSync(join(dir, '.mcp'), { recursive: true });
    expectErrorMatching(
      await handleGetProjectFiles({ projectPath: dir, subfolder: '.mcp' }),
      /Invalid subfolder/,
    );
  });

  it('refuses a missing folder and a file', async () => {
    const dir = makeTree();
    expectErrorMatching(
      await handleGetProjectFiles({ projectPath: dir, subfolder: 'nope' }),
      /not a directory/,
    );
    expectErrorMatching(
      await handleGetProjectFiles({ projectPath: dir, subfolder: 'ui/menu.tscn' }),
      /not a directory/,
    );
  });

  it('refuses a link that leaves the project only when the spelling does; a path through an in-project spelling is read', async () => {
    const dir = makeTree();
    const outside = tmp.make('mcp-outside-');
    put(outside, 'x.gd');
    try {
      symlinkSync(outside, join(dir, 'linked'), 'junction');
    } catch {
      return;
    }
    const payload = expectMatchesOutputSchema(
      'get_project_files',
      await handleGetProjectFiles({ projectPath: dir, subfolder: 'linked' }),
    ) as unknown as Node;
    expect(payload.path).toBe('linked');
  });
});

describe('get_project_files extension filter pruning', () => {
  // Red when a directory with no match stays under a filter.
  it('drops directories that hold no matching file at any depth', async () => {
    const dir = makeTree();
    const payload = expectMatchesOutputSchema(
      'get_project_files',
      await handleGetProjectFiles({ projectPath: dir, extensions: ['tres'] }),
    ) as unknown as Node;
    expect(paths(payload).sort()).toEqual([
      '.',
      'ui',
      'ui/themes',
      'ui/themes/dark.tres',
      'ui/themes/deep',
      'ui/themes/deep/more.tres',
    ]);
  });

  it('keeps the root with empty children when nothing matches', async () => {
    const dir = makeTree();
    const payload = expectMatchesOutputSchema(
      'get_project_files',
      await handleGetProjectFiles({ projectPath: dir, extensions: ['xyz'] }),
    ) as unknown as Node;
    expect(payload.children).toEqual([]);
  });

  it('keeps an empty directory when no filter is set', async () => {
    const dir = makeTree();
    const payload = expectMatchesOutputSchema(
      'get_project_files',
      await handleGetProjectFiles({ projectPath: dir }),
    ) as unknown as Node;
    expect(paths(payload)).toContain('empty');
  });

  it('keeps a directory cut by maxDepth, whose content is unknown', async () => {
    const dir = makeTree();
    const payload = expectMatchesOutputSchema(
      'get_project_files',
      await handleGetProjectFiles({ projectPath: dir, extensions: ['tres'], maxDepth: 1 }),
    ) as unknown as Node;
    const ui = payload.children?.find((child) => child.name === 'ui');
    expect(ui?.children).toBeNull();
  });
});

describe('list_projects name', () => {
  // Red when the name is the folder name again.
  it('reports config/name, with the folder visible in projectPath', async () => {
    const parent = tmp.make('mcp-names-');
    put(
      parent,
      'folder-a/project.godot',
      'config_version=5\n\n[application]\n\nconfig/name="Pretty Name"\n',
    );
    put(parent, 'folder-b/project.godot', 'config_version=5\n');
    put(parent, 'folder-c/project.godot', 'config_version=5\n\n[application]\n\nconfig/name=""\n');
    const payload = expectMatchesOutputSchema(
      'list_projects',
      await handleListProjects({ directory: parent }),
    ) as unknown as { projects: Array<{ projectPath: string; name: string }> };
    const byPath = new Map(payload.projects.map((p) => [p.projectPath, p.name]));
    expect(byPath.get(resolve(parent, 'folder-a'))).toBe('Pretty Name');
    expect(byPath.get(resolve(parent, 'folder-b'))).toBe('folder-b');
    expect(byPath.get(resolve(parent, 'folder-c'))).toBe('folder-c');
  });

  it('reports config/name for the searched directory itself and for recursive hits', async () => {
    const parent = tmp.make('mcp-names-root-');
    put(parent, 'project.godot', '[application]\n\nconfig/name="Root Game"\n');
    put(parent, 'deep/er/project.godot', '[application]\n\nconfig/name="Nested"\n');
    const payload = expectMatchesOutputSchema(
      'list_projects',
      await handleListProjects({ directory: parent, recursive: true }),
    ) as unknown as { projects: Array<{ projectPath: string; name: string }> };
    expect(payload.projects.map((p) => p.name).sort()).toEqual(['Nested', 'Root Game']);
  });
});
