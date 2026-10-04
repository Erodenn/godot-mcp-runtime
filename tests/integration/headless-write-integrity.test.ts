/**
 * Integration tests for headless writes that used to report success for work
 * that did not happen: an unloadable or unsaveable scene returned as a success,
 * a batch that discarded the result of its final save, two spellings of one
 * scene overwriting each other, a scene instanced into itself, and values a
 * scene file cannot store (a script constant, null or a fraction on an int
 * property, and a non-exported script variable, which is set and reported in a
 * leading warning). Node-level slash keys (`metadata/<name>` and keys the
 * node itself declares) are covered here too.
 *
 * The real handlers run against a tmp copy of the fixture project and every
 * assertion reads a parsed payload, never .tscn text. Read-only scenes are made
 * with chmod and restored in a finally block so cleanup can delete them.
 *
 * Requires GODOT_PATH. Skipped locally when it is unset; CI sets it in the
 * godot-integration job.
 */

import { describe, beforeAll, beforeEach, afterAll, expect } from 'vitest';
import { chmodSync, cpSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { itGodot } from '../helpers/godot-skip.js';
import { fixtureProjectPath } from '../helpers/fixture-paths.js';
import { dropProjectFeatureVersion } from '../helpers/tmp.js';
import { errorText, hasError } from '../helpers/assertions.js';
import { expectMatchesOutputSchema } from '../helpers/schema-assert.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import {
  handleAddNode,
  handleBatchSceneOperations,
  handleCreateScene,
} from '../../src/tools/scene-tools.js';
import {
  handleAttachScript,
  handleDeleteNodes,
  handleGetNodeProperties,
  handleGetSceneTree,
  handleSetNodeProperties,
} from '../../src/tools/node-tools.js';

const SCENE = 'main.tscn';
const READ_ONLY_SCENE = 'locked.tscn';
const BROKEN_SCENE = 'broken.tscn';
const SELF_SCENE = 'level.tscn';
const TWO_SPELLING_SCENE = 'twice.tscn';
const HOST_SCENE = 'host.tscn';
const SCRIPT_FILE = 'stored_values.gd';
const CASE_TIMEOUT_MS = 120000;
const READ_ONLY_MODE = 0o444;
const WRITABLE_MODE = 0o644;

/** A scene whose Sprite2D names a texture that is not on disk. */
const MISSING_DEPENDENCY_SCENE = [
  '[gd_scene load_steps=2 format=3]',
  '',
  '[ext_resource type="Texture2D" path="res://not_on_disk.png" id="1_missing"]',
  '',
  '[node name="Main" type="Node2D"]',
  '',
  '[node name="Sprite" type="Sprite2D" parent="."]',
  'texture = ExtResource("1_missing")',
  '',
].join('\n');

/** One exported and one non-exported variable, a constant, and an int array of each flavor. */
const STORED_VALUES_SCRIPT = [
  'extends Node2D',
  '',
  'const MAX_HP := 5',
  'var hidden_hp := 10',
  '@export var shown_hp := 3',
  '@export var counts: PackedInt32Array = PackedInt32Array()',
  '@export var ids: Array[int] = []',
  '',
].join('\n');

interface TreeNode {
  name: string;
  children: TreeNode[] | null;
}

type Entry = Record<string, unknown>;

let runner: GodotRunner;
let projectPath: string;
const tmpDirs: string[] = [];

beforeAll(async () => {
  runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
  await runner.detectGodotPath();
});

