/**
 * Recursive validation of a structure check's schema.
 *
 * A malformed entry below the top level used to cross the boundary unchecked
 * and land on a typed GDScript parameter. Rejecting it here is what keeps the
 * diagnosis specific about which part of the schema is wrong.
 */

import { describe, it, expect } from 'vitest';
import { handleValidate } from '../../../src/tools/validate-tools.js';
import { createFakeRunner } from '../../helpers/fake-runner.js';
import { hasError, expectErrorMatching } from '../../helpers/assertions.js';
import { fixtureProjectPath } from '../../helpers/fixture-paths.js';

const SCENE = 'main.tscn';

describe('handleValidate - nested structure schema validation', () => {
  it('rejects a children entry that is not an object', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      scenePath: SCENE,
      checks: [{ type: 'structure', schema: { children: ['oops'] } }],
    });

    expectErrorMatching(result, /Invalid schema at schema\.children\[0\]/);
    // The malformed entry is rejected before the checks operation is asked to
    // run it; only the resource validation for scenePath reached the runner.
    expect(fake.calls.map((c) => c.operation)).toEqual(['validate_resource']);
  });

  it('rejects a nested child schema with no keys', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      scenePath: SCENE,
      checks: [{ type: 'structure', schema: { type: 'Node2D', children: [{}] } }],
    });

    expectErrorMatching(result, /Invalid schema at schema\.children\[0\]/);
    expect(fake.calls.map((c) => c.operation)).toEqual(['validate_resource']);
  });

  it('accepts a two-level nested schema', async () => {
    const checks = [
      {
        type: 'structure',
        schema: {
          type: 'Node2D',
          children: [{ type: 'Node2D', children: [{ type: 'Sprite2D', hasProperty: 'texture' }] }],
        },
      },
    ];
    const fake = createFakeRunner({ stdout: JSON.stringify({ valid: true, errors: [] }) });

    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      scenePath: SCENE,
      checks,
    });

    expect(hasError(result)).toBe(false);
    expect(fake.calls.map((c) => c.operation)).toEqual(['validate_resource', 'validate_checks']);
    expect(fake.calls[1]!.params).toEqual({ scene_path: SCENE, checks });
  });
});
