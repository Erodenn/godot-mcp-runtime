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

// ---------------------------------------------------------------------------
// Reproduction: instanced children lose their scene provenance when a script
// is attached to them through attach_script.
//
// attach_script (godot_operations.gd) loads the scene, calls node.set_script()
// on the instanced child, then packs+saves via PackedScene.pack(). A plain
// Node.set_script() on an instanced scene child is legal in the Godot editor
// (it serializes as a script override next to instance=ExtResource), but the
// pack path used here drops the instance provenance entirely: the child node
// is re-serialized as a bare class node WITHOUT its inherited children and
// WITHOUT the instance=ExtResource attribute. Consumers of the scene see a
// structurally different tree (missing sub-nodes, missing collision shapes)
// after what appears to be a successful operation.
//
// Invariants pinned below:
// 1. ext_resource ids remain unique per resource across save round-trips
// 2. an instanced child survives attach_script + further save cycles with
//    its instance= link intact AND pointing at the correct PackedScene
// ---------------------------------------------------------------------------

function writeEntitiesScenes(projectDir: string): void {
  writeFileSync(
    join(projectDir, 'child_a.tscn'),
    '[gd_scene format=3]\n\n' +
      '[node name="ChildA" type="Node2D"]\n\n' +
      '[node name="Inner" type="Node2D" parent="."]\n',
  );
  writeFileSync(
    join(projectDir, 'child_b.tscn'),
    '[gd_scene format=3]\n\n' +
      '[node name="ChildB" type="Node2D"]\n\n' +
      '[node name="Inner" type="Node2D" parent="."]\n',
  );
}

function writeScriptFile(projectDir: string, name: string): void {
  writeFileSync(join(projectDir, name), 'extends Node2D\n');
}

// Position written onto the node inside the instanced child. Deliberately
// distinct from every position already present in the fixture scene (its
// Sprite2D sits at Vector2(50, 50)): a value that collides with one makes the
// serialized-text assertion below unfalsifiable, because the string is found
// whether or not the override actually persisted.
const OVERRIDE_POSITION = { x: 123, y: 456 };
const OVERRIDE_POSITION_TSCN = 'position = Vector2(123, 456)';

/**
 * Structural assertion for the editable-children override form.
 *
 * A corrupt save (owner reassigned to the root instead of editable-instance
 * flags) serializes a second, shadowing node:
 *   [node name="Inner" type="Node2D" parent="A"]
 * A correct override serializes without a type, next to the instance= link:
 *   [node name="Inner" parent="A" index="0"]
 * The corrupted output would leave the loaded scene with TWO Inner children
 * under root/A, so file-text greps alone cannot distinguish them — hence the
 * get_scene_tree check and the idempotency probe below.
 */
