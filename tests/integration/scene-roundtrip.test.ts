/**
 * Integration tests for headless scene mutation round-trips.
 *
 * Each mutating test gets a fresh tmp copy of the fixture project to avoid
 * touching the committed fixture. The auto-save invariant is pinned: every
 * mutation (add_node, set_node_property, delete_node) must persist to disk
 * without an explicit save_scene call.
 *
 * Requires GODOT_PATH. Skipped in CI.
 */

import { describe, beforeAll, beforeEach, afterAll } from 'vitest';
import { cpSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { itGodot } from '../helpers/godot-skip.js';
import { fixtureProjectPath } from '../helpers/fixture-paths.js';
import { GodotRunner, extractJson } from '../../src/utils/godot-runner.js';

// --- tmp project helpers ---

function makeTmpProject(): string {
  const id = randomBytes(6).toString('hex');
  const dst = join(tmpdir(), `godot-mcp-test-${id}`);
  cpSync(fixtureProjectPath, dst, { recursive: true });
  return dst;
}

function cleanup(dirs: string[]) {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
  dirs.length = 0;
}

// --- shared runner ---

let runner: GodotRunner;

beforeAll(async () => {
  runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
  await runner.detectGodotPath();
});

// --- tests ---

describe('add_node round-trip', () => {
  const tmpDirs: string[] = [];
  let tmpProject: string;

  beforeEach(() => {
    tmpProject = makeTmpProject();
    tmpDirs.push(tmpProject);
  });

  afterAll(() => cleanup(tmpDirs));

  itGodot(
    'get_scene_tree reports the new node after add_node',
    async () => {
      await runner.executeOperation(
        'add_node',
        { scenePath: 'main.tscn', nodeType: 'Sprite2D', nodeName: 'TestSprite' },
        tmpProject,
        30000,
      );

      const { stdout } = await runner.executeOperation(
        'get_scene_tree',
        { scenePath: 'main.tscn' },
        tmpProject,
        30000,
      );
      const tree = JSON.parse(extractJson(stdout));

      const allNames = collectNames(tree);
      expect(allNames).toContain('TestSprite');
    },
    60000,
  );

  itGodot(
    'auto-save invariant: add_node persists to .tscn without an explicit save_scene call',
    async () => {
      await runner.executeOperation(
        'add_node',
        { scenePath: 'main.tscn', nodeType: 'Node2D', nodeName: 'AutoSaveProbe' },
        tmpProject,
        30000,
      );

      const tscnContent = readFileSync(join(tmpProject, 'main.tscn'), 'utf8');
      expect(tscnContent).toContain('AutoSaveProbe');
    },
    40000,
  );
});

describe('set_node_properties round-trip', () => {
  const tmpDirs: string[] = [];
  let tmpProject: string;

  beforeEach(() => {
    tmpProject = makeTmpProject();
    tmpDirs.push(tmpProject);
  });

  afterAll(() => cleanup(tmpDirs));

  itGodot(
    'get_node_properties reflects the updated text after set_node_properties on Label',
    async () => {
      await runner.executeOperation(
        'set_node_properties',
        {
          scenePath: 'main.tscn',
          updates: [{ node_path: 'root/Label', property: 'text', value: 'round-trip-value' }],
        },
        tmpProject,
        30000,
      );

      const { stdout } = await runner.executeOperation(
        'get_node_properties',
        { scenePath: 'main.tscn', nodes: [{ node_path: 'root/Label' }] },
        tmpProject,
        30000,
      );
      const result = JSON.parse(extractJson(stdout));
      expect(result.results[0].properties).toHaveProperty('text', 'round-trip-value');
    },
    60000,
  );

  itGodot(
    'auto-save invariant: set_node_properties persists to .tscn without an explicit save_scene call',
    async () => {
      await runner.executeOperation(
        'set_node_properties',
        {
          scenePath: 'main.tscn',
          updates: [{ node_path: 'root/Label', property: 'text', value: 'persisted-text' }],
        },
        tmpProject,
        30000,
      );

      const tscnContent = readFileSync(join(tmpProject, 'main.tscn'), 'utf8');
      expect(tscnContent).toContain('persisted-text');
    },
    40000,
  );
});

describe('delete_nodes round-trip', () => {
  const tmpDirs: string[] = [];
  let tmpProject: string;

  beforeEach(() => {
    tmpProject = makeTmpProject();
    tmpDirs.push(tmpProject);
  });

  afterAll(() => cleanup(tmpDirs));

  itGodot(
    'get_scene_tree no longer lists the node after delete_nodes',
    async () => {
      // Fixture invariant: tests/fixtures/godot-project/main.tscn ships with a Sprite2D
      // child of the root Node2D — fixture.test.ts guards this shape.
      await runner.executeOperation(
        'delete_nodes',
        { scenePath: 'main.tscn', nodePaths: ['root/Sprite2D'] },
        tmpProject,
        30000,
      );

      const { stdout: after } = await runner.executeOperation(
        'get_scene_tree',
        { scenePath: 'main.tscn' },
        tmpProject,
        30000,
      );
      const treeAfter = JSON.parse(extractJson(after));
      expect(collectNames(treeAfter)).not.toContain('Sprite2D');
    },
    60000,
  );

  itGodot(
    'auto-save invariant: delete_nodes removal persists to .tscn without an explicit save_scene call',
    async () => {
      await runner.executeOperation(
        'delete_nodes',
        { scenePath: 'main.tscn', nodePaths: ['root/Sprite2D'] },
        tmpProject,
        30000,
      );

      const tscnContent = readFileSync(join(tmpProject, 'main.tscn'), 'utf8');
      // The Sprite2D node entry should no longer appear in the file
      expect(tscnContent).not.toMatch(/\[node name="Sprite2D"/);
    },
    40000,
  );
});

// --- helpers ---

interface TreeNode {
  name: string;
  children?: TreeNode[];
}

function collectNames(node: TreeNode): string[] {
  const names: string[] = [node.name];
  for (const child of node.children ?? []) {
    names.push(...collectNames(child));
  }
  return names;
}
