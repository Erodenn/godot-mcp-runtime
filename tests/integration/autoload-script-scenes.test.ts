/**
 * Integration tests for scenes whose scripts name a project autoload.
 *
 * Headless operations run from MainLoop._initialize, after the engine has
 * registered autoload singletons as GDScript globals. Under _init they were
 * not yet visible, so player.gd (which reads GameState.score) failed to
 * compile and every save wrote the node without its script and exported
 * values. These tests run the real handlers on a tmp copy of the authored
 * fixture and assert on the .tscn text read back from disk, so they do not
 * depend on the tools' own read-back.
 *
 * Requires GODOT_PATH. Skipped locally when it is unset; CI sets it in the
 * godot-integration job.
 */

import { describe, beforeAll, beforeEach, afterAll, expect } from 'vitest';
import { cpSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { engineMajorMinor, itGodot } from '../helpers/godot-skip.js';
import { authoredFixtureProjectPath } from '../helpers/fixture-paths.js';
import { expectMatchesOutputSchema } from '../helpers/schema-assert.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { handleValidate } from '../../src/tools/validate-tools.js';
import { handleGetSceneTree, handleSetNodeProperties } from '../../src/tools/node-tools.js';
import { handleAddNode, handleSaveScene } from '../../src/tools/scene-tools.js';

const PLAYER_SCENE = 'player.tscn';
const CASE_TIMEOUT_MS = 120000;

let runner: GodotRunner;
let projectPath: string;
const tmpDirs: string[] = [];

beforeAll(async () => {
  runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
  await runner.detectGodotPath();
});

beforeEach(() => {
  projectPath = join(tmpdir(), `godot-mcp-authored-${randomBytes(6).toString('hex')}`);
  cpSync(authoredFixtureProjectPath, projectPath, { recursive: true });
  tmpDirs.push(projectPath);
});

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

/** The scene file's text as it is on disk right now. */
function sceneText(scene: string): string {
  return readFileSync(join(projectPath, scene), 'utf8');
}

describe('a scene script that names an autoload survives a headless save', () => {
  itGodot(
    'save_scene keeps the script and its stored export',
    async () => {
      const result = await handleSaveScene(runner, { projectPath, scenePath: PLAYER_SCENE });
      expectMatchesOutputSchema('save_scene', result);

      const text = sceneText(PLAYER_SCENE);
      expect(text).toContain('script = ExtResource(');
      expect(text).toContain('speed = 9.0');
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'set_node_properties on a child keeps the root script and stored export',
    async () => {
      const result = await handleSetNodeProperties(runner, {
        projectPath,
        scenePath: PLAYER_SCENE,
        updates: [{ nodePath: 'root/Body', property: 'position', value: { x: 30, y: 40 } }],
      });
      expectMatchesOutputSchema('set_node_properties', result);

      const text = sceneText(PLAYER_SCENE);
      expect(text).toContain('script = ExtResource(');
      expect(text).toContain('speed = 9.0');
      expect(text).toContain('position = Vector2(30, 40)');
      expect(text).not.toContain('position = Vector2(3, 4)');
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'validate accepts a script that reads an autoload',
    async () => {
      const result = await handleValidate(runner, { projectPath, scriptPath: 'player.gd' });
      const payload = expectMatchesOutputSchema('validate', result);
      expect(payload.valid).toBe(true);
      expect(payload.errors).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'validate accepts the scene whose root script reads an autoload',
    async () => {
      const result = await handleValidate(runner, {
        projectPath,
        scenePath: PLAYER_SCENE,
        checks: [{ type: 'structure', schema: { type: 'Node2D' } }],
      });
      const payload = expectMatchesOutputSchema('validate', result);
      expect(payload.valid).toBe(true);
      expect(payload.errors).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'get_scene_tree reports the root script',
    async () => {
      const result = await handleGetSceneTree(runner, { projectPath, scenePath: PLAYER_SCENE });
      const tree = expectMatchesOutputSchema('get_scene_tree', result);
      expect(tree.script).toBe('res://player.gd');
    },
    CASE_TIMEOUT_MS,
  );
});

const BROKEN_SCENE = 'broken_script.tscn';
/** The backup location a loss warning names, project-relative with forward slashes. */
const BACKUP_PATH_REGEX = /\.mcp\/godot-runtime\/scene-backups\/[^/\s]+\/[^\s]+\.tscn/;

describe('a headless save that drops content says so and keeps the file as it was', () => {
  itGodot(
    'add_node on a scene whose script does not compile warns, backs the file up and still saves',
    async () => {
      // broken_script.gd names an identifier that exists nowhere, so the engine
      // cannot load it and the save drops the stored export (and, on 4.6, the
      // script line with it).
      const before = sceneText(BROKEN_SCENE);
      const result = await handleAddNode(runner, {
        projectPath,
        scenePath: BROKEN_SCENE,
        nodeType: 'Node2D',
        nodeName: 'Added',
      });
      const payload = expectMatchesOutputSchema('add_node', result);

      expect(Object.keys(payload)[0]).toBe('warnings');
      expect(payload.nodeName).toBe('Added');
      expect(payload.nodePath).toBe('root/Added');
      const warnings = payload.warnings as string[];
      expect(warnings[0]).toMatch(/lost content this operation did not ask to change/);
      const backup = BACKUP_PATH_REGEX.exec(warnings[0] ?? '');
      expect(backup).not.toBeNull();
      expect(warnings.some((entry) => /stored values of .*: .*\bspeed\b/.test(entry))).toBe(true);

      expect(readFileSync(join(projectPath, ...backup![0].split('/')), 'utf8')).toBe(before);
      expect(existsSync(join(projectPath, '.mcp', '.gdignore'))).toBe(true);
      // The save happened: the new node is in the file.
      expect(sceneText(BROKEN_SCENE)).toContain('[node name="Added" type="Node2D" parent="."');
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'add_node on a healthy scene reports no loss and writes no backup',
    async () => {
      const result = await handleAddNode(runner, {
        projectPath,
        scenePath: PLAYER_SCENE,
        nodeType: 'Node2D',
        nodeName: 'Added',
      });
      const payload = expectMatchesOutputSchema('add_node', result);

      // Not "no warnings": an engine newer than the project's config/features
      // version adds its own entry.
      const warnings = (payload.warnings ?? []) as string[];
      expect(warnings.filter((entry) => /lost|no longer/.test(entry))).toEqual([]);
      expect(existsSync(join(projectPath, '.mcp', 'godot-runtime', 'scene-backups'))).toBe(false);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'edits on the inherited and the instancing scene report no loss',
    async () => {
      // The shapes the comparison has to read as healthy: an inherited root,
      // an override line, and an editable instance gaining its first override.
      const derived = await handleSetNodeProperties(runner, {
        projectPath,
        scenePath: 'derived_unit.tscn',
        updates: [{ nodePath: 'root/Leg', property: 'text', value: 'changed' }],
      });
      const host = await handleSetNodeProperties(runner, {
        projectPath,
        scenePath: 'host.tscn',
        updates: [{ nodePath: 'root/Unit/Arm', property: 'position', value: { x: 7, y: 7 } }],
      });
      for (const [tool, result] of [
        ['derived', derived],
        ['host', host],
      ] as const) {
        const payload = expectMatchesOutputSchema('set_node_properties', result);
        const warnings = (payload.warnings ?? []) as string[];
        expect(
          warnings.filter((entry) => /lost|no longer/.test(entry)),
          tool,
        ).toEqual([]);
      }
      expect(existsSync(join(projectPath, '.mcp', 'godot-runtime', 'scene-backups'))).toBe(false);
    },
    CASE_TIMEOUT_MS,
  );
});

/** The engine version the authored fixture's project.godot states in config/features. */
const AUTHORED_FEATURE_VERSION = { major: 4, minor: 5 };

describe('a scene mutation on a project an older engine saved says so', () => {
  itGodot(
    'add_node warns exactly when the engine is newer than config/features',
    async () => {
      const engine = await engineMajorMinor();
      const engineIsNewer =
        engine.major > AUTHORED_FEATURE_VERSION.major ||
        (engine.major === AUTHORED_FEATURE_VERSION.major &&
          engine.minor > AUTHORED_FEATURE_VERSION.minor);

      const result = await handleAddNode(runner, {
        projectPath,
        scenePath: PLAYER_SCENE,
        nodeType: 'Node2D',
        nodeName: 'Added',
      });
      const payload = expectMatchesOutputSchema('add_node', result);
      const versionWarnings = ((payload.warnings ?? []) as string[]).filter((entry) =>
        /config\/features version 4\.5/.test(entry),
      );
      expect(versionWarnings).toHaveLength(engineIsNewer ? 1 : 0);
      if (engineIsNewer) {
        expect(Object.keys(payload)[0]).toBe('warnings');
        expect(versionWarnings[0]).toContain(`Godot ${engine.major}.${engine.minor} is newer`);
      }
    },
    CASE_TIMEOUT_MS,
  );
});

const PLAYER_SCENE_UID = 'uid://clomui4eibwiq';
const PLAYER_SCRIPT_UID = 'uid://cp6gyxwwwr27j';
const DERIVED_SCENE = 'derived_unit.tscn';
const DERIVED_SCENE_UID = 'uid://ud33laavt82f';
const BASE_SCENE_UID = 'uid://76owar7af2bj';

/** The first line of a scene file: its `[gd_scene ...]` header. */
function headerLine(scene: string): string {
  return sceneText(scene).split('\n')[0] ?? '';
}

/** The `[ext_resource ...]` line that points at `path`. */
function extResourceLine(scene: string, path: string): string {
  const line = sceneText(scene)
    .split('\n')
    .find((candidate) => candidate.startsWith('[ext_resource ') && candidate.includes(path));
  if (line === undefined) throw new Error(`${scene} has no ext_resource for ${path}`);
  return line;
}

describe('a headless save keeps the scene uid and the reference uids', () => {
  itGodot(
    'set_node_properties keeps the scene uid and the script reference uid',
    async () => {
      const result = await handleSetNodeProperties(runner, {
        projectPath,
        scenePath: PLAYER_SCENE,
        updates: [{ nodePath: 'root/Body', property: 'position', value: { x: 30, y: 40 } }],
      });
      expectMatchesOutputSchema('set_node_properties', result);

      expect(headerLine(PLAYER_SCENE)).toMatch(/^\[gd_scene .*uid="uid:\/\/clomui4eibwiq"\]/);
      expect(extResourceLine(PLAYER_SCENE, 'res://player.gd')).toContain(
        `uid="${PLAYER_SCRIPT_UID}"`,
      );
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'save_scene with newPath writes a copy with no uid of its own and keeps the reference uid',
    async () => {
      const result = await handleSaveScene(runner, {
        projectPath,
        scenePath: PLAYER_SCENE,
        newPath: 'player_copy.tscn',
      });
      expectMatchesOutputSchema('save_scene', result);

      expect(headerLine('player_copy.tscn')).not.toContain('uid=');
      expect(extResourceLine('player_copy.tscn', 'res://player.gd')).toContain(
        `uid="${PLAYER_SCRIPT_UID}"`,
      );
      // The original is untouched by the save-as.
      expect(headerLine(PLAYER_SCENE)).toContain(`uid="${PLAYER_SCENE_UID}"`);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'a second save leaves both uids unchanged',
    async () => {
      for (let pass = 0; pass < 2; pass++) {
        const result = await handleSaveScene(runner, { projectPath, scenePath: PLAYER_SCENE });
        expectMatchesOutputSchema('save_scene', result);
        expect(headerLine(PLAYER_SCENE)).toContain(`uid="${PLAYER_SCENE_UID}"`);
        expect(extResourceLine(PLAYER_SCENE, 'res://player.gd')).toContain(
          `uid="${PLAYER_SCRIPT_UID}"`,
        );
      }
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'an inherited scene keeps its own uid and the uid of its base scene',
    async () => {
      const result = await handleSetNodeProperties(runner, {
        projectPath,
        scenePath: DERIVED_SCENE,
        updates: [{ nodePath: 'root/Leg', property: 'text', value: 'changed' }],
      });
      expectMatchesOutputSchema('set_node_properties', result);

      expect(headerLine(DERIVED_SCENE)).toContain(`uid="${DERIVED_SCENE_UID}"`);
      expect(extResourceLine(DERIVED_SCENE, 'res://base_unit.tscn')).toContain(
        `uid="${BASE_SCENE_UID}"`,
      );
    },
    CASE_TIMEOUT_MS,
  );
});
