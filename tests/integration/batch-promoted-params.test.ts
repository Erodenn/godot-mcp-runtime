/**
 * Integration test: promoted spatial params in batch_scene_operations.
 *
 * Regression: batch add_node silently dropped top-level `position` (and the
 * other promoted spatial params — rotation, scale, visible, modulate).
 * The standalone add_node handler merges those keys into `properties`
 * (handleAddNode), but the batch path forwards operations raw to the
 * GDScript layer, whose _apply_add_node only read `properties` — so
 * a batch like:
 *
 *   { operation: 'add_node', nodeType: 'StaticBody2D',
 *     nodeName: 'WallTop', position: { x: 480, y: -10 } }
 *
 * reported success while persisting the node at (0,0): a scene assembled
 * through batch ops came out with every positioned node at the origin, with
 * nothing in the response hinting at it.
 *
 * The fix folds promoted params into the properties map inside
 * _apply_add_node, with `properties` winning on key conflicts (matching
 * handleAddNode's documented precedence).
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

describe('batch_scene_operations promoted spatial params', () => {
  itGodot(
    'batch add_node persists a top-level position param',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      await runner.executeOperation(
        'batch_scene_operations',
        {
          operations: [
            {
              operation: 'add_node',
              scenePath: 'main.tscn',
              nodeType: 'StaticBody2D',
              nodeName: 'WallTop',
              position: { x: 480, y: -10 },
            },
          ],
        },
        tmpProject,
        30000,
      );
      const sceneText = readFileSync(join(tmpProject, 'main.tscn'), 'utf-8');
      expect(sceneText).toMatch(/position\s*=\s*Vector2\(480,\s*-10\)/);
    },
    60000,
  );

  itGodot(
    'properties wins over a conflicting promoted param (matches handleAddNode precedence)',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      await runner.executeOperation(
        'batch_scene_operations',
        {
          operations: [
            {
              operation: 'add_node',
              scenePath: 'main.tscn',
              nodeType: 'StaticBody2D',
              nodeName: 'Conflicted',
              position: { x: 1, y: 2 },
              properties: { position: { x: 300, y: 400 } },
            },
          ],
        },
        tmpProject,
        30000,
      );
      const sceneText = readFileSync(join(tmpProject, 'main.tscn'), 'utf-8');
      expect(sceneText).toMatch(/position\s*=\s*Vector2\(300,\s*400\)/);
      expect(sceneText).not.toMatch(/position\s*=\s*Vector2\(1,\s*2\)/);
    },
    60000,
  );

  itGodot(
    'batch add_node persists promoted rotation and scale',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      await runner.executeOperation(
        'batch_scene_operations',
        {
          operations: [
            {
              operation: 'add_node',
              scenePath: 'main.tscn',
              nodeType: 'Sprite2D',
              nodeName: 'RotatedSprite',
              rotation: 1.5708,
              scale: { x: 2, y: 3 },
            },
          ],
        },
        tmpProject,
        30000,
      );
      const sceneText = readFileSync(join(tmpProject, 'main.tscn'), 'utf-8');
      expect(sceneText).toMatch(/rotation\s*=\s*1\.5708/);
      expect(sceneText).toMatch(/scale\s*=\s*Vector2\(2,\s*3\)/);
    },
    60000,
  );

  itGodot(
    'standalone add_node promoted params still work (no regression)',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      await runner.executeOperation(
        'add_node',
        {
          scenePath: 'main.tscn',
          nodeType: 'StaticBody2D',
          nodeName: 'SoloWall',
          position: { x: -10, y: 270 },
        },
        tmpProject,
        30000,
      );
      const sceneText = readFileSync(join(tmpProject, 'main.tscn'), 'utf-8');
      expect(sceneText).toMatch(/position\s*=\s*Vector2\(-10,\s*270\)/);
    },
    60000,
  );
  itGodot(
    'promoted position on a 3D node lands as a Vector3 transform',
    async () => {
      // There is no separate `position3d` param: `position` carries {x,y,z}
      // for 3D nodes, which Godot stores on the node's transform.
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      await runner.executeOperation(
        'batch_scene_operations',
        {
          operations: [
            {
              operation: 'add_node',
              scenePath: 'main.tscn',
              nodeType: 'Node3D',
              nodeName: 'Spatial',
              position: { x: 1, y: 2, z: 3 },
            },
          ],
        },
        tmpProject,
        30000,
      );
      const sceneText = readFileSync(join(tmpProject, 'main.tscn'), 'utf-8');
      expect(sceneText).toMatch(/transform = Transform3D\([^)]*1, 2, 3\)/);
    },
    60000,
  );
});
