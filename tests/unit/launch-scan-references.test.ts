/**
 * How the launch scan decides what a scene's `ext_resource` lines bring in,
 * and what it does with a file that exists and cannot be read.
 *
 * The engine loads the file an `ext_resource` path names. Its `type` attribute
 * is a hint a hand-edited scene can set to anything, so the scan classifies a
 * reference by its path as well. A file the scan reads and could not read is
 * reported for that file alone, the scan goes on, and strict mode refuses the
 * launch: that is different from a file of a kind the scan never reads.
 */

import { describe, it, expect } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { runLaunchGate } from '../../src/utils/launch-gate.js';
import * as sceneParsing from '../../src/utils/scene-parsing.js';
import { makeContext } from '../helpers/runtime-fakes.js';
import { useTmpDirs } from '../helpers/tmp.js';
import { expectErrorMatching } from '../helpers/assertions.js';

const tmp = useTmpDirs();

const TIER1_BODY = 'extends Node\nfunc _ready():\n\tOS.execute("rm", [])\n';
const MAIN_SCENE_SETTING = 'run/main_scene="res://main.tscn"\n';
const SCRIPTLESS_SCENE = '[gd_scene format=3]\n\n[node name="Main" type="Node"]\n';
const BINARY_SCENE_BYTES = 'RSCC\u0000\u0001binary scene bytes';

const sceneWith = (...lines: string[]): string => `[gd_scene format=3]\n\n${lines.join('\n')}\n`;

function projectWithMainScene(prefix: string, sceneText: string): string {
  const dir = tmp.makeProject(prefix, `config_version=5\n\n[application]\n${MAIN_SCENE_SETTING}`);
  writeFileSync(join(dir, 'main.tscn'), sceneText, 'utf8');
  return dir;
}

async function gateWarnings(dir: string, strict = false): Promise<string[]> {
  const result = await runLaunchGate(
    { projectPath: dir, confirm: false, launchedByServer: false, toolName: 'run_project' },
    makeContext({ strict }),
  );
  if (!result.ok) throw new Error(`expected an ok outcome, got: ${JSON.stringify(result.error)}`);
  return result.value.warnings;
}

function strictGate(dir: string): ReturnType<typeof runLaunchGate> {
  return runLaunchGate(
    { projectPath: dir, confirm: false, launchedByServer: false, toolName: 'run_project' },
    makeContext({ strict: true }),
  );
}

/** A directory where a file should be: a read of it fails on every platform. */
function plantUnreadable(dir: string, name: string): void {
  mkdirSync(join(dir, name));
}

