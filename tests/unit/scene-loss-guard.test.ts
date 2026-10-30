import { describe, it, expect } from 'vitest';
import {
  batchSceneWrites,
  resolveIntentPaths,
  capLossItems,
  diffSceneText,
  failedScriptsIn,
  MAX_LOSS_ITEMS_PER_SCENE,
  toolPathToFilePath,
  updateTouches,
  type SceneDiffOptions,
} from '../../src/utils/scene-loss-guard.js';
import { useTmpDirs } from '../helpers/tmp.js';

const NOTHING_ASKED: SceneDiffOptions = { touchedNodes: [], deletedNodes: [] };
const NO_FAILED_SCRIPTS: ReadonlySet<string> = new Set();

function scene(...lines: string[]): string {
  return lines.join('\n') + '\n';
}

const SCRIPTED = scene(
  '[gd_scene load_steps=2 format=3 uid="uid://scene"]',
  '',
  '[ext_resource type="Script" uid="uid://script" path="res://player.gd" id="1_abc"]',
  '',
  '[node name="Player" type="Node2D"]',
  'script = ExtResource("1_abc")',
  'speed = 9.0',
  'hp = 3',
  '',
  '[node name="Body" type="Sprite2D" parent="."]',
  'position = Vector2(3, 4)',
);

describe('diffSceneText: scripts and their stored values', () => {
  it('reports a script that is no longer attached, and the values that went with it', () => {
    const after = scene(
      '[gd_scene format=3 uid="uid://scene"]',
      '',
      '[node name="Player" type="Node2D"]',
      '',
      '[node name="Body" type="Sprite2D" parent="."]',
      'position = Vector2(3, 4)',
    );
    expect(diffSceneText(SCRIPTED, after, NOTHING_ASKED, NO_FAILED_SCRIPTS)).toEqual([
      '"root" lost its script res://player.gd',
      '"root" lost stored values of res://player.gd: speed, hp',
    ]);
  });

  it('reports the stored values when the script is kept but failed to load', () => {
    const after = SCRIPTED.replace('speed = 9.0\nhp = 3\n', '');
    const items = diffSceneText(SCRIPTED, after, NOTHING_ASKED, new Set(['res://player.gd']));
    expect(items).toEqual(['"root" lost stored values of res://player.gd: speed, hp']);
  });

  it('says nothing about vanished plain values on a node whose script loaded', () => {
    // A value equal to a default is legitimately not written back.
    const after = SCRIPTED.replace('speed = 9.0\nhp = 3\n', '');
    expect(diffSceneText(SCRIPTED, after, NOTHING_ASKED, NO_FAILED_SCRIPTS)).toEqual([]);
  });

  it('leaves a value the operation assigned out of the stored-values item', () => {
    const after = SCRIPTED.replace('speed = 9.0\nhp = 3\n', '');
    const items = diffSceneText(
      SCRIPTED,
      after,
      { ...NOTHING_ASKED, touchedProperties: [{ nodePath: 'root', property: 'speed' }] },
      new Set(['res://player.gd']),
    );
    expect(items).toEqual(['"root" lost stored values of res://player.gd: hp']);
  });

  it('reads the failed scripts out of the engine stderr', () => {
    const stderr =
      'ERROR: Failed to load script "res://broken.gd" with error "Parse error".\n   at: load (x.cpp:1)';
    expect(Array.from(failedScriptsIn(stderr))).toEqual(['res://broken.gd']);
  });
});

