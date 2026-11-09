/** create_resource and set_resource_properties against a copy of the authored fixture. A failing assertion whose message starts with "precondition:" means the case itself is wrong, not the code under test. */

import { describe, beforeAll, expect } from 'vitest';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { itGodot } from '../helpers/godot-skip.js';
import { dropProjectFeatureVersion, useTmpDirs } from '../helpers/tmp.js';
import { authoredFixtureProjectPath } from '../helpers/fixture-paths.js';
import { expectErrorMatching } from '../helpers/assertions.js';
import { expectMatchesOutputSchema } from '../helpers/schema-assert.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { extractOperationPayload } from '../../src/utils/output-parsing.js';
import { handleCreateResource, handleSetResourceProperties } from '../../src/tools/scene-tools.js';

const CASE_TIMEOUT_MS = 120_000;
const PROJECT_DIR = 'project';
const SWORD = 'sword.tres';
const CLASS_CACHE_FILE = join('.godot', 'global_script_class_cache.cfg');

const tmp = useTmpDirs();

let runner: GodotRunner;

beforeAll(async () => {
  runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
  await runner.detectGodotPath();
});

function authoredCopy(): { parent: string; project: string } {
  const parent = tmp.make('godot-mcp-resource-');
  const project = join(parent, PROJECT_DIR);
  cpSync(authoredFixtureProjectPath, project, { recursive: true });
  dropProjectFeatureVersion(project);
  return { parent, project };
}

function readText(project: string, relPath: string): string {
  return readFileSync(join(project, relPath), 'utf8');
}

