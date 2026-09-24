import { describe, it, expect } from 'vitest';
import { handleValidate } from '../../../src/tools/validate-tools.js';
import { createFakeRunner } from '../../helpers/fake-runner.js';
import { expectErrorMatching, unwrap } from '../../helpers/assertions.js';
import { fixtureProjectPath, fixtureScenePath } from '../../helpers/fixture-paths.js';

// ---------------------------------------------------------------------------
// handleValidate: render checks (server-side execution path)
//
// The render check itself spawns a real Godot with --write-movie, which these
// unit tests stub at the boundary: getGodotPath() returning null forces the
// "cannot run" path, and a fake runner with getGodotPath() set but no frames
// produces the "failed" catch-path entry. Fixture-driven integration coverage
// lives in tests/integration/validate-render-checks.test.ts.
// ---------------------------------------------------------------------------

describe('handleValidate: render checks', () => {
  it('rejects unknown check types with the render option documented', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      scenePath: fixtureScenePath,
      checks: [{ type: 'bogus' }],
    });
    expectErrorMatching(result, /Invalid check type: bogus.*"structure", "signals", or "render"/s);
  });

  it('rejects a render check with non-integer frames', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      scenePath: fixtureScenePath,
      checks: [{ type: 'render', frames: 2.5 }],
    });
    expectErrorMatching(result, /frames must be a positive integer/);
  });

  it('rejects a render check with negative frames', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      scenePath: fixtureScenePath,
      checks: [{ type: 'render', frames: 0 }],
    });
    expectErrorMatching(result, /frames must be a positive integer/);
  });

  it('reports a render error when Godot path is unavailable', async () => {
    const fake = createFakeRunner({ godotPath: null });
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      scenePath: fixtureScenePath,
      checks: [{ type: 'render' }],
    });
    const payload = JSON.parse(unwrap(result).content[0]!.text as string);
    expect(payload.valid).toBe(false);
    expect(payload.errors).toHaveLength(1);
    expect(payload.errors[0].check).toBe('render');
    expect(payload.errors[0].message).toMatch(/Cannot run render check|spawn.*ENOENT/);
    // Only render checks that fail this way skip spawning the GDScript batch
    expect(fake.calls).toHaveLength(0);
  });

  it('merges render failure entries alongside structure check results', async () => {
    const fake = createFakeRunner({
      godotPath: null,
      stdout: JSON.stringify({
        results: [{ target: fixtureScenePath, valid: true, errors: [] }],
      }),
    });
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      scenePath: fixtureScenePath,
      checks: [{ type: 'render' }, { type: 'structure', schema: { type: 'Node2D' } }],
    });
    const payload = JSON.parse(unwrap(result).content[0]!.text as string);
    expect(payload.valid).toBe(false);
    const renderEntries = payload.errors.filter((e: { check: string }) => e.check === 'render');
    expect(renderEntries).toHaveLength(1);
    expect(renderEntries[0].message).toMatch(/Cannot run render check|spawn.*ENOENT/);
    // The structure check still ran through validate_batch
    expect(fake.calls.some((c) => c.operation === 'validate_batch')).toBe(true);
  });

  it('rejects render checks in batch mode with a clear error', async () => {
    const fake = createFakeRunner({
      stdout: JSON.stringify({
        results: [{ target: 'other.tscn', valid: true, errors: [] }],
      }),
    });
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      targets: [
        { scenePath: 'main.tscn', checks: [{ type: 'render' }] },
        { scenePath: 'other.tscn', checks: [{ type: 'structure', schema: { type: 'Node2D' } }] },
      ],
    });
    const payload = JSON.parse(unwrap(result).content[0]!.text as string);
    expect(payload.results).toHaveLength(2);
    expect(payload.results[0].valid).toBe(false);
    expect(payload.results[0].errors[0].message).toMatch(
      /render checks are not supported in batch mode/,
    );
    // The second target still validates normally
    expect(payload.results[1].valid).toBe(true);
  });
});