describe('diffSceneText: what a healthy save changes', () => {
  it('ignores renumbered ids, load_steps, unique_id, added nodes and reordering', () => {
    const after = scene(
      '[gd_scene format=3 uid="uid://scene"]',
      '',
      '[ext_resource type="Script" uid="uid://script" path="res://player.gd" id="1_x7k2p"]',
      '',
      '[node name="Player" type="Node2D" unique_id=123456]',
      'script = ExtResource("1_x7k2p")',
      'hp = 3',
      'speed = 9.0',
      '',
      '[node name="Added" type="Node2D" parent="." unique_id=77]',
      '',
      '[node name="Body" type="Sprite2D" parent="." unique_id=99]',
      'position = Vector2(3, 4)',
    );
    expect(diffSceneText(SCRIPTED, after, NOTHING_ASKED, NO_FAILED_SCRIPTS)).toEqual([]);
  });

  it('reads a scene with CRLF line endings the same way', () => {
    const before = SCRIPTED.replace(/\n/g, '\r\n');
    expect(diffSceneText(before, SCRIPTED, NOTHING_ASKED, NO_FAILED_SCRIPTS)).toEqual([]);
  });

  it('answers nothing when either text is not a text scene', () => {
    expect(diffSceneText('RSRC binary', SCRIPTED, NOTHING_ASKED, NO_FAILED_SCRIPTS)).toEqual([]);
    expect(diffSceneText(SCRIPTED, '', NOTHING_ASKED, NO_FAILED_SCRIPTS)).toEqual([]);
  });
});

const TEXTURED = scene(
  '[gd_scene load_steps=3 format=3]',
  '',
  '[ext_resource type="Texture2D" path="res://a.png" id="1_a"]',
  '[ext_resource type="Texture2D" path="res://b.png" id="2_b"]',
  '',
  '[node name="Main" type="Node2D"]',
  '',
  '[node name="Icon" type="Sprite2D" parent="."]',
  'texture = ExtResource("1_a")',
  '',
  '[node name="Limb" type="Node2D" parent="Icon"]',
);

describe('diffSceneText: references', () => {
  const replaced = TEXTURED.replace('texture = ExtResource("1_a")', 'texture = ExtResource("2_b")');

  it('reports a reference replaced on a node the operation did not touch', () => {
    expect(diffSceneText(TEXTURED, replaced, NOTHING_ASKED, NO_FAILED_SCRIPTS)).toEqual([
      '"root/Icon" lost texture (was res://a.png)',
    ]);
  });

  it('accepts the replacement when the operation assigned that property', () => {
    const intent: SceneDiffOptions = {
      ...NOTHING_ASKED,
      touchedProperties: [{ nodePath: 'root/Icon', property: 'texture' }],
    };
    expect(diffSceneText(TEXTURED, replaced, intent, NO_FAILED_SCRIPTS)).toEqual([]);
  });

  it('accepts anything on a node touched as a whole', () => {
    const intent: SceneDiffOptions = { touchedNodes: ['Main/Icon'], deletedNodes: [] };
    expect(diffSceneText(TEXTURED, replaced, intent, NO_FAILED_SCRIPTS)).toEqual([]);
  });

  it('still reports a dropped reference on a node touched through another property', () => {
    const dropped = TEXTURED.replace(
      'texture = ExtResource("1_a")\n',
      'position = Vector2(1, 1)\n',
    );
    const intent: SceneDiffOptions = {
      ...NOTHING_ASKED,
      touchedProperties: [{ nodePath: 'root/Icon', property: 'position' }],
    };
    expect(diffSceneText(TEXTURED, dropped, intent, NO_FAILED_SCRIPTS)).toEqual([
      '"root/Icon" lost texture (was res://a.png)',
    ]);
  });

  it('reports a reference inside an array value', () => {
    const before = TEXTURED.replace(
      'texture = ExtResource("1_a")',
      'frames = [ExtResource("1_a"), ExtResource("2_b")]',
    );
    const after = before.replace(
      '[ExtResource("1_a"), ExtResource("2_b")]',
      '[ExtResource("2_b")]',
    );
    expect(diffSceneText(before, after, NOTHING_ASKED, NO_FAILED_SCRIPTS)).toEqual([
      '"root/Icon" lost frames (was res://a.png)',
    ]);
  });

  it('reports an inline resource that is gone, by its type', () => {
    const before = scene(
      '[gd_scene load_steps=2 format=3]',
      '',
      '[sub_resource type="RectangleShape2D" id="RectangleShape2D_abcde"]',
      'size = Vector2(4, 4)',
      '',
      '[node name="Main" type="Node2D"]',
      '',
      '[node name="Shape" type="CollisionShape2D" parent="."]',
      'shape = SubResource("RectangleShape2D_abcde")',
    );
    const after = scene(
      '[gd_scene format=3]',
      '',
      '[node name="Main" type="Node2D"]',
      '',
      '[node name="Shape" type="CollisionShape2D" parent="."]',
    );
    expect(diffSceneText(before, after, NOTHING_ASKED, NO_FAILED_SCRIPTS)).toEqual([
      '"root/Shape" lost shape (was an inline RectangleShape2D)',
    ]);
  });

  it('follows an inline resource to a reference it lost, across a renumbered id', () => {
    const before = scene(
      '[gd_scene load_steps=3 format=3]',
      '',
      '[ext_resource type="Shader" path="res://glow.gdshader" id="1_s"]',
      '',
      '[sub_resource type="ShaderMaterial" id="ShaderMaterial_aaaaa"]',
      'shader = ExtResource("1_s")',
      '',
      '[node name="Main" type="Sprite2D"]',
      'material = SubResource("ShaderMaterial_aaaaa")',
    );
    const kept = before.replace(/ShaderMaterial_aaaaa/g, 'ShaderMaterial_zzzzz');
    expect(diffSceneText(before, kept, NOTHING_ASKED, NO_FAILED_SCRIPTS)).toEqual([]);
    const lost = kept.replace('shader = ExtResource("1_s")\n', '');
    expect(diffSceneText(before, lost, NOTHING_ASKED, NO_FAILED_SCRIPTS)).toEqual([
      '"root" material lost shader (was res://glow.gdshader)',
    ]);
  });
});

