// A property declared int is not always 64 bits wide in the engine and set() wraps or drops a value that does not fit, so the stored value is read back and compared.
// set() refuses an untyped array on a typed property, empty or not, and keeps the old elements.

import { describe, beforeAll, beforeEach, afterAll, expect } from 'vitest';
import { cpSync, readFileSync } from 'fs';
import { removeTmpDir } from '../helpers/tmp.js';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { engineMajorMinor, itGodot } from '../helpers/godot-skip.js';
import { authoredFixtureProjectPath } from '../helpers/fixture-paths.js';
import { expectMatchesOutputSchema } from '../helpers/schema-assert.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { handleAddNode } from '../../src/tools/scene-tools.js';
import { handleSetNodeProperties } from '../../src/tools/node-tools.js';

const TYPED_SCENE = 'typed_values.tscn';
const INVENTORY_SCENE = 'inventory.tscn';
const PLAYER_SCENE = 'player.tscn';
const CASE_TIMEOUT_MS = 120000;
const TYPED_DICTIONARY_MIN_MINOR = 4;
const ABOVE_INT32_MAX = 3000000000;
const ABOVE_Z_INDEX_LIMIT = 5000;
const HUGE_NUMBER = 1e30;
const ABOVE_FLOAT32_EXACT = 16777217;

interface UpdateEntry {
  success?: boolean;
  error?: string;
}

let runner: GodotRunner;
let projectPath: string;
const tmpDirs: string[] = [];

beforeAll(async () => {
  runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
  await runner.detectGodotPath();
});

