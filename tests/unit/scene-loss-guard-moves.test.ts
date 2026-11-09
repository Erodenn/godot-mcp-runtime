import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { handleMoveNodes } from '../../src/tools/node-tools.js';
import {
  diffSceneText,
  inPlaceSceneWrite,
  resolveIntentPaths,
  type SceneDiffOptions,
} from '../../src/utils/scene-loss-guard.js';
import { createFakeRunner } from '../helpers/fake-runner.js';
import { unwrap } from '../helpers/assertions.js';
import { useTmpDirs } from '../helpers/tmp.js';

const NO_FAILED_SCRIPTS: ReadonlySet<string> = new Set();
const KID_TEXTURE = 'res://icon.png';

function scene(...lines: string[]): string {
  return lines.join('\n') + '\n';
}

const HEADER = [
  '[gd_scene load_steps=2 format=3 uid="uid://moves"]',
  '',
  '[ext_resource type="Texture2D" path="res://icon.png" id="1_tex"]',
  '',
  '[node name="Main" type="Node2D"]',
];

/** A holds Kid (texture, group, a connection to the root) and Kid holds Grand; B is empty. */
const BEFORE = scene(
  ...HEADER,
  '',
  '[node name="A" type="Node2D" parent="."]',
  '',
  '[node name="Kid" type="Sprite2D" parent="A" groups=["hero"]]',
  'texture = ExtResource("1_tex")',
  'position = Vector2(3, 4)',
  '',
  '[node name="Grand" type="Node2D" parent="A/Kid"]',
  '',
  '[node name="B" type="Node2D" parent="."]',
  '',
  '[node name="Lost" type="Node2D" parent="."]',
  '',
  '[connection signal="ready" from="A/Kid" to="." method="_on_kid"]',
);

/** A reparented under B, nothing else changed. */
function afterMovingA(options: { grand?: boolean; texture?: boolean; connection?: boolean } = {}) {
  const { grand = true, texture = true, connection = true } = options;
  return scene(
    ...HEADER,
    '',
    '[node name="B" type="Node2D" parent="."]',
    '',
    '[node name="A" type="Node2D" parent="B"]',
    '',
    '[node name="Kid" type="Sprite2D" parent="B/A" groups=["hero"]]',
    ...(texture ? ['texture = ExtResource("1_tex")'] : []),
    'position = Vector2(3, 4)',
    ...(grand ? ['', '[node name="Grand" type="Node2D" parent="B/A/Kid"]'] : []),
    '',
    '[node name="Lost" type="Node2D" parent="."]',
    ...(connection
      ? ['', '[connection signal="ready" from="B/A/Kid" to="." method="_on_kid"]']
      : []),
  );
}

const MOVE_A_UNDER_B: SceneDiffOptions = {
  touchedNodes: [],
  deletedNodes: [],
  movedNodes: [{ from: 'root/A', to: 'root/B/A' }],
};

function report(after: string, intent: SceneDiffOptions): string[] {
  return diffSceneText(BEFORE, after, intent, NO_FAILED_SCRIPTS);
}

