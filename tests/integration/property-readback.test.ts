// get_node_properties reads a value in the shape set_node_properties takes it back, at any depth.

import { describe, beforeAll, expect } from 'vitest';
import { cpSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { itGodot } from '../helpers/godot-skip.js';
import { dropProjectFeatureVersion, useTmpDirs } from '../helpers/tmp.js';
import { authoredFixtureProjectPath } from '../helpers/fixture-paths.js';
import { expectMatchesOutputSchema } from '../helpers/schema-assert.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { handleGetNodeProperties, handleSetNodeProperties } from '../../src/tools/node-tools.js';

const CASE_TIMEOUT_MS = 120_000;
const SCENE = 'readback.tscn';
const SCRIPT_NAME = 'readback.gd';

const SCRIPT_SOURCE = [
  'extends Node',
  '',
  '@export var cell: Vector2i',
  '@export var cell3: Vector3i',
  '@export var quad: Vector4i',
  '@export var points: Array[Vector2] = []',
  '@export var loose: Array = []',
  '@export var bag: Dictionary = {}',
  '@export var bytes: PackedByteArray',
  '@export var ids32: PackedInt32Array',
  '@export var floats: PackedFloat32Array',
  '@export var names: PackedStringArray',
  '@export var verts: PackedVector2Array',
  '@export var tints: PackedColorArray',
  '@export var area: Rect2',
  '@export var native_bag: Dictionary = {"p": Vector2(1, 2), "list": [Vector3i(1, 2, 3)]}',
  '@export var native_loose: Array = [Vector2(3, 4), [Vector4(1, 2, 3, 4)]]',
  '@export var basis_text: Transform2D',
  '',
].join('\n');

const SCENE_SOURCE = [
  '[gd_scene load_steps=2 format=3]',
  '',
  `[ext_resource type="Script" path="res://${SCRIPT_NAME}" id="1_rb"]`,
  '',
  '[node name="Readback" type="Node"]',
  'script = ExtResource("1_rb")',
  '',
].join('\n');

const WRITTEN: Record<string, unknown> = {
  cell: { x: 1, y: 2 },
  cell3: { x: 4, y: 5, z: 6 },
  quad: { x: 1, y: 2, z: 3, w: 4 },
  points: [
    { x: 1, y: 2 },
    { x: 3, y: 4 },
  ],
  loose: [{ x: 1, y: 2 }, 'text', [7]],
  bag: { p: { x: 1, y: 2 }, list: [1, 2], name: 'n' },
  bytes: [0, 255],
  ids32: [2147483647, -5],
  floats: [0.5, 2],
  names: ['a', 'b'],
  verts: [
    { x: 1, y: 2 },
    { x: 3, y: 4 },
  ],
  tints: [{ r: 1, g: 0.5, b: 0, a: 1 }],
};

const tmp = useTmpDirs();

let runner: GodotRunner;

beforeAll(async () => {
  runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
  await runner.detectGodotPath();
});

function readbackProject(): string {
  const project = tmp.make('godot-mcp-readback-');
  cpSync(authoredFixtureProjectPath, project, { recursive: true });
  dropProjectFeatureVersion(project);
  writeFileSync(join(project, SCRIPT_NAME), SCRIPT_SOURCE);
  writeFileSync(join(project, SCENE), SCENE_SOURCE);
  return project;
}

async function writeValues(
  project: string,
  values: Record<string, unknown>,
): Promise<{ success?: boolean; error?: string; property?: string }[]> {
  const result = await handleSetNodeProperties(runner, {
    projectPath: project,
    scenePath: SCENE,
    updates: Object.entries(values).map(([property, value]) => ({
      nodePath: 'root',
      property,
      value,
    })),
  });
  const payload = expectMatchesOutputSchema('set_node_properties', result);
  return payload.results as { success?: boolean; error?: string; property?: string }[];
}

async function readProperties(project: string): Promise<Record<string, unknown>> {
  const result = await handleGetNodeProperties(runner, {
    projectPath: project,
    scenePath: SCENE,
    nodes: [{ nodePath: 'root' }],
  });
  const payload = expectMatchesOutputSchema('get_node_properties', result);
  const [entry] = payload.results as { properties: Record<string, unknown> }[];
  return entry?.properties ?? {};
}

describe('get_node_properties reads values in the shapes set_node_properties accepts', () => {
  itGodot(
    'vectors, typed arrays, packed arrays and dictionaries read back as written',
    async () => {
      // Red when _variant_to_json str()s a vector or packed array, or passes a container through for JSON.stringify to flatten.
      const project = readbackProject();
      const written = await writeValues(project, WRITTEN);
      expect(written.filter((entry) => entry.success !== true)).toEqual([]);

      const properties = await readProperties(project);
      for (const [name, value] of Object.entries(WRITTEN)) {
        expect(properties[name], name).toEqual(value);
      }
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'writing the read values back leaves the saved scene text identical',
    async () => {
      // Red when any read shape is one the write side does not take back, or takes back as a different value.
      const project = readbackProject();
      await writeValues(project, WRITTEN);
      const before = readFileSync(join(project, SCENE), 'utf8');
      expect(before, 'precondition: the writes reached the scene file').toContain('Vector2i(1, 2)');

      const properties = await readProperties(project);
      const roundTrip: Record<string, unknown> = {};
      for (const name of Object.keys(WRITTEN)) roundTrip[name] = properties[name];
      const rewritten = await writeValues(project, roundTrip);

      expect(rewritten.filter((entry) => entry.success !== true)).toEqual([]);
      expect(readFileSync(join(project, SCENE), 'utf8')).toBe(before);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'a vector nested in an untyped Array or Dictionary a script holds reads as an object',
    async () => {
      // Red when a container is returned as it is and JSON.stringify flattens each vector to its text form.
      const project = readbackProject();
      const properties = await readProperties(project);

      expect(properties.native_bag).toEqual({ p: { x: 1, y: 2 }, list: [{ x: 1, y: 2, z: 3 }] });
      expect(properties.native_loose).toEqual([{ x: 3, y: 4 }, [{ x: 1, y: 2, z: 3, w: 4 }]]);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'a type set_node_properties does not accept stays text',
    async () => {
      // Red when a Rect2 or Transform2D is given an object shape the write side cannot take back.
      const project = readbackProject();
      const [rectWrite] = await writeValues(project, {
        area: { position: { x: 0, y: 0 }, size: { x: 1, y: 1 } },
      });
      expect(rectWrite?.success, 'precondition: Rect2 is not a write-side type').not.toBe(true);

      const properties = await readProperties(project);
      expect(typeof properties.area).toBe('string');
      expect(typeof properties.basis_text).toBe('string');
    },
    CASE_TIMEOUT_MS,
  );
});
