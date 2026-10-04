/**
 * Tests for the main-scene reader behind a launch with no explicit `scene`
 * argument. Mirrors the autoload-ini test layout: tmp project dirs, project.godot
 * content as fixtures.
 */

import { describe, it, expect } from 'vitest';
import { mkdirSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  findFilesByUid,
  readMainSceneFromProject,
  resolveLaunchScene,
  UID_HEADER_READ_BYTES,
} from '../../src/utils/launch-scene.js';
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
    expect(resolveLaunchScene(dir)).toEqual({
      kind: 'scenes',
      absPaths: [join(dir, 'main.tscn')],
      notes: [],
    });
  });

  it('returns kind none when no scene is configured', () => {
    const dir = tmp.makeProject('launch-scene-', 'config_version=5\n');
    expect(resolveLaunchScene(dir)).toEqual({ kind: 'none' });
  });

  it('resolves a value with no res:// prefix under the project', () => {
    const dir = tmp.makeProject(
      'launch-scene-',
      'config_version=5\n\n[application]\nrun/main_scene="scenes/main.tscn"\n',
    );
    expect(resolveLaunchScene(dir)).toMatchObject({
      kind: 'scenes',
      absPaths: [join(dir, 'scenes', 'main.tscn')],
    });
  });

  it('resolves the last of two keys', () => {
    const dir = tmp.makeProject(
      'launch-scene-',
      'config_version=5\n\n[application]\nrun/main_scene="res://first.tscn"\nrun/main_scene="res://second.tscn" ; current\n',
    );
    expect(resolveLaunchScene(dir)).toMatchObject({
      kind: 'scenes',
      absPaths: [join(dir, 'second.tscn')],
    });
  });

  it('is unresolved for a value that leaves the project', () => {
    const dir = tmp.makeProject(
      'launch-scene-',
      'config_version=5\n\n[application]\nrun/main_scene="res://../outside.tscn"\n',
    );
    expect(resolveLaunchScene(dir)).toMatchObject({
      kind: 'unresolved',
      value: 'res://../outside.tscn',
    });
  });
});

const UID_A = 'uid://aaaaaaaaaaaaa';
const UID_B = 'uid://bbbbbbbbbbbbb';

function sceneWithUid(uid: string): string {
  return `[gd_scene format=3 uid="${uid}"]\n\n[node name="Main" type="Node2D"]\n`;
}

describe('findFilesByUid', () => {
  it('finds a scene by its header uid and a script by its .uid sidecar', () => {
    const dir = tmp.makeProject();
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'a.tscn'), sceneWithUid(UID_A));
    writeFileSync(join(dir, 'b.tscn'), sceneWithUid(UID_B));
    writeFileSync(join(dir, 'auto.gd'), 'extends Node\n');
    writeFileSync(join(dir, 'auto.gd.uid'), UID_B + '\n');
    const found = findFilesByUid(dir, UID_A);
    expect(found).toEqual({ paths: [join(dir, 'sub', 'a.tscn')], complete: true });
    expect(findFilesByUid(dir, UID_B).paths).toEqual([join(dir, 'auto.gd'), join(dir, 'b.tscn')]);
  });

  it('does not enter dot directories or follow symlinks', () => {
    const dir = tmp.makeProject();
    mkdirSync(join(dir, '.godot'));
    writeFileSync(join(dir, '.godot', 'hidden.tscn'), sceneWithUid(UID_A));
    const outside = tmp.make('uid-outside-');
    writeFileSync(join(outside, 'linked.tscn'), sceneWithUid(UID_A));
    try {
      symlinkSync(outside, join(dir, 'link'), 'junction');
    } catch {
      // Link creation can be refused; the dot-directory half still holds.
    }
    expect(findFilesByUid(dir, UID_A).paths).toEqual([]);
  });

  it('reads only the first line of the header bytes', () => {
    const dir = tmp.makeProject();
    const padding = 'x'.repeat(UID_HEADER_READ_BYTES);
    writeFileSync(
      join(dir, 'late.tscn'),
      `[gd_scene format=3]\n; ${padding}\n[ext_resource uid="${UID_A}"]\n`,
    );
    expect(findFilesByUid(dir, UID_A).paths).toEqual([]);
  });

  it('stops after the file cap and reports an incomplete search', () => {
    const dir = tmp.makeProject();
    for (const name of ['a', 'b', 'c', 'd']) {
      writeFileSync(join(dir, `${name}.tscn`), sceneWithUid(UID_B));
    }
    writeFileSync(join(dir, 'z.tscn'), sceneWithUid(UID_A));
    expect(findFilesByUid(dir, UID_A, 3)).toEqual({ paths: [], complete: false });
  });
});

describe('resolveLaunchScene with a uid:// main scene', () => {
  const mainSceneUid = (uid: string): string =>
    `config_version=5\n\n[application]\nrun/main_scene="${uid}"\n`;

  it('resolves to the scene carrying the uid', () => {
    const dir = tmp.makeProject('launch-uid-', mainSceneUid(UID_A));
    writeFileSync(join(dir, 'menu.tscn'), sceneWithUid(UID_A));
    expect(resolveLaunchScene(dir)).toEqual({
      kind: 'scenes',
      absPaths: [join(dir, 'menu.tscn')],
      notes: [],
    });
  });

  it('is unresolved when no file carries the uid', () => {
    const dir = tmp.makeProject('launch-uid-', mainSceneUid(UID_A));
    const result = resolveLaunchScene(dir);
    expect(result).toMatchObject({ kind: 'unresolved', value: UID_A });
    expect(result.kind === 'unresolved' && result.reason).toContain(UID_A);
  });

  it('returns every file carrying the uid with a note', () => {
    const dir = tmp.makeProject('launch-uid-', mainSceneUid(UID_A));
    writeFileSync(join(dir, 'one.tscn'), sceneWithUid(UID_A));
    writeFileSync(join(dir, 'two.tscn'), sceneWithUid(UID_A));
    const result = resolveLaunchScene(dir);
    expect(result).toMatchObject({
      kind: 'scenes',
      absPaths: [join(dir, 'one.tscn'), join(dir, 'two.tscn')],
    });
    expect(result.kind === 'scenes' && result.notes).toHaveLength(1);
  });
});
