/** Typed-container and text-spelling values on the resource tools and set_node_properties, plus the uid layout of a saved .tres. Asserts on saved text; a failing assertion starting with "precondition:" means the case is wrong, not the code. */

import { describe, beforeAll, expect } from 'vitest';
import { cpSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { engineMajorMinor, itGodot } from '../helpers/godot-skip.js';
import { dropProjectFeatureVersion, useTmpDirs } from '../helpers/tmp.js';
import { authoredFixtureProjectPath } from '../helpers/fixture-paths.js';
import { expectErrorMatching } from '../helpers/assertions.js';
import { expectMatchesOutputSchema } from '../helpers/schema-assert.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { handleCreateResource, handleSetResourceProperties } from '../../src/tools/scene-tools.js';
import { handleSetNodeProperties } from '../../src/tools/node-tools.js';

const CASE_TIMEOUT_MS = 120_000;
const TYPED_DICTIONARY_MIN_MINOR = 4;
const TABLE_SCRIPT = 'title_table.gd';
const BARE_TITLES = 'bare_titles.tres';
const HOST_SCENE = 'title_host.tscn';

const tmp = useTmpDirs();

let runner: GodotRunner;

beforeAll(async () => {
  runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
  await runner.detectGodotPath();
});

function authoredCopy(): string {
  const project = join(tmp.make('godot-mcp-typed-values-'), 'project');
  cpSync(authoredFixtureProjectPath, project, { recursive: true });
  dropProjectFeatureVersion(project);
  return project;
}

function readText(project: string, relPath: string): string {
  return readFileSync(join(project, relPath), 'utf8');
}

describe('a Dictionary[StringName, PackedStringArray] property', () => {
  itGodot(
    'create_resource builds it from string keys and arrays of strings',
    async (ctx) => {
      if ((await engineMajorMinor()).minor < TYPED_DICTIONARY_MIN_MINOR) ctx.skip();
      const project = authoredCopy();
      const result = await handleCreateResource(runner, {
        projectPath: project,
        resourcePath: 'titles/era_2.tres',
        type: TABLE_SCRIPT,
        properties: { slots: { a: ['x', 'y'], b: [] } },
      });
      const payload = expectMatchesOutputSchema('create_resource', result);
      expect(payload.properties).toEqual({ slots: { a: ['x', 'y'], b: [] } });

      const text = readText(project, 'titles/era_2.tres');
      expect(text).toContain('slots = Dictionary[StringName, PackedStringArray]({');
      expect(text).toContain('PackedStringArray("x", "y")');
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'a key written in the file spelling &"b" is stored as b',
    async (ctx) => {
      if ((await engineMajorMinor()).minor < TYPED_DICTIONARY_MIN_MINOR) ctx.skip();
      const project = authoredCopy();
      const result = await handleCreateResource(runner, {
        projectPath: project,
        resourcePath: 'titles/keyed.tres',
        type: TABLE_SCRIPT,
        properties: { slots: { '&"b"': ['z'] } },
      });
      const payload = expectMatchesOutputSchema('create_resource', result);
      expect(payload.properties).toEqual({ slots: { b: ['z'] } });
      expect(readText(project, 'titles/keyed.tres')).not.toContain('&"&');
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'an element that is not a string is an error naming the entry, and nothing is written',
    async (ctx) => {
      if ((await engineMajorMinor()).minor < TYPED_DICTIONARY_MIN_MINOR) ctx.skip();
      const project = authoredCopy();
      const result = await handleCreateResource(runner, {
        projectPath: project,
        resourcePath: 'titles/bad.tres',
        type: TABLE_SCRIPT,
        properties: { slots: { a: [1] } },
      });
      expectErrorMatching(result, /slots\["a"\]/);
      expect(existsSync(join(project, 'titles/bad.tres'))).toBe(false);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'a value that is not an array is an error, and nothing is written',
    async (ctx) => {
      if ((await engineMajorMinor()).minor < TYPED_DICTIONARY_MIN_MINOR) ctx.skip();
      const project = authoredCopy();
      const result = await handleCreateResource(runner, {
        projectPath: project,
        resourcePath: 'titles/bad.tres',
        type: TABLE_SCRIPT,
        properties: { slots: { a: 'x' } },
      });
      expectErrorMatching(result, /not an array/);
      expect(existsSync(join(project, 'titles/bad.tres'))).toBe(false);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'set_node_properties builds it too',
    async (ctx) => {
      if ((await engineMajorMinor()).minor < TYPED_DICTIONARY_MIN_MINOR) ctx.skip();
      const project = authoredCopy();
      const result = await handleSetNodeProperties(runner, {
        projectPath: project,
        scenePath: HOST_SCENE,
        updates: [{ nodePath: 'root', property: 'slots', value: { a: ['x', 'y'] } }],
      });
      const payload = expectMatchesOutputSchema('set_node_properties', result);
      const entry = (payload.results as { success?: boolean; error?: string }[])[0];
      expect(entry?.error).toBeUndefined();
      expect(entry?.success).toBe(true);
      const text = readText(project, HOST_SCENE);
      expect(text).toContain('slots = Dictionary[StringName, PackedStringArray]({');
      expect(text).toContain('PackedStringArray("x", "y")');
    },
    CASE_TIMEOUT_MS,
  );
});

describe('set_resource_properties on a file written by hand', () => {
  itGodot(
    'a StringName given in the file spelling &"x" is stored as x, not double-wrapped',
    async () => {
      const project = authoredCopy();
      const result = await handleSetResourceProperties(runner, {
        projectPath: project,
        resourcePath: BARE_TITLES,
        properties: { label: '&"era_2"' },
      });
      const payload = expectMatchesOutputSchema('set_resource_properties', result);
      expect(payload.properties).toEqual({ label: 'era_2' });
      const text = readText(project, BARE_TITLES);
      expect(text).toContain('label = &"era_2"');
      expect(text).not.toContain('&"&');
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'a plain string still works for a StringName',
    async () => {
      const project = authoredCopy();
      const result = await handleSetResourceProperties(runner, {
        projectPath: project,
        resourcePath: BARE_TITLES,
        properties: { label: 'era_3' },
      });
      expectMatchesOutputSchema('set_resource_properties', result);
      expect(readText(project, BARE_TITLES)).toContain('label = &"era_3"');
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'a script reference the file listed without a uid is saved without one',
    async () => {
      const project = authoredCopy();
      expect(
        readText(project, TABLE_SCRIPT + '.uid'),
        'precondition: the project records a uid for the script',
      ).toContain('uid://');
      const result = await handleSetResourceProperties(runner, {
        projectPath: project,
        resourcePath: BARE_TITLES,
        properties: { label: 'era_4' },
      });
      expectMatchesOutputSchema('set_resource_properties', result);
      const text = readText(project, BARE_TITLES);
      const scriptLine = text.split('\n').find((line) => line.includes('res://title_table.gd'));
      expect(scriptLine, 'precondition: the script is still an ext_resource').toBeDefined();
      expect(scriptLine).not.toContain('uid=');
      expect(text.split('\n')[0]).not.toContain('uid=');
    },
    CASE_TIMEOUT_MS,
  );
});
