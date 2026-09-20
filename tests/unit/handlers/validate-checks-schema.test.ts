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
    // The malformed entry is rejected before Godot is spawned at all: the
    // parse validation and the checks share one process, and the schema is
    // shape-checked before that process is asked for.
    expect(fake.calls).toEqual([]);
  });

  it('rejects a nested child schema with no keys', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      scenePath: SCENE,
      checks: [{ type: 'structure', schema: { type: 'Node2D', children: [{}] } }],
    });

    expectErrorMatching(result, /Invalid schema at schema\.children\[0\]/);
    expect(fake.calls).toEqual([]);
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
    const fake = createFakeRunner({
      stdout: JSON.stringify({
        results: [{ target: SCENE, valid: true, errors: [], checkErrors: [] }],
      }),
    });

    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      scenePath: SCENE,
      checks,
    });

    expect(hasError(result)).toBe(false);
    expect(fake.calls.map((c) => c.operation)).toEqual(['validate_batch']);
    expect(fake.calls[0]!.params).toEqual({ targets: [{ scene_path: SCENE, checks }] });
  });
});
