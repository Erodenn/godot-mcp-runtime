import { describe, beforeAll, beforeEach, afterAll, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { removeTmpDir } from '../helpers/tmp.js';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { fileURLToPath } from 'url';
import { itGodot } from '../helpers/godot-skip.js';
import { authoredFixtureProjectPath } from '../helpers/fixture-paths.js';
import { expectErrorMatching } from '../helpers/assertions.js';
import { expectMatchesOutputSchema } from '../helpers/schema-assert.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { handleAddNode, handleCreateScene } from '../../src/tools/scene-tools.js';

const PLAYER_SCENE = 'player.tscn';
const UI_SCENE = 'ui.tscn';
const ABOVE_INT32_MAX = 3000000000;
const CASE_TIMEOUT_MS = 120000;
const OPERATIONS_SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'scripts',
  'godot_operations.gd',
);

let runner: GodotRunner;
let projectPath: string;
const tmpDirs: string[] = [];

beforeAll(async () => {
  runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
  await runner.detectGodotPath();
});

beforeEach(() => {
  projectPath = join(tmpdir(), `godot-mcp-add-node-${randomBytes(6).toString('hex')}`);
  cpSync(authoredFixtureProjectPath, projectPath, { recursive: true });
  tmpDirs.push(projectPath);
});

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      removeTmpDir(dir);
    } catch {}
  }
});

function sceneText(scene: string): string {
  return readFileSync(join(projectPath, scene), 'utf8');
}

function sectionProperties(text: string, headerPrefix: string): string[] | null {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith(headerPrefix));
  if (start === -1) return null;
  const properties: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || line.startsWith('[')) break;
    properties.push(line);
  }
  return properties;
}

function operationExitStatus(operation: string, params: object): number | null {
  const run = spawnSync(
    process.env.GODOT_PATH as string,
    [
      '--headless',
      '--path',
      projectPath,
      '--script',
      OPERATIONS_SCRIPT,
      operation,
      JSON.stringify(params),
    ],
    { timeout: CASE_TIMEOUT_MS, windowsHide: true },
  );
  return run.status;
}

