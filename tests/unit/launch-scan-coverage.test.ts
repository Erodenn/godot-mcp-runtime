/**
 * What the launch scan reads and what it admits it could not read: inline
 * GDScript sub-resources, scripts attached to instanced scenes, scene
 * autoloads, scripts that are not GDScript, and autoload lines the parser could
 * not understand. The scene-format tests run on hand-written `.tscn` text.
 */

import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'fs';
import { join } from 'path';
import {
  runLaunchGate,
  MAX_SCAN_WARNINGS_SHOWN,
  MAX_SCAN_INCOMPLETE_SHOWN,
} from '../../src/utils/launch-gate.js';
import * as sceneParsing from '../../src/utils/scene-parsing.js';
import { makeContext } from '../helpers/runtime-fakes.js';
import { useTmpDirs } from '../helpers/tmp.js';
import { expectErrorMatching } from '../helpers/assertions.js';

const tmp = useTmpDirs();

const TIER1_BODY = 'extends Node\nfunc _ready():\n\tOS.execute("rm", [])\n';
const MAIN_SCENE_SETTING = 'run/main_scene="res://main.tscn"\n';
const SCRIPTLESS_SCENE = '[gd_scene format=3]\n\n[node name="Main" type="Node"]\n';
const BINARY_SCENE_BYTES = 'RSCC\u0000\u0001binary scene bytes';
const EXTRA_NOT_SCANNED_COUNT = 3;

/** An inline script as Godot saves it: `script/source` is one string with real newlines. */
const INLINE_TIER1_SCENE = [
  '[gd_scene load_steps=2 format=3 uid="uid://abc"]',
  '',
  '[sub_resource type="GDScript" id="GDScript_evil"]',
  'script/source = "extends Node',
  '',
  'func _ready():',
  '\tOS.execute(\\"rm\\", [])',
  '"',
  '',
  '[node name="Main" type="Node"]',
  'script = SubResource("GDScript_evil")',
  '',
].join('\n');

function projectWithMainScene(prefix: string, sceneText: string, extraSettings = ''): string {
  const dir = tmp.makeProject(
    prefix,
    `config_version=5\n\n[application]\n${MAIN_SCENE_SETTING}${extraSettings}`,
  );
  writeFileSync(join(dir, 'main.tscn'), sceneText, 'utf8');
  return dir;
}

async function gateWarnings(dir: string, strict = false): Promise<string[]> {
  const result = await runLaunchGate(
    { projectPath: dir, confirm: false, toolName: 'run_project' },
    makeContext({ strict }),
  );
  if (!result.ok) throw new Error(`expected an ok outcome, got: ${JSON.stringify(result.error)}`);
  return result.value.warnings;
}