describe('diffSceneText: movedNodes', () => {
  it('reports nothing for a clean reparent of a subtree', () => {
    expect(report(afterMovingA(), MOVE_A_UNDER_B)).toEqual([]);
  });

  it('still reports the old place as gone when no move was declared', () => {
    expect(report(afterMovingA(), { touchedNodes: [], deletedNodes: [] })).toContain(
      'Node "root/A" is no longer in the file',
    );
  });

  it('reports a grandchild lost from inside the moved subtree under its new path', () => {
    expect(report(afterMovingA({ grand: false }), MOVE_A_UNDER_B)).toEqual([
      'Node "root/B/A/Kid/Grand" is no longer in the file',
    ]);
  });

  it('reports a reference lost from a moved child under its new path', () => {
    expect(report(afterMovingA({ texture: false }), MOVE_A_UNDER_B)).toEqual([
      `"root/B/A/Kid" lost texture (was ${KID_TEXTURE})`,
    ]);
  });

  it('reports a connection lost from inside the moved subtree under its new path', () => {
    expect(report(afterMovingA({ connection: false }), MOVE_A_UNDER_B)).toEqual([
      'The connection of signal ready from "root/B/A/Kid" to _on_kid on "root" is no longer in the file',
    ]);
  });

  it('reports a group lost from a moved child under its new path', () => {
    const noGroup = afterMovingA().replace(' groups=["hero"]', '');
    expect(report(noGroup, MOVE_A_UNDER_B)).toEqual([
      '"root/B/A/Kid" is no longer in the group(s) hero',
    ]);
  });

  it('does not report the child-order change a move implies', () => {
    const reordered = scene(
      ...HEADER,
      '',
      '[node name="Lost" type="Node2D" parent="."]',
      '',
      '[node name="B" type="Node2D" parent="."]',
      '',
      '[node name="A" type="Node2D" parent="B" index="0"]',
      '',
      '[node name="Kid" type="Sprite2D" parent="B/A" groups=["hero"]]',
      'texture = ExtResource("1_tex")',
      'position = Vector2(3, 4)',
      '',
      '[node name="Grand" type="Node2D" parent="B/A/Kid"]',
      '',
      '[connection signal="ready" from="B/A/Kid" to="." method="_on_kid"]',
    );
    expect(report(reordered, MOVE_A_UNDER_B)).toEqual([]);
  });

  it('maps a nested move once: a moved node whose ancestor also moved', () => {
    const movedTwice = scene(
      ...HEADER,
      '',
      '[node name="Kid" type="Sprite2D" parent="." groups=["hero"]]',
      'texture = ExtResource("1_tex")',
      'position = Vector2(3, 4)',
      '',
      '[node name="Grand" type="Node2D" parent="Kid"]',
      '',
      '[node name="B" type="Node2D" parent="."]',
      '',
      '[node name="A" type="Node2D" parent="B"]',
      '',
      '[node name="Lost" type="Node2D" parent="."]',
      '',
      '[connection signal="ready" from="Kid" to="." method="_on_kid"]',
    );
    const ancestorFirst: SceneDiffOptions = {
      touchedNodes: [],
      deletedNodes: [],
      movedNodes: [
        { from: 'root/A', to: 'root/B/A' },
        { from: 'root/B/A/Kid', to: 'root/Kid' },
      ],
    };
    const descendantFirst: SceneDiffOptions = {
      touchedNodes: [],
      deletedNodes: [],
      movedNodes: [
        { from: 'root/A/Kid', to: 'root/Kid' },
        { from: 'root/A', to: 'root/B/A' },
      ],
    };
    expect(report(movedTwice, ancestorFirst)).toEqual([]);
    expect(report(movedTwice, descendantFirst)).toEqual([]);

    const lostGrand = movedTwice.replace('\n[node name="Grand" type="Node2D" parent="Kid"]\n', '');
    expect(report(lostGrand, ancestorFirst)).toEqual([
      'Node "root/Kid/Grand" is no longer in the file',
    ]);
    expect(report(lostGrand, descendantFirst)).toEqual([
      'Node "root/Kid/Grand" is no longer in the file',
    ]);
  });

  it('still reports an unrelated deletion beside a move', () => {
    const withoutLost = afterMovingA().replace(
      '\n[node name="Lost" type="Node2D" parent="."]\n',
      '',
    );
    expect(report(withoutLost, MOVE_A_UNDER_B)).toEqual([
      'Node "root/Lost" is no longer in the file',
    ]);
  });

  it('honours a deletion declared beside a move, matched under the node own old path', () => {
    const withoutGrand = afterMovingA({ grand: false });
    const intent: SceneDiffOptions = {
      ...MOVE_A_UNDER_B,
      deletedNodes: ['root/A/Kid/Grand'],
    };
    expect(report(withoutGrand, intent)).toEqual([]);
  });

  it('leaves deletedNodes meaning what it meant: the old place exempt, the new place not compared', () => {
    const deletes: SceneDiffOptions = { touchedNodes: [], deletedNodes: ['root/A'] };
    expect(report(afterMovingA({ grand: false }), deletes)).toEqual([]);
  });

  it('ignores a move whose path cannot be resolved rather than guessing', () => {
    const unresolved: SceneDiffOptions = {
      touchedNodes: [],
      deletedNodes: [],
      movedNodes: [{ from: 'root/%Nope', to: 'root/B/Nope' }],
    };
    expect(report(afterMovingA(), unresolved)).toContain('Node "root/A" is no longer in the file');
  });
});

describe('resolveIntentPaths: movedNodes', () => {
  it('restates each move from the operation report and drops one that failed', () => {
    const [intent] = inPlaceSceneWrite('main.tscn', {
      movedNodes: [
        { from: '%A', to: 'root/B/A' },
        { from: 'root/C', to: 'root/B/C' },
      ],
    });
    const restated = resolveIntentPaths([intent!], {
      results: [
        { nodePath: '%A', resolvedNodePath: 'root/A', success: true, newNodePath: 'root/B/A' },
        { nodePath: 'root/C', resolvedNodePath: 'root/C', error: 'no' },
      ],
    });
    expect(restated[0]?.movedNodes).toEqual([{ from: 'root/A', to: 'root/B/A' }]);
  });
});

describe('handleMoveNodes: the loss guard', () => {
  const tmp = useTmpDirs();
  const SCENE = 'main.tscn';
  const MOVE_PAYLOAD = JSON.stringify({
    results: [
      {
        nodePath: 'root/A',
        resolvedNodePath: 'root/A',
        success: true,
        newNodePath: 'root/B/A',
        index: 0,
      },
    ],
  });

  async function moveAUnderB(savedText: string): Promise<string[]> {
    const projectPath = tmp.makeProject('move-guard-');
    writeFileSync(join(projectPath, SCENE), BEFORE, 'utf8');
    const fake = createFakeRunner({ stdout: MOVE_PAYLOAD });
    const runner = fake.asRunner;
    const answer = runner.executeOperation.bind(runner);
    runner.executeOperation = async (...args: Parameters<typeof runner.executeOperation>) => {
      writeFileSync(join(projectPath, SCENE), savedText, 'utf8');
      return answer(...args);
    };
    const result = await handleMoveNodes(runner, {
      projectPath,
      scenePath: SCENE,
      moves: [{ nodePath: 'root/A', newParentPath: 'root/B' }],
    });
    const payload = unwrap(result).structuredContent as Record<string, unknown>;
    expect(readFileSync(join(projectPath, SCENE), 'utf8')).toBe(savedText);
    return ((payload.warnings as string[] | undefined) ?? []).slice(1);
  }

  it('says nothing when a reparent keeps the whole subtree', async () => {
    expect(await moveAUnderB(afterMovingA())).toEqual([]);
  });

  it('reports a node lost from inside the reparented subtree', async () => {
    expect(await moveAUnderB(afterMovingA({ grand: false }))).toEqual([
      'Node "root/B/A/Kid/Grand" is no longer in the file',
    ]);
  });
});