beforeEach(() => {
  projectPath = join(tmpdir(), `godot-mcp-integrity-${randomBytes(6).toString('hex')}`);
  cpSync(fixtureProjectPath, projectPath, { recursive: true });
  // These tests assert exact warnings. Without a stated engine version the
  // newer-engine warning stays out of them on every engine CI runs.
  dropProjectFeatureVersion(projectPath);
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

async function createScene(scenePath: string): Promise<void> {
  const result = await handleCreateScene(runner, {
    projectPath,
    scenePath,
    rootNodeType: 'Node2D',
  });
  expect(hasError(result), String(errorText(result))).toBe(false);
}

async function addNode(scenePath: string, nodeType: string, nodeName: string): Promise<void> {
  const result = await handleAddNode(runner, { projectPath, scenePath, nodeType, nodeName });
  expect(hasError(result), String(errorText(result))).toBe(false);
}

/** Run `body` with a scene file made read-only, restoring it afterwards. */
async function withReadOnly<T>(scenePath: string, body: () => Promise<T>): Promise<T> {
  const file = join(projectPath, scenePath);
  chmodSync(file, READ_ONLY_MODE);
  try {
    return await body();
  } finally {
    chmodSync(file, WRITABLE_MODE);
  }
}

async function setProp(nodePath: string, property: string, value: unknown): Promise<Entry> {
  const result = await handleSetNodeProperties(runner, {
    projectPath,
    scenePath: SCENE,
    updates: [{ nodePath, property, value }],
  });
  const payload = expectMatchesOutputSchema('set_node_properties', result);
  const [entry] = payload.results as Entry[];
  if (!entry) throw new Error('set_node_properties returned no entry');
  return entry;
}

async function readProps(scenePath: string, nodePath: string): Promise<Entry> {
  const result = await handleGetNodeProperties(runner, {
    projectPath,
    scenePath,
    nodes: [{ nodePath }],
  });
  const payload = expectMatchesOutputSchema('get_node_properties', result);
  const [entry] = payload.results as Entry[];
  if (!entry) throw new Error('get_node_properties returned no entry');
  expect(entry).not.toHaveProperty('error');
  return entry.properties as Entry;
}

async function batch(operations: object[]): Promise<Record<string, unknown>> {
  const result = await handleBatchSceneOperations(runner, { projectPath, operations });
  return expectMatchesOutputSchema('batch_scene_operations', result);
}

describe('an unloadable or unsaveable scene is an error response', () => {
  itGodot(
    'set_node_properties on a scene with a missing dependency is an error response',
    async () => {
      writeFileSync(join(projectPath, BROKEN_SCENE), MISSING_DEPENDENCY_SCENE, 'utf-8');
      const result = await handleSetNodeProperties(runner, {
        projectPath,
        scenePath: BROKEN_SCENE,
        updates: [{ nodePath: 'root', property: 'visible', value: false }],
      });
      expect(hasError(result)).toBe(true);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'get_node_properties on an unloadable scene is an error response',
    async () => {
      writeFileSync(join(projectPath, BROKEN_SCENE), MISSING_DEPENDENCY_SCENE, 'utf-8');
      const result = await handleGetNodeProperties(runner, {
        projectPath,
        scenePath: BROKEN_SCENE,
        nodes: [{ nodePath: 'root' }],
      });
      expect(hasError(result)).toBe(true);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'set_node_properties on a read-only scene is an error response',
    async () => {
      await createScene(READ_ONLY_SCENE);
      const result = await withReadOnly(READ_ONLY_SCENE, () =>
        handleSetNodeProperties(runner, {
          projectPath,
          scenePath: READ_ONLY_SCENE,
          updates: [{ nodePath: 'root', property: 'visible', value: false }],
        }),
      );
      expect(hasError(result)).toBe(true);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'delete_nodes on a read-only scene is an error response',
    async () => {
      await createScene(READ_ONLY_SCENE);
      await addNode(READ_ONLY_SCENE, 'Node2D', 'Doomed');
      const result = await withReadOnly(READ_ONLY_SCENE, () =>
        handleDeleteNodes(runner, {
          projectPath,
          scenePath: READ_ONLY_SCENE,
          nodePaths: ['root/Doomed'],
        }),
      );
      expect(hasError(result)).toBe(true);
    },
    CASE_TIMEOUT_MS,
  );
});

describe('batch_scene_operations reports what it saved', () => {
  itGodot(
    'a batch whose final save fails reports its entries as errors and leads with a warning',
    async () => {
      await createScene(READ_ONLY_SCENE);
      const payload = await withReadOnly(READ_ONLY_SCENE, () =>
        batch([
          { operation: 'add_node', scenePath: READ_ONLY_SCENE, nodeType: 'Node2D', nodeName: 'A' },
          { operation: 'add_node', scenePath: READ_ONLY_SCENE, nodeType: 'Node2D', nodeName: 'B' },
        ]),
      );
      const results = payload.results as Entry[];
      expect(results).toHaveLength(2);
      for (const entry of results) {
        expect(entry).not.toHaveProperty('success');
        expect(String(entry.error)).toContain(READ_ONLY_SCENE);
      }
      expect(Object.keys(payload)[0]).toBe('warnings');
      expect(String((payload.warnings as string[])[0])).toContain(READ_ONLY_SCENE);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'two spellings of one scene in a batch both land',
    async () => {
      await createScene(TWO_SPELLING_SCENE);
      const payload = await batch([
        { operation: 'add_node', scenePath: TWO_SPELLING_SCENE, nodeType: 'Node2D', nodeName: 'A' },
        {
          operation: 'add_node',
          scenePath: `res://${TWO_SPELLING_SCENE}`,
          nodeType: 'Node2D',
          nodeName: 'B',
        },
      ]);
      const results = payload.results as Entry[];
      expect(results.map((entry) => entry.success)).toEqual([true, true]);

      const tree = expectMatchesOutputSchema(
        'get_scene_tree',
        await handleGetSceneTree(runner, { projectPath, scenePath: TWO_SPELLING_SCENE }),
      ) as unknown as TreeNode;
      const childNames = (tree.children ?? []).map((child) => child.name);
      expect(childNames).toContain('A');
      expect(childNames).toContain('B');
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'a batch set_node_properties entry with a failed update leads with a warning',
    async () => {
      const payload = await batch([
        {
          operation: 'set_node_properties',
          scenePath: SCENE,
          updates: [
            { nodePath: 'root', property: 'visible', value: false },
            { nodePath: 'root/Ghost', property: 'visible', value: true },
          ],
        },
      ]);
      const results = payload.results as Entry[];
      expect(results[0]?.success).toBe(true);
      expect(Object.keys(payload)[0]).toBe('warnings');
      expect(String((payload.warnings as string[])[0])).toMatch(/^operations\[0\]:/);
    },
    CASE_TIMEOUT_MS,
  );
});

describe('add_node refuses to instance a scene into itself', () => {
  itGodot(
    'add_node refuses to instance a scene into itself, standalone and batch',
    async () => {
      await createScene(SELF_SCENE);
      const standalone = await handleAddNode(runner, {
        projectPath,
        scenePath: SELF_SCENE,
        nodeType: SELF_SCENE,
        nodeName: 'Again',
      });
      expect(hasError(standalone)).toBe(true);
      expect(String(errorText(standalone))).toMatch(/into itself/);

      const payload = await batch([
        {
          operation: 'add_node',
          scenePath: `res://${SELF_SCENE}`,
          nodeType: SELF_SCENE,
          nodeName: 'Again',
        },
      ]);
      const [entry] = payload.results as Entry[];
      expect(entry).not.toHaveProperty('success');
      expect(String(entry?.error)).toMatch(/into itself/);
    },
    CASE_TIMEOUT_MS,
  );
});

describe('node-level slash keys', () => {
  itGodot(
    'set_node_properties sets metadata and get_node_properties reads it back',
    async () => {
      const entry = await setProp('root', 'metadata/mine', 'hello');
      expect(entry.success).toBe(true);
      const props = await readProps(SCENE, 'root');
      expect(props['metadata/mine']).toBe('hello');
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'null on a metadata key removes it',
    async () => {
      await setProp('root', 'metadata/mine', 'hello');
      const entry = await setProp('root', 'metadata/mine', null);
      expect(entry.success).toBe(true);
      const props = await readProps(SCENE, 'root');
      expect(props).not.toHaveProperty('metadata/mine');
    },
    CASE_TIMEOUT_MS,
  );

  // Metadata is untyped: nothing declares what a key should hold, so the value
  // is stored as it was sent. A dictionary used to be turned into a vector when
  // it had x and y keys, which dropped its other keys under a success.
  itGodot(
    'a dictionary written to a metadata key is stored as that dictionary, vector-shaped or not',
    async () => {
      const spawn = { x: 4, y: 2, name: 'left gate' };
      const corner = { x: 'left', y: 'top' };
      const tint = { r: 1, g: 0, b: 0, note: 'warning color' };
      expect((await setProp('root', 'metadata/spawn', spawn)).success).toBe(true);
      expect((await setProp('root', 'metadata/corner', corner)).success).toBe(true);
      expect((await setProp('root', 'metadata/tint', tint)).success).toBe(true);

      const props = await readProps(SCENE, 'root');
      expect(props['metadata/spawn']).toEqual(spawn);
      expect(props['metadata/corner']).toEqual(corner);
      expect(props['metadata/tint']).toEqual(tint);
    },
    CASE_TIMEOUT_MS,
  );

  // A vector-shaped dictionary whose components are not numbers cannot become
  // a vector. It reaches the type check as the dictionary it is and is refused
  // there, instead of a failed conversion standing in for null.
  itGodot(
    'a vector-shaped dictionary with non-numeric components is an error on a typed property',
    async () => {
      const onVector = await setProp('root', 'position', { x: 'left', y: 'top' });
      expect(onVector).not.toHaveProperty('success');
      expect(String(onVector.error)).toMatch(/expected Vector2, got Dictionary/);

      const onObject = await setProp('root/Sprite2D', 'texture', { x: 'left', y: 'top' });
      expect(onObject).not.toHaveProperty('success');
      expect(String(onObject.error)).toContain('Object-typed');

      // The well-formed vector still converts.
      expect((await setProp('root', 'position', { x: 12, y: 34 })).success).toBe(true);
      const props = await readProps(SCENE, 'root');
      expect(props.position).toEqual({ x: 12, y: 34 });
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'add_node sets metadata through properties and get_node_properties reads it back',
    async () => {
      const result = await handleAddNode(runner, {
        projectPath,
        scenePath: SCENE,
        nodeType: 'Node2D',
        nodeName: 'Tagged',
        properties: { 'metadata/myKey': 'camelCaseKeptAsWritten' },
      });
      const payload = expectMatchesOutputSchema('add_node', result);
      const props = await readProps(SCENE, String(payload.nodePath));
      expect(props['metadata/myKey']).toBe('camelCaseKeptAsWritten');
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'an invalid metadata name is an error naming the key',
    async () => {
      const badKeys = ['metadata/1bad', 'metadata/', 'metadata/has space'];
      for (const key of badKeys) {
        const entry = await setProp('root', key, 1);
        expect(entry).not.toHaveProperty('success');
        expect(String(entry.error)).toContain(key);
      }

      const added = await handleAddNode(runner, {
        projectPath,
        scenePath: SCENE,
        nodeType: 'Node2D',
        nodeName: 'Bad',
        properties: { 'metadata/1bad': 1 },
      });
      expect(hasError(added)).toBe(true);
      expect(String(errorText(added))).toContain('metadata/1bad');
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'a slash key the node does not declare is an error naming the key',
    async () => {
      const entry = await setProp('root', 'invented_group/thing', 1);
      expect(entry).not.toHaveProperty('success');
      expect(String(entry.error)).toContain('invented_group/thing');
      expect(String(entry.error)).toContain('run_script');
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'a theme override slash key round-trips',
    async () => {
      const red = { r: 1, g: 0, b: 0, a: 1 };
      const entry = await setProp('root/Label', 'theme_override_colors/font_color', red);
      expect(entry.success).toBe(true);
      const props = await readProps(SCENE, 'root/Label');
      expect(props['theme_override_colors/font_color']).toEqual(red);
    },
    CASE_TIMEOUT_MS,
  );
});

describe('values a scene file cannot store are refused or reported', () => {
  async function sceneWithStoredValuesScript(): Promise<void> {
    writeFileSync(join(projectPath, SCRIPT_FILE), STORED_VALUES_SCRIPT, 'utf-8');
    const result = await handleAttachScript(runner, {
      projectPath,
      scenePath: SCENE,
      nodePath: 'root',
      scriptPath: SCRIPT_FILE,
    });
    expect(hasError(result), String(errorText(result))).toBe(false);
  }

  itGodot(
    'a non-exported script variable is set, with a leading warning that the scene file does not store it',
    async () => {
      await sceneWithStoredValuesScript();
      const result = await handleSetNodeProperties(runner, {
        projectPath,
        scenePath: SCENE,
        updates: [
          { nodePath: 'root', property: 'visible', value: true },
          { nodePath: 'root', property: 'hidden_hp', value: 5 },
        ],
      });
      const payload = expectMatchesOutputSchema('set_node_properties', result);
      const results = payload.results as Entry[];
      expect(results.map((entry) => entry.success)).toEqual([true, true]);
      expect(Object.keys(payload)[0]).toBe('warnings');
      const warnings = payload.warnings as string[];
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/^updates\[1\]: /);
      expect(warnings[0]).toContain("'hidden_hp'");
      expect(warnings[0]).toContain('@export');
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'an exported script variable is still set and carries no warning',
    async () => {
      await sceneWithStoredValuesScript();
      const result = await handleSetNodeProperties(runner, {
        projectPath,
        scenePath: SCENE,
        updates: [{ nodePath: 'root', property: 'shown_hp', value: 7 }],
      });
      const payload = expectMatchesOutputSchema('set_node_properties', result);
      expect((payload.results as Entry[])[0]?.success).toBe(true);
      expect(payload).not.toHaveProperty('warnings');
      const props = await readProps(SCENE, 'root');
      expect(props.shown_hp).toBe(7);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'a batch update of a non-exported script variable leads with a warning naming the operation',
    async () => {
      await sceneWithStoredValuesScript();
      const payload = await batch([
        {
          operation: 'set_node_properties',
          scenePath: SCENE,
          updates: [{ nodePath: 'root', property: 'hidden_hp', value: 5 }],
        },
      ]);
      expect((payload.results as Entry[])[0]?.success).toBe(true);
      expect(Object.keys(payload)[0]).toBe('warnings');
      const warnings = payload.warnings as string[];
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/^operations\[0\]: updates\[0\]: /);
      expect(warnings[0]).toContain("'hidden_hp'");
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'add_node leads with a warning for a non-exported script variable on an instanced scene',
    async () => {
      await sceneWithStoredValuesScript();
      await createScene(HOST_SCENE);
      const result = await handleAddNode(runner, {
        projectPath,
        scenePath: HOST_SCENE,
        nodeType: SCENE,
        nodeName: 'Instanced',
        properties: { hidden_hp: 5 },
      });
      const payload = expectMatchesOutputSchema('add_node', result);
      expect(Object.keys(payload)[0]).toBe('warnings');
      const warnings = payload.warnings as string[];
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("'hidden_hp'");
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'a script constant is an error, not a value reported as set',
    async () => {
      await sceneWithStoredValuesScript();
      const entry = await setProp('root', 'MAX_HP', 9);
      expect(entry).not.toHaveProperty('success');
      expect(String(entry.error)).toContain('MAX_HP');
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'null on an int property is an error',
    async () => {
      const entry = await setProp('root', 'z_index', null);
      expect(entry).not.toHaveProperty('success');
      expect(String(entry.error)).toContain('z_index');
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'null on an Object-typed property still clears it',
    async () => {
      await addNode(SCENE, 'CollisionShape2D', 'ClearShape');
      const entry = await setProp('root/ClearShape', 'shape', null);
      expect(entry.success).toBe(true);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'a fractional number on an int property is an error',
    async () => {
      const entry = await setProp('root', 'z_index', 1.7);
      expect(entry).not.toHaveProperty('success');
      expect(String(entry.error)).toMatch(/whole number/);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'a whole float on an int property is still accepted',
    async () => {
      const entry = await setProp('root', 'z_index', 3.0);
      expect(entry.success).toBe(true);
      const props = await readProps(SCENE, 'root');
      expect(props.z_index).toBe(3);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'a fractional element in a PackedInt32Array is an error naming its index',
    async () => {
      await sceneWithStoredValuesScript();
      const packed = await setProp('root', 'counts', [1, 2.5, 3]);
      expect(packed).not.toHaveProperty('success');
      expect(String(packed.error)).toMatch(/element 1/);
      const typed = await setProp('root', 'ids', [4, 5, 6.25]);
      expect(typed).not.toHaveProperty('success');
      expect(String(typed.error)).toMatch(/element 2/);
    },
    CASE_TIMEOUT_MS,
  );
});
