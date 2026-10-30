import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import {
  collectSceneScripts,
  extractSceneScripts,
  scanTscn,
} from '../../src/utils/scene-parsing.js';
import { useTmpDirs } from '../helpers/tmp.js';

const tmp = useTmpDirs();

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

describe('collectSceneScripts script paths', () => {
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

    const result = collectSceneScripts(parentScenePath, dir).scripts;
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

    const result = collectSceneScripts(sceneAPath, dir).scripts;
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

    expect(() => collectSceneScripts(parentScenePath, dir).scripts).not.toThrow();
    expect(collectSceneScripts(parentScenePath, dir).scripts).toEqual([
      join(dir, 'scripts/parent.gd'),
    ]);
  });

  it('returns [] when the root scene file is missing', () => {
    const dir = tmp.makeProject('subscene-root-missing-', 'config_version=5\n');
    expect(collectSceneScripts(join(dir, 'missing.tscn'), dir).scripts).toEqual([]);
  });
});

describe('scanTscn rawProps', () => {
  const scan = scanTscn(
    [
      '[gd_scene load_steps=2 format=3]',
      '',
      '[node name="Main" type="Node2D"]',
      'script = ExtResource("1_a")',
      'position = Vector2(3, 4)  ; a comment',
      'text = "plain string"',
      'frames = ["a", ExtResource("2_b")]',
      'metadata/table = {',
      '"key": 1',
      '}',
      '',
    ].join('\r\n'),
  );
  const node = scan.headers[1]!;

  it('keeps a non-string value as written, by key', () => {
    expect(node.rawProps.get('script')).toBe('ExtResource("1_a")');
    expect(node.rawProps.get('frames')).toBe('["a", ExtResource("2_b")]');
  });

  it('stops at a comment and trims the line ending', () => {
    expect(node.rawProps.get('position')).toBe('Vector2(3, 4)');
  });

  it('leaves a value that is one quoted string to stringProps', () => {
    expect(node.stringProps.get('text')).toBe('plain string');
    expect(node.rawProps.has('text')).toBe(false);
  });

  it('returns a value that continues on later lines whole', () => {
    expect(node.rawProps.get('metadata/table')).toBe('{\r\n"key": 1\r\n}');
    expect(Array.from(node.rawProps.keys())).toEqual([
      'script',
      'position',
      'frames',
      'metadata/table',
    ]);
  });

  it('gives a header with no properties an empty map', () => {
    expect(scan.headers[0]!.rawProps.size).toBe(0);
  });
});

