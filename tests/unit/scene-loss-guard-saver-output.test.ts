/** The "after" texts follow the 4.6 saver: no `load_steps`, a `unique_id` on every node, `parent` before `unique_id` before `instance`. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  batchSceneWrites,
  compareSceneText,
  diffSceneText,
  toolPathToFilePath,
  type SceneDiffOptions,
} from '../../src/utils/scene-loss-guard.js';
import { fileIdentityKey } from '../../src/utils/path-validation.js';
import { authoredFixtureProjectPath, fixtureProjectPath } from '../helpers/fixture-paths.js';
import { useTmpDirs } from '../helpers/tmp.js';

const NOTHING_ASKED: SceneDiffOptions = { touchedNodes: [], deletedNodes: [] };
const NO_FAILED_SCRIPTS: ReadonlySet<string> = new Set();
const RES_PREFIX = 'res://';

function scene(...lines: string[]): string {
  return lines.join('\n') + '\n';
}

function authored(name: string): string {
  return readFileSync(join(authoredFixtureProjectPath, name), 'utf8');
}

/** Reads another scene of the authored fixture project, as the guard does on disk. */
function readAuthored(resPath: string): string | null {
  try {
    return authored(resPath.slice(RES_PREFIX.length));
  } catch {
    return null;
  }
}

const AGAINST_AUTHORED: SceneDiffOptions = { ...NOTHING_ASKED, readScene: readAuthored };

describe('a healthy 4.6 save of a fixture scene loses nothing', () => {
  it('host.tscn after add_node, as Godot 4.6 wrote it', () => {
    const after = scene(
      '[gd_scene format=3 uid="uid://dmw7yey2g31wl"]',
      '',
      '[ext_resource type="PackedScene" uid="uid://76owar7af2bj" path="res://base_unit.tscn" id="1_base"]',
      '',
      '[node name="Host" type="Node2D" unique_id=1380053471]',
      '',
      '[node name="Unit" parent="." unique_id=783173003 instance=ExtResource("1_base")]',
      'position = Vector2(10, 10)',
      '',
      '[node name="X" type="Node2D" parent="." unique_id=1389430695]',
    );
    expect(
      diffSceneText(authored('host.tscn'), after, AGAINST_AUTHORED, NO_FAILED_SCRIPTS),
    ).toEqual([]);
  });

  it('player.tscn re-saved with renumbered ids and unique_id on every node', () => {
    const after = scene(
      '[gd_scene format=3 uid="uid://clomui4eibwiq"]',
      '',
      '[ext_resource type="Script" uid="uid://cp6gyxwwwr27j" path="res://player.gd" id="1_k3x9p"]',
      '',
      '[node name="Player" type="Node2D" unique_id=101]',
      'script = ExtResource("1_k3x9p")',
      'speed = 9.0',
      '',
      '[node name="Body" type="Sprite2D" parent="." unique_id=102]',
      'position = Vector2(3, 4)',
    );
    expect(
      diffSceneText(authored('player.tscn'), after, AGAINST_AUTHORED, NO_FAILED_SCRIPTS),
    ).toEqual([]);
  });

  it('derived_unit.tscn kept inherited, its override line and its added node', () => {
    const after = scene(
      '[gd_scene format=3 uid="uid://ud33laavt82f"]',
      '',
      '[ext_resource type="PackedScene" uid="uid://76owar7af2bj" path="res://base_unit.tscn" id="1_q1w2e"]',
      '',
      '[node name="Derived" unique_id=7 instance=ExtResource("1_q1w2e")]',
      '',
      '[node name="Arm" parent="." index="0" unique_id=8]',
      'position = Vector2(5, 6)',
      '',
      '[node name="Extra" type="Node2D" parent="." index="2" unique_id=9]',
    );
    expect(
      diffSceneText(authored('derived_unit.tscn'), after, AGAINST_AUTHORED, NO_FAILED_SCRIPTS),
    ).toEqual([]);
  });

  it('main.tscn of the minimal fixture with a node added', () => {
    const before = readFileSync(join(fixtureProjectPath, 'main.tscn'), 'utf8');
    const after = scene(
      '[gd_scene format=3]',
      '',
      '[node name="Main" type="Node2D" unique_id=1]',
      '',
      '[node name="Label" type="Label" parent="." unique_id=2]',
      'offset_right = 100.0',
      'offset_bottom = 23.0',
      'text = "fixture"',
      '',
      '[node name="Sprite2D" type="Sprite2D" parent="." unique_id=3]',
      'position = Vector2(50, 50)',
      '',
      '[node name="Added" type="Node2D" parent="." unique_id=4]',
    );
    expect(diffSceneText(before, after, NOTHING_ASKED, NO_FAILED_SCRIPTS)).toEqual([]);
  });

  it('still reports the instance of host.tscn flattened into a plain node', () => {
    const after = scene(
      '[gd_scene format=3 uid="uid://dmw7yey2g31wl"]',
      '',
      '[node name="Host" type="Node2D" unique_id=1380053471]',
      '',
      '[node name="Unit" type="Node2D" parent="." unique_id=783173003]',
      'position = Vector2(10, 10)',
    );
    expect(
      diffSceneText(authored('host.tscn'), after, AGAINST_AUTHORED, NO_FAILED_SCRIPTS),
    ).toEqual(['"root/Unit" no longer instances res://base_unit.tscn']);
  });
});

