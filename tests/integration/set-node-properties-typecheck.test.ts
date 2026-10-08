import { describe, beforeAll, beforeEach, afterAll, expect } from 'vitest';
import { cpSync, readFileSync, writeFileSync } from 'fs';
import { removeTmpDir } from '../helpers/tmp.js';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { engineMajorMinor, itGodot } from '../helpers/godot-skip.js';
import { authoredFixtureProjectPath, fixtureProjectPath } from '../helpers/fixture-paths.js';
import { expectMatchesOutputSchema } from '../helpers/schema-assert.js';
import { handleSetNodeProperties } from '../../src/tools/node-tools.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { extractJson, OPERATION_RESULT_SENTINEL } from '../../src/utils/output-parsing.js';

function makeTmpProject(): string {
  const id = randomBytes(6).toString('hex');
  const dst = join(tmpdir(), `godot-mcp-test-${id}`);
  cpSync(fixtureProjectPath, dst, { recursive: true });
  return dst;
}

const tmpDirs: string[] = [];

let runner: GodotRunner;

beforeAll(async () => {
  runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
  await runner.detectGodotPath();
});

beforeEach(() => {
  tmpDirs.push(makeTmpProject());
});

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      removeTmpDir(dir);
    } catch {}
  }
});

describe('set_node_properties type validation (silent-success gap)', () => {
  itGodot(
    'errors when a dict value is assigned to a Resource-typed property (was silent success)',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      const scenePath = join(tmpProject, 'main.tscn');

      await runner.executeOperation(
        'add_node',
        {
          scenePath: 'main.tscn',
          nodeType: 'CollisionShape2D',
          nodeName: 'ShapeHolder',
          parentNodePath: '.',
        },
        tmpProject,
        30000,
      );

      // The classic silent-drop case: a bare dictionary on a Shape2D Resource property.
      const { stdout } = await runner.executeOperation(
        'set_node_properties',
        {
          scenePath: 'main.tscn',
          updates: [{ nodePath: 'ShapeHolder', property: 'shape', value: { x: 100, y: 50 } }],
        },
        tmpProject,
        30000,
      );

      const parsed = JSON.parse(extractJson(stdout));
      expect(parsed.results[0].error).toMatch(/cannot|fail|invalid|mismatch|type/i);
      expect(parsed.results[0].success).toBeUndefined();
      const sceneText = readFileSync(scenePath, 'utf-8');
      expect(sceneText).not.toMatch(/shape\s*=/);
    },
    60000,
  );

  itGodot(
    'still succeeds for valid Vector dict values (no regression)',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      const scenePath = join(tmpProject, 'main.tscn');

      const { stdout } = await runner.executeOperation(
        'set_node_properties',
        {
          scenePath: 'main.tscn',
          updates: [{ nodePath: '.', property: 'position', value: { x: 10, y: 20 } }],
        },
        tmpProject,
        30000,
      );

      const parsed = JSON.parse(extractJson(stdout));
      expect(parsed.results[0].success).toBe(true);
      const sceneText = readFileSync(scenePath, 'utf-8');
      expect(sceneText).toContain('position = Vector2(10, 20)');
    },
    60000,
  );

  itGodot(
    'still succeeds for an int property (z_index) and persists the int value',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      const scenePath = join(tmpProject, 'main.tscn');

      const { stdout } = await runner.executeOperation(
        'set_node_properties',
        {
          scenePath: 'main.tscn',
          updates: [{ nodePath: '.', property: 'z_index', value: 3 }],
        },
        tmpProject,
        30000,
      );

      const parsed = JSON.parse(extractJson(stdout));
      expect(parsed.results[0].success).toBe(true);
      const sceneText = readFileSync(scenePath, 'utf-8');
      expect(sceneText).toContain('z_index = 3');
    },
    60000,
  );

  itGodot(
    'still succeeds for a NodePath property (remote_path) from a plain string',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      const scenePath = join(tmpProject, 'main.tscn');

      await runner.executeOperation(
        'add_node',
        {
          scenePath: 'main.tscn',
          nodeType: 'RemoteTransform2D',
          nodeName: 'Remote',
          parentNodePath: '.',
        },
        tmpProject,
        30000,
      );

      const { stdout } = await runner.executeOperation(
        'set_node_properties',
        {
          scenePath: 'main.tscn',
          updates: [{ nodePath: 'Remote', property: 'remote_path', value: '../Label' }],
        },
        tmpProject,
        30000,
      );

      const parsed = JSON.parse(extractJson(stdout));
      expect(parsed.results[0].success).toBe(true);
      const sceneText = readFileSync(scenePath, 'utf-8');
      expect(sceneText).toContain('remote_path = NodePath("../Label")');
    },
    60000,
  );

  itGodot(
    'still succeeds for a StringName property (theme_type_variation) from a plain string',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      const scenePath = join(tmpProject, 'main.tscn');

      const { stdout } = await runner.executeOperation(
        'set_node_properties',
        {
          scenePath: 'main.tscn',
          updates: [{ nodePath: 'Label', property: 'theme_type_variation', value: 'HeaderLarge' }],
        },
        tmpProject,
        30000,
      );

      const parsed = JSON.parse(extractJson(stdout));
      expect(parsed.results[0].success).toBe(true);
      const sceneText = readFileSync(scenePath, 'utf-8');
      expect(sceneText).toContain('theme_type_variation = &"HeaderLarge"');
    },
    60000,
  );

  itGodot(
    'allows null to clear an Object-typed property',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];

      await runner.executeOperation(
        'add_node',
        {
          scenePath: 'main.tscn',
          nodeType: 'CollisionShape2D',
          nodeName: 'ClearShape',
          parentNodePath: '.',
        },
        tmpProject,
        30000,
      );

      const { stdout } = await runner.executeOperation(
        'set_node_properties',
        {
          scenePath: 'main.tscn',
          updates: [{ nodePath: 'ClearShape', property: 'shape', value: null }],
        },
        tmpProject,
        30000,
      );

      const parsed = JSON.parse(extractJson(stdout));
      expect(parsed.results[0].success).toBe(true);
    },
    60000,
  );

  itGodot(
    'auto-loads a res:// path assigned to an Object-typed property and persists it as an ExtResource',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      const scenePath = join(tmpProject, 'main.tscn');

      writeFileSync(
        join(tmpProject, 'shape.tres'),
        '[gd_resource type="RectangleShape2D" format=3]\n\n[resource]\nsize = Vector2(4, 4)\n',
        'utf-8',
      );

      await runner.executeOperation(
        'add_node',
        {
          scenePath: 'main.tscn',
          nodeType: 'CollisionShape2D',
          nodeName: 'LoadedShape',
          parentNodePath: '.',
        },
        tmpProject,
        30000,
      );

      const { stdout } = await runner.executeOperation(
        'set_node_properties',
        {
          scenePath: 'main.tscn',
          updates: [{ nodePath: 'LoadedShape', property: 'shape', value: 'res://shape.tres' }],
        },
        tmpProject,
        30000,
      );

      const parsed = JSON.parse(extractJson(stdout));
      expect(parsed.results[0].success).toBe(true);
      const sceneText = readFileSync(scenePath, 'utf-8');
      expect(sceneText).toMatch(/ext_resource type="Shape2D" path="res:\/\/shape\.tres"/);
      expect(sceneText).toMatch(/shape = ExtResource\(/);
    },
    60000,
  );

  itGodot(
    'errors when a res:// path does not exist',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];

      await runner.executeOperation(
        'add_node',
        {
          scenePath: 'main.tscn',
          nodeType: 'CollisionShape2D',
          nodeName: 'MissingShape',
          parentNodePath: '.',
        },
        tmpProject,
        30000,
      );

      const { stdout } = await runner.executeOperation(
        'set_node_properties',
        {
          scenePath: 'main.tscn',
          updates: [
            { nodePath: 'MissingShape', property: 'shape', value: 'res://does-not-exist.tres' },
          ],
        },
        tmpProject,
        30000,
      );

      const parsed = JSON.parse(extractJson(stdout));
      expect(parsed.results[0].success).toBeUndefined();
      expect(parsed.results[0].error).toMatch(/failed to load resource/i);
    },
    60000,
  );

  itGodot(
    'errors when a String is assigned to an int property (z_index) and does not persist',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      const scenePath = join(tmpProject, 'main.tscn');
      const originalTscn = readFileSync(scenePath, 'utf-8');

      const { stdout } = await runner.executeOperation(
        'set_node_properties',
        {
          scenePath: 'main.tscn',
          updates: [{ nodePath: '.', property: 'z_index', value: 'abc' }],
        },
        tmpProject,
        30000,
      );

      const parsed = JSON.parse(extractJson(stdout));
      expect(parsed.results[0].success).toBeUndefined();
      expect(parsed.results[0].error).toMatch(/int/i);
      expect(parsed.results[0].error).toMatch(/String/);
      const sceneText = readFileSync(scenePath, 'utf-8');
      expect(sceneText).toBe(originalTscn);
    },
    60000,
  );

  itGodot(
    'errors when a String is assigned to a Vector2 property (position) and does not persist',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      const scenePath = join(tmpProject, 'main.tscn');
      const originalTscn = readFileSync(scenePath, 'utf-8');

      const { stdout } = await runner.executeOperation(
        'set_node_properties',
        {
          scenePath: 'main.tscn',
          updates: [{ nodePath: '.', property: 'position', value: 'abc' }],
        },
        tmpProject,
        30000,
      );

      const parsed = JSON.parse(extractJson(stdout));
      expect(parsed.results[0].success).toBeUndefined();
      expect(parsed.results[0].error).toMatch(/cannot|expected|type/i);
      const sceneText = readFileSync(scenePath, 'utf-8');
      expect(sceneText).toBe(originalTscn);
    },
    60000,
  );

  itGodot(
    'still succeeds assigning a bool to an int property (z_index)',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      const scenePath = join(tmpProject, 'main.tscn');

      const { stdout } = await runner.executeOperation(
        'set_node_properties',
        {
          scenePath: 'main.tscn',
          updates: [{ nodePath: '.', property: 'z_index', value: true }],
        },
        tmpProject,
        30000,
      );

      const parsed = JSON.parse(extractJson(stdout));
      expect(parsed.results[0].success).toBe(true);
      const sceneText = readFileSync(scenePath, 'utf-8');
      expect(sceneText).toContain('z_index = 1');
    },
    60000,
  );

  itGodot(
    'errors when a res:// resource is the wrong type for the property',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];

      writeFileSync(
        join(tmpProject, 'shape.tres'),
        '[gd_resource type="RectangleShape2D" format=3]\n\n[resource]\nsize = Vector2(4, 4)\n',
        'utf-8',
      );

      await runner.executeOperation(
        'add_node',
        {
          scenePath: 'main.tscn',
          nodeType: 'Sprite2D',
          nodeName: 'MismatchedSprite',
          parentNodePath: '.',
        },
        tmpProject,
        30000,
      );

      const { stdout } = await runner.executeOperation(
        'set_node_properties',
        {
          scenePath: 'main.tscn',
          updates: [
            { nodePath: 'MismatchedSprite', property: 'texture', value: 'res://shape.tres' },
          ],
        },
        tmpProject,
        30000,
      );

      const parsed = JSON.parse(extractJson(stdout));
      expect(parsed.results[0].success).toBeUndefined();
      expect(parsed.results[0].error).toMatch(/RectangleShape2D/);
      expect(parsed.results[0].error).toMatch(/texture/);
    },
    60000,
  );
});