describe('scanTscn values written across lines', () => {
  // The layout Godot 4 writes for an AnimationPlayer and its library.
  const animated = [
    '[gd_scene load_steps=4 format=3]',
    '',
    '[ext_resource type="AudioStream" path="res://step.ogg" id="3_x"]',
    '',
    '[sub_resource type="Animation" id="Animation_idle1"]',
    'tracks/0/keys = {',
    '"clips": [{',
    '"note": "a ] and a } and an = in a string",',
    '"stream": ExtResource("3_x")',
    '}],',
    '"times": PackedFloat32Array(0)',
    '}',
    'length = 2.0',
    '',
    '[sub_resource type="AnimationLibrary" id="AnimationLibrary_abc12"]',
    '_data = {',
    '&"idle": SubResource("Animation_idle1")',
    '}',
    '',
    '[node name="Anim" type="AnimationPlayer"]',
    'libraries = {',
    '&"": SubResource("AnimationLibrary_abc12")',
    '}',
    'speed_scale = 2.0',
    '',
  ].join('\n');
  const scan = scanTscn(animated);
  const byTag = (tag: string, at = 0) => scan.headers.filter((h) => h.tag === tag)[at]!;

  it('reads a dictionary through its closing brace', () => {
    expect(byTag('node').rawProps.get('libraries')).toBe(
      '{\n&"": SubResource("AnimationLibrary_abc12")\n}',
    );
    expect(byTag('sub_resource', 1).rawProps.get('_data')).toBe(
      '{\n&"idle": SubResource("Animation_idle1")\n}',
    );
  });

  it('is not ended early by brackets inside a string, nor by nested brackets', () => {
    const keys = byTag('sub_resource').rawProps.get('tracks/0/keys') ?? '';
    expect(keys.startsWith('{\n"clips": [{')).toBe(true);
    expect(keys).toContain('"stream": ExtResource("3_x")');
    expect(keys.endsWith('"times": PackedFloat32Array(0)\n}')).toBe(true);
  });

  it('reads the property after a multi-line value as its own property', () => {
    expect(byTag('sub_resource').rawProps.get('length')).toBe('2.0');
    expect(byTag('node').rawProps.get('speed_scale')).toBe('2.0');
    expect(Array.from(byTag('node').rawProps.keys())).toEqual(['libraries', 'speed_scale']);
  });

  it('reads every header, on its own line number, and reports nothing malformed', () => {
    expect(scan.malformed).toEqual([]);
    expect(scan.headers.map((h) => [h.tag, h.line])).toEqual([
      ['gd_scene', 1],
      ['ext_resource', 3],
      ['sub_resource', 5],
      ['sub_resource', 15],
      ['node', 20],
    ]);
  });

  it('drops a comment inside a multi-line value', () => {
    const commented = scanTscn(
      '[gd_scene format=3]\n[node name="N" type="Node"]\nmetadata/t = { ; why\n"a": 1 ; one\n}\n',
    );
    expect(commented.headers[1]!.rawProps.get('metadata/t')).toBe('{ \n"a": 1 \n}');
  });

  it('still reads a multi-line string that looks like structure as one string', () => {
    const inline = scanTscn(
      '[gd_scene format=3]\n[sub_resource type="GDScript" id="G"]\nscript/source = "extends Node\nvar d = {\n[node]\n"\n\n[node name="N" type="Node"]\n',
    );
    expect(inline.headers[1]!.stringProps.get('script/source')).toBe(
      'extends Node\nvar d = {\n[node]\n',
    );
    expect(inline.headers.map((h) => h.tag)).toEqual(['gd_scene', 'sub_resource', 'node']);
  });

  it('cuts a value whose bracket never closes at its first line, reports it, and reads on', () => {
    const open = scanTscn(
      [
        '[gd_scene format=3]',
        '[node name="N" type="Node"]',
        'metadata/open = {',
        '"a": 1',
        '[ext_resource type="Script" path="res://after.gd" id="1_a"]',
        '',
      ].join('\n'),
    );
    expect(open.malformed).toEqual([
      { line: 3, reason: 'value has an unclosed bracket', raw: 'metadata/open = {' },
    ]);
    expect(open.headers[1]!.rawProps.get('metadata/open')).toBe('{');
    expect(open.headers.map((h) => h.tag)).toEqual(['gd_scene', 'node', 'ext_resource']);
  });

  it('skips a leading byte order mark', () => {
    const marked = scanTscn('﻿[gd_scene format=3]\n\n[node name="N" type="Node"]\n');
    expect(marked.isTextResource).toBe(true);
    expect(marked.headers.map((h) => [h.tag, h.line])).toEqual([
      ['gd_scene', 1],
      ['node', 3],
    ]);
  });
});

