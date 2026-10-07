/**
 * Unit tests for the shared runtime-test launch helper.
 *
 * The helper's one skip is decided from the display probe before anything is
 * launched. These tests pin that a bridge failure whose text mentions a
 * display never turns into a skip while a display exists, and that a missing
 * display is a skip locally but a failure in CI.
 *
 * Break conditions: restoring a substring test on the bridge error text makes
 * the "display text" case call skip; dropping the CI branch makes the CI case
 * skip instead of throwing; checking the display after the launch makes the
 * "no display" cases call runProject.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { GodotRunner } from '../../src/utils/godot-runner.js';
import type * as PathValidation from '../../src/utils/path-validation.js';

const displayProbe = vi.hoisted(() => ({ available: true }));

vi.mock('../../src/utils/path-validation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof PathValidation>();
  return { ...actual, checkDisplayAvailable: () => displayProbe.available };
});

import { runProjectOrSkip } from '../helpers/run-project-or-skip.js';

const PROJECT = 'unused-project-path';
const SKIP_SIGNAL = 'skip-signal';
const DISPLAY_ERROR_TAIL =
  'ERROR: Could not create window\n   at: display_server_windows.cpp:1234 (DisplayServerWindows)';

function fakeRunner(waitResult: { ready: boolean; error?: string }) {
  const runProject = vi.fn().mockResolvedValue(undefined);
  const waitForBridge = vi.fn().mockResolvedValue(waitResult);
  return { runner: { runProject, waitForBridge } as unknown as GodotRunner, runProject };
}

function skipSpy() {
  return vi.fn((): never => {
    throw new Error(SKIP_SIGNAL);
  });
}

beforeEach(() => {
  displayProbe.available = true;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('runProjectOrSkip', () => {
  it('throws, and does not skip, when the bridge fails with display text while a display exists', async () => {
    const { runner } = fakeRunner({ ready: false, error: DISPLAY_ERROR_TAIL });
    const skip = skipSpy();
    await expect(runProjectOrSkip(runner, { skip }, PROJECT)).rejects.toThrow(
      /Bridge failed to initialise/,
    );
    expect(skip).not.toHaveBeenCalled();
  });

  it('skips before launching when there is no display and CI is unset', async () => {
    displayProbe.available = false;
    vi.stubEnv('CI', '');
    const { runner, runProject } = fakeRunner({ ready: true });
    const skip = skipSpy();
    await expect(runProjectOrSkip(runner, { skip }, PROJECT)).rejects.toThrow(SKIP_SIGNAL);
    expect(skip).toHaveBeenCalledTimes(1);
    expect(runProject).not.toHaveBeenCalled();
  });

  it('throws instead of skipping when there is no display and CI is set', async () => {
    displayProbe.available = false;
    vi.stubEnv('CI', 'true');
    const { runner, runProject } = fakeRunner({ ready: true });
    const skip = skipSpy();
    await expect(runProjectOrSkip(runner, { skip }, PROJECT)).rejects.toThrow(/no display/);
    expect(skip).not.toHaveBeenCalled();
    expect(runProject).not.toHaveBeenCalled();
  });

  it('returns ready when the bridge answers', async () => {
    const { runner } = fakeRunner({ ready: true });
    await expect(runProjectOrSkip(runner, { skip: skipSpy() }, PROJECT)).resolves.toEqual({
      ready: true,
    });
  });
});