describe('diffSceneText: nodes that are gone', () => {
  const withoutIcon = scene(
    '[gd_scene load_steps=3 format=3]',
    '',
    '[node name="Main" type="Node2D"]',
  );

  it('reports a node that is no longer in the file, once for its subtree root', () => {
    expect(diffSceneText(TEXTURED, withoutIcon, NOTHING_ASKED, NO_FAILED_SCRIPTS)).toEqual([
      'Node "root/Icon" is no longer in the file',
    ]);
  });

  it('accepts a deleted subtree', () => {
    const intent: SceneDiffOptions = { touchedNodes: [], deletedNodes: ['root/Icon'] };
    expect(diffSceneText(TEXTURED, withoutIcon, intent, NO_FAILED_SCRIPTS)).toEqual([]);
  });

  it('does not treat a sibling with the deleted name as a prefix as deleted', () => {
    const before = TEXTURED + '\n[node name="Icon2" type="Node2D" parent="."]\n';
    const intent: SceneDiffOptions = { touchedNodes: [], deletedNodes: ['root/Icon'] };
    expect(diffSceneText(before, withoutIcon, intent, NO_FAILED_SCRIPTS)).toEqual([
      'Node "root/Icon2" is no longer in the file',
    ]);
  });
});

const BASE = scene(
  '[gd_scene format=3 uid="uid://base"]',
  '',
  '[node name="Base" type="Node2D"]',
  '',
  '[node name="Arm" type="Sprite2D" parent="."]',
  'position = Vector2(1, 2)',
  'modulate = Color(1, 0, 0, 1)',
);
const readBase = (resPath: string): string | null => (resPath === 'res://base.tscn' ? BASE : null);

const DERIVED = scene(
  '[gd_scene load_steps=2 format=3 uid="uid://derived"]',
  '',
  '[ext_resource type="PackedScene" uid="uid://base" path="res://base.tscn" id="1_base"]',
  '',
  '[node name="Derived" instance=ExtResource("1_base")]',
  '',
  '[node name="Arm" parent="." index="0"]',
  'position = Vector2(5, 6)',
  '',
  '[node name="Extra" type="Node2D" parent="." index="1"]',
);

