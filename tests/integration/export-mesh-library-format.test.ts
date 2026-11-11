/** export_mesh_library writes the format the output extension names: a `.tres` is text, a `.res` stays binary. */

import { describe, beforeAll, expect } from 'vitest';
import { cpSync, readFileSync } from 'fs';
import { join } from 'path';
import { itGodot } from '../helpers/godot-skip.js';
import { dropProjectFeatureVersion, useTmpDirs } from '../helpers/tmp.js';
import { fixtureProjectPath } from '../helpers/fixture-paths.js';
import { hasError } from '../helpers/assertions.js';
import { expectMatchesOutputSchema } from '../helpers/schema-assert.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import {
  handleAddNode,
  handleCreateScene,
  handleExportMeshLibrary,
} from '../../src/tools/scene-tools.js';

const CASE_TIMEOUT_MS = 120_000;
const SOURCE_SCENE = 'tiles.tscn';
const TILE_NAME = 'Wall';
const TEXT_RESOURCE_HEADER = '[gd_resource type="MeshLibrary"';
const TEXT_RESOURCE_PREFIX = '[gd_resource';

const tmp = useTmpDirs();

let runner: GodotRunner;

beforeAll(async () => {
  runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
  await runner.detectGodotPath();
});

async function projectWithTile(): Promise<string> {
  const project = tmp.make('godot-mcp-meshlib-');
  cpSync(fixtureProjectPath, project, { recursive: true });
  dropProjectFeatureVersion(project);
  const created = await handleCreateScene(runner, {
    projectPath: project,
    scenePath: SOURCE_SCENE,
    rootNodeType: 'Node3D',
  });
  expect(hasError(created), JSON.stringify(created)).toBe(false);
  const added = await handleAddNode(runner, {
    projectPath: project,
    scenePath: SOURCE_SCENE,
    nodeType: 'MeshInstance3D',
    nodeName: TILE_NAME,
    properties: { mesh: { type: 'BoxMesh' } },
  });
  expect(hasError(added), JSON.stringify(added)).toBe(false);
  return project;
}

describe('export_mesh_library output format', () => {
  itGodot(
    'a .tres output is a text MeshLibrary holding the item',
    async () => {
      const project = await projectWithTile();
      const result = await handleExportMeshLibrary(runner, {
        projectPath: project,
        scenePath: SOURCE_SCENE,
        outputPath: 'pieces.tres',
      });
      const payload = expectMatchesOutputSchema('export_mesh_library', result);
      expect(payload.outputPath).toBe('pieces.tres');
      expect(payload.itemNames).toEqual([TILE_NAME]);

      const text = readFileSync(join(project, 'pieces.tres'), 'utf8');
      expect(text.startsWith(TEXT_RESOURCE_HEADER)).toBe(true);
      expect(text).toContain(TILE_NAME);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'a .res output stays a binary resource',
    async () => {
      const project = await projectWithTile();
      const result = await handleExportMeshLibrary(runner, {
        projectPath: project,
        scenePath: SOURCE_SCENE,
        outputPath: 'pieces.res',
      });
      const payload = expectMatchesOutputSchema('export_mesh_library', result);
      expect(payload.outputPath).toBe('pieces.res');

      const bytes = readFileSync(join(project, 'pieces.res'));
      expect(bytes.subarray(0, TEXT_RESOURCE_PREFIX.length).toString('latin1')).not.toBe(
        TEXT_RESOURCE_PREFIX,
      );
      expect(bytes.subarray(0, 2).toString('latin1')).toBe('RS');
    },
    CASE_TIMEOUT_MS,
  );
});
