/** Whole JSON numbers on the resource tools: an int target stores an int, an untyped container or Variant keeps the type already stored or becomes an int, and a fractional value for an int is refused. Asserts on saved text; a failing assertion starting with "precondition:" means the case is wrong, not the code. */

import { describe, beforeAll, expect } from 'vitest';
import { cpSync, readFileSync } from 'fs';
import { join } from 'path';
import { itGodot } from '../helpers/godot-skip.js';
import { dropProjectFeatureVersion, useTmpDirs } from '../helpers/tmp.js';
import { authoredFixtureProjectPath } from '../helpers/fixture-paths.js';
import { expectErrorMatching } from '../helpers/assertions.js';
import { expectMatchesOutputSchema } from '../helpers/schema-assert.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { handleCreateResource, handleSetResourceProperties } from '../../src/tools/scene-tools.js';

const CASE_TIMEOUT_MS = 120_000;
const BAG_SCRIPT = 'number_bag.gd';
const BAG_FILE = 'number_bag.tres';

const tmp = useTmpDirs();

let runner: GodotRunner;

beforeAll(async () => {
  runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
  await runner.detectGodotPath();
});

function authoredCopy(): string {
  const project = join(tmp.make('godot-mcp-json-numbers-'), 'project');
  cpSync(authoredFixtureProjectPath, project, { recursive: true });
  dropProjectFeatureVersion(project);
  return project;
}

function readText(project: string, relPath: string): string {
  return readFileSync(join(project, relPath), 'utf8');
}

describe('whole JSON numbers saved by the resource tools', () => {
  itGodot(
    'an int property and an untyped dictionary value are saved as 3, not 3.0',
    async () => {
      const project = authoredCopy();
      const result = await handleSetResourceProperties(runner, {
        projectPath: project,
        resourcePath: BAG_FILE,
        properties: { count: 3, stock: { gold: 3, rate: 4 } },
      });
      expectMatchesOutputSchema('set_resource_properties', result);
      const text = readText(project, BAG_FILE);
      expect(text).toMatch(/^count = 3$/m);
      expect(text).toMatch(/"gold": 3(,|$)/m);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'a value stored as a float stays a float when the new number is whole',
    async () => {
      const project = authoredCopy();
      expect(
        readText(project, BAG_FILE),
        'precondition: the file stores rate as a float',
      ).toContain('"rate": 2.0');
      const result = await handleSetResourceProperties(runner, {
        projectPath: project,
        resourcePath: BAG_FILE,
        properties: { stock: { gold: 3, rate: 4 }, any: 6, tags: [5, 6] },
      });
      expectMatchesOutputSchema('set_resource_properties', result);
      const text = readText(project, BAG_FILE);
      expect(text).toContain('"rate": 4.0');
      expect(text).toMatch(/^any = 6\.0$/m);
      expect(text).toMatch(/^tags = \[5, 6\.0\]$/m);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'a fractional number in an untyped container stays fractional',
    async () => {
      const project = authoredCopy();
      const result = await handleCreateResource(runner, {
        projectPath: project,
        resourcePath: 'bags/new.tres',
        type: BAG_SCRIPT,
        properties: { stock: { gold: 2, share: 0.5 }, any: 7 },
      });
      expectMatchesOutputSchema('create_resource', result);
      const text = readText(project, 'bags/new.tres');
      expect(text).toMatch(/"gold": 2(,|$)/m);
      expect(text).toContain('"share": 0.5');
      expect(text).toMatch(/^any = 7$/m);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'a fractional number for an int property is an error naming it, and nothing is written',
    async () => {
      const project = authoredCopy();
      const before = readText(project, BAG_FILE);
      const result = await handleSetResourceProperties(runner, {
        projectPath: project,
        resourcePath: BAG_FILE,
        properties: { count: 1.5 },
      });
      expectErrorMatching(result, /count.*whole number/s);
      expect(readText(project, BAG_FILE)).toBe(before);
    },
    CASE_TIMEOUT_MS,
  );
});