describe('a nodeType that is not a Node is reported, not raised', () => {
  itGodot(
    'add_node with a Resource class says it is not a Node type and leaves the file alone',
    async () => {
      const before = sceneText(PLAYER_SCENE);

      const result = await handleAddNode(runner, {
        projectPath,
        scenePath: PLAYER_SCENE,
        nodeType: 'Resource',
        nodeName: 'Bad',
      });

      expectErrorMatching(result, /'Resource' is not a Node type/);
      expect(sceneText(PLAYER_SCENE)).toBe(before);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'add_node with a script that extends a non-Node class says what it extends, and never runs its _init',
    async () => {
      writeFileSync(
        join(projectPath, 'plain_resource.gd'),
        [
          'extends Resource',
          '',
          'func _init() -> void:',
          '\tFileAccess.open("res://init_ran.txt", FileAccess.WRITE).store_string("ran")',
          '',
        ].join('\n'),
      );
      const before = sceneText(PLAYER_SCENE);

      const result = await handleAddNode(runner, {
        projectPath,
        scenePath: PLAYER_SCENE,
        nodeType: 'res://plain_resource.gd',
        nodeName: 'Bad',
      });

      expectErrorMatching(result, /is not a Node type.*its script extends Resource/);
      expect(sceneText(PLAYER_SCENE)).toBe(before);
      expect(existsSync(join(projectPath, 'init_ran.txt'))).toBe(false);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'add_node with a script that extends Node still adds the node',
    async () => {
      const result = await handleAddNode(runner, {
        projectPath,
        scenePath: PLAYER_SCENE,
        nodeType: 'res://game_state.gd',
        nodeName: 'FromScript',
      });
      expectMatchesOutputSchema('add_node', result);

      expect(sceneText(PLAYER_SCENE)).toContain('[node name="FromScript" type="Node" parent="."');
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'create_scene with a Resource class as the root type creates no file',
    async () => {
      const result = await handleCreateScene(runner, {
        projectPath,
        scenePath: 'not_a_scene.tscn',
        rootNodeType: 'Resource',
      });

      expectErrorMatching(result, /'Resource' is not a Node type/);
      expect(existsSync(join(projectPath, 'not_a_scene.tscn'))).toBe(false);
    },
    CASE_TIMEOUT_MS,
  );
});

describe('add_node applies script before the properties that depend on it', () => {
  itGodot(
    'a script variable listed before the script is set',
    async () => {
      const result = await handleAddNode(runner, {
        projectPath,
        scenePath: PLAYER_SCENE,
        nodeType: 'Node2D',
        nodeName: 'Scripted',
        properties: { speed: 5, script: 'res://player.gd' },
      });
      expectMatchesOutputSchema('add_node', result);

      const properties = sectionProperties(sceneText(PLAYER_SCENE), '[node name="Scripted"');
      expect(properties).not.toBeNull();
      expect(properties?.some((line) => line.startsWith('script = ExtResource('))).toBe(true);
      expect(properties).toContain('speed = 5.0');
    },
    CASE_TIMEOUT_MS,
  );
});

describe('add_node sets properties on a node that is already in the scene', () => {
  itGodot(
    'a Control under a Control parent keeps layout_mode and anchors_preset',
    async () => {
      // Control answers both properties from its parent, so on a node with no parent they differ from what was assigned.
      const created = await handleCreateScene(runner, {
        projectPath,
        scenePath: UI_SCENE,
        rootNodeType: 'Control',
      });
      expectMatchesOutputSchema('create_scene', created);

      const result = await handleAddNode(runner, {
        projectPath,
        scenePath: UI_SCENE,
        nodeType: 'Control',
        nodeName: 'Panel',
        properties: { layout_mode: 1, anchors_preset: 15 },
      });
      expectMatchesOutputSchema('add_node', result);

      const properties = sectionProperties(
        sceneText(UI_SCENE),
        '[node name="Panel" type="Control"',
      );
      expect(properties).toContain('layout_mode = 1');
      expect(properties).toContain('anchors_preset = 15');
      expect(properties).toContain('anchor_right = 1.0');
      expect(properties).toContain('anchor_bottom = 1.0');
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'a property that fails leaves the scene file as it was',
    async () => {
      const before = sceneText(PLAYER_SCENE);

      const result = await handleAddNode(runner, {
        projectPath,
        scenePath: PLAYER_SCENE,
        nodeType: 'Node2D',
        nodeName: 'Bad',
        properties: { position: { x: 1, y: 2 }, process_priority: ABOVE_INT32_MAX },
      });

      expectErrorMatching(result, /process_priority.*3000000000 was not stored/);
      expect(sceneText(PLAYER_SCENE)).toBe(before);
    },
    CASE_TIMEOUT_MS,
  );
});

describe('the operations script exits with the outcome of the operation', () => {
  itGodot(
    'an unknown operation exits non-zero',
    () => {
      expect(operationExitStatus('no_such_operation', { scenePath: PLAYER_SCENE })).toBe(1);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'an operation that fails on its input exits non-zero',
    () => {
      expect(operationExitStatus('get_scene_tree', { scene_path: 'missing.tscn' })).toBe(1);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'an operation that stops before it emits a result exits non-zero, though nothing marked it failed',
    () => {
      // A number where create_scene builds a string raises a script error on its first line, aborting without reaching any failure path, so only the missing result can turn the exit code.
      expect(operationExitStatus('create_scene', { scene_path: 7 })).toBe(1);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'an operation that returns a result exits zero',
    () => {
      expect(operationExitStatus('get_scene_tree', { scene_path: PLAYER_SCENE })).toBe(0);
    },
    CASE_TIMEOUT_MS,
  );
});
