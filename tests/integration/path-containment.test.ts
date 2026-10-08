/** Godot resolves `res://../x` outward to a real file, and batch_scene_operations forwards operations to GDScript raw, so containment must hold in normalize_scene_path (it returns "" for an escaping path). */

import { describe, beforeAll, beforeEach, afterAll, expect } from 'vitest';
import { cpSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { removeTmpDir } from '../helpers/tmp.js';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { itGodot } from '../helpers/godot-skip.js';
import { fixtureProjectPath } from '../helpers/fixture-paths.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { OPERATION_RESULT_SENTINEL, extractJson } from '../../src/utils/output-parsing.js';

const ESCAPE_MESSAGE = 'escapes the project root';

function makeTmpProject(): string {
  const id = randomBytes(6).toString('hex');
  const dst = join(tmpdir(), `godot-mcp-containment-${id}`);
  cpSync(fixtureProjectPath, dst, { recursive: true });
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

function parseUpdateResults(stdout: string): Array<{ success?: boolean; error?: string }> {
  const payload = JSON.parse(extractJson(stdout)) as {
    results: Array<{ success?: boolean; error?: string }>;
  };
  return payload.results;
}

function plantOutside(projectDir: string, name: string, body: string): string {
  writeFileSync(join(dirname(projectDir), name), body);
  return name;
}

describe('project-root containment (normalize_scene_path choke point)', () => {
  itGodot(
    'batch load_sprite rejects a texturePath that escapes the project root',
    async () => {
      // The batch path reaches _apply_load_sprite without handleLoadSprite's resolveProjectPath, so the guard must be engine-side.
      const tmpProject = tmpDirs[tmpDirs.length - 1]!;
      const outside = plantOutside(tmpProject, 'outside.png', 'not-a-real-png');

      const { stdout } = await runner.executeOperation(
        'batch_scene_operations',
        {
          operations: [
            {
              operation: 'load_sprite',
              scenePath: 'main.tscn',
              nodePath: 'root/Sprite2D',
              texturePath: `../${outside}`,
            },
          ],
        },
        tmpProject,
        30000,
      );

      expect(stdout).toContain(ESCAPE_MESSAGE);
    },
    60000,
  );

  itGodot(
    'batch add_node rejects a scenePath that escapes the project root',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1]!;
      const outside = plantOutside(
        tmpProject,
        'outside.tscn',
        '[gd_scene format=3]\n\n[node name="O" type="Node2D"]\n',
      );
      const before = readFileSync(join(dirname(tmpProject), outside), 'utf-8');

      const { stdout } = await runner.executeOperation(
        'batch_scene_operations',
        {
          operations: [
            {
              operation: 'add_node',
              scenePath: `../${outside}`,
              nodeType: 'Node2D',
              nodeName: 'Intruder',
            },
          ],
        },
        tmpProject,
        30000,
      );

      expect(stdout).toContain(ESCAPE_MESSAGE);
      expect(readFileSync(join(dirname(tmpProject), outside), 'utf-8')).toBe(before);
    },
    60000,
  );

  itGodot(
    'validate rejects an escaping target instead of reading outside the project',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1]!;

      const { stdout } = await runner.executeOperation(
        'validate_batch',
        { targets: [{ scriptPath: '../../etc/passwd.gd' }] },
        tmpProject,
        30000,
      );

      expect(stdout).toContain(ESCAPE_MESSAGE);
    },
    60000,
  );

  itGodot(
    'attach_script rejects an escaping scriptPath',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1]!;
      plantOutside(tmpProject, 'outside.gd', 'extends Node\n');

      // A refused operation resolves with its output; a throw means the engine died or timed out.
      const { stdout, stderr } = await runner.executeOperation(
        'attach_script',
        { scenePath: 'main.tscn', nodePath: 'root', scriptPath: '../outside.gd' },
        tmpProject,
        30000,
      );

      // Also red when the operation never ran: a misspelled operation name prints no such line.
      expect(stderr).toContain(ESCAPE_MESSAGE);
      expect(stdout).not.toContain(OPERATION_RESULT_SENTINEL);
      expect(readFileSync(join(tmpProject, 'main.tscn'), 'utf-8')).not.toContain('outside.gd');
    },
    60000,
  );

  itGodot(
    'save_scene refuses to write outside the project root',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1]!;
      const target = join(dirname(tmpProject), 'escaped-save.tscn');
      rmSync(target, { force: true });

      const { stdout, stderr } = await runner.executeOperation(
        'save_scene',
        { scenePath: 'main.tscn', newPath: '../escaped-save.tscn' },
        tmpProject,
        30000,
      );

      expect(stderr).toContain(ESCAPE_MESSAGE);
      expect(stdout).not.toContain(OPERATION_RESULT_SENTINEL);
      expect(existsSync(target)).toBe(false);
    },
    60000,
  );

  // A property value is the one path that arrives with no Node-side validator, so the script is the only guard.
  itGodot(
    'set_node_properties rejects a res:// property value that escapes the project root',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1]!;
      plantOutside(tmpProject, 'outside_value.gd', 'extends Node2D\n');
      const before = readFileSync(join(tmpProject, 'main.tscn'), 'utf-8');

      const { stdout } = await runner.executeOperation(
        'set_node_properties',
        {
          scenePath: 'main.tscn',
          updates: [{ nodePath: 'root', property: 'script', value: 'res://../outside_value.gd' }],
        },
        tmpProject,
        30000,
      );

      const [entry] = parseUpdateResults(stdout);
      expect(entry).not.toHaveProperty('success');
      expect(String(entry?.error)).toContain(ESCAPE_MESSAGE);
      expect(readFileSync(join(tmpProject, 'main.tscn'), 'utf-8')).toBe(before);
    },
    60000,
  );

  itGodot(
    'batch rejects an escaping res:// path nested in an inline resource value',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1]!;
      plantOutside(
        tmpProject,
        'outside_value.gdshader',
        'shader_type canvas_item;\nvoid fragment() {}\n',
      );

      const { stdout } = await runner.executeOperation(
        'batch_scene_operations',
        {
          operations: [
            {
              operation: 'set_node_properties',
              scenePath: 'main.tscn',
              updates: [
                {
                  nodePath: 'root/Sprite2D',
                  property: 'material',
                  value: { type: 'ShaderMaterial', shader: 'res://../outside_value.gdshader' },
                },
              ],
            },
          ],
        },
        tmpProject,
        30000,
      );

      expect(stdout).toContain(ESCAPE_MESSAGE);
      expect(readFileSync(join(tmpProject, 'main.tscn'), 'utf-8')).not.toContain('outside_value');
    },
    60000,
  );

  itGodot(
    'add_node rejects a nodeType that names a script outside the project root',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1]!;
      plantOutside(tmpProject, 'outside_node.gd', 'extends Node2D\n');

      const { stdout, stderr } = await runner.executeOperation(
        'add_node',
        { scenePath: 'main.tscn', nodeType: 'res://../outside_node.gd', nodeName: 'Intruder' },
        tmpProject,
        30000,
      );

      expect(stderr).toContain(ESCAPE_MESSAGE);
      expect(stdout).not.toContain(OPERATION_RESULT_SENTINEL);
      expect(readFileSync(join(tmpProject, 'main.tscn'), 'utf-8')).not.toContain('Intruder');
    },
    60000,
  );

  itGodot(
    'a res:// property value inside the project still loads, however it is spelled',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1]!;
      writeFileSync(join(tmpProject, 'inside_value.gd'), 'extends Node2D\n');

      const { stdout } = await runner.executeOperation(
        'set_node_properties',
        {
          scenePath: 'main.tscn',
          updates: [{ nodePath: 'root', property: 'script', value: 'res://./inside_value.gd' }],
        },
        tmpProject,
        30000,
      );

      const [entry] = parseUpdateResults(stdout);
      expect(entry).not.toHaveProperty('error');
      expect(entry?.success).toBe(true);
      expect(readFileSync(join(tmpProject, 'main.tscn'), 'utf-8')).toContain('inside_value.gd');
    },
    60000,
  );

  itGodot(
    'ordinary project-relative paths are unaffected',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1]!;

      const { stdout } = await runner.executeOperation(
        'add_node',
        { scenePath: './main.tscn', nodeType: 'Node2D', nodeName: 'Plain' },
        tmpProject,
        30000,
      );

      expect(stdout).toContain(OPERATION_RESULT_SENTINEL);
      expect(readFileSync(join(tmpProject, 'main.tscn'), 'utf-8')).toContain('Plain');
    },
    60000,
  );
});