describe('launch scan: references are classified by path, not only by type', () => {
  it.each([
    ['type="GDScript"', '[ext_resource type="GDScript" path="res://late.gd" id="1"]'],
    ['an empty type', '[ext_resource type="" path="res://late.gd" id="1"]'],
    ['no type at all', '[ext_resource path="res://late.gd" id="1"]'],
    ['a type naming something else', '[ext_resource type="Texture2D" path="res://late.gd" id="1"]'],
  ])('a .gd file referenced with %s is scanned and produces its finding', async (_label, line) => {
    const dir = projectWithMainScene('scan-by-path-script-', sceneWith(line));
    writeFileSync(join(dir, 'late.gd'), TIER1_BODY, 'utf8');

    const collected = sceneParsing.collectSceneScripts(join(dir, 'main.tscn'), dir);
    expect(collected.scripts).toEqual([join(dir, 'late.gd')]);
    expect(collected.unscanned).toEqual([]);

    const warnings = await gateWarnings(dir);
    expect(warnings.join('\n')).toMatch(/late\.gd:3 OS\.execute/);
  });

  it('strict mode refuses on a Tier 1 script referenced with a GDScript type hint', async () => {
    const dir = projectWithMainScene(
      'scan-by-path-strict-',
      sceneWith('[ext_resource type="GDScript" path="res://late.gd" id="1"]'),
    );
    writeFileSync(join(dir, 'late.gd'), TIER1_BODY, 'utf8');

    const result = await strictGate(dir);

    expectErrorMatching(result, /Strict mode: refusing to launch/);
    expectErrorMatching(result, /late\.gd/);
  });

  it('a .tscn file referenced with a type other than PackedScene is walked', async () => {
    const dir = projectWithMainScene(
      'scan-by-path-scene-',
      sceneWith('[ext_resource type="Resource" path="res://child.tscn" id="1"]'),
    );
    writeFileSync(
      join(dir, 'child.tscn'),
      sceneWith('[ext_resource type="Script" path="res://inner.gd" id="1"]'),
    );
    writeFileSync(join(dir, 'inner.gd'), TIER1_BODY, 'utf8');

    const warnings = await gateWarnings(dir);

    expect(warnings.join('\n')).toMatch(/inner\.gd:3 OS\.execute/);
  });

  it('a script type hint on a file that is not GDScript is reported, whichever hint it is', () => {
    const dir = projectWithMainScene(
      'scan-by-path-csharp-',
      sceneWith('[ext_resource type="CSharpScript" path="res://a.cs" id="1"]'),
    );

    const collected = sceneParsing.collectSceneScripts(join(dir, 'main.tscn'), dir);

    expect(collected.unscanned.map((u) => u.reason)).toEqual([
      'script res://a.cs is not GDScript and is not scanned',
    ]);
  });

  it('a binary resource file is reported once, however many scenes name it', async () => {
    const themeLine = '[ext_resource type="Theme" path="res://ui.res" id="1"]';
    const dir = projectWithMainScene(
      'scan-resource-file-',
      sceneWith(themeLine, '[ext_resource type="PackedScene" path="res://child.tscn" id="2"]'),
    );
    writeFileSync(join(dir, 'child.tscn'), sceneWith(themeLine));

    const collected = sceneParsing.collectSceneScripts(join(dir, 'main.tscn'), dir);
    expect(collected.unscanned.map((u) => u.reason)).toEqual([
      'resource res://ui.res is not scanned (a binary .res file can carry a script)',
    ]);

    const warnings = await gateWarnings(dir);
    expect(warnings.join('\n')).toMatch(/Not scanned: main\.tscn: resource res:\/\/ui\.res/);
  });

  it('an imported asset that cannot carry a script is not reported', () => {
    const dir = projectWithMainScene(
      'scan-plain-asset-',
      sceneWith('[ext_resource type="Texture2D" path="res://icon.png" id="1"]'),
    );

    const collected = sceneParsing.collectSceneScripts(join(dir, 'main.tscn'), dir);

    expect(collected.unscanned).toEqual([]);
  });

  it('a reference with no res:// path is reported, whatever its type', () => {
    const dir = projectWithMainScene(
      'scan-no-path-any-',
      sceneWith('[ext_resource type="Resource" uid="uid://abc" id="1"]'),
    );

    const collected = sceneParsing.collectSceneScripts(join(dir, 'main.tscn'), dir);

    expect(collected.unscanned).toHaveLength(1);
    expect(collected.unscanned[0]?.reason).toMatch(
      /ext_resource has no res:\/\/ path and was not followed/,
    );
  });

  it('extractSceneScripts lists a .gd reference whatever its type says', () => {
    const dir = projectWithMainScene(
      'scan-extract-by-path-',
      sceneWith('[ext_resource type="GDScript" path="res://late.gd" id="1"]'),
    );

    expect(sceneParsing.extractSceneScripts(join(dir, 'main.tscn'), dir)).toEqual([
      join(dir, 'late.gd'),
    ]);
  });
});

