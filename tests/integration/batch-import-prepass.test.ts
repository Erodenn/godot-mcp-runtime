import { describe, beforeAll, expect } from 'vitest';
import { cpSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { itGodot } from '../helpers/godot-skip.js';
import { authoredFixtureProjectPath, fixtureProjectPath } from '../helpers/fixture-paths.js';
import { useTmpDirs, type TmpDirHandle } from '../helpers/tmp.js';
import { minimalPng } from '../helpers/png-fixtures.js';
import { stripExitLeakNoise } from '../helpers/engine-noise.js';
import { hasError, errorText, unwrap } from '../helpers/assertions.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { handleBatchSceneOperations } from '../../src/tools/scene-tools.js';
import { extractJson } from '../../src/utils/output-parsing.js';

const IMPORT_TEST_TIMEOUT_MS = 180000;

const READ_TIMEOUT_MS = 30000;

const COLD_TEXTURE_REL_PATH = 'assets/test_texture.png';
const COLD_TEXTURE_RES_PATH = `res://${COLD_TEXTURE_REL_PATH}`;

const PROBE_SCENE = 'probe.tscn';
const PROBE_SPRITE = 'Sprite2D';

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

/** The PNG has no .import sidecar and no .godot/imported entry, the state the cold-import probe exists for; the committed placeholder.png is invalid, so the copy gets a valid one. */
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

/** Goes through the handler, not executeOperation: the import-and-retry lives in executeSceneOp. */
async function runBatchThroughHandler(
  project: string,
  operations: object[],
): Promise<BatchOperationResult[]> {
  const result = await handleBatchSceneOperations(runner, { projectPath: project, operations });
  if (hasError(result)) throw new Error(errorText(result) ?? 'batch returned an error response');
  const payload = unwrap(result).structuredContent as { results: BatchOperationResult[] };
  return payload.results;
}

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

/** Godot renames a colliding add_child (`@Node@2`) instead of failing, so a replayed batch's duplicate shows only in the node list. */
function expectExactChildren(actual: string[], expected: string[]): void {
  expect(actual.filter((name) => name.startsWith('@'))).toEqual([]);
  expect([...actual].sort()).toEqual([...expected].sort());
  expect(actual).toHaveLength(expected.length);
}

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
      // The committed placeholder.png is intentionally invalid; give the copy a valid one so import succeeds.
      writeFileSync(join(project, 'placeholder.png'), minimalPng());
      rmSync(join(project, '.godot', 'imported'), { recursive: true, force: true });

      writeFileSync(join(project, 'warm.tscn'), sceneWithNode('Warm'));
      writeFileSync(join(project, 'cold.tscn'), sceneWithNode('Cold', '1'));

      const before = readFileSync(join(project, 'warm.tscn'), 'utf8');

      // Mutate the warm scene first: without the pre-pass its mutation is saved before the cold scene is found, and the retry adds WarmChild twice.
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

      expect(stderr).toContain('[IMPORT_NEEDED]');
      expect(stderr).toContain('res://assets/test_texture.png');
      expect(stripExitLeakNoise(stdout)).toBe('');
      expect(readFileSync(join(project, 'warm.tscn'), 'utf8')).toBe(before);

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

      const after = readFileSync(join(project, 'warm.tscn'), 'utf8');
      expect(after.match(/WarmChild/g)?.length).toBe(1);
    },
    IMPORT_TEST_TIMEOUT_MS,
  );

  itGodot(
    'probes an asset that only a later add_node properties dict references',
    async () => {
      // The cold asset is reachable only through a res:// path nested in an inline resource spec.
      const project = tmp.make('godot-mcp-test-');
      cpSync(fixtureProjectPath, project, { recursive: true });

      const assetsDir = join(project, 'assets');
      mkdirSync(assetsDir, { recursive: true });
      writeFileSync(join(assetsDir, 'test_texture.png'), minimalPng());
      writeFileSync(join(project, 'placeholder.png'), minimalPng());
      rmSync(join(project, '.godot', 'imported'), { recursive: true, force: true });

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
      expect(stripExitLeakNoise(stdout)).toBe('');
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

/** Each case pairs a mutating operation with one that references a cold asset; a pre-pass that misses it lets the retry apply the first operation twice. */
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
      // _instantiate_node_type loads the scene directly, not through load_scene_instance, so its dependencies are probed only if the pre-pass does it.
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

describe('batch cold-import pre-pass, res:// strings on non-Object properties (integration)', () => {
  const tmp = useTmpDirs();

  function makeAuthoredProject(): string {
    const project = tmp.make('godot-mcp-authored-');
    cpSync(authoredFixtureProjectPath, project, { recursive: true });
    return project;
  }

  function importedNothing(project: string): boolean {
    return (
      !existsSync(join(project, 'notes.txt.import')) &&
      !existsSync(join(project, '.godot', 'imported'))
    );
  }

  itGodot(
    'stores a res:// string on a String property without importing it',
    async () => {
      const project = makeAuthoredProject();

      const results = await runBatchThroughHandler(project, [
        {
          operation: 'set_node_properties',
          scenePath: 'player.tscn',
          updates: [{ nodePath: 'root', property: 'note', value: 'res://notes.txt' }],
        },
      ]);

      expect(results[0]?.success).toBe(true);
      expect(readFileSync(join(project, 'player.tscn'), 'utf8')).toContain(
        'note = "res://notes.txt"',
      );
      expect(importedNothing(project)).toBe(true);
    },
    IMPORT_TEST_TIMEOUT_MS,
  );

  itGodot(
    'stores a res:// string on a metadata key without importing it',
    async () => {
      const project = makeAuthoredProject();

      const results = await runBatchThroughHandler(project, [
        {
          operation: 'set_node_properties',
          scenePath: 'player.tscn',
          updates: [{ nodePath: 'root', property: 'metadata/source', value: 'res://notes.txt' }],
        },
      ]);

      expect(results[0]?.success).toBe(true);
      expect(readFileSync(join(project, 'player.tscn'), 'utf8')).toContain('res://notes.txt');
      expect(importedNothing(project)).toBe(true);
    },
    IMPORT_TEST_TIMEOUT_MS,
  );
});
