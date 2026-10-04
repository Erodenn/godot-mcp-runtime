/**
 * Tests for the .tscn / project.godot helpers used by run_project's pre-flight
 * scan. Mirrors the autoload-ini test layout: tmp project dirs, INI/TSCN
 * content as fixtures.
 */

import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import {
  readMainSceneFromProject,
  resolveLaunchScene,
  extractSceneScripts,
  collectSceneScriptsRecursive,
} from '../../src/utils/scene-parsing.js';
import { useTmpDirs } from '../helpers/tmp.js';

const tmp = useTmpDirs();

describe('readMainSceneFromProject', () => {
  it('returns the main scene from [application]', () => {
    const dir = tmp.makeProject(
      'main-scene-',
      'config_version=5\n\n[application]\nrun/main_scene="res://main.tscn"\n',
    );
    expect(readMainSceneFromProject(dir)).toBe('res://main.tscn');
  });

  it('returns null when the key is absent', () => {
    const dir = tmp.makeProject('main-scene-', 'config_version=5\n\n[application]\n');
    expect(readMainSceneFromProject(dir)).toBeNull();
  });

  it('returns null when project.godot is missing', () => {
    const dir = tmp.make('no-project-');
    expect(readMainSceneFromProject(dir)).toBeNull();
  });

  it('ignores main_scene keys outside [application]', () => {
    const dir = tmp.makeProject(
      'main-scene-',
      'config_version=5\n\n[autoload]\nrun/main_scene="res://decoy.tscn"\n',
    );
    expect(readMainSceneFromProject(dir)).toBeNull();
  });

  it('tolerates an unquoted value (hand-edited project.godot)', () => {
    const dir = tmp.makeProject(
      'main-scene-',
      'config_version=5\n\n[application]\nrun/main_scene=res://main.tscn\n',
    );
    expect(readMainSceneFromProject(dir)).toBe('res://main.tscn');
  });
});

describe('resolveLaunchScene', () => {
  it('reads run/main_scene', () => {
    const dir = tmp.makeProject(
      'launch-scene-',
      'config_version=5\n\n[application]\nrun/main_scene="res://main.tscn"\n',
    );
    expect(resolveLaunchScene(dir)).toBe(join(dir, 'main.tscn'));
  });

  it('returns null when no scene is configured', () => {
    const dir = tmp.makeProject('launch-scene-', 'config_version=5\n');
    expect(resolveLaunchScene(dir)).toBeNull();
  });
});

describe('extractSceneScripts', () => {
  it('returns absolute paths for each [ext_resource type="Script"] entry', () => {
    const dir = tmp.makeProject('scene-scripts-', 'config_version=5\n');
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts/player.gd'), '');
    writeFileSync(join(dir, 'scripts/enemy.gd'), '');
    const scenePath = join(dir, 'main.tscn');
    writeFileSync(
      scenePath,
      [
        '[gd_scene format=3]',
        '',
        '[ext_resource type="Script" path="res://scripts/player.gd" id="1_aaa"]',
        '[ext_resource type="Script" uid="uid://abc" path="res://scripts/enemy.gd" id="2_bbb"]',
        '[ext_resource type="PackedScene" path="res://scenes/other.tscn" id="3_ccc"]',
        '[ext_resource type="Texture2D" path="res://textures/x.png" id="4_ddd"]',
        '',
        '[node name="Main" type="Node2D"]',
        '',
      ].join('\n'),
    );
    expect(extractSceneScripts(scenePath, dir)).toEqual([
      join(dir, 'scripts/player.gd'),
      join(dir, 'scripts/enemy.gd'),
    ]);
  });

  it('returns [] when the scene file is missing', () => {
    const dir = tmp.makeProject('scene-scripts-', 'config_version=5\n');
    expect(extractSceneScripts(join(dir, 'missing.tscn'), dir)).toEqual([]);
  });

  it('returns [] when the scene has no Script ext_resources', () => {
    const dir = tmp.makeProject('scene-scripts-', 'config_version=5\n');
    const scenePath = join(dir, 'main.tscn');
    writeFileSync(scenePath, '[gd_scene format=3]\n\n[node name="Main" type="Node2D"]\n');
    expect(extractSceneScripts(scenePath, dir)).toEqual([]);
  });

  it('skips entries whose path does not end in .gd', () => {
    const dir = tmp.makeProject('scene-scripts-', 'config_version=5\n');
    const scenePath = join(dir, 'main.tscn');
    writeFileSync(
      scenePath,
      '[ext_resource type="Script" path="res://scripts/bad.cs" id="1_aaa"]\n',
    );
    expect(extractSceneScripts(scenePath, dir)).toEqual([]);
  });
});

