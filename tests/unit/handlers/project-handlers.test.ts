import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'fs';
import { join, resolve, sep } from 'path';
import {
  handleGetProjectFiles,
  handleSearchProject,
  handleGetSceneDependencies,
  handleGetProjectSettings,
  handleCheckProject,
  handleListProjects,
} from '../../../src/tools/project-tools.js';
import { createFakeRunner } from '../../helpers/fake-runner.js';
import { hasError, expectErrorMatching, unwrap } from '../../helpers/assertions.js';
import { fixtureProjectPath } from '../../helpers/fixture-paths.js';
import { expectMatchesOutputSchema } from '../../helpers/schema-assert.js';
import { useTmpDirs } from '../../helpers/tmp.js';

function parseText<T>(result: unknown): T {
  const text = unwrap(result).content[0]?.text;
  if (text === undefined) throw new Error('Expected a text content entry');
  return JSON.parse(text);
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
    const payload = expectMatchesOutputSchema('get_project_files', result);
    expect(payload.type).toBe('dir');
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
    expect(files.every((f) => f.extension === 'gd')).toBe(true);
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
    expect(
      parsed.matches.every(
        (m) =>
          typeof m.file === 'string' &&
          typeof m.lineNumber === 'number' &&
          m.lineNumber > 0 &&
          m.line.includes('Node2D'),
      ),
    ).toBe(true);
  });

  it('respects maxResults and reports truncated:true when hit', async () => {
    const result = await handleSearchProject({
      projectPath: fixtureProjectPath,
      // main.tscn has 3 [node ...] header lines matching 'node' case-insensitively;
      // maxResults:1 forces truncated:true.
      pattern: 'node',
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
    // rather than via parseSceneArgs ("Invalid scene path"): match either.
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
    const parsed = parseText<{ scenePath: string; dependencies: unknown[] }>(result);
    expect(parsed.scenePath).toBe('main.tscn');
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
      scenePath: string;
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
    expectMatchesOutputSchema('get_project_settings', result);
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
    const payload = expectMatchesOutputSchema('get_project_settings', result);
    expect(payload.section).toBe('application');
    expect(payload).not.toHaveProperty('warnings');
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
    const payload = expectMatchesOutputSchema('get_project_settings', result);
    expect(Object.keys(payload)[0]).toBe('warnings');
    expect(payload.warnings).toHaveLength(1);
    expect(payload.settings).toEqual({});
  });

  it('returns the whole multi-line value for a wrapped [input] action instead of just its first line', async () => {
    const projectGodot = [
      'config_version=5',
      '',
      '[input]',
      '',
      'jump={',
      '"deadzone": 0.5,',
      '"events": [Object(InputEventKey,"resource_local_to_scene":false,"resource_name":"","device":-1,"window_id":0,"alt_pressed":false,"shift_pressed":false,"ctrl_pressed":false,"meta_pressed":false,"pressed":false,"keycode":0,"physical_keycode":4194309,"key_label":0,"unicode":0,"echo":false,"script":null)',
      ']',
      '}',
      '',
      '[display]',
      '',
      'window/size/viewport_width=1920',
      '',
    ].join('\n');
    const projectPath = tmp.makeProject('mcp-multiline-settings-', projectGodot);

    const result = await handleGetProjectSettings({ projectPath, section: 'input' });
    const parsed = parseText<{ settings: Record<string, unknown> }>(result);
    const jump = parsed.settings.jump as string;

    expect(typeof jump).toBe('string');
    expect(jump).toContain('deadzone');
    expect(jump).toContain('events');
    expect(jump.endsWith('}')).toBe(true);

    // The scan must not run past the [input] section into [display].
    const allResult = await handleGetProjectSettings({ projectPath });
    const allParsed = parseText<{ settings: Record<string, Record<string, unknown>> }>(allResult);
    expect(allParsed.settings.display['window/size/viewport_width']).toBe(1920);
  });
});

// ---------------------------------------------------------------------------
// handleCheckProject
// ---------------------------------------------------------------------------

