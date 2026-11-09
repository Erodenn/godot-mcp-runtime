/** move_nodes against a copy of the authored fixture, asserted on the saved .tscn text. The scenes under test are written into the copy, so the committed fixture is never touched. A failing assertion whose message starts with "precondition:" means the case itself is wrong, not the code under test. */

import { describe, beforeAll, expect } from 'vitest';
import { cpSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { itGodot } from '../helpers/godot-skip.js';
import { dropProjectFeatureVersion, useTmpDirs } from '../helpers/tmp.js';
import { authoredFixtureProjectPath } from '../helpers/fixture-paths.js';
import { expectMatchesOutputSchema } from '../helpers/schema-assert.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { handleMoveNodes } from '../../src/tools/node-tools.js';

const CASE_TIMEOUT_MS = 120_000;
const PROJECT_DIR = 'project';
const TREE_SCENE = 'move_tree.tscn';
const PATHS_SCENE = 'move_paths.tscn';
const TABS_SCENE = 'move_tabs.tscn';
const LAST_INDEX = -1;
const ROOT_FILE_PATH = '.';

const TREE_SCENE_TEXT = `[gd_scene load_steps=2 format=3]

[ext_resource type="PackedScene" uid="uid://76owar7af2bj" path="res://base_unit.tscn" id="1_base"]

[node name="MoveHost" type="Node2D"]

[node name="Source" type="Node2D" parent="."]

[node name="Branch" type="Node2D" parent="Source"]
position = Vector2(3, 4)

[node name="Leaf" type="Sprite2D" parent="Source/Branch" groups=["movers"]]

[node name="Fruit" parent="Source/Branch" instance=ExtResource("1_base")]

[node name="Twin" type="Node2D" parent="Source"]

[node name="Target" type="Node2D" parent="."]

[node name="First" type="Node2D" parent="Target"]

[node name="Second" type="Node2D" parent="Target"]

[node name="Third" type="Node2D" parent="Target"]

[node name="Twin" type="Node2D" parent="Target"]

[connection signal="visibility_changed" from="Source/Branch/Leaf" to="Source/Twin" method="queue_redraw"]
`;

const PATHS_SCENE_TEXT = `[gd_scene format=3]

[node name="PathHost" type="Control"]

[node name="Pad" type="Control" parent="."]
focus_neighbor_right = NodePath("../Peer")

[node name="Peer" type="Control" parent="."]

[node name="Dest" type="Control" parent="."]
`;

const TABS_SCENE_TEXT = `[gd_scene format=3]

[node name="TabsHost" type="Control"]

[node name="Tabs" type="TabContainer" parent="."]

[node name="T0" type="Control" parent="Tabs"]

[node name="T1" type="Control" parent="Tabs"]

[node name="T2" type="Control" parent="Tabs"]

[node name="Loose" type="Control" parent="."]
`;

const tmp = useTmpDirs();

let runner: GodotRunner;

beforeAll(async () => {
  runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
  await runner.detectGodotPath();
});

function projectWithScenes(): string {
  const project = join(tmp.make('godot-mcp-move-'), PROJECT_DIR);
  cpSync(authoredFixtureProjectPath, project, { recursive: true });
  dropProjectFeatureVersion(project);
  writeFileSync(join(project, TREE_SCENE), TREE_SCENE_TEXT);
  writeFileSync(join(project, PATHS_SCENE), PATHS_SCENE_TEXT);
  writeFileSync(join(project, TABS_SCENE), TABS_SCENE_TEXT);
  return project;
}

function readScene(project: string, scene: string): string {
  return readFileSync(join(project, scene), 'utf8');
}

/** Every node line of a saved scene as its file-form path, in file order ("." for the root). */
function nodePaths(text: string): string[] {
  const paths: string[] = [];
  for (const line of text.split('\n')) {
    const match = /^\[node name="([^"]+)"(?: [^\]]*?parent="([^"]*)")?/.exec(line);
    if (!match) continue;
    const [, name, parent] = match;
    if (parent === undefined) paths.push(ROOT_FILE_PATH);
    else paths.push(parent === ROOT_FILE_PATH ? name! : `${parent}/${name}`);
  }
  return paths;
}

function resultsOf(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  return payload.results as Array<Record<string, unknown>>;
}

describe('move_nodes reparents a subtree', () => {
  itGodot(
    'keeps the children, their owners, groups, connections and an instance, and puts the node at the index',
    async () => {
      const project = projectWithScenes();
      const result = await handleMoveNodes(runner, {
        projectPath: project,
        scenePath: TREE_SCENE,
        moves: [{ nodePath: 'root/Source/Branch', newParentPath: 'root/Target', index: 1 }],
      });
      const payload = expectMatchesOutputSchema('move_nodes', result);
      expect(resultsOf(payload)).toEqual([
        {
          nodePath: 'root/Source/Branch',
          resolvedNodePath: 'root/Source/Branch',
          success: true,
          newNodePath: 'root/Target/Branch',
          index: 1,
        },
      ]);
      expect(payload.warnings).toBeUndefined();

      const text = readScene(project, TREE_SCENE);
      expect(nodePaths(text)).toEqual([
        ROOT_FILE_PATH,
        'Source',
        'Source/Twin',
        'Target',
        'Target/First',
        'Target/Branch',
        'Target/Branch/Leaf',
        'Target/Branch/Fruit',
        'Target/Second',
        'Target/Third',
        'Target/Twin',
      ]);
      expect(text).toContain('position = Vector2(3, 4)');
      expect(text).toMatch(
        /\[node name="Leaf" type="Sprite2D" parent="Target\/Branch"(?: unique_id=\d+)? groups=\["movers"\]/,
      );
      expect(text).toMatch(
        /\[node name="Fruit" parent="Target\/Branch"(?: unique_id=\d+)? instance=ExtResource\(/,
      );
      expect(text).toContain(
        '[connection signal="visibility_changed" from="Target/Branch/Leaf" to="Source/Twin" method="queue_redraw"]',
      );
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'moves an instance root as an instance, appended last when no index is given',
    async () => {
      const project = projectWithScenes();
      const result = await handleMoveNodes(runner, {
        projectPath: project,
        scenePath: TREE_SCENE,
        moves: [{ nodePath: 'root/Source/Branch/Fruit', newParentPath: 'root/Target' }],
      });
      const payload = expectMatchesOutputSchema('move_nodes', result);
      expect(resultsOf(payload)[0]).toMatchObject({
        success: true,
        newNodePath: 'root/Target/Fruit',
        index: 4,
      });

      const text = readScene(project, TREE_SCENE);
      const fruitLine = text.split('\n').find((line) => line.startsWith('[node name="Fruit"'));
      expect(fruitLine).toMatch(/parent="Target"(?: unique_id=\d+)? instance=ExtResource\(/);
      expect(fruitLine).not.toContain('type=');
      expect(nodePaths(text).at(-1)).toBe('Target/Fruit');
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'a new parent inside an instanced scene marks that instance editable',
    async () => {
      const project = projectWithScenes();
      const result = await handleMoveNodes(runner, {
        projectPath: project,
        scenePath: TREE_SCENE,
        moves: [{ nodePath: 'root/Target/First', newParentPath: 'root/Source/Branch/Fruit/Arm' }],
      });
      const payload = expectMatchesOutputSchema('move_nodes', result);
      expect(resultsOf(payload)[0]).toMatchObject({
        success: true,
        newNodePath: 'root/Source/Branch/Fruit/Arm/First',
      });

      const text = readScene(project, TREE_SCENE);
      expect(text).toContain('[node name="First" type="Node2D" parent="Source/Branch/Fruit/Arm"');
      expect(text).toContain('[editable path="Source/Branch/Fruit"]');
    },
    CASE_TIMEOUT_MS,
  );
});

describe('move_nodes reorders children', () => {
  itGodot(
    'puts a node at a given index and at the end, applying the moves in order',
    async () => {
      const project = projectWithScenes();
      const result = await handleMoveNodes(runner, {
        projectPath: project,
        scenePath: TREE_SCENE,
        moves: [
          { nodePath: 'root/Target/Third', index: 0 },
          { nodePath: 'root/Target/First', index: LAST_INDEX },
        ],
      });
      const payload = expectMatchesOutputSchema('move_nodes', result);
      expect(resultsOf(payload).map((entry) => [entry.success, entry.index])).toEqual([
        [true, 0],
        [true, 3],
      ]);
      expect(payload.warnings).toBeUndefined();

      expect(nodePaths(readScene(project, TREE_SCENE))).toEqual([
        ROOT_FILE_PATH,
        'Source',
        'Source/Branch',
        'Source/Branch/Leaf',
        'Source/Branch/Fruit',
        'Source/Twin',
        'Target',
        'Target/Third',
        'Target/Second',
        'Target/Twin',
        'Target/First',
      ]);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'leaves the file byte-identical when a node is already at the index',
    async () => {
      const project = projectWithScenes();
      const before = readScene(project, TREE_SCENE);
      const result = await handleMoveNodes(runner, {
        projectPath: project,
        scenePath: TREE_SCENE,
        moves: [{ nodePath: 'root/Target/First', index: 0 }],
      });
      const payload = expectMatchesOutputSchema('move_nodes', result);
      expect(resultsOf(payload)[0]).toMatchObject({ success: true, index: 0 });
      expect(readScene(project, TREE_SCENE)).toBe(before);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'counts the index among scene children under a parent with a front-internal child (a TabContainer)',
    async () => {
      const project = projectWithScenes();
      const result = await handleMoveNodes(runner, {
        projectPath: project,
        scenePath: TABS_SCENE,
        moves: [
          { nodePath: 'root/Tabs/T2', index: 0 },
          { nodePath: 'root/Loose', newParentPath: 'root/Tabs', index: 1 },
        ],
      });
      const payload = expectMatchesOutputSchema('move_nodes', result);
      expect(resultsOf(payload).map((entry) => [entry.success, entry.index])).toEqual([
        [true, 0],
        [true, 1],
      ]);
      expect(nodePaths(readScene(project, TABS_SCENE))).toEqual([
        ROOT_FILE_PATH,
        'Tabs',
        'Tabs/T2',
        'Tabs/Loose',
        'Tabs/T0',
        'Tabs/T1',
      ]);
    },
    CASE_TIMEOUT_MS,
  );
});

describe('move_nodes refusals', () => {
  itGodot(
    'refuses the root, a move under the node itself or its descendant, a taken name, a bad index, a missing node or parent, and an instanced inner node, each leaving the file byte-identical',
    async () => {
      const project = projectWithScenes();
      const before = readScene(project, TREE_SCENE);
      const result = await handleMoveNodes(runner, {
        projectPath: project,
        scenePath: TREE_SCENE,
        moves: [
          { nodePath: 'root', index: 0 },
          { nodePath: 'root/Source/Branch', newParentPath: 'root/Source/Branch/Leaf' },
          { nodePath: 'root/Target', newParentPath: 'root/Target' },
          { nodePath: 'root/Source/Twin', newParentPath: 'root/Target' },
          { nodePath: 'root/Target/First', index: 9 },
          { nodePath: 'root/Nope', index: 0 },
          { nodePath: 'root/Target/First', newParentPath: 'root/Nope' },
          { nodePath: 'root/Source/Branch/Fruit/Arm', newParentPath: 'root/Target' },
        ],
      });
      const payload = expectMatchesOutputSchema('move_nodes', result);
      const errors = resultsOf(payload).map((entry) => entry.error);
      expect(errors, 'precondition: one entry per move').toHaveLength(8);
      expect(errors[0]).toMatch(/Cannot move the root node/);
      expect(errors[1]).toMatch(/under itself or one of its own descendants/);
      expect(errors[2]).toMatch(/under itself or one of its own descendants/);
      expect(errors[3]).toMatch(/already has a child named 'Twin'/);
      expect(errors[4]).toMatch(/index 9 is outside 0\.\.3/);
      expect(errors[5]).toMatch(/Node not found/);
      expect(errors[6]).toMatch(/New parent not found/);
      expect(errors[7]).toMatch(/belongs to an instanced scene/);
      expect(resultsOf(payload).some((entry) => entry.success === true)).toBe(false);
      expect(readScene(project, TREE_SCENE)).toBe(before);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'a refused entry does not stop the entries after it',
    async () => {
      const project = projectWithScenes();
      const result = await handleMoveNodes(runner, {
        projectPath: project,
        scenePath: TREE_SCENE,
        moves: [
          { nodePath: 'root/Source/Twin', newParentPath: 'root/Target' },
          { nodePath: 'root/Target/Second', index: 0 },
        ],
      });
      const payload = expectMatchesOutputSchema('move_nodes', result);
      expect(resultsOf(payload)[0]?.error).toMatch(/already has a child/);
      expect(resultsOf(payload)[1]).toMatchObject({ success: true, index: 0 });
      expect(nodePaths(readScene(project, TREE_SCENE)).slice(-4)).toEqual([
        'Target/Second',
        'Target/First',
        'Target/Third',
        'Target/Twin',
      ]);
    },
    CASE_TIMEOUT_MS,
  );
});

describe('move_nodes and NodePath values', () => {
  itGodot(
    'warns when a stored relative NodePath no longer leads where it did, and does not rewrite it',
    async () => {
      const project = projectWithScenes();
      const result = await handleMoveNodes(runner, {
        projectPath: project,
        scenePath: PATHS_SCENE,
        moves: [{ nodePath: 'root/Peer', newParentPath: 'root/Dest' }],
      });
      const payload = expectMatchesOutputSchema('move_nodes', result);
      const warnings = payload.warnings as string[];
      expect(warnings, 'precondition: a warning was reported').toHaveLength(1);
      expect(warnings[0]).toContain('root/Pad.focus_neighbor_right');
      expect(warnings[0]).toContain("led to 'root/Peer' and now leads to no node");

      const text = readScene(project, PATHS_SCENE);
      expect(text).toContain('focus_neighbor_right = NodePath("../Peer")');
      expect(nodePaths(text)).toContain('Dest/Peer');
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'a reorder changes no path and reports no warning',
    async () => {
      const project = projectWithScenes();
      const result = await handleMoveNodes(runner, {
        projectPath: project,
        scenePath: PATHS_SCENE,
        moves: [{ nodePath: 'root/Pad', index: LAST_INDEX }],
      });
      const payload = expectMatchesOutputSchema('move_nodes', result);
      expect(payload.warnings).toBeUndefined();
      expect(nodePaths(readScene(project, PATHS_SCENE))).toEqual([
        ROOT_FILE_PATH,
        'Peer',
        'Dest',
        'Pad',
      ]);
    },
    CASE_TIMEOUT_MS,
  );
});
