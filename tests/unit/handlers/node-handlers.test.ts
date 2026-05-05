import { describe, it, expect } from 'vitest';
import {
  handleDeleteNodes,
  handleSetNodeProperties,
  handleGetNodeProperties,
  handleAttachScript,
  handleGetSceneTree,
  handleDuplicateNode,
  handleConnectSignal,
  handleDisconnectSignal,
  handleGetNodeSignals,
} from '../../../src/tools/node-tools.js';
import { createFakeRunner } from '../../helpers/fake-runner.js';
import { hasError, expectErrorMatching } from '../../helpers/assertions.js';
import { fixtureProjectPath, fixtureScenePath } from '../../helpers/fixture-paths.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const validBase = { projectPath: fixtureProjectPath, scenePath: fixtureScenePath };

// ---------------------------------------------------------------------------
// handleDeleteNodes
// ---------------------------------------------------------------------------

describe('handleDeleteNodes', () => {
  it('rejects missing projectPath', async () => {
    const fake = createFakeRunner();
    const result = await handleDeleteNodes(fake.asRunner, {
      scenePath: fixtureScenePath,
      nodePaths: ['root/Node'],
    });
    expectErrorMatching(result, /projectPath/i);
  });

  it('rejects projectPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleDeleteNodes(fake.asRunner, {
      projectPath: '../evil',
      scenePath: fixtureScenePath,
      nodePaths: ['root/Node'],
    });
    expectErrorMatching(result, /invalid project path/i);
  });

  it('rejects nonexistent project', async () => {
    const fake = createFakeRunner();
    const result = await handleDeleteNodes(fake.asRunner, {
      projectPath: '/ghost',
      scenePath: fixtureScenePath,
      nodePaths: ['root/Node'],
    });
    expectErrorMatching(result, /not a valid godot project/i);
  });

  it('rejects missing nodePaths', async () => {
    const fake = createFakeRunner();
    const result = await handleDeleteNodes(fake.asRunner, validBase);
    expectErrorMatching(result, /nodePaths/i);
  });

  it('rejects an empty nodePaths array', async () => {
    const fake = createFakeRunner({ stdout: '{}' });
    const result = await handleDeleteNodes(fake.asRunner, {
      ...validBase,
      nodePaths: [],
    });
    expectErrorMatching(result, /nodePaths/i);
  });

  it('rejects nodePath entry containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleDeleteNodes(fake.asRunner, {
      ...validBase,
      nodePaths: ['../escape'],
    });
    expectErrorMatching(result, /nodePath/i);
  });

  it('treats empty Godot output as a failed operation', async () => {
    const fake = createFakeRunner({ stdout: '' });
    const result = await handleDeleteNodes(fake.asRunner, {
      ...validBase,
      nodePaths: ['root/Node'],
    });
    expect(hasError(result)).toBe(true);
  });

  it('surfaces runner exceptions as a structured MCP error response', async () => {
    const fake = createFakeRunner({ throws: new Error('boom') });
    const result = await handleDeleteNodes(fake.asRunner, {
      ...validBase,
      nodePaths: ['root/Node'],
    });
    expectErrorMatching(result, /boom/);
  });

  it('returns parsed result on successful runner output', async () => {
    const fake = createFakeRunner({
      stdout: '{"results":[{"nodePath":"root/Sprite2D","success":true}]}',
    });
    const result = await handleDeleteNodes(fake.asRunner, {
      ...validBase,
      nodePaths: ['root/Sprite2D'],
    });
    expect(hasError(result)).toBe(false);
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.results[0].success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleSetNodeProperties
// ---------------------------------------------------------------------------

describe('handleSetNodeProperties', () => {
  const validUpdates = [{ nodePath: 'root/Sprite2D', property: 'visible', value: true }];

  it('rejects missing projectPath', async () => {
    const fake = createFakeRunner();
    const result = await handleSetNodeProperties(fake.asRunner, {
      scenePath: fixtureScenePath,
      updates: validUpdates,
    });
    expectErrorMatching(result, /projectPath/i);
  });

  it('rejects projectPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleSetNodeProperties(fake.asRunner, {
      projectPath: '../evil',
      scenePath: fixtureScenePath,
      updates: validUpdates,
    });
    expectErrorMatching(result, /invalid project path/i);
  });

  it('rejects nonexistent project', async () => {
    const fake = createFakeRunner();
    const result = await handleSetNodeProperties(fake.asRunner, {
      projectPath: '/ghost',
      scenePath: fixtureScenePath,
      updates: validUpdates,
    });
    expectErrorMatching(result, /not a valid godot project/i);
  });

  it('rejects missing updates array', async () => {
    const fake = createFakeRunner();
    const result = await handleSetNodeProperties(fake.asRunner, validBase);
    expectErrorMatching(result, /updates/i);
  });

  it('treats empty Godot output as a failed operation', async () => {
    const fake = createFakeRunner({ stdout: '' });
    const result = await handleSetNodeProperties(fake.asRunner, {
      ...validBase,
      updates: validUpdates,
    });
    expect(hasError(result)).toBe(true);
  });

  it('surfaces runner exceptions as a structured MCP error response', async () => {
    const fake = createFakeRunner({ throws: new Error('boom') });
    const result = await handleSetNodeProperties(fake.asRunner, {
      ...validBase,
      updates: validUpdates,
    });
    expectErrorMatching(result, /boom/);
  });

  it('handles single-element updates array', async () => {
    const fake = createFakeRunner({
      stdout: '{"results":[{"nodePath":"root/Sprite2D","property":"visible","success":true}]}',
    });
    const result = await handleSetNodeProperties(fake.asRunner, {
      ...validBase,
      updates: validUpdates,
    });
    expect(hasError(result)).toBe(false);
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.results[0].success).toBe(true);
  });

  it('handles multi-element updates array', async () => {
    const fake = createFakeRunner({
      stdout:
        '{"results":[{"nodePath":"root/A","property":"visible","success":true},{"nodePath":"root/B","property":"visible","success":true}]}',
    });
    const result = await handleSetNodeProperties(fake.asRunner, {
      ...validBase,
      updates: [
        { nodePath: 'root/A', property: 'visible', value: true },
        { nodePath: 'root/B', property: 'visible', value: false },
      ],
    });
    expect(hasError(result)).toBe(false);
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.results).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// handleGetNodeProperties (always-array)
// ---------------------------------------------------------------------------

describe('handleGetNodeProperties', () => {
  const validNodes = [{ nodePath: 'root' }];

  it('rejects missing projectPath', async () => {
    const fake = createFakeRunner();
    const result = await handleGetNodeProperties(fake.asRunner, {
      scenePath: fixtureScenePath,
      nodes: validNodes,
    });
    expectErrorMatching(result, /projectPath/i);
  });

  it('rejects projectPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleGetNodeProperties(fake.asRunner, {
      projectPath: '../evil',
      scenePath: fixtureScenePath,
      nodes: validNodes,
    });
    expectErrorMatching(result, /invalid project path/i);
  });

  it('rejects nonexistent project', async () => {
    const fake = createFakeRunner();
    const result = await handleGetNodeProperties(fake.asRunner, {
      projectPath: '/ghost',
      scenePath: fixtureScenePath,
      nodes: validNodes,
    });
    expectErrorMatching(result, /not a valid godot project/i);
  });

  it('rejects missing nodes array', async () => {
    const fake = createFakeRunner();
    const result = await handleGetNodeProperties(fake.asRunner, validBase);
    expectErrorMatching(result, /nodes/i);
  });

  it('treats empty Godot output as a failed operation', async () => {
    const fake = createFakeRunner({ stdout: '' });
    const result = await handleGetNodeProperties(fake.asRunner, {
      ...validBase,
      nodes: validNodes,
    });
    expect(hasError(result)).toBe(true);
  });

  it('surfaces runner exceptions as a structured MCP error response', async () => {
    const fake = createFakeRunner({ throws: new Error('boom') });
    const result = await handleGetNodeProperties(fake.asRunner, {
      ...validBase,
      nodes: validNodes,
    });
    expectErrorMatching(result, /boom/);
  });

  it('returns parsed result on successful runner output', async () => {
    const fake = createFakeRunner({
      stdout: '{"results":[{"nodePath":"root","nodeType":"Node2D","properties":{}}]}',
    });
    const result = await handleGetNodeProperties(fake.asRunner, {
      ...validBase,
      nodes: validNodes,
    });
    expect(hasError(result)).toBe(false);
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.results[0].nodePath).toBe('root');
    expect(parsed.results[0].nodeType).toBe('Node2D');
  });
});