describe('diffSceneText: inherited scenes and instances', () => {
  it('reports a scene that is no longer inherited', () => {
    const flattened = scene(
      '[gd_scene format=3 uid="uid://derived"]',
      '',
      '[node name="Derived" type="Node2D"]',
      '',
      '[node name="Arm" type="Sprite2D" parent="."]',
      'position = Vector2(5, 6)',
      'modulate = Color(1, 0, 0, 1)',
      '',
      '[node name="Extra" type="Node2D" parent="."]',
    );
    expect(diffSceneText(DERIVED, flattened, NOTHING_ASKED, NO_FAILED_SCRIPTS)).toEqual([
      'The scene is no longer inherited from res://base.tscn',
    ]);
  });

  it('reports an override line that vanished when the base scene holds another value', () => {
    const after = DERIVED.replace(
      '[node name="Arm" parent="." index="0"]\nposition = Vector2(5, 6)\n\n',
      '',
    );
    const intent: SceneDiffOptions = { ...NOTHING_ASKED, readScene: readBase };
    expect(diffSceneText(DERIVED, after, intent, NO_FAILED_SCRIPTS)).toEqual([
      '"root/Arm" lost its override of position (was Vector2(5, 6))',
    ]);
  });

  it('accepts an override line that vanished because it repeated the base scene', () => {
    const pinned = DERIVED.replace(
      'position = Vector2(5, 6)',
      'position = Vector2(1, 2)\nmodulate = Color(1, 0, 0, 1)',
    );
    const after = pinned.replace(
      '[node name="Arm" parent="." index="0"]\nposition = Vector2(1, 2)\nmodulate = Color(1, 0, 0, 1)\n\n',
      '',
    );
    const intent: SceneDiffOptions = { ...NOTHING_ASKED, readScene: readBase };
    expect(diffSceneText(pinned, after, intent, NO_FAILED_SCRIPTS)).toEqual([]);
  });

  it('accepts a single redundant key dropped from an override line that stays', () => {
    const pinned = DERIVED.replace(
      'position = Vector2(5, 6)',
      'position = Vector2(5, 6)\nmodulate = Color(1, 0, 0, 1)',
    );
    const intent: SceneDiffOptions = { ...NOTHING_ASKED, readScene: readBase };
    expect(diffSceneText(pinned, DERIVED, intent, NO_FAILED_SCRIPTS)).toEqual([]);
  });

  it('counts a vanished plain override, without judging it, when the base scene cannot be read', () => {
    const after = DERIVED.replace(
      '[node name="Arm" parent="." index="0"]\nposition = Vector2(5, 6)\n\n',
      '',
    );
    expect(diffSceneText(DERIVED, after, NOTHING_ASKED, NO_FAILED_SCRIPTS)).toEqual([
      '1 stored override under "root" is gone and could not be checked against res://base.tscn',
    ]);
  });

  it('accepts an override line removed by assigning the property it held', () => {
    const after = DERIVED.replace(
      '[node name="Arm" parent="." index="0"]\nposition = Vector2(5, 6)\n\n',
      '',
    );
    const intent: SceneDiffOptions = {
      ...NOTHING_ASKED,
      readScene: readBase,
      touchedProperties: [{ nodePath: 'root/Arm', property: 'position' }],
    };
    expect(diffSceneText(DERIVED, after, intent, NO_FAILED_SCRIPTS)).toEqual([]);
  });

  const HOST = scene(
    '[gd_scene load_steps=2 format=3]',
    '',
    '[ext_resource type="PackedScene" path="res://base.tscn" id="1_base"]',
    '',
    '[node name="Host" type="Node2D"]',
    '',
    '[node name="Unit" parent="." instance=ExtResource("1_base")]',
    'position = Vector2(10, 10)',
    '',
    '[node name="Arm" parent="Unit" index="0"]',
    'position = Vector2(7, 7)',
    '',
    '[editable path="Unit"]',
  );

  it('reports an instance that became a plain node, without listing the lines under it', () => {
    const after = scene(
      '[gd_scene format=3]',
      '',
      '[node name="Host" type="Node2D"]',
      '',
      '[node name="Unit" type="Node2D" parent="."]',
      'position = Vector2(10, 10)',
    );
    expect(
      diffSceneText(HOST, after, { ...NOTHING_ASKED, readScene: readBase }, NO_FAILED_SCRIPTS),
    ).toEqual(['"root/Unit" no longer instances res://base.tscn']);
  });

  it('reports an override on an instance root that vanished', () => {
    const after = HOST.replace('position = Vector2(10, 10)\n', '');
    expect(
      diffSceneText(HOST, after, { ...NOTHING_ASKED, readScene: readBase }, NO_FAILED_SCRIPTS),
    ).toEqual(['"root/Unit" lost its override of position (was Vector2(10, 10))']);
  });

  it('accepts a redundant type= beside instance= being removed', () => {
    const before = HOST.replace(
      '[node name="Unit" parent="."',
      '[node name="Unit" type="Node2D" parent="."',
    );
    expect(
      diffSceneText(before, HOST, { ...NOTHING_ASKED, readScene: readBase }, NO_FAILED_SCRIPTS),
    ).toEqual([]);
  });
});

