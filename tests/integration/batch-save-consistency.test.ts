/** Every assertion reads the .tscn text from disk, because the batch's per-scene cache decides what reaches it. */

import { describe, beforeAll, beforeEach, afterAll, expect } from 'vitest';
import { copyFileSync, cpSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { removeTmpDir } from '../helpers/tmp.js';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { itGodot } from '../helpers/godot-skip.js';
import { authoredFixtureProjectPath } from '../helpers/fixture-paths.js';
import { errorText, hasError, unwrap } from '../helpers/assertions.js';
import { minimalPng } from '../helpers/png-fixtures.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { handleBatchSceneOperations } from '../../src/tools/scene-tools.js';

const BASE_SCENE = 'base_unit.tscn';
const DERIVED_SCENE = 'derived_unit.tscn';
const HOST_SCENE = 'host.tscn';
const PLAYER_SCENE = 'player.tscn';
const SPAWNER_SCENE = 'spawner.tscn';
const CASE_TIMEOUT_MS = 120000;
const IMPORT_CASE_TIMEOUT_MS = 240000;

interface BatchResult {
  operation: string;
  scenePath: string;
  success?: boolean;
  error?: string;
  savedScenePath?: string;
}

let runner: GodotRunner;
let projectPath: string;
const tmpDirs: string[] = [];

beforeAll(async () => {
  runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
  await runner.detectGodotPath();
});

beforeEach(() => {
  projectPath = join(tmpdir(), `godot-mcp-batch-save-${randomBytes(6).toString('hex')}`);
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

function nodeCount(scene: string, nodeName: string): number {
  return sceneText(scene).split(`[node name="${nodeName}"`).length - 1;
}

async function runBatch(operations: object[]): Promise<BatchResult[]> {
  const result = await handleBatchSceneOperations(runner, { projectPath, operations });
  if (hasError(result)) throw new Error(errorText(result) ?? 'batch returned an error response');
  return (unwrap(result).structuredContent as { results: BatchResult[] }).results;
}

function addNode(scenePath: string, nodeName: string, nodeType = 'Node2D'): object {
  return { operation: 'add_node', scenePath, nodeType, nodeName };
}

describe('a batch keeps one tree per scene file', () => {
  itGodot(
    'a node added before an explicit save is still in the file after a later add',
    async () => {
      const results = await runBatch([
        {
          operation: 'set_node_properties',
          scenePath: HOST_SCENE,
          updates: [{ nodePath: 'root/Unit', property: 'position', value: { x: 20, y: 20 } }],
        },
        addNode(BASE_SCENE, 'N1'),
        { operation: 'save', scenePath: BASE_SCENE },
        addNode(BASE_SCENE, 'N2'),
      ]);

      expect(results.map((entry) => entry.success)).toEqual([true, true, true, true]);
      expect(nodeCount(BASE_SCENE, 'N1')).toBe(1);
      expect(nodeCount(BASE_SCENE, 'N2')).toBe(1);
      expect(sceneText(HOST_SCENE)).toContain('position = Vector2(20, 20)');
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'a scene first loaded after a save of the scene it instances sees the saved nodes',
    async () => {
      // Loaded after the base was saved in the same process, the derived scene must be built on the saved base so N1 can be overridden.
      const results = await runBatch([
        addNode(HOST_SCENE, 'Marker'),
        addNode(BASE_SCENE, 'N1'),
        { operation: 'save', scenePath: BASE_SCENE },
        {
          operation: 'set_node_properties',
          scenePath: DERIVED_SCENE,
          updates: [{ nodePath: 'root/N1', property: 'position', value: { x: 9, y: 9 } }],
        },
      ]);

      expect(results.map((entry) => entry.error)).toEqual([
        undefined,
        undefined,
        undefined,
        undefined,
      ]);
      expect(nodeCount(BASE_SCENE, 'N1')).toBe(1);
      const derived = sceneText(DERIVED_SCENE);
      // N1 belongs to the base: the derived scene writes an override section, not a node of its own.
      expect(derived).toMatch(/\[node name="N1" parent="\."[^\]]*\]\nposition = Vector2\(9, 9\)/);
      expect(derived).not.toContain('[node name="N1" type="Node2D"');
    },
    CASE_TIMEOUT_MS,
  );
});

describe('a scene another loaded tree holds as a property value', () => {
  // While the spawner's tree is loaded, base_unit.tscn's PackedScene stays in the resource cache; saving the base must not take its path away, or it is written into spawner.tscn as a whole sub_resource.
  function expectSpawnerKeepsItsReferences(): void {
    const spawner = sceneText(SPAWNER_SCENE);
    expect(spawner).not.toContain('[sub_resource type="PackedScene"');
    expect(spawner).not.toContain('_bundled');
    expect(spawner).toMatch(
      /\[ext_resource type="PackedScene"[^\]]*path="res:\/\/base_unit\.tscn"/,
    );
    expect(spawner).toMatch(/\nenemy = ExtResource\("[^"]+"\)\n/);
    expect(spawner).toMatch(/\nwave = Array\[PackedScene\]\(\[ExtResource\("[^"]+"\)\]\)/);
    expect(nodeCount(SPAWNER_SCENE, 'A')).toBe(1);
    expect(nodeCount(BASE_SCENE, 'N1')).toBe(1);
  }

  itGodot(
    'is still an ExtResource when the held scene is saved by an explicit save',
    async () => {
      const results = await runBatch([
        addNode(SPAWNER_SCENE, 'A'),
        addNode(BASE_SCENE, 'N1'),
        { operation: 'save', scenePath: BASE_SCENE },
      ]);

      expect(results.map((entry) => entry.error)).toEqual([undefined, undefined, undefined]);
      expectSpawnerKeepsItsReferences();
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'is still an ExtResource when the closing auto-save writes both scenes',
    async () => {
      // The closing auto-save writes the spawner before the base all the same, because it references the base.
      const results = await runBatch([addNode(BASE_SCENE, 'N1'), addNode(SPAWNER_SCENE, 'A')]);

      expect(results.map((entry) => entry.error)).toEqual([undefined, undefined]);
      expectSpawnerKeepsItsReferences();
    },
    CASE_TIMEOUT_MS,
  );
});

describe('a batch save-as onto a scene the batch also holds', () => {
  itGodot(
    'is refused before writing when that scene has unwritten operations',
    async () => {
      const results = await runBatch([
        addNode(HOST_SCENE, 'X'),
        { operation: 'save', scenePath: DERIVED_SCENE, newPath: HOST_SCENE },
      ]);

      expect(results[0]?.success).toBe(true);
      expect(results[1]?.success).toBeUndefined();
      expect(String(results[1]?.error)).toMatch(/save-as would discard/);

      const host = sceneText(HOST_SCENE);
      expect(host).toContain('[node name="Host" type="Node2D"');
      expect(nodeCount(HOST_SCENE, 'X')).toBe(1);
      expect(host).not.toContain('[node name="Derived"');
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'wins over an unchanged cached tree, and a later operation works on the saved file',
    async () => {
      const results = await runBatch([
        {
          operation: 'set_node_properties',
          scenePath: HOST_SCENE,
          updates: [{ nodePath: 'root/NoSuchNode', property: 'position', value: { x: 1, y: 1 } }],
        },
        { operation: 'save', scenePath: DERIVED_SCENE, newPath: HOST_SCENE },
        addNode(HOST_SCENE, 'Y'),
      ]);

      expect(results[0]?.success).toBeUndefined();
      expect(results[1]?.success).toBe(true);
      expect(results[1]?.savedScenePath).toBe(HOST_SCENE);
      expect(results[2]?.success).toBe(true);

      const host = sceneText(HOST_SCENE);
      expect(host).toContain('[node name="Derived"');
      expect(host).toContain('[node name="Extra"');
      expect(nodeCount(HOST_SCENE, 'Y')).toBe(1);
      expect(host).not.toContain('[node name="Unit"');
    },
    CASE_TIMEOUT_MS,
  );
});

describe('a batch identifies a scene by its file, not by the spelling of its path', () => {
  function fileSystemIgnoresCase(): boolean {
    return existsSync(join(projectPath, PLAYER_SCENE.toUpperCase()));
  }

  itGodot(
    'two case spellings of one file are one scene where the file system ignores case',
    async (ctx) => {
      if (!fileSystemIgnoresCase()) ctx.skip();

      const results = await runBatch([
        addNode(PLAYER_SCENE, 'Lower'),
        addNode('Player.tscn', 'Upper'),
      ]);

      expect(results.map((entry) => entry.success)).toEqual([true, true]);
      expect(nodeCount(PLAYER_SCENE, 'Lower')).toBe(1);
      expect(nodeCount(PLAYER_SCENE, 'Upper')).toBe(1);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'two files that differ by case stay two scenes where the file system keeps case',
    async (ctx) => {
      if (fileSystemIgnoresCase()) ctx.skip();
      copyFileSync(join(projectPath, BASE_SCENE), join(projectPath, 'Base_Unit.tscn'));

      const results = await runBatch([
        addNode(BASE_SCENE, 'Lower'),
        addNode('Base_Unit.tscn', 'Upper'),
      ]);

      expect(results.map((entry) => entry.success)).toEqual([true, true]);
      expect(nodeCount(BASE_SCENE, 'Lower')).toBe(1);
      expect(nodeCount(BASE_SCENE, 'Upper')).toBe(0);
      expect(nodeCount('Base_Unit.tscn', 'Upper')).toBe(1);
      expect(nodeCount('Base_Unit.tscn', 'Lower')).toBe(0);
    },
    CASE_TIMEOUT_MS,
  );
});

describe('a failing batch item is an error entry, not an aborted batch', () => {
  itGodot(
    'a nodeType that is not a Node fails its own item and the earlier node is saved',
    async () => {
      const results = await runBatch([
        addNode(PLAYER_SCENE, 'Good'),
        addNode(PLAYER_SCENE, 'Bad', 'Resource'),
      ]);

      expect(results).toHaveLength(2);
      expect(results[0]?.success).toBe(true);
      expect(results[1]?.success).toBeUndefined();
      expect(String(results[1]?.error)).toMatch(/'Resource' is not a Node type/);
      expect(nodeCount(PLAYER_SCENE, 'Good')).toBe(1);
      expect(nodeCount(PLAYER_SCENE, 'Bad')).toBe(0);
    },
    CASE_TIMEOUT_MS,
  );
});

describe('an add_node that fails on a property leaves nothing behind', () => {
  itGodot(
    'the node is not in the file the closing auto-save writes',
    async () => {
      const aboveInt32Max = 3000000000;
      const results = await runBatch([
        addNode(PLAYER_SCENE, 'Good'),
        {
          operation: 'add_node',
          scenePath: PLAYER_SCENE,
          nodeType: 'Node2D',
          nodeName: 'Bad',
          properties: { process_priority: aboveInt32Max },
        },
      ]);

      expect(results[0]?.success).toBe(true);
      expect(results[1]?.success).toBeUndefined();
      expect(String(results[1]?.error)).toMatch(/3000000000 was not stored/);
      expect(nodeCount(PLAYER_SCENE, 'Good')).toBe(1);
      expect(nodeCount(PLAYER_SCENE, 'Bad')).toBe(0);
    },
    CASE_TIMEOUT_MS,
  );
});

describe('the batch pre-pass probes a value whose property is not declared yet', () => {
  itGodot(
    'a cold texture on an export of the script the same add_node attaches is imported before anything is applied',
    async () => {
      // icon is declared by the script, so the bare Node2D the pre-pass builds lacks it; read as "not an asset", the cold texture is found only after the first item succeeded, where the retry is refused.
      writeFileSync(
        join(projectPath, 'icon_holder.gd'),
        'extends Node2D\n\n@export var icon: Texture2D\n',
      );
      writeFileSync(join(projectPath, 'cold.png'), minimalPng());

      const results = await runBatch([
        addNode(PLAYER_SCENE, 'First'),
        {
          operation: 'add_node',
          scenePath: PLAYER_SCENE,
          nodeType: 'Node2D',
          nodeName: 'Holder',
          properties: { script: 'res://icon_holder.gd', icon: 'res://cold.png' },
        },
      ]);

      expect(results.map((entry) => entry.error)).toEqual([undefined, undefined]);
      expect(nodeCount(PLAYER_SCENE, 'First')).toBe(1);
      expect(nodeCount(PLAYER_SCENE, 'Holder')).toBe(1);
      const text = sceneText(PLAYER_SCENE);
      expect(text).toMatch(/\[ext_resource type="Texture2D"[^\]]*path="res:\/\/cold\.png"/);
      expect(text).toMatch(/\nicon = ExtResource\(/);
    },
    IMPORT_CASE_TIMEOUT_MS,
  );
});