// ---------------------------------------------------------------------------
// handleAttachScript
// ---------------------------------------------------------------------------

describe('handleAttachScript', () => {
  it('rejects missing projectPath', async () => {
    const fake = createFakeRunner();
    const result = await handleAttachScript(fake.asRunner, {
      scenePath: fixtureScenePath,
      nodePath: 'root/Node',
      scriptPath: 'player.gd',
    });
    expectErrorMatching(result, /projectPath/i);
  });

  it('rejects projectPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleAttachScript(fake.asRunner, {
      projectPath: '../evil',
      scenePath: fixtureScenePath,
      nodePath: 'root/Node',
      scriptPath: 'player.gd',
    });
    expectErrorMatching(result, /invalid project path/i);
  });

  it('rejects nonexistent project', async () => {
    const fake = createFakeRunner();
    const result = await handleAttachScript(fake.asRunner, {
      projectPath: '/ghost',
      scenePath: fixtureScenePath,
      nodePath: 'root/Node',
      scriptPath: 'player.gd',
    });
    expectErrorMatching(result, /not a valid godot project/i);
  });

  it('rejects missing nodePath', async () => {
    const fake = createFakeRunner();
    const result = await handleAttachScript(fake.asRunner, {
      ...validBase,
      scriptPath: 'player.gd',
    });
    expectErrorMatching(result, /nodePath/i);
  });

  it('rejects missing scriptPath', async () => {
    const fake = createFakeRunner();
    const result = await handleAttachScript(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Node',
    });
    expectErrorMatching(result, /scriptPath/i);
  });

  it('rejects scriptPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleAttachScript(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Node',
      scriptPath: '../outside.gd',
    });
    expectErrorMatching(result, /scriptPath|invalid/i);
  });

  it('rejects nonexistent script file', async () => {
    const fake = createFakeRunner();
    const result = await handleAttachScript(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Node',
      scriptPath: 'nonexistent_script.gd',
    });
    expectErrorMatching(result, /script file does not exist/i);
  });

  it('surfaces runner exceptions as a structured MCP error response', async () => {
    const fake = createFakeRunner({ throws: new Error('boom') });
    const result = await handleAttachScript(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Node',
      scriptPath: 'placeholder.gd',
    });
    expectErrorMatching(result, /boom/);
  });

  it('returns parsed result on successful runner output', async () => {
    const fake = createFakeRunner({
      stdout: "Script 'res://placeholder.gd' attached successfully to node 'root/Sprite2D'",
    });
    const result = await handleAttachScript(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Sprite2D',
      scriptPath: 'placeholder.gd',
    });
    expect(hasError(result)).toBe(false);
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain('attached successfully');
  });
});

