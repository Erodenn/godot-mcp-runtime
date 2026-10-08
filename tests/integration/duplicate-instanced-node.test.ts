// A copy of an instanced scene must be written like the original: one `instance=` line and only this scene's overrides; a `type=` with every non-default root property stops it following its scene.
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
import { handleDuplicateNode, handleSetNodeProperties } from '../../src/tools/node-tools.js';

const TINTED_HOST_SCENE = 'tinted_host.tscn';
const HOST_SCENE = 'host.tscn';
const DERIVED_SCENE = 'derived_unit.tscn';
const UNBIND_SCENE = 'unbind_host.tscn';
const CASE_TIMEOUT_MS = 120000;

let runner: GodotRunner;
let projectPath: string;
const tmpDirs: string[] = [];

beforeAll(async () => {
  runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
  await runner.detectGodotPath();
});

beforeEach(() => {
  projectPath = join(tmpdir(), `godot-mcp-duplicate-${randomBytes(6).toString('hex')}`);
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

function lineCount(text: string, prefix: string): number {
  return text.split('\n').filter((line) => line.startsWith(prefix)).length;
}

function sectionHeader(text: string, headerPrefix: string): string | undefined {
  return text.split('\n').find((line) => line.startsWith(headerPrefix));
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

describe('duplicate_node writes a copy of an instance as an instance', () => {
  itGodot(
    'the copy of an instance root carries instance= and only the overrides of the original',
    async () => {
      const result = await handleDuplicateNode(runner, {
        projectPath,
        scenePath: TINTED_HOST_SCENE,
        nodePath: 'root/Unit',
        newName: 'Copy',
      });
      const payload = expectMatchesOutputSchema('duplicate_node', result);
      expect(payload.newNodePath).toBe('root/Copy');

      const text = sceneText(TINTED_HOST_SCENE);
      const header = sectionHeader(text, '[node name="Copy"');
      expect(header).toContain('parent="."');
      expect(header).toContain('instance=ExtResource(');
      expect(header).not.toContain('type=');
      expect(sectionProperties(text, '[node name="Copy"')).toEqual(['position = Vector2(10, 10)']);
      expect(text).not.toContain('modulate =');
      expect(text).not.toContain('position = Vector2(5, 5)');
      expect(sectionProperties(text, '[node name="Unit" parent="."')).toEqual([
        'position = Vector2(10, 10)',
      ]);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'a node the host added under the instance is copied once, and the inner nodes are not written out',
    async () => {
      await handleDuplicateNode(runner, {
        projectPath,
        scenePath: TINTED_HOST_SCENE,
        nodePath: 'root/Unit',
        newName: 'Copy',
      });

      const text = sceneText(TINTED_HOST_SCENE);
      expect(text).toContain('[node name="Badge" type="Node2D" parent="Unit"');
      expect(text).toContain('[node name="Badge" type="Node2D" parent="Copy"');
      expect(text.split('[node name="Badge"').length - 1).toBe(2);
      // Core is an inner node of tinted_unit.tscn: the instance re-creates it.
      expect(text).not.toContain('[node name="Core"');
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'a plain subtree that contains an instance keeps the instance as an instance',
    async () => {
      const result = await handleDuplicateNode(runner, {
        projectPath,
        scenePath: TINTED_HOST_SCENE,
        nodePath: 'root/Group',
        newName: 'Group2',
      });
      expectMatchesOutputSchema('duplicate_node', result);

      const text = sceneText(TINTED_HOST_SCENE);
      expect(text).toContain('[node name="Group2" type="Node2D" parent="."');
      const inner = sectionHeader(text, '[node name="Inner" parent="Group2"');
      expect(inner).toContain('instance=ExtResource(');
      expect(inner).not.toContain('type=');
      expect(sectionProperties(text, '[node name="Inner" parent="Group2"')).toEqual([]);
      expect(text).not.toContain('modulate =');
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'the copy of an editable instance keeps its inner override and its editable mark',
    async () => {
      const edited = await handleSetNodeProperties(runner, {
        projectPath,
        scenePath: HOST_SCENE,
        updates: [{ nodePath: 'root/Unit/Arm', property: 'position', value: { x: 7, y: 7 } }],
      });
      expectMatchesOutputSchema('set_node_properties', edited);

      const result = await handleDuplicateNode(runner, {
        projectPath,
        scenePath: HOST_SCENE,
        nodePath: 'root/Unit',
        newName: 'Copy',
      });
      expectMatchesOutputSchema('duplicate_node', result);

      const text = sceneText(HOST_SCENE);
      const header = sectionHeader(text, '[node name="Copy"');
      expect(header).toContain('instance=ExtResource(');
      expect(header).not.toContain('type=');
      expect(text).toContain('[editable path="Copy"]');
      const arm = sectionHeader(text, '[node name="Arm" parent="Copy"');
      expect(arm).toBeDefined();
      expect(arm).not.toContain('type=');
      expect(sectionProperties(text, '[node name="Arm" parent="Copy"')).toEqual([
        'position = Vector2(7, 7)',
      ]);
      expect(text).not.toContain('modulate =');
    },
    CASE_TIMEOUT_MS,
  );
});

describe('duplicate_node on a node another scene defines', () => {
  itGodot(
    'the copy of a node inside an editable instance is a node of this scene',
    async () => {
      const edited = await handleSetNodeProperties(runner, {
        projectPath,
        scenePath: HOST_SCENE,
        updates: [{ nodePath: 'root/Unit/Arm', property: 'position', value: { x: 7, y: 7 } }],
      });
      expectMatchesOutputSchema('set_node_properties', edited);

      const result = await handleDuplicateNode(runner, {
        projectPath,
        scenePath: HOST_SCENE,
        nodePath: 'root/Unit/Arm',
        newName: 'ArmCopy',
      });
      const payload = expectMatchesOutputSchema('duplicate_node', result);
      expect(payload.newNodePath).toBe('root/Unit/ArmCopy');

      const text = sceneText(HOST_SCENE);
      expect(lineCount(text, '[node name="ArmCopy"')).toBe(1);
      const header = sectionHeader(text, '[node name="ArmCopy"');
      expect(header).toContain('type="Sprite2D"');
      expect(header).toContain('parent="Unit"');
      expect(header).not.toContain('instance=');
      expect(sectionProperties(text, '[node name="ArmCopy"')).toContain('position = Vector2(7, 7)');
      expect(sectionHeader(text, '[node name="Arm" parent="Unit"')).not.toContain('type=');
      expect(sectionProperties(text, '[node name="Arm" parent="Unit"')).toEqual([
        'position = Vector2(7, 7)',
      ]);
      expect(text).toContain('[editable path="Unit"]');
      expect(sectionHeader(text, '[node name="Unit"')).toContain('instance=ExtResource(');
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'the copy of an inherited node is a node of the derived scene, which stays inherited',
    async () => {
      const result = await handleDuplicateNode(runner, {
        projectPath,
        scenePath: DERIVED_SCENE,
        nodePath: 'root/Arm',
        newName: 'ArmCopy',
      });
      const payload = expectMatchesOutputSchema('duplicate_node', result);
      expect(payload.newNodePath).toBe('root/ArmCopy');

      const text = sceneText(DERIVED_SCENE);
      const root = sectionHeader(text, '[node name="Derived"');
      expect(root).toContain('instance=ExtResource(');
      expect(root).not.toContain('type=');
      expect(lineCount(text, '[node name="ArmCopy"')).toBe(1);
      const header = sectionHeader(text, '[node name="ArmCopy"');
      expect(header).toContain('type="Sprite2D"');
      expect(header).toContain('parent="."');
      expect(sectionProperties(text, '[node name="ArmCopy"')).toContain('position = Vector2(5, 6)');
      expect(sectionHeader(text, '[node name="Arm" parent="."')).not.toContain('type=');
      expect(sectionProperties(text, '[node name="Arm" parent="."')).toEqual([
        'position = Vector2(5, 6)',
      ]);
      expect(lineCount(text, '[node name="Leg"')).toBe(0);
      expect(lineCount(text, '[node name="Extra" type="Node2D" parent="."')).toBe(1);
    },
    CASE_TIMEOUT_MS,
  );
});

describe('duplicate_node keeps what a connection of the copy carries', () => {
  itGodot(
    'a connection to a node outside the copy keeps its unbound argument count',
    async () => {
      const result = await handleDuplicateNode(runner, {
        projectPath,
        scenePath: UNBIND_SCENE,
        nodePath: 'root/Toggle',
        newName: 'Toggle2',
      });
      expectMatchesOutputSchema('duplicate_node', result);

      const lines = sceneText(UNBIND_SCENE).split('\n');
      for (const source of ['Toggle', 'Toggle2']) {
        const connections = lines.filter((line) =>
          line.startsWith(`[connection signal="toggled" from="${source}" to="."`),
        );
        expect(connections).toHaveLength(1);
        expect(connections[0]).toContain('method="_on_toggle_changed"');
        expect(connections[0]).toContain('unbinds=1');
      }
    },
    CASE_TIMEOUT_MS,
  );
});

describe('duplicate_node reports a name Godot did not keep', () => {
  itGodot(
    'a newName a sibling already has leads the payload with a warning and names the real path',
    async () => {
      const result = await handleDuplicateNode(runner, {
        projectPath,
        scenePath: TINTED_HOST_SCENE,
        nodePath: 'root/Unit',
        newName: 'Group',
      });
      const payload = expectMatchesOutputSchema('duplicate_node', result);

      expect(payload.newNodePath).not.toBe('root/Group');
      const warnings = payload.warnings as string[];
      expect(
        warnings.some((warning) => /Requested node name 'Group' was not kept/.test(warning)),
      ).toBe(true);
      const text = sceneText(TINTED_HOST_SCENE);
      expect(lineCount(text, '[node name="Group" ')).toBe(1);
      const copyName = String(payload.newNodePath).slice('root/'.length);
      expect(sectionHeader(text, `[node name="${copyName}"`)).toContain('instance=ExtResource(');
    },
    CASE_TIMEOUT_MS,
  );
});
