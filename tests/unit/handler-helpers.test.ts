/**
 * Direct unit tests for executeSceneOp.
 *
 * Currently only covered transitively via the 15 scene/node mutation
 * handlers. A direct test localizes the failure when its contract drifts —
 * the empty-stdout branch and the catch branch are easy to break in a
 * refactor.
 */

import { describe, it, expect } from 'vitest';
import { executeSceneOp } from '../../src/utils/handler-helpers.js';
import { createFakeRunner } from '../helpers/fake-runner.js';
import { hasError, expectErrorMatching } from '../helpers/assertions.js';

const TEST_FAILURE_PREFIX = 'Failed to op';
const EMPTY_SOLUTIONS = ['empty: a', 'empty: b'];
const EXCEPTION_SOLUTIONS = ['exc: a', 'exc: b'];

describe('executeSceneOp', () => {
  it('returns the runner stdout verbatim when non-empty (no isError)', async () => {
    const fake = createFakeRunner({ stdout: '{"node":"ok"}' });
    const result = await executeSceneOp(
      fake.asRunner,
      'add_node',
      { foo: 1 },
      '/p',
      TEST_FAILURE_PREFIX,
      EMPTY_SOLUTIONS,
      EXCEPTION_SOLUTIONS,
    );
    expect(hasError(result)).toBe(false);
    expect(result.content).toEqual([{ type: 'text', text: '{"node":"ok"}' }]);
  });

  it('forwards (operation, params, projectPath) to the runner unchanged', async () => {
    const fake = createFakeRunner({ stdout: '{}' });
    await executeSceneOp(
      fake.asRunner,
      'delete_nodes',
      { nodePaths: ['a', 'b'] },
      '/some/project',
      TEST_FAILURE_PREFIX,
      EMPTY_SOLUTIONS,
      EXCEPTION_SOLUTIONS,
    );
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      operation: 'delete_nodes',
      params: { nodePaths: ['a', 'b'] },
      projectPath: '/some/project',
    });
  });

  it('escalates empty stdout into an isError with extracted GD error from stderr', async () => {
    const fake = createFakeRunner({
      stdout: '   \n  ',
      stderr: 'Godot v4.4 ...\n[ERROR] node not found at root/Missing\nmore noise',
    });
    const result = await executeSceneOp(
      fake.asRunner,
      'delete_nodes',
      {},
      '/p',
      TEST_FAILURE_PREFIX,
      EMPTY_SOLUTIONS,
      EXCEPTION_SOLUTIONS,
    );
    expectErrorMatching(result, /Failed to op/);
    expectErrorMatching(result, /node not found at root\/Missing/);
    // Empty-stdout-specific solutions surface in the secondary text block.
    const solutionsText = (result as { content: Array<{ text: string }> }).content[1]?.text ?? '';
    expect(solutionsText).toContain('empty: a');
    expect(solutionsText).not.toContain('exc: a');
  });

  it('escalates empty stdout to a generic message when stderr has no [ERROR] line', async () => {
    const fake = createFakeRunner({ stdout: '', stderr: 'just some banner output' });
    const result = await executeSceneOp(
      fake.asRunner,
      'delete_nodes',
      {},
      '/p',
      TEST_FAILURE_PREFIX,
      EMPTY_SOLUTIONS,
      EXCEPTION_SOLUTIONS,
    );
    expectErrorMatching(result, /see get_debug_output for details/);
  });

  it('wraps a thrown runner error with failurePrefix and exceptionSolutions', async () => {
    const fake = createFakeRunner({ throws: new Error('spawn ENOENT') });
    const result = await executeSceneOp(
      fake.asRunner,
      'add_node',
      {},
      '/p',
      TEST_FAILURE_PREFIX,
      EMPTY_SOLUTIONS,
      EXCEPTION_SOLUTIONS,
    );
    expectErrorMatching(result, /Failed to op: spawn ENOENT/);
    const solutionsText = (result as { content: Array<{ text: string }> }).content[1]?.text ?? '';
    expect(solutionsText).toContain('exc: a');
    expect(solutionsText).not.toContain('empty: a');
  });
});
