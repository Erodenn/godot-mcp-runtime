import { describe, beforeAll, beforeEach, afterAll, expect } from 'vitest';
import { cpSync } from 'fs';
import { removeTmpDir } from '../helpers/tmp.js';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { itGodot } from '../helpers/godot-skip.js';
import { fixtureProjectPath } from '../helpers/fixture-paths.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { extractJson } from '../../src/utils/output-parsing.js';

function makeTmpProject(): string {
  const id = randomBytes(6).toString('hex');
  const dst = join(tmpdir(), `godot-mcp-test-${id}`);
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

describe('validate: structure checks', () => {
  itGodot(
    'validates a simple scene with correct root type',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];

      const { stdout } = await runner.executeOperation(
        'validate_checks',
        {
          scenePath: 'main.tscn',
          checks: [{ type: 'structure', schema: { type: 'Node2D' } }],
        },
        tmpProject,
        30000,
      );

      const result = JSON.parse(extractJson(stdout));
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    },
    60000,
  );

  itGodot(
    'detects wrong root type',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];

      const { stdout } = await runner.executeOperation(
        'validate_checks',
        {
          scenePath: 'main.tscn',
          checks: [{ type: 'structure', schema: { type: 'Control' } }],
        },
        tmpProject,
        30000,
      );

      const result = JSON.parse(extractJson(stdout));
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(String(result.errors[0]?.message)).toContain('Control');
    },
    60000,
  );

  itGodot(
    'validates children hierarchy and required properties',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];

      await runner.executeOperation(
        'add_node',
        {
          scenePath: 'main.tscn',
          nodeType: 'CollisionShape2D',
          nodeName: 'TestShape',
          parentNodePath: '.',
          properties: {
            shape: { type: 'RectangleShape2D', size: { x: 100, y: 100 } },
          },
        },
        tmpProject,
        30000,
      );

      const { stdout } = await runner.executeOperation(
        'validate_checks',
        {
          scenePath: 'main.tscn',
          checks: [
            {
              type: 'structure',
              schema: {
                type: 'Node2D',
                children: [{ type: 'CollisionShape2D', hasProperty: 'shape' }],
              },
            },
          ],
        },
        tmpProject,
        30000,
      );

      const result = JSON.parse(extractJson(stdout));
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    },
    60000,
  );

  itGodot(
    'detects missing property on child node',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];

      await runner.executeOperation(
        'add_node',
        {
          scenePath: 'main.tscn',
          nodeType: 'CollisionShape2D',
          nodeName: 'EmptyShape',
          parentNodePath: '.',
        },
        tmpProject,
        30000,
      );

      const { stdout } = await runner.executeOperation(
        'validate_checks',
        {
          scenePath: 'main.tscn',
          checks: [
            {
              type: 'structure',
              schema: {
                type: 'Node2D',
                children: [{ type: 'CollisionShape2D', hasProperty: 'shape' }],
              },
            },
          ],
        },
        tmpProject,
        30000,
      );

      const result = JSON.parse(extractJson(stdout));
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: { message: string }) => e.message.includes('shape'))).toBe(
        true,
      );
    },
    60000,
  );

  itGodot(
    'names the root as root, not root/., on a root type mismatch',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];

      const { stdout } = await runner.executeOperation(
        'validate_checks',
        {
          scenePath: 'main.tscn',
          checks: [{ type: 'structure', schema: { type: 'Control' } }],
        },
        tmpProject,
        30000,
      );

      const result = JSON.parse(extractJson(stdout));
      expect(result.errors).toEqual([
        {
          check: 'structure',
          path: 'root',
          message: 'Expected node of type Control at root, found Node2D',
        },
      ]);
    },
    60000,
  );

  itGodot(
    'names the parent in an unmatched-child error',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];

      const { stdout } = await runner.executeOperation(
        'validate_checks',
        {
          scenePath: 'main.tscn',
          checks: [
            {
              type: 'structure',
              schema: { type: 'Node2D', children: [{ type: 'CollisionShape2D' }] },
            },
          ],
        },
        tmpProject,
        30000,
      );

      const result = JSON.parse(extractJson(stdout));
      expect(result.errors).toEqual([
        {
          check: 'structure',
          path: 'root',
          message: 'No child of type CollisionShape2D under root',
        },
      ]);
    },
    60000,
  );

  itGodot(
    'reports a malformed children entry instead of crashing',
    async () => {
      // Sent straight to the operation, bypassing the handler's schema recursion: the state a batch sub-operation reaches the GDScript layer in.
      const tmpProject = tmpDirs[tmpDirs.length - 1];

      const { stdout } = await runner.executeOperation(
        'validate_checks',
        {
          scenePath: 'main.tscn',
          checks: [{ type: 'structure', schema: { children: ['oops'] } }],
        },
        tmpProject,
        30000,
      );

      const result = JSON.parse(extractJson(stdout));
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(String(result.errors[0].message)).toMatch(/^Invalid schema entry:/);
    },
    60000,
  );

  itGodot(
    'skips type check when type is omitted',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];

      const { stdout } = await runner.executeOperation(
        'validate_checks',
        {
          scenePath: 'main.tscn',
          checks: [{ type: 'structure', schema: { children: [{ type: 'Sprite2D' }] } }],
        },
        tmpProject,
        30000,
      );

      const result = JSON.parse(extractJson(stdout));
      expect(result.errors).toEqual([]);
    },
    60000,
  );
});
