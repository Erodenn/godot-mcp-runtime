import { describe, it, expect } from 'vitest';
import { join } from 'path';
import {
  handleDeleteNodes,
  handleSetNodeProperties,
  handleGetNodeProperties,
  handleAttachScript,
  handleGetSceneTree,
  handleDuplicateNode,
  handleMoveNodes,
  handleConnectSignal,
  handleDisconnectSignal,
  handleGetNodeSignals,
} from '../../../src/tools/node-tools.js';
import { createFakeRunner } from '../../helpers/fake-runner.js';
import { hasError, expectErrorMatching, unwrap } from '../../helpers/assertions.js';
import { fixtureProjectPath, fixtureScenePath } from '../../helpers/fixture-paths.js';
import { expectMatchesOutputSchema } from '../../helpers/schema-assert.js';
import { allToolDefinitions } from '../../../src/server.js';

/** The property names a tool's outputSchema declares for one entry of its `results` array. */
function declaredResultFields(toolName: string): string[] {
  const definition = allToolDefinitions.find((tool) => tool.name === toolName) as
    | { outputSchema?: { properties: { results: { items: { properties: object } } } } }
    | undefined;
  return Object.keys(definition?.outputSchema?.properties.results.items.properties ?? {});
}

const validBase = { projectPath: fixtureProjectPath, scenePath: fixtureScenePath };

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

  it('rejects an empty-string nodePath entry', async () => {
    const fake = createFakeRunner();
    const result = await handleDeleteNodes(fake.asRunner, {
      ...validBase,
      nodePaths: [''],
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
    const text = unwrap(result).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.results[0].success).toBe(true);
  });

  it('declares resolvedNodePath on a result entry and returns the one the engine reported', async () => {
    const fake = createFakeRunner({
      stdout:
        '{"results":[{"nodePath":"%Sprite2D","resolvedNodePath":"root/Sprite2D","success":true}]}',
    });
    const result = await handleDeleteNodes(fake.asRunner, {
      ...validBase,
      nodePaths: ['%Sprite2D'],
    });
    const payload = expectMatchesOutputSchema('delete_nodes', result);
    expect(payload.results).toEqual([
      { nodePath: '%Sprite2D', resolvedNodePath: 'root/Sprite2D', success: true },
    ]);
    expect(declaredResultFields('delete_nodes')).toContain('resolvedNodePath');
  });
});

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
    const text = unwrap(result).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.results[0].success).toBe(true);
  });

  it('declares resolvedNodePath on a result entry and returns the one the engine reported', async () => {
    const entry = {
      nodePath: '%Sprite2D',
      property: 'visible',
      resolvedNodePath: 'root/Sprite2D',
      success: true,
    };
    const fake = createFakeRunner({ stdout: JSON.stringify({ results: [entry] }) });
    const result = await handleSetNodeProperties(fake.asRunner, {
      ...validBase,
      updates: [{ nodePath: '%Sprite2D', property: 'visible', value: false }],
    });
    const payload = expectMatchesOutputSchema('set_node_properties', result);
    expect(payload.results).toEqual([entry]);
    expect(declaredResultFields('set_node_properties')).toContain('resolvedNodePath');
  });

  // Red when an update is checked as spelled and forwarded raw: the runner folds
  // nodePath and node_path onto one key, so the unchecked spelling is the one run.
  it('checks and forwards one spelling of an update whose nodePath is spelled both ways', async () => {
    const SET = { property: 'visible', value: true };
    const refused = createFakeRunner({ stdout: '{"results":[]}' });
    const result = await handleSetNodeProperties(refused.asRunner, {
      ...validBase,
      updates: [{ nodePath: 'root/A', node_path: '../Outside', ...SET }],
    });
    expectErrorMatching(result, /Invalid updates\[0\]\.nodePath/);
    expect(refused.calls).toHaveLength(0);

    const forwarded = createFakeRunner({ stdout: '{"results":[]}' });
    await handleSetNodeProperties(forwarded.asRunner, {
      ...validBase,
      updates: [
        { node_path: 'root/A', nodePath: 'root/B', ...SET },
        { node_path: 'root/C', property: 'meta', value: { node_path: 'kept' } },
      ],
    });
    expect(forwarded.calls[0]?.params.updates).toEqual([
      { nodePath: 'root/B', ...SET },
      { nodePath: 'root/C', property: 'meta', value: { node_path: 'kept' } },
    ]);
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
    const text = unwrap(result).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.results).toHaveLength(2);
  });
});

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

  it('moves a warnings entry the script emitted last to the front, and the outputSchema declares it', async () => {
    // GDScript sorts keys, so `warnings` arrives after `results`.
    const payload = {
      results: [{ nodePath: 'root', nodeType: 'Node2D', properties: {} }],
      warnings: ['changedOnly could not build a default Node2D to compare against'],
    };
    const fake = createFakeRunner({ stdout: JSON.stringify(payload) });
    const result = await handleGetNodeProperties(fake.asRunner, {
      ...validBase,
      nodes: [{ nodePath: 'root', changedOnly: true }],
    });
    const structured = expectMatchesOutputSchema('get_node_properties', result);
    expect(structured).toEqual(payload);
    expect(Object.keys(structured)[0]).toBe('warnings');
    const definition = allToolDefinitions.find((tool) => tool.name === 'get_node_properties') as {
      outputSchema: { properties: Record<string, unknown> };
    };
    expect(Object.keys(definition.outputSchema.properties)).toContain('warnings');
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
    const text = unwrap(result).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.results[0].nodePath).toBe('root');
    expect(parsed.results[0].nodeType).toBe('Node2D');
    expectMatchesOutputSchema('get_node_properties', result);
  });

  // Red when a node item is checked as spelled and forwarded raw.
  it('checks and forwards one spelling of a node item whose keys are spelled both ways', async () => {
    const refused = createFakeRunner({ stdout: '{"results":[]}' });
    const badPath = await handleGetNodeProperties(refused.asRunner, {
      ...validBase,
      nodes: [{ nodePath: 'root', node_path: '../Outside' }],
    });
    expectErrorMatching(badPath, /Invalid nodes\[0\]\.nodePath/);
    const badFlag = await handleGetNodeProperties(refused.asRunner, {
      ...validBase,
      nodes: [{ nodePath: 'root', changedOnly: true, changed_only: 'yes' }],
    });
    expectErrorMatching(badFlag, /nodes\[0\]\.changedOnly must be a boolean/);
    expect(refused.calls).toHaveLength(0);

    const forwarded = createFakeRunner({ stdout: '{"results":[]}' });
    await handleGetNodeProperties(forwarded.asRunner, {
      ...validBase,
      nodes: [{ node_path: 'root/A', nodePath: 'root/B', changed_only: true }],
    });
    expect(forwarded.calls[0]?.params.nodes).toEqual([{ nodePath: 'root/B', changedOnly: true }]);
  });

  it('returns an error response for a payload that carries a load failure', async () => {
    const fake = createFakeRunner({
      stdout: JSON.stringify({ error: 'Failed to load scene: main.tscn', results: [] }),
    });
    const result = await handleGetNodeProperties(fake.asRunner, {
      ...validBase,
      nodes: validNodes,
    });
    expectErrorMatching(result, /Failed to load scene: main\.tscn/);
  });
});

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
      stdout: JSON.stringify({
        nodePath: 'root/Sprite2D',
        scriptPath: 'placeholder.gd',
      }),
    });
    const result = await handleAttachScript(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Sprite2D',
      scriptPath: 'placeholder.gd',
    });
    expect(hasError(result)).toBe(false);
    const env = unwrap(result);
    expect(env.structuredContent).toEqual({
      nodePath: 'root/Sprite2D',
      scriptPath: 'placeholder.gd',
    });
    expect(JSON.parse(env.content[0].text)).toEqual(env.structuredContent);
  });
});

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
    const text = unwrap(result).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.name).toBe('root');
    expect(parsed.type).toBe('Node2D');
    expectMatchesOutputSchema('get_scene_tree', result);
  });
});

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

  // Red when copySignals is dropped before the runner call, or forwarded when the caller omitted it.
  it('forwards copySignals false, and sends nothing when it is omitted', async () => {
    const payload = JSON.stringify({ nodePath: 'root/Node', newNodePath: 'root/Node2' });
    const off = createFakeRunner({ stdout: payload });
    await handleDuplicateNode(off.asRunner, {
      ...validBase,
      nodePath: 'root/Node',
      copy_signals: false,
    });
    expect(off.calls[0]?.params.copySignals).toBe(false);

    const unset = createFakeRunner({ stdout: payload });
    await handleDuplicateNode(unset.asRunner, { ...validBase, nodePath: 'root/Node' });
    expect(unset.calls[0]?.params).not.toHaveProperty('copySignals');
  });

  it('rejects a copySignals that is not a boolean', async () => {
    const fake = createFakeRunner();
    const result = await handleDuplicateNode(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Node',
      copySignals: 'no',
    });
    expectErrorMatching(result, /copySignals/);
    expect(fake.calls).toHaveLength(0);
  });

  it('returns parsed result on successful runner output', async () => {
    const fake = createFakeRunner({
      stdout: JSON.stringify({
        nodePath: 'root/Sprite2D',
        newNodePath: 'root/Sprite2D2',
      }),
    });
    const result = await handleDuplicateNode(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Sprite2D',
    });
    expect(hasError(result)).toBe(false);
    const env = unwrap(result);
    expect(env.structuredContent).toEqual({
      nodePath: 'root/Sprite2D',
      newNodePath: 'root/Sprite2D2',
    });
    expect(JSON.parse(env.content[0].text)).toEqual(env.structuredContent);
    expectMatchesOutputSchema('duplicate_node', result);
  });
});

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
    const connection = {
      nodePath: 'root/Button',
      signal: 'pressed',
      targetNodePath: 'root/Receiver',
      method: '_on_pressed',
      connected: true,
    };
    const fake = createFakeRunner({ stdout: JSON.stringify(connection) });
    const result = await handleConnectSignal(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Button',
      signal: 'pressed',
      targetNodePath: 'root/Receiver',
      method: '_on_pressed',
    });
    expect(expectMatchesOutputSchema('connect_signal', result)).toEqual(connection);
  });

  it('reports connected null with a leading warning when the scene was not read back', async () => {
    const fake = createFakeRunner({
      stdout: JSON.stringify({
        nodePath: 'root/Button',
        signal: 'pressed',
        targetNodePath: 'root/Receiver',
        method: '_on_pressed',
        connected: null,
        warnings: ['not read back'],
      }),
    });
    const result = await handleConnectSignal(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Button',
      signal: 'pressed',
      targetNodePath: 'root/Receiver',
      method: '_on_pressed',
    });
    const payload = expectMatchesOutputSchema('connect_signal', result);
    expect(Object.keys(payload)[0]).toBe('warnings');
    expect(payload.connected).toBeNull();
  });
});

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
    const connection = {
      nodePath: 'root/Button',
      signal: 'pressed',
      targetNodePath: 'root/Receiver',
      method: '_on_pressed',
      connected: false,
    };
    const fake = createFakeRunner({ stdout: JSON.stringify(connection) });
    const result = await handleDisconnectSignal(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Button',
      signal: 'pressed',
      targetNodePath: 'root/Receiver',
      method: '_on_pressed',
    });
    expect(expectMatchesOutputSchema('disconnect_signal', result)).toEqual(connection);
  });
});

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
    const text = unwrap(result).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.nodePath).toBe('root/Button');
    expect(parsed.signals[0].name).toBe('pressed');
  });
});

