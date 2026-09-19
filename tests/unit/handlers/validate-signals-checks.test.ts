import { describe, it, expect } from 'vitest';
import { handleValidate } from '../../../src/tools/validate-tools.js';
import { createFakeRunner } from '../../helpers/fake-runner.js';
import { hasError, unwrap } from '../../helpers/assertions.js';
import { fixtureProjectPath, fixtureScenePath } from '../../helpers/fixture-paths.js';

const validBase = { projectPath: fixtureProjectPath, scenePath: fixtureScenePath };

function parseResult(result: unknown): { valid: boolean; errors: unknown[] } {
  const envelope = unwrap(result);
  return JSON.parse(envelope.content[0]!.text);
}

function validateChecksCall(fake: { calls: Array<{ operation: string; params: unknown }> }) {
  const call = fake.calls.find((c) => c.operation === 'validate_checks');
  expect(call).toBeDefined();
  return call!;
}

describe('handleValidate — signals checks', () => {
  it('rejects missing projectPath', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      scenePath: fixtureScenePath,
      checks: [{ type: 'signals' }],
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects nonexistent project', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: '/ghost',
      scenePath: fixtureScenePath,
      checks: [{ type: 'signals' }],
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects checks without scenePath', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      checks: [{ type: 'signals' }],
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects an unknown check type', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      ...validBase,
      checks: [{ type: 'nope' }],
    });
    expect(hasError(result)).toBe(true);
  });

  it('passes a valid signals check', async () => {
    const fake = createFakeRunner({ stdout: '{"valid":true,"errors":[]}' });
    const result = await handleValidate(fake.asRunner, {
      ...validBase,
      checks: [{ type: 'signals' }],
    });
    expect(hasError(result)).toBe(false);
    const data = parseResult(result);
    expect(data.valid).toBe(true);
    expect(data.errors).toEqual([]);
  });

  it('merges signal issues into errors with check discriminator', async () => {
    const errors = [
      {
        check: 'signals',
        node: 'root/Button',
        signal: 'pressed',
        target: 'root/Label',
        method: '_on_button_pressed',
        problem: 'method_missing_on_target',
        message: 'method_missing_on_target',
      },
      {
        check: 'signals',
        node: 'root/Area2D',
        signal: 'body_entered',
        target: 'root/Player',
        method: 'handle_body_entered',
        problem: 'naming_convention',
        message: 'naming_convention',
      },
    ];
    const fake = createFakeRunner({ stdout: JSON.stringify({ valid: false, errors }) });
    const result = await handleValidate(fake.asRunner, {
      ...validBase,
      checks: [{ type: 'signals' }],
    });
    expect(hasError(result)).toBe(false);
    const data = parseResult(result);
    expect(data.valid).toBe(false);
    // The fake runner returns the same stdout for both validate_resource and
    // validate_checks, so the resource-parse branch also surfaces these
    // errors — assert containment, not exact equality.
    for (const e of errors) {
      expect(data.errors).toContainEqual(e);
    }
  });

  it('forwards nodePath to the GDScript operation', async () => {
    const fake = createFakeRunner({ stdout: '{"valid":true,"errors":[]}' });
    await handleValidate(fake.asRunner, {
      ...validBase,
      checks: [{ type: 'signals', nodePath: 'root/SubViewport' }],
    });
    const call = validateChecksCall(fake);
    expect(call.params).toMatchObject({
      scene_path: fixtureScenePath,
      checks: [{ type: 'signals', nodePath: 'root/SubViewport' }],
    });
  });

  it('omits nodePath when not provided', async () => {
    const fake = createFakeRunner({ stdout: '{"valid":true,"errors":[]}' });
    await handleValidate(fake.asRunner, { ...validBase, checks: [{ type: 'signals' }] });
    const call = validateChecksCall(fake);
    expect(call.params).toMatchObject({ checks: [{ type: 'signals' }] });
    expect((call.params as Record<string, unknown>).checks[0]).not.toHaveProperty('nodePath');
  });
});
