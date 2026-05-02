import { describe, it, expect } from 'vitest';
import {
  handleDeleteNode,
  handleSetNodeProperty,
  handleGetNodeProperties,
  handleAttachScript,
  handleGetSceneTree,
  handleDuplicateNode,
  handleConnectSignal,
  handleDisconnectSignal,
  handleBatchSetNodeProperties,
  handleBatchGetNodeProperties,
  handleGetNodeSignals,
} from '../../../src/tools/node-tools.js';
import { createFakeRunner } from '../../helpers/fake-runner.js';
import { hasError } from '../../helpers/assertions.js';
import { fixtureProjectPath, fixtureScenePath } from '../../helpers/fixture-paths.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const validBase = { projectPath: fixtureProjectPath, scenePath: fixtureScenePath };

// ---------------------------------------------------------------------------
// handleDeleteNode
// ---------------------------------------------------------------------------

describe('handleDeleteNode', () => {
  it('rejects missing projectPath', async () => {
    const fake = createFakeRunner();
    const result = await handleDeleteNode(fake.asRunner, {
      scenePath: fixtureScenePath,
      nodePath: 'root/Node',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects projectPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleDeleteNode(fake.asRunner, {
      projectPath: '../evil',
      scenePath: fixtureScenePath,
      nodePath: 'root/Node',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects nonexistent project', async () => {
    const fake = createFakeRunner();
    const result = await handleDeleteNode(fake.asRunner, {
      projectPath: '/ghost',
      scenePath: fixtureScenePath,
      nodePath: 'root/Node',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects missing nodePath', async () => {
    const fake = createFakeRunner();
    const result = await handleDeleteNode(fake.asRunner, validBase);
    expect(hasError(result)).toBe(true);
  });

  it('rejects nodePath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleDeleteNode(fake.asRunner, {
      ...validBase,
      nodePath: '../escape',
    });
    expect(hasError(result)).toBe(true);
  });

  it('treats empty Godot output as a failed operation', async () => {
    const fake = createFakeRunner({ stdout: '' });
    const result = await handleDeleteNode(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Node',
    });
    expect(hasError(result)).toBe(true);
  });

  it('surfaces runner exceptions as a structured MCP error response', async () => {
    const fake = createFakeRunner({ throws: new Error('boom') });
    const result = await handleDeleteNode(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Node',
    });
    expect(hasError(result)).toBe(true);
  });

  it('returns parsed result on successful runner output', async () => {
    const fake = createFakeRunner({
      stdout: "Node 'root/Sprite2D' deleted successfully",
    });
    const result = await handleDeleteNode(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Sprite2D',
    });
    expect(hasError(result)).toBe(false);
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain('deleted successfully');
  });
});

// ---------------------------------------------------------------------------
// handleSetNodeProperty
// ---------------------------------------------------------------------------