describe('attach_script accepts every project path spelling', () => {
  it.each([
    ['res://', (p: string) => `res://${p}`],
    ['absolute', (p: string) => join(fixtureProjectPath, p)],
  ] as const)('scenePath and scriptPath as %s are forwarded relative', async (_l, spell) => {
    const fake = createFakeRunner({ stdout: JSON.stringify({}) });
    await handleAttachScript(fake.asRunner, {
      projectPath: fixtureProjectPath,
      scenePath: spell(fixtureScenePath),
      nodePath: 'root/Node',
      scriptPath: spell('placeholder.gd'),
    });
    expect(fake.calls[0]?.params.scenePath).toBe(fixtureScenePath);
    expect(fake.calls[0]?.params.scriptPath).toBe('placeholder.gd');
  });
});

describe('handleMoveNodes', () => {
  const validMoves = [{ nodePath: 'root/A', newParentPath: 'root/B', index: 1 }];

  it('rejects missing projectPath', async () => {
    const fake = createFakeRunner();
    const result = await handleMoveNodes(fake.asRunner, {
      scenePath: fixtureScenePath,
      moves: validMoves,
    });
    expectErrorMatching(result, /projectPath/i);
  });

  it('rejects a missing or empty moves array', async () => {
    const fake = createFakeRunner();
    expectErrorMatching(await handleMoveNodes(fake.asRunner, { ...validBase }), /moves/i);
    expectErrorMatching(
      await handleMoveNodes(fake.asRunner, { ...validBase, moves: [] }),
      /moves/i,
    );
    expect(fake.calls).toHaveLength(0);
  });

  it.each([
    ['an item that is not an object', ['root/A'], /moves\[0\] must be an object/],
    ['an item without a nodePath', [{ index: 0 }], /nodePath is required/],
    [
      'a nodePath containing ..',
      [{ nodePath: 'root/../A', index: 0 }],
      /invalid moves\[0\]\.nodePath|invalid nodePath/i,
    ],
    [
      'a newParentPath containing ..',
      [{ nodePath: 'root/A', newParentPath: 'root/../B' }],
      /invalid newParentPath/i,
    ],
    ['a fractional index', [{ nodePath: 'root/A', index: 1.5 }], /index must be a whole number/],
    ['a string index', [{ nodePath: 'root/A', index: '1' }], /index must be a whole number/],
    [
      'an item with neither newParentPath nor index',
      [{ nodePath: 'root/A' }],
      /needs newParentPath/,
    ],
  ])('rejects %s before starting Godot', async (_label, moves, pattern) => {
    const fake = createFakeRunner();
    const result = await handleMoveNodes(fake.asRunner, { ...validBase, moves });
    expectErrorMatching(result, pattern);
    expect(fake.calls).toHaveLength(0);
  });

  it('names the index of the first bad item', async () => {
    const fake = createFakeRunner();
    const result = await handleMoveNodes(fake.asRunner, {
      ...validBase,
      moves: [{ nodePath: 'root/A', index: 0 }, { index: 2 }],
    });
    expectErrorMatching(result, /moves\[1\]/);
  });

  it('forwards each move with its keys normalized, whichever spelling the caller used', async () => {
    const fake = createFakeRunner({ stdout: JSON.stringify({ results: [] }) });
    await handleMoveNodes(fake.asRunner, {
      ...validBase,
      moves: [
        { node_path: 'root/A', new_parent_path: 'root/B', index: -1 },
        { nodePath: 'root/C', index: 0 },
      ],
    });
    expect(fake.calls[0]?.operation).toBe('move_nodes');
    expect(fake.calls[0]?.params.moves).toEqual([
      { nodePath: 'root/A', newParentPath: 'root/B', index: -1 },
      { nodePath: 'root/C', index: 0 },
    ]);
  });

  it('returns the operation payload, valid against the outputSchema', async () => {
    const payload = {
      warnings: ['moves[0]: the NodePath root/Pad.focus_neighbor_right ("../Peer") led to nothing'],
      results: [
        {
          nodePath: 'root/A',
          resolvedNodePath: 'root/A',
          success: true,
          newNodePath: 'root/B/A',
          index: 1,
        },
        { nodePath: 'root', resolvedNodePath: 'root', error: 'Cannot move the root node' },
      ],
    };
    const fake = createFakeRunner({ stdout: JSON.stringify(payload) });
    const result = await handleMoveNodes(fake.asRunner, { ...validBase, moves: validMoves });
    expect(unwrap(result).structuredContent).toEqual(payload);
    expectMatchesOutputSchema('move_nodes', result);
  });

  it('reports a runner failure as an error response', async () => {
    const fake = createFakeRunner({ throws: new Error('boom') });
    const result = await handleMoveNodes(fake.asRunner, { ...validBase, moves: validMoves });
    expectErrorMatching(result, /boom/);
  });
});
