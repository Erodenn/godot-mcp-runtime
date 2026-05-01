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
} from '../../../src/tools/node-tools.js';
import { createFakeRunner } from '../../helpers/fake-runner.js';
import { fixtureProjectPath, fixtureScenePath } from '../../helpers/fixture-paths.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const validBase = { projectPath: fixtureProjectPath, scenePath: fixtureScenePath };

function hasError(result: unknown): boolean {
  return typeof result === 'object' && result !== null && 'isError' in result;
}

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

  it('returns isError when runner returns empty stdout', async () => {
    const fake = createFakeRunner({ stdout: '' });
    const result = await handleDeleteNode(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Node',
    });
    expect(hasError(result)).toBe(true);
  });

  it('returns isError when runner throws', async () => {
    const fake = createFakeRunner({ throws: new Error('boom') });
    const result = await handleDeleteNode(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Node',
    });
    expect(hasError(result)).toBe(true);
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

  it('returns isError when runner returns empty stdout', async () => {
    const fake = createFakeRunner({ stdout: '' });
    const result = await handleSetNodeProperty(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Node',
      property: 'visible',
      value: true,
    });
    expect(hasError(result)).toBe(true);
  });

  it('returns isError when runner throws', async () => {
    const fake = createFakeRunner({ throws: new Error('boom') });
    const result = await handleSetNodeProperty(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Node',
      property: 'visible',
      value: true,
    });
    expect(hasError(result)).toBe(true);
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

  it('returns isError when runner returns empty stdout', async () => {
    const fake = createFakeRunner({ stdout: '' });
    const result = await handleGetNodeProperties(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Node',
    });
    expect(hasError(result)).toBe(true);
  });

  it('returns isError when runner throws', async () => {
    const fake = createFakeRunner({ throws: new Error('boom') });
    const result = await handleGetNodeProperties(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Node',
    });
    expect(hasError(result)).toBe(true);
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

  it('returns isError when runner throws', async () => {
    const fake = createFakeRunner({ throws: new Error('boom') });
    // project.godot exists in the fixture, use it as a stand-in "script" so the fs check passes
    const result = await handleAttachScript(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Node',
      scriptPath: 'project.godot',
    });
    expect(hasError(result)).toBe(true);
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

  it('returns isError when runner returns empty stdout', async () => {
    const fake = createFakeRunner({ stdout: '' });
    const result = await handleGetSceneTree(fake.asRunner, validBase);
    expect(hasError(result)).toBe(true);
  });

  it('returns isError when runner throws', async () => {
    const fake = createFakeRunner({ throws: new Error('boom') });
    const result = await handleGetSceneTree(fake.asRunner, validBase);
    expect(hasError(result)).toBe(true);
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

  it('returns isError when runner returns empty stdout', async () => {
    const fake = createFakeRunner({ stdout: '' });
    const result = await handleDuplicateNode(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Node',
    });
    expect(hasError(result)).toBe(true);
  });

  it('returns isError when runner throws', async () => {
    const fake = createFakeRunner({ throws: new Error('boom') });
    const result = await handleDuplicateNode(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Node',
    });
    expect(hasError(result)).toBe(true);
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

  it('returns isError when runner returns empty stdout', async () => {
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

  it('returns isError when runner throws', async () => {
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

  it('returns isError when runner returns empty stdout', async () => {
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

  it('returns isError when runner throws', async () => {
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
});