describe('add_node type validation (silent-success gap)', () => {
  itGodot(
    'errors and does not add the node when a plain value is given for an Object-typed property',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      const scenePath = join(tmpProject, 'main.tscn');
      const originalTscn = readFileSync(scenePath, 'utf-8');

      let stdoutSeen = '';
      let stderrSeen = '';
      try {
        const { stdout, stderr } = await runner.executeOperation(
          'add_node',
          {
            scenePath: 'main.tscn',
            nodeType: 'CollisionShape2D',
            nodeName: 'BadShape',
            properties: { shape: { x: 1, y: 2 } },
          },
          tmpProject,
          30000,
        );
        stdoutSeen = stdout || '';
        stderrSeen = stderr || '';
      } catch (err) {
        stderrSeen = err instanceof Error ? err.message : String(err);
      }

      expect(stdoutSeen).not.toContain(OPERATION_RESULT_SENTINEL);
      expect(stderrSeen.toLowerCase()).toMatch(/object-typed|resource/);
      const tscnAfter = readFileSync(scenePath, 'utf-8');
      expect(tscnAfter).not.toMatch(/\[node name="BadShape"/);
      expect(tscnAfter).toBe(originalTscn);
    },
    60000,
  );

  itGodot(
    'errors and does not add the node when an unknown property is given',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      const scenePath = join(tmpProject, 'main.tscn');
      const originalTscn = readFileSync(scenePath, 'utf-8');

      let stdoutSeen = '';
      let stderrSeen = '';
      try {
        const { stdout, stderr } = await runner.executeOperation(
          'add_node',
          {
            scenePath: 'main.tscn',
            nodeType: 'CollisionShape2D',
            nodeName: 'UnknownProp',
            properties: { not_a_real_property: 5 },
          },
          tmpProject,
          30000,
        );
        stdoutSeen = stdout || '';
        stderrSeen = stderr || '';
      } catch (err) {
        stderrSeen = err instanceof Error ? err.message : String(err);
      }

      expect(stdoutSeen).not.toContain(OPERATION_RESULT_SENTINEL);
      expect(stderrSeen.toLowerCase()).toMatch(/does not exist/);
      const tscnAfter = readFileSync(scenePath, 'utf-8');
      expect(tscnAfter).not.toMatch(/\[node name="UnknownProp"/);
      expect(tscnAfter).toBe(originalTscn);
    },
    60000,
  );

  itGodot(
    'errors and does not add the node when a String is given for an int property (z_index)',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      const scenePath = join(tmpProject, 'main.tscn');
      const originalTscn = readFileSync(scenePath, 'utf-8');

      let stdoutSeen = '';
      let stderrSeen = '';
      try {
        const { stdout, stderr } = await runner.executeOperation(
          'add_node',
          {
            scenePath: 'main.tscn',
            nodeType: 'Node2D',
            nodeName: 'BadZIndex',
            properties: { z_index: 'abc' },
          },
          tmpProject,
          30000,
        );
        stdoutSeen = stdout || '';
        stderrSeen = stderr || '';
      } catch (err) {
        stderrSeen = err instanceof Error ? err.message : String(err);
      }

      expect(stdoutSeen).not.toContain(OPERATION_RESULT_SENTINEL);
      expect(stderrSeen.toLowerCase()).toMatch(/int/);
      const tscnAfter = readFileSync(scenePath, 'utf-8');
      expect(tscnAfter).not.toMatch(/\[node name="BadZIndex"/);
      expect(tscnAfter).toBe(originalTscn);
    },
    60000,
  );
});