describe('collectSceneScriptsRecursive', () => {
  it("collects a child scene's script transitively through a PackedScene reference", () => {
    const dir = tmp.makeProject('subscene-', 'config_version=5\n');
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts/parent.gd'), '');
    writeFileSync(join(dir, 'scripts/child.gd'), '');

    const childScenePath = join(dir, 'child.tscn');
    writeFileSync(
      childScenePath,
      [
        '[gd_scene format=3]',
        '',
        '[ext_resource type="Script" path="res://scripts/child.gd" id="1_ccc"]',
        '',
        '[node name="Child" type="Node2D"]',
        '',
      ].join('\n'),
    );

    const parentScenePath = join(dir, 'parent.tscn');
    writeFileSync(
      parentScenePath,
      [
        '[gd_scene format=3]',
        '',
        '[ext_resource type="Script" path="res://scripts/parent.gd" id="1_ppp"]',
        '[ext_resource type="PackedScene" path="res://child.tscn" id="2_ccc"]',
        '',
        '[node name="Main" type="Node2D"]',
        '',
      ].join('\n'),
    );

    const result = collectSceneScriptsRecursive(parentScenePath, dir);
    expect(result).toContain(join(dir, 'scripts/parent.gd'));
    expect(result).toContain(join(dir, 'scripts/child.gd'));
    expect(result).toHaveLength(2);
  });

  it('terminates and returns the union on a two-scene reference cycle', () => {
    const dir = tmp.makeProject('subscene-cycle-', 'config_version=5\n');
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts/a.gd'), '');
    writeFileSync(join(dir, 'scripts/b.gd'), '');

    const sceneAPath = join(dir, 'a.tscn');
    const sceneBPath = join(dir, 'b.tscn');

    writeFileSync(
      sceneAPath,
      [
        '[gd_scene format=3]',
        '',
        '[ext_resource type="Script" path="res://scripts/a.gd" id="1_aaa"]',
        '[ext_resource type="PackedScene" path="res://b.tscn" id="2_bbb"]',
        '',
        '[node name="A" type="Node2D"]',
        '',
      ].join('\n'),
    );
    writeFileSync(
      sceneBPath,
      [
        '[gd_scene format=3]',
        '',
        '[ext_resource type="Script" path="res://scripts/b.gd" id="1_bbb"]',
        '[ext_resource type="PackedScene" path="res://a.tscn" id="2_aaa"]',
        '',
        '[node name="B" type="Node2D"]',
        '',
      ].join('\n'),
    );

    const result = collectSceneScriptsRecursive(sceneAPath, dir);
    expect(result.sort()).toEqual([join(dir, 'scripts/a.gd'), join(dir, 'scripts/b.gd')].sort());
  });

  it('skips a missing subscene reference silently instead of throwing', () => {
    const dir = tmp.makeProject('subscene-missing-', 'config_version=5\n');
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts/parent.gd'), '');

    const parentScenePath = join(dir, 'parent.tscn');
    writeFileSync(
      parentScenePath,
      [
        '[gd_scene format=3]',
        '',
        '[ext_resource type="Script" path="res://scripts/parent.gd" id="1_ppp"]',
        '[ext_resource type="PackedScene" path="res://ghost.tscn" id="2_ggg"]',
        '',
        '[node name="Main" type="Node2D"]',
        '',
      ].join('\n'),
    );

    expect(() => collectSceneScriptsRecursive(parentScenePath, dir)).not.toThrow();
    expect(collectSceneScriptsRecursive(parentScenePath, dir)).toEqual([
      join(dir, 'scripts/parent.gd'),
    ]);
  });

  it('returns [] when the root scene file is missing', () => {
    const dir = tmp.makeProject('subscene-root-missing-', 'config_version=5\n');
    expect(collectSceneScriptsRecursive(join(dir, 'missing.tscn'), dir)).toEqual([]);
  });
});
