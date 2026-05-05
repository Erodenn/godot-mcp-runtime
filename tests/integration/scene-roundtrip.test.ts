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

import { describe, beforeAll, beforeEach, afterAll, expect } from 'vitest';
import { cpSync, rmSync, readFileSync, writeFileSync } from 'fs';
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

// --- bug-fix regression coverage ---

describe('add_node coerces dict properties (Bug #1)', () => {
  const tmpDirs: string[] = [];
  let tmpProject: string;

  beforeEach(() => {
    tmpProject = makeTmpProject();
    tmpDirs.push(tmpProject);
  });

  afterAll(() => cleanup(tmpDirs));

  itGodot(
    'persists Vector2 position, scale, and Color modulate from {x,y}/{r,g,b,a} dicts',
    async () => {
      await runner.executeOperation(
        'add_node',
        {
          scenePath: 'main.tscn',
          nodeType: 'Sprite2D',
          nodeName: 'CoercedSprite',
          properties: {
            position: { x: 100, y: 200 },
            scale: { x: 2, y: 3 },
            modulate: { r: 1, g: 0.5, b: 0.25, a: 1 },
          },
        },
        tmpProject,
        30000,
      );

      const tscnContent = readFileSync(join(tmpProject, 'main.tscn'), 'utf8');
      expect(tscnContent).toMatch(/position = Vector2\(\s*100\s*,\s*200\s*\)/);
      expect(tscnContent).toMatch(/scale = Vector2\(\s*2\s*,\s*3\s*\)/);
      // Color components serialize as floats; just assert the channel values are present
      expect(tscnContent).toMatch(/modulate = Color\(\s*1\s*,\s*0\.5\s*,\s*0\.25\s*,\s*1\s*\)/);
    },
    60000,
  );
});

describe('connect_signal persists with CONNECT_PERSIST (Bug #2)', () => {
  const tmpDirs: string[] = [];
  let tmpProject: string;

  beforeEach(() => {
    tmpProject = makeTmpProject();
    tmpDirs.push(tmpProject);
  });

  afterAll(() => cleanup(tmpDirs));

  itGodot(
    'connect_signal writes a [connection] entry that survives re-pack',
    async () => {
      // Fixture has root Node2D (named "root") with a Label and Sprite2D child.
      // The Label has the queue_free method; root has tree_exiting signal.
      await runner.executeOperation(
        'connect_signal',
        {
          scenePath: 'main.tscn',
          nodePath: 'root',
          signal: 'tree_exiting',
          targetNodePath: 'root/Label',
          method: 'queue_free',
        },
        tmpProject,
        30000,
      );

      const tscnContent = readFileSync(join(tmpProject, 'main.tscn'), 'utf8');
      expect(tscnContent).toMatch(
        /\[connection\s+signal="tree_exiting"\s+from="\."\s+to="Label"\s+method="queue_free"\s*\]/,
      );
    },
    60000,
  );
});

describe('load_sprite rejects unimported textures with a clear error (Bug #4)', () => {
  const tmpDirs: string[] = [];
  let tmpProject: string;

  beforeEach(() => {
    tmpProject = makeTmpProject();
    tmpDirs.push(tmpProject);
  });

  afterAll(() => cleanup(tmpDirs));

  itGodot(
    'returns a non-empty stderr / non-zero status rather than silently succeeding',
    async () => {
      // Write a fresh 1x1 PNG without an .import sidecar.
      const pngBytes = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
        0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8,
        0xcf, 0xc0, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01, 0xc8, 0xd7, 0x71, 0x6c, 0x00, 0x00, 0x00,
        0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ]);
      writeFileSync(join(tmpProject, 'unimported.png'), pngBytes);

      let threw = false;
      let errorMessage = '';
      try {
        const { stderr } = await runner.executeOperation(
          'load_sprite',
          {
            scenePath: 'main.tscn',
            nodePath: 'root/Sprite2D',
            texturePath: 'unimported.png',
          },
          tmpProject,
          30000,
        );
        // If it didn't throw, we expect stderr to mention the failure
        errorMessage = stderr || '';
      } catch (err) {
        threw = true;
        errorMessage = err instanceof Error ? err.message : String(err);
      }

      // Either a thrown error or a stderr message — but NOT silent success.
      // Tolerate either the new explicit "resource_path" / "Texture2D" guard
      // message, or Godot's lower-level "No loader found" / "Failed to load
      // texture" error.
      expect(threw || errorMessage.length > 0).toBe(true);
      const combined = errorMessage.toLowerCase();
      expect(
        combined.includes('texture') ||
          combined.includes('loader') ||
          combined.includes('resource'),
      ).toBe(true);

      // .tscn must NOT have been mutated to add a texture line.
      const tscnContent = readFileSync(join(tmpProject, 'main.tscn'), 'utf8');
      expect(tscnContent).not.toMatch(/texture\s*=\s*ExtResource/);
    },
    60000,
  );
});

describe('find_node_by_path accepts root-name-prefixed paths (Bug #5)', () => {
  const tmpDirs: string[] = [];
  let tmpProject: string;

  beforeEach(() => {
    tmpProject = makeTmpProject();
    tmpDirs.push(tmpProject);
  });

  afterAll(() => cleanup(tmpDirs));

  itGodot(
    'get_node_properties accepts "root/Label" (literal "root" prefix)',
    async () => {
      const { stdout } = await runner.executeOperation(
        'get_node_properties',
        { scenePath: 'main.tscn', nodes: [{ node_path: 'root/Label' }] },
        tmpProject,
        30000,
      );
      const result = JSON.parse(extractJson(stdout));
      expect(result.results[0]).not.toHaveProperty('error');
    },
    60000,
  );

  itGodot(
    'get_node_properties accepts the actual scene root name ("Main") as first segment',
    async () => {
      // Fixture's scene root is named "Main". Before fix: "Main/Label" was
      // routed verbatim into get_node_or_null, which only resolves descendants
      // and would return null. After fix: first segment matching the root name
      // is stripped.
      const { stdout } = await runner.executeOperation(
        'get_node_properties',
        { scenePath: 'main.tscn', nodes: [{ node_path: 'Main/Label' }] },
        tmpProject,
        30000,
      );
      const result = JSON.parse(extractJson(stdout));
      expect(result.results[0]).not.toHaveProperty('error');
      expect(result.results[0].properties).toHaveProperty('text', 'fixture');
    },
    60000,
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
