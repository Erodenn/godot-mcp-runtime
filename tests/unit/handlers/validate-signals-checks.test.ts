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

/**
 * The single call a scenePath-plus-checks validate makes. Single mode runs the
 * parse validation and the checks against one instantiated scene in one Godot
 * process, so the target travels inside validate_batch's targets array.
 */
function checksTarget(fake: { calls: Array<{ operation: string; params: unknown }> }) {
  expect(fake.calls).toHaveLength(1);
  const call = fake.calls[0]!;
  expect(call.operation).toBe('validate_batch');
  const targets = (call.params as { targets?: unknown[] }).targets;
  expect(Array.isArray(targets)).toBe(true);
  return (targets as Record<string, unknown>[])[0]!;
}

/** A validate_batch payload carrying one target. */
function batchStdout(target: Record<string, unknown>): string {
  return JSON.stringify({ results: [{ target: 'main.tscn', errors: [], ...target }] });
}

describe('handleValidate: signals checks', () => {
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
    const fake = createFakeRunner({ stdout: batchStdout({ valid: true, checkErrors: [] }) });
    const result = await handleValidate(fake.asRunner, {
      ...validBase,
      checks: [{ type: 'signals' }],
    });
    expect(hasError(result)).toBe(false);
    expect(fake.calls).toHaveLength(1);
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
    const fake = createFakeRunner({
      stdout: batchStdout({ valid: true, checkErrors: errors }),
    });
    const result = await handleValidate(fake.asRunner, {
      ...validBase,
      checks: [{ type: 'signals' }],
    });
    expect(hasError(result)).toBe(false);
    const data = parseResult(result);
    expect(data.valid).toBe(false);
    // One process now, so the findings appear exactly once and in order.
    expect(data.errors).toEqual(errors);
  });

  it('forwards nodePath to the GDScript operation', async () => {
    const fake = createFakeRunner({ stdout: batchStdout({ valid: true, checkErrors: [] }) });
    await handleValidate(fake.asRunner, {
      ...validBase,
      checks: [{ type: 'signals', nodePath: 'root/SubViewport' }],
    });
    expect(checksTarget(fake)).toMatchObject({
      scene_path: fixtureScenePath,
      checks: [{ type: 'signals', nodePath: 'root/SubViewport' }],
    });
  });

  it('omits nodePath when not provided', async () => {
    const fake = createFakeRunner({ stdout: batchStdout({ valid: true, checkErrors: [] }) });
    await handleValidate(fake.asRunner, { ...validBase, checks: [{ type: 'signals' }] });
    const target = checksTarget(fake);
    expect(target).toMatchObject({ checks: [{ type: 'signals' }] });
    expect((target.checks as Record<string, unknown>[])[0]).not.toHaveProperty('nodePath');
  });
});
