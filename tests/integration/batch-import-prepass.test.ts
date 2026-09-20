/**
 * Integration test for the batch cold-import pre-pass.
 *
 * Regression shape: in batch_scene_operations, scenes load lazily in
 * operation order. Without the pre-pass, op 1 mutates scene A (auto-saves),
 * then op 2's scene B is cold — [IMPORT_NEEDED] fires, TS imports and
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
import { useTmpDirs } from '../helpers/tmp.js';
import { minimalPng } from '../helpers/png-fixtures.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';

/** Integration tests spawn a real Godot process; give them room to run. */
const IMPORT_TEST_TIMEOUT_MS = 180000;

/** A scene with exactly one node of `name`, countable after the fact. */
function sceneWithNode(name: string, textureExtResourceId?: string): string {
  const textureLine = textureExtResourceId
    ? `\ntexture = ExtResource("${textureExtResourceId}")`
    : '';
  const extResource = textureExtResourceId
    ? `\n[ext_resource type="Texture2D" path="res://assets/test_texture.png" id="${textureExtResourceId}"]\n`
    : '\n';
  return (
    `[gd_scene load_steps=${textureExtResourceId ? 2 : 1} format=3]` +
    extResource +
    `\n[node name="Main" type="Node2D"]\n` +
    `\n[node name="${name}" type="Sprite2D" parent="."]${textureLine}\n`
  );
}

let runner: GodotRunner;

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
});
