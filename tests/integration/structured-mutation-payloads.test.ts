import { describe, beforeAll, beforeEach, afterAll, expect } from 'vitest';
import { cpSync, existsSync, writeFileSync } from 'fs';
import { removeTmpDir } from '../helpers/tmp.js';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { itGodot } from '../helpers/godot-skip.js';
import { fixtureProjectPath } from '../helpers/fixture-paths.js';
import { dropProjectFeatureVersion } from '../helpers/tmp.js';
import { hasError } from '../helpers/assertions.js';
import { minimalPng } from '../helpers/png-fixtures.js';
import { expectMatchesOutputSchema } from '../helpers/schema-assert.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import {
  handleAddNode,
  handleBatchSceneOperations,
  handleCreateScene,
  handleLoadSprite,
  handleSaveScene,
} from '../../src/tools/scene-tools.js';
import {
  handleAttachScript,
  handleConnectSignal,
  handleDeleteNodes,
  handleDisconnectSignal,
  handleDuplicateNode,
  handleGetNodeProperties,
  handleGetNodeSignals,
  handleGetSceneTree,
  handleSetNodeProperties,
} from '../../src/tools/node-tools.js';

const SCENE = 'main.tscn';
const CASE_TIMEOUT_MS = 120000;
/** load_sprite on a fresh tmp project runs the asset import step first. */
const IMPORT_CASE_TIMEOUT_MS = 180000;

interface TreeNode {
  name: string;
  children: TreeNode[];
}

let runner: GodotRunner;
let projectPath: string;
const tmpDirs: string[] = [];

beforeAll(async () => {
  runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
  await runner.detectGodotPath();
});

beforeEach(() => {
  projectPath = join(tmpdir(), `godot-mcp-payloads-${randomBytes(6).toString('hex')}`);
  cpSync(fixtureProjectPath, projectPath, { recursive: true });
  // Exact payloads are asserted; without a stated engine version the newer-engine warning stays out of them on every CI engine.
  dropProjectFeatureVersion(projectPath);
  tmpDirs.push(projectPath);
});

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      removeTmpDir(dir);
    } catch {}
  }
});

async function readNode(nodePath: string): Promise<Record<string, unknown>> {
  const result = await handleGetNodeProperties(runner, {
    projectPath,
    scenePath: SCENE,
    nodes: [{ nodePath }],
  });
  const payload = expectMatchesOutputSchema('get_node_properties', result);
  const [entry] = payload.results as Array<Record<string, unknown>>;
  if (!entry) throw new Error('get_node_properties returned no entry');
  return entry;
}

