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
 * A dependency that is missing from disk entirely (not just unimported) is a
 * different failure: the scene load is refused outright rather than fed into
 * the import retry, so the reference is never silently stripped on save.
 *
 * Rules:
 * - a fresh project with a new PNG asset: a scene op emits [IMPORT_NEEDED]
 *   rather than a plain failure
 * - the same holds for a uid-form dependency string (every scene saved by
 *   the Godot editor uses this form, not the bare res:// form)
 * - a scene referencing a file that does not exist on disk at all is refused
 *   outright, not imported-then-stripped
 * - after import_assets, the same op succeeds and .godot/imported exists
 * - a warm project still catches a first-time reference to a brand new,
 *   never-imported asset (load_sprite naming a texture with no prior deps)
 * - GodotRunner.importAssets() throws on individual import failures
 *   (Godot exits 0 even when assets fail — stderr is the only signal)
 *
 * Requires GODOT_PATH. Skipped locally when it is unset; CI sets it in the
 * godot-integration job and runs this file on Godot 4.5.1 and 4.6.2.
 */

import { describe, beforeAll, expect } from 'vitest';
import { cpSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { itGodot } from '../helpers/godot-skip.js';
import { fixtureProjectPath } from '../helpers/fixture-paths.js';
import { useTmpDirs } from '../helpers/tmp.js';
import { minimalPng, invalidPng } from '../helpers/png-fixtures.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';

/** Integration tests spawn a real Godot process; give them room to run. */
const IMPORT_TEST_TIMEOUT_MS = 180000;

let runner: GodotRunner;

beforeAll(async () => {
  runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
  await runner.detectGodotPath();
});

describe('reactive import on demand (integration)', () => {
  const tmp = useTmpDirs();

  itGodot(
    'emits [IMPORT_NEEDED] on a cold project, then succeeds after import and retry',
    async () => {
      const project = tmp.make('godot-mcp-test-');
      cpSync(fixtureProjectPath, project, { recursive: true });

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
    IMPORT_TEST_TIMEOUT_MS,
  );

  itGodot(
    'emits [IMPORT_NEEDED] for a uid-form dependency string, the shape every editor-saved scene uses',
    async () => {
      const project = tmp.make('godot-mcp-test-');
      cpSync(fixtureProjectPath, project, { recursive: true });

      const assetsDir = join(project, 'assets');
      mkdirSync(assetsDir, { recursive: true });
      writeFileSync(join(assetsDir, 'test_texture.png'), minimalPng());
      writeFileSync(join(project, 'placeholder.png'), minimalPng());
      rmSync(join(project, '.godot', 'imported'), { recursive: true, force: true });

      writeFileSync(
        join(project, 'main.tscn'),
        [
          '[gd_scene load_steps=2 format=3]',
          '',
          '[ext_resource type="Texture2D" uid="uid://bq0sxwkx7p5xe" path="res://assets/test_texture.png" id="1"]',
          '',
          '[node name="Main" type="Node2D"]',
          '',
          '[node name="Sprite2D" type="Sprite2D" parent="."]',
          'texture = ExtResource("1")',
          '',
        ].join('\n'),
      );

      const { stdout, stderr } = await runner.executeOperation(
        'get_scene_tree',
        { scenePath: 'main.tscn' },
        project,
      );
      expect(stdout.trim()).toBe('');
      expect(stderr).toContain('[IMPORT_NEEDED]');
      expect(stderr).toContain('res://assets/test_texture.png');
    },
    IMPORT_TEST_TIMEOUT_MS,
  );

  itGodot(
    'refuses to load (and never mutates) a scene referencing a file that does not exist on disk',
    async () => {
      const project = tmp.make('godot-mcp-test-');
      cpSync(fixtureProjectPath, project, { recursive: true });

      writeFileSync(
        join(project, 'main.tscn'),
        [
          '[gd_scene load_steps=2 format=3]',
          '',
          '[ext_resource type="Texture2D" path="res://assets/nope.png" id="1"]',
          '',
          '[node name="Main" type="Node2D"]',
          '',
          '[node name="Sprite2D" type="Sprite2D" parent="."]',
          'texture = ExtResource("1")',
          '',
        ].join('\n'),
      );
      const before = readFileSync(join(project, 'main.tscn'), 'utf8');

      const { stdout, stderr } = await runner.executeOperation(
        'add_node',
        { scenePath: 'main.tscn', nodeName: 'Extra', nodeType: 'Node2D' },
        project,
      );
      expect(stdout.trim()).toBe('');
      expect(stderr).toContain('do not exist on disk');
      expect(readFileSync(join(project, 'main.tscn'), 'utf8')).toBe(before);
    },
    IMPORT_TEST_TIMEOUT_MS,
  );

  itGodot(
    'catches a first-time asset reference on an already-warm project (load_sprite naming a brand new texture)',
    async () => {
      const project = tmp.make('godot-mcp-test-');
      cpSync(fixtureProjectPath, project, { recursive: true });
      writeFileSync(join(project, 'placeholder.png'), minimalPng());

      // Warm the project up first — no texture refs in main.tscn yet.
      await runner.importAssets(project);
      expect(existsSync(join(project, '.godot', 'imported'))).toBe(true);

      // Now add a brand new asset the scene-load probe never saw (it wasn't
      // a dependency of anything at import time).
      const assetsDir = join(project, 'assets');
      mkdirSync(assetsDir, { recursive: true });
      writeFileSync(join(assetsDir, 'new_texture.png'), minimalPng());

      const { stdout, stderr } = await runner.executeOperation(
        'load_sprite',
        {
          scenePath: 'main.tscn',
          nodePath: 'Sprite2D',
          texturePath: 'res://assets/new_texture.png',
        },
        project,
      );
      expect(stdout.trim()).toBe('');
      expect(stderr).toContain('[IMPORT_NEEDED]');
      expect(stderr).toContain('res://assets/new_texture.png');
    },
    IMPORT_TEST_TIMEOUT_MS,
  );

  itGodot(
    'importAssets throws when an individual asset fails to import (exit code stays 0)',
    async () => {
      const project = tmp.make('godot-mcp-test-');
      cpSync(fixtureProjectPath, project, { recursive: true });

      const assetsDir = join(project, 'assets');
      mkdirSync(assetsDir, { recursive: true });
      writeFileSync(join(assetsDir, 'broken.png'), invalidPng());

      rmSync(join(project, '.godot', 'imported'), { recursive: true, force: true });

      // Godot exits 0 even when the asset fails to import; only stderr knows.
      await expect(runner.importAssets(project)).rejects.toThrow(/broken\.png/);
    },
    IMPORT_TEST_TIMEOUT_MS,
  );
});
