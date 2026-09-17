import { describe, it, expect } from 'vitest';
import { handleValidateSceneStructure } from '../../../src/tools/validate-tools.js';
import { createFakeRunner } from '../../helpers/fake-runner.js';
import { hasError, unwrap } from '../../helpers/assertions.js';
import { fixtureProjectPath } from '../../helpers/fixture-paths.js';

const validBase = { projectPath: fixtureProjectPath };

function parseResult(result: unknown): {
  valid: boolean;
  missingNodes: Array<{ path: string; expected: string }>;
  missingProperties: Array<{ path: string; property: string }>;
  errors: string[];
} {
  const envelope = unwrap(result);
  return JSON.parse(envelope.content[0]!.text) as ReturnType<typeof parseResult>;
}

describe('handleValidateSceneStructure', () => {
  it('rejects missing projectPath', async () => {
    const fake = createFakeRunner();
    const result = await handleValidateSceneStructure(fake.asRunner, {
      scenePath: 'main.tscn',
      schema: { type: 'Node2D' },
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects nonexistent project', async () => {
    const fake = createFakeRunner();
    const result = await handleValidateSceneStructure(fake.asRunner, {
      projectPath: '/ghost',
      scenePath: 'main.tscn',
      schema: { type: 'Node2D' },
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects missing scenePath', async () => {
    const fake = createFakeRunner();
    const result = await handleValidateSceneStructure(fake.asRunner, {
      projectPath: fixtureProjectPath,
      schema: { type: 'Node2D' },
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects missing schema', async () => {
    const fake = createFakeRunner();
    const result = await handleValidateSceneStructure(fake.asRunner, {
      projectPath: fixtureProjectPath,
      scenePath: 'main.tscn',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects a non-object schema', async () => {
    const fake = createFakeRunner();
    const result = await handleValidateSceneStructure(fake.asRunner, {
      projectPath: fixtureProjectPath,
      scenePath: 'main.tscn',
      schema: 'Node2D',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects a schema with neither type nor children', async () => {
    const fake = createFakeRunner();
    const result = await handleValidateSceneStructure(fake.asRunner, {
      projectPath: fixtureProjectPath,
      scenePath: 'main.tscn',
      schema: {},
    });
    expect(hasError(result)).toBe(true);
  });

  it('forwards scenePath and schema to the GDScript operation', async () => {
    const fake = createFakeRunner({
      stdout: '{"valid":true,"missingNodes":[],"missingProperties":[],"errors":[]}',
    });
    const schema = {
      type: 'Node2D',
      children: [{ type: 'CollisionShape2D', hasProperty: 'shape' }],
    };
    await handleValidateSceneStructure(fake.asRunner, {
      ...validBase,
      scenePath: 'main.tscn',
      schema,
    });
    expect(fake.calls.length).toBe(1);
    expect(fake.calls[0]!.operation).toBe('validate_scene_structure');
    expect(fake.calls[0]!.params.scenePath).toBe('main.tscn');
    expect(fake.calls[0]!.params.schema).toEqual(schema);
  });

  it('parses valid:true response', async () => {
    const fake = createFakeRunner({
      stdout: '{"valid":true,"missingNodes":[],"missingProperties":[],"errors":[]}',
    });
    const result = await handleValidateSceneStructure(fake.asRunner, {
      ...validBase,
      scenePath: 'main.tscn',
      schema: { type: 'Node2D' },
    });
    expect(hasError(result)).toBe(false);
    const data = parseResult(result);
    expect(data.valid).toBe(true);
    expect(data.missingNodes).toEqual([]);
    expect(data.missingProperties).toEqual([]);
  });

  it('parses invalid response with missing nodes and properties', async () => {
    const missingNodes = [{ path: 'root/CollisionShape2D', expected: 'CollisionShape2D' }];
    const missingProperties = [{ path: 'root/CollisionShape2D', property: 'shape' }];
    const fake = createFakeRunner({
      stdout: JSON.stringify({
        valid: false,
        missingNodes,
        missingProperties,
        errors: ['root type mismatch: expected Node2D, found Control'],
      }),
    });
    const result = await handleValidateSceneStructure(fake.asRunner, {
      ...validBase,
      scenePath: 'main.tscn',
      schema: { type: 'Node2D' },
    });
    expect(hasError(result)).toBe(false);
    const data = parseResult(result);
    expect(data.valid).toBe(false);
    expect(data.missingNodes).toEqual(missingNodes);
    expect(data.missingProperties).toEqual(missingProperties);
    expect(data.errors).toHaveLength(1);
  });
});
