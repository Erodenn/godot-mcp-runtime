import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'fs';
import { join, sep } from 'path';
import {
  handleGetProjectFiles,
  handleSearchProject,
  handleGetSceneDependencies,
  handleGetProjectSettings,
  handleGetProjectInfo,
  handleListProjects,
} from '../../../src/tools/project-tools.js';
import { createFakeRunner } from '../../helpers/fake-runner.js';
import { hasError, expectErrorMatching } from '../../helpers/assertions.js';
import { fixtureProjectPath } from '../../helpers/fixture-paths.js';
import { useTmpDirs } from '../../helpers/tmp.js';

interface TextResponse {
  content: Array<{ text: string }>;
}
function parseText<T>(result: unknown): T {
  return JSON.parse((result as TextResponse).content[0].text);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmp = useTmpDirs();

/** Create a minimal tmp Godot project (project.godot only). */
function makeTmpProject(): string {
  return tmp.makeProject('mcp-test-');
}

/** Create an empty tmp directory (no project.godot inside). */
function makeTmpEmptyDir(): string {
  return tmp.make('mcp-empty-');
}

// ---------------------------------------------------------------------------
// handleGetProjectFiles
// ---------------------------------------------------------------------------

describe('handleGetProjectFiles', () => {
  it('rejects missing projectPath', async () => {
    const result = await handleGetProjectFiles({});
    expectErrorMatching(result, /projectPath/i);
  });

  it('rejects projectPath containing ..', async () => {
    const result = await handleGetProjectFiles({ projectPath: '../evil' });
    expectErrorMatching(result, /invalid project path/i);
  });

  it('rejects nonexistent project', async () => {
    const result = await handleGetProjectFiles({ projectPath: '/ghost' });
    expectErrorMatching(result, /not a valid godot project/i);
  });

  it('returns file tree for valid project', async () => {
    const result = await handleGetProjectFiles({ projectPath: fixtureProjectPath });
    expect(hasError(result)).toBe(false);
  });

  it('filters the tree to the requested extensions', async () => {
    const result = await handleGetProjectFiles({
      projectPath: fixtureProjectPath,
      extensions: ['gd'],
    });
    interface Node {
      type: 'file' | 'dir';
      extension?: string;
      children?: Node[];
    }
    const tree = parseText<Node>(result);
    const collectFiles = (n: Node): Node[] => {
      if (n.type === 'file') return [n];
      return (n.children ?? []).flatMap(collectFiles);
    };
    const files = collectFiles(tree);
    // Fixture has placeholder.gd but not, e.g., main.tscn at extension=gd.
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(f.extension).toBe('gd');
    }
  });
});

// ---------------------------------------------------------------------------
// handleSearchProject
// ---------------------------------------------------------------------------

