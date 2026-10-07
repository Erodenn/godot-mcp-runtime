/**
 * Integration tests for the uids a headless save writes on ext_resource lines.
 *
 * ResourceSaver.save outside the editor writes every reference path-only. The
 * save puts back the uid the old file text had for a path, and gives a
 * reference the operation added the uid the project records for that file (a
 * scene's own header, a script's .uid sidecar). A file with no recorded uid
 * stays path-only: no uid is ever made up.
 *
 * Every assertion reads the .tscn text from disk. Requires GODOT_PATH. Skipped
 * locally when it is unset; CI sets it in the godot-integration job.
 */

import { describe, beforeAll, beforeEach, afterAll, expect } from 'vitest';
import { cpSync, readdirSync, readFileSync } from 'fs';
import { removeTmpDir } from '../helpers/tmp.js';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { itGodot } from '../helpers/godot-skip.js';
import { authoredFixtureProjectPath } from '../helpers/fixture-paths.js';
import { expectMatchesOutputSchema } from '../helpers/schema-assert.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { handleAddNode, handleSaveScene } from '../../src/tools/scene-tools.js';
import { handleAttachScript } from '../../src/tools/node-tools.js';

const PLAYER_SCENE = 'player.tscn';
const BASE_SCENE = 'base_unit.tscn';
const INVENTORY_SCENE = 'inventory.tscn';
/** The uid player.gd.uid records for player.gd. */
const PLAYER_SCRIPT_UID = 'uid://cp6gyxwwwr27j';
/** The uid base_unit.tscn carries in its own header. */
const BASE_SCENE_UID = 'uid://76owar7af2bj';
/** The uid player.tscn carries in its own header. */
const PLAYER_SCENE_UID = 'uid://clomui4eibwiq';
const CASE_TIMEOUT_MS = 120000;

let runner: GodotRunner;
let projectPath: string;
const tmpDirs: string[] = [];

beforeAll(async () => {
  runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
  await runner.detectGodotPath();
});

beforeEach(() => {
  projectPath = join(tmpdir(), `godot-mcp-ext-uid-${randomBytes(6).toString('hex')}`);
  cpSync(authoredFixtureProjectPath, projectPath, { recursive: true });
  tmpDirs.push(projectPath);
});

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      removeTmpDir(dir);
    } catch {
      // best-effort cleanup
    }
  }
});

/** The scene file's text as it is on disk right now. */
function sceneText(scene: string): string {
  return readFileSync(join(projectPath, scene), 'utf8');
}

/** The ext_resource line that references `resPath`, or undefined. */
function extResourceLine(text: string, resPath: string): string | undefined {
  return text
    .split('\n')
    .find((line) => line.startsWith('[ext_resource ') && line.includes(`path="${resPath}"`));
}

describe('a reference an operation adds gets the uid the project records for it', () => {
  itGodot(
    'attach_script writes the uid from the script .uid sidecar',
    async () => {
      const result = await handleAttachScript(runner, {
        projectPath,
        scenePath: BASE_SCENE,
        nodePath: 'root/Arm',
        scriptPath: 'player.gd',
      });
      expectMatchesOutputSchema('attach_script', result);

      const text = sceneText(BASE_SCENE);
      expect(extResourceLine(text, 'res://player.gd')).toContain(`uid="${PLAYER_SCRIPT_UID}"`);
      // The scene keeps its own uid as well.
      expect(text.split('\n')[0]).toContain(`uid="${BASE_SCENE_UID}"`);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'add_node of a scene writes the uid from that scene header and keeps the uids already there',
    async () => {
      const result = await handleAddNode(runner, {
        projectPath,
        scenePath: PLAYER_SCENE,
        nodeType: BASE_SCENE,
        nodeName: 'Unit',
      });
      expectMatchesOutputSchema('add_node', result);

      const text = sceneText(PLAYER_SCENE);
      expect(extResourceLine(text, 'res://base_unit.tscn')).toContain(`uid="${BASE_SCENE_UID}"`);
      expect(extResourceLine(text, 'res://player.gd')).toContain(`uid="${PLAYER_SCRIPT_UID}"`);
      expect(text.split('\n')[0]).toContain(`uid="${PLAYER_SCENE_UID}"`);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'a referenced file with no recorded uid stays path-only',
    async () => {
      // inventory.gd has no .uid sidecar and inventory.tscn names it by path.
      const result = await handleAddNode(runner, {
        projectPath,
        scenePath: INVENTORY_SCENE,
        nodeType: 'Node',
        nodeName: 'Added',
      });
      expectMatchesOutputSchema('add_node', result);

      const line = extResourceLine(sceneText(INVENTORY_SCENE), 'res://inventory.gd');
      expect(line).toBeDefined();
      expect(line).not.toContain('uid=');
    },
    CASE_TIMEOUT_MS,
  );
});

describe('the uid rewrite leaves a whole file and nothing else', () => {
  itGodot(
    'a save-as to a new path carries the reference uids, takes no scene uid and leaves no temporary file',
    async () => {
      const result = await handleSaveScene(runner, {
        projectPath,
        scenePath: PLAYER_SCENE,
        newPath: 'player_copy.tscn',
      });
      expectMatchesOutputSchema('save_scene', result);

      const text = sceneText('player_copy.tscn');
      expect(text.split('\n')[0]).not.toContain('uid=');
      expect(extResourceLine(text, 'res://player.gd')).toContain(`uid="${PLAYER_SCRIPT_UID}"`);
      // The rewritten file is complete: the body is still there after the header.
      expect(text).toContain('[node name="Player" type="Node2D"');
      expect(text).toContain('[node name="Body" type="Sprite2D" parent="."');
      expect(readdirSync(projectPath).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );
});