describe('handleCheckProject', () => {
  it('returns version-only payload plus an inactive runtime block when no projectPath is provided', async () => {
    const fake = createFakeRunner({ godotVersion: '4.4.1.stable.official' });
    const result = await handleCheckProject(fake.asRunner, {});
    expect(hasError(result)).toBe(false);
    const parsed = parseText<{
      godotVersion: string;
      name?: string;
      structure?: unknown;
      runtime: { activeSession: boolean };
    }>(result);
    expect(parsed.godotVersion).toBe('4.4.1.stable.official');
    expect(parsed.name).toBeUndefined();
    expect(parsed.structure).toBeUndefined();
    expect(parsed.runtime).toEqual({ activeSession: false, projectPath: null, liveSessions: [] });
  });

  it('reads config/name from project.godot and reports it as the project name', async () => {
    const fake = createFakeRunner({ godotVersion: '4.4.stable' });
    const result = await handleCheckProject(fake.asRunner, {
      projectPath: fixtureProjectPath,
    });
    expect(hasError(result)).toBe(false);
    const parsed = parseText<{
      name: string;
      projectPath: string;
      godotVersion: string;
      structure: { scenes: number; scripts: number; assets: number; other: number };
      runtime: { activeSession: boolean };
    }>(result);
    expect(parsed.name).toBe('godot-mcp-runtime test fixture');
    expect(parsed.projectPath).toBe(resolve(fixtureProjectPath));
    expect(parsed.godotVersion).toBe('4.4.stable');
    // The fixture has main.tscn (scene), placeholder.gd (script), placeholder.png (asset).
    expect(parsed.structure.scenes).toBeGreaterThanOrEqual(1);
    expect(parsed.structure.scripts).toBeGreaterThanOrEqual(1);
    expect(parsed.structure.assets).toBeGreaterThanOrEqual(1);
    // No runtime session was set on the fake runner.
    expect(parsed.runtime).toEqual({
      activeSession: false,
      projectPath: null,
      liveSessions: [],
      project: { projectPath: resolve(fixtureProjectPath), session: 'none', current: false },
    });
  });

  it('falls back to basename(projectPath) when project.godot has no config/name', async () => {
    const dir = tmp.makeProject('no-name-', 'config_version=5\n');
    const fake = createFakeRunner({ godotVersion: '4.3.stable' });
    const result = await handleCheckProject(fake.asRunner, { projectPath: dir });
    expect(hasError(result)).toBe(false);
    const parsed = parseText<{ name: string }>(result);
    expect(parsed.name).toBe(dir.split(sep).pop());
  });

  it('rejects an invalid projectPath', async () => {
    const fake = createFakeRunner({ godotVersion: '4.3.stable' });
    expectErrorMatching(
      await handleCheckProject(fake.asRunner, { projectPath: '../escape' }),
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
    // Fresh empty dir: guarantees no ambient Godot projects scanned.
    const dir = makeTmpEmptyDir();
    const result = await handleListProjects({ directory: dir });
    expect(hasError(result)).toBe(false);
    expect(expectMatchesOutputSchema('list_projects', result)).toEqual({ projects: [] });
  });

  it('finds a project in a tmp dir that contains one', async () => {
    const dir = makeTmpProject();
    // parentDir is the dir that contains dir
    const parentDir = join(dir, '..').replace(/[/\\]$/, '');
    const projectName = dir.split(sep).pop()!;
    const result = await handleListProjects({ directory: parentDir });
    expect(hasError(result)).toBe(false);
    const payload = expectMatchesOutputSchema('list_projects', result);
    expect(payload.projects).toContainEqual({ projectPath: resolve(dir), name: projectName });
  });

  it('descends into dot-prefixed project dirs that are not on the blacklist', async () => {
    // Regression: an earlier blanket dot-prefix exclusion silently dropped
    // legitimate projects whose directory name began with a dot. Only known
    // noise dirs (.git, .godot, .mcp, node_modules, .svn, .hg) should be skipped.
    const parent = makeTmpEmptyDir();
    const dotProject = join(parent, '.dot-project');
    mkdirSync(dotProject, { recursive: true });
    writeFileSync(join(dotProject, 'project.godot'), 'config_version=5\n', 'utf8');

    // Sibling .git dir is on the blacklist and must NOT be reported.
    const gitDir = join(parent, '.git');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, 'project.godot'), 'config_version=5\n', 'utf8');

    const result = await handleListProjects({ directory: parent });
    expect(hasError(result)).toBe(false);
    const text = unwrap(result).content[0].text;
    expect(text).toContain('.dot-project');
    expect(text).not.toContain('.git');
  });
});

