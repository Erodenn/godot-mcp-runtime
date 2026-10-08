/** shader_parameter/* are virtual properties that exist on the instance only after `shader` is assigned, so `"prop" in instance` is false at check time though set() works. */

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
uniform float glow = 1.0;
uniform vec3 tint : source_color = vec3(1.0, 0.5, 0.2);
`;

function makeTmpProject(): string {
  const id = randomBytes(6).toString('hex');
  const dst = join(tmpdir(), `godot-mcp-test-${id}`);
  cpSync(fixtureProjectPath, dst, { recursive: true });
  mkdirSync(join(dst, 'shaders'), { recursive: true });
  writeFileSync(join(dst, 'shaders', 'test_neon.gdshader'), TEST_SHADER);
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

describe('inline ShaderMaterial with shader_parameter overrides', () => {
  itGodot(
    'add_node assigns material with shader + shader_parameter/* and persists the ext_resource + parameter lines',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      const scenePath = join(tmpProject, 'main.tscn');

      const { stdout } = await runner.executeOperation(
        'add_node',
        {
          scenePath: 'main.tscn',
          nodeType: 'Sprite2D',
          nodeName: 'GlowSprite',
          parentNodePath: '.',
          properties: {
            material: {
              type: 'ShaderMaterial',
              shader: 'res://shaders/test_neon.gdshader',
              'shader_parameter/glow': 2.5,
              'shader_parameter/tint': { r: 0.2, g: 0.9, b: 1.0 },
            },
          },
        },
        tmpProject,
        30000,
      );

      expect(stdout).toContain(OPERATION_RESULT_SENTINEL);

      const sceneText = readFileSync(scenePath, 'utf-8');
      expect(sceneText).toContain('[sub_resource type="ShaderMaterial"');
      expect(sceneText).toContain('shader = ExtResource(');
      expect(sceneText).toMatch(/shader_parameter\/glow = 2\.5/);
      expect(sceneText).toMatch(/shader_parameter\/tint = Color\(0\.2, 0\.9, 1/);
    },
    60000,
  );

  itGodot(
    'key order inside the typed dict does not affect the result (virtual-only specs persist correctly)',
    async () => {
      // The `in` operator's result for shader_parameter/* depends on a cache that refreshes only after an unrelated set(), so key order once decided success or a silent null; both orders must persist the identical Color.
      const tmpProject = tmpDirs[tmpDirs.length - 1];

      const addWith = async (nodeName: string, params: Record<string, unknown>) => {
        await runner.executeOperation(
          'add_node',
          {
            scenePath: 'main.tscn',
            nodeType: 'Sprite2D',
            nodeName,
            parentNodePath: '.',
            properties: {
              material: {
                type: 'ShaderMaterial',
                shader: 'res://shaders/test_neon.gdshader',
                ...params,
              },
            },
          },
          tmpProject,
          30000,
        );
      };

      await addWith('TintFirst', {
        'shader_parameter/tint': { r: 0.2, g: 0.9, b: 1.0 },
        'shader_parameter/glow': 3.0,
      });
      await addWith('GlowFirst', {
        'shader_parameter/glow': 3.0,
        'shader_parameter/tint': { r: 0.2, g: 0.9, b: 1.0 },
      });

      const sceneText = readFileSync(join(tmpProject, 'main.tscn'), 'utf-8');
      const tintLines = sceneText.match(/shader_parameter\/tint = .*/g) ?? [];
      expect(tintLines).toHaveLength(2);
      expect(new Set(tintLines).size).toBe(1);
      expect(tintLines[0]).toMatch(/shader_parameter\/tint = Color\(0\.2, 0\.9, 1/);
    },
    60000,
  );

  itGodot(
    'a spec with shader_parameter/* ordered before shader in the JSON still resolves',
    async () => {
      // addWith always spreads `shader` first, so build the dict by hand to put `shader_parameter/glow` ahead of `shader`.
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      const scenePath = join(tmpProject, 'main.tscn');

      const { stdout } = await runner.executeOperation(
        'add_node',
        {
          scenePath: 'main.tscn',
          nodeType: 'Sprite2D',
          nodeName: 'ReorderedSprite',
          parentNodePath: '.',
          properties: {
            material: {
              type: 'ShaderMaterial',
              'shader_parameter/glow': 2.5,
              shader: 'res://shaders/test_neon.gdshader',
            },
          },
        },
        tmpProject,
        30000,
      );

      expect(stdout).toContain(OPERATION_RESULT_SENTINEL);
      const sceneText = readFileSync(scenePath, 'utf-8');
      expect(sceneText).toMatch(/shader_parameter\/glow = 2\.5/);
    },
    60000,
  );

  itGodot(
    'a shader that fails to compile is attributed as such, not as an unknown uniform',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      const scenePath = join(tmpProject, 'main.tscn');
      writeFileSync(
        join(tmpProject, 'shaders', 'broken.gdshader'),
        'shader_type canvas_item;\nuniform float glow = ;\n',
      );

      const { stdout, stderr } = await runner.executeOperation(
        'add_node',
        {
          scenePath: 'main.tscn',
          nodeType: 'Sprite2D',
          nodeName: 'BrokenShaderSprite',
          parentNodePath: '.',
          properties: {
            material: {
              type: 'ShaderMaterial',
              shader: 'res://shaders/broken.gdshader',
              'shader_parameter/glow': 2.5,
            },
          },
        },
        tmpProject,
        30000,
      );

      const combined = `${stdout}\n${stderr}`;
      expect(combined).toContain('failed to compile or declares none');
      // The node was never added (freed before add_node returns), so nothing may be persisted.
      const sceneText = readFileSync(scenePath, 'utf-8');
      expect(sceneText).not.toContain('BrokenShaderSprite');
    },
    60000,
  );

  itGodot(
    'set_node_properties constructs ShaderMaterial on an existing node and the parameter persists',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];

      await runner.executeOperation(
        'add_node',
        {
          scenePath: 'main.tscn',
          nodeType: 'Sprite2D',
          nodeName: 'GlowSprite',
          parentNodePath: '.',
        },
        tmpProject,
        30000,
      );

      const { stdout, stderr: _stderr } = await runner.executeOperation(
        'set_node_properties',
        {
          scenePath: 'main.tscn',
          updates: [
            {
              nodePath: 'GlowSprite',
              property: 'material',
              value: {
                type: 'ShaderMaterial',
                shader: 'res://shaders/test_neon.gdshader',
                'shader_parameter/glow': 4.0,
              },
            },
          ],
        },
        tmpProject,
        30000,
      );

      const parsed = JSON.parse(extractJson(stdout));
      expect(parsed.results[0].success).toBe(true);

      const sceneText = readFileSync(join(tmpProject, 'main.tscn'), 'utf-8');
      expect(sceneText).toContain('[sub_resource type="ShaderMaterial"');
      expect(sceneText).toMatch(/shader_parameter\/glow = 4\.0/);
    },
    60000,
  );

  itGodot(
    'shader_parameter/* key with NO shader assigned returns the explicit error (nothing to resolve against)',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      const scenePath = join(tmpProject, 'main.tscn');

      const { stdout, stderr } = await runner.executeOperation(
        'add_node',
        {
          scenePath: 'main.tscn',
          nodeType: 'Sprite2D',
          nodeName: 'OrphanSprite',
          parentNodePath: '.',
          properties: {
            material: {
              type: 'ShaderMaterial',
              'shader_parameter/glow': 2.5,
            },
          },
        },
        tmpProject,
        30000,
      );

      const combined = `${stdout}\n${stderr}`;
      expect(combined).toContain(
        "Property 'shader_parameter/glow' does not resolve on resource of type 'ShaderMaterial'",
      );
      // The node was never added (freed before add_node returns), so nothing may be persisted.
      const sceneText = readFileSync(scenePath, 'utf-8');
      expect(sceneText).not.toContain('OrphanSprite');
    },
    60000,
  );

  itGodot(
    'unknown uniform name (shader set, but uniform not declared) returns the explicit error',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      const scenePath = join(tmpProject, 'main.tscn');

      const { stdout, stderr } = await runner.executeOperation(
        'add_node',
        {
          scenePath: 'main.tscn',
          nodeType: 'Sprite2D',
          nodeName: 'TypoSprite',
          parentNodePath: '.',
          properties: {
            material: {
              type: 'ShaderMaterial',
              shader: 'res://shaders/test_neon.gdshader',
              'shader_parameter/undeclared_uniform': 1.0,
            },
          },
        },
        tmpProject,
        30000,
      );

      const combined = `${stdout}\n${stderr}`;
      expect(combined).toContain(
        "Property 'shader_parameter/undeclared_uniform' does not resolve on resource of type 'ShaderMaterial'",
      );
      // The node was never added (freed before add_node returns), so nothing may be persisted.
      const sceneText = readFileSync(scenePath, 'utf-8');
      expect(sceneText).not.toContain('TypoSprite');
    },
    60000,
  );
});
