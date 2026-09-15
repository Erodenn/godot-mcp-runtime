/**
 * Integration tests for validate_scene_structure.
 *
 * Validates a scene against a structural schema (node types, children hierarchy,
 * required properties). Tests cover:
 * - Valid scenes matching schema
 * - Missing nodes (wrong type at expected path)
 * - Missing properties (property not set or null/empty)
 * - Nested children validation
 */

import { describe, beforeAll, beforeEach, afterAll, expect } from 'vitest';
import { cpSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { itGodot } from '../helpers/godot-skip.js';
import { fixtureProjectPath } from '../helpers/fixture-paths.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';

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
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe('validate_scene_structure', () => {
  itGodot(
    'validates a simple scene with correct root type',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];

      const { stdout } = await runner.executeOperation(
        'validate_scene_structure',
        {
          scenePath: 'main.tscn',
          schema: { type: 'Node2D' },
        },
        tmpProject,
        30000,
      );

      const result = JSON.parse(stdout);
      expect(result.valid).toBe(true);
      expect(result.missingNodes).toEqual([]);
      expect(result.missingProperties).toEqual([]);
    },
    60000,
  );

  itGodot(
    'detects wrong root type',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];

      const { stdout } = await runner.executeOperation(
        'validate_scene_structure',
        {
          scenePath: 'main.tscn',
          schema: { type: 'Control' },
        },
        tmpProject,
        30000,
      );

      const result = JSON.parse(stdout);
      expect(result.valid).toBe(false);
      expect(result.missingNodes.length).toBeGreaterThan(0);
      expect(result.missingNodes[0]?.expected).toBe('Control');
    },
    60000,
  );

  itGodot(
    'validates children hierarchy and required properties',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];

      // Add a CollisionShape2D with shape to the scene first
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

      // Now validate
      const { stdout } = await runner.executeOperation(
        'validate_scene_structure',
        {
          scenePath: 'main.tscn',
          schema: {
            type: 'Node2D',
            children: [{ type: 'CollisionShape2D', hasProperty: 'shape' }],
          },
        },
        tmpProject,
        30000,
      );

      const result = JSON.parse(stdout);
      expect(result.valid).toBe(true);
      expect(result.missingNodes).toEqual([]);
      expect(result.missingProperties).toEqual([]);
    },
    60000,
  );

  itGodot(
    'detects missing property on child node',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];

      // Add CollisionShape2D WITHOUT shape
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

      // Validate expecting shape property
      const { stdout } = await runner.executeOperation(
        'validate_scene_structure',
        {
          scenePath: 'main.tscn',
          schema: {
            type: 'Node2D',
            children: [{ type: 'CollisionShape2D', hasProperty: 'shape' }],
          },
        },
        tmpProject,
        30000,
      );

      const result = JSON.parse(stdout);
      expect(result.valid).toBe(false);
      expect(result.missingProperties.length).toBeGreaterThan(0);
      expect(result.missingProperties[0]?.property).toBe('shape');
    },
    60000,
  );

  itGodot(
    'skips type check when type is omitted',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];

      const { stdout } = await runner.executeOperation(
        'validate_scene_structure',
        {
          scenePath: 'main.tscn',
          schema: {
            children: [{ type: 'Sprite2D' }],
          },
        },
        tmpProject,
        30000,
      );

      const result = JSON.parse(stdout);
      // Should not fail on root type since we didn't specify it
      expect(result.errors).toEqual([]);
    },
    60000,
  );
});
