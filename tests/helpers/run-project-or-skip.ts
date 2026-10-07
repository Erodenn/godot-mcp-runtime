/**
 * Shared preamble for integration tests that spawn a real Godot project and
 * wait for the MCP bridge before doing anything else.
 *
 * Five files under `tests/integration/` used to repeat the same
 * `runProject` + `waitForBridge` + skip-or-throw block by hand. Extracting it
 * here makes the "the only condition an itGodot runtime test may skip on
 * beyond the `hasGodot` gate is a headless-environment error" rule mechanical
 * rather than comment-enforced: every caller goes through the same check, so
 * a copy that widens the skip to swallow other failures cannot exist.
 *
 * The one skip is decided before anything is launched, from the same
 * display probe `runProject` itself uses, and never from the text of a
 * failure: a bridge that did not come up on a machine that has a display is a
 * defect even when its stderr mentions "display" (a window-creation error in
 * the engine's display server is exactly that).
 */

import type { TestContext } from 'vitest';
import type { GodotRunner } from '../../src/utils/godot-runner.js';
import { checkDisplayAvailable, resolveProjectPath } from '../../src/utils/path-validation.js';

const DEFAULT_BRIDGE_WAIT_MS = 20000;

/**
 * Set by CI. With no display there, a skip would turn the whole runtime
 * suite green without running it, so the helper throws instead.
 */
const CI_ENV_VAR = 'CI';

/** Set to `1` to let integration-test games show their windows. */
export const SHOW_WINDOWS_ENV_VAR = 'GODOT_MCP_TEST_SHOW_WINDOWS';

/**
 * Whether integration-test games should show their windows. The one decision
 * every launch path in the suite reads: `runProjectOrSkip` for background
 * mode, and tests that spawn Godot themselves for `windowsHide`.
 */
export function showTestWindows(): boolean {
  return process.env[SHOW_WINDOWS_ENV_VAR] === '1';
}

export interface RunProjectOrSkipOptions {
  scene?: string;
  /** Default: true, unless GODOT_MCP_TEST_SHOW_WINDOWS=1. */
  background?: boolean;
  bridgePort?: number;
  profiling?: boolean;
  /** Passed to waitForBridge. Default: 20000ms. */
  waitMs?: number;
}

/**
 * Runs the project, waits for the bridge, and either returns once it is
 * ready, calls `ctx.skip()` when the machine has no display (locally only; in
 * CI that throws), or throws for any failure to start or to reach the bridge
 * - a real bug that must not pass silently.
 */
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