describe('add_node reports what Godot did', () => {
  itGodot(
    'returns the name, type and path of the node it added',
    async () => {
      const result = await handleAddNode(runner, {
        projectPath,
        scenePath: SCENE,
        nodeType: 'Sprite2D',
        nodeName: 'Probe',
      });
      const payload = expectMatchesOutputSchema('add_node', result);
      expect(payload).toEqual({ nodeName: 'Probe', nodeType: 'Sprite2D', nodePath: 'root/Probe' });

      const read = await readNode(String(payload.nodePath));
      expect(read).not.toHaveProperty('error');
      expect(read.nodeType).toBe('Sprite2D');
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'returns the name Godot assigned when the requested name collides with a sibling',
    async () => {
      const result = await handleAddNode(runner, {
        projectPath,
        scenePath: SCENE,
        nodeType: 'Sprite2D',
        nodeName: 'Sprite2D',
      });
      const payload = expectMatchesOutputSchema('add_node', result);

      expect(typeof payload.nodeName).toBe('string');
      expect(payload.nodeName).not.toBe('Sprite2D');
      expect(payload.nodePath).toBe(`root/${String(payload.nodeName)}`);
      expect(Object.keys(payload)[0]).toBe('warnings');
      expect(payload.warnings).toHaveLength(1);

      const read = await readNode(String(payload.nodePath));
      expect(read).not.toHaveProperty('error');
      expect(read.nodeType).toBe('Sprite2D');

      const tree = expectMatchesOutputSchema(
        'get_scene_tree',
        await handleGetSceneTree(runner, { projectPath, scenePath: SCENE }),
      ) as unknown as TreeNode;
      const childNames = tree.children.map((child) => child.name);
      expect(childNames).toContain('Sprite2D');
      expect(childNames).toContain(payload.nodeName);
    },
    CASE_TIMEOUT_MS,
  );
});

describe('duplicate_node reports where the duplicate is', () => {
  itGodot(
    'returns a newNodePath that resolves in the saved scene',
    async () => {
      const result = await handleDuplicateNode(runner, {
        projectPath,
        scenePath: SCENE,
        nodePath: 'root/Label',
        newName: 'LabelCopy',
      });
      const payload = expectMatchesOutputSchema('duplicate_node', result);
      expect(payload.nodePath).toBe('root/Label');
      expect(payload.newNodePath).toBe('root/LabelCopy');
      expect(payload).not.toHaveProperty('success');

      const read = await readNode(String(payload.newNodePath));
      expect(read).not.toHaveProperty('error');
      expect(read.nodeType).toBe('Label');
    },
    CASE_TIMEOUT_MS,
  );
});

describe('create_scene and attach_script carry no constant success field', () => {
  itGodot(
    'create_scene answers with the scenePath alone and attach_script with nodePath and scriptPath',
    async () => {
      const created = await handleCreateScene(runner, {
        projectPath,
        scenePath: 'fresh.tscn',
        rootNodeType: 'Node2D',
      });
      const createdPayload = expectMatchesOutputSchema('create_scene', created);
      expect(createdPayload.scenePath).toBe('fresh.tscn');
      expect(createdPayload).not.toHaveProperty('success');

      writeFileSync(join(projectPath, 'plain.gd'), 'extends Node2D\n', 'utf-8');
      const attached = await handleAttachScript(runner, {
        projectPath,
        scenePath: 'fresh.tscn',
        nodePath: 'root',
        scriptPath: 'plain.gd',
      });
      const attachedPayload = expectMatchesOutputSchema('attach_script', attached);
      expect(attachedPayload.scriptPath).toBe('plain.gd');
      expect(attachedPayload).not.toHaveProperty('success');
    },
    CASE_TIMEOUT_MS,
  );
});

describe('connect_signal and disconnect_signal read the connection back from the saved scene', () => {
  const connection = {
    nodePath: 'root',
    signal: 'tree_exiting',
    targetNodePath: 'root/Label',
    method: 'queue_free',
  };

  async function connectionExists(): Promise<boolean> {
    const result = await handleGetNodeSignals(runner, {
      projectPath,
      scenePath: SCENE,
      nodePath: connection.nodePath,
    });
    const payload = expectMatchesOutputSchema('get_node_signals', result);
    const signals = payload.signals as Array<{
      name: string;
      connections: Array<{ target: string; method: string }>;
    }>;
    const entry = signals.find((candidate) => candidate.name === connection.signal);
    return (entry?.connections ?? []).some(
      (c) => c.target === connection.targetNodePath && c.method === connection.method,
    );
  }

  itGodot(
    'reports connected: true after a connect and connected: false after the disconnect',
    async () => {
      const connected = expectMatchesOutputSchema(
        'connect_signal',
        await handleConnectSignal(runner, { projectPath, scenePath: SCENE, ...connection }),
      );
      expect(connected).toEqual({ ...connection, connected: true });
      expect(await connectionExists()).toBe(true);

      const disconnected = expectMatchesOutputSchema(
        'disconnect_signal',
        await handleDisconnectSignal(runner, { projectPath, scenePath: SCENE, ...connection }),
      );
      expect(disconnected).toEqual({ ...connection, connected: false });
      expect(await connectionExists()).toBe(false);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'refuses to connect the same pair a second time',
    async () => {
      const first = await handleConnectSignal(runner, {
        projectPath,
        scenePath: SCENE,
        ...connection,
      });
      expect(hasError(first)).toBe(false);

      const second = await handleConnectSignal(runner, {
        projectPath,
        scenePath: SCENE,
        ...connection,
      });
      expect(hasError(second)).toBe(true);
      expect(await connectionExists()).toBe(true);
    },
    CASE_TIMEOUT_MS,
  );
});

describe('save_scene reports the file it wrote', () => {
  itGodot(
    'returns the loaded scene and the save-as target, which exists on disk',
    async () => {
      const result = await handleSaveScene(runner, {
        projectPath,
        scenePath: SCENE,
        newPath: 'main_copy.tscn',
      });
      const payload = expectMatchesOutputSchema('save_scene', result);
      expect(payload).toEqual({ scenePath: 'main.tscn', savedScenePath: 'main_copy.tscn' });
      expect(existsSync(join(projectPath, 'main_copy.tscn'))).toBe(true);
    },
    CASE_TIMEOUT_MS,
  );
});

describe('load_sprite reports the texture the node holds', () => {
  itGodot(
    'returns the node and the texture path read back from it',
    async () => {
      // The committed placeholder.png is intentionally invalid; give the copy a real one so the handler's import step can succeed.
      writeFileSync(join(projectPath, 'placeholder.png'), minimalPng());

      const result = await handleLoadSprite(runner, {
        projectPath,
        scenePath: SCENE,
        nodePath: 'root/Sprite2D',
        texturePath: 'placeholder.png',
      });
      const payload = expectMatchesOutputSchema('load_sprite', result);
      expect(payload).toEqual({
        nodePath: 'root/Sprite2D',
        nodeType: 'Sprite2D',
        texturePath: 'placeholder.png',
      });
    },
    IMPORT_CASE_TIMEOUT_MS,
  );
});

interface DepthTreeNode {
  name: string;
  type: string;
  path: string;
  children: DepthTreeNode[] | null;
  childCount?: number;
}

async function addTreeNode(
  nodeType: string,
  nodeName: string,
  parentNodePath: string,
): Promise<void> {
  const result = await handleAddNode(runner, {
    projectPath,
    scenePath: SCENE,
    nodeType,
    nodeName,
    parentNodePath,
  });
  expect(hasError(result), JSON.stringify(result)).toBe(false);
}

function flattenTree(node: DepthTreeNode): DepthTreeNode[] {
  return [node, ...(node.children ?? []).flatMap(flattenTree)];
}

async function readNodes(nodePaths: string[]): Promise<Array<Record<string, unknown>>> {
  const result = await handleGetNodeProperties(runner, {
    projectPath,
    scenePath: SCENE,
    nodes: nodePaths.map((nodePath) => ({ nodePath })),
  });
  const payload = expectMatchesOutputSchema('get_node_properties', result);
  return payload.results as Array<Record<string, unknown>>;
}

async function readTree(extra: Record<string, unknown> = {}): Promise<DepthTreeNode> {
  const result = await handleGetSceneTree(runner, { projectPath, scenePath: SCENE, ...extra });
  return expectMatchesOutputSchema('get_scene_tree', result) as unknown as DepthTreeNode;
}

describe('get_scene_tree reports paths that resolve and what it did not list', () => {
  async function buildDeepScene(): Promise<void> {
    await addTreeNode('Node2D', 'Deep', 'root');
    await addTreeNode('Node2D', 'Leaf', 'root/Deep');
    await addTreeNode('Node2D', 'Inner', 'root/Deep/Leaf');
  }

  itGodot(
    'get_scene_tree paths are in root form and resolve when passed back',
    async () => {
      await buildDeepScene();
      const tree = await readTree();
      expect(tree.path).toBe('root');

      const nodes = flattenTree(tree);
      const paths = nodes.map((node) => node.path);
      expect(paths).toContain('root/Deep');
      expect(paths).toContain('root/Deep/Leaf/Inner');

      const read = await readNodes(paths);
      expect(read).toHaveLength(nodes.length);
      read.forEach((entry, index) => {
        expect(entry, paths[index]).not.toHaveProperty('error');
        expect(entry.nodeType).toBe(nodes[index]!.type);
      });
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'a parentPath subtree reports paths that resolve from the scene root',
    async () => {
      await buildDeepScene();
      const subtree = await readTree({ parentPath: 'root/Deep' });
      expect(subtree.name).toBe('Deep');
      expect(subtree.path).toBe('root/Deep');

      const nodes = flattenTree(subtree);
      expect(nodes.map((node) => node.path)).toEqual([
        'root/Deep',
        'root/Deep/Leaf',
        'root/Deep/Leaf/Inner',
      ]);
      const read = await readNodes(nodes.map((node) => node.path));
      read.forEach((entry, index) => {
        expect(entry, nodes[index]!.path).not.toHaveProperty('error');
        expect(entry.nodeType).toBe(nodes[index]!.type);
      });
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'a node cut by maxDepth has children null, a childCount, and the payload leads with a warning',
    async () => {
      await buildDeepScene();
      const result = await handleGetSceneTree(runner, {
        projectPath,
        scenePath: SCENE,
        maxDepth: 1,
      });
      const tree = expectMatchesOutputSchema('get_scene_tree', result);
      expect(Object.keys(tree)[0]).toBe('warnings');
      const warnings = tree.warnings as string[];
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/maxDepth 1 cut the tree: 1 node\(s\)/);

      const children = tree.children as DepthTreeNode[];
      const deep = children.find((child) => child.name === 'Deep')!;
      expect(deep.children).toBeNull();
      expect(deep.childCount).toBe(1);
      const label = children.find((child) => child.name === 'Label')!;
      expect(label.children).toEqual([]);
      expect(label).not.toHaveProperty('childCount');
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'a leaf at the depth limit has an empty children array',
    async () => {
      const result = await handleGetSceneTree(runner, {
        projectPath,
        scenePath: SCENE,
        maxDepth: 1,
      });
      const tree = expectMatchesOutputSchema('get_scene_tree', result);
      expect(tree).not.toHaveProperty('warnings');
      const children = tree.children as DepthTreeNode[];
      expect(children.length).toBeGreaterThan(0);
      for (const child of children) expect(child.children).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );
});

describe('abortOnError lists what it did not attempt', () => {
  itGodot(
    'abortOnError marks the updates it did not attempt as skipped',
    async () => {
      const result = await handleSetNodeProperties(runner, {
        projectPath,
        scenePath: SCENE,
        abortOnError: true,
        updates: [
          { nodePath: 'root/Label', property: 'text', value: 'first' },
          { nodePath: 'root/NoSuchNode', property: 'text', value: 'broken' },
          { nodePath: 'root/Sprite2D', property: 'visible', value: false },
          { nodePath: 'root/Label', property: 'text', value: 'last' },
        ],
      });
      const payload = expectMatchesOutputSchema('set_node_properties', result);
      const results = payload.results as Array<Record<string, unknown>>;
      expect(results).toHaveLength(4);
      expect(results[0]).toMatchObject({ nodePath: 'root/Label', success: true });
      expect(results[1]).toHaveProperty('error');
      expect(results[2]).toEqual({ nodePath: 'root/Sprite2D', property: 'visible', skipped: true });
      expect(results[3]).toEqual({ nodePath: 'root/Label', property: 'text', skipped: true });

      const [label] = await readNodes(['root/Label']);
      expect((label!.properties as Record<string, unknown>).text).toBe('first');
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'a batch stopped by abortOnError marks the remaining operations as skipped',
    async () => {
      const result = await handleBatchSceneOperations(runner, {
        projectPath,
        abortOnError: true,
        operations: [
          { operation: 'add_node', scenePath: SCENE, nodeType: 'Node2D', nodeName: 'Landed' },
          { operation: 'add_node', scenePath: SCENE, nodeType: 'NoSuchClass', nodeName: 'Broken' },
          { operation: 'add_node', scenePath: SCENE, nodeType: 'Node2D', nodeName: 'NeverRan' },
          { operation: 'save', scenePath: SCENE },
        ],
      });
      const payload = expectMatchesOutputSchema('batch_scene_operations', result);
      const results = payload.results as Array<Record<string, unknown>>;
      expect(results).toHaveLength(4);
      expect(results[0]).toMatchObject({ operation: 'add_node', success: true });
      expect(results[1]).toHaveProperty('error');
      expect(results[2]).toEqual({ operation: 'add_node', scenePath: SCENE, skipped: true });
      expect(results[3]).toEqual({ operation: 'save', scenePath: SCENE, skipped: true });

      const [landed, neverRan] = await readNodes(['root/Landed', 'root/NeverRan']);
      expect(landed).not.toHaveProperty('error');
      expect(neverRan).toHaveProperty('error');
    },
    CASE_TIMEOUT_MS,
  );
});

describe('per-item entries report where a node path led', () => {
  itGodot(
    'delete_nodes, set_node_properties and a batch entry carry resolvedNodePath for a found node',
    async () => {
      const set = await handleSetNodeProperties(runner, {
        projectPath,
        scenePath: SCENE,
        updates: [{ nodePath: 'root/Label', property: 'text', value: 'resolved' }],
      });
      const setPayload = expectMatchesOutputSchema('set_node_properties', set);
      const [setEntry] = setPayload.results as Array<Record<string, unknown>>;
      expect(setEntry).toMatchObject({ nodePath: 'root/Label', resolvedNodePath: 'root/Label' });

      const batch = await handleBatchSceneOperations(runner, {
        projectPath,
        operations: [
          {
            operation: 'set_node_properties',
            scenePath: SCENE,
            updates: [
              { nodePath: 'root/Label', property: 'text', value: 'batched' },
              { nodePath: 'root/NoSuchNode', property: 'text', value: 'x' },
            ],
          },
        ],
      });
      const batchPayload = expectMatchesOutputSchema('batch_scene_operations', batch);
      const [batchEntry] = batchPayload.results as Array<Record<string, unknown>>;
      const updates = batchEntry!.updates as Array<Record<string, unknown>>;
      expect(updates[0]).toMatchObject({ nodePath: 'root/Label', resolvedNodePath: 'root/Label' });
      expect(updates[1]).not.toHaveProperty('resolvedNodePath');

      const deleted = await handleDeleteNodes(runner, {
        projectPath,
        scenePath: SCENE,
        nodePaths: ['root/Sprite2D', 'root/NoSuchNode'],
      });
      const deletedPayload = expectMatchesOutputSchema('delete_nodes', deleted);
      const entries = deletedPayload.results as Array<Record<string, unknown>>;
      expect(entries[0]).toMatchObject({
        nodePath: 'root/Sprite2D',
        resolvedNodePath: 'root/Sprite2D',
      });
      expect(entries[1]).not.toHaveProperty('resolvedNodePath');
    },
    CASE_TIMEOUT_MS,
  );
});