describe('set_node_properties type validation against a scripted node', () => {
  itGodot(
    'errors when a String is assigned to a script-declared int property, succeeds for an untyped one',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];

      writeFileSync(
        join(tmpProject, 'typed.gd'),
        'extends Node2D\n@export var speed: int = 1\nvar anything\n',
        'utf-8',
      );

      const attachResult = await runner.executeOperation(
        'attach_script',
        { scenePath: 'main.tscn', nodePath: '.', scriptPath: 'typed.gd' },
        tmpProject,
        30000,
      );
      expect(JSON.parse(extractJson(attachResult.stdout)).scriptPath).toBe('typed.gd');

      const { stdout: speedStdout } = await runner.executeOperation(
        'set_node_properties',
        {
          scenePath: 'main.tscn',
          updates: [{ nodePath: '.', property: 'speed', value: 'fast' }],
        },
        tmpProject,
        30000,
      );
      const speedResult = JSON.parse(extractJson(speedStdout));
      expect(speedResult.results[0].success).toBeUndefined();
      expect(speedResult.results[0].error).toMatch(/int/i);

      const { stdout: anythingStdout } = await runner.executeOperation(
        'set_node_properties',
        {
          scenePath: 'main.tscn',
          updates: [{ nodePath: '.', property: 'anything', value: { a: 1 } }],
        },
        tmpProject,
        30000,
      );
      const anythingResult = JSON.parse(extractJson(anythingStdout));
      expect(anythingResult.results[0].success).toBe(true);
    },
    60000,
  );
});