// The layout Godot 4 writes for an AnimationPlayer: every dictionary spans lines.
const ANIMATED = scene(
  '[gd_scene load_steps=5 format=3 uid="uid://anim"]',
  '',
  '[ext_resource type="AudioStream" path="res://step.ogg" id="3_x"]',
  '',
  '[sub_resource type="Animation" id="Animation_idle1"]',
  'resource_name = "idle"',
  'tracks/0/type = "audio"',
  'tracks/0/path = NodePath("Player")',
  'tracks/0/keys = {',
  '"clips": [{',
  '"end_offset": 0.0,',
  '"start_offset": 0.0,',
  '"stream": ExtResource("3_x")',
  '}],',
  '"times": PackedFloat32Array(0)',
  '}',
  '',
  '[sub_resource type="AnimationLibrary" id="AnimationLibrary_abc12"]',
  '_data = {',
  '&"idle": SubResource("Animation_idle1")',
  '}',
  '',
  '[node name="Main" type="Node2D"]',
  '',
  '[node name="Anim" type="AnimationPlayer" parent="."]',
  'libraries = {',
  '&"": SubResource("AnimationLibrary_abc12")',
  '}',
);

describe('values written across lines', () => {
  it('reports an animation library dropped from a libraries dictionary', () => {
    const after = ANIMATED.replace(
      'libraries = {\n&"": SubResource("AnimationLibrary_abc12")\n}\n',
      '',
    );
    expect(diffSceneText(ANIMATED, after, NOTHING_ASKED, NO_FAILED_SCRIPTS)).toEqual([
      '"root/Anim" lost libraries (was an inline AnimationLibrary)',
    ]);
  });

  it('reports a library left in place and emptied', () => {
    const after = ANIMATED.replace(
      '_data = {\n&"idle": SubResource("Animation_idle1")\n}',
      '_data = {}',
    );
    expect(diffSceneText(ANIMATED, after, NOTHING_ASKED, NO_FAILED_SCRIPTS)).toEqual([
      '"root/Anim" libraries lost _data (was an inline Animation)',
    ]);
  });

  it('reports a stream dropped from a track key dictionary two resources down', () => {
    const after = ANIMATED.replace('"stream": ExtResource("3_x")', '"stream": null');
    expect(diffSceneText(ANIMATED, after, NOTHING_ASKED, NO_FAILED_SCRIPTS)).toEqual([
      '"root/Anim" libraries._data lost tracks/0/keys (was res://step.ogg)',
    ]);
  });

  it('accepts the same scene with every id renumbered and CRLF line endings', () => {
    const after = ANIMATED.replace(/Animation_idle1/g, 'Animation_p0q1r')
      .replace(/AnimationLibrary_abc12/g, 'AnimationLibrary_zz9zz')
      .replace(/3_x/g, '1_m4n5o')
      .replace(/\n/g, '\r\n');
    expect(diffSceneText(ANIMATED, after, NOTHING_ASKED, NO_FAILED_SCRIPTS)).toEqual([]);
  });

  it('pairs several inline resources of one type whatever their order', () => {
    const before = scene(
      '[gd_scene format=3]',
      '',
      '[ext_resource type="AudioStream" path="res://step.ogg" id="1_s"]',
      '',
      '[sub_resource type="Animation" id="Animation_a"]',
      'tracks/0/keys = {',
      '"stream": ExtResource("1_s")',
      '}',
      '',
      '[sub_resource type="Animation" id="Animation_b"]',
      'length = 2.0',
      '',
      '[sub_resource type="AnimationLibrary" id="AnimationLibrary_l"]',
      '_data = {',
      '&"a": SubResource("Animation_a"),',
      '&"b": SubResource("Animation_b")',
      '}',
      '',
      '[node name="Anim" type="AnimationPlayer"]',
      'libraries = {',
      '&"": SubResource("AnimationLibrary_l")',
      '}',
    );
    const reordered = before.replace(
      '&"a": SubResource("Animation_a"),\n&"b": SubResource("Animation_b")',
      '&"b": SubResource("Animation_b"),\n&"a": SubResource("Animation_a")',
    );
    expect(diffSceneText(before, reordered, NOTHING_ASKED, NO_FAILED_SCRIPTS)).toEqual([]);
  });

  it('compares a dictionary override against the scene it overrides, whole', () => {
    const base = scene(
      '[gd_scene format=3]',
      '',
      '[node name="Unit" type="Node2D"]',
      'metadata/stats = {',
      '"hp": 1',
      '}',
    );
    const host = scene(
      '[gd_scene format=3]',
      '',
      '[ext_resource type="PackedScene" path="res://unit.tscn" id="1_u"]',
      '',
      '[node name="Host" type="Node2D"]',
      '',
      '[node name="Unit" parent="." instance=ExtResource("1_u")]',
      'metadata/stats = {',
      '"hp": 5',
      '}',
    );
    const after = host.replace('metadata/stats = {\n"hp": 5\n}\n', '');
    const intent: SceneDiffOptions = { ...NOTHING_ASKED, readScene: () => base };
    expect(diffSceneText(host, after, intent, NO_FAILED_SCRIPTS)).toEqual([
      '"root/Unit" lost its override of metadata/stats (was { "hp": 5 })',
    ]);
    // The same dictionary as the base scene holds is a redundant override.
    const redundant = host.replace('"hp": 5', '"hp": 1');
    expect(diffSceneText(redundant, after, intent, NO_FAILED_SCRIPTS)).toEqual([]);
  });
});

