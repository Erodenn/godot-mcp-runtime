import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { join, sep } from 'path';
import { tmpdir } from 'os';
import {
  handleListAutoloads,
  handleAddAutoload,
  handleRemoveAutoload,
  handleUpdateAutoload,
  handleGetProjectFiles,
  handleSearchProject,
  handleGetSceneDependencies,
  handleGetProjectSettings,
  handleListProjects,
} from '../../../src/tools/project-tools.js';
import { fixtureProjectPath } from '../../helpers/fixture-paths.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasError(result: unknown): boolean {
  return typeof result === 'object' && result !== null && 'isError' in result;
}

/** Create a minimal tmp Godot project (project.godot only). */
function makeTmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-test-'));
  writeFileSync(join(dir, 'project.godot'), 'config_version=5\n', 'utf8');
  return dir;
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
    expect(hasError(result)).toBe(true);
  });

  it('rejects projectPath containing ..', async () => {
    const result = await handleListAutoloads({ projectPath: '../evil' });
    expect(hasError(result)).toBe(true);
  });

  it('rejects nonexistent project directory', async () => {
    const result = await handleListAutoloads({ projectPath: '/does/not/exist' });
    expect(hasError(result)).toBe(true);
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
    expect(hasError(result)).toBe(true);
  });

  it('rejects projectPath containing ..', async () => {
    const result = await handleAddAutoload({
      projectPath: '../evil',
      autoloadName: 'MyManager',
      autoloadPath: 'autoload/my.gd',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects nonexistent project', async () => {
    const result = await handleAddAutoload({
      projectPath: '/ghost',
      autoloadName: 'MyManager',
      autoloadPath: 'autoload/my.gd',
    });
    expect(hasError(result)).toBe(true);
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

  it('registers autoload in a fresh tmp project', async () => {
    const dir = makeTmpProject();
    const result = await handleAddAutoload({
      projectPath: dir,
      autoloadName: 'TestManager',
      autoloadPath: 'scripts/test.gd',
    });
    expect(hasError(result)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleRemoveAutoload
// ---------------------------------------------------------------------------

describe('handleRemoveAutoload', () => {
  it('rejects missing projectPath', async () => {
    const result = await handleRemoveAutoload({ autoloadName: 'MyManager' });
    expect(hasError(result)).toBe(true);
  });

  it('rejects projectPath containing ..', async () => {
    const result = await handleRemoveAutoload({
      projectPath: '../evil',
      autoloadName: 'MyManager',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects nonexistent project', async () => {
    const result = await handleRemoveAutoload({
      projectPath: '/ghost',
      autoloadName: 'MyManager',
    });
    expect(hasError(result)).toBe(true);
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

  it('removes an existing autoload in a tmp project', async () => {
    const dir = makeTmpProjectWithAutoload('TestManager', 'scripts/test.gd');
    const result = await handleRemoveAutoload({ projectPath: dir, autoloadName: 'TestManager' });
    expect(hasError(result)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleUpdateAutoload
// ---------------------------------------------------------------------------

describe('handleUpdateAutoload', () => {
  it('rejects missing projectPath', async () => {
    const result = await handleUpdateAutoload({ autoloadName: 'MyManager' });
    expect(hasError(result)).toBe(true);
  });

  it('rejects projectPath containing ..', async () => {
    const result = await handleUpdateAutoload({
      projectPath: '../evil',
      autoloadName: 'MyManager',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects nonexistent project', async () => {
    const result = await handleUpdateAutoload({
      projectPath: '/ghost',
      autoloadName: 'MyManager',
    });
    expect(hasError(result)).toBe(true);
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

  it('updates an existing autoload in a tmp project', async () => {
    const dir = makeTmpProjectWithAutoload('TestManager', 'scripts/old.gd');
    const result = await handleUpdateAutoload({
      projectPath: dir,
      autoloadName: 'TestManager',
      autoloadPath: 'scripts/new.gd',
    });
    expect(hasError(result)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleGetProjectFiles
// ---------------------------------------------------------------------------

describe('handleGetProjectFiles', () => {
  it('rejects missing projectPath', async () => {
    const result = await handleGetProjectFiles({});
    expect(hasError(result)).toBe(true);
  });

  it('rejects projectPath containing ..', async () => {
    const result = await handleGetProjectFiles({ projectPath: '../evil' });
    expect(hasError(result)).toBe(true);
  });

  it('rejects nonexistent project', async () => {
    const result = await handleGetProjectFiles({ projectPath: '/ghost' });
    expect(hasError(result)).toBe(true);
  });

  it('returns file tree for valid project', async () => {
    const result = await handleGetProjectFiles({ projectPath: fixtureProjectPath });
    expect(hasError(result)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleSearchProject
// ---------------------------------------------------------------------------

describe('handleSearchProject', () => {
  it('rejects missing projectPath', async () => {
    const result = await handleSearchProject({ pattern: 'Node2D' });
    expect(hasError(result)).toBe(true);
  });

  it('rejects projectPath containing ..', async () => {
    const result = await handleSearchProject({ projectPath: '../evil', pattern: 'Node2D' });
    expect(hasError(result)).toBe(true);
  });

  it('rejects nonexistent project', async () => {
    const result = await handleSearchProject({ projectPath: '/ghost', pattern: 'Node2D' });
    expect(hasError(result)).toBe(true);
  });

  it('rejects missing pattern', async () => {
    const result = await handleSearchProject({ projectPath: fixtureProjectPath });
    expect(hasError(result)).toBe(true);
  });

  it('returns results for valid project and pattern', async () => {
    const result = await handleSearchProject({
      projectPath: fixtureProjectPath,
      pattern: 'Node2D',
    });
    expect(hasError(result)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleGetSceneDependencies
// ---------------------------------------------------------------------------

describe('handleGetSceneDependencies', () => {
  it('rejects missing projectPath', async () => {
    const result = await handleGetSceneDependencies({ scenePath: 'main.tscn' });
    expect(hasError(result)).toBe(true);
  });

  it('rejects projectPath containing ..', async () => {
    const result = await handleGetSceneDependencies({
      projectPath: '../evil',
      scenePath: 'main.tscn',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects nonexistent project', async () => {
    const result = await handleGetSceneDependencies({
      projectPath: '/ghost',
      scenePath: 'main.tscn',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects missing scenePath', async () => {
    const result = await handleGetSceneDependencies({ projectPath: fixtureProjectPath });
    expect(hasError(result)).toBe(true);
  });

  it('rejects scenePath containing ..', async () => {
    const result = await handleGetSceneDependencies({
      projectPath: fixtureProjectPath,
      scenePath: '../outside.tscn',
    });
    expect(hasError(result)).toBe(true);
  });

  it('returns isError when scene file does not exist', async () => {
    const result = await handleGetSceneDependencies({
      projectPath: fixtureProjectPath,
      scenePath: 'nonexistent.tscn',
    });
    expect(hasError(result)).toBe(true);
  });

  it('returns dependencies for the fixture main.tscn', async () => {
    const result = await handleGetSceneDependencies({
      projectPath: fixtureProjectPath,
      scenePath: 'main.tscn',
    });
    expect(hasError(result)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleGetProjectSettings
// ---------------------------------------------------------------------------

describe('handleGetProjectSettings', () => {
  it('rejects missing projectPath', async () => {
    const result = await handleGetProjectSettings({});
    expect(hasError(result)).toBe(true);
  });

  it('rejects projectPath containing ..', async () => {
    const result = await handleGetProjectSettings({ projectPath: '../evil' });
    expect(hasError(result)).toBe(true);
  });

  it('rejects nonexistent project', async () => {
    const result = await handleGetProjectSettings({ projectPath: '/ghost' });
    expect(hasError(result)).toBe(true);
  });

  it('returns settings for valid project', async () => {
    const result = await handleGetProjectSettings({ projectPath: fixtureProjectPath });
    expect(hasError(result)).toBe(false);
  });

  it('returns filtered section when section is provided', async () => {
    const result = await handleGetProjectSettings({
      projectPath: fixtureProjectPath,
      section: 'application',
    });
    expect(hasError(result)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleListProjects
// ---------------------------------------------------------------------------

describe('handleListProjects', () => {
  it('rejects missing directory', async () => {
    const result = await handleListProjects({});
    expect(hasError(result)).toBe(true);
  });

  it('rejects directory containing ..', async () => {
    const result = await handleListProjects({ directory: '../evil' });
    expect(hasError(result)).toBe(true);
  });

  it('rejects nonexistent directory', async () => {
    const result = await handleListProjects({ directory: '/ghost/path' });
    expect(hasError(result)).toBe(true);
  });

  it('returns a list (possibly empty) for a valid directory', async () => {
    // Use the OS tmp dir — it exists and has no Godot projects.
    const result = await handleListProjects({ directory: tmpdir() });
    expect(hasError(result)).toBe(false);
  });

  it('finds a project in a tmp dir that contains one', async () => {
    const dir = makeTmpProject();
    // parentDir is the dir that contains dir
    const parentDir = join(dir, '..').replace(/[/\\]$/, '');
    const projectName = dir.split(sep).pop()!;
    const result = await handleListProjects({ directory: parentDir });
    expect(hasError(result)).toBe(false);
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain(projectName);
  });
});
