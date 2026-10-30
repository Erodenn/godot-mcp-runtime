/** User-authored dicts under `properties` and `value` (script exports, `shader_parameter/<uniform>`, `metadata/<key>`) must not be rewritten to snake_case: `OPAQUE_VALUE_KEYS` stops the converter's walk at those keys. */

import { describe, beforeAll, beforeEach, afterAll, expect } from 'vitest';
import { cpSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { removeTmpDir } from '../helpers/tmp.js';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { itGodot } from '../helpers/godot-skip.js';
import { fixtureProjectPath } from '../helpers/fixture-paths.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { extractJson, OPERATION_RESULT_SENTINEL } from '../../src/utils/output-parsing.js';

const TEST_SHADER = `shader_type canvas_item;
uniform float glowAmount = 1.0;
`;

function makeTmpProject(): string {
  const id = randomBytes(6).toString('hex');
  const dst = join(tmpdir(), `godot-mcp-test-${id}`);
  cpSync(fixtureProjectPath, dst, { recursive: true });
  mkdirSync(join(dst, 'shaders'), { recursive: true });
  writeFileSync(join(dst, 'shaders', 'camel_case.gdshader'), TEST_SHADER);
  return dst;
}

const tmpDirs: string[] = [];

let runner: GodotRunner;

beforeAll(async () => {
  runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
  await runner.detectGodotPath();
});

beforeEach(() => {
  tmpDirs.push(makeTmpProject());
});

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      removeTmpDir(dir);
    } catch {}
  }
});

describe('camelCase keys inside user-authored properties/value dicts', () => {
  itGodot(
    'camelCase shader uniform names survive the parameter converter through add_node, set_node_properties, and batch',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      const scenePath = join(tmpProject, 'main.tscn');

      const addResult = await runner.executeOperation(
        'add_node',
        {
          scenePath: 'main.tscn',
          nodeType: 'Sprite2D',
          nodeName: 'CamelSprite',
          parentNodePath: '.',
          properties: {
            material: {
              type: 'ShaderMaterial',
              shader: 'res://shaders/camel_case.gdshader',
              'shader_parameter/glowAmount': 2.5,
            },
          },
        },
        tmpProject,
        30000,
      );

      expect(addResult.stdout).toContain(OPERATION_RESULT_SENTINEL);
      let sceneText = readFileSync(scenePath, 'utf-8');
      expect(sceneText).toMatch(/shader_parameter\/glowAmount = 2\.5/);

      const setResult = await runner.executeOperation(
        'set_node_properties',
        {
          scenePath: 'main.tscn',
          updates: [
            {
              nodePath: 'root/CamelSprite',
              property: 'material',
              value: {
                type: 'ShaderMaterial',
                shader: 'res://shaders/camel_case.gdshader',
                'shader_parameter/glowAmount': 3.5,
              },
            },
          ],
          abortOnError: true,
        },
        tmpProject,
        30000,
      );

      const setParsed = JSON.parse(extractJson(setResult.stdout));
      expect(setParsed.results[0].success).toBe(true);
      expect(setParsed.results[0].error).toBeUndefined();
      sceneText = readFileSync(scenePath, 'utf-8');
      expect(sceneText).toMatch(/shader_parameter\/glowAmount = 3\.5/);

      const batchResult = await runner.executeOperation(
        'batch_scene_operations',
        {
          operations: [
            {
              operation: 'add_node',
              scenePath: 'main.tscn',
              nodeType: 'Sprite2D',
              nodeName: 'BatchCamelSprite',
              parentNodePath: '.',
              properties: {
                material: {
                  type: 'ShaderMaterial',
                  shader: 'res://shaders/camel_case.gdshader',
                  'shader_parameter/glowAmount': 4.5,
                },
              },
            },
          ],
        },
        tmpProject,
        30000,
      );

      const batchParsed = JSON.parse(extractJson(batchResult.stdout));
      expect(batchParsed.results[0].success).toBe(true);
      sceneText = readFileSync(scenePath, 'utf-8');
      expect(sceneText).toMatch(/shader_parameter\/glowAmount = 4\.5/);
    },
    60000,
  );
});
