/**
 * Regression tests for type-invalid property assignments (silent-success gap).
 *
 * Context: `node.set()` casts the incoming value through the property's
 * typed setter with no validity return -- a type-incompatible value doesn't
 * fail, it silently stores the ZERO value for the declared type (e.g. a
 * String or Dictionary on an int property stores 0, a String on a Vector2
 * property stores (0, 0)) -- but the tool previously reported
 * `success: true`, so agents believed the write landed (observed in
 * Agent-driven scene builds: `properties={"shape": {"size": {...}}}` on
 * CollisionShape2D silently dropping).
 *
 * The fix checks the node's *declared* property type up front (via
 * get_property_list()) rather than inferring failure from post-set()
 * equality, against a declared-type compatibility table
 * (`_PROPERTY_TYPE_COMPAT` in godot_operations.gd) that allows the
 * legitimate widening conversions Godot performs on store -- float->int,
 * String->NodePath/StringName, bool<->int/float, Vector2<->Vector2i,
 * Vector3<->Vector3i, Array->Packed*Array -- while rejecting everything
 * else. A non-Object value assigned to an Object-typed property (Resource
 * or Node) is rejected outright; a `res://` string assigned to an
 * Object-typed property is auto-loaded instead.
 *
 * Requires GODOT_PATH. Skipped locally when it is unset; CI sets it in the
 * godot-integration job and runs this file on Godot 4.5.1 and 4.6.2.
 */

import { describe, beforeAll, beforeEach, afterAll, expect } from 'vitest';
import { cpSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { itGodot } from '../helpers/godot-skip.js';
import { fixtureProjectPath } from '../helpers/fixture-paths.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { extractJson } from '../../src/utils/output-parsing.js';

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
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe('set_node_properties type validation (silent-success gap)', () => {
  itGodot(
    'errors when a dict value is assigned to a Resource-typed property (was silent success)',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      const scenePath = join(tmpProject, 'main.tscn');

      // Create a CollisionShape2D node to mutate.
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

      // Attempt to set the `shape` property (Shape2D, a Resource) to a bare
      // dictionary — the classic silent-drop case from agent-driven builds.
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
      // And nothing was persisted for this property.
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

      expect(stdoutSeen).not.toContain('added successfully');
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

      expect(stdoutSeen).not.toContain('added successfully');
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

      expect(stdoutSeen).not.toContain('added successfully');
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
      expect(JSON.parse(extractJson(attachResult.stdout)).success).toBe(true);

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

// --- Packed*Array properties (e.g. Polygon2D polygon) ---
// JSON sends a PackedVector2Array as an array of {x, y} dicts. node.set()
// casts each dict element to the zero Vector2, the compat table accepts
// TYPE_ARRAY, and the tool reported success:true while the array was
// silently zeroed (observed in agent-driven builds: Polygon2D geometry
// wiped by a later write, caught only on read-back).
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

      // Read back via get_node_properties — the zeroed-array tell.
      // The read path stringifies Vector arrays ("[(10.0, 20.0), ...]"),
      // so assert on the serialized form.
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

      // RichTextLabel.tab_stops is a PackedFloat32Array; JSON ints are
      // the natural wire form and must land as floats, not zeros.
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

      // String elements cannot become Vector2s — must be an explicit
      // error, never a zero write with success:true.
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

      // Read back: the CollisionPolygon2D polygon (PackedVector2Array)
      // must carry the supplied points, not zeros.
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

      // And the bad-element rule fires through the add_node path too
      // (reported via stderr, matching other add_node property errors).
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
      expect(stdoutSeen).not.toContain('added successfully');
      expect(stderrSeen).toMatch(/cannot be coerced/i);
    },
    60000,
  );
});

// --- Script-declared typed arrays (Array[T]) ---
// A typed array's declared type is plain TYPE_ARRAY, so it passes the
// declared-type check untouched and the raw {x, y} dicts reach node.set().
// Godot's typed assign refuses the whole array rather than zero-filling it,
// so the symptom is a success:true with nothing written. The element type is
// recovered from the live value (Array.get_typed_builtin()) or, failing that,
// from the property descriptor's PROPERTY_HINT_ARRAY_TYPE hint.
const TYPED_ARRAY_SCRIPT = [
  'extends Node2D',
  '@export var points: Array[Vector2] = []',
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
  expect(JSON.parse(extractJson(stdout)).success).toBe(true);
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

      // The persisted scene is the proof the elements survived: a refused
      // assignment writes an empty typed array and reports nothing.
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
      // The element type is TYPE_OBJECT, which has no element rule. Passing the
      // raw untyped Array to set() would leave an empty Array[Texture2D] behind
      // and still report success, so the refusal has to be explicit.
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

      // A non-exported script variable carries no storage usage, so
      // get_node_properties cannot read it back. The element error on a
      // rejected value is the observable proof that the element type
      // resolved: had it stayed unresolved, this write would pass the
      // declared-type check and report success with nothing stored.
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
      expect(JSON.parse(extractJson(createStdout)).success).toBe(true);
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
      expect(stdout).toContain('added successfully');

      const sceneText = readFileSync(join(tmpProject, 'main.tscn'), 'utf-8');
      expect(sceneText).toMatch(/points\s*=\s*Array\[Vector2\]\(\[Vector2\(7(\.0)?, 8(\.0)?\)\]\)/);
    },
    60000,
  );
});
