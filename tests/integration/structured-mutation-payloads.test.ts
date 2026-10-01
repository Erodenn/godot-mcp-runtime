/**
 * Integration tests for the structured payloads of the headless mutation
 * tools. Each payload field is read back from the engine after the operation,
 * so these run the real handlers against a tmp copy of the fixture project and
 * assert on parsed payloads only, never on .tscn text.
 *
 * Requires GODOT_PATH. Skipped locally when it is unset; CI sets it in the
 * godot-integration job.
 */

import { describe, beforeAll, beforeEach, afterAll, expect } from 'vitest';
import { cpSync, existsSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { itGodot } from '../helpers/godot-skip.js';
import { fixtureProjectPath } from '../helpers/fixture-paths.js';
import { hasError } from '../helpers/assertions.js';
import { minimalPng } from '../helpers/png-fixtures.js';
import { expectMatchesOutputSchema } from '../helpers/schema-assert.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { handleAddNode, handleLoadSprite, handleSaveScene } from '../../src/tools/scene-tools.js';
import {
  handleConnectSignal,
  handleDisconnectSignal,
  handleDuplicateNode,
  handleGetNodeProperties,
  handleGetNodeSignals,
  handleGetSceneTree,
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
  tmpDirs.push(projectPath);
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

/** Read one node back through get_node_properties, by the path a payload reported. */
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
      // The fixture scene already has a child named Sprite2D.
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

      // The reported path addresses the new node in the saved scene, and the
      // sibling that held the name is still there.
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

      const read = await readNode(String(payload.newNodePath));
      expect(read).not.toHaveProperty('error');
      expect(read.nodeType).toBe('Label');
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

  /** Whether get_node_signals, a separate process, sees the connection in the scene file. */
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
      // The committed placeholder.png is intentionally invalid; give the tmp
      // copy a real one so the import step the handler triggers can succeed.
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