describe('scanTscn reads statements where the engine reads them', () => {
  const GD_HEADER = '[sub_resource type="GDScript" id="evil"]';
  const SOURCE_LINES = [
    'script/source = "extends Node',
    'func _init():',
    '\tprint(\\"PROBE evil ran\\")',
    '"',
  ];
  const EVIL_SOURCE = 'extends Node\nfunc _init():\n\tprint("PROBE evil ran")\n';
  /** Lines a section of its own is wrapped in, to see whether a scan loses it. */
  const wrap = (before: string[], after: string[]): string =>
    [
      '[gd_scene load_steps=2 format=3]',
      '',
      '[sub_resource type="Resource" id="pad"]',
      ...before,
      '',
      GD_HEADER,
      ...SOURCE_LINES,
      '',
      '[sub_resource type="Resource" id="pad2"]',
      ...after,
      '',
      '[node name="Root" type="Node"]',
      'script = SubResource("evil")',
      '',
    ].join('\n');
  const inlineOf = (text: string): Array<string | undefined> =>
    scanTscn(text)
      .headers.filter((h) => h.attrs.get('type') === 'GDScript')
      .map((h) => h.stringProps.get('script/source'));

  it('does not read a section as part of a value because a bracket follows the value', () => {
    // Godot loads this scene and runs the inline script: its value ends at
    // `1`, and `(` starts the key of the next statement.
    const scan = scanTscn(wrap(['metadata/a = 1 (', '= 0'], [') = 0']));
    expect(
      scan.headers.map((h) => `${h.tag}:${h.attrs.get('type') ?? h.attrs.get('name')}`),
    ).toEqual([
      'gd_scene:undefined',
      'sub_resource:Resource',
      'sub_resource:GDScript',
      'sub_resource:Resource',
      'node:Node',
    ]);
    expect(inlineOf(wrap(['metadata/a = 1 (', '= 0'], [') = 0']))).toEqual([EVIL_SOURCE]);
    // The layout is still reported: it is not one Godot writes.
    expect(scan.malformed.map((m) => [m.line, m.reason])).toEqual([
      [4, 'text after the value on the same line'],
      [4, 'line has no = and is not a statement'],
    ]);
  });

  it.each([
    ['a string', 'metadata/a = "x" ('],
    ['a constructor', 'metadata/a = Vector2(1, 2) ('],
    ['a closed dictionary', 'metadata/a = {} ['],
    ['a bare word', 'metadata/a = true {'],
    ['a color', 'metadata/a = #ff00ff ('],
  ])('finds the section after %s followed by an opening bracket', (_label, line) => {
    expect(inlineOf(wrap([line, '= 0'], []))).toEqual([EVIL_SOURCE]);
  });

  it('ends a value that is still open at a line that opens a known section', () => {
    const scan = scanTscn(wrap(['metadata/a = {', '"k": ['], []));
    expect(inlineOf(wrap(['metadata/a = {', '"k": ['], []))).toEqual([EVIL_SOURCE]);
    expect(scan.malformed).toEqual([
      { line: 4, reason: 'value has an unclosed bracket', raw: 'metadata/a = {' },
    ]);
    expect(scan.headers[1]?.rawProps.get('metadata/a')).toBe('{');
  });

  it('does not end a value at a bracketed line that opens no known section', () => {
    const scan = scanTscn(
      '[gd_scene format=3]\n[node name="N" type="Node"]\nmetadata/a = [\n[1, 2],\n[sub]\n]\nx = 1\n',
    );
    expect(scan.malformed).toEqual([]);
    expect(scan.headers[1]?.rawProps.get('metadata/a')).toBe('[\n[1, 2],\n[sub]\n]');
    expect(scan.headers[1]?.rawProps.get('x')).toBe('1');
  });

  it('never keeps an earlier value of a key whose later assignment it could not read', () => {
    // The engine keeps the last assignment. A scan that kept the first would
    // show the launch gate a script that is not the one that runs.
    const decoy = 'script/source = "extends Node"';
    for (const later of [
      'script/source = "extends Node" + evil',
      'script/source = Evil',
      'script/source = &"extends Object"',
    ]) {
      const text = ['[gd_scene format=3]', GD_HEADER, decoy, later, ''].join('\n');
      expect(inlineOf(text)).toEqual([undefined]);
    }
  });

  it('reads the last of two readable assignments, a quoted key and a key split by blanks', () => {
    const text = [
      '[gd_scene format=3]',
      GD_HEADER,
      'script/source = "first"',
      '"script/source" = "second"',
      'script/ source = "third"',
      '',
    ].join('\n');
    expect(inlineOf(text)).toEqual(['third']);
  });

  it('joins a key written across lines, as the engine does, and reports the line', () => {
    const scan = scanTscn(
      ['[gd_scene format=3]', GD_HEADER, 'script/', 'source = "joined"', ''].join('\n'),
    );
    expect(scan.headers[1]?.stringProps.get('script/source')).toBe('joined');
    expect(scan.malformed).toEqual([
      { line: 3, reason: 'line has no = and is not a statement', raw: 'script/' },
    ]);
  });

  it('reads a statement that follows a header on the same line, and reports it', () => {
    const scan = scanTscn(
      `[gd_scene format=3]\n[sub_resource type="Resource" id="pad"] ${GD_HEADER}\nscript/source = "x"\n`,
    );
    expect(scan.headers.map((h) => h.attrs.get('type'))).toEqual([
      undefined,
      'Resource',
      'GDScript',
    ]);
    expect(scan.headers[2]?.stringProps.get('script/source')).toBe('x');
    expect(scan.malformed.map((m) => m.reason)).toEqual(['text after the header on the same line']);
  });

  it('reads a type or path written as a StringName the way the engine converts it', () => {
    const scan = scanTscn(
      '[gd_scene format=3]\n[sub_resource type=&"GDScript" id="e"]\n[ext_resource type="Script" path=&"res://a.gd" id="1"]\n',
    );
    expect(scan.malformed).toEqual([]);
    expect(scan.headers[1]?.attrs.get('type')).toBe('GDScript');
    expect(scan.headers[2]?.attrs.get('path')).toBe('res://a.gd');
  });

  it('reads the values Godot writes without reporting any', () => {
    const lines = [
      'a = -1.5e-05',
      'b = inf',
      'c = -inf',
      'd = null',
      'e = &"name"',
      'f = NodePath("A/B")',
      'g = Array[int]([1, 2])',
      'h = Dictionary[String, int]({',
      '"k": 1',
      '})',
      'i = PackedInt32Array(1, 2)',
      'j = ExtResource("1_a")',
      'k = Color(1, 0, 0, 1)',
      'l = 3',
      'm = "s"',
      'n = [{',
      '"x": Vector2(1, 2)',
      '}]',
    ];
    const scan = scanTscn(
      ['[gd_scene format=3]', '[node name="N" type="Node"]', ...lines, ''].join('\n'),
    );
    expect(scan.malformed).toEqual([]);
    const node = scan.headers[1]!;
    expect(Array.from(node.rawProps.keys()).concat(Array.from(node.stringProps.keys()))).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
      'h',
      'i',
      'j',
      'k',
      'l',
      'n',
      'm',
    ]);
    expect(node.rawProps.get('h')).toBe('Dictionary[String, int]({\n"k": 1\n})');
    expect(node.rawProps.get('c')).toBe('-inf');
  });
});