describe('diffSceneText: uids, groups and connections', () => {
  it('reports a lost scene uid, and not when the comparison is a save-as', () => {
    const after = SCRIPTED.replace(' uid="uid://scene"', '');
    expect(diffSceneText(SCRIPTED, after, NOTHING_ASKED, NO_FAILED_SCRIPTS)).toEqual([
      'The scene lost its uid uid://scene',
    ]);
    const saveAs: SceneDiffOptions = { ...NOTHING_ASKED, compareSceneUid: false };
    expect(diffSceneText(SCRIPTED, after, saveAs, NO_FAILED_SCRIPTS)).toEqual([]);
  });

  it('reports a reference that lost its uid', () => {
    const after = SCRIPTED.replace(' uid="uid://script"', '');
    expect(diffSceneText(SCRIPTED, after, NOTHING_ASKED, NO_FAILED_SCRIPTS)).toEqual([
      'The reference to res://player.gd lost its uid uid://script',
    ]);
  });

  const WIRED = scene(
    '[gd_scene format=3]',
    '',
    '[node name="Main" type="Node2D"]',
    '',
    '[node name="Button" type="Button" parent="." groups=["ui", "hud"]]',
    '',
    '[connection signal="pressed" from="Button" to="." method="_on_pressed"]',
  );

  it('reports a group a node is no longer in', () => {
    const after = WIRED.replace('groups=["ui", "hud"]', 'groups=["ui"]');
    expect(diffSceneText(WIRED, after, NOTHING_ASKED, NO_FAILED_SCRIPTS)).toEqual([
      '"root/Button" is no longer in the group(s) hud',
    ]);
  });

  const unwired = WIRED.replace(
    '[connection signal="pressed" from="Button" to="." method="_on_pressed"]\n',
    '',
  );

  it('reports a connection that is no longer in the file', () => {
    expect(diffSceneText(WIRED, unwired, NOTHING_ASKED, NO_FAILED_SCRIPTS)).toEqual([
      'The connection of signal pressed from "root/Button" to _on_pressed on "root" is no longer in the file',
    ]);
  });

  it('accepts a connection the operation removed', () => {
    const intent: SceneDiffOptions = {
      ...NOTHING_ASKED,
      removedConnections: [
        { signal: 'pressed', from: 'root/Button', to: 'root', method: '_on_pressed' },
      ],
    };
    expect(diffSceneText(WIRED, unwired, intent, NO_FAILED_SCRIPTS)).toEqual([]);
  });

  it('accepts a connection that went with a deleted node', () => {
    const after = scene('[gd_scene format=3]', '', '[node name="Main" type="Node2D"]');
    const intent: SceneDiffOptions = { touchedNodes: [], deletedNodes: ['root/Button'] };
    expect(diffSceneText(WIRED, after, intent, NO_FAILED_SCRIPTS)).toEqual([]);
  });
});