describe('node path spellings the tools accept', () => {
  const PLAYER = authored('player.tscn');
  const WITHOUT_BODY = PLAYER.replace(
    '\n[node name="Body" type="Sprite2D" parent="."]\nposition = Vector2(3, 4)\n',
    '',
  );
  const UNIQUE = PLAYER.replace(
    'position = Vector2(3, 4)',
    'unique_name_in_owner = true\nposition = Vector2(3, 4)\ntexture = ExtResource("1_abc")',
  );

  it.each(['./Body', 'root/./Body', 'Player/Body', 'root/Body', 'Body', 'Body/'])(
    'accepts a node deleted as %j',
    (nodePath) => {
      const intent: SceneDiffOptions = { touchedNodes: [], deletedNodes: [nodePath] };
      expect(diffSceneText(PLAYER, WITHOUT_BODY, intent, NO_FAILED_SCRIPTS)).toEqual([]);
    },
  );

  it.each([
    ['./A', 'A'],
    ['root/./A', 'A'],
    ['./A/./B', 'A/B'],
    ['./root/A', 'root/A'],
    ['root/.', '.'],
    ['./', '.'],
    ['%A', '%A'],
    ['root/%A', '%A'],
  ])('maps %j to %j', (toolPath, filePath) => {
    expect(toolPathToFilePath(toolPath, 'Main')).toBe(filePath);
  });

  it('resolves a %Name path against the node that stores the unique name', () => {
    const after = UNIQUE.replace('\ntexture = ExtResource("1_abc")', '');
    const untouched = diffSceneText(UNIQUE, after, NOTHING_ASKED, NO_FAILED_SCRIPTS);
    expect(untouched).toEqual(['"root/Body" lost texture (was res://player.gd)']);
    for (const nodePath of ['%Body', 'root/%Body']) {
      const intent: SceneDiffOptions = {
        ...NOTHING_ASKED,
        touchedProperties: [{ nodePath, property: 'texture' }],
      };
      expect(diffSceneText(UNIQUE, after, intent, NO_FAILED_SCRIPTS)).toEqual([]);
    }
  });

  it('does not let a resolved %Name exempt another node', () => {
    const after = UNIQUE.replace('script = ExtResource("1_abc")\nspeed = 9.0\n', '');
    const intent: SceneDiffOptions = { touchedNodes: ['%Body'], deletedNodes: [] };
    expect(diffSceneText(UNIQUE, after, intent, NO_FAILED_SCRIPTS)).toEqual([
      '"root" lost its script res://player.gd',
      '"root" lost stored values of res://player.gd: speed',
    ]);
  });

  it('treats a touched %Name the file cannot resolve as every node of that name', () => {
    // No section stores unique_name_in_owner (it can live in an instanced scene): any node called Body could be meant.
    const withTexture = PLAYER.replace(
      'position = Vector2(3, 4)',
      'position = Vector2(3, 4)\ntexture = ExtResource("1_abc")',
    );
    expect(diffSceneText(withTexture, PLAYER, NOTHING_ASKED, NO_FAILED_SCRIPTS)).toEqual([
      '"root/Body" lost texture (was res://player.gd)',
    ]);
    const intent: SceneDiffOptions = {
      ...NOTHING_ASKED,
      touchedProperties: [{ nodePath: '%Body', property: 'texture' }],
    };
    expect(diffSceneText(withTexture, PLAYER, intent, NO_FAILED_SCRIPTS)).toEqual([]);
  });

  it('never lets a %Name the file cannot resolve exempt a deleted subtree', () => {
    // A guess here would exempt every node called Body and everything below
    // each, so a Body the save lost would pass as the one that was deleted.
    for (const name of ['%Body', '%Elsewhere']) {
      const intent: SceneDiffOptions = { touchedNodes: [], deletedNodes: [name] };
      expect(diffSceneText(PLAYER, WITHOUT_BODY, intent, NO_FAILED_SCRIPTS)).toEqual([
        'Node "root/Body" is no longer in the file',
      ]);
    }
    // The path the operation reports for the node it deleted is exact.
    const resolved: SceneDiffOptions = { touchedNodes: [], deletedNodes: ['root/Body'] };
    expect(diffSceneText(PLAYER, WITHOUT_BODY, resolved, NO_FAILED_SCRIPTS)).toEqual([]);
  });
});

