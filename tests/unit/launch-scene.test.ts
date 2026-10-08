/**
 * Tests for the main-scene reader behind a launch with no explicit `scene`
 * argument. Mirrors the autoload-ini test layout: tmp project dirs, project.godot
 * content as fixtures.
 */

import { describe, it, expect } from 'vitest';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
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

  it('does not enter dot directories', () => {
    const dir = tmp.makeProject();
    mkdirSync(join(dir, '.godot'));
    writeFileSync(join(dir, '.godot', 'hidden.tscn'), sceneWithUid(UID_A));
    expect(findFilesByUid(dir, UID_A).paths).toEqual([]);
  });

  describe('linked directories', () => {
    const tryLink = (target: string, path: string): boolean => {
      try {
        symlinkSync(target, path, 'junction');
        return true;
      } catch {
        return false;
      }
    };

    it('enters a linked directory and returns the file under the link', (ctx) => {
      const dir = tmp.makeProject();
      const shared = tmp.make('uid-shared-');
      writeFileSync(join(shared, 'linked.tscn'), sceneWithUid(UID_A));
      mkdirSync(join(dir, 'addons'));
      if (!tryLink(shared, join(dir, 'addons', 'shared'))) ctx.skip();
      expect(findFilesByUid(dir, UID_A)).toEqual({
        paths: [join(dir, 'addons', 'shared', 'linked.tscn')],
        complete: true,
      });
    });

    it('terminates on a link cycle and still reports the search complete', (ctx) => {
      const dir = tmp.makeProject();
      mkdirSync(join(dir, 'a'));
      writeFileSync(join(dir, 'a', 'scene.tscn'), sceneWithUid(UID_A));
      if (!tryLink(dir, join(dir, 'a', 'back'))) ctx.skip();
      expect(findFilesByUid(dir, UID_A)).toEqual({
        paths: [join(dir, 'a', 'scene.tscn')],
        complete: true,
      });
    });

    it('reports an unresolvable link as an incomplete search', (ctx) => {
      const dir = tmp.makeProject();
      const gone = tmp.make('uid-gone-');
      if (!tryLink(gone, join(dir, 'broken'))) ctx.skip();
      rmSync(gone, { recursive: true, force: true });
      expect(findFilesByUid(dir, UID_A)).toEqual({ paths: [], complete: false });
    });
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

describe('a uid search that was cut short', () => {
  const mainSceneUid = (uid: string): string =>
    `config_version=5\n\n[application]\nrun/main_scene="${uid}"\n`;
  const FILE_CAP = 2;

  it('says so when a carrier was found before the cap, instead of claiming all were scanned', () => {
    const dir = tmp.makeProject('launch-uid-capped-', mainSceneUid(UID_A));
    writeFileSync(join(dir, 'a.tscn'), sceneWithUid(UID_A));
    writeFileSync(join(dir, 'b.tscn'), sceneWithUid(UID_B));
    writeFileSync(join(dir, 'c.tscn'), sceneWithUid(UID_A));

    const result = resolveLaunchScene(dir, FILE_CAP);
    expect(result).toMatchObject({
      kind: 'scenes',
      absPaths: [join(dir, 'a.tscn')],
    });
    const notes = result.kind === 'scenes' ? result.notes.join('\n') : '';
    expect(notes).toMatch(/was cut short/);
    expect(notes).toMatch(/another file may carry it, and was not scanned/);
    expect(notes).not.toMatch(/all of them were scanned/);
  });

  it('is unresolved, and marked as an incomplete search, when no carrier was found before the cap', () => {
    const dir = tmp.makeProject('launch-uid-capped-none-', mainSceneUid(UID_A));
    for (const name of ['a', 'b', 'c']) {
      writeFileSync(join(dir, `${name}.tscn`), sceneWithUid(UID_B));
    }
    expect(resolveLaunchScene(dir, FILE_CAP)).toMatchObject({
      kind: 'unresolved',
      value: UID_A,
      reason: expect.stringMatching(/^the search was cut short .* before a file carrying/),
    });
  });

  it('a search that read every file is complete', () => {
    const dir = tmp.makeProject('launch-uid-complete-', mainSceneUid(UID_A));
    expect(resolveLaunchScene(dir)).toMatchObject({
      kind: 'unresolved',
      reason: `no scene or .uid file in the project carries ${UID_A}`,
    });
  });
});

describe('findFilesByUid folder limit', () => {
  const DIRECTORY_CAP = 3;
  const NO_FILE_CAP = 100;

  it('is incomplete after more folders than the limit, though none holds a scene file', () => {
    const dir = tmp.makeProject('launch-uid-dirs-over-', 'config_version=5\n');
    for (let i = 0; i < DIRECTORY_CAP + 1; i++) mkdirSync(join(dir, `d${i}`));
    expect(findFilesByUid(dir, UID_A, NO_FILE_CAP, DIRECTORY_CAP)).toEqual({
      paths: [],
      complete: false,
    });
  });

  it('is complete when the folders, the project root counted, are exactly at the limit', () => {
    const dir = tmp.makeProject('launch-uid-dirs-at-', 'config_version=5\n');
    for (let i = 0; i < DIRECTORY_CAP - 1; i++) mkdirSync(join(dir, `d${i}`));
    expect(findFilesByUid(dir, UID_A, NO_FILE_CAP, DIRECTORY_CAP).complete).toBe(true);
  });
});

describe('the main scene is the setting application/run/main_scene, however it is spelled', () => {
  it('reads it from an [application/run] section', () => {
    const dir = tmp.makeProject(
      'launch-scene-split-',
      'config_version=5\n\n[application/run]\nmain_scene="res://split.tscn"\n',
    );
    expect(readMainSceneFromProject(dir)).toBe('res://split.tscn');
  });

  it('reads it from a top-level line', () => {
    const dir = tmp.makeProject(
      'launch-scene-top-',
      'application/run/main_scene="res://top.tscn"\n\n[rendering]\nx=1\n',
    );
    expect(readMainSceneFromProject(dir)).toBe('res://top.tscn');
  });

  it('keeps the last assignment across spellings', () => {
    const dir = tmp.makeProject(
      'launch-scene-mixed-',
      'config_version=5\n\n[application]\nrun/main_scene="res://first.tscn"\n\n[application/run]\nmain_scene="res://last.tscn"\n',
    );
    expect(readMainSceneFromProject(dir)).toBe('res://last.tscn');
  });

  it('reads a value that starts on the line after the equals sign', () => {
    const dir = tmp.makeProject(
      'launch-scene-nextline-',
      'config_version=5\n\n[application]\nrun/main_scene=\n"res://next.tscn"\n',
    );
    expect(readMainSceneFromProject(dir)).toBe('res://next.tscn');
  });
});
