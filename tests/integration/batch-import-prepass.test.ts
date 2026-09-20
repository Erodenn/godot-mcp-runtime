/**
 * Integration test for the batch cold-import pre-pass.
 *
 * Regression shape: in batch_scene_operations, scenes load lazily in
 * operation order. Without the pre-pass, op 1 mutates scene A (auto-saves),
 * then op 2's scene B is cold: [IMPORT_NEEDED] fires, TS imports and
 * re-runs the whole batch, and scene A's mutation is duplicated.
 *
 * With the pre-pass, every referenced scene is probed before any mutation
 * is applied; a cold scene exits the whole batch with quit(1) before
 * anything is touched, so the retry replays cleanly.
 *
 * Requires GODOT_PATH. Skipped locally when it is unset; CI sets it in the
 * godot-integration job and runs this file on Godot 4.5.1 and 4.6.2.
 */

import { describe, beforeAll, expect } from 'vitest';
import { cpSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { itGodot } from '../helpers/godot-skip.js';
import { fixtureProjectPath } from '../helpers/fixture-paths.js';
import { useTmpDirs, type TmpDirHandle } from '../helpers/tmp.js';
import { minimalPng } from '../helpers/png-fixtures.js';
import { hasError, errorText, unwrap } from '../helpers/assertions.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { handleBatchSceneOperations } from '../../src/tools/scene-tools.js';
import { extractJson } from '../../src/utils/output-parsing.js';

/** Integration tests spawn a real Godot process; give them room to run. */
const IMPORT_TEST_TIMEOUT_MS = 180000;

/** Read-only follow-up calls (tree, properties) get a shorter budget. */
const READ_TIMEOUT_MS = 30000;

/** The never-imported PNG, in both spellings a caller may pass. */
const COLD_TEXTURE_REL_PATH = 'assets/test_texture.png';
const COLD_TEXTURE_RES_PATH = `res://${COLD_TEXTURE_REL_PATH}`;

/** Scene the batch tests mutate, and the one child it starts with. */
const PROBE_SCENE = 'probe.tscn';
const PROBE_SPRITE = 'Sprite2D';

/** A scene with exactly one node of `name`, countable after the fact. */
function sceneWithNode(name: string, textureExtResourceId?: string): string {
  const textureLine = textureExtResourceId
    ? `\ntexture = ExtResource("${textureExtResourceId}")`
    : '';
  const extResource = textureExtResourceId
    ? `\n[ext_resource type="Texture2D" path="${COLD_TEXTURE_RES_PATH}" id="${textureExtResourceId}"]\n`
    : '\n';
  return (
    `[gd_scene load_steps=${textureExtResourceId ? 2 : 1} format=3]` +
    extResource +
    `\n[node name="Main" type="Node2D"]\n` +
    `\n[node name="${name}" type="Sprite2D" parent="."]${textureLine}\n`
  );
}

let runner: GodotRunner;

interface BatchOperationResult {
  operation?: string;
  success?: boolean;
  error?: string;
}

interface SceneTreeNode {
  name: string;
  type: string;
  children: SceneTreeNode[];
}

/**
 * A temp fixture copy carrying a texture that was never imported: the PNG is
 * on disk with no .import sidecar and no .godot/imported entry, which is the
 * exact state the cold-import probe exists for. The committed placeholder.png
 * is deliberately invalid and would make the import step throw, so the copy
 * gets a valid one.
 */
function makeColdProject(tmp: TmpDirHandle): string {
  const project = tmp.make('godot-mcp-test-');
  cpSync(fixtureProjectPath, project, { recursive: true });
  mkdirSync(join(project, 'assets'), { recursive: true });
  writeFileSync(join(project, COLD_TEXTURE_REL_PATH), minimalPng());
  writeFileSync(join(project, 'placeholder.png'), minimalPng());
  rmSync(join(project, '.godot', 'imported'), { recursive: true, force: true });
  writeFileSync(join(project, PROBE_SCENE), sceneWithNode(PROBE_SPRITE));
  return project;
}

/**
 * Run a batch through the handler, not through executeOperation: the
 * import-and-retry lives in executeSceneOp, so a bare executeOperation call
 * never exercises the replay these tests are about.
 */
async function runBatchThroughHandler(
  project: string,
  operations: object[],
): Promise<BatchOperationResult[]> {
  const result = await handleBatchSceneOperations(runner, { projectPath: project, operations });
  if (hasError(result)) throw new Error(errorText(result) ?? 'batch returned an error response');
  const payload = unwrap(result).structuredContent as { results: BatchOperationResult[] };
  return payload.results;
}

/** Child node names of the scene root, read back out of the engine. */
async function rootChildNames(project: string, scenePath: string): Promise<string[]> {
  const { stdout } = await runner.executeOperation(
    'get_scene_tree',
    { scenePath },
    project,
    READ_TIMEOUT_MS,
  );
  const tree = JSON.parse(extractJson(stdout)) as SceneTreeNode;
  return tree.children.map((child) => child.name);
}

/** Properties of one node, as the engine reports them after the batch. */
async function changedProperties(
  project: string,
  scenePath: string,
  nodePath: string,
): Promise<Record<string, unknown>> {
  const { stdout } = await runner.executeOperation(
    'get_node_properties',
    { scenePath, nodes: [{ nodePath, changedOnly: true }] },
    project,
    READ_TIMEOUT_MS,
  );
  const parsed = JSON.parse(extractJson(stdout)) as {
    results: Array<{ properties?: Record<string, unknown> }>;
  };
  return parsed.results[0]?.properties ?? {};
}

/**
 * The scene root holds exactly these children and nothing else. A batch that
 * was replayed over its own saved output shows up here as an extra node named
 * `@Node@2` or similar: Godot renames a colliding add_child instead of
 * failing it, so the duplicate is silent everywhere except the node list.
 */
function expectExactChildren(actual: string[], expected: string[]): void {
  expect(actual.filter((name) => name.startsWith('@'))).toEqual([]);
  expect([...actual].sort()).toEqual([...expected].sort());
  expect(actual).toHaveLength(expected.length);
}

/** Every operation in the batch reported success, none reported an error. */
function expectAllSucceeded(results: BatchOperationResult[], expectedCount: number): void {
  expect(results.map((r) => r.error ?? null)).toEqual(new Array(expectedCount).fill(null));
  expect(results.map((r) => r.success)).toEqual(new Array(expectedCount).fill(true));
}

beforeAll(async () => {
  runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
  await runner.detectGodotPath();
});

describe('batch cold-import pre-pass (integration)', () => {
  const tmp = useTmpDirs();

  itGodot(
    'does not mutate any scene when a later-referenced scene is cold',
    async () => {
      const project = tmp.make('godot-mcp-test-');
      cpSync(fixtureProjectPath, project, { recursive: true });

      const assetsDir = join(project, 'assets');
      mkdirSync(assetsDir, { recursive: true });
      writeFileSync(join(assetsDir, 'test_texture.png'), minimalPng());
      // The committed placeholder.png is intentionally invalid; give the temp
      // copy a valid one so import succeeds (this test is about ordering).
      writeFileSync(join(project, 'placeholder.png'), minimalPng());
      rmSync(join(project, '.godot', 'imported'), { recursive: true, force: true });

      // Scene A: warm (no texture refs). Scene B: cold (references the
      // unimported texture).
      writeFileSync(join(project, 'warm.tscn'), sceneWithNode('Warm'));
      writeFileSync(join(project, 'cold.tscn'), sceneWithNode('Cold', '1'));

      const before = readFileSync(join(project, 'warm.tscn'), 'utf8');

      // Batch: mutate the warm scene FIRST, then touch the cold one. Without
      // the pre-pass the warm mutation would already be saved when the cold
      // scene is discovered, and the retry would add WarmChild twice.
      const { stdout, stderr } = await runner.executeOperation(
        'batch_scene_operations',
        {
          operations: [
            {
              operation: 'add_node',
              scenePath: 'warm.tscn',
              nodeName: 'WarmChild',
              nodeType: 'Node2D',
            },
            {
              operation: 'add_node',
              scenePath: 'cold.tscn',
              nodeName: 'ColdChild',
              nodeType: 'Node2D',
            },
          ],
        },
        project,
      );

      // The cold probe must have exited the whole batch before any mutation.
      expect(stderr).toContain('[IMPORT_NEEDED]');
      expect(stderr).toContain('res://assets/test_texture.png');
      expect(stdout.trim()).toBe('');
      expect(readFileSync(join(project, 'warm.tscn'), 'utf8')).toBe(before);

      // Import and replay: both scenes mutate exactly once now.
      await runner.importAssets(project);
      expect(existsSync(join(project, '.godot', 'imported'))).toBe(true);
      const retry = await runner.executeOperation(
        'batch_scene_operations',
        {
          operations: [
            {
              operation: 'add_node',
              scenePath: 'warm.tscn',
              nodeName: 'WarmChild',
              nodeType: 'Node2D',
            },
            {
              operation: 'add_node',
              scenePath: 'cold.tscn',
              nodeName: 'ColdChild',
              nodeType: 'Node2D',
            },
          ],
        },
        project,
      );
      expect(retry.stdout).toContain('"success":true');

      // And the warm scene's mutation landed exactly once on disk.
      const after = readFileSync(join(project, 'warm.tscn'), 'utf8');
      expect(after.match(/WarmChild/g)?.length).toBe(1);
    },
    IMPORT_TEST_TIMEOUT_MS,
  );

  itGodot(
    'probes an asset that only a later add_node properties dict references',
    async () => {
      // Same shape as above, but the cold asset is reachable only through a
      // property value: a res:// path nested inside an inline resource spec.
      // Found lazily, its [IMPORT_NEEDED] fires after the first operation has
      // already mutated and auto-saved, and the retry duplicates that mutation.
      const project = tmp.make('godot-mcp-test-');
      cpSync(fixtureProjectPath, project, { recursive: true });

      const assetsDir = join(project, 'assets');
      mkdirSync(assetsDir, { recursive: true });
      writeFileSync(join(assetsDir, 'test_texture.png'), minimalPng());
      writeFileSync(join(project, 'placeholder.png'), minimalPng());
      rmSync(join(project, '.godot', 'imported'), { recursive: true, force: true });

      // Both scenes are warm: nothing in either .tscn references the texture.
      writeFileSync(join(project, 'warm.tscn'), sceneWithNode('Warm'));
      writeFileSync(join(project, 'second.tscn'), sceneWithNode('Second'));
      const before = readFileSync(join(project, 'warm.tscn'), 'utf8');

      const operations = [
        {
          operation: 'add_node',
          scenePath: 'warm.tscn',
          nodeName: 'WarmChild',
          nodeType: 'Node2D',
        },
        {
          operation: 'add_node',
          scenePath: 'second.tscn',
          nodeName: 'Textured',
          nodeType: 'Sprite2D',
          properties: {
            material: {
              type: 'CanvasItemMaterial',
            },
            texture: 'res://assets/test_texture.png',
          },
        },
      ];

      const { stdout, stderr } = await runner.executeOperation(
        'batch_scene_operations',
        { operations },
        project,
      );

      expect(stderr).toContain('[IMPORT_NEEDED]');
      expect(stderr).toContain('res://assets/test_texture.png');
      expect(stdout.trim()).toBe('');
      // The decisive assertion: nothing was written before the refusal.
      expect(readFileSync(join(project, 'warm.tscn'), 'utf8')).toBe(before);

      await runner.importAssets(project);
      const retry = await runner.executeOperation(
        'batch_scene_operations',
        { operations },
        project,
      );
      expect(retry.stdout).toContain('"success":true');
      expect(readFileSync(join(project, 'warm.tscn'), 'utf8').match(/WarmChild/g)?.length).toBe(1);
    },
    IMPORT_TEST_TIMEOUT_MS,
  );
});

/**
 * The caller's real shapes, through the handler so the import-and-retry in
 * executeSceneOp actually runs. Each case pairs a mutating operation with a
 * second operation that references a cold asset through one of the path
 * parameters or property values the pre-pass has to cover. The assertion that
 * matters is the node list afterwards: a pre-pass that misses the reference
 * lets the first operation mutate and save, and the retry then applies it a
 * second time under an engine-assigned name.
 */
describe('batch cold-import pre-pass, caller-shaped references (integration)', () => {
  const tmp = useTmpDirs();

  itGodot(
    'covers a load_sprite texturePath spelled project-relative',
    async () => {
      const project = makeColdProject(tmp);

      const results = await runBatchThroughHandler(project, [
        {
          operation: 'add_node',
          scenePath: PROBE_SCENE,
          nodeType: 'Node',
          nodeName: 'PrepassProbe',
        },
        {
          operation: 'load_sprite',
          scenePath: PROBE_SCENE,
          nodePath: `root/${PROBE_SPRITE}`,
          texturePath: COLD_TEXTURE_REL_PATH,
        },
      ]);

      expectAllSucceeded(results, 2);
      expectExactChildren(await rootChildNames(project, PROBE_SCENE), [
        PROBE_SPRITE,
        'PrepassProbe',
      ]);
      const props = await changedProperties(project, PROBE_SCENE, `root/${PROBE_SPRITE}`);
      expect(String(props.texture)).toContain('Texture');
    },
    IMPORT_TEST_TIMEOUT_MS,
  );

  itGodot(
    'covers a load_sprite texturePath spelled res://',
    async () => {
      const project = makeColdProject(tmp);

      const results = await runBatchThroughHandler(project, [
        {
          operation: 'add_node',
          scenePath: PROBE_SCENE,
          nodeType: 'Node',
          nodeName: 'PrepassProbe',
        },
        {
          operation: 'load_sprite',
          scenePath: PROBE_SCENE,
          nodePath: `root/${PROBE_SPRITE}`,
          texturePath: COLD_TEXTURE_RES_PATH,
        },
      ]);

      expectAllSucceeded(results, 2);
      expectExactChildren(await rootChildNames(project, PROBE_SCENE), [
        PROBE_SPRITE,
        'PrepassProbe',
      ]);
      const props = await changedProperties(project, PROBE_SCENE, `root/${PROBE_SPRITE}`);
      expect(String(props.texture)).toContain('Texture');
    },
    IMPORT_TEST_TIMEOUT_MS,
  );

  itGodot(
    'covers a res:// path nested in an add_node properties dict',
    async () => {
      const project = makeColdProject(tmp);

      const results = await runBatchThroughHandler(project, [
        {
          operation: 'add_node',
          scenePath: PROBE_SCENE,
          nodeType: 'Node',
          nodeName: 'FirstProbe',
        },
        {
          operation: 'add_node',
          scenePath: PROBE_SCENE,
          nodeType: 'Sprite2D',
          nodeName: 'Textured',
          properties: { texture: COLD_TEXTURE_RES_PATH },
        },
      ]);

      expectAllSucceeded(results, 2);
      expectExactChildren(await rootChildNames(project, PROBE_SCENE), [
        PROBE_SPRITE,
        'FirstProbe',
        'Textured',
      ]);
      const props = await changedProperties(project, PROBE_SCENE, 'root/Textured');
      expect(String(props.texture)).toContain('Texture');
    },
    IMPORT_TEST_TIMEOUT_MS,
  );

  itGodot(
    'covers a res:// path in a set_node_properties update value',
    async () => {
      const project = makeColdProject(tmp);

      const results = await runBatchThroughHandler(project, [
        {
          operation: 'add_node',
          scenePath: PROBE_SCENE,
          nodeType: 'Node',
          nodeName: 'FirstProbe',
        },
        {
          operation: 'set_node_properties',
          scenePath: PROBE_SCENE,
          updates: [
            {
              nodePath: `root/${PROBE_SPRITE}`,
              property: 'texture',
              value: COLD_TEXTURE_RES_PATH,
            },
          ],
        },
      ]);

      expectAllSucceeded(results, 2);
      expectExactChildren(await rootChildNames(project, PROBE_SCENE), [PROBE_SPRITE, 'FirstProbe']);
      const props = await changedProperties(project, PROBE_SCENE, `root/${PROBE_SPRITE}`);
      expect(String(props.texture)).toContain('Texture');
    },
    IMPORT_TEST_TIMEOUT_MS,
  );

  itGodot(
    'covers an add_node nodeType that names a scene with a cold dependency',
    async () => {
      // node_type may name a scene to instance, and _instantiate_node_type
      // loads it directly instead of going through load_scene_instance, so
      // that scene's own dependencies are only probed if the pre-pass does it.
      const project = makeColdProject(tmp);
      writeFileSync(join(project, 'sub.tscn'), sceneWithNode('SubSprite', '1'));

      const results = await runBatchThroughHandler(project, [
        {
          operation: 'add_node',
          scenePath: PROBE_SCENE,
          nodeType: 'Node',
          nodeName: 'FirstProbe',
        },
        {
          operation: 'add_node',
          scenePath: PROBE_SCENE,
          nodeType: 'sub.tscn',
          nodeName: 'SubInstance',
        },
      ]);

      expectAllSucceeded(results, 2);
      expectExactChildren(await rootChildNames(project, PROBE_SCENE), [
        PROBE_SPRITE,
        'FirstProbe',
        'SubInstance',
      ]);
    },
    IMPORT_TEST_TIMEOUT_MS,
  );
});
