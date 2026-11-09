import { describe, it, expect } from 'vitest';
import {
  handleCreateResource,
  handleSetResourceProperties,
} from '../../../src/tools/scene-tools.js';
import { createFakeRunner } from '../../helpers/fake-runner.js';
import { expectErrorMatching } from '../../helpers/assertions.js';
import { authoredFixtureProjectPath } from '../../helpers/fixture-paths.js';
import { expectMatchesOutputSchema } from '../../helpers/schema-assert.js';

const EXISTING_RESOURCE = 'sword.tres';

const RESOURCE_PAYLOAD = {
  resourcePath: 'items/axe.tres',
  resourceType: 'Resource',
  scriptPath: 'item_stats.gd',
  properties: { title: 'Axe', power: 7 },
};

describe('handleCreateResource', () => {
  it('refuses a resourcePath outside the project before any Godot run', async () => {
    const fake = createFakeRunner();
    const result = await handleCreateResource(fake.asRunner, {
      projectPath: authoredFixtureProjectPath,
      resourcePath: '../outside.tres',
      type: 'Resource',
    });
    expectErrorMatching(result, /resource path/i);
    expect(fake.calls).toEqual([]);
  });

  it('refuses a resourcePath that is not a .tres file', async () => {
    const fake = createFakeRunner();
    const result = await handleCreateResource(fake.asRunner, {
      projectPath: authoredFixtureProjectPath,
      resourcePath: 'items/axe.json',
      type: 'Resource',
    });
    expectErrorMatching(result, /\.tres/);
    expect(fake.calls).toEqual([]);
  });

  it('refuses an existing file when overwrite is not set', async () => {
    const fake = createFakeRunner();
    const result = await handleCreateResource(fake.asRunner, {
      projectPath: authoredFixtureProjectPath,
      resourcePath: EXISTING_RESOURCE,
      type: 'Resource',
    });
    expectErrorMatching(result, /already exists/);
    expect(fake.calls).toEqual([]);
  });

  it('forwards overwrite: true to the operation for an existing file', async () => {
    const fake = createFakeRunner({
      stdout: JSON.stringify({ ...RESOURCE_PAYLOAD, resourcePath: EXISTING_RESOURCE }),
    });
    const result = await handleCreateResource(fake.asRunner, {
      projectPath: authoredFixtureProjectPath,
      resourcePath: EXISTING_RESOURCE,
      type: 'item_stats.gd',
      properties: { power: 1 },
      overwrite: true,
    });
    expectMatchesOutputSchema('create_resource', result);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].operation).toBe('create_resource');
    expect(fake.calls[0].params).toMatchObject({
      resourcePath: EXISTING_RESOURCE,
      type: 'item_stats.gd',
      properties: { power: 1 },
      overwrite: true,
    });
  });

  it('returns a payload that matches the create_resource outputSchema', async () => {
    const fake = createFakeRunner({ stdout: JSON.stringify(RESOURCE_PAYLOAD) });
    const result = await handleCreateResource(fake.asRunner, {
      projectPath: authoredFixtureProjectPath,
      resourcePath: 'items/axe.tres',
      type: 'item_stats.gd',
      properties: { title: 'Axe', power: 7 },
    });
    const payload = expectMatchesOutputSchema('create_resource', result);
    expect(payload).toMatchObject(RESOURCE_PAYLOAD);
  });
});

describe('handleSetResourceProperties', () => {
  it('refuses a resource file that does not exist', async () => {
    const fake = createFakeRunner();
    const result = await handleSetResourceProperties(fake.asRunner, {
      projectPath: authoredFixtureProjectPath,
      resourcePath: 'missing.tres',
      properties: { power: 1 },
    });
    expectErrorMatching(result, /does not exist/);
    expect(fake.calls).toEqual([]);
  });

  it('refuses an empty properties object', async () => {
    const fake = createFakeRunner();
    const result = await handleSetResourceProperties(fake.asRunner, {
      projectPath: authoredFixtureProjectPath,
      resourcePath: EXISTING_RESOURCE,
      properties: {},
    });
    expectErrorMatching(result, /at least one property/);
    expect(fake.calls).toEqual([]);
  });

  it('returns a payload that matches the set_resource_properties outputSchema', async () => {
    const payloadIn = {
      resourcePath: EXISTING_RESOURCE,
      resourceType: 'Resource',
      scriptPath: 'item_stats.gd',
      properties: { power: 20 },
    };
    const fake = createFakeRunner({ stdout: JSON.stringify(payloadIn) });
    const result = await handleSetResourceProperties(fake.asRunner, {
      projectPath: authoredFixtureProjectPath,
      resourcePath: EXISTING_RESOURCE,
      properties: { power: 20 },
    });
    const payload = expectMatchesOutputSchema('set_resource_properties', result);
    expect(payload).toMatchObject(payloadIn);
    expect(fake.calls[0].operation).toBe('set_resource_properties');
  });

  it('accepts a null scriptPath for an engine-class resource', async () => {
    const fake = createFakeRunner({
      stdout: JSON.stringify({
        resourcePath: EXISTING_RESOURCE,
        resourceType: 'StyleBoxFlat',
        scriptPath: null,
        properties: { corner_radius_top_left: 4 },
      }),
    });
    const result = await handleSetResourceProperties(fake.asRunner, {
      projectPath: authoredFixtureProjectPath,
      resourcePath: EXISTING_RESOURCE,
      properties: { corner_radius_top_left: 4 },
    });
    expectMatchesOutputSchema('set_resource_properties', result);
  });
});