describe('scanTscn reads every character once', () => {
  /** Lines in the hostile files below. */
  const HOSTILE_LINE_COUNT = 20000;
  /** Generous bound for a linear scan of them; a quadratic one takes many seconds. */
  const SCAN_TIME_LIMIT_MS = 1000;

  it.each([
    ['a bracket that is no value', 'a = ('],
    ['a group that never closes', 'a = ['],
    ['a constructor that never closes', 'a = Vector2('],
  ])('scans a file of lines with %s in linear time', (_label, line) => {
    const text = `[gd_scene format=3]\n[node name="N" type="Node"]\n${`${line}\n`.repeat(HOSTILE_LINE_COUNT)}[node name="After" type="Node" parent="."]\n`;
    const startedAt = performance.now();
    const scan = scanTscn(text);
    expect(performance.now() - startedAt).toBeLessThan(SCAN_TIME_LIMIT_MS);
    expect(scan.malformed.length).toBeGreaterThan(0);
    // The section after the broken lines is still read.
    expect(scan.headers.map((h) => h.attrs.get('name'))).toEqual([undefined, 'N', 'After']);
  });
});

describe('collectSceneScripts on a scene with malformed statements', () => {
  it('scans the inline script the engine runs and marks what it could not take as written', () => {
    const dir = tmp.makeProject('scene-malformed-', 'config_version=5\n');
    const scenePath = join(dir, 'main.tscn');
    writeFileSync(
      scenePath,
      [
        '[gd_scene load_steps=2 format=3]',
        '',
        '[sub_resource type="Resource" id="pad"]',
        'metadata/a = 1 (',
        '= 0',
        '',
        '[sub_resource type="GDScript" id="evil"]',
        'script/source = "extends Node"',
        '',
        '[sub_resource type="Resource" id="pad2"]',
        ') = 0',
        '',
        '[node name="Root" type="Node"]',
        'script = SubResource("evil")',
        '',
      ].join('\n'),
    );
    const collected = collectSceneScripts(scenePath, dir);
    expect(collected.inlineScripts.map((s) => [s.id, s.source])).toEqual([
      ['evil', 'extends Node'],
    ]);
    expect(collected.unscanned.length).toBeGreaterThan(0);
    expect(collected.unscanned.every((item) => item.malformed === true)).toBe(true);
  });

  it('folds a long run of malformed statements into one count', () => {
    const dir = tmp.makeProject('scene-malformed-', 'config_version=5\n');
    const scenePath = join(dir, 'main.tscn');
    const brokenLines = 100;
    writeFileSync(
      scenePath,
      `[gd_scene format=3]\n[node name="N" type="Node"]\n${'a = "x" y\n'.repeat(brokenLines)}`,
    );
    const reasons = collectSceneScripts(scenePath, dir).unscanned.map((item) => item.reason);
    expect(reasons.length).toBeLessThan(brokenLines);
    expect(reasons.at(-1)).toMatch(/^\d+ more malformed statements$/);
  });
});

describe('collectSceneScripts across multi-line values', () => {
  it('finds a script declared after a dictionary that spans lines', () => {
    const dir = tmp.makeProject('scene-scripts-', 'config_version=5\n');
    const scenePath = join(dir, 'main.tscn');
    writeFileSync(
      scenePath,
      [
        '[gd_scene format=3]',
        '',
        '[sub_resource type="AnimationLibrary" id="AnimationLibrary_a"]',
        '_data = {',
        '&"idle": null',
        '}',
        '',
        '[ext_resource type="Script" path="res://late.gd" id="1_late"]',
        '',
        '[node name="Main" type="Node2D"]',
        '',
      ].join('\n'),
    );
    expect(collectSceneScripts(scenePath, dir).scripts).toEqual([join(dir, 'late.gd')]);
  });
});
