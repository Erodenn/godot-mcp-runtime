/**
 * Feature tests for inline Resource construction in property values.
 *
 * Context: `set_node_properties` / `add_node` coerce Vector2/3/Color dicts
 * but historically had no dict→Resource path — an agent wanting
 * `CollisionShape2D.shape = RectangleShape2D(size=...)` had to load a
 * pre-existing res:// resource or hand-edit the .tscn (agent libraries carried
 * a scene-file-edit permission exception solely for this gap).
 *
 * The feature: a typed-dict form `{"type": "<ResourceClassName>", ...props}`
 * constructs the Resource inline (ClassDB.instantiate + recursive property
 * assignment through the same validated `_prepare_property_value`
 * machinery). Scenes are persisted via PackedScene.pack() +
 * ResourceSaver, so an assigned inline Resource is serialized as a proper
 * sub_resource block automatically — one implementation covers both the
 * scene-edit and runtime contexts.
 *
 * Rules preserved (v3.2.4 error contract):
 * - `{"x","y"}` / `{"r","g","b"}` dicts remain Vector/Color (checked first)
 * - "type" must be an instantiable Resource subclass; otherwise the
 *   existing explicit error fires
 * - Inner property type violations produce explicit errors naming the
 *   inner property
 * - res:// strings still load saved resources; null still clears
 *
 * Requires GODOT_PATH. Skipped in CI without it.
 */

import { describe, beforeAll, beforeEach, afterAll, expect } from 'vitest';
import { cpSync, rmSync, readFileSync } from 'fs';
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

describe('inline Resource construction (typed-dict form)', () => {
  itGodot(
    'add_node constructs a Resource from a typed dict and it round-trips through the saved scene',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      const scenePath = join(tmpProject, 'main.tscn');

      const { stdout } = await runner.executeOperation(
        'add_node',
        {
          scenePath: 'main.tscn',
          nodeType: 'CollisionShape2D',
          nodeName: 'ShapeHolder',
          parentNodePath: '.',
          properties: {
            shape: { type: 'RectangleShape2D', size: { x: 80, y: 16 } },
          },
        },
        tmpProject,
        30000,
      );

      expect(stdout).toContain('added successfully');

      // The scene text must now contain a persisted sub_resource block.
      const sceneText = readFileSync(scenePath, 'utf-8');
      expect(sceneText).toContain('[sub_resource type="RectangleShape2D"');
      expect(sceneText).toContain('size = Vector2(80, 16)');
    },
    60000,
  );

  itGodot(
    'set_node_properties constructs a Resource on an existing node and persists it',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];

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

      const { stdout } = await runner.executeOperation(
        'set_node_properties',
        {
          scenePath: 'main.tscn',
          updates: [
            {
              nodePath: 'ShapeHolder',
              property: 'shape',
              value: { type: 'CircleShape2D', radius: 12.5 },
            },
          ],
        },
        tmpProject,
        30000,
      );

      const parsed = JSON.parse(extractJson(stdout));
      expect(parsed.results[0].success).toBe(true);
      const sceneText = readFileSync(join(tmpProject, 'main.tscn'), 'utf-8');
      expect(sceneText).toContain('[sub_resource type="CircleShape2D"');
      expect(sceneText).toContain('radius = 12.5');
    },
    60000,
  );

  itGodot(
    'invalid resource class name returns the explicit error and persists nothing',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      const scenePath = join(tmpProject, 'main.tscn');

      let stdoutSeen = '';
      let stderrSeen = '';
      try {
        ({ stdout: stdoutSeen, stderr: stderrSeen } = await runner.executeOperation(
          'add_node',
          {
            scenePath: 'main.tscn',
            nodeType: 'CollisionShape2D',
            nodeName: 'ShapeHolder',
            parentNodePath: '.',
            properties: { shape: { type: 'NotARealResourceClass', size: { x: 1, y: 1 } } },
          },
          tmpProject,
          30000,
        ));
      } catch (err) {
        stderrSeen = err instanceof Error ? err.message : String(err);
      }

      expect(stdoutSeen).not.toContain('added successfully');
      expect(stderrSeen).toMatch(/unknown class 'NotARealResourceClass'/i);
      const sceneText = readFileSync(scenePath, 'utf-8');
      expect(sceneText).not.toMatch(/sub_resource/);
    },
    60000,
  );

  itGodot(
    'node-typed class name is rejected (Resources only)',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];

      let stdoutSeen = '';
      let stderrSeen = '';
      try {
        ({ stdout: stdoutSeen, stderr: stderrSeen } = await runner.executeOperation(
          'add_node',
          {
            scenePath: 'main.tscn',
            nodeType: 'CollisionShape2D',
            nodeName: 'ShapeHolder',
            parentNodePath: '.',
            properties: { shape: { type: 'Node2D' } },
          },
          tmpProject,
          30000,
        ));
      } catch (err) {
        stderrSeen = err instanceof Error ? err.message : String(err);
      }

      expect(stdoutSeen).not.toContain('added successfully');
      expect(stderrSeen).toMatch(/is not a Resource/i);
    },
    60000,
  );

  itGodot(
    'inner property type violation returns an explicit error naming the inner property',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      const scenePath = join(tmpProject, 'main.tscn');

      let stdoutSeen = '';
      let stderrSeen = '';
      try {
        ({ stdout: stdoutSeen, stderr: stderrSeen } = await runner.executeOperation(
          'add_node',
          {
            scenePath: 'main.tscn',
            nodeType: 'CollisionShape2D',
            nodeName: 'ShapeHolder',
            parentNodePath: '.',
            properties: { shape: { type: 'RectangleShape2D', size: 'wide' } },
          },
          tmpProject,
          30000,
        ));
      } catch (err) {
        stderrSeen = err instanceof Error ? err.message : String(err);
      }

      expect(stdoutSeen).not.toContain('added successfully');
      expect(stderrSeen).toMatch(/size/i);
      expect(stderrSeen).toMatch(/expected|type|incompatible/i);
      const sceneText = readFileSync(scenePath, 'utf-8');
      expect(sceneText).not.toMatch(/sub_resource/);
    },
    60000,
  );

  itGodot(
    'property hint class check still applies to constructed resources',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];

      // texture is a Texture2D-typed property on Sprite2D; assigning a
      // correctly-typed-but-wrong-class Resource must error.
      let stdoutSeen = '';
      let stderrSeen = '';
      try {
        ({ stdout: stdoutSeen, stderr: stderrSeen } = await runner.executeOperation(
          'add_node',
          {
            scenePath: 'main.tscn',
            nodeType: 'Sprite2D',
            nodeName: 'Spr',
            parentNodePath: '.',
            properties: { texture: { type: 'RectangleShape2D', size: { x: 1, y: 1 } } },
          },
          tmpProject,
          30000,
        ));
      } catch (err) {
        stderrSeen = err instanceof Error ? err.message : String(err);
      }

      expect(stdoutSeen).not.toContain('added successfully');
      expect(stderrSeen).toMatch(/expects|texture|RectangleShape2D/i);
    },
    60000,
  );
});