beforeEach(() => {
  projectPath = join(tmpdir(), `godot-mcp-int-range-${randomBytes(6).toString('hex')}`);
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

async function setProperty(
  scenePath: string,
  nodePath: string,
  property: string,
  value: unknown,
): Promise<UpdateEntry> {
  const result = await handleSetNodeProperties(runner, {
    projectPath,
    scenePath,
    updates: [{ nodePath, property, value }],
  });
  const payload = expectMatchesOutputSchema('set_node_properties', result);
  return (payload.results as UpdateEntry[])[0] ?? {};
}

describe('an empty JSON array or object empties a typed container', () => {
  itGodot(
    '[] on an Array[int] removes its elements',
    async () => {
      const entry = await setProperty(TYPED_SCENE, 'root', 'nums', []);

      expect(entry.error).toBeUndefined();
      expect(entry.success).toBe(true);
      const text = sceneText(TYPED_SCENE);
      expect(text).not.toContain('Array[int]([1, 2])');
      expect(text).toContain('ids = PackedInt32Array(1, 2)');
      expect(text).toContain('count = 3');
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    '[] on a PackedInt32Array removes its elements',
    async () => {
      const entry = await setProperty(TYPED_SCENE, 'root', 'ids', []);

      expect(entry.error).toBeUndefined();
      expect(entry.success).toBe(true);
      const text = sceneText(TYPED_SCENE);
      expect(text).not.toContain('PackedInt32Array(1, 2)');
      expect(text).toContain('nums = Array[int]([1, 2])');
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    '{} on a Dictionary[String, int] removes its entries',
    async (ctx) => {
      if ((await engineMajorMinor()).minor < TYPED_DICTIONARY_MIN_MINOR) ctx.skip();
      const filled = await setProperty(INVENTORY_SCENE, 'root', 'stock', { hp: 3 });
      expect(filled.success).toBe(true);
      expect(sceneText(INVENTORY_SCENE)).toContain('"hp": 3');

      const entry = await setProperty(INVENTORY_SCENE, 'root', 'stock', {});

      expect(entry.error).toBeUndefined();
      expect(entry.success).toBe(true);
      expect(sceneText(INVENTORY_SCENE)).not.toContain('"hp": 3');
    },
    CASE_TIMEOUT_MS,
  );
});

describe('an integer that does not fit its target is an error', () => {
  itGodot(
    'a value past 32 bits on a 32-bit int property names the property and leaves the file alone',
    async () => {
      const before = sceneText(TYPED_SCENE);

      const entry = await setProperty(TYPED_SCENE, 'root', 'process_priority', ABOVE_INT32_MAX);

      expect(entry.success).toBeUndefined();
      expect(entry.error).toMatch(/process_priority/);
      expect(entry.error).toMatch(/3000000000 was not stored/);
      expect(sceneText(TYPED_SCENE)).toBe(before);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'a failed integer write does not ride along with an update that succeeded',
    async () => {
      const result = await handleSetNodeProperties(runner, {
        projectPath,
        scenePath: TYPED_SCENE,
        updates: [
          { nodePath: 'root', property: 'process_priority', value: ABOVE_INT32_MAX },
          { nodePath: 'root', property: 'count', value: 4 },
        ],
      });
      const payload = expectMatchesOutputSchema('set_node_properties', result);
      const results = payload.results as UpdateEntry[];

      expect(results[0]?.error).toMatch(/was not stored/);
      expect(results[1]?.success).toBe(true);
      const text = sceneText(TYPED_SCENE);
      expect(text).toContain('count = 4');
      expect(text).not.toContain('process_priority');
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'the same value on an int property that is 32 bits unsigned in the engine is stored',
    async () => {
      const result = await handleAddNode(runner, {
        projectPath,
        scenePath: PLAYER_SCENE,
        nodeType: 'Area2D',
        nodeName: 'Zone',
        properties: { collision_layer: ABOVE_INT32_MAX },
      });
      expectMatchesOutputSchema('add_node', result);

      expect(sceneText(PLAYER_SCENE)).toContain('collision_layer = 3000000000');
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'a value that fits 32 bits and reads back differently is kept, with a warning naming both numbers',
    async () => {
      // CanvasItem.z_index refuses a value above its limit and keeps what it had: the update succeeds and the warning says what the property reads.
      const result = await handleSetNodeProperties(runner, {
        projectPath,
        scenePath: PLAYER_SCENE,
        updates: [{ nodePath: 'root/Body', property: 'z_index', value: ABOVE_Z_INDEX_LIMIT }],
      });
      const payload = expectMatchesOutputSchema('set_node_properties', result);

      expect((payload.results as UpdateEntry[])[0]?.success).toBe(true);
      const warnings = payload.warnings as string[];
      expect(
        warnings.some((warning) =>
          /^updates\[0\]: Property 'z_index' .* was assigned 5000 and reads 0 afterwards/.test(
            warning,
          ),
        ),
      ).toBe(true);
      expect(sceneText(PLAYER_SCENE)).not.toContain('z_index');
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'a number beyond the exact integer range of a JSON number is an error on any int property',
    async () => {
      const before = sceneText(PLAYER_SCENE);

      const native = await setProperty(PLAYER_SCENE, 'root/Body', 'z_index', HUGE_NUMBER);
      expect(native.success).toBeUndefined();
      expect(native.error).toMatch(/z_index/);
      expect(native.error).toMatch(/beyond the whole numbers a JSON number carries exactly/);
      expect(sceneText(PLAYER_SCENE)).toBe(before);

      const scripted = await setProperty(TYPED_SCENE, 'root', 'count', HUGE_NUMBER);
      expect(scripted.success).toBeUndefined();
      expect(scripted.error).toMatch(/count/);
      expect(scripted.error).toMatch(/beyond the whole numbers/);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'an Array[int] element beyond that range names its index',
    async () => {
      const before = sceneText(TYPED_SCENE);

      const entry = await setProperty(TYPED_SCENE, 'root', 'nums', [1, HUGE_NUMBER]);

      expect(entry.success).toBeUndefined();
      expect(entry.error).toMatch(/element 1 of the array .*beyond the whole numbers/);
      expect(sceneText(TYPED_SCENE)).toBe(before);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'a typed-dictionary int value beyond that range names its key',
    async (ctx) => {
      if ((await engineMajorMinor()).minor < TYPED_DICTIONARY_MIN_MINOR) ctx.skip();
      const before = sceneText(INVENTORY_SCENE);

      const entry = await setProperty(INVENTORY_SCENE, 'root', 'stock', { hp: HUGE_NUMBER });

      expect(entry.success).toBeUndefined();
      expect(entry.error).toMatch(/value at key "hp" .*beyond the whole numbers/);
      expect(sceneText(INVENTORY_SCENE)).toBe(before);
    },
    CASE_TIMEOUT_MS,
  );
});

describe('integer vector components are checked and stored as integers', () => {
  itGodot(
    'a component past 32 bits is an error that names the component and the range',
    async (ctx) => {
      if ((await engineMajorMinor()).minor < TYPED_DICTIONARY_MIN_MINOR) ctx.skip();
      const before = sceneText(INVENTORY_SCENE);

      const entry = await setProperty(INVENTORY_SCENE, 'root', 'cell', {
        x: ABOVE_INT32_MAX,
        y: 0,
      });

      expect(entry.success).toBeUndefined();
      expect(entry.error).toMatch(
        /component x \(.*\) is outside the range a component of Vector2i/,
      );
      expect(entry.error).toMatch(/-2147483648 to 2147483647/);
      expect(sceneText(INVENTORY_SCENE)).toBe(before);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'a component a 32-bit float cannot hold exactly is stored exactly',
    async (ctx) => {
      if ((await engineMajorMinor()).minor < TYPED_DICTIONARY_MIN_MINOR) ctx.skip();

      const entry = await setProperty(INVENTORY_SCENE, 'root', 'cell', {
        x: ABOVE_FLOAT32_EXACT,
        y: 2,
      });

      expect(entry.error).toBeUndefined();
      expect(entry.success).toBe(true);
      expect(sceneText(INVENTORY_SCENE)).toContain('cell = Vector2i(16777217, 2)');
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'an Array[Vector2i] element with a component past 32 bits names its index',
    async () => {
      const before = sceneText(TYPED_SCENE);

      const entry = await setProperty(TYPED_SCENE, 'root', 'cells', [
        { x: 1, y: 2 },
        { x: 0, y: ABOVE_INT32_MAX },
      ]);

      expect(entry.success).toBeUndefined();
      expect(entry.error).toMatch(/element 1 of the array: component y .*outside the range/);
      expect(sceneText(TYPED_SCENE)).toBe(before);
    },
    CASE_TIMEOUT_MS,
  );
});