describe('launch scan: inline GDScript sub-resources', () => {
  it('an inline GDScript sub_resource reaches the scanner and produces a finding', async () => {
    const dir = projectWithMainScene('scan-inline-', INLINE_TIER1_SCENE);
    const warnings = await gateWarnings(dir);
    expect(warnings.join('\n')).toMatch(/main\.tscn\[GDScript GDScript_evil\]:4 OS\.execute/);
  });

  it('strict mode refuses on a Tier 1 finding in an inline script', async () => {
    const dir = projectWithMainScene('scan-inline-strict-', INLINE_TIER1_SCENE);
    const result = await runLaunchGate(
      { projectPath: dir, confirm: false, toolName: 'run_project' },
      makeContext({ strict: true }),
    );
    expectErrorMatching(result, /Strict mode: refusing to launch/);
    expectErrorMatching(result, /GDScript_evil/);
  });

  it('a bracketed line inside a multi-line string value is not read as a header', () => {
    const decoy = '[ext_resource type="Script" path="res://decoy.gd" id="9"]';
    // Godot writes the quotes inside a string value escaped.
    const decoyAsWritten = decoy.replace(/"/g, '\\"');
    const scene = [
      '[gd_scene format=3]',
      '',
      '[sub_resource type="GDScript" id="GDScript_a"]',
      'script/source = "extends Node',
      decoyAsWritten,
      '[node name=\\"Fake\\"]',
      '"',
      '',
      '[node name="Main" type="Node"]',
      '',
    ].join('\n');
    const dir = projectWithMainScene('scan-decoy-', scene);
    const collected = sceneParsing.collectSceneScripts(join(dir, 'main.tscn'), dir);
    expect(collected.scripts).toEqual([]);
    expect(collected.inlineScripts).toHaveLength(1);
    expect(collected.inlineScripts[0]?.source).toContain(decoy);
    const scan = sceneParsing.scanTscn(scene);
    expect(scan.headers.map((h) => h.tag)).toEqual(['gd_scene', 'sub_resource', 'node']);
  });

  it('a header-like line inside another property string does not create a phantom inline script', () => {
    const scene = [
      '[gd_scene format=3]',
      '',
      '[node name="Main" type="Node"]',
      'metadata/note = "first line',
      '[sub_resource type=\\"GDScript\\" id=\\"x\\"]',
      'script/source = \\"extends Node\\"',
      'last line"',
      '',
    ].join('\n');
    const scan = sceneParsing.scanTscn(scene);
    expect(scan.headers.map((h) => h.tag)).toEqual(['gd_scene', 'node']);
    expect(scan.malformed).toEqual([]);
    const dir = projectWithMainScene('scan-phantom-', scene);
    const collected = sceneParsing.collectSceneScripts(join(dir, 'main.tscn'), dir);
    expect(collected.inlineScripts).toEqual([]);
    expect(collected.unscanned).toEqual([]);
  });

  it('a source string whose quotes are not escaped is reported as not scanned, never as no scripts', () => {
    const scene = [
      '[gd_scene format=3]',
      '',
      '[sub_resource type="GDScript" id="GDScript_raw"]',
      'script/source = "extends Node',
      '[ext_resource type="Script" path="res://decoy.gd" id="9"]',
      '"',
      '',
    ].join('\n');
    const dir = projectWithMainScene('scan-raw-quotes-', scene);
    const collected = sceneParsing.collectSceneScripts(join(dir, 'main.tscn'), dir);
    expect(collected.inlineScripts).toEqual([]);
    expect(collected.unscanned.some((u) => /GDScript_raw has no readable/.test(u.reason))).toBe(
      true,
    );
  });

  it('escaped quotes and backslashes in inline source are unescaped before scanning', () => {
    const scene = [
      '[gd_scene format=3]',
      '',
      '[sub_resource type="GDScript" id="GDScript_b"]',
      'script/source = "a\\"b\\\\c\\nd\\te\\u0041\\q"',
      '',
    ].join('\n');
    const scan = sceneParsing.scanTscn(scene);
    const header = scan.headers.find((h) => h.tag === 'sub_resource');
    expect(header?.stringProps.get('script/source')).toBe('a"b\\c\nd\teAq');
    expect(scan.malformed).toEqual([]);
  });

  it('a string still open at end of file is reported as not scanned', () => {
    const scene = [
      '[gd_scene format=3]',
      '',
      '[sub_resource type="GDScript" id="GDScript_c"]',
      'script/source = "extends Node',
      '',
    ].join('\n');
    const scan = sceneParsing.scanTscn(scene);
    expect(scan.malformed.map((m) => m.reason)).toContain('unterminated string');
    const dir = projectWithMainScene('scan-open-string-', scene);
    const collected = sceneParsing.collectSceneScripts(join(dir, 'main.tscn'), dir);
    expect(collected.unscanned.some((u) => /unterminated string/.test(u.reason))).toBe(true);
  });

  it('an inline GDScript with no readable source is reported as not scanned', () => {
    const scene = [
      '[gd_scene format=3]',
      '',
      '[sub_resource type="GDScript" id="GDScript_d"]',
      '',
      '[node name="Main" type="Node"]',
      '',
    ].join('\n');
    const dir = projectWithMainScene('scan-no-source-', scene);
    const collected = sceneParsing.collectSceneScripts(join(dir, 'main.tscn'), dir);
    expect(collected.unscanned.some((u) => /GDScript_d has no readable/.test(u.reason))).toBe(true);
  });
});

describe('launch scan: instance overrides', () => {
  const instanceScene = (scriptLine: string, extraHeaders: string[]): string =>
    [
      '[gd_scene load_steps=4 format=3]',
      '',
      '[ext_resource type="PackedScene" path="res://child.tscn" id="1_child"]',
      ...extraHeaders,
      '',
      '[node name="Main" type="Node"]',
      '',
      '[node name="Child" parent="." instance=ExtResource("1_child")]',
      scriptLine,
      '',
    ].join('\n');

  it('an instance override that assigns an inline script is scanned', async () => {
    const dir = projectWithMainScene(
      'scan-instance-inline-',
      instanceScene('script = SubResource("GDScript_o")', [
        '[sub_resource type="GDScript" id="GDScript_o"]',
        'script/source = "extends Node\\nfunc f():\\n\\tOS.execute(\\"x\\", [])\\n"',
      ]),
    );
    writeFileSync(join(dir, 'child.tscn'), '[gd_scene format=3]\n\n[node name="C" type="Node"]\n');
    const warnings = await gateWarnings(dir);
    expect(warnings.join('\n')).toMatch(/GDScript_o\]:3 OS\.execute/);
  });

  it('an instance override that assigns an external script is scanned', async () => {
    const dir = projectWithMainScene(
      'scan-instance-ext-',
      instanceScene('script = ExtResource("2_s")', [
        '[ext_resource type="Script" path="res://override.gd" id="2_s"]',
      ]),
    );
    writeFileSync(join(dir, 'child.tscn'), '[gd_scene format=3]\n\n[node name="C" type="Node"]\n');
    writeFileSync(join(dir, 'override.gd'), TIER1_BODY, 'utf8');
    const warnings = await gateWarnings(dir);
    expect(warnings.join('\n')).toMatch(/override\.gd:3 OS\.execute/);
  });
});