// A scene that exists and cannot be read used to throw out of the whole scan:
// one "pre-flight scan failed" line, and every autoload and scene after it
// went unscanned with nothing naming them.
describe('launch scan: a file that exists and cannot be read', () => {
  function projectWithUnreadableAutoloadScene(prefix: string): string {
    const dir = tmp.makeProject(
      prefix,
      'config_version=5\n\n[autoload]\nBroken="*res://broken.tscn"\nLater="*res://later.gd"\n',
    );
    plantUnreadable(dir, 'broken.tscn');
    writeFileSync(join(dir, 'later.gd'), TIER1_BODY, 'utf8');
    return dir;
  }

  it('is reported for that file, and the scan goes on to what comes after it', async () => {
    const dir = projectWithUnreadableAutoloadScene('scan-unreadable-scene-');

    const joined = (await gateWarnings(dir)).join('\n');

    expect(joined).toMatch(/Not scanned: broken\.tscn: scene file could not be read/);
    // The autoload listed after the unreadable scene is still scanned.
    expect(joined).toMatch(/later\.gd:3 OS\.execute/);
    expect(joined).not.toMatch(/pre-flight scan failed/);
  });

  it('collectSceneScripts does not throw on it, and marks the entry as a failed read', () => {
    const dir = projectWithMainScene(
      'scan-unreadable-subscene-',
      sceneWith('[ext_resource type="PackedScene" path="res://sub.tscn" id="1"]'),
    );
    plantUnreadable(dir, 'sub.tscn');

    const collected = sceneParsing.collectSceneScripts(join(dir, 'main.tscn'), dir);

    expect(collected.unscanned).toHaveLength(1);
    expect(collected.unscanned[0]?.readFailed).toBe(true);
    expect(collected.unscanned[0]?.reason).toMatch(/scene file could not be read/);
  });

  it('a scene that is simply missing is not marked as a failed read', () => {
    const dir = projectWithMainScene(
      'scan-missing-subscene-',
      sceneWith('[ext_resource type="PackedScene" path="res://ghost.tscn" id="1"]'),
    );

    const collected = sceneParsing.collectSceneScripts(join(dir, 'main.tscn'), dir);

    expect(collected.unscanned).toEqual([
      { scenePath: join(dir, 'ghost.tscn'), reason: 'scene file not found' },
    ]);
  });
});

describe('launch scan: what strict mode refuses on besides a Tier 1 finding', () => {
  it('a text scene that exists and could not be read', async () => {
    const dir = projectWithMainScene('scan-strict-unreadable-scene-', SCRIPTLESS_SCENE);
    rmSync(join(dir, 'main.tscn'));
    plantUnreadable(dir, 'main.tscn');

    const result = await strictGate(dir);

    expectErrorMatching(
      result,
      /Strict mode: refusing to launch project because the pre-flight scan could not read/,
    );
    expectErrorMatching(result, /main\.tscn: scene file could not be read/);
  });

  it('a GDScript file that exists and could not be read', async () => {
    const dir = tmp.makeProject(
      'scan-strict-unreadable-script-',
      'config_version=5\n\n[autoload]\nBoot="*res://boot.gd"\n',
    );
    plantUnreadable(dir, 'boot.gd');

    const result = await strictGate(dir);

    expectErrorMatching(result, /pre-flight scan could not read/);
    expectErrorMatching(result, /boot\.gd/);
  });

  it('a scan step that threw', async () => {
    // A project.godot that exists and cannot be read: the autoload section
    // cannot be listed, so nothing after it was scanned.
    const dir = tmp.make('scan-strict-threw-');
    plantUnreadable(dir, 'project.godot');

    const result = await strictGate(dir);

    expectErrorMatching(result, /pre-flight scan could not read/);
    expectErrorMatching(result, /run_project pre-flight scan failed/);
  });

  it('and the same read failure only warns outside strict mode', async () => {
    const dir = projectWithMainScene('scan-default-unreadable-', SCRIPTLESS_SCENE);
    rmSync(join(dir, 'main.tscn'));
    plantUnreadable(dir, 'main.tscn');

    const warnings = await gateWarnings(dir, false);

    expect(warnings.some((w) => /scene file could not be read/.test(w))).toBe(true);
  });

  // What strict mode does not refuse on: files of a kind the scan never reads.
  // Refusing on these would block every C# and binary-scene project.
  it.each([
    ['a C# script', sceneWith('[ext_resource type="Script" path="res://a.cs" id="1"]')],
    ['a binary scene', BINARY_SCENE_BYTES],
    ['a binary resource file', sceneWith('[ext_resource type="Theme" path="res://ui.res" id="1"]')],
  ])('it still launches when the scene brings in %s', async (_label, sceneText) => {
    const dir = projectWithMainScene('scan-strict-by-kind-', sceneText);

    const warnings = await gateWarnings(dir, true);

    expect(warnings.some((w) => w.startsWith('Not scanned: '))).toBe(true);
  });

  it('it still launches when a script the scene names is missing from disk', async () => {
    const dir = projectWithMainScene(
      'scan-strict-missing-',
      sceneWith('[ext_resource type="Script" path="res://gone.gd" id="1"]'),
    );

    const warnings = await gateWarnings(dir, true);

    expect(warnings.some((w) => /gone\.gd \(file not found\)/.test(w))).toBe(true);
  });
});