// JSON sends a PackedVector2Array as {x, y} dicts; node.set() once zeroed each element while the compat table accepted TYPE_ARRAY and success:true was reported.
describe('packed-array element coercion', () => {
  itGodot(
    'round-trips PackedVector2Array from array-of-dicts (was silent zero-write)',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      const scenePath = join(tmpProject, 'main.tscn');

      await runner.executeOperation(
        'add_node',
        {
          scenePath: 'main.tscn',
          nodeType: 'Polygon2D',
          nodeName: 'Poly',
          parentNodePath: '.',
        },
        tmpProject,
        30000,
      );

      const { stdout } = await runner.executeOperation(
        'set_node_properties',
        {
          scenePath: 'main.tscn',
          updates: [
            {
              nodePath: 'Poly',
              property: 'polygon',
              value: [
                { x: 10, y: 20 },
                { x: 30, y: 40 },
                { x: 50, y: 60 },
              ],
            },
          ],
        },
        tmpProject,
        30000,
      );

      const parsed = JSON.parse(extractJson(stdout));
      expect(parsed.results[0].success).toBe(true);

      // The read path stringifies Vector arrays ("[(10.0, 20.0), ...]"), so assert on the serialized form.
      const { stdout: rb } = await runner.executeOperation(
        'get_node_properties',
        { scenePath: 'main.tscn', nodes: [{ node_path: 'Poly' }] },
        tmpProject,
        30000,
      );
      const rbp = JSON.parse(extractJson(rb));
      const poly = rbp.results?.[0]?.properties?.polygon;
      expect(poly).toBeDefined();
      expect(String(poly)).toMatch(/\(10(\.0)?, 20(\.0)?\)/);
      expect(String(poly)).not.toMatch(/\(0(\.0)?, 0(\.0)?\)/);

      const sceneText = readFileSync(scenePath, 'utf-8');
      expect(sceneText).toMatch(
        /polygon\s*=\s*PackedVector2Array\(10(\.0)?, 20(\.0)?, 30(\.0)?, 40(\.0)?, 50(\.0)?, 60(\.0)?\)/,
      );
    },
    60000,
  );

  itGodot(
    'round-trips PackedColorArray from array of color dicts (vertex_colors)',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];

      await runner.executeOperation(
        'add_node',
        {
          scenePath: 'main.tscn',
          nodeType: 'Polygon2D',
          nodeName: 'Colors',
          parentNodePath: '.',
        },
        tmpProject,
        30000,
      );

      const { stdout } = await runner.executeOperation(
        'set_node_properties',
        {
          scenePath: 'main.tscn',
          updates: [
            {
              nodePath: 'Colors',
              property: 'vertex_colors',
              value: [
                { r: 1, g: 0, b: 0, a: 1 },
                { r: 0, g: 0, b: 1, a: 1 },
              ],
            },
          ],
        },
        tmpProject,
        30000,
      );

      const parsed = JSON.parse(extractJson(stdout));
      expect(parsed.results[0].success).toBe(true);

      const { stdout: rb } = await runner.executeOperation(
        'get_node_properties',
        { scenePath: 'main.tscn', nodes: [{ node_path: 'Colors' }] },
        tmpProject,
        30000,
      );
      const rbp = JSON.parse(extractJson(rb));
      const colors = rbp.results?.[0]?.properties?.vertex_colors;
      expect(colors).toBeDefined();
      expect(String(colors)).toMatch(/\(1(\.0)?, 0(\.0)?, 0(\.0)?, 1(\.0)?\)/);
      expect(String(colors)).not.toMatch(/\(0(\.0)?, 0(\.0)?, 0(\.0)?, 0(\.0)?\)/);
    },
    60000,
  );

  itGodot(
    'round-trips integer elements widened into a PackedFloat32Array property',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];

      await runner.executeOperation(
        'add_node',
        {
          scenePath: 'main.tscn',
          nodeType: 'RichTextLabel',
          nodeName: 'Tabs',
          parentNodePath: '.',
        },
        tmpProject,
        30000,
      );

      // JSON ints are the natural wire form and must land as floats, not zeros.
      const { stdout } = await runner.executeOperation(
        'set_node_properties',
        {
          scenePath: 'main.tscn',
          updates: [{ nodePath: 'Tabs', property: 'tab_stops', value: [4, 8, 12] }],
        },
        tmpProject,
        30000,
      );

      const parsed = JSON.parse(extractJson(stdout));
      expect(parsed.results[0].success).toBe(true);

      const { stdout: rb } = await runner.executeOperation(
        'get_node_properties',
        { scenePath: 'main.tscn', nodes: [{ node_path: 'Tabs' }] },
        tmpProject,
        30000,
      );
      const rbp = JSON.parse(extractJson(rb));
      const stops = rbp.results?.[0]?.properties?.tab_stops;
      expect(String(stops)).toMatch(/\[4(\.0)?, 8(\.0)?, 12(\.0)?\]/);
    },
    60000,
  );

  itGodot(
    'still allows an empty array to clear a packed-array property',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      const scenePath = join(tmpProject, 'main.tscn');

      await runner.executeOperation(
        'add_node',
        {
          scenePath: 'main.tscn',
          nodeType: 'Polygon2D',
          nodeName: 'ClearPoly',
          parentNodePath: '.',
        },
        tmpProject,
        30000,
      );

      await runner.executeOperation(
        'set_node_properties',
        {
          scenePath: 'main.tscn',
          updates: [
            {
              nodePath: 'ClearPoly',
              property: 'polygon',
              value: [
                { x: 10, y: 20 },
                { x: 30, y: 40 },
              ],
            },
          ],
        },
        tmpProject,
        30000,
      );

      const { stdout } = await runner.executeOperation(
        'set_node_properties',
        {
          scenePath: 'main.tscn',
          updates: [{ nodePath: 'ClearPoly', property: 'polygon', value: [] }],
        },
        tmpProject,
        30000,
      );

      const parsed = JSON.parse(extractJson(stdout));
      expect(parsed.results[0].success).toBe(true);

      const { stdout: rb } = await runner.executeOperation(
        'get_node_properties',
        { scenePath: 'main.tscn', nodes: [{ node_path: 'ClearPoly' }] },
        tmpProject,
        30000,
      );
      const rbp = JSON.parse(extractJson(rb));
      const poly = rbp.results?.[0]?.properties?.polygon;
      expect(String(poly)).toBe('[]');

      const sceneText = readFileSync(scenePath, 'utf-8');
      expect(sceneText).not.toMatch(/polygon\s*=\s*PackedVector2Array\(10/);
    },
    60000,
  );

  itGodot(
    'errors (not zero-writes) on elements that cannot be coerced to the packed element type',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];

      await runner.executeOperation(
        'add_node',
        {
          scenePath: 'main.tscn',
          nodeType: 'Polygon2D',
          nodeName: 'BadPoly',
          parentNodePath: '.',
        },
        tmpProject,
        30000,
      );

      // Must be an explicit error, never a zero write with success:true.
      const { stdout } = await runner.executeOperation(
        'set_node_properties',
        {
          scenePath: 'main.tscn',
          updates: [{ nodePath: 'BadPoly', property: 'polygon', value: ['not', 'points'] }],
        },
        tmpProject,
        30000,
      );

      const parsed = JSON.parse(extractJson(stdout));
      expect(parsed.results[0].error).toMatch(/cannot be coerced/i);
      expect(parsed.results[0].error).toMatch(/element 0/);
      expect(parsed.results[0].success).toBeUndefined();
    },
    60000,
  );

  itGodot(
    'applies packed-array element coercion to initial properties in add_node',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];

      await runner.executeOperation(
        'add_node',
        {
          scenePath: 'main.tscn',
          nodeType: 'CollisionPolygon2D',
          nodeName: 'Collider',
          parentNodePath: '.',
          properties: {
            polygon: [
              { x: 0, y: 0 },
              { x: 20, y: 0 },
              { x: 20, y: 10 },
            ],
          },
        },
        tmpProject,
        30000,
      );

      const { stdout: rb } = await runner.executeOperation(
        'get_node_properties',
        { scenePath: 'main.tscn', nodes: [{ node_path: 'Collider' }] },
        tmpProject,
        30000,
      );
      const rbp = JSON.parse(extractJson(rb));
      const poly = rbp.results?.[0]?.properties?.polygon;
      expect(poly).toBeDefined();
      expect(String(poly)).toMatch(
        /\(0(\.0)?, 0(\.0)?\), \(20(\.0)?, 0(\.0)?\), \(20(\.0)?, 10(\.0)?\)/,
      );

      // The bad-element rule fires through add_node too, reported via stderr like other add_node property errors.
      let stdoutSeen = '';
      let stderrSeen = '';
      try {
        ({ stdout: stdoutSeen, stderr: stderrSeen } = await runner.executeOperation(
          'add_node',
          {
            scenePath: 'main.tscn',
            nodeType: 'CollisionPolygon2D',
            nodeName: 'BadCollider',
            parentNodePath: '.',
            properties: { polygon: ['nope'] },
          },
          tmpProject,
          30000,
        ));
      } catch (err) {
        stderrSeen = err instanceof Error ? err.message : String(err);
      }
      expect(stdoutSeen).not.toContain(OPERATION_RESULT_SENTINEL);
      expect(stderrSeen).toMatch(/cannot be coerced/i);
    },
    60000,
  );
});

