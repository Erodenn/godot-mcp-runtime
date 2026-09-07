/**
 * Feature tests for scene instancing via add_node.
 *
 * Context: composing scenes by instancing a child scene (`[node ... instance=ExtResource(...)]`)
 * was not expressible through the MCP node tools — agents had to hand-edit the
 * parent .tscn to add `instance=` entries and the matching ext_resource header.
 *
 * The feature: `add_node` accepts a scene path as `nodeType` (e.g. "sub.tscn" or
 * "res://sub.tscn"). The child is `load()`ed and `instantiate()`d; on save,
 * PackedScene.pack() serializes it as `instance=ExtResource(...)`.
 *
 * Rules:
 * - a nonexistent scene path produces an explicit error, adding nothing
 * - a path that exists but is not a scene (wrong suffix) is never treated as one
 * - a path escaping the project root is rejected on both the standalone and
 *   batch paths (Godot resolves `res://../x.tscn` to a real file on disk)
 * - the saved parent scene references the child via instance= ExtResource
 * - ordinary class names keep working unchanged
 * - `create_scene`'s rootNodeType still means a Godot class, not a scene
 *
 * Requires GODOT_PATH. Skipped in CI without it.
 */

import { describe, beforeAll, beforeEach, afterAll, expect } from 'vitest';
import { cpSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
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

function writeChildScene(projectDir: string): void {
  writeFileSync(
    join(projectDir, 'child.tscn'),
    '[gd_scene format=3]\n\n' +
      '[node name="Child" type="Node2D"]\n\n' +
      '[node name="Sprite2D" type="Sprite2D" parent="."]\n' +
      'position = Vector2(10, 10)\n',
  );
}

describe('scene instancing via add_node', () => {
  itGodot(
    'instances an existing scene as a child and serializes it as instance=ExtResource',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      writeChildScene(tmpProject);

      const { stdout } = await runner.executeOperation(
        'add_node',
        {
          scenePath: 'main.tscn',
          nodeType: 'child.tscn',
          nodeName: 'ChildInstance',
        },
        tmpProject,
        30000,
      );

      expect(stdout).toContain('added successfully');

      const saved = readFileSync(join(tmpProject, 'main.tscn'), 'utf-8');
      expect(saved).toMatch(/\[node name="ChildInstance"[^\]]*instance=ExtResource\(/);
      expect(saved).toMatch(/\[ext_resource type="PackedScene" path="res:\/\/child\.tscn"/);
    },
    60000,
  );

  itGodot(
    'instances a scene via res:// path form',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      writeChildScene(tmpProject);

      const { stdout } = await runner.executeOperation(
        'add_node',
        {
          scenePath: 'main.tscn',
          nodeType: 'res://child.tscn',
          nodeName: 'ChildInstance2',
        },
        tmpProject,
        30000,
      );

      expect(stdout).toContain('added successfully');
      const saved = readFileSync(join(tmpProject, 'main.tscn'), 'utf-8');
      expect(saved).toMatch(/instance=ExtResource\(/);
    },
    60000,
  );

  itGodot(
    'errors on a nonexistent scene path and adds nothing',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      const before = readFileSync(join(tmpProject, 'main.tscn'), 'utf-8');

      let stdout = '';
      try {
        const result = await runner.executeOperation(
          'add_node',
          {
            scenePath: 'main.tscn',
            nodeType: 'missing.tscn',
            nodeName: 'Ghost',
          },
          tmpProject,
          30000,
        );
        stdout = result.stdout;
      } catch {
        // acceptable: some engine versions propagate the nonzero exit
      }

      expect(stdout).not.toContain('added successfully');
      const after = readFileSync(join(tmpProject, 'main.tscn'), 'utf-8');
      expect(after).toBe(before);
    },
    60000,
  );

  itGodot(
    'keeps ordinary class names working (no .tscn suffix, no behavior change)',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];

      const { stdout } = await runner.executeOperation(
        'add_node',
        {
          scenePath: 'main.tscn',
          nodeType: 'Node2D',
          nodeName: 'PlainNode',
        },
        tmpProject,
        30000,
      );

      expect(stdout).toContain('added successfully');
      const saved = readFileSync(join(tmpProject, 'main.tscn'), 'utf-8');
      expect(saved).toMatch(/\[node name="PlainNode" type="Node2D"/);
      expect(saved).not.toMatch(/instance=ExtResource/);
    },
    60000,
  );
  itGodot(
    'rejects a scene path that escapes the project root',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      const outside = join(tmpProject, '..', `outside-${randomBytes(4).toString('hex')}.tscn`);
      writeFileSync(outside, '[gd_scene format=3]\n[node name="Outside" type="Node2D"]\n');
      const before = readFileSync(join(tmpProject, 'main.tscn'), 'utf-8');

      try {
        await runner.executeOperation(
          'add_node',
          {
            scenePath: 'main.tscn',
            nodeType: `../${outside.split(/[\/]/).pop()}`,
            nodeName: 'Escaped',
          },
          tmpProject,
          30000,
        );
      } catch {
        // acceptable: the operation exits nonzero on rejection
      } finally {
        rmSync(outside, { force: true });
      }

      expect(readFileSync(join(tmpProject, 'main.tscn'), 'utf-8')).toBe(before);
    },
    60000,
  );

  itGodot(
    'rejects an escaping scene path through batch_scene_operations too',
    async () => {
      // The batch path forwards operations to GDScript without passing through
      // the Node-side path validators, so containment must hold engine-side.
      const tmpProject = tmpDirs[tmpDirs.length - 1];

      const { stdout } = await runner.executeOperation(
        'batch_scene_operations',
        {
          operations: [
            {
              operation: 'add_node',
              scenePath: 'main.tscn',
              nodeType: '../outside.tscn',
              nodeName: 'BatchEscaped',
            },
          ],
        },
        tmpProject,
        30000,
      );

      expect(stdout).toContain('escapes the project root');
      // The batch re-saves surviving scenes, so assert on the node rather than
      // byte-equality: nothing was instanced and no ext_resource was added.
      const saved = readFileSync(join(tmpProject, 'main.tscn'), 'utf-8');
      expect(saved).not.toContain('BatchEscaped');
      expect(saved).not.toContain('outside.tscn');
    },
    60000,
  );

  itGodot(
    'rejects a second scheme smuggled into the scene path',
    async () => {
      // simplify_path() leaves an embedded "res://" intact, so containment
      // would otherwise rest on how the engine rewrites the path later.
      const tmpProject = tmpDirs[tmpDirs.length - 1];

      const { stdout } = await runner.executeOperation(
        'batch_scene_operations',
        {
          operations: [
            {
              operation: 'add_node',
              scenePath: 'main.tscn',
              nodeType: 'res://res://../outside.tscn',
              nodeName: 'SchemeEscaped',
            },
          ],
        },
        tmpProject,
        30000,
      );

      expect(stdout).toContain('escapes the project root');
      const saved = readFileSync(join(tmpProject, 'main.tscn'), 'utf-8');
      expect(saved).not.toContain('SchemeEscaped');
      expect(saved).not.toContain('outside.tscn');
    },
    60000,
  );

  itGodot(
    'matches the scene suffix case-insensitively',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      writeChildScene(tmpProject);
      writeFileSync(
        join(tmpProject, 'Upper.TSCN'),
        readFileSync(join(tmpProject, 'child.tscn'), 'utf-8'),
      );

      const { stdout } = await runner.executeOperation(
        'add_node',
        { scenePath: 'main.tscn', nodeType: 'Upper.TSCN', nodeName: 'UpperKid' },
        tmpProject,
        30000,
      );

      expect(stdout).toContain('added successfully');
      expect(readFileSync(join(tmpProject, 'main.tscn'), 'utf-8')).toMatch(
        /instance=ExtResource\(/,
      );
    },
    60000,
  );

  itGodot(
    'create_scene rootNodeType still means a Godot class, not a scene path',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      writeChildScene(tmpProject);

      let stdout = '';
      try {
        const result = await runner.executeOperation(
          'create_scene',
          { scenePath: 'made.tscn', rootNodeType: 'child.tscn' },
          tmpProject,
          30000,
        );
        stdout = result.stdout;
      } catch {
        // acceptable: the operation exits nonzero
      }

      expect(stdout).not.toContain('created successfully');
      expect(existsSync(join(tmpProject, 'made.tscn'))).toBe(false);
    },
    60000,
  );
});
