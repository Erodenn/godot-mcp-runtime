/**
 * Integration tests for the reactive import-on-demand behavior.
 *
 * Context: on a fresh project, `.godot/imported` does not exist and headless
 * Godot runs no import step — `ResourceLoader.load` fails on real files
 * sitting on disk (`res://assets/paddle.svg`, even `icon.svg`). Worse, a scene
 * that references an unimported texture loads with `null` and auto-save
 * silently strips the reference from the .tscn.
 *
 * The fix: `load_scene_instance` in godot_operations.gd probes ext_resources
 * before loading; if `ResourceLoader.exists(dep)` is false while
 * `FileAccess.file_exists(dep)` is true, it emits
 * `[IMPORT_NEEDED] <scene>: <files>` and returns null. TS catches the marker
 * in stderr, runs the import step, and retries the operation once. The signal
 * is self-terminating: failed imports still write `.import` sidecars, so the
 * same asset is never probed again and instead reports as a broken asset.
 *
 * Rules:
 * - a fresh project with a new PNG asset: a scene op emits [IMPORT_NEEDED]
 *   rather than a plain failure
 * - after import_assets, the same op succeeds and .godot/imported exists
 * - GodotRunner.importAssets() throws on individual import failures
 *   (Godot exits 0 even when assets fail — stderr is the only signal)
 *
 * Requires GODOT_PATH. Skipped in CI without it.
 */

import { describe, beforeAll, afterAll, expect } from 'vitest';
import { cpSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs';
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

/** 1x1 transparent PNG. */
function minimalPng(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
}

/** Garbage bytes with a .png extension — import fails but writes an .import sidecar. */
function invalidPng(): Buffer {
  return Buffer.from('this is not a png at all');
}

const tmpDirs: string[] = [];
let runner: GodotRunner;

beforeAll(async () => {
  runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
  await runner.detectGodotPath();
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

describe('reactive import on demand (integration)', () => {
  itGodot(
    'emits [IMPORT_NEEDED] on a cold project, then succeeds after import and retry',
    async () => {
      const project = makeTmpProject();
      tmpDirs.push(project);

      // New asset that was never imported.
      const assetsDir = join(project, 'assets');
      mkdirSync(assetsDir, { recursive: true });
      writeFileSync(join(assetsDir, 'test_texture.png'), minimalPng());

      // The committed fixture ships an intentionally-invalid placeholder.png
      // (see the "Error importing" control case). importAssets() treats any
      // individual import failure as an error, so give the temp copy a valid
      // one — this test is about the cold-import flow, not broken assets.
      writeFileSync(join(project, 'placeholder.png'), minimalPng());

      // Fresh copy: strip any committed .godot/imported so the project starts cold.
      rmSync(join(project, '.godot', 'imported'), { recursive: true, force: true });

      // Reference the unimported texture from the scene — the cold-state bug
      // shape: file on disk, no import artifacts, scene ops would silently
      // strip the reference on save.
      writeFileSync(
        join(project, 'main.tscn'),
        [
          '[gd_scene load_steps=2 format=3]',
          '',
          `[ext_resource type="Texture2D" path="res://assets/test_texture.png" id="1"]`,
          '',
          '[node name="Main" type="Node2D"]',
          '',
          '[node name="Sprite2D" type="Sprite2D" parent="."]',
          'texture = ExtResource("1")',
          '',
        ].join('\n'),
      );

      // A scene operation on the cold project: expect the marker, not a plain failure.
      const { stdout, stderr } = await runner.executeOperation(
        'get_scene_tree',
        { scenePath: 'main.tscn' },
        project,
      );
      expect(stdout.trim()).toBe('');
      expect(stderr).toContain('[IMPORT_NEEDED]');
      expect(stderr).toContain('res://assets/test_texture.png');

      // Import, then the same operation succeeds.
      await runner.importAssets(project);
      expect(existsSync(join(project, '.godot', 'imported'))).toBe(true);
      const retry = await runner.executeOperation(
        'get_scene_tree',
        { scenePath: 'main.tscn' },
        project,
      );
      expect(retry.stdout.trim()).not.toBe('');

      // Idempotent re-run.
      await runner.importAssets(project);
    },
    180000,
  );

  itGodot(
    'importAssets throws when an individual asset fails to import (exit code stays 0)',
    async () => {
      const project = makeTmpProject();
      tmpDirs.push(project);

      const assetsDir = join(project, 'assets');
      mkdirSync(assetsDir, { recursive: true });
      writeFileSync(join(assetsDir, 'broken.png'), invalidPng());

      rmSync(join(project, '.godot', 'imported'), { recursive: true, force: true });

      // Godot exits 0 even when the asset fails to import; only stderr knows.
      await expect(runner.importAssets(project)).rejects.toThrow(/broken\.png/);
    },
    180000,
  );
});