// A typed array's declared type is plain TYPE_ARRAY, and Godot's typed assign refuses the whole array rather than zero-filling, so the symptom is success:true with nothing written.
// The element type comes from the live value (get_typed_builtin()) or the PROPERTY_HINT_ARRAY_TYPE hint.
const TYPED_ARRAY_SCRIPT = [
  'extends Node2D',
  '@export var points: Array[Vector2] = []',
  '@export var quad: Vector4 = Vector4()',
  '@export var quads: PackedVector4Array = PackedVector4Array()',
  '@export var cells: Array[Vector2i] = []',
  '@export var blocks: Array[Vector3i] = []',
  '@export var ratios: Array[float] = []',
  '@export var labels: Array[String] = []',
  '@export var loose: Array = []',
  '@export var textures: Array[Texture2D] = []',
  'var no_initializer: Array[Vector2]',
  '',
].join('\n');

const TYPED_ARRAY_SCRIPT_NAME = 'typed_arrays.gd';

async function attachTypedArrayScript(tmpProject: string, scenePath: string): Promise<void> {
  writeFileSync(join(tmpProject, TYPED_ARRAY_SCRIPT_NAME), TYPED_ARRAY_SCRIPT, 'utf-8');
  const { stdout } = await runner.executeOperation(
    'attach_script',
    { scenePath, nodePath: '.', scriptPath: TYPED_ARRAY_SCRIPT_NAME },
    tmpProject,
    30000,
  );
  expect(JSON.parse(extractJson(stdout)).scriptPath).toBe(TYPED_ARRAY_SCRIPT_NAME);
}

