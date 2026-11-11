// On a fresh project headless Godot runs no import step, so ResourceLoader.load fails on unimported files and auto-save silently strips their references.
// importAssets() throws on individual failures because Godot exits 0 even when assets fail; stderr is the only signal.

import { describe, beforeAll, expect } from 'vitest';
import { cpSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { itGodot } from '../helpers/godot-skip.js';
import { fixtureProjectPath } from '../helpers/fixture-paths.js';
import { useTmpDirs } from '../helpers/tmp.js';
import { minimalPng, invalidPng } from '../helpers/png-fixtures.js';
import { stripExitLeakNoise } from '../helpers/engine-noise.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { handleAddNode } from '../../src/tools/scene-tools.js';
import { hasError, errorText, unwrap } from '../helpers/assertions.js';

const IMPORT_TEST_TIMEOUT_MS = 180000;

const COLD_INSTANCE_SCENE = 'cold_instance.tscn';

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

      const assetsDir = join(project, 'assets');
      mkdirSync(assetsDir, { recursive: true });
      writeFileSync(join(assetsDir, 'test_texture.png'), minimalPng());

      // The committed placeholder.png is intentionally invalid and importAssets() treats any import failure as an error, so give the copy a valid one.
      writeFileSync(join(project, 'placeholder.png'), minimalPng());

      // Strip any committed .godot/imported so the project starts cold.
      rmSync(join(project, '.godot', 'imported'), { recursive: true, force: true });

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

      const { stdout, stderr } = await runner.executeOperation(
        'get_scene_tree',
        { scenePath: 'main.tscn' },
        project,
      );
      expect(stripExitLeakNoise(stdout)).toBe('');
      expect(stderr).toContain('[IMPORT_NEEDED]');
      expect(stderr).toContain('res://assets/test_texture.png');

      await runner.importAssets(project);
      expect(existsSync(join(project, '.godot', 'imported'))).toBe(true);
      const retry = await runner.executeOperation(
        'get_scene_tree',
        { scenePath: 'main.tscn' },
        project,
      );
      expect(retry.stdout.trim()).not.toBe('');

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
      expect(stripExitLeakNoise(stdout)).toBe('');
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
      expect(stripExitLeakNoise(stdout)).toBe('');
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

      await runner.importAssets(project);
      expect(existsSync(join(project, '.godot', 'imported'))).toBe(true);

      // Added after warm-up, so the scene-load probe never saw it as a dependency.
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
      expect(stripExitLeakNoise(stdout)).toBe('');
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

  itGodot(
    'standalone add_node of a scene nodeType whose own asset is cold imports and retries instead of failing to load',
    async () => {
      const project = tmp.make('godot-mcp-test-');
      cpSync(fixtureProjectPath, project, { recursive: true });

      const assetsDir = join(project, 'assets');
      mkdirSync(assetsDir, { recursive: true });
      writeFileSync(join(assetsDir, 'test_texture.png'), minimalPng());
      writeFileSync(join(project, 'placeholder.png'), minimalPng());
      rmSync(join(project, '.godot', 'imported'), { recursive: true, force: true });

      writeFileSync(
        join(project, COLD_INSTANCE_SCENE),
        [
          '[gd_scene load_steps=2 format=3]',
          '',
          '[ext_resource type="Texture2D" path="res://assets/test_texture.png" id="1"]',
          '',
          '[node name="Cold" type="Sprite2D"]',
          'texture = ExtResource("1")',
          '',
        ].join('\n'),
      );

      const result = await handleAddNode(runner, {
        projectPath: project,
        scenePath: 'main.tscn',
        nodeType: COLD_INSTANCE_SCENE,
        nodeName: 'ColdInstance',
      });

      if (hasError(result)) throw new Error(errorText(result) ?? 'add_node returned an error');
      const payload = unwrap(result).structuredContent as { nodeName: string };
      expect(payload.nodeName).toBe('ColdInstance');
      expect(existsSync(join(project, '.godot', 'imported'))).toBe(true);
      // Godot may write extra attributes (unique_id) on the node line, so tie the
      // instance to the cold scene's ext_resource id rather than to attribute order.
      const mainScene = readFileSync(join(project, 'main.tscn'), 'utf-8');
      const extResource = mainScene.match(
        new RegExp(
          `\\[ext_resource type="PackedScene"[^\\]]*path="res://${COLD_INSTANCE_SCENE.replace('.', '\\.')}"[^\\]]*id="([^"]+)"`,
        ),
      );
      expect(extResource).not.toBeNull();
      const coldId = extResource![1];
      const nodeLine = mainScene.match(/^\[node name="ColdInstance"[^\]]*\]$/m)?.[0];
      expect(nodeLine).toBeDefined();
      expect(nodeLine).toContain('parent="."');
      expect(nodeLine).toContain(`instance=ExtResource("${coldId}")`);
    },
    IMPORT_TEST_TIMEOUT_MS,
  );
});