describe('handleGetProjectSettings: section names are data, not object keys', () => {
  const PROTO_PROJECT =
    'config_version=5\n\n[__proto__]\npolluted="yes"\n\n[application]\nconfig/name="X"\n';

  it('a [__proto__] section does not reach Object.prototype and is returned as a section', async () => {
    const dir = tmp.makeProject('mcp-proto-', PROTO_PROJECT);
    const result = await handleGetProjectSettings({ projectPath: dir });
    expectMatchesOutputSchema('get_project_settings', result);
    const parsed = parseText<{ settings: Record<string, Record<string, unknown>> }>(result);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.hasOwn(parsed.settings, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(parsed.settings, '__proto__')?.value).toEqual({
      polluted: 'yes',
    });
    expect(Object.hasOwn(parsed.settings, 'application')).toBe(true);

    const filtered = await handleGetProjectSettings({ projectPath: dir, section: '__proto__' });
    const payload = expectMatchesOutputSchema('get_project_settings', filtered);
    expect(payload).not.toHaveProperty('warnings');
    expect(payload.settings).toEqual({ polluted: 'yes' });
  });

  it('a section filter named constructor reports the section as absent', async () => {
    const dir = tmp.makeProject('mcp-ctor-', PROTO_PROJECT);
    const result = await handleGetProjectSettings({ projectPath: dir, section: 'constructor' });
    const payload = expectMatchesOutputSchema('get_project_settings', result);
    expect(Object.keys(payload)[0]).toBe('warnings');
    expect(payload.warnings).toEqual([
      'Section "constructor" is not present in project.godot, so settings is empty',
    ]);
    expect(payload.settings).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// handleGetProjectSettings: values as Godot writes them
// ---------------------------------------------------------------------------

describe('handleGetProjectSettings: value lexing', () => {
  type SettingsPayload = {
    warnings?: string[];
    settings: Record<string, Record<string, unknown>>;
  };

  async function readSettings(projectGodot: string): Promise<SettingsPayload> {
    const projectPath = tmp.makeProject('mcp-lex-', projectGodot);
    const result = await handleGetProjectSettings({ projectPath });
    expectMatchesOutputSchema('get_project_settings', result);
    return parseText<SettingsPayload>(result);
  }

  it('a string value spanning two lines is returned whole and invents no key', async () => {
    const parsed = await readSettings(
      [
        'config_version=5',
        '',
        '[application]',
        '',
        'config/description="First line',
        'second line, speed=fast"',
        'config/name="Game"',
        '',
      ].join('\n'),
    );
    expect(parsed.settings.application['config/description']).toBe(
      'First line\nsecond line, speed=fast',
    );
    expect(parsed.settings.application).not.toHaveProperty('second line, speed');
    expect(parsed.settings.application['config/name']).toBe('Game');
    expect(parsed).not.toHaveProperty('warnings');
  });

  it('a dictionary value holding a string that ends in an escaped backslash does not swallow the keys after it', async () => {
    const parsed = await readSettings(
      [
        'config_version=5',
        '',
        '[application]',
        '',
        'custom/drives=["C:\\\\", "D:\\\\"]',
        'custom/after=7',
        'custom/paths={',
        String.raw`"root": "C:\\",`,
        '"extra": ["a", "b"]',
        '}',
        'config/name="Game"',
        '',
        '[display]',
        '',
        'window/size/viewport_width=1920',
        '',
      ].join('\n'),
    );
    expect(parsed.settings.application['custom/drives']).toBe(String.raw`["C:\\", "D:\\"]`);
    expect(parsed.settings.application['custom/after']).toBe(7);
    expect(parsed.settings.application['custom/paths']).toBe(
      ['{', String.raw`"root": "C:\\",`, '"extra": ["a", "b"]', '}'].join('\n'),
    );
    expect(parsed.settings.application['config/name']).toBe('Game');
    expect(parsed.settings.display['window/size/viewport_width']).toBe(1920);
    expect(parsed).not.toHaveProperty('warnings');
  });

  it('a section name with a hyphen is recognized', async () => {
    const parsed = await readSettings(
      [
        'config_version=5',
        '',
        '[application]',
        '',
        'config/name="Game"',
        '',
        '[my-addon]',
        '',
        'feature/enabled=true',
        '',
      ].join('\n'),
    );
    expect(parsed.settings['my-addon']).toEqual({ 'feature/enabled': true });
    expect(parsed.settings.application).not.toHaveProperty('feature/enabled');
  });

  it('an unterminated value is returned with a leading warning', async () => {
    const parsed = await readSettings(
      [
        'config_version=5',
        '',
        '[input]',
        '',
        'jump={',
        '"deadzone": 0.5,',
        '',
        '[display]',
        '',
        'window/size/viewport_width=1920',
        '',
      ].join('\n'),
    );
    expect(Object.keys(parsed)[0]).toBe('warnings');
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings?.[0]).toMatch(/input\/jump is unterminated/);
    expect(parsed.settings.input.jump).toBe('{\n"deadzone": 0.5,');
    expect(parsed.settings.display['window/size/viewport_width']).toBe(1920);
  });

  it('a line that cannot be parsed is counted in a leading warning', async () => {
    const parsed = await readSettings(
      [
        'config_version=5',
        '',
        '[application]',
        '',
        'this line has no equals sign',
        'config/name="Game"',
        'another stray line',
        '',
      ].join('\n'),
    );
    expect(Object.keys(parsed)[0]).toBe('warnings');
    expect(parsed.warnings).toEqual([
      '2 line(s) could not be parsed and were skipped; first: this line has no equals sign',
    ]);
    expect(parsed.settings.application['config/name']).toBe('Game');
  });

  it('an empty value is null with a warning', async () => {
    const parsed = await readSettings(
      ['config_version=5', '', '[application]', '', 'config/tags=', 'config/name="Game"', ''].join(
        '\n',
      ),
    );
    expect(parsed.settings.application['config/tags']).toBeNull();
    expect(Object.keys(parsed)[0]).toBe('warnings');
    expect(parsed.warnings).toEqual(['Value of application/config/tags is empty and is null']);
  });

  it('string escapes are unescaped', async () => {
    const parsed = await readSettings(
      [
        'config_version=5',
        '',
        '[application]',
        '',
        String.raw`config/name="My \"Game\" in C:\\games"`,
        String.raw`config/note="a \\ b"`,
        '',
      ].join('\n'),
    );
    expect(parsed.settings.application['config/name']).toBe('My "Game" in C:\\games');
    expect(parsed.settings.application['config/note']).toBe('a \\ b');
  });

  it('config_version is reported under __global__', async () => {
    const parsed = await readSettings('config_version=5\n\n[application]\n\nconfig/name="Game"\n');
    expect(parsed.settings.__global__).toEqual({ config_version: 5 });
  });

  it('constructor values stay raw strings and numbers and booleans are typed', async () => {
    const parsed = await readSettings(
      [
        'config_version=5',
        '',
        '[application]',
        '',
        'config/features=PackedStringArray("4.3", "Forward Plus")',
        'config/icon="res://icon.svg"',
        'run/max_fps=60',
        'run/ratio=0.5',
        'run/big=1e3',
        'config/use_hidden_project_data_directory=false',
        '',
      ].join('\n'),
    );
    expect(parsed.settings.application).toEqual({
      'config/features': 'PackedStringArray("4.3", "Forward Plus")',
      'config/icon': 'res://icon.svg',
      'run/max_fps': 60,
      'run/ratio': 0.5,
      'run/big': 1000,
      'config/use_hidden_project_data_directory': false,
    });
  });
});

// ---------------------------------------------------------------------------
// get_project_files and search_project: what was not listed or searched
// ---------------------------------------------------------------------------

describe('handleGetProjectFiles: depth limits', () => {
  type TreeNode = {
    name: string;
    type: string;
    path: string;
    warnings?: string[];
    children?: TreeNode[] | null;
  };

  function makeNestedProject(): string {
    const dir = tmp.makeProject('mcp-depth-');
    mkdirSync(join(dir, 'scenes'), { recursive: true });
    writeFileSync(join(dir, 'scenes', 'a.tscn'), '[gd_scene format=3]\n', 'utf8');
    return dir;
  }

  it('a directory cut by maxDepth has children null and the root leads with a warning', async () => {
    const result = await handleGetProjectFiles({ projectPath: makeNestedProject(), maxDepth: 1 });
    expectMatchesOutputSchema('get_project_files', result);
    const tree = parseText<TreeNode>(result);
    expect(Object.keys(tree)[0]).toBe('warnings');
    expect(tree.warnings?.[0]).toMatch(/maxDepth 1 cut the listing/);
    const scenes = tree.children?.find((c) => c.name === 'scenes');
    expect(scenes?.children).toBeNull();
  });

  it('maxDepth 0 returns the root with children null', async () => {
    const result = await handleGetProjectFiles({ projectPath: makeNestedProject(), maxDepth: 0 });
    const tree = parseText<TreeNode>(result);
    expect(tree.children).toBeNull();
    expect(tree.warnings?.[0]).toMatch(/maxDepth 0 cut the listing/);
  });

  it('an unlimited depth lists every directory and carries no warning', async () => {
    const result = await handleGetProjectFiles({ projectPath: makeNestedProject() });
    const tree = parseText<TreeNode>(result);
    expect(tree).not.toHaveProperty('warnings');
    const scenes = tree.children?.find((c) => c.name === 'scenes');
    expect(scenes?.children?.map((c) => c.name)).toEqual(['a.tscn']);
  });

  it('a negative maxDepth other than -1 is an error', async () => {
    expectErrorMatching(
      await handleGetProjectFiles({ projectPath: makeNestedProject(), maxDepth: -2 }),
      /maxDepth/,
    );
    expectErrorMatching(
      await handleGetProjectFiles({ projectPath: makeNestedProject(), maxDepth: 1.5 }),
      /maxDepth/,
    );
  });
});

describe('handleSearchProject: what was searched', () => {
  type SearchPayload = {
    warnings?: string[];
    matches: unknown[];
    truncated: boolean;
    filesSearched: number;
    fileTypes: string[];
  };

  it('search_project reports filesSearched and the effective fileTypes', async () => {
    const dir = tmp.makeProject('mcp-search-');
    writeFileSync(join(dir, 'a.gd'), 'var needle = 1\n', 'utf8');
    writeFileSync(join(dir, 'b.gd'), 'var other = 2\n', 'utf8');
    const result = await handleSearchProject({ projectPath: dir, pattern: 'needle' });
    expectMatchesOutputSchema('search_project', result);
    const parsed = parseText<SearchPayload>(result);
    expect(parsed.filesSearched).toBe(2);
    expect(parsed.fileTypes).toEqual(['gd', 'tscn', 'cs', 'gdshader']);
    expect(parsed.matches).toHaveLength(1);
    expect(parsed).not.toHaveProperty('warnings');
  });

  it('a fileTypes list that matches no file leads with a warning', async () => {
    const dir = tmp.makeProject('mcp-search-none-');
    writeFileSync(join(dir, 'a.gd'), 'var needle = 1\n', 'utf8');
    const result = await handleSearchProject({
      projectPath: dir,
      pattern: 'needle',
      fileTypes: ['gdscript'],
    });
    const parsed = parseText<SearchPayload>(result);
    expect(Object.keys(parsed)[0]).toBe('warnings');
    expect(parsed.warnings?.[0]).toMatch(/No file with extension\(s\) gdscript exists/);
    expect(parsed.filesSearched).toBe(0);
    expect(parsed.fileTypes).toEqual(['gdscript']);
    expect(parsed.matches).toEqual([]);
  });

  it('a pattern containing a line break is an error', async () => {
    expectErrorMatching(
      await handleSearchProject({ projectPath: fixtureProjectPath, pattern: 'a\nb' }),
      /line break/,
    );
    expectErrorMatching(
      await handleSearchProject({ projectPath: fixtureProjectPath, pattern: 'a\rb' }),
      /line break/,
    );
  });
});
