/** The only skip beyond the `hasGodot` gate is a headless environment, decided before launch from the display probe `runProject` uses, never from failure text: a bridge that fails on a machine with a display is a defect. */

import type { TestContext } from 'vitest';
import type { GodotRunner } from '../../src/utils/godot-runner.js';
import { checkDisplayAvailable, resolveProjectPath } from '../../src/utils/path-validation.js';

const DEFAULT_BRIDGE_WAIT_MS = 20000;

/** Set by CI. With no display there, a skip would turn the runtime suite green without running it, so the helper throws. */
const CI_ENV_VAR = 'CI';

export const SHOW_WINDOWS_ENV_VAR = 'GODOT_MCP_TEST_SHOW_WINDOWS';

export function showTestWindows(): boolean {
  return process.env[SHOW_WINDOWS_ENV_VAR] === '1';
}

export interface RunProjectOrSkipOptions {
  scene?: string;
  background?: boolean;
  bridgePort?: number;
  profiling?: boolean;
  waitMs?: number;
}

/** Skips (locally only; throws in CI) when the machine has no display; any other failure to start or reach the bridge throws. */
export async function runProjectOrSkip(
  runner: GodotRunner,
  ctx: Pick<TestContext, 'skip'>,
  projectPath: string,
  opts: RunProjectOrSkipOptions = {},
): Promise<{ ready: true }> {
  const scene =
    opts.scene === undefined ? undefined : resolveProjectPath(projectPath, opts.scene, 'read');
  if (opts.scene !== undefined && !scene) {
    throw new Error(`runProjectOrSkip: scene is not a project sub-path: ${opts.scene}`);
  }
  if (!checkDisplayAvailable()) {
    if (process.env[CI_ENV_VAR]) {
      throw new Error(
        'runProjectOrSkip: no display server is available in CI, so every runtime test would ' +
          'skip and pass unrun. Provide a display (xvfb) for the job.',
      );
    }
    // ctx.skip() throws to abort the test as skipped, not passed.
    ctx.skip('no display server available (DISPLAY and WAYLAND_DISPLAY are both unset)');
  }
  await runner.runProject(
    projectPath,
    scene ?? undefined,
    opts.background ?? !showTestWindows(),
    opts.bridgePort,
    opts.profiling ?? false,
  );
  const bridgeResult = await runner.waitForBridge(opts.waitMs ?? DEFAULT_BRIDGE_WAIT_MS);

  if (!bridgeResult.ready) {
    throw new Error(
      `Bridge failed to initialise: ${bridgeResult.error ?? 'unknown error'}. ` +
        `A display is available, so this is not a skip - runProject or the bridge is broken.`,
    );
  }

  return { ready: true };
}
