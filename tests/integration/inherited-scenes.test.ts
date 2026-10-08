// Scenes load with an edit state, as the editor does, so PackedScene.pack can tell an override from an inherited value.
// Every assertion reads the .tscn text from disk.

import { describe, beforeAll, beforeEach, afterAll, expect } from 'vitest';
import { cpSync, readFileSync } from 'fs';
import { removeTmpDir } from '../helpers/tmp.js';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { itGodot } from '../helpers/godot-skip.js';
import { authoredFixtureProjectPath } from '../helpers/fixture-paths.js';
import { expectMatchesOutputSchema } from '../helpers/schema-assert.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { handleAddNode } from '../../src/tools/scene-tools.js';
import {
  handleDeleteNodes,
  handleGetSceneTree,
  handleSetNodeProperties,
} from '../../src/tools/node-tools.js';

const DERIVED_SCENE = 'derived_unit.tscn';
const HOST_SCENE = 'host.tscn';
const CASE_TIMEOUT_MS = 120000;

let runner: GodotRunner;
let projectPath: string;
const tmpDirs: string[] = [];

beforeAll(async () => {
  runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
  await runner.detectGodotPath();
});

beforeEach(() => {
  projectPath = join(tmpdir(), `godot-mcp-inherit-${randomBytes(6).toString('hex')}`);
  cpSync(authoredFixtureProjectPath, projectPath, { recursive: true });
  tmpDirs.push(projectPath);
});

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      removeTmpDir(dir);
    } catch {}
  }
});

function sceneText(scene: string): string {
  return readFileSync(join(projectPath, scene), 'utf8');
}

function sectionProperties(text: string, headerPrefix: string): string[] | null {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith(headerPrefix));
  if (start === -1) return null;
  const properties: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || line.startsWith('[')) break;
    properties.push(line);
  }
  return properties;
}

describe('an inherited scene stays inherited through a mutation', () => {
  itGodot(
    'set_node_properties on an inherited node writes only that override',
    async () => {
      const result = await handleSetNodeProperties(runner, {
        projectPath,
        scenePath: DERIVED_SCENE,
        updates: [{ nodePath: 'root/Leg', property: 'text', value: 'changed' }],
      });
      expectMatchesOutputSchema('set_node_properties', result);

      const text = sceneText(DERIVED_SCENE);
      const rootLine = text.split('\n').find((line) => line.startsWith('[node name="Derived"'));
      expect(rootLine).toContain('instance=ExtResource(');
      expect(rootLine).not.toContain('type="Node2D"');
      expect(sectionProperties(text, '[node name="Leg" parent="."')).toEqual(['text = "changed"']);
      expect(text).not.toContain('modulate =');
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'delete_nodes refuses an inherited node and still deletes the scene own child',
    async () => {
      const result = await handleDeleteNodes(runner, {
        projectPath,
        scenePath: DERIVED_SCENE,
        nodePaths: ['root/Arm', 'root/Extra'],
      });
      const payload = expectMatchesOutputSchema('delete_nodes', result);
      const results = payload.results as Array<Record<string, unknown>>;
      expect(results).toHaveLength(2);
      expect(String(results[0]?.error)).toMatch(/inherited/);
      expect(results[1]?.success).toBe(true);

      expect(sceneText(DERIVED_SCENE)).not.toContain('name="Extra"');

      const tree = expectMatchesOutputSchema(
        'get_scene_tree',
        await handleGetSceneTree(runner, { projectPath, scenePath: DERIVED_SCENE }),
      );
      const children = tree.children as Array<{ name: string }>;
      expect(children.map((child) => child.name)).toContain('Arm');
    },
    CASE_TIMEOUT_MS,
  );
});

describe('an edit inside an instanced child writes only what changed', () => {
  itGodot(
    'set_node_properties on a node inside an instance marks it editable and pins nothing else',
    async () => {
      const result = await handleSetNodeProperties(runner, {
        projectPath,
        scenePath: HOST_SCENE,
        updates: [{ nodePath: 'root/Unit/Arm', property: 'position', value: { x: 77, y: 88 } }],
      });
      expectMatchesOutputSchema('set_node_properties', result);

      const text = sceneText(HOST_SCENE);
      expect(text).toContain('[editable path="Unit"]');
      expect(text).toContain('position = Vector2(77, 88)');
      expect(text).not.toContain('modulate =');
      expect(text).not.toContain('offset_right =');
      expect(text).not.toContain('text =');
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'add_node of a scene then an edit inside it writes only the edited property',
    async () => {
      const added = await handleAddNode(runner, {
        projectPath,
        scenePath: HOST_SCENE,
        nodeType: 'base_unit.tscn',
        nodeName: 'Second',
      });
      expectMatchesOutputSchema('add_node', added);

      const result = await handleSetNodeProperties(runner, {
        projectPath,
        scenePath: HOST_SCENE,
        updates: [{ nodePath: 'root/Second/Leg', property: 'text', value: 'second leg' }],
      });
      expectMatchesOutputSchema('set_node_properties', result);

      const text = sceneText(HOST_SCENE);
      expect(sectionProperties(text, '[node name="Leg" parent="Second"')).toEqual([
        'text = "second leg"',
      ]);
      expect(text).not.toContain('modulate =');
      expect(text).not.toContain('offset_right =');
    },
    CASE_TIMEOUT_MS,
  );
});