// ---------------------------------------------------------------------------
// handleGetSceneTree
// ---------------------------------------------------------------------------

describe('handleGetSceneTree', () => {
  it('rejects missing projectPath', async () => {
    const fake = createFakeRunner();
    const result = await handleGetSceneTree(fake.asRunner, { scenePath: fixtureScenePath });
    expectErrorMatching(result, /projectPath/i);
  });

  it('rejects projectPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleGetSceneTree(fake.asRunner, {
      projectPath: '../evil',
      scenePath: fixtureScenePath,
    });
    expectErrorMatching(result, /invalid project path/i);
  });

  it('rejects nonexistent project', async () => {
    const fake = createFakeRunner();
    const result = await handleGetSceneTree(fake.asRunner, {
      projectPath: '/ghost',
      scenePath: fixtureScenePath,
    });
    expectErrorMatching(result, /not a valid godot project/i);
  });

  it('rejects parentPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleGetSceneTree(fake.asRunner, {
      ...validBase,
      parentPath: '../root',
    });
    expectErrorMatching(result, /parentPath/i);
  });

  it('treats empty Godot output as a failed operation', async () => {
    const fake = createFakeRunner({ stdout: '' });
    const result = await handleGetSceneTree(fake.asRunner, validBase);
    expectErrorMatching(result, /scene tree|failed/i);
  });

  it('surfaces runner exceptions as a structured MCP error response', async () => {
    const fake = createFakeRunner({ throws: new Error('boom') });
    const result = await handleGetSceneTree(fake.asRunner, validBase);
    expectErrorMatching(result, /boom/);
  });

  it('returns parsed result on successful runner output', async () => {
    const fake = createFakeRunner({
      stdout: '{"name":"root","type":"Node2D","path":"root","script":"","children":[]}',
    });
    const result = await handleGetSceneTree(fake.asRunner, validBase);
    expect(hasError(result)).toBe(false);
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.name).toBe('root');
    expect(parsed.type).toBe('Node2D');
  });
});