async function assertInstancedOverrideRoundTrips(
  tmpProject: string,
  reapplyUpdate: () => Promise<void>,
): Promise<void> {
  const saved = readFileSync(join(tmpProject, 'main.tscn'), 'utf-8');
  expect(saved).toMatch(/\[node name="A"[^\]]*instance=ExtResource\(/);
  expect(saved).toContain(OVERRIDE_POSITION_TSCN);
  // Override form: name + parent, no type, serialized alongside the instance.
  expect(saved).toMatch(/\[node name="Inner" parent="A" index="\d+"\]/);
  // Forbidden: a second shadowing node for Inner.
  expect(saved).not.toMatch(/\[node name="Inner" parent="A" type="/);

  // Reload the saved scene: A must have exactly one Inner, at the override position.
  const { stdout } = await runner.executeOperation(
    'get_scene_tree',
    { scenePath: 'main.tscn' },
    tmpProject,
    30000,
  );
  const tree = JSON.parse(extractJson(stdout));
  // get_scene_tree's JSON root IS the scene root node (e.g. "Main").
  const a = (tree.children ?? []).find((n: { name: string }) => n.name === 'A');
  expect(a).toBeDefined();
  const inners = (a!.children ?? []).filter((n: { name: string }) => n.name === 'Inner');
  expect(inners).toHaveLength(1);

  // Idempotency: a repeat write to the same path must not destroy the
  // override (the corrupted form degrades to two nodes here, then loses it).
  await reapplyUpdate();
  const resaved = readFileSync(join(tmpProject, 'main.tscn'), 'utf-8');
  expect(resaved).toMatch(/\[node name="Inner" parent="A" index="\d+"\]/);
  expect(resaved).toContain(OVERRIDE_POSITION_TSCN);
  const { stdout: stdout2 } = await runner.executeOperation(
    'get_scene_tree',
    { scenePath: 'main.tscn' },
    tmpProject,
    30000,
  );
  const tree2 = JSON.parse(extractJson(stdout2));
  const a2 = (tree2.children ?? []).find((n: { name: string }) => n.name === 'A');
  const inners2 = (a2!.children ?? []).filter((n: { name: string }) => n.name === 'Inner');
  expect(inners2).toHaveLength(1);
}

describe('set_node_properties on nodes inside instanced children', () => {
  itGodot(
    'set_node_properties persists overrides on instanced-child nodes as editable-children, idempotently',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      writeEntitiesScenes(tmpProject);

      await runner.executeOperation(
        'add_node',
        { scenePath: 'main.tscn', nodeType: 'child_a.tscn', nodeName: 'A' },
        tmpProject,
        30000,
      );
      // Target a node that lives INSIDE the instanced child scene.
      const reapply = () =>
        runner.executeOperation(
          'set_node_properties',
          {
            scenePath: 'main.tscn',
            updates: [{ nodePath: 'root/A/Inner', property: 'position', value: OVERRIDE_POSITION }],
          },
          tmpProject,
          30000,
        );
      const { stdout } = await reapply();

      const parsed = JSON.parse(extractJson(stdout));
      expect(parsed.results[0].error).toBeUndefined();
      await assertInstancedOverrideRoundTrips(tmpProject, reapply);
    },
    180000,
  );

  itGodot(
    'batch_scene_operations set_node_properties persists overrides on instanced-child nodes, idempotently',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      writeEntitiesScenes(tmpProject);

      // Seed: add the instanced child, apply the override, save — one batch.
      await runner.executeOperation(
        'batch_scene_operations',
        {
          operations: [
            {
              operation: 'add_node',
              scenePath: 'main.tscn',
              nodeType: 'child_a.tscn',
              nodeName: 'A',
            },
            {
              operation: 'set_node_properties',
              scenePath: 'main.tscn',
              updates: [
                { nodePath: 'root/A/Inner', property: 'position', value: OVERRIDE_POSITION },
              ],
            },
            { operation: 'save', scenePath: 'main.tscn' },
          ],
        },
        tmpProject,
        30000,
      );

      const reapply = () =>
        runner.executeOperation(
          'batch_scene_operations',
          {
            operations: [
              {
                operation: 'set_node_properties',
                scenePath: 'main.tscn',
                updates: [
                  { nodePath: 'root/A/Inner', property: 'position', value: OVERRIDE_POSITION },
                ],
              },
              { operation: 'save', scenePath: 'main.tscn' },
            ],
          },
          tmpProject,
          30000,
        );
      await reapply();

      await assertInstancedOverrideRoundTrips(tmpProject, reapply);
    },
    180000,
  );
});

describe('ext_resource stability across repeated MCP round-trips', () => {
  itGodot(
    'ids stay unique per resource after many interleaved operations',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      writeEntitiesScenes(tmpProject);

      // Two instanced children plus script attachment — the observed trigger mix.
      await runner.executeOperation(
        'add_node',
        { scenePath: 'main.tscn', nodeType: 'child_a.tscn', nodeName: 'A' },
        tmpProject,
        30000,
      );
      await runner.executeOperation(
        'add_node',
        { scenePath: 'main.tscn', nodeType: 'child_b.tscn', nodeName: 'B' },
        tmpProject,
        30000,
      );
      writeScriptFile(tmpProject, 'new_script.gd');
      await runner.executeOperation(
        'attach_script',
        { scenePath: 'main.tscn', nodePath: 'root/A', scriptPath: 'new_script.gd' },
        tmpProject,
        30000,
      );

      // Re-save via a benign mutation to force another pack/save cycle.
      await runner.executeOperation(
        'add_node',
        { scenePath: 'main.tscn', nodeType: 'Node2D', nodeName: 'Benign' },
        tmpProject,
        30000,
      );

      const saved = readFileSync(join(tmpProject, 'main.tscn'), 'utf-8');
      const ids = [...saved.matchAll(/\[ext_resource[^\]]*\bid="([^"]+)"/g)].map((m) => m[1]);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length); // no two ext_resources share an id
    },
    120000,
  );

  itGodot(
    'instanced children keep their instance= link after attach_script + further saves',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      writeEntitiesScenes(tmpProject);

      await runner.executeOperation(
        'add_node',
        { scenePath: 'main.tscn', nodeType: 'child_a.tscn', nodeName: 'A' },
        tmpProject,
        30000,
      );
      // Overriding the script on an instanced child is legal in the editor;
      // the survival of instance= + inherited children is the invariant.
      writeScriptFile(tmpProject, 'override.gd');
      await runner.executeOperation(
        'attach_script',
        { scenePath: 'main.tscn', nodePath: 'root/A', scriptPath: 'override.gd' },
        tmpProject,
        30000,
      );

      // Further save cycles (delete another node, then re-add) must not strip it.
      await runner.executeOperation(
        'add_node',
        { scenePath: 'main.tscn', nodeType: 'Node2D', nodeName: 'Temp' },
        tmpProject,
        30000,
      );
      await runner.executeOperation(
        'delete_nodes',
        { scenePath: 'main.tscn', nodePaths: ['root/Temp'] },
        tmpProject,
        30000,
      );

      const saved = readFileSync(join(tmpProject, 'main.tscn'), 'utf-8');
      expect(saved).toMatch(/\[node name="A"[^\]]*instance=ExtResource\(/);
      // The ext_resource the instance points at must be the right PackedScene.
      const instanceMatch = saved.match(/\[node name="A"[^\]]*instance=ExtResource\("([^"]+)"\)/);
      expect(instanceMatch).not.toBeNull();
      const id = instanceMatch![1];
      const resLine = saved
        .split('\n')
        .find((l) => l.includes(`id="${id}"`) && l.includes('ext_resource'));
      expect(resLine).toBeDefined();
      expect(resLine!).toContain('type="PackedScene"');
      expect(resLine!).toContain('path="res://child_a.tscn"');
    },
    120000,
  );
});