describe('typed Array[T] element coercion', () => {
  itGodot(
    'coerces {x,y} dicts into a script-declared Array[Vector2] property',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      await attachTypedArrayScript(tmpProject, 'main.tscn');

      const { stdout } = await runner.executeOperation(
        'set_node_properties',
        {
          scenePath: 'main.tscn',
          updates: [
            {
              nodePath: '.',
              property: 'points',
              value: [
                { x: 10, y: 20 },
                { x: 30, y: 40 },
              ],
            },
          ],
        },
        tmpProject,
        30000,
      );
      const parsed = JSON.parse(extractJson(stdout));
      expect(parsed.results[0].success).toBe(true);

      const { stdout: rb } = await runner.executeOperation(
        'get_node_properties',
        { scenePath: 'main.tscn', nodes: [{ node_path: '.' }] },
        tmpProject,
        30000,
      );
      const points = JSON.parse(extractJson(rb)).results?.[0]?.properties?.points;
      expect(points).toBeDefined();
      expect(JSON.stringify(points)).not.toBe('[]');
      expect(String(points)).toMatch(/\(10(\.0)?, 20(\.0)?\)/);

      const sceneText = readFileSync(join(tmpProject, 'main.tscn'), 'utf-8');
      expect(sceneText).toMatch(/points\s*=\s*Array\[Vector2\]\(/);
    },
    60000,
  );

  itGodot(
    'errors with the element index when a String is given for an Array[Vector2] element',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      await attachTypedArrayScript(tmpProject, 'main.tscn');

      const { stdout } = await runner.executeOperation(
        'set_node_properties',
        {
          scenePath: 'main.tscn',
          updates: [{ nodePath: '.', property: 'points', value: [{ x: 1, y: 2 }, 'nope'] }],
        },
        tmpProject,
        30000,
      );
      const parsed = JSON.parse(extractJson(stdout));
      expect(parsed.results[0].success).toBeUndefined();
      expect(parsed.results[0].error).toMatch(/element 1/);
      expect(parsed.results[0].error).toMatch(/Vector2/);
    },
    60000,
  );

  itGodot(
    'still accepts a plain array for an untyped Array property',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      await attachTypedArrayScript(tmpProject, 'main.tscn');

      const { stdout } = await runner.executeOperation(
        'set_node_properties',
        {
          scenePath: 'main.tscn',
          updates: [{ nodePath: '.', property: 'loose', value: [1, 'two', { x: 3, y: 4 }] }],
        },
        tmpProject,
        30000,
      );
      expect(JSON.parse(extractJson(stdout)).results[0].success).toBe(true);
    },
    60000,
  );

  itGodot(
    'stores an {x,y,z,w} dict as a Vector4, not a Vector3 with w dropped',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      await attachTypedArrayScript(tmpProject, 'main.tscn');

      const { stdout } = await runner.executeOperation(
        'set_node_properties',
        {
          scenePath: 'main.tscn',
          updates: [{ nodePath: '.', property: 'quad', value: { x: 1, y: 2, z: 3, w: 4 } }],
        },
        tmpProject,
        30000,
      );
      expect(JSON.parse(extractJson(stdout)).results[0].success).toBe(true);

      const sceneText = readFileSync(join(tmpProject, 'main.tscn'), 'utf-8');
      expect(sceneText).toMatch(/quad\s*=\s*Vector4\(1, 2, 3, 4\)/);
    },
    60000,
  );

  itGodot(
    'round-trips a PackedVector4Array from array-of-dicts',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      await attachTypedArrayScript(tmpProject, 'main.tscn');

      const { stdout } = await runner.executeOperation(
        'set_node_properties',
        {
          scenePath: 'main.tscn',
          updates: [
            {
              nodePath: '.',
              property: 'quads',
              value: [
                { x: 1, y: 2, z: 3, w: 4 },
                { x: 5, y: 6, z: 7, w: 8 },
              ],
            },
          ],
        },
        tmpProject,
        30000,
      );
      expect(JSON.parse(extractJson(stdout)).results[0].success).toBe(true);

      const sceneText = readFileSync(join(tmpProject, 'main.tscn'), 'utf-8');
      expect(sceneText).toMatch(/quads\s*=\s*PackedVector4Array\(1, 2, 3, 4, 5, 6, 7, 8\)/);
    },
    60000,
  );

  itGodot(
    'keeps {x,y,z} a Vector3 and a color dict a Color after the Vector4 case',
    async () => {
      // Every Vector4 dict is also a valid Vector3 dict, so the w branch must be tested before z, and neither may capture the {r,g,b} form.
      const tmpProject = tmpDirs[tmpDirs.length - 1];

      await runner.executeOperation(
        'add_node',
        { scenePath: 'main.tscn', nodeType: 'Node3D', nodeName: 'Spatial', parentNodePath: '.' },
        tmpProject,
        30000,
      );
      const { stdout } = await runner.executeOperation(
        'set_node_properties',
        {
          scenePath: 'main.tscn',
          updates: [
            { nodePath: 'Spatial', property: 'position', value: { x: 1, y: 2, z: 3 } },
            { nodePath: 'Label', property: 'modulate', value: { r: 1, g: 0, b: 0, a: 1 } },
          ],
        },
        tmpProject,
        30000,
      );
      const results = JSON.parse(extractJson(stdout)).results;
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);

      const sceneText = readFileSync(join(tmpProject, 'main.tscn'), 'utf-8');
      expect(sceneText).toMatch(
        /transform\s*=\s*Transform3D\(1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 2, 3\)/,
      );
      expect(sceneText).toMatch(/modulate\s*=\s*Color\(1, 0, 0, 1\)/);
    },
    60000,
  );

  itGodot(
    'stores {x,y} dicts as Vector2i for an Array[Vector2i] property',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      await attachTypedArrayScript(tmpProject, 'main.tscn');

      const { stdout } = await runner.executeOperation(
        'set_node_properties',
        {
          scenePath: 'main.tscn',
          updates: [
            {
              nodePath: '.',
              property: 'cells',
              value: [
                { x: 1, y: 2 },
                { x: 3, y: 4 },
              ],
            },
          ],
        },
        tmpProject,
        30000,
      );
      expect(JSON.parse(extractJson(stdout)).results[0].success).toBe(true);

      // The persisted scene is the proof: a refused assignment writes an empty typed array and reports nothing.
      const sceneText = readFileSync(join(tmpProject, 'main.tscn'), 'utf-8');
      expect(sceneText).toMatch(/cells\s*=\s*Array\[Vector2i\]\(/);
      expect(sceneText).toMatch(/Vector2i\(1,\s*2\)/);
    },
    60000,
  );

  itGodot(
    'stores {x,y,z} dicts as Vector3i for an Array[Vector3i] property',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      await attachTypedArrayScript(tmpProject, 'main.tscn');

      const { stdout } = await runner.executeOperation(
        'set_node_properties',
        {
          scenePath: 'main.tscn',
          updates: [{ nodePath: '.', property: 'blocks', value: [{ x: 5, y: 6, z: 7 }] }],
        },
        tmpProject,
        30000,
      );
      expect(JSON.parse(extractJson(stdout)).results[0].success).toBe(true);

      const sceneText = readFileSync(join(tmpProject, 'main.tscn'), 'utf-8');
      expect(sceneText).toMatch(/blocks\s*=\s*Array\[Vector3i\]\(/);
      expect(sceneText).toMatch(/Vector3i\(5,\s*6,\s*7\)/);
    },
    60000,
  );

  itGodot(
    'widens JSON ints into an Array[float] property',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      await attachTypedArrayScript(tmpProject, 'main.tscn');

      const { stdout } = await runner.executeOperation(
        'set_node_properties',
        {
          scenePath: 'main.tscn',
          updates: [{ nodePath: '.', property: 'ratios', value: [1, 2] }],
        },
        tmpProject,
        30000,
      );
      expect(JSON.parse(extractJson(stdout)).results[0].success).toBe(true);

      const sceneText = readFileSync(join(tmpProject, 'main.tscn'), 'utf-8');
      expect(sceneText).toMatch(/ratios\s*=\s*Array\[float\]\(/);
      expect(sceneText).toMatch(/ratios\s*=\s*Array\[float\]\(\[1(\.0)?,\s*2(\.0)?\]\)/);
    },
    60000,
  );

  itGodot(
    'errors instead of silently dropping a non-empty Array[Texture2D] value',
    async () => {
      // TYPE_OBJECT has no element rule; passing the raw Array to set() would leave an empty Array[Texture2D] and still report success, so the refusal must be explicit.
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      await attachTypedArrayScript(tmpProject, 'main.tscn');

      const { stdout } = await runner.executeOperation(
        'set_node_properties',
        {
          scenePath: 'main.tscn',
          updates: [{ nodePath: '.', property: 'textures', value: ['res://placeholder.png'] }],
        },
        tmpProject,
        30000,
      );
      const entry = JSON.parse(extractJson(stdout)).results[0];
      expect(entry.success).toBeUndefined();
      expect(entry.error).toMatch(/typed Array/);
      expect(entry.error).toMatch(/Object/);
    },
    60000,
  );

  itGodot(
    'accepts an empty array for an Array[Texture2D] property',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      await attachTypedArrayScript(tmpProject, 'main.tscn');

      const { stdout } = await runner.executeOperation(
        'set_node_properties',
        {
          scenePath: 'main.tscn',
          updates: [{ nodePath: '.', property: 'textures', value: [] }],
        },
        tmpProject,
        30000,
      );
      expect(JSON.parse(extractJson(stdout)).results[0].success).toBe(true);
    },
    60000,
  );

  itGodot(
    'resolves the element type for a typed array declared without an initializer',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      await attachTypedArrayScript(tmpProject, 'main.tscn');

      const { stdout: goodStdout } = await runner.executeOperation(
        'set_node_properties',
        {
          scenePath: 'main.tscn',
          updates: [{ nodePath: '.', property: 'no_initializer', value: [{ x: 5, y: 6 }] }],
        },
        tmpProject,
        30000,
      );
      expect(JSON.parse(extractJson(goodStdout)).results[0].success).toBe(true);

      // A non-exported script variable carries no storage usage, so it cannot be read back; the element error on a rejected value proves the element type resolved.
      const { stdout: badStdout } = await runner.executeOperation(
        'set_node_properties',
        {
          scenePath: 'main.tscn',
          updates: [{ nodePath: '.', property: 'no_initializer', value: ['nope'] }],
        },
        tmpProject,
        30000,
      );
      const bad = JSON.parse(extractJson(badStdout));
      expect(bad.results[0].success).toBeUndefined();
      expect(bad.results[0].error).toMatch(/element 0/);
      expect(bad.results[0].error).toMatch(/Vector2/);
    },
    60000,
  );

  itGodot(
    'applies typed-array element coercion to initial properties in add_node',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];

      const { stdout: createStdout } = await runner.executeOperation(
        'create_scene',
        { scenePath: 'typed_child.tscn', rootNodeType: 'Node2D' },
        tmpProject,
        30000,
      );
      expect(JSON.parse(extractJson(createStdout)).scenePath).toBe('typed_child.tscn');
      await attachTypedArrayScript(tmpProject, 'typed_child.tscn');

      const { stdout } = await runner.executeOperation(
        'add_node',
        {
          scenePath: 'main.tscn',
          nodeType: 'typed_child.tscn',
          nodeName: 'TypedChild',
          parentNodePath: '.',
          properties: { points: [{ x: 7, y: 8 }] },
        },
        tmpProject,
        30000,
      );
      expect(stdout).toContain(OPERATION_RESULT_SENTINEL);

      const sceneText = readFileSync(join(tmpProject, 'main.tscn'), 'utf-8');
      expect(sceneText).toMatch(/points\s*=\s*Array\[Vector2\]\(\[Vector2\(7(\.0)?, 8(\.0)?\)\]\)/);
    },
    60000,
  );
});