describe('placeholders and editable instances', () => {
  const PLACED = scene(
    '[gd_scene format=3]',
    '',
    '[ext_resource type="PackedScene" path="res://base_unit.tscn" id="1_base"]',
    '',
    '[node name="Host" type="Node2D"]',
    '',
    '[node name="Later" parent="." instance_placeholder="res://heavy.tscn"]',
    '',
    '[node name="Unit" parent="." instance=ExtResource("1_base")]',
    '',
    '[node name="Arm" parent="Unit" index="0"]',
    'position = Vector2(7, 7)',
    '',
    '[editable path="Unit"]',
  );

  it('reports a placeholder that became a plain node', () => {
    const after = PLACED.replace(
      '[node name="Later" parent="." instance_placeholder="res://heavy.tscn"]',
      '[node name="Later" type="Node2D" parent="."]',
    );
    expect(diffSceneText(PLACED, after, AGAINST_AUTHORED, NO_FAILED_SCRIPTS)).toEqual([
      '"root/Later" is no longer a placeholder for res://heavy.tscn',
    ]);
  });

  it('reports a vanished [editable] line', () => {
    const after = PLACED.replace('\n[editable path="Unit"]\n', '');
    expect(diffSceneText(PLACED, after, AGAINST_AUTHORED, NO_FAILED_SCRIPTS)).toEqual([
      '"root/Unit" is no longer marked editable: without its [editable] line the overrides of its children are not loaded',
    ]);
  });

  it('says nothing about the [editable] line of an instance deleted on purpose', () => {
    const after = scene(
      '[gd_scene format=3]',
      '',
      '[node name="Host" type="Node2D"]',
      '',
      '[node name="Later" parent="." instance_placeholder="res://heavy.tscn"]',
    );
    const intent: SceneDiffOptions = { ...AGAINST_AUTHORED, deletedNodes: ['root/Unit'] };
    expect(diffSceneText(PLACED, after, intent, NO_FAILED_SCRIPTS)).toEqual([]);
  });

  it('reports a lost instance once, not its [editable] line as well', () => {
    const after = scene(
      '[gd_scene format=3]',
      '',
      '[node name="Host" type="Node2D"]',
      '',
      '[node name="Later" parent="." instance_placeholder="res://heavy.tscn"]',
    );
    expect(diffSceneText(PLACED, after, AGAINST_AUTHORED, NO_FAILED_SCRIPTS)).toEqual([
      'Node "root/Unit" is no longer in the file',
    ]);
  });
});

