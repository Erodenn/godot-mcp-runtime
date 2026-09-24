/**
 * Batch-mode per-target checks[] for handleValidate.
 *
 * The contract under test: every target's checks travel inside the single
 * validate_batch call (one Godot process for the whole batch), a failure on
 * one target never costs the others their result, and the cold-import retry
 * fires at most once per call.
 */

import { describe, it, expect } from 'vitest';
import { handleValidate } from '../../../src/tools/validate-tools.js';
import { createFakeRunner } from '../../helpers/fake-runner.js';
import { hasError, expectErrorMatching, unwrap } from '../../helpers/assertions.js';
import { fixtureProjectPath } from '../../helpers/fixture-paths.js';

const STRUCTURE_CHECK = { type: 'structure', schema: { type: 'Node2D' } };
const SIGNALS_CHECK = { type: 'signals', nodePath: 'root/Label' };

function parseResults(result: unknown): {
  results: Array<{ target: string; valid: boolean; errors: unknown[] }>;
} {
  return JSON.parse(unwrap(result).content[0]!.text) as ReturnType<typeof parseResults>;
}

describe('handleValidate batch mode - per-target checks', () => {
  it("forwards each target's checks inside the single validate_batch call", async () => {
    const fake = createFakeRunner({
      stdout: JSON.stringify({
        results: [
          { target: 'placeholder.gd', valid: true, errors: [] },
          { target: 'main.tscn', valid: true, errors: [], checkErrors: [] },
        ],
      }),
    });

    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      targets: [
        { scriptPath: 'placeholder.gd' },
        { scenePath: 'main.tscn', checks: [STRUCTURE_CHECK, SIGNALS_CHECK] },
      ],
    });

    expect(hasError(result)).toBe(false);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.operation).toBe('validate_batch');
    expect(fake.calls[0]!.params).toEqual({
      targets: [
        { script_path: 'placeholder.gd' },
        { scene_path: 'main.tscn', checks: [STRUCTURE_CHECK, SIGNALS_CHECK] },
      ],
    });
  });

  it("reports one target's check errors without discarding the other targets", async () => {
    const middleCheckError = {
      check: 'structure',
      path: 'root',
      message: 'Expected node of type Control at root, found Node2D',
    };
    const fake = createFakeRunner({
      stdout: JSON.stringify({
        results: [
          { target: 'a.tscn', valid: true, errors: [], checkErrors: [] },
          { target: 'b.tscn', valid: true, errors: [], checkErrors: [middleCheckError] },
          { target: 'c.tscn', valid: true, errors: [], checkErrors: [] },
        ],
      }),
    });

    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      targets: [
        { scenePath: 'a.tscn', checks: [STRUCTURE_CHECK] },
        { scenePath: 'b.tscn', checks: [STRUCTURE_CHECK] },
        { scenePath: 'c.tscn', checks: [STRUCTURE_CHECK] },
      ],
    });

    expect(hasError(result)).toBe(false);
    expect(parseResults(result)).toEqual({
      results: [
        { target: 'a.tscn', valid: true, errors: [] },
        { target: 'b.tscn', valid: false, errors: [middleCheckError] },
        { target: 'c.tscn', valid: true, errors: [] },
      ],
    });
  });

  it('keeps parse errors and check errors in the same target errors array', async () => {
    const parseError = { message: 'File not found: res://gone.tscn' };
    const checkError = { message: 'Scene checks skipped: could not load scene gone.tscn' };
    const fake = createFakeRunner({
      stdout: JSON.stringify({
        results: [
          { target: 'gone.tscn', valid: false, errors: [parseError], checkErrors: [checkError] },
        ],
      }),
    });

    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      targets: [{ scenePath: 'gone.tscn', checks: [STRUCTURE_CHECK] }],
    });

    expect(hasError(result)).toBe(false);
    expect(parseResults(result)).toEqual({
      results: [{ target: 'gone.tscn', valid: false, errors: [parseError, checkError] }],
    });
  });

  it("records checks without scenePath as that target's own failure", async () => {
    const fake = createFakeRunner({
      stdout: JSON.stringify({
        results: [{ target: 'main.tscn', valid: true, errors: [], checkErrors: [] }],
      }),
    });

    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      targets: [
        { scriptPath: 'placeholder.gd', checks: [STRUCTURE_CHECK] },
        { scenePath: 'main.tscn', checks: [STRUCTURE_CHECK] },
      ],
    });

    expect(hasError(result)).toBe(false);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.params).toEqual({
      targets: [{ scene_path: 'main.tscn', checks: [STRUCTURE_CHECK] }],
    });
    expect(parseResults(result)).toEqual({
      results: [
        {
          target: 'placeholder.gd',
          valid: false,
          errors: [{ message: 'Target checks require scenePath - checks run against a scene' }],
        },
        { target: 'main.tscn', valid: true, errors: [] },
      ],
    });
  });

  it('rejects a structure check with no schema as that target alone', async () => {
    const fake = createFakeRunner({
      stdout: JSON.stringify({
        results: [{ target: 'main.tscn', valid: true, errors: [], checkErrors: [] }],
      }),
    });

    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      targets: [
        { scenePath: 'broken.tscn', checks: [{ type: 'structure' }] },
        { scenePath: 'main.tscn', checks: [STRUCTURE_CHECK] },
      ],
    });

    expect(hasError(result)).toBe(false);
    // The malformed target never reaches Godot; the other one still runs.
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.params).toEqual({
      targets: [{ scene_path: 'main.tscn', checks: [STRUCTURE_CHECK] }],
    });
    const parsed = parseResults(result);
    expect(parsed.results[0]).toEqual({
      target: 'broken.tscn',
      valid: false,
      errors: [
        {
          message:
            'Invalid schema at schema: must be an object like { type?, children?, hasProperty? }',
        },
      ],
    });
    expect(parsed.results[1]).toEqual({ target: 'main.tscn', valid: true, errors: [] });
  });

  it('rejects an unknown check type in a batch target the way single mode does', async () => {
    const fake = createFakeRunner({ stdout: JSON.stringify({ results: [] }) });

    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      targets: [{ scenePath: 'main.tscn', checks: [{ type: 'strcture', schema: {} }] }],
    });

    expect(hasError(result)).toBe(false);
    expect(fake.calls).toHaveLength(0);
    expect(parseResults(result)).toEqual({
      results: [
        {
          target: 'main.tscn',
          valid: false,
          errors: [
            {
              message:
                'Invalid check type: strcture (expected "structure", "signals", or "render")',
            },
          ],
        },
      ],
    });
  });

  it('errors on a target naming two modes instead of silently dropping its checks', async () => {
    const fake = createFakeRunner({
      stdout: JSON.stringify({
        results: [{ target: 'main.tscn', valid: true, errors: [], checkErrors: [] }],
      }),
    });

    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      targets: [
        { scriptPath: 'placeholder.gd', scenePath: 'both.tscn', checks: [STRUCTURE_CHECK] },
        { scenePath: 'main.tscn', checks: [STRUCTURE_CHECK] },
      ],
    });

    expect(hasError(result)).toBe(false);
    expect(fake.calls[0]!.params).toEqual({
      targets: [{ scene_path: 'main.tscn', checks: [STRUCTURE_CHECK] }],
    });
    expect(parseResults(result).results[0]).toEqual({
      target: 'both.tscn',
      valid: false,
      errors: [{ message: 'Target must have exactly one of scriptPath, source, or scenePath' }],
    });
  });

  it('does not forward checks for a target that failed path pre-validation', async () => {
    const fake = createFakeRunner({
      stdout: JSON.stringify({
        results: [{ target: 'main.tscn', valid: true, errors: [], checkErrors: [] }],
      }),
    });

    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      targets: [
        { scenePath: '../escape.tscn', checks: [STRUCTURE_CHECK] },
        { scenePath: 'main.tscn', checks: [STRUCTURE_CHECK] },
      ],
    });

    expect(hasError(result)).toBe(false);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.params).toEqual({
      targets: [{ scene_path: 'main.tscn', checks: [STRUCTURE_CHECK] }],
    });
    expect(parseResults(result)).toEqual({
      results: [
        {
          target: '../escape.tscn',
          valid: false,
          errors: [
            {
              message:
                'Invalid scenePath: must be a relative path inside the project root, no ".."',
            },
          ],
        },
        { target: 'main.tscn', valid: true, errors: [] },
      ],
    });
  });

  it('runs the asset import step once and retries validate_batch when stderr reports IMPORT_NEEDED', async () => {
    const goodPayload = JSON.stringify({
      results: [{ target: 'main.tscn', valid: true, errors: [], checkErrors: [] }],
    });
    const fake = createFakeRunner({
      responses: [
        { stdout: '', stderr: '[IMPORT_NEEDED] main.tscn: res://placeholder.png' },
        { stdout: goodPayload },
      ],
    });

    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      targets: [{ scenePath: 'main.tscn', checks: [STRUCTURE_CHECK] }],
    });

    expect(hasError(result)).toBe(false);
    expect(fake.importCalls).toEqual([fixtureProjectPath]);
    expect(fake.calls).toHaveLength(2);
    expect(parseResults(result)).toEqual({
      results: [{ target: 'main.tscn', valid: true, errors: [] }],
    });
  });

  it('surfaces the import failure without retrying when importAssets rejects', async () => {
    const fake = createFakeRunner({
      stdout: '',
      stderr: '[IMPORT_NEEDED] main.tscn: res://placeholder.png',
      importThrows: new Error('broken asset blocks the import'),
    });

    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      targets: [{ scenePath: 'main.tscn', checks: [STRUCTURE_CHECK] }],
    });

    expectErrorMatching(result, /broken asset blocks the import/);
    expect(fake.calls).toHaveLength(1);
  });
});