describe('launch scan: scripts and scenes it cannot read', () => {
  it('a script path containing a closing bracket is scanned', () => {
    const scene =
      '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://we]ird.gd" id="1"]\n';
    const dir = projectWithMainScene('scan-bracket-', scene);
    const collected = sceneParsing.collectSceneScripts(join(dir, 'main.tscn'), dir);
    expect(collected.scripts).toEqual([join(dir, 'we]ird.gd')]);
  });

  it('a C# script is reported as not scanned', async () => {
    const scene = '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://a.cs" id="1"]\n';
    const dir = projectWithMainScene('scan-csharp-', scene);
    const collected = sceneParsing.collectSceneScripts(join(dir, 'main.tscn'), dir);
    expect(collected.scripts).toEqual([]);
    expect(collected.unscanned.map((u) => u.reason)).toEqual([
      'script res://a.cs is not GDScript and is not scanned',
    ]);
    const warnings = await gateWarnings(dir);
    expect(warnings.join('\n')).toMatch(/Not scanned: main\.tscn: script res:\/\/a\.cs/);
  });

  it('a launch scene that is not a text scene is reported as not scanned', async () => {
    const dir = projectWithMainScene('scan-binary-scene-', BINARY_SCENE_BYTES);
    const warnings = await gateWarnings(dir);
    expect(warnings.join('\n')).toMatch(/Not scanned: main\.tscn: not a text scene/);
  });

  it('a Script ext_resource with no path is reported as not scanned', () => {
    const scene = '[gd_scene format=3]\n\n[ext_resource type="Script" uid="uid://abc" id="1"]\n';
    const dir = projectWithMainScene('scan-no-path-', scene);
    const collected = sceneParsing.collectSceneScripts(join(dir, 'main.tscn'), dir);
    expect(collected.unscanned).toHaveLength(1);
    expect(collected.unscanned[0]?.reason).toMatch(/Script ext_resource has no res:\/\/ path/);
  });

  it('a script extension in upper case is scanned', () => {
    const scene =
      '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://Big.GD" id="1"]\n';
    const dir = projectWithMainScene('scan-upper-', scene);
    const collected = sceneParsing.collectSceneScripts(join(dir, 'main.tscn'), dir);
    expect(collected.scripts).toEqual([join(dir, 'Big.GD')]);
  });

  it('a missing subscene is reported as not scanned', () => {
    const scene =
      '[gd_scene format=3]\n\n[ext_resource type="PackedScene" path="res://ghost.tscn" id="1"]\n';
    const dir = projectWithMainScene('scan-ghost-', scene);
    const collected = sceneParsing.collectSceneScripts(join(dir, 'main.tscn'), dir);
    expect(collected.unscanned.map((u) => u.reason)).toContain('scene file not found');
  });

  it('a header with no closing bracket is not read as a header', () => {
    const scan = sceneParsing.scanTscn('[gd_scene format=3]\n[ext_resource type="Script" path=\n');
    expect(scan.headers.map((h) => h.tag)).toEqual(['gd_scene']);
    expect(scan.malformed).toHaveLength(1);
    expect(scan.malformed[0]?.raw.startsWith('[ext_resource')).toBe(true);
  });
});

