import { describe, it, expect, vi } from 'vitest';
import type * as fsModule from 'fs';
import { mkdirSync, symlinkSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import {
  handleCheckProject,
  handleGetProjectFiles,
  handleListProjects,
  handleSearchProject,
} from '../../src/tools/project-tools.js';
import { createFakeRunner } from '../helpers/fake-runner.js';
import { expectErrorMatching, unwrap } from '../helpers/assertions.js';
import { expectMatchesOutputSchema } from '../helpers/schema-assert.js';
import { useTmpDirs } from '../helpers/tmp.js';

const UNREADABLE_DIR_MARKER = 'unreadable_dir';
const UNREADABLE_FILE_MARKER = 'unreadable_file';

function accessDenied(path: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`EACCES: permission denied, '${path}'`);
  error.code = 'EACCES';
  return error;
}

// Pass everything through to the real fs except two marker names, so the walkers
// meet a directory and a file that exist but cannot be read.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fsModule>();
  return {
    ...actual,
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => {
      if (String(args[0]).includes(UNREADABLE_DIR_MARKER)) throw accessDenied(String(args[0]));
      return (actual.readdirSync as (...a: unknown[]) => unknown)(...args);
    },
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (String(args[0]).includes(UNREADABLE_FILE_MARKER)) throw accessDenied(String(args[0]));
      return (actual.readFileSync as (...a: unknown[]) => unknown)(...args);
    },
  };
});

const tmp = useTmpDirs();

function parseText<T>(result: unknown): T {
  const text = unwrap(result).content[0]?.text;
  if (text === undefined) throw new Error('Expected a text content entry');
  return JSON.parse(text);
}

function makeProjectWithUnreadableDir(): string {
  const dir = tmp.makeProject('mcp-walk-');
  mkdirSync(join(dir, UNREADABLE_DIR_MARKER), { recursive: true });
  writeFileSync(join(dir, UNREADABLE_DIR_MARKER, 'hidden.gd'), 'var needle\n', 'utf8');
  writeFileSync(join(dir, 'ok.gd'), 'var needle\n', 'utf8');
  return dir;
}

const UNREADABLE_DIR_WARNING = new RegExp(
  `1 path\\(s\\) could not be read and are missing from this result: .*${UNREADABLE_DIR_MARKER} \\(EACCES\\)`,
);

