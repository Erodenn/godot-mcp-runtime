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
import { cpSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { itGodot } from '../helpers/godot-skip.js';
import { authoredFixtureProjectPath } from '../helpers/fixture-paths.js';
import { expectMatchesOutputSchema } from '../helpers/schema-assert.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { handleValidate } from '../../src/tools/validate-tools.js';
import { handleGetSceneTree, handleSetNodeProperties } from '../../src/tools/node-tools.js';
import { handleSaveScene } from '../../src/tools/scene-tools.js';

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
