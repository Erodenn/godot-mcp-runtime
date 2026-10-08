import { describe, beforeAll, beforeEach, afterAll, expect } from 'vitest';
import { cpSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { removeTmpDir } from '../helpers/tmp.js';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { itGodot } from '../helpers/godot-skip.js';
import { fixtureProjectPath } from '../helpers/fixture-paths.js';
import { minimalPng } from '../helpers/png-fixtures.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import {
  extractJson,
  extractOperationPayload,
  OPERATION_RESULT_SENTINEL,
} from '../../src/utils/output-parsing.js';

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

      expect(stdout).toContain(OPERATION_RESULT_SENTINEL);

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

      expect(stdout).toContain(OPERATION_RESULT_SENTINEL);
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

      // A refused operation resolves with its output; a throw means the engine died or timed out.
      const { stdout, stderr } = await runner.executeOperation(
        'add_node',
        {
          scenePath: 'main.tscn',
          nodeType: 'missing.tscn',
          nodeName: 'Ghost',
        },
        tmpProject,
        30000,
      );

      // Also red when the operation never ran: a misspelled operation name prints no such line.
      expect(stderr).toContain('Scene file does not exist');
      expect(stdout).not.toContain(OPERATION_RESULT_SENTINEL);
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

      expect(stdout).toContain(OPERATION_RESULT_SENTINEL);
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

      let stdout = '';
      let stderr = '';
      try {
        ({ stdout, stderr } = await runner.executeOperation(
          'add_node',
          {
            scenePath: 'main.tscn',
            nodeType: `../${outside.split(/[\/]/).pop()}`,
            nodeName: 'Escaped',
          },
          tmpProject,
          30000,
        ));
      } finally {
        rmSync(outside, { force: true });
      }

      expect(stderr).toContain('escapes the project root');
      expect(stdout).not.toContain(OPERATION_RESULT_SENTINEL);
      expect(readFileSync(join(tmpProject, 'main.tscn'), 'utf-8')).toBe(before);
    },
    60000,
  );

  itGodot(
    'rejects an escaping scene path through batch_scene_operations too',
    async () => {
      // The batch path skips the Node-side path validators, so containment must hold engine-side.
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
      // The batch re-saves surviving scenes, so assert on the node rather than byte-equality.
      const saved = readFileSync(join(tmpProject, 'main.tscn'), 'utf-8');
      expect(saved).not.toContain('BatchEscaped');
      expect(saved).not.toContain('outside.tscn');
    },
    60000,
  );

  itGodot(
    'rejects a second scheme smuggled into the scene path',
    async () => {
      // simplify_path() leaves an embedded "res://" intact.
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

      expect(stdout).toContain(OPERATION_RESULT_SENTINEL);
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

      const { stdout, stderr } = await runner.executeOperation(
        'create_scene',
        { scenePath: 'made.tscn', rootNodeType: 'child.tscn' },
        tmpProject,
        30000,
      );

      expect(stderr).toContain('Failed to instantiate node of type: child.tscn');
      expect(stdout).not.toContain(OPERATION_RESULT_SENTINEL);
      expect(existsSync(join(tmpProject, 'made.tscn'))).toBe(false);
    },
    60000,
  );
});

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

// Distinct from every fixture position (its Sprite2D sits at Vector2(50, 50)): a collision makes the text assertion unfalsifiable.
const OVERRIDE_POSITION = { x: 123, y: 456 };
const OVERRIDE_POSITION_TSCN = 'position = Vector2(123, 456)';

