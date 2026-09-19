import { describe, it, expect } from 'vitest';
import { handleValidate } from '../../../src/tools/validate-tools.js';
import { createFakeRunner } from '../../helpers/fake-runner.js';
import { hasError, unwrap } from '../../helpers/assertions.js';
import { fixtureProjectPath } from '../../helpers/fixture-paths.js';

const validBase = { projectPath: fixtureProjectPath };

function parseResult(result: unknown): { valid: boolean; errors: unknown[] } {
  const envelope = unwrap(result);
  return JSON.parse(envelope.content[0]!.text) as ReturnType<typeof parseResult>;
}

describe('handleValidate — structure checks', () => {
  it('rejects missing projectPath', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      scenePath: 'main.tscn',
      checks: [{ type: 'structure', schema: { type: 'Node2D' } }],
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects nonexistent project', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: '/ghost',
      scenePath: 'main.tscn',
      checks: [{ type: 'structure', schema: { type: 'Node2D' } }],
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects missing scenePath', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      checks: [{ type: 'structure', schema: { type: 'Node2D' } }],
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects a structure check without a schema', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      scenePath: 'main.tscn',
      checks: [{ type: 'structure' }],
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects a non-object schema', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      scenePath: 'main.tscn',
      checks: [{ type: 'structure', schema: 'Node2D' }],
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects a schema with neither type nor children', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      scenePath: 'main.tscn',
      checks: [{ type: 'structure', schema: {} }],
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
    await handleValidate(fake.asRunner, {
      ...validBase,
      scenePath: 'main.tscn',
      checks: [{ type: 'structure', schema }],
    });
    expect(fake.calls.some((c) => c.operation === 'validate_checks')).toBe(true);
    const call = fake.calls.find((c) => c.operation === 'validate_checks')!;
    expect(call.params.scene_path).toBe('main.tscn');
    expect(call.params.checks).toEqual([{ type: 'structure', schema }]);
  });

  it('parses valid:true response', async () => {
    const fake = createFakeRunner({
      stdout: '{"valid":true,"errors":[]}',
    });
    const result = await handleValidate(fake.asRunner, {
      ...validBase,
      scenePath: 'main.tscn',
      checks: [{ type: 'structure', schema: { type: 'Node2D' } }],
    });
    expect(hasError(result)).toBe(false);
    const data = parseResult(result);
    expect(data.valid).toBe(true);
    expect(data.errors).toEqual([]);
  });

  it('parses invalid response with check errors', async () => {
    const errors = [
      {
        check: 'structure',
        path: 'root/CollisionShape2D',
        message: 'Expected node of type CollisionShape2D at root/CollisionShape2D',
      },
      {
        check: 'structure',
        path: 'root/CollisionShape2D',
        message: 'Property shape not set on root/CollisionShape2D',
      },
    ];
    const fake = createFakeRunner({
      stdout: JSON.stringify({ valid: false, errors }),
    });
    const result = await handleValidate(fake.asRunner, {
      ...validBase,
      scenePath: 'main.tscn',
      checks: [{ type: 'structure', schema: { type: 'Node2D' } }],
    });
    expect(hasError(result)).toBe(false);
    const data = parseResult(result);
    expect(data.valid).toBe(false);
    // Fake runner returns same stdout for both ops, so errors appear twice.
    for (const e of errors) {
      expect(data.errors).toContainEqual(e);
    }
  });
});