const INVENTORY_SCENE = 'inventory.tscn';
/** Dictionary[K, V] exists from Godot 4.4. */
const TYPED_DICTIONARY_MIN_MINOR = 4;
const AUTHORED_CASE_TIMEOUT_MS = 120000;

function makeAuthoredProject(): string {
  const dst = join(tmpdir(), `godot-mcp-authored-${randomBytes(6).toString('hex')}`);
  cpSync(authoredFixtureProjectPath, dst, { recursive: true });
  tmpDirs.push(dst);
  return dst;
}

async function setInventoryProperty(
  project: string,
  property: string,
  value: unknown,
): Promise<{ success?: boolean; error?: string }> {
  const result = await handleSetNodeProperties(runner, {
    projectPath: project,
    scenePath: INVENTORY_SCENE,
    updates: [{ nodePath: 'root', property, value }],
  });
  const payload = expectMatchesOutputSchema('set_node_properties', result);
  const results = payload.results as Array<{ success?: boolean; error?: string }>;
  return results[0] ?? {};
}

function inventoryText(project: string): string {
  return readFileSync(join(project, INVENTORY_SCENE), 'utf-8');
}

describe('typed Dictionary[K, V] properties', () => {
  itGodot(
    'stores a JSON object on a Dictionary[String, int] as a typed dictionary',
    async (ctx) => {
      if ((await engineMajorMinor()).minor < TYPED_DICTIONARY_MIN_MINOR) ctx.skip();
      const project = makeAuthoredProject();

      const entry = await setInventoryProperty(project, 'stock', { hp: 3, mp: 4 });

      expect(entry.error).toBeUndefined();
      expect(entry.success).toBe(true);
      expect(inventoryText(project)).toContain('stock = Dictionary[String, int]({');
    },
    AUTHORED_CASE_TIMEOUT_MS,
  );

  itGodot(
    'converts the string keys of a Dictionary[int, float] to ints',
    async (ctx) => {
      if ((await engineMajorMinor()).minor < TYPED_DICTIONARY_MIN_MINOR) ctx.skip();
      const project = makeAuthoredProject();

      const entry = await setInventoryProperty(project, 'by_id', { '1': 1.5 });

      expect(entry.error).toBeUndefined();
      expect(entry.success).toBe(true);
      expect(inventoryText(project)).toContain('by_id = Dictionary[int, float]({');
    },
    AUTHORED_CASE_TIMEOUT_MS,
  );

  itGodot(
    'rejects a value that is not an int and names its key',
    async (ctx) => {
      if ((await engineMajorMinor()).minor < TYPED_DICTIONARY_MIN_MINOR) ctx.skip();
      const project = makeAuthoredProject();
      const before = inventoryText(project);

      const entry = await setInventoryProperty(project, 'stock', { hp: 'x' });

      expect(entry.success).toBeUndefined();
      expect(entry.error).toMatch(/key "hp"/);
      expect(inventoryText(project)).toBe(before);
    },
    AUTHORED_CASE_TIMEOUT_MS,
  );

  itGodot(
    'rejects a fractional value for an int dictionary',
    async (ctx) => {
      if ((await engineMajorMinor()).minor < TYPED_DICTIONARY_MIN_MINOR) ctx.skip();
      const project = makeAuthoredProject();
      const before = inventoryText(project);

      const entry = await setInventoryProperty(project, 'stock', { hp: 1.5 });

      expect(entry.success).toBeUndefined();
      expect(entry.error).toMatch(/not a whole number/);
      expect(inventoryText(project)).toBe(before);
    },
    AUTHORED_CASE_TIMEOUT_MS,
  );

  itGodot(
    'rejects a key that is not a number on an int-keyed dictionary',
    async (ctx) => {
      if ((await engineMajorMinor()).minor < TYPED_DICTIONARY_MIN_MINOR) ctx.skip();
      const project = makeAuthoredProject();
      const before = inventoryText(project);

      const entry = await setInventoryProperty(project, 'by_id', { a: 1 });

      expect(entry.success).toBeUndefined();
      expect(entry.error).toMatch(/key "a" is not a whole number/);
      expect(inventoryText(project)).toBe(before);
    },
    AUTHORED_CASE_TIMEOUT_MS,
  );
});