describe('handleSearchProject', () => {
  it('rejects missing projectPath', async () => {
    const result = await handleSearchProject({ pattern: 'Node2D' });
    expectErrorMatching(result, /projectPath/i);
  });

  it('rejects projectPath containing ..', async () => {
    const result = await handleSearchProject({ projectPath: '../evil', pattern: 'Node2D' });
    expectErrorMatching(result, /invalid project path/i);
  });

  it('rejects nonexistent project', async () => {
    const result = await handleSearchProject({ projectPath: '/ghost', pattern: 'Node2D' });
    expectErrorMatching(result, /not a valid godot project/i);
  });

  it('rejects missing pattern', async () => {
    const result = await handleSearchProject({ projectPath: fixtureProjectPath });
    expect(hasError(result)).toBe(true);
  });

  it('returns matches with {file, lineNumber, line} shape and the line contains the pattern', async () => {
    const result = await handleSearchProject({
      projectPath: fixtureProjectPath,
      pattern: 'Node2D',
    });
    const parsed = parseText<{
      matches: Array<{ file: string; lineNumber: number; line: string }>;
      truncated: boolean;
    }>(result);
    expect(parsed.matches.length).toBeGreaterThan(0);
    for (const m of parsed.matches) {
      expect(typeof m.file).toBe('string');
      expect(typeof m.lineNumber).toBe('number');
      expect(m.lineNumber).toBeGreaterThan(0);
      expect(m.line).toContain('Node2D');
    }
  });

  it('respects maxResults and reports truncated:true when hit', async () => {
    const result = await handleSearchProject({
      projectPath: fixtureProjectPath,
      pattern: 'node', // case-insensitive default — many matches
      maxResults: 1,
    });
    const parsed = parseText<{ matches: unknown[]; truncated: boolean }>(result);
    expect(parsed.matches).toHaveLength(1);
    expect(parsed.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleGetSceneDependencies
// ---------------------------------------------------------------------------

describe('handleGetSceneDependencies', () => {
  it('rejects missing projectPath', async () => {
    const result = await handleGetSceneDependencies({ scenePath: 'main.tscn' });
    expectErrorMatching(result, /projectPath/i);
  });

  it('rejects projectPath containing ..', async () => {
    const result = await handleGetSceneDependencies({
      projectPath: '../evil',
      scenePath: 'main.tscn',
    });
    expectErrorMatching(result, /invalid project path/i);
  });

  it('rejects nonexistent project', async () => {
    const result = await handleGetSceneDependencies({
      projectPath: '/ghost',
      scenePath: 'main.tscn',
    });
    expectErrorMatching(result, /not a valid godot project/i);
  });

  it('rejects missing scenePath', async () => {
    const result = await handleGetSceneDependencies({ projectPath: fixtureProjectPath });
    expectErrorMatching(result, /scenePath/i);
  });

  it('rejects scenePath containing ..', async () => {
    const result = await handleGetSceneDependencies({
      projectPath: fixtureProjectPath,
      scenePath: '../outside.tscn',
    });
    // handleGetSceneDependencies validates scenePath inline ("Invalid scenePath")
    // rather than via validateSceneArgs ("Invalid scene path") — match either.
    expectErrorMatching(result, /invalid scene\s?path/i);
  });

  it('returns isError when scene file does not exist', async () => {
    const result = await handleGetSceneDependencies({
      projectPath: fixtureProjectPath,
      scenePath: 'nonexistent.tscn',
    });
    expect(hasError(result)).toBe(true);
  });

  it('returns an empty dependencies array when the scene has no ext_resource entries', async () => {
    // The committed fixture's main.tscn has no ext_resource lines.
    const result = await handleGetSceneDependencies({
      projectPath: fixtureProjectPath,
      scenePath: 'main.tscn',
    });
    const parsed = parseText<{ scene: string; dependencies: unknown[] }>(result);
    expect(parsed.scene).toBe('main.tscn');
    expect(parsed.dependencies).toEqual([]);
  });

  it('parses ext_resource entries with type, path, and uid attributes', async () => {
    const dir = tmp.makeProject('deps-');
    const tscn = [
      '[gd_scene load_steps=3 format=3]',
      '',
      '[ext_resource type="Script" path="res://scripts/player.gd" id="1_abc"]',
      '[ext_resource type="Texture2D" uid="uid://abc123" path="res://art/hero.png" id="2_def"]',
      '',
      '[node name="Root" type="Node2D"]',
      '',
    ].join('\n');
    writeFileSync(join(dir, 'level.tscn'), tscn, 'utf8');

    const result = await handleGetSceneDependencies({
      projectPath: dir,
      scenePath: 'level.tscn',
    });
    const parsed = parseText<{
      scene: string;
      dependencies: Array<{ path: string; type: string; uid?: string }>;
    }>(result);
    expect(parsed.dependencies).toEqual([
      { path: 'scripts/player.gd', type: 'Script' },
      { path: 'art/hero.png', type: 'Texture2D', uid: 'uid://abc123' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// handleGetProjectSettings
// ---------------------------------------------------------------------------

describe('handleGetProjectSettings', () => {
  it('rejects missing projectPath', async () => {
    const result = await handleGetProjectSettings({});
    expectErrorMatching(result, /projectPath/i);
  });

  it('rejects projectPath containing ..', async () => {
    const result = await handleGetProjectSettings({ projectPath: '../evil' });
    expectErrorMatching(result, /invalid project path/i);
  });

  it('rejects nonexistent project', async () => {
    const result = await handleGetProjectSettings({ projectPath: '/ghost' });
    expectErrorMatching(result, /not a valid godot project/i);
  });

  it('returns the full settings tree grouped by section for the fixture', async () => {
    const result = await handleGetProjectSettings({ projectPath: fixtureProjectPath });
    const parsed = parseText<{ settings: Record<string, Record<string, unknown>> }>(result);
    expect(parsed.settings).toHaveProperty('application');
    expect(parsed.settings).toHaveProperty('rendering');
    expect(parsed.settings.application['config/name']).toBe('godot-mcp-runtime test fixture');
  });

  it('returns only the requested section keys, with no other-section keys leaking through', async () => {
    const result = await handleGetProjectSettings({
      projectPath: fixtureProjectPath,
      section: 'application',
    });
    const parsed = parseText<{ settings: Record<string, unknown> }>(result);
    expect(parsed.settings['config/name']).toBe('godot-mcp-runtime test fixture');
    expect(parsed.settings['run/main_scene']).toBe('res://main.tscn');
    // 'rendering' keys must NOT be present in a section-filtered response.
    expect(parsed.settings).not.toHaveProperty('renderer/rendering_method');
  });

  it('returns an empty settings object for an unknown section', async () => {
    const result = await handleGetProjectSettings({
      projectPath: fixtureProjectPath,
      section: 'no_such_section',
    });
    const parsed = parseText<{ settings: Record<string, unknown> }>(result);
    expect(parsed.settings).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// handleGetProjectInfo
// ---------------------------------------------------------------------------

describe('handleGetProjectInfo', () => {
  it('returns version-only payload when no projectPath is provided', async () => {
    const fake = createFakeRunner({ godotVersion: '4.4.1.stable.official' });
    const result = await handleGetProjectInfo(fake.asRunner, {});
    expect(hasError(result)).toBe(false);
    const parsed = parseText<{ godotVersion: string; name?: string; structure?: unknown }>(result);
    expect(parsed.godotVersion).toBe('4.4.1.stable.official');
    expect(parsed.name).toBeUndefined();
    expect(parsed.structure).toBeUndefined();
  });

  it('reads config/name from project.godot and reports it as the project name', async () => {
    const fake = createFakeRunner({ godotVersion: '4.4.stable' });
    const result = await handleGetProjectInfo(fake.asRunner, {
      projectPath: fixtureProjectPath,
    });
    const parsed = parseText<{
      name: string;
      path: string;
      godotVersion: string;
      structure: { scenes: number; scripts: number; assets: number; other: number };
    }>(result);
    expect(parsed.name).toBe('godot-mcp-runtime test fixture');
    expect(parsed.path).toBe(fixtureProjectPath);
    expect(parsed.godotVersion).toBe('4.4.stable');
    // The fixture has main.tscn (scene), placeholder.gd (script), placeholder.png (asset).
    expect(parsed.structure.scenes).toBeGreaterThanOrEqual(1);
    expect(parsed.structure.scripts).toBeGreaterThanOrEqual(1);
    expect(parsed.structure.assets).toBeGreaterThanOrEqual(1);
  });

  it('falls back to basename(projectPath) when project.godot has no config/name', async () => {
    const dir = tmp.makeProject('no-name-', 'config_version=5\n');
    const fake = createFakeRunner({ godotVersion: '4.3.stable' });
    const result = await handleGetProjectInfo(fake.asRunner, { projectPath: dir });
    const parsed = parseText<{ name: string }>(result);
    expect(parsed.name).toBe(dir.split(sep).pop());
  });

  it('rejects an invalid projectPath', async () => {
    const fake = createFakeRunner({ godotVersion: '4.3.stable' });
    expectErrorMatching(
      await handleGetProjectInfo(fake.asRunner, { projectPath: '../escape' }),
      /invalid project path/i,
    );
  });
});

// ---------------------------------------------------------------------------
// handleListProjects
// ---------------------------------------------------------------------------

describe('handleListProjects', () => {
  it('rejects missing directory', async () => {
    const result = await handleListProjects({});
    expectErrorMatching(result, /directory is required/i);
  });

  it('rejects directory containing ..', async () => {
    const result = await handleListProjects({ directory: '../evil' });
    expectErrorMatching(result, /invalid directory path/i);
  });

  it('rejects nonexistent directory', async () => {
    const result = await handleListProjects({ directory: '/ghost/path' });
    expectErrorMatching(result, /does not exist/i);
  });

  it('returns a list (possibly empty) for a valid directory', async () => {
    // Fresh empty dir — guarantees no ambient Godot projects scanned.
    const dir = makeTmpEmptyDir();
    const result = await handleListProjects({ directory: dir });
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