// ---------------------------------------------------------------------------
// handleDuplicateNode
// ---------------------------------------------------------------------------

describe('handleDuplicateNode', () => {
  it('rejects missing projectPath', async () => {
    const fake = createFakeRunner();
    const result = await handleDuplicateNode(fake.asRunner, {
      scenePath: fixtureScenePath,
      nodePath: 'root/Node',
    });
    expectErrorMatching(result, /projectPath/i);
  });

  it('rejects projectPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleDuplicateNode(fake.asRunner, {
      projectPath: '../evil',
      scenePath: fixtureScenePath,
      nodePath: 'root/Node',
    });
    expectErrorMatching(result, /invalid project path/i);
  });

  it('rejects nonexistent project', async () => {
    const fake = createFakeRunner();
    const result = await handleDuplicateNode(fake.asRunner, {
      projectPath: '/ghost',
      scenePath: fixtureScenePath,
      nodePath: 'root/Node',
    });
    expectErrorMatching(result, /not a valid godot project/i);
  });

  it('rejects missing nodePath', async () => {
    const fake = createFakeRunner();
    const result = await handleDuplicateNode(fake.asRunner, validBase);
    expectErrorMatching(result, /nodePath/i);
  });

  it('rejects targetParentPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleDuplicateNode(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Node',
      targetParentPath: '../escape',
    });
    expectErrorMatching(result, /targetParentPath/i);
  });

  it('treats empty Godot output as a failed operation', async () => {
    const fake = createFakeRunner({ stdout: '' });
    const result = await handleDuplicateNode(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Node',
    });
    expect(hasError(result)).toBe(true);
  });

  it('surfaces runner exceptions as a structured MCP error response', async () => {
    const fake = createFakeRunner({ throws: new Error('boom') });
    const result = await handleDuplicateNode(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Node',
    });
    expectErrorMatching(result, /boom/);
  });

  it('returns parsed result on successful runner output', async () => {
    const fake = createFakeRunner({
      stdout: "Node duplicated successfully as 'Sprite2D2'",
    });
    const result = await handleDuplicateNode(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Sprite2D',
    });
    expect(hasError(result)).toBe(false);
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain('duplicated successfully');
  });
});

// ---------------------------------------------------------------------------
// handleConnectSignal
// ---------------------------------------------------------------------------