describe('inline resources with a script that did not load', () => {
  const STATS = scene(
    '[gd_scene load_steps=3 format=3]',
    '',
    '[ext_resource type="Script" path="res://stats.gd" id="1_s"]',
    '',
    '[sub_resource type="Resource" id="Resource_abcde"]',
    'script = ExtResource("1_s")',
    'hp = 5',
    'armor = 2',
    '',
    '[node name="Main" type="Node2D"]',
    'metadata/stats = SubResource("Resource_abcde")',
  );
  const emptied = STATS.replace('hp = 5\narmor = 2\n', '');

  it('reports the plain values the resource stored', () => {
    expect(diffSceneText(STATS, emptied, NOTHING_ASKED, new Set(['res://stats.gd']))).toEqual([
      '"root" metadata/stats lost stored values of res://stats.gd: hp, armor',
    ]);
  });

  it('says nothing about them when the script loaded', () => {
    expect(diffSceneText(STATS, emptied, NOTHING_ASKED, NO_FAILED_SCRIPTS)).toEqual([]);
  });
});

describe('overrides whose base scene cannot be read as text', () => {
  const ON_GLB = scene(
    '[gd_scene load_steps=2 format=3]',
    '',
    '[ext_resource type="PackedScene" path="res://unit.glb" id="1_u"]',
    '',
    '[node name="Host" type="Node3D"]',
    '',
    '[node name="Unit" parent="." instance=ExtResource("1_u")]',
    'transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 2, 0, 0)',
    '',
    '[node name="Mesh" parent="Unit" index="0"]',
    'visible = false',
    'cast_shadow = 0',
  );

  it('counts the plain overrides that are gone in one line, per instance', () => {
    const after = ON_GLB.replace(
      'transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 2, 0, 0)\n',
      '',
    ).replace(
      '\n[node name="Mesh" parent="Unit" index="0"]\nvisible = false\ncast_shadow = 0\n',
      '',
    );
    const intent: SceneDiffOptions = { ...NOTHING_ASKED, readScene: () => null };
    expect(diffSceneText(ON_GLB, after, intent, NO_FAILED_SCRIPTS)).toEqual([
      '3 stored overrides under "root/Unit" are gone and could not be checked against res://unit.glb',
    ]);
  });

  it('adds nothing when every override is still there', () => {
    const after = ON_GLB.replace('[gd_scene load_steps=2 format=3]', '[gd_scene format=3]');
    const intent: SceneDiffOptions = { ...NOTHING_ASKED, readScene: () => null };
    expect(diffSceneText(ON_GLB, after, intent, NO_FAILED_SCRIPTS)).toEqual([]);
  });
});

describe('compareSceneText: what could not be compared', () => {
  const PLAYER = authored('player.tscn');

  it('reads a scene that starts with a byte order mark', () => {
    const after = PLAYER.replace('script = ExtResource("1_abc")\nspeed = 9.0\n', '');
    expect(compareSceneText(`﻿${PLAYER}`, after, NOTHING_ASKED, NO_FAILED_SCRIPTS)).toEqual({
      losses: [
        '"root" lost its script res://player.gd',
        '"root" lost stored values of res://player.gd: speed',
      ],
      notChecked: null,
    });
  });

  it('says which side is not a text scene', () => {
    const binary = 'RSRC\u0000\u0001';
    expect(compareSceneText(binary, PLAYER, NOTHING_ASKED, NO_FAILED_SCRIPTS)).toEqual({
      losses: [],
      notChecked: expect.stringMatching(/^the file as it was before the save is not a text scene/),
    });
    expect(compareSceneText(PLAYER, binary, NOTHING_ASKED, NO_FAILED_SCRIPTS)).toEqual({
      losses: [],
      notChecked: expect.stringMatching(/^the saved file is not a text scene/),
    });
  });
});