describe('launch scan: a .tres a scene references is read like a scene', () => {
  const resourceWith = (...lines: string[]): string =>
    `[gd_resource type="Resource" format=3]

${lines.join('\n')}
`;
  const scriptRef = (path: string): string => `[ext_resource type="Script" path="${path}" id="1"]`;
  const tresRef = (path: string): string => `[ext_resource type="Resource" path="${path}" id="2"]`;

  it('reports a Tier 1 script attached to a .tres the scene references', async () => {
    const dir = projectWithMainScene('scan-tres-script-', sceneWith(tresRef('res://data.tres')));
    writeFileSync(join(dir, 'data.tres'), resourceWith(scriptRef('res://evil.gd')), 'utf8');
    writeFileSync(join(dir, 'evil.gd'), TIER1_BODY, 'utf8');

    const warnings = await gateWarnings(dir);

    expect(warnings.join('\n')).toMatch(/evil\.gd:3 OS\.execute/);
    expectErrorMatching(await strictGate(dir), /evil\.gd:3 OS\.execute/);
  });

  it('follows a chain of .tres files two deep', async () => {
    const dir = projectWithMainScene('scan-tres-chain-', sceneWith(tresRef('res://a.tres')));
    writeFileSync(join(dir, 'a.tres'), resourceWith(tresRef('res://b.tres')), 'utf8');
    writeFileSync(join(dir, 'b.tres'), resourceWith(scriptRef('res://deep.gd')), 'utf8');
    writeFileSync(join(dir, 'deep.gd'), TIER1_BODY, 'utf8');

    expect((await gateWarnings(dir)).join('\n')).toMatch(/deep\.gd:3 OS\.execute/);
  });

  it('reads the source of an inline GDScript inside a .tres', async () => {
    const dir = projectWithMainScene('scan-tres-inline-', sceneWith(tresRef('res://a.tres')));
    writeFileSync(
      join(dir, 'a.tres'),
      resourceWith(
        '[sub_resource type="GDScript" id="1"]',
        'script/source = "extends Node\\nfunc _ready():\\n\\tOS.execute(\\"x\\")\\n"',
      ),
      'utf8',
    );

    expect((await gateWarnings(dir)).join('\n')).toMatch(/a\.tres\[GDScript 1\]:3 OS\.execute/);
  });

  it('ends on a .tres cycle', () => {
    const dir = projectWithMainScene('scan-tres-cycle-', sceneWith(tresRef('res://a.tres')));
    writeFileSync(join(dir, 'a.tres'), resourceWith(tresRef('res://b.tres')), 'utf8');
    writeFileSync(join(dir, 'b.tres'), resourceWith(tresRef('res://a.tres')), 'utf8');

    const collected = sceneParsing.collectSceneScripts(join(dir, 'main.tscn'), dir);

    expect(collected.unscanned).toEqual([]);
  });

  it('a .tres that cannot be read is a read failure, so strict mode refuses', async () => {
    const dir = projectWithMainScene('scan-tres-unreadable-', sceneWith(tresRef('res://a.tres')));
    plantUnreadable(dir, 'a.tres');

    expect((await gateWarnings(dir)).some((w) => /scene file could not be read/.test(w))).toBe(
      true,
    );
    expectErrorMatching(await strictGate(dir), /pre-flight scan could not read/);
  });

  it('a .res is still only a Not scanned notice, which strict mode does not refuse', async () => {
    const dir = projectWithMainScene(
      'scan-res-notice-',
      sceneWith('[ext_resource type="Resource" path="res://a.res" id="1"]'),
    );

    const warnings = await gateWarnings(dir, true);

    expect(warnings.join('\n')).toMatch(/resource res:\/\/a\.res is not scanned/);
  });
});