describe('launch scan: autoloads', () => {
  it('a scene autoload has its scripts scanned', async () => {
    const dir = tmp.makeProject(
      'scan-scene-autoload-',
      'config_version=5\n\n[autoload]\nBoot="*res://boot.tscn"\n',
    );
    writeFileSync(
      join(dir, 'boot.tscn'),
      '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://boot_script.gd" id="1"]\n',
    );
    writeFileSync(join(dir, 'boot_script.gd'), TIER1_BODY, 'utf8');
    const warnings = await gateWarnings(dir);
    expect(warnings.join('\n')).toMatch(/boot_script\.gd:3 OS\.execute/);
  });

  it('an autoload that is neither .gd nor .tscn is reported as not scanned', async () => {
    const dir = tmp.makeProject(
      'scan-cs-autoload-',
      'config_version=5\n\n[autoload]\nNative="*res://native.cs"\n',
    );
    const warnings = await gateWarnings(dir);
    expect(warnings).toContain(
      'Autoload Native (res://native.cs) was not scanned: only .gd scripts and .tscn scenes are scanned',
    );
  });

  it('not-scanned entries are never dropped by the findings cap', async () => {
    const findingCount = MAX_SCAN_WARNINGS_SHOWN + 2;
    const body = 'extends Node\nfunc _ready():\n' + '\tOS.execute("x")\n'.repeat(findingCount);
    const dir = tmp.makeProject(
      'scan-cap-',
      'config_version=5\n\n[autoload]\nMyAuto="res://auto.gd"\nNative="res://native.cs"\n',
    );
    writeFileSync(join(dir, 'auto.gd'), body, 'utf8');
    const warnings = await gateWarnings(dir);
    expect(warnings).toContain('+2 more');
    expect(warnings.some((w) => /Autoload Native .* was not scanned/.test(w))).toBe(true);
  });

  it('caps the not-scanned entries separately and says how many more there were', async () => {
    const count = MAX_SCAN_INCOMPLETE_SHOWN + EXTRA_NOT_SCANNED_COUNT;
    const lines = Array.from({ length: count }, (_, n) => `Native${n}="res://n${n}.cs"`);
    const dir = projectWithMainScene(
      'scan-incomplete-cap-',
      SCRIPTLESS_SCENE,
      `\n[autoload]\n${lines.join('\n')}\n`,
    );
    const warnings = await gateWarnings(dir);
    expect(warnings).toHaveLength(MAX_SCAN_INCOMPLETE_SHOWN + 1);
    expect(warnings[warnings.length - 1]).toBe(
      `+${EXTRA_NOT_SCANNED_COUNT} more files were not scanned`,
    );
  });

  it('an unparsed autoload line is reported by the launch gate', async () => {
    const dir = tmp.makeProject(
      'scan-unparsed-',
      'config_version=5\n\n[autoload]\nmy-auto="res://a.gd"\n',
    );
    const warnings = await gateWarnings(dir);
    expect(warnings).toContain(
      'Autoload line could not be parsed and was not scanned: my-auto="res://a.gd"',
    );
  });

  it('an autoload path that escapes the project is still skipped for a scene', async () => {
    const dir = tmp.makeProject(
      'scan-escape-',
      'config_version=5\n\n[autoload]\nOut="res://../elsewhere.tscn"\n',
    );
    const warnings = await gateWarnings(dir);
    expect(warnings.join('\n')).toMatch(/Skipped autoload Out/);
  });
});