describe('batchSceneWrites: a save-as moves the baseline of its target', () => {
  const tmp = useTmpDirs();
  const EDIT_COPY = {
    operation: 'set_node_properties',
    scenePath: 'copy.tscn',
    updates: [{ nodePath: 'root/Icon', property: 'texture', value: 'res://b.png' }],
  };
  const EDIT_SOURCE = {
    operation: 'set_node_properties',
    scenePath: 'a.tscn',
    updates: [{ nodePath: 'root/N', property: 'position', value: { x: 1, y: 2 } }],
  };
  const SAVE_AS = { operation: 'save', scenePath: 'a.tscn', newPath: 'copy.tscn' };
  const ICON_TEXTURE = { nodePath: 'root/Icon', property: 'texture' };
  const N_POSITION = { nodePath: 'root/N', property: 'position' };

  function writesFor(operations: unknown[], results?: unknown): Record<string, unknown> {
    const writes = batchSceneWrites(operations, tmp.makeProject('batch-writes-'), results);
    return Object.fromEntries(
      writes.map((write) => [
        write.target,
        { source: write.source, touchedProperties: write.touchedProperties },
      ]),
    );
  }

  it('gives the copy the touches made on the source before it and on itself after it', () => {
    expect(writesFor([EDIT_SOURCE, SAVE_AS, EDIT_COPY])).toEqual({
      'a.tscn': { source: 'a.tscn', touchedProperties: [N_POSITION] },
      'copy.tscn': { source: 'a.tscn', touchedProperties: [N_POSITION, ICON_TEXTURE] },
    });
  });

  it('keeps touches made on the source after the save-as off the copy', () => {
    expect(writesFor([SAVE_AS, EDIT_SOURCE])).toEqual({
      'a.tscn': { source: 'a.tscn', touchedProperties: [N_POSITION] },
      'copy.tscn': { source: 'a.tscn', touchedProperties: [] },
    });
  });

  it('lets the save-as win over what the batch did to the target before it', () => {
    expect(writesFor([EDIT_COPY, SAVE_AS])).toEqual({
      'a.tscn': { source: 'a.tscn', touchedProperties: [] },
      'copy.tscn': { source: 'a.tscn', touchedProperties: [] },
    });
  });

  it('carries the baseline through a chain of copies', () => {
    const second = { operation: 'save', scene_path: 'copy.tscn', new_path: 'third.tscn' };
    expect(writesFor([SAVE_AS, EDIT_COPY, second])['third.tscn']).toEqual({
      source: 'a.tscn',
      touchedProperties: [ICON_TEXTURE],
    });
  });

  it('leaves the target on its own baseline when the results say the save-as failed', () => {
    const results = [{ error: 'Failed to save scene' }, { success: true }];
    expect(writesFor([SAVE_AS, EDIT_COPY], results)).toEqual({
      'a.tscn': { source: 'a.tscn', touchedProperties: [] },
      'copy.tscn': { source: 'copy.tscn', touchedProperties: [ICON_TEXTURE] },
    });
  });

  it('folds every spelling of one file into one intent', () => {
    const foldsCase = fileIdentityKey('/x/A') === fileIdentityKey('/x/a');
    const names = ['a.tscn', './a.tscn', 'res://a.tscn', ...(foldsCase ? ['A.tscn'] : [])];
    const spelled = names.map((scenePath) => ({ ...EDIT_SOURCE, scenePath }));
    const writes = batchSceneWrites(spelled, tmp.makeProject('batch-writes-'));
    expect(writes).toHaveLength(1);
    expect(writes[0]?.touchedProperties).toHaveLength(spelled.length);
  });

  it('keeps two case spellings apart where the file system is case-sensitive', () => {
    if (fileIdentityKey('/x/A') === fileIdentityKey('/x/a')) return;
    const spelled = ['a.tscn', 'A.tscn'].map((scenePath) => ({ ...EDIT_SOURCE, scenePath }));
    expect(batchSceneWrites(spelled, tmp.makeProject('batch-writes-'))).toHaveLength(2);
  });

  it('skips an item whose scene escapes the project', () => {
    const escaping = { ...EDIT_SOURCE, scenePath: '../outside.tscn' };
    expect(batchSceneWrites([escaping], tmp.makeProject('batch-writes-'))).toEqual([]);
  });
});