// A corrupt save serializes a second shadowing `[node name="Inner" type="Node2D" parent="A"]`; the correct override has no type.
// File-text greps cannot tell them apart, hence the get_scene_tree check and the idempotency probe.
async function assertInstancedOverrideRoundTrips(
  tmpProject: string,
  reapplyUpdate: () => Promise<void>,
): Promise<void> {
  const saved = readFileSync(join(tmpProject, 'main.tscn'), 'utf-8');
  expect(saved).toMatch(/\[node name="A"[^\]]*instance=ExtResource\(/);
  expect(saved).toContain(OVERRIDE_POSITION_TSCN);
  expect(saved).toMatch(/\[node name="Inner" parent="A" index="\d+"\]/);
  expect(saved).not.toMatch(/\[node name="Inner" parent="A" type="/);

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

  // A repeat write to the same path must not destroy the override (the corrupt form degrades to two nodes, then loses it).
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

      await runner.executeOperation(
        'add_node',
        { scenePath: 'main.tscn', nodeType: 'Node2D', nodeName: 'Benign' },
        tmpProject,
        30000,
      );

      const saved = readFileSync(join(tmpProject, 'main.tscn'), 'utf-8');
      const ids = [...saved.matchAll(/\[ext_resource[^\]]*\bid="([^"]+)"/g)].map((m) => m[1]);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
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
      writeScriptFile(tmpProject, 'override.gd');
      await runner.executeOperation(
        'attach_script',
        { scenePath: 'main.tscn', nodePath: 'root/A', scriptPath: 'override.gd' },
        tmpProject,
        30000,
      );

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

// Nodes inside an instanced scene are not owned by the scene root, so pack() drops edits unless the instance is marked editable.
// The editable mark is read from .tscn text (a reload does not report it), once present and elsewhere absent.

const INSTANCE_CASE_TIMEOUT_MS = 180000;
const INSTANCE_OP_TIMEOUT_MS = 30000;

interface ReloadedNode {
  name: string;
  children: ReloadedNode[] | null;
}

async function runOperation(
  project: string,
  operation: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { stdout, stderr } = await runner.executeOperation(
    operation,
    params,
    project,
    INSTANCE_OP_TIMEOUT_MS,
  );
  // A failed operation emitted no payload; say what it printed so the case fails on that reason, not a JSON syntax error.
  const payload = extractOperationPayload(stdout);
  if (payload === null) {
    throw new Error(`${operation} emitted no payload.\nstdout: ${stdout}\nstderr: ${stderr}`);
  }
  return JSON.parse(payload) as Record<string, unknown>;
}

async function reloadTree(project: string): Promise<ReloadedNode> {
  return (await runOperation(project, 'get_scene_tree', {
    scenePath: 'main.tscn',
  })) as unknown as ReloadedNode;
}

async function reloadedChildNames(project: string, names: string[]): Promise<string[]> {
  let node = await reloadTree(project);
  for (const name of names) {
    const next = (node.children ?? []).find((child) => child.name === name);
    expect(next, `${name} is in the reloaded scene`).toBeDefined();
    node = next!;
  }
  return (node.children ?? []).map((child) => child.name);
}

async function reloadedNode(project: string, nodePath: string): Promise<Record<string, unknown>> {
  const payload = await runOperation(project, 'get_node_properties', {
    scenePath: 'main.tscn',
    nodes: [{ nodePath }],
  });
  return (payload.results as Array<Record<string, unknown>>)[0]!;
}

const EDITABLE_INSTANCE_MARK_PREFIX = '[editable ';
const EDITABLE_INSTANCE_A_MARK = `${EDITABLE_INSTANCE_MARK_PREFIX}path="A"]`;

function savedMainScene(project: string): string {
  return readFileSync(join(project, 'main.tscn'), 'utf-8');
}

async function addInstanceA(project: string): Promise<void> {
  writeEntitiesScenes(project);
  const added = await runOperation(project, 'add_node', {
    scenePath: 'main.tscn',
    nodeType: 'child_a.tscn',
    nodeName: 'A',
  });
  expect(added.nodePath).toBe('root/A');
}

describe('mutations inside instanced children persist or are refused', () => {
  itGodot(
    'load_sprite on a node inside an instance survives a reload',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1]!;
      writeFileSync(
        join(tmpProject, 'child_sprite.tscn'),
        '[gd_scene format=3]\n\n' +
          '[node name="ChildSprite" type="Node2D"]\n\n' +
          '[node name="Pic" type="Sprite2D" parent="."]\n',
      );
      writeFileSync(join(tmpProject, 'pic.png'), minimalPng());
      // The committed placeholder.png is intentionally invalid; give the copy a real one so import does not report an error.
      writeFileSync(join(tmpProject, 'placeholder.png'), minimalPng());
      await runner.importAssets(tmpProject);
      await runOperation(tmpProject, 'add_node', {
        scenePath: 'main.tscn',
        nodeType: 'child_sprite.tscn',
        nodeName: 'A',
      });

      const loaded = await runOperation(tmpProject, 'load_sprite', {
        scenePath: 'main.tscn',
        nodePath: 'root/A/Pic',
        texturePath: 'pic.png',
      });
      expect(loaded.texturePath).toBe('pic.png');

      expect(await reloadedChildNames(tmpProject, ['A'])).toEqual(['Pic']);
      const pic = await reloadedNode(tmpProject, 'root/A/Pic');
      expect(pic).not.toHaveProperty('error');
      expect((pic.properties as Record<string, unknown>).texture).not.toBeNull();
    },
    INSTANCE_CASE_TIMEOUT_MS,
  );

  itGodot(
    'attach_script on a node inside an instance survives a reload',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1]!;
      await addInstanceA(tmpProject);
      writeScriptFile(tmpProject, 'inner_script.gd');

      const attached = await runOperation(tmpProject, 'attach_script', {
        scenePath: 'main.tscn',
        nodePath: 'root/A/Inner',
        scriptPath: 'inner_script.gd',
      });
      expect(attached.scriptPath).toBe('inner_script.gd');

      expect(await reloadedChildNames(tmpProject, ['A'])).toEqual(['Inner']);
      const inner = await reloadedNode(tmpProject, 'root/A/Inner');
      expect(inner).not.toHaveProperty('error');
      expect((inner.properties as Record<string, unknown>).script).not.toBeNull();
    },
    INSTANCE_CASE_TIMEOUT_MS,
  );

  itGodot(
    'add_node under a node inside an instance survives a reload',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1]!;
      await addInstanceA(tmpProject);

      const added = await runOperation(tmpProject, 'add_node', {
        scenePath: 'main.tscn',
        nodeType: 'Node2D',
        nodeName: 'Grown',
        parentNodePath: 'root/A/Inner',
      });
      expect(added.nodePath).toBe('root/A/Inner/Grown');

      expect(await reloadedChildNames(tmpProject, ['A'])).toEqual(['Inner']);
      expect(await reloadedChildNames(tmpProject, ['A', 'Inner'])).toEqual(['Grown']);
      const grown = await reloadedNode(tmpProject, 'root/A/Inner/Grown');
      expect(grown).not.toHaveProperty('error');
      // Positive twin of the "leaves the instance unmarked" case, so that one cannot pass on a marker spelling that never occurs.
      expect(savedMainScene(tmpProject)).toContain(EDITABLE_INSTANCE_A_MARK);
    },
    INSTANCE_CASE_TIMEOUT_MS,
  );

  itGodot(
    'add_node directly under an instance root survives a reload and leaves the instance unmarked',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1]!;
      await addInstanceA(tmpProject);

      const added = await runOperation(tmpProject, 'add_node', {
        scenePath: 'main.tscn',
        nodeType: 'Node2D',
        nodeName: 'Beside',
        parentNodePath: 'root/A',
      });
      expect(added.nodePath).toBe('root/A/Beside');

      const names = await reloadedChildNames(tmpProject, ['A']);
      expect([...names].sort()).toEqual(['Beside', 'Inner']);
      // The instance root is owned by this scene, so it needs no editable mark.
      expect(savedMainScene(tmpProject)).not.toContain(EDITABLE_INSTANCE_MARK_PREFIX);
    },
    INSTANCE_CASE_TIMEOUT_MS,
  );

  itGodot(
    'duplicate_node of a node inside an instance survives a reload',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1]!;
      await addInstanceA(tmpProject);

      const duplicated = await runOperation(tmpProject, 'duplicate_node', {
        scenePath: 'main.tscn',
        nodePath: 'root/A/Inner',
        newName: 'InnerCopy',
      });
      expect(duplicated.newNodePath).toBe('root/A/InnerCopy');

      const names = await reloadedChildNames(tmpProject, ['A']);
      expect(names).toHaveLength(2);
      expect(names).toContain('Inner');
      expect(names).toContain('InnerCopy');
      expect(savedMainScene(tmpProject)).not.toContain(EDITABLE_INSTANCE_MARK_PREFIX);
    },
    INSTANCE_CASE_TIMEOUT_MS,
  );

  itGodot(
    'duplicate_node into a node inside an instance survives a reload',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1]!;
      await addInstanceA(tmpProject);

      // pack() never reaches a child of an instance-owned node unless the instance is editable.
      const duplicated = await runOperation(tmpProject, 'duplicate_node', {
        scenePath: 'main.tscn',
        nodePath: 'root/A/Inner',
        newName: 'InnerCopy',
        targetParentPath: 'root/A/Inner',
      });
      expect(duplicated.newNodePath).toBe('root/A/Inner/InnerCopy');

      expect(await reloadedChildNames(tmpProject, ['A'])).toEqual(['Inner']);
      expect(await reloadedChildNames(tmpProject, ['A', 'Inner'])).toEqual(['InnerCopy']);
    },
    INSTANCE_CASE_TIMEOUT_MS,
  );

  itGodot(
    'delete_nodes refuses a node that belongs to an instanced scene',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1]!;
      await addInstanceA(tmpProject);

      const refused = await runOperation(tmpProject, 'delete_nodes', {
        scenePath: 'main.tscn',
        nodePaths: ['root/A/Inner'],
      });
      const [entry] = refused.results as Array<Record<string, unknown>>;
      expect(entry).not.toHaveProperty('success');
      expect(String(entry!.error)).toMatch(/belongs to an instanced scene/);
      expect(await reloadedChildNames(tmpProject, ['A'])).toEqual(['Inner']);

      const removed = await runOperation(tmpProject, 'delete_nodes', {
        scenePath: 'main.tscn',
        nodePaths: ['root/A'],
      });
      const [removedEntry] = removed.results as Array<Record<string, unknown>>;
      expect(removedEntry).toMatchObject({ nodePath: 'root/A', success: true });
      const tree = await reloadTree(tmpProject);
      expect((tree.children ?? []).map((child) => child.name)).not.toContain('A');
    },
    INSTANCE_CASE_TIMEOUT_MS,
  );

  itGodot(
    'duplicating an instanced child leaves one copy of its inner nodes after a reload',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1]!;
      await addInstanceA(tmpProject);

      const duplicated = await runOperation(tmpProject, 'duplicate_node', {
        scenePath: 'main.tscn',
        nodePath: 'root/A',
        newName: 'A2',
      });
      expect(duplicated.newNodePath).toBe('root/A2');

      // Two Inner children here means the instance's inner nodes were re-owned to the scene root.
      expect(await reloadedChildNames(tmpProject, ['A2'])).toEqual(['Inner']);
      expect(await reloadedChildNames(tmpProject, ['A'])).toEqual(['Inner']);
    },
    INSTANCE_CASE_TIMEOUT_MS,
  );

  itGodot(
    'duplicating an instanced child copies a node this scene added under it',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1]!;
      await addInstanceA(tmpProject);
      await runOperation(tmpProject, 'add_node', {
        scenePath: 'main.tscn',
        nodeType: 'Node2D',
        nodeName: 'Extra',
        parentNodePath: 'root/A',
      });

      const duplicated = await runOperation(tmpProject, 'duplicate_node', {
        scenePath: 'main.tscn',
        nodePath: 'root/A',
        newName: 'A2',
      });
      expect(duplicated.newNodePath).toBe('root/A2');

      // duplicate() copies Extra without an owner, so pack() drops it unless it is re-owned.
      const copied = await reloadedChildNames(tmpProject, ['A2']);
      expect([...copied].sort()).toEqual(['Extra', 'Inner']);
      const original = await reloadedChildNames(tmpProject, ['A']);
      expect([...original].sort()).toEqual(['Extra', 'Inner']);
    },
    INSTANCE_CASE_TIMEOUT_MS,
  );
});