describe('project walkers report what they could not read', () => {
  it('an unreadable subdirectory is reported by get_project_files, search_project, check_project and list_projects', async () => {
    const dir = makeProjectWithUnreadableDir();

    const files = await handleGetProjectFiles({ projectPath: dir });
    expectMatchesOutputSchema('get_project_files', files);
    const tree = parseText<{
      warnings?: string[];
      children: Array<{ name: string; children?: unknown[] | null }>;
    }>(files);
    expect(Object.keys(tree)[0]).toBe('warnings');
    expect(tree.warnings?.[0]).toMatch(UNREADABLE_DIR_WARNING);
    expect(tree.children.find((c) => c.name === UNREADABLE_DIR_MARKER)?.children).toBeNull();

    const search = await handleSearchProject({ projectPath: dir, pattern: 'needle' });
    expectMatchesOutputSchema('search_project', search);
    const found = parseText<{ warnings?: string[]; matches: unknown[] }>(search);
    expect(Object.keys(found)[0]).toBe('warnings');
    expect(found.warnings?.[0]).toMatch(UNREADABLE_DIR_WARNING);
    expect(found.matches).toHaveLength(1);

    const runner = createFakeRunner({ godotVersion: '4.4.stable' }).asRunner;
    const check = await handleCheckProject(runner, { projectPath: dir });
    expectMatchesOutputSchema('check_project', check);
    const checked = parseText<{ warnings?: string[]; structure: { scripts: number } }>(check);
    expect(Object.keys(checked)[0]).toBe('warnings');
    expect(checked.warnings?.[0]).toMatch(UNREADABLE_DIR_WARNING);
    expect(checked.structure.scripts).toBe(1);

    const listed = await handleListProjects({ directory: dir, recursive: true });
    expectMatchesOutputSchema('list_projects', listed);
    const projects = parseText<{ warnings?: string[]; projects: unknown[] }>(listed);
    expect(Object.keys(projects)[0]).toBe('warnings');
    expect(projects.warnings?.[0]).toMatch(UNREADABLE_DIR_WARNING);
    expect(projects.projects).toHaveLength(1);
  });

  it('search_project does not say an extension is absent from a project it could not read in full', async () => {
    // hidden.gd sits in the unreadable directory, so "no .gdscript file exists
    // under the project" is not something this walk can know.
    const dir = makeProjectWithUnreadableDir();
    const result = await handleSearchProject({
      projectPath: dir,
      pattern: 'needle',
      fileTypes: ['gdscript'],
    });
    const parsed = parseText<{ warnings?: string[]; filesSearched: number }>(result);
    expect(parsed.filesSearched).toBe(0);
    expect(parsed.warnings).toHaveLength(2);
    expect(parsed.warnings?.[0]).toMatch(
      /No file with extension\(s\) gdscript was found in the part of the project that could be read/,
    );
    expect(parsed.warnings?.[0]).not.toMatch(/exists under the project/);
    expect(parsed.warnings?.[1]).toMatch(UNREADABLE_DIR_WARNING);
  });

  it('an unreadable file is reported by search_project', async () => {
    const dir = tmp.makeProject('mcp-walk-file-');
    writeFileSync(join(dir, `${UNREADABLE_FILE_MARKER}.gd`), 'var needle\n', 'utf8');
    writeFileSync(join(dir, 'ok.gd'), 'var needle\n', 'utf8');
    const result = await handleSearchProject({ projectPath: dir, pattern: 'needle' });
    const parsed = parseText<{
      warnings?: string[];
      matches: Array<{ file: string }>;
      filesSearched: number;
    }>(result);
    expect(Object.keys(parsed)[0]).toBe('warnings');
    expect(parsed.warnings?.[0]).toMatch(
      new RegExp(`1 path\\(s\\) could not be read.*${UNREADABLE_FILE_MARKER}\\.gd \\(EACCES\\)`),
    );
    expect(parsed.matches.map((m) => m.file)).toEqual(['ok.gd']);
    expect(parsed.filesSearched).toBe(1);
  });

  it('a link is listed as a link node and reported, not followed', async () => {
    const dir = tmp.makeProject('mcp-walk-link-');
    const target = tmp.make('mcp-walk-target-');
    writeFileSync(join(target, 'inside.gd'), 'var needle\n', 'utf8');
    writeFileSync(join(dir, 'ok.gd'), 'var other\n', 'utf8');
    symlinkSync(target, join(dir, 'shared_addon'), 'junction');

    const files = await handleGetProjectFiles({ projectPath: dir });
    expectMatchesOutputSchema('get_project_files', files);
    const tree = parseText<{
      warnings?: string[];
      children: Array<{ name: string; type: string; path: string; children?: unknown }>;
    }>(files);
    expect(tree.children).toContainEqual({
      name: 'shared_addon',
      type: 'link',
      path: 'shared_addon',
    });
    expect(Object.keys(tree)[0]).toBe('warnings');
    expect(tree.warnings?.[0]).toMatch(
      /1 symbolic link\(s\) or junction\(s\) were not followed: shared_addon/,
    );

    const search = await handleSearchProject({ projectPath: dir, pattern: 'needle' });
    const found = parseText<{ warnings?: string[]; matches: unknown[] }>(search);
    expect(found.matches).toEqual([]);
    expect(found.warnings?.[0]).toMatch(/1 symbolic link\(s\) or junction\(s\) were not followed/);
  });

  it('more than five problems are counted and the list is capped', async () => {
    const dir = tmp.makeProject('mcp-walk-many-');
    const total = 7;
    for (let i = 0; i < total; i++) {
      writeFileSync(join(dir, `${UNREADABLE_FILE_MARKER}${i}.gd`), 'var needle\n', 'utf8');
    }
    const result = await handleSearchProject({ projectPath: dir, pattern: 'needle' });
    const parsed = parseText<{ warnings?: string[] }>(result);
    expect(parsed.warnings?.[0]).toMatch(/^7 path\(s\) could not be read/);
    expect(parsed.warnings?.[0]).toMatch(/\+2 more$/);
  });

  it('list_projects on a path that is not a directory is an error', async () => {
    const dir = tmp.make('mcp-walk-notdir-');
    const file = join(dir, 'plain.txt');
    writeFileSync(file, 'text', 'utf8');
    expectErrorMatching(await handleListProjects({ directory: file }), /not a directory/i);
  });

  it('list_projects on an unreadable directory is an error, not an empty list', async () => {
    const dir = tmp.make('mcp-walk-root-');
    const unreadable = join(dir, UNREADABLE_DIR_MARKER);
    mkdirSync(unreadable, { recursive: true });
    expectErrorMatching(
      await handleListProjects({ directory: resolve(unreadable) }),
      /could not read directory/i,
    );
  });
});
