import { describe, it, expect } from 'vitest';
import * as headlessOp from '../../src/utils/headless-op.js';
import * as nodeTools from '../../src/tools/node-tools.js';
import * as sceneTools from '../../src/tools/scene-tools.js';
import { OPERATION_RESULT_SENTINEL } from '../../src/utils/output-parsing.js';
import { createFakeRunner } from '../helpers/fake-runner.js';
import { hasError, expectErrorMatching, errorText } from '../helpers/assertions.js';
import { fixtureProjectPath, fixtureScenePath } from '../helpers/fixture-paths.js';

const FAILURE_PREFIX = 'Failed to op';
const EMPTY_SOLUTIONS = ['check the input'];
const validBase = { projectPath: fixtureProjectPath, scenePath: fixtureScenePath };
const GOOD_UPDATE = { nodePath: 'root', property: 'visible', value: true };
const UPDATE_WITHOUT_VALUE = { nodePath: 'root', property: 'visible' };
const UPDATE_WITHOUT_PROPERTY = { nodePath: 'root' };

async function interpret(stdout: string): Promise<unknown> {
  const fake = createFakeRunner({ stdout });
  return headlessOp.executeSceneOp(
    fake.asRunner,
    'set_node_properties',
    {},
    '/p',
    FAILURE_PREFIX,
    EMPTY_SOLUTIONS,
    undefined,
    { parseStdoutAsJson: true },
  );
}

describe('interpretation of a payload that carries a top-level error', () => {
  it('a payload with a top-level error string becomes an error response', async () => {
    const result = await interpret(`${OPERATION_RESULT_SENTINEL}{"error":"x","results":[]}`);
    expect(hasError(result)).toBe(true);
    expect(errorText(result)).toBe(`${FAILURE_PREFIX}: x`);
  });

  it('a payload without an error key is still a success', async () => {
    const result = await interpret(`${OPERATION_RESULT_SENTINEL}{"results":[]}`);
    expect(hasError(result)).toBe(false);
  });

  it('a non-string error field is data, not a failure', async () => {
    const result = await interpret(`${OPERATION_RESULT_SENTINEL}{"results":[],"error":null}`);
    expect(hasError(result)).toBe(false);
  });
});

describe('get_node_properties item validation', () => {
  it('get_node_properties rejects a nodes item without nodePath', async () => {
    const fake = createFakeRunner({ stdout: '{"results":[]}' });
    const result = await nodeTools.handleGetNodeProperties(fake.asRunner, {
      ...validBase,
      nodes: [{ nodePath: 'root' }, { path: 'root/Player' }],
    });
    expectErrorMatching(result, /nodes\[1\]\.nodePath/);
    expect(fake.calls).toHaveLength(0);
  });

  it('get_node_properties rejects a nodes item that is not an object', async () => {
    const fake = createFakeRunner({ stdout: '{"results":[]}' });
    const result = await nodeTools.handleGetNodeProperties(fake.asRunner, {
      ...validBase,
      nodes: ['root/Player'],
    });
    expectErrorMatching(result, /nodes\[0\]/);
    expect(fake.calls).toHaveLength(0);
  });

  it('get_node_properties rejects a changedOnly that is not a boolean', async () => {
    const fake = createFakeRunner({ stdout: '{"results":[]}' });
    const result = await nodeTools.handleGetNodeProperties(fake.asRunner, {
      ...validBase,
      nodes: [{ nodePath: 'root', changedOnly: 'yes' }],
    });
    expectErrorMatching(result, /nodes\[0\]\.changedOnly/);
    expect(fake.calls).toHaveLength(0);
  });

  it('get_node_properties accepts the snake_case spelling inside items', async () => {
    const fake = createFakeRunner({ stdout: '{"results":[]}' });
    const result = await nodeTools.handleGetNodeProperties(fake.asRunner, {
      ...validBase,
      nodes: [{ node_path: 'root/Label', changed_only: true }],
    });
    expect(hasError(result)).toBe(false);
    expect(fake.calls).toHaveLength(1);
  });
});