// inventory.gd declares Dictionary[K, V] exports, so every case below needs an engine that has them.
describe('integer vectors and packed integer arrays', () => {
  itGodot(
    'rejects a fractional component on a Vector2i',
    async (ctx) => {
      if ((await engineMajorMinor()).minor < TYPED_DICTIONARY_MIN_MINOR) ctx.skip();
      const project = makeAuthoredProject();
      const before = inventoryText(project);

      const entry = await setInventoryProperty(project, 'cell', { x: 1.5, y: 2 });

      expect(entry.success).toBeUndefined();
      expect(entry.error).toMatch(/whole-number components for Vector2i/);
      expect(inventoryText(project)).toBe(before);
    },
    AUTHORED_CASE_TIMEOUT_MS,
  );

  itGodot(
    'stores whole-number components on a Vector2i',
    async (ctx) => {
      if ((await engineMajorMinor()).minor < TYPED_DICTIONARY_MIN_MINOR) ctx.skip();
      const project = makeAuthoredProject();

      const entry = await setInventoryProperty(project, 'cell', { x: 1, y: 2 });

      expect(entry.error).toBeUndefined();
      expect(entry.success).toBe(true);
      expect(inventoryText(project)).toContain('cell = Vector2i(1, 2)');
    },
    AUTHORED_CASE_TIMEOUT_MS,
  );

  itGodot(
    'rejects a PackedByteArray element above 255 and names its index',
    async (ctx) => {
      if ((await engineMajorMinor()).minor < TYPED_DICTIONARY_MIN_MINOR) ctx.skip();
      const project = makeAuthoredProject();
      const before = inventoryText(project);

      const entry = await setInventoryProperty(project, 'bytes', [1, 256]);

      expect(entry.success).toBeUndefined();
      expect(entry.error).toMatch(/element 1 of the array .*outside the range/);
      expect(inventoryText(project)).toBe(before);
    },
    AUTHORED_CASE_TIMEOUT_MS,
  );

  itGodot(
    'rejects a negative PackedByteArray element',
    async (ctx) => {
      if ((await engineMajorMinor()).minor < TYPED_DICTIONARY_MIN_MINOR) ctx.skip();
      const project = makeAuthoredProject();

      const entry = await setInventoryProperty(project, 'bytes', [-1]);

      expect(entry.success).toBeUndefined();
      expect(entry.error).toMatch(/element 0 of the array .*outside the range/);
    },
    AUTHORED_CASE_TIMEOUT_MS,
  );

  itGodot(
    'rejects a PackedInt32Array element past the 32-bit maximum',
    async (ctx) => {
      if ((await engineMajorMinor()).minor < TYPED_DICTIONARY_MIN_MINOR) ctx.skip();
      const project = makeAuthoredProject();

      const entry = await setInventoryProperty(project, 'ids32', [2147483648]);

      expect(entry.success).toBeUndefined();
      expect(entry.error).toMatch(/outside the range PackedInt32Array holds/);
    },
    AUTHORED_CASE_TIMEOUT_MS,
  );

  itGodot(
    'accepts the bounds of a PackedByteArray',
    async (ctx) => {
      if ((await engineMajorMinor()).minor < TYPED_DICTIONARY_MIN_MINOR) ctx.skip();
      const project = makeAuthoredProject();

      const entry = await setInventoryProperty(project, 'bytes', [0, 255]);

      expect(entry.error).toBeUndefined();
      expect(entry.success).toBe(true);
    },
    AUTHORED_CASE_TIMEOUT_MS,
  );
});
