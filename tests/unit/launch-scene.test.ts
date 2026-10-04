/**
 * Tests for the main-scene reader behind a launch with no explicit `scene`
 * argument. Mirrors the autoload-ini test layout: tmp project dirs, project.godot
 * content as fixtures.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { readMainSceneFromProject, resolveLaunchScene } from '../../src/utils/launch-scene.js';
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

  it('reads a value followed by a comment', () => {
    const dir = tmp.makeProject(
      'main-scene-',
      'config_version=5\n\n[application]\nrun/main_scene="res://main.tscn" ; the menu\n',
    );
    expect(readMainSceneFromProject(dir)).toBe('res://main.tscn');
  });

  it('reads the key under a header followed by a comment', () => {
    const dir = tmp.makeProject(
      'main-scene-',
      'config_version=5\n\n[application] ; edited by hand\nrun/main_scene="res://main.tscn"\n',
    );
    expect(readMainSceneFromProject(dir)).toBe('res://main.tscn');
  });

  it('reads the last of two keys, the one the engine keeps', () => {
    const dir = tmp.makeProject(
      'main-scene-',
      'config_version=5\n\n[application]\nrun/main_scene="res://first.tscn"\nrun/main_scene="res://second.tscn"\n',
    );
    expect(readMainSceneFromProject(dir)).toBe('res://second.tscn');
  });

  it('reads a CRLF file', () => {
    const dir = tmp.makeProject(
      'main-scene-',
      'config_version=5\r\n\r\n[application]\r\nrun/main_scene="res://main.tscn"\r\n',
    );
    expect(readMainSceneFromProject(dir)).toBe('res://main.tscn');
  });

  it('returns null for an empty or non-string value', () => {
    for (const value of ['""', '', '5', 'true']) {
      const dir = tmp.makeProject(
        'main-scene-',
        `config_version=5\n\n[application]\nrun/main_scene=${value}\n`,
      );
      expect(readMainSceneFromProject(dir)).toBeNull();
    }
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

  it('resolves a value with no res:// prefix under the project', () => {
    const dir = tmp.makeProject(
      'launch-scene-',
      'config_version=5\n\n[application]\nrun/main_scene="scenes/main.tscn"\n',
    );
    expect(resolveLaunchScene(dir)).toBe(join(dir, 'scenes', 'main.tscn'));
  });

  it('resolves the last of two keys', () => {
    const dir = tmp.makeProject(
      'launch-scene-',
      'config_version=5\n\n[application]\nrun/main_scene="res://first.tscn"\nrun/main_scene="res://second.tscn" ; current\n',
    );
    expect(resolveLaunchScene(dir)).toBe(join(dir, 'second.tscn'));
  });

  it('returns null for a value that leaves the project', () => {
    const dir = tmp.makeProject(
      'launch-scene-',
      'config_version=5\n\n[application]\nrun/main_scene="res://../outside.tscn"\n',
    );
    expect(resolveLaunchScene(dir)).toBeNull();
  });
});