describe('set_node_properties item validation', () => {
  it('set_node_properties rejects an update without property', async () => {
    const fake = createFakeRunner({ stdout: '{"results":[]}' });
    const result = await nodeTools.handleSetNodeProperties(fake.asRunner, {
      ...validBase,
      updates: [UPDATE_WITHOUT_PROPERTY],
    });
    expectErrorMatching(result, /updates\[0\]\.property/);
    expect(fake.calls).toHaveLength(0);
  });

  it('set_node_properties rejects an update without value', async () => {
    const fake = createFakeRunner({ stdout: '{"results":[]}' });
    const result = await nodeTools.handleSetNodeProperties(fake.asRunner, {
      ...validBase,
      updates: [GOOD_UPDATE, UPDATE_WITHOUT_VALUE],
    });
    expectErrorMatching(result, /updates\[1\]\.value/);
    expect(fake.calls).toHaveLength(0);
  });

  it('set_node_properties rejects an update without nodePath', async () => {
    const fake = createFakeRunner({ stdout: '{"results":[]}' });
    const result = await nodeTools.handleSetNodeProperties(fake.asRunner, {
      ...validBase,
      updates: [{ property: 'visible', value: true }],
    });
    expectErrorMatching(result, /updates\[0\]\.nodePath/);
    expect(fake.calls).toHaveLength(0);
  });

  it('set_node_properties accepts a null value and the snake_case spelling', async () => {
    const fake = createFakeRunner({ stdout: '{"results":[]}' });
    const result = await nodeTools.handleSetNodeProperties(fake.asRunner, {
      ...validBase,
      updates: [{ node_path: 'root/Shape', property: 'shape', value: null }],
    });
    expect(hasError(result)).toBe(false);
    expect(fake.calls).toHaveLength(1);
  });
});

describe('batch_scene_operations item validation', () => {
  it('batch_scene_operations rejects a non-string operation', async () => {
    const fake = createFakeRunner({ stdout: '{"results":[]}' });
    const result = await sceneTools.handleBatchSceneOperations(fake.asRunner, {
      projectPath: fixtureProjectPath,
      operations: [{ operation: 'save', scenePath: fixtureScenePath }, { operation: 7 }],
    });
    expectErrorMatching(result, /operations\[1\]\.operation/);
    expect(fake.calls).toHaveLength(0);
  });

  it('batch_scene_operations rejects a non-object item', async () => {
    const fake = createFakeRunner({ stdout: '{"results":[]}' });
    const result = await sceneTools.handleBatchSceneOperations(fake.asRunner, {
      projectPath: fixtureProjectPath,
      operations: ['add_node'],
    });
    expectErrorMatching(result, /operations\[0\]/);
    expect(fake.calls).toHaveLength(0);
  });

  it('batch_scene_operations rejects a non-string scenePath', async () => {
    const fake = createFakeRunner({ stdout: '{"results":[]}' });
    const result = await sceneTools.handleBatchSceneOperations(fake.asRunner, {
      projectPath: fixtureProjectPath,
      operations: [{ operation: 'save', scenePath: 5 }],
    });
    expectErrorMatching(result, /operations\[0\]\.scenePath/);
    expect(fake.calls).toHaveLength(0);
  });

  it('batch_scene_operations rejects a malformed update inside an item', async () => {
    const fake = createFakeRunner({ stdout: '{"results":[]}' });
    const result = await sceneTools.handleBatchSceneOperations(fake.asRunner, {
      projectPath: fixtureProjectPath,
      operations: [
        {
          operation: 'set_node_properties',
          scenePath: fixtureScenePath,
          updates: [GOOD_UPDATE, UPDATE_WITHOUT_PROPERTY],
        },
      ],
    });
    expectErrorMatching(result, /operations\[0\]\.updates\[1\]\.property/);
    expect(fake.calls).toHaveLength(0);
  });

  it('batch_scene_operations rejects an item with no operation key before Godot starts', async () => {
    const fake = createFakeRunner({ stdout: '{"results":[]}' });
    const result = await sceneTools.handleBatchSceneOperations(fake.asRunner, {
      projectPath: fixtureProjectPath,
      operations: [{ scenePath: fixtureScenePath, nodeName: 'Probe', nodeType: 'Node2D' }],
    });
    expectErrorMatching(result, /operations\[0\] is missing the required 'operation' key/);
    expect(fake.calls).toHaveLength(0);
  });
});