describe('capLossItems', () => {
  it('returns a short list unchanged', () => {
    expect(capLossItems(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('folds everything past the cap into one tail entry', () => {
    const extra = 3;
    const items = Array.from({ length: MAX_LOSS_ITEMS_PER_SCENE + extra }, (_, i) => `item ${i}`);
    const capped = capLossItems(items);
    expect(capped).toHaveLength(MAX_LOSS_ITEMS_PER_SCENE + 1);
    expect(capped[MAX_LOSS_ITEMS_PER_SCENE]).toBe(`+${extra} more`);
    expect(capped.slice(0, MAX_LOSS_ITEMS_PER_SCENE)).toEqual(
      items.slice(0, MAX_LOSS_ITEMS_PER_SCENE),
    );
  });
});

describe('toolPathToFilePath', () => {
  it.each([
    ['root/A', 'A'],
    ['Main/A', 'A'],
    ['A', 'A'],
    ['root', '.'],
    ['Main', '.'],
    ['', '.'],
    ['.', '.'],
    ['root/A/B', 'A/B'],
    ['A/B', 'A/B'],
  ])('maps %j to %j', (toolPath, filePath) => {
    expect(toolPathToFilePath(toolPath, 'Main')).toBe(filePath);
  });
});

describe('updateTouches', () => {
  it('touches one property per update, and the whole node for a script assignment', () => {
    expect(
      updateTouches([
        { nodePath: 'root/A', property: 'position', value: 1 },
        { node_path: 'root/B', property: 'script', value: 'res://x.gd' },
        'not an update',
        { nodePath: 'root/C' },
      ]),
    ).toEqual({
      touchedNodes: ['root/B'],
      touchedProperties: [{ nodePath: 'root/A', property: 'position' }],
    });
  });
});

describe('resolveIntentPaths', () => {
  const intents = [
    {
      source: 'a.tscn',
      target: 'a.tscn',
      touchedNodes: ['%Hat'],
      deletedNodes: ['%Enemy', '%Gone', 'root/Plain'],
      touchedProperties: [{ nodePath: '%Enemy', property: 'position' }],
    },
  ];

  it('replaces each node path by the node the operation says it led to', () => {
    const restated = resolveIntentPaths(intents, {
      results: [
        { nodePath: '%Enemy', resolvedNodePath: 'root/Squad/Enemy', success: true },
        { nodePath: '%Hat', resolvedNodePath: 'root/Squad/Enemy/Hat', success: true },
        { nodePath: 'root/Plain', resolvedNodePath: 'root/Plain', success: true },
        { nodePath: '%Gone', error: 'Node not found: %Gone' },
      ],
    });
    expect(restated).toEqual([
      {
        source: 'a.tscn',
        target: 'a.tscn',
        touchedNodes: ['root/Squad/Enemy/Hat'],
        // %Gone was not deleted, so it exempts nothing.
        deletedNodes: ['root/Squad/Enemy', 'root/Plain'],
        touchedProperties: [{ nodePath: 'root/Squad/Enemy', property: 'position' }],
      },
    ]);
  });

  it('keeps a deletion the report does not mention, and every intent when there is no report', () => {
    expect(resolveIntentPaths(intents, { results: [] })[0]?.deletedNodes).toEqual([
      '%Enemy',
      '%Gone',
      'root/Plain',
    ]);
    expect(resolveIntentPaths(intents, { nodeName: 'N' })).toBe(intents);
  });
});

describe('batchSceneWrites', () => {
  const tmp = useTmpDirs();

  it('names the node each update led to once the batch has reported', () => {
    const operations = [
      {
        operation: 'set_node_properties',
        scenePath: 'a.tscn',
        updates: [
          { nodePath: '%Enemy', property: 'position', value: { x: 1, y: 2 } },
          { nodePath: '%Enemy', property: 'script', value: 'res://e.gd' },
        ],
      },
    ];
    const projectPath = tmp.makeProject('batch-writes-');
    const results = [
      {
        operation: 'set_node_properties',
        success: true,
        updates: [
          { nodePath: '%Enemy', resolvedNodePath: 'root/Squad/Enemy', success: true },
          { nodePath: '%Enemy', resolvedNodePath: 'root/Squad/Enemy', success: true },
        ],
      },
    ];
    expect(batchSceneWrites(operations, projectPath)[0]).toMatchObject({
      touchedNodes: ['%Enemy'],
      touchedProperties: [{ nodePath: '%Enemy', property: 'position' }],
    });
    expect(batchSceneWrites(operations, projectPath, results)[0]).toMatchObject({
      touchedNodes: ['root/Squad/Enemy'],
      touchedProperties: [{ nodePath: 'root/Squad/Enemy', property: 'position' }],
    });
  });

  it('builds one intent per scene file, reading both key spellings', () => {
    const writes = batchSceneWrites(
      [
        { operation: 'add_node', scenePath: 'a.tscn', nodeType: 'Node2D', nodeName: 'N' },
        {
          operation: 'set_node_properties',
          scene_path: 'a.tscn',
          updates: [{ node_path: 'root/N', property: 'position', value: { x: 1, y: 2 } }],
        },
        { operation: 'save', scenePath: 'a.tscn', new_path: 'copy.tscn' },
        { operation: 'load_sprite', scenePath: 'b.tscn', nodePath: 'root/S', texturePath: 'x.png' },
        'not an item',
        { operation: 'add_node' },
      ],
      tmp.makeProject('batch-writes-'),
    );
    const untouched = { touchedNodes: [], deletedNodes: [], removedConnections: [] };
    expect(writes).toEqual([
      {
        ...untouched,
        source: 'a.tscn',
        target: 'a.tscn',
        touchedProperties: [{ nodePath: 'root/N', property: 'position' }],
      },
      {
        ...untouched,
        source: 'a.tscn',
        target: 'copy.tscn',
        touchedProperties: [{ nodePath: 'root/N', property: 'position' }],
      },
      {
        ...untouched,
        source: 'b.tscn',
        target: 'b.tscn',
        touchedProperties: [{ nodePath: 'root/S', property: 'texture' }],
      },
    ]);
  });
});

describe('diffSceneText: a reference the engine re-resolved by uid', () => {
  const TEXTURE_BEFORE = scene(
    '[gd_scene load_steps=2 format=3 uid="uid://scene"]',
    '',
    '[ext_resource type="Texture2D" uid="uid://tex" path="res://old/tex.png" id="1"]',
    '',
    '[node name="Root" type="Node2D"]',
    '',
    '[node name="Sprite" type="Sprite2D" parent="."]',
    'texture = ExtResource("1")',
  );
  const INSTANCE_BEFORE = scene(
    '[gd_scene load_steps=2 format=3 uid="uid://scene"]',
    '',
    '[ext_resource type="PackedScene" uid="uid://enemy" path="res://old/enemy.tscn" id="1"]',
    '',
    '[node name="Root" type="Node2D"]',
    '',
    '[node name="Enemy" parent="." instance=ExtResource("1")]',
  );

  it('does not report a stale path the save rewrote to the current one for the same uid', () => {
    const after = TEXTURE_BEFORE.replace('res://old/tex.png', 'res://art/tex.png');
    expect(diffSceneText(TEXTURE_BEFORE, after, NOTHING_ASKED, NO_FAILED_SCRIPTS)).toEqual([]);
  });

  it('does not report an instanced scene whose path changed under the same uid', () => {
    const after = INSTANCE_BEFORE.replace('res://old/enemy.tscn', 'res://actors/enemy.tscn');
    expect(diffSceneText(INSTANCE_BEFORE, after, NOTHING_ASKED, NO_FAILED_SCRIPTS)).toEqual([]);
  });

  it('still reports the texture when the uid changed with the path', () => {
    const after = TEXTURE_BEFORE.replace('res://old/tex.png', 'res://art/tex.png').replace(
      'uid://tex',
      'uid://other',
    );
    expect(diffSceneText(TEXTURE_BEFORE, after, NOTHING_ASKED, NO_FAILED_SCRIPTS)).toEqual([
      '"root/Sprite" lost texture (was res://old/tex.png)',
    ]);
  });

  it('still reports the instance when the uid changed with the path', () => {
    const after = INSTANCE_BEFORE.replace(
      'res://old/enemy.tscn',
      'res://actors/enemy.tscn',
    ).replace('uid://enemy', 'uid://other');
    expect(diffSceneText(INSTANCE_BEFORE, after, NOTHING_ASKED, NO_FAILED_SCRIPTS)).toEqual([
      '"root/Enemy" no longer instances res://old/enemy.tscn',
    ]);
  });

  it('still reports a path change when only one side carries a uid', () => {
    const after = INSTANCE_BEFORE.replace(
      'res://old/enemy.tscn',
      'res://actors/enemy.tscn',
    ).replace(' uid="uid://enemy"', '');
    expect(diffSceneText(INSTANCE_BEFORE, after, NOTHING_ASKED, NO_FAILED_SCRIPTS)).toEqual([
      '"root/Enemy" no longer instances res://old/enemy.tscn',
    ]);
  });
});