describe('handleSetNodeProperty', () => {
  it('rejects missing projectPath', async () => {
    const fake = createFakeRunner();
    const result = await handleSetNodeProperty(fake.asRunner, {
      scenePath: fixtureScenePath,
      nodePath: 'root/Node',
      property: 'visible',
      value: true,
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects projectPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleSetNodeProperty(fake.asRunner, {
      projectPath: '../evil',
      scenePath: fixtureScenePath,
      nodePath: 'root/Node',
      property: 'visible',
      value: true,
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects nonexistent project', async () => {
    const fake = createFakeRunner();
    const result = await handleSetNodeProperty(fake.asRunner, {
      projectPath: '/ghost',
      scenePath: fixtureScenePath,
      nodePath: 'root/Node',
      property: 'visible',
      value: true,
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects missing nodePath', async () => {
    const fake = createFakeRunner();
    const result = await handleSetNodeProperty(fake.asRunner, {
      ...validBase,
      property: 'visible',
      value: true,
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects missing property', async () => {
    const fake = createFakeRunner();
    const result = await handleSetNodeProperty(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Node',
      value: true,
    });
    expect(hasError(result)).toBe(true);
  });

  it('treats empty Godot output as a failed operation', async () => {
    const fake = createFakeRunner({ stdout: '' });
    const result = await handleSetNodeProperty(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Node',
      property: 'visible',
      value: true,
    });
    expect(hasError(result)).toBe(true);
  });

  it('surfaces runner exceptions as a structured MCP error response', async () => {
    const fake = createFakeRunner({ throws: new Error('boom') });
    const result = await handleSetNodeProperty(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Node',
      property: 'visible',
      value: true,
    });
    expect(hasError(result)).toBe(true);
  });

  it('returns parsed result on successful runner output', async () => {
    const fake = createFakeRunner({
      stdout: "Property 'position' updated successfully on node 'root/Sprite2D'",
    });
    const result = await handleSetNodeProperty(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Sprite2D',
      property: 'position',
      value: { x: 1, y: 2 },
    });
    expect(hasError(result)).toBe(false);
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain('updated successfully');
  });
});

// ---------------------------------------------------------------------------
// handleGetNodeProperties
// ---------------------------------------------------------------------------

describe('handleGetNodeProperties', () => {
  it('rejects missing projectPath', async () => {
    const fake = createFakeRunner();
    const result = await handleGetNodeProperties(fake.asRunner, {
      scenePath: fixtureScenePath,
      nodePath: 'root/Node',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects projectPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleGetNodeProperties(fake.asRunner, {
      projectPath: '../evil',
      scenePath: fixtureScenePath,
      nodePath: 'root/Node',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects nonexistent project', async () => {
    const fake = createFakeRunner();
    const result = await handleGetNodeProperties(fake.asRunner, {
      projectPath: '/ghost',
      scenePath: fixtureScenePath,
      nodePath: 'root/Node',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects missing nodePath', async () => {
    const fake = createFakeRunner();
    const result = await handleGetNodeProperties(fake.asRunner, validBase);
    expect(hasError(result)).toBe(true);
  });

  it('treats empty Godot output as a failed operation', async () => {
    const fake = createFakeRunner({ stdout: '' });
    const result = await handleGetNodeProperties(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Node',
    });
    expect(hasError(result)).toBe(true);
  });

  it('surfaces runner exceptions as a structured MCP error response', async () => {
    const fake = createFakeRunner({ throws: new Error('boom') });
    const result = await handleGetNodeProperties(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Node',
    });
    expect(hasError(result)).toBe(true);
  });

  it('returns parsed result on successful runner output', async () => {
    const fake = createFakeRunner({
      stdout: '{"nodePath":"root","nodeType":"Node2D","properties":{"position":{"x":0,"y":0}}}',
    });
    const result = await handleGetNodeProperties(fake.asRunner, {
      ...validBase,
      nodePath: 'root',
    });
    expect(hasError(result)).toBe(false);
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.nodePath).toBe('root');
    expect(parsed.nodeType).toBe('Node2D');
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
    expect(hasError(result)).toBe(true);
  });

  it('rejects projectPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleAttachScript(fake.asRunner, {
      projectPath: '../evil',
      scenePath: fixtureScenePath,
      nodePath: 'root/Node',
      scriptPath: 'player.gd',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects nonexistent project', async () => {
    const fake = createFakeRunner();
    const result = await handleAttachScript(fake.asRunner, {
      projectPath: '/ghost',
      scenePath: fixtureScenePath,
      nodePath: 'root/Node',
      scriptPath: 'player.gd',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects missing nodePath', async () => {
    const fake = createFakeRunner();
    const result = await handleAttachScript(fake.asRunner, {
      ...validBase,
      scriptPath: 'player.gd',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects missing scriptPath', async () => {
    const fake = createFakeRunner();
    const result = await handleAttachScript(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Node',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects scriptPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleAttachScript(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Node',
      scriptPath: '../outside.gd',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects nonexistent script file', async () => {
    const fake = createFakeRunner();
    const result = await handleAttachScript(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Node',
      scriptPath: 'nonexistent_script.gd',
    });
    expect(hasError(result)).toBe(true);
  });

  it('surfaces runner exceptions as a structured MCP error response', async () => {
    const fake = createFakeRunner({ throws: new Error('boom') });
    const result = await handleAttachScript(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Node',
      scriptPath: 'placeholder.gd',
    });
    expect(hasError(result)).toBe(true);
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
    expect(hasError(result)).toBe(true);
  });

  it('rejects projectPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleGetSceneTree(fake.asRunner, {
      projectPath: '../evil',
      scenePath: fixtureScenePath,
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects nonexistent project', async () => {
    const fake = createFakeRunner();
    const result = await handleGetSceneTree(fake.asRunner, {
      projectPath: '/ghost',
      scenePath: fixtureScenePath,
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects parentPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleGetSceneTree(fake.asRunner, {
      ...validBase,
      parentPath: '../root',
    });
    expect(hasError(result)).toBe(true);
  });

  it('treats empty Godot output as a failed operation', async () => {
    const fake = createFakeRunner({ stdout: '' });
    const result = await handleGetSceneTree(fake.asRunner, validBase);
    expect(hasError(result)).toBe(true);
  });

  it('surfaces runner exceptions as a structured MCP error response', async () => {
    const fake = createFakeRunner({ throws: new Error('boom') });
    const result = await handleGetSceneTree(fake.asRunner, validBase);
    expect(hasError(result)).toBe(true);
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
    expect(hasError(result)).toBe(true);
  });

  it('rejects projectPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleDuplicateNode(fake.asRunner, {
      projectPath: '../evil',
      scenePath: fixtureScenePath,
      nodePath: 'root/Node',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects nonexistent project', async () => {
    const fake = createFakeRunner();
    const result = await handleDuplicateNode(fake.asRunner, {
      projectPath: '/ghost',
      scenePath: fixtureScenePath,
      nodePath: 'root/Node',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects missing nodePath', async () => {
    const fake = createFakeRunner();
    const result = await handleDuplicateNode(fake.asRunner, validBase);
    expect(hasError(result)).toBe(true);
  });

  it('rejects targetParentPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleDuplicateNode(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Node',
      targetParentPath: '../escape',
    });
    expect(hasError(result)).toBe(true);
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
    expect(hasError(result)).toBe(true);
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
    expect(hasError(result)).toBe(true);
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
    expect(hasError(result)).toBe(true);
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
    expect(hasError(result)).toBe(true);
  });

  it('rejects missing nodePath', async () => {
    const fake = createFakeRunner();
    const result = await handleConnectSignal(fake.asRunner, {
      ...validBase,
      signal: 'pressed',
      targetNodePath: 'root/Label',
      method: '_on_pressed',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects missing signal', async () => {
    const fake = createFakeRunner();
    const result = await handleConnectSignal(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Button',
      targetNodePath: 'root/Label',
      method: '_on_pressed',
    });
    expect(hasError(result)).toBe(true);
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
    expect(hasError(result)).toBe(true);
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
    expect(hasError(result)).toBe(true);
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
    expect(hasError(result)).toBe(true);
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
    expect(hasError(result)).toBe(true);
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
    expect(hasError(result)).toBe(true);
  });

  it('rejects missing nodePath', async () => {
    const fake = createFakeRunner();
    const result = await handleDisconnectSignal(fake.asRunner, {
      ...validBase,
      signal: 'pressed',
      targetNodePath: 'root/Label',
      method: '_on_pressed',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects missing signal', async () => {
    const fake = createFakeRunner();
    const result = await handleDisconnectSignal(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Button',
      targetNodePath: 'root/Label',
      method: '_on_pressed',
    });
    expect(hasError(result)).toBe(true);
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
    expect(hasError(result)).toBe(true);
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
    expect(hasError(result)).toBe(true);
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
// handleBatchSetNodeProperties
// ---------------------------------------------------------------------------

describe('handleBatchSetNodeProperties', () => {
  const validUpdates = [{ nodePath: 'root/Sprite2D', property: 'visible', value: true }];

  it('rejects missing projectPath', async () => {
    const fake = createFakeRunner();
    const result = await handleBatchSetNodeProperties(fake.asRunner, {
      scenePath: fixtureScenePath,
      updates: validUpdates,
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects projectPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleBatchSetNodeProperties(fake.asRunner, {
      projectPath: '../evil',
      scenePath: fixtureScenePath,
      updates: validUpdates,
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects nonexistent project', async () => {
    const fake = createFakeRunner();
    const result = await handleBatchSetNodeProperties(fake.asRunner, {
      projectPath: '/ghost',
      scenePath: fixtureScenePath,
      updates: validUpdates,
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects missing updates array', async () => {
    const fake = createFakeRunner();
    const result = await handleBatchSetNodeProperties(fake.asRunner, validBase);
    expect(hasError(result)).toBe(true);
  });

  it('treats empty Godot output as a failed operation', async () => {
    const fake = createFakeRunner({ stdout: '' });
    const result = await handleBatchSetNodeProperties(fake.asRunner, {
      ...validBase,
      updates: validUpdates,
    });
    expect(hasError(result)).toBe(true);
  });

  it('surfaces runner exceptions as a structured MCP error response', async () => {
    const fake = createFakeRunner({ throws: new Error('boom') });
    const result = await handleBatchSetNodeProperties(fake.asRunner, {
      ...validBase,
      updates: validUpdates,
    });
    expect(hasError(result)).toBe(true);
  });

  it('returns parsed result on successful runner output', async () => {
    const fake = createFakeRunner({
      stdout: '{"results":[{"nodePath":"root/Sprite2D","property":"visible","success":true}]}',
    });
    const result = await handleBatchSetNodeProperties(fake.asRunner, {
      ...validBase,
      updates: validUpdates,
    });
    expect(hasError(result)).toBe(false);
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.results[0].success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleBatchGetNodeProperties
// ---------------------------------------------------------------------------

describe('handleBatchGetNodeProperties', () => {
  const validNodes = [{ nodePath: 'root' }];

  it('rejects missing projectPath', async () => {
    const fake = createFakeRunner();
    const result = await handleBatchGetNodeProperties(fake.asRunner, {
      scenePath: fixtureScenePath,
      nodes: validNodes,
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects projectPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleBatchGetNodeProperties(fake.asRunner, {
      projectPath: '../evil',
      scenePath: fixtureScenePath,
      nodes: validNodes,
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects nonexistent project', async () => {
    const fake = createFakeRunner();
    const result = await handleBatchGetNodeProperties(fake.asRunner, {
      projectPath: '/ghost',
      scenePath: fixtureScenePath,
      nodes: validNodes,
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects missing nodes array', async () => {
    const fake = createFakeRunner();
    const result = await handleBatchGetNodeProperties(fake.asRunner, validBase);
    expect(hasError(result)).toBe(true);
  });

  it('treats empty Godot output as a failed operation', async () => {
    const fake = createFakeRunner({ stdout: '' });
    const result = await handleBatchGetNodeProperties(fake.asRunner, {
      ...validBase,
      nodes: validNodes,
    });
    expect(hasError(result)).toBe(true);
  });

  it('surfaces runner exceptions as a structured MCP error response', async () => {
    const fake = createFakeRunner({ throws: new Error('boom') });
    const result = await handleBatchGetNodeProperties(fake.asRunner, {
      ...validBase,
      nodes: validNodes,
    });
    expect(hasError(result)).toBe(true);
  });

  it('returns parsed result on successful runner output', async () => {
    const fake = createFakeRunner({
      stdout: '{"results":[{"nodePath":"root","nodeType":"Node2D","properties":{}}]}',
    });
    const result = await handleBatchGetNodeProperties(fake.asRunner, {
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
// handleGetNodeSignals
// ---------------------------------------------------------------------------

describe('handleGetNodeSignals', () => {
  it('rejects missing projectPath', async () => {
    const fake = createFakeRunner();
    const result = await handleGetNodeSignals(fake.asRunner, {
      scenePath: fixtureScenePath,
      nodePath: 'root/Button',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects projectPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleGetNodeSignals(fake.asRunner, {
      projectPath: '../evil',
      scenePath: fixtureScenePath,
      nodePath: 'root/Button',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects nonexistent project', async () => {
    const fake = createFakeRunner();
    const result = await handleGetNodeSignals(fake.asRunner, {
      projectPath: '/ghost',
      scenePath: fixtureScenePath,
      nodePath: 'root/Button',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects missing nodePath', async () => {
    const fake = createFakeRunner();
    const result = await handleGetNodeSignals(fake.asRunner, validBase);
    expect(hasError(result)).toBe(true);
  });

  it('rejects nodePath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleGetNodeSignals(fake.asRunner, {
      ...validBase,
      nodePath: '../escape',
    });
    expect(hasError(result)).toBe(true);
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
    expect(hasError(result)).toBe(true);
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
