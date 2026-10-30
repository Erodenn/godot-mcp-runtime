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
    // Rejected before Godot is spawned: the parse validation and the checks share one process, and the
    // schema is shape-checked first.
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

describe('handleValidate - signals check node spelling', () => {
  it('refuses a signals check that carries both nodePath and node_path', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      scenePath: SCENE,
      checks: [{ type: 'signals', nodePath: 'root/HUD', node_path: 'root/Other' }],
    });

    expectErrorMatching(result, /nodePath or node_path, not both/);
    expect(fake.calls).toEqual([]);
  });

  it('refuses the pair on a targets item as well', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      targets: [
        {
          scenePath: SCENE,
          checks: [{ type: 'signals', nodePath: 'root/HUD', node_path: 'root' }],
        },
      ],
    });

    expect(fake.calls).toEqual([]);
    expect(JSON.stringify(result)).toMatch(/nodePath or node_path, not both/);
  });
});