describe('handleConnectSignal', () => {
  it('rejects missing projectPath', async () => {
    const fake = createFakeRunner();
    const result = await handleConnectSignal(fake.asRunner, {
      scenePath: fixtureScenePath,
      nodePath: 'root/Button',
      signal: 'pressed',
      targetNodePath: 'root/Label',
      method: '_on_pressed',
    });
    expectErrorMatching(result, /projectPath/i);
  });

  it('rejects projectPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleConnectSignal(fake.asRunner, {
      projectPath: '../evil',
      scenePath: fixtureScenePath,
      nodePath: 'root/Button',
      signal: 'pressed',
      targetNodePath: 'root/Label',
      method: '_on_pressed',
    });
    expectErrorMatching(result, /invalid project path/i);
  });

  it('rejects nonexistent project', async () => {
    const fake = createFakeRunner();
    const result = await handleConnectSignal(fake.asRunner, {
      projectPath: '/ghost',
      scenePath: fixtureScenePath,
      nodePath: 'root/Button',
      signal: 'pressed',
      targetNodePath: 'root/Label',
      method: '_on_pressed',
    });
    expectErrorMatching(result, /not a valid godot project/i);
  });

  it('rejects missing nodePath', async () => {
    const fake = createFakeRunner();
    const result = await handleConnectSignal(fake.asRunner, {
      ...validBase,
      signal: 'pressed',
      targetNodePath: 'root/Label',
      method: '_on_pressed',
    });
    expectErrorMatching(result, /nodePath/i);
  });

  it('rejects missing signal', async () => {
    const fake = createFakeRunner();
    const result = await handleConnectSignal(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Button',
      targetNodePath: 'root/Label',
      method: '_on_pressed',
    });
    expectErrorMatching(result, /signal/i);
  });

  it('rejects targetNodePath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleConnectSignal(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Button',
      signal: 'pressed',
      targetNodePath: '../evil',
      method: '_on_pressed',
    });
    expectErrorMatching(result, /nodePath/i);
  });

  it('treats empty Godot output as a failed operation', async () => {
    const fake = createFakeRunner({ stdout: '' });
    const result = await handleConnectSignal(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Button',
      signal: 'pressed',
      targetNodePath: 'root/Label',
      method: '_on_pressed',
    });
    expect(hasError(result)).toBe(true);
  });

  it('surfaces runner exceptions as a structured MCP error response', async () => {
    const fake = createFakeRunner({ throws: new Error('boom') });
    const result = await handleConnectSignal(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Button',
      signal: 'pressed',
      targetNodePath: 'root/Label',
      method: '_on_pressed',
    });
    expectErrorMatching(result, /boom/);
  });

  it('returns parsed result on successful runner output', async () => {
    const fake = createFakeRunner({
      stdout: "Signal 'pressed' connected from 'root/Button' to 'root/Receiver._on_pressed'",
    });
    const result = await handleConnectSignal(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Button',
      signal: 'pressed',
      targetNodePath: 'root/Receiver',
      method: '_on_pressed',
    });
    expect(hasError(result)).toBe(false);
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain('connected');
  });
});

// ---------------------------------------------------------------------------
// handleDisconnectSignal
// ---------------------------------------------------------------------------