describe('create_resource', () => {
  itGodot(
    'creates a typed .tres from a script path and reads the values back from the saved file',
    async () => {
      const { project } = authoredCopy();
      const result = await handleCreateResource(runner, {
        projectPath: project,
        resourcePath: 'items/axe.tres',
        type: 'item_stats.gd',
        properties: {
          title: 'Axe',
          power: 7,
          tint: { r: 0, g: 1, b: 0, a: 1 },
          shape: { type: 'CircleShape2D', radius: 3 },
        },
      });
      const payload = expectMatchesOutputSchema('create_resource', result);
      expect(payload.resourcePath).toBe('items/axe.tres');
      expect(payload.resourceType).toBe('Resource');
      expect(payload.scriptPath).toBe('item_stats.gd');
      expect(payload.properties).toEqual({
        title: 'Axe',
        power: 7,
        tint: { r: 0, g: 1, b: 0, a: 1 },
        shape: 'CircleShape2D',
      });

      const text = readText(project, 'items/axe.tres');
      expect(text).toContain('[gd_resource type="Resource"');
      expect(text).toContain('path="res://item_stats.gd"');
      expect(text).toContain('uid="uid://bitemstats1x"');
      expect(text).toContain('title = "Axe"');
      expect(text).toContain('power = 7');
      expect(text).toContain('tint = Color(0, 1, 0, 1)');
      expect(text).toContain('[sub_resource type="CircleShape2D"');
      expect(text).toMatch(/radius = 3/);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'creates a .tres from a registered class_name',
    async () => {
      const { project } = authoredCopy();
      await runner.importAssets(project);
      expect(
        readText(project, CLASS_CACHE_FILE),
        'precondition: the import registered ItemStats',
      ).toContain('ItemStats');

      const result = await handleCreateResource(runner, {
        projectPath: project,
        resourcePath: 'items/by_name.tres',
        type: 'ItemStats',
        properties: { power: 3 },
      });
      const payload = expectMatchesOutputSchema('create_resource', result);
      expect(payload.scriptPath).toBe('item_stats.gd');
      expect(payload.properties).toEqual({ power: 3 });
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'refuses a path outside the project in the operation itself',
    async () => {
      const { parent, project } = authoredCopy();
      const { stdout, stderr } = await runner.executeOperation(
        'create_resource',
        { resourcePath: 'res://../outside.tres', type: 'Resource' },
        project,
      );
      expect(extractOperationPayload(stdout)).toBeNull();
      expect(stderr).toContain('escapes the project root');
      expect(existsSync(join(parent, 'outside.tres'))).toBe(false);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'refuses an unknown property name and writes nothing',
    async () => {
      const { project } = authoredCopy();
      const result = await handleCreateResource(runner, {
        projectPath: project,
        resourcePath: 'items/bad.tres',
        type: 'item_stats.gd',
        properties: { no_such: 1 },
      });
      expectErrorMatching(result, /no_such/);
      expect(existsSync(join(project, 'items/bad.tres'))).toBe(false);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'refuses a value of the wrong type and writes nothing',
    async () => {
      const { project } = authoredCopy();
      const result = await handleCreateResource(runner, {
        projectPath: project,
        resourcePath: 'items/bad.tres',
        type: 'item_stats.gd',
        properties: { power: 'lots' },
      });
      expectErrorMatching(result, /power/);
      expect(existsSync(join(project, 'items/bad.tres'))).toBe(false);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'refuses an existing file without overwrite in the operation itself',
    async () => {
      const { project } = authoredCopy();
      const before = readText(project, SWORD);
      const { stdout, stderr } = await runner.executeOperation(
        'create_resource',
        { resourcePath: SWORD, type: 'Resource' },
        project,
      );
      expect(extractOperationPayload(stdout)).toBeNull();
      expect(stderr).toContain('already exists');
      expect(readText(project, SWORD)).toBe(before);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'refuses a type that is not a Resource',
    async () => {
      const { project } = authoredCopy();
      const result = await handleCreateResource(runner, {
        projectPath: project,
        resourcePath: 'items/node.tres',
        type: 'Node2D',
      });
      expectErrorMatching(result, /not a Resource/);
      expect(existsSync(join(project, 'items/node.tres'))).toBe(false);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'overwrite replaces the values and keeps the file uid',
    async () => {
      const { project } = authoredCopy();
      const result = await handleCreateResource(runner, {
        projectPath: project,
        resourcePath: SWORD,
        type: 'item_stats.gd',
        properties: { power: 1 },
        overwrite: true,
      });
      expectMatchesOutputSchema('create_resource', result);
      const text = readText(project, SWORD);
      expect(text).toContain('uid="uid://csword1tres"');
      expect(text).not.toContain('title = "Sword"');
    },
    CASE_TIMEOUT_MS,
  );
});

describe('set_resource_properties', () => {
  itGodot(
    'changes one value and keeps every other value, the sub-resource and the uids',
    async () => {
      const { project } = authoredCopy();
      const result = await handleSetResourceProperties(runner, {
        projectPath: project,
        resourcePath: SWORD,
        properties: { power: 20 },
      });
      const payload = expectMatchesOutputSchema('set_resource_properties', result);
      expect(payload.properties).toEqual({ power: 20 });

      const text = readText(project, SWORD);
      expect(text).toContain('power = 20');
      expect(text).not.toContain('power = 12');
      expect(text).toContain('title = "Sword"');
      expect(text).toContain('weight = 3.5');
      expect(text).toContain('tint = Color(1, 0, 0, 1)');
      expect(text).toContain('[sub_resource type="RectangleShape2D"');
      expect(text).toContain('size = Vector2(4, 8)');
      expect(text).toContain('shape = SubResource(');
      expect(text).toContain('script = ExtResource(');
      expect(text).toContain('uid="uid://csword1tres"');
      expect(text).toContain('uid="uid://bitemstats1x"');
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'refuses an unknown property and leaves the file byte-identical',
    async () => {
      const { project } = authoredCopy();
      const before = readText(project, SWORD);
      const result = await handleSetResourceProperties(runner, {
        projectPath: project,
        resourcePath: SWORD,
        properties: { power: 20, no_such: 1 },
      });
      expectErrorMatching(result, /no_such/);
      expect(readText(project, SWORD)).toBe(before);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'refuses the script key and leaves the file byte-identical',
    async () => {
      const { project } = authoredCopy();
      const before = readText(project, SWORD);
      const result = await handleSetResourceProperties(runner, {
        projectPath: project,
        resourcePath: SWORD,
        properties: { script: 'res://item_stats.gd' },
      });
      expectErrorMatching(result, /script/);
      expect(readText(project, SWORD)).toBe(before);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'refuses to save a resource whose script did not attach',
    async () => {
      const { project } = authoredCopy();
      writeFileSync(
        join(project, 'broken_item.gd'),
        'extends Resource\n\n@export var hp: int = 1\n\nfunc f() -> int:\n\treturn undeclared_x\n',
      );
      const brokenResource =
        '[gd_resource type="Resource" load_steps=2 format=3]\n\n' +
        '[ext_resource type="Script" path="res://broken_item.gd" id="1_broken"]\n\n' +
        '[resource]\nscript = ExtResource("1_broken")\nhp = 5\n';
      writeFileSync(join(project, 'broken_item.tres'), brokenResource);

      const result = await handleSetResourceProperties(runner, {
        projectPath: project,
        resourcePath: 'broken_item.tres',
        properties: { resource_name: 'x' },
      });
      expectErrorMatching(result, /script could not be attached/);
      expect(readText(project, 'broken_item.tres')).toBe(brokenResource);
    },
    CASE_TIMEOUT_MS,
  );
});