describe('handleDisconnectSignal', () => {
  it('rejects missing projectPath', async () => {
    const fake = createFakeRunner();
    const result = await handleDisconnectSignal(fake.asRunner, {
      scenePath: fixtureScenePath,
      nodePath: 'root/Button',
      signal: 'pressed',
      targetNodePath: 'root/Label',
      method: '_on_pressed',
    });
    expectErrorMatching(result, /projectPath/i);
  });

  it('rejects projectPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleDisconnectSignal(fake.asRunner, {
      projectPath: '../evil',
      scenePath: fixtureScenePath,
      nodePath: 'root/Button',
      signal: 'pressed',
      targetNodePath: 'root/Label',
      method: '_on_pressed',
    });
    expectErrorMatching(result, /invalid project path/i);
  });

  it('rejects nonexistent project', async () => {
    const fake = createFakeRunner();
    const result = await handleDisconnectSignal(fake.asRunner, {
      projectPath: '/ghost',
      scenePath: fixtureScenePath,
      nodePath: 'root/Button',
      signal: 'pressed',
      targetNodePath: 'root/Label',
      method: '_on_pressed',
    });
    expectErrorMatching(result, /not a valid godot project/i);
  });

  it('rejects missing nodePath', async () => {
    const fake = createFakeRunner();
    const result = await handleDisconnectSignal(fake.asRunner, {
      ...validBase,
      signal: 'pressed',
      targetNodePath: 'root/Label',
      method: '_on_pressed',
    });
    expectErrorMatching(result, /nodePath/i);
  });

  it('rejects missing signal', async () => {
    const fake = createFakeRunner();
    const result = await handleDisconnectSignal(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Button',
      targetNodePath: 'root/Label',
      method: '_on_pressed',
    });
    expectErrorMatching(result, /signal/i);
  });

  it('rejects targetNodePath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleDisconnectSignal(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Button',
      signal: 'pressed',
      targetNodePath: '../evil',
      method: '_on_pressed',
    });
    expectErrorMatching(result, /nodePath/i);
  });

  it('treats empty Godot output as a failed operation', async () => {
    const fake = createFakeRunner({ stdout: '' });
    const result = await handleDisconnectSignal(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Button',
      signal: 'pressed',
      targetNodePath: 'root/Label',
      method: '_on_pressed',
    });
    expect(hasError(result)).toBe(true);
  });

  it('surfaces runner exceptions as a structured MCP error response', async () => {
    const fake = createFakeRunner({ throws: new Error('boom') });
    const result = await handleDisconnectSignal(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Button',
      signal: 'pressed',
      targetNodePath: 'root/Label',
      method: '_on_pressed',
    });
    expectErrorMatching(result, /boom/);
  });

  it('returns parsed result on successful runner output', async () => {
    const fake = createFakeRunner({
      stdout: "Signal 'pressed' disconnected from 'root/Button' to 'root/Receiver._on_pressed'",
    });
    const result = await handleDisconnectSignal(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Button',
      signal: 'pressed',
      targetNodePath: 'root/Receiver',
      method: '_on_pressed',
    });
    expect(hasError(result)).toBe(false);
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain('disconnected');
  });
});

// ---------------------------------------------------------------------------
// handleGetNodeSignals
// ---------------------------------------------------------------------------

describe('handleGetNodeSignals', () => {
  it('rejects missing projectPath', async () => {
    const fake = createFakeRunner();
    const result = await handleGetNodeSignals(fake.asRunner, {
      scenePath: fixtureScenePath,
      nodePath: 'root/Button',
    });
    expectErrorMatching(result, /projectPath/i);
  });

  it('rejects projectPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleGetNodeSignals(fake.asRunner, {
      projectPath: '../evil',
      scenePath: fixtureScenePath,
      nodePath: 'root/Button',
    });
    expectErrorMatching(result, /invalid project path/i);
  });

  it('rejects nonexistent project', async () => {
    const fake = createFakeRunner();
    const result = await handleGetNodeSignals(fake.asRunner, {
      projectPath: '/ghost',
      scenePath: fixtureScenePath,
      nodePath: 'root/Button',
    });
    expectErrorMatching(result, /not a valid godot project/i);
  });

  it('rejects missing nodePath', async () => {
    const fake = createFakeRunner();
    const result = await handleGetNodeSignals(fake.asRunner, validBase);
    expectErrorMatching(result, /nodePath/i);
  });

  it('rejects nodePath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleGetNodeSignals(fake.asRunner, {
      ...validBase,
      nodePath: '../escape',
    });
    expectErrorMatching(result, /nodePath/i);
  });

  it('treats empty Godot output as a failed operation', async () => {
    const fake = createFakeRunner({ stdout: '' });
    const result = await handleGetNodeSignals(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Button',
    });
    expect(hasError(result)).toBe(true);
  });

  it('surfaces runner exceptions as a structured MCP error response', async () => {
    const fake = createFakeRunner({ throws: new Error('boom') });
    const result = await handleGetNodeSignals(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Button',
    });
    expectErrorMatching(result, /boom/);
  });

  it('returns parsed result on successful runner output', async () => {
    const fake = createFakeRunner({
      stdout:
        '{"nodePath":"root/Button","nodeType":"Button","signals":[{"name":"pressed","connections":[]}]}',
    });
    const result = await handleGetNodeSignals(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Button',
    });
    expect(hasError(result)).toBe(false);
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.nodePath).toBe('root/Button');
    expect(parsed.signals[0].name).toBe('pressed');
  });
});
