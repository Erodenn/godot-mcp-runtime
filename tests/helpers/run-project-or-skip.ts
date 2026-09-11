/**
 * Shared preamble for integration tests that spawn a real Godot project and
 * wait for the MCP bridge before doing anything else.
 *
 * Five files under `tests/integration/` used to repeat the same
 * `runProject` + `waitForBridge` + skip-or-throw block by hand. Extracting it
 * here makes the "the only condition an itGodot runtime test may skip on
 * beyond the `hasGodot` gate is a headless-environment error" rule mechanical
 * rather than comment-enforced: every caller goes through the same check, so
 * a copy that silently drops the `isHeadlessEnvironmentError` guard (or
 * widens it to swallow other failures) cannot exist.
 */

import type { TestContext } from 'vitest';
import type { GodotRunner } from '../../src/utils/godot-runner.js';
import { isHeadlessEnvironmentError } from './godot-skip.js';

const DEFAULT_BRIDGE_WAIT_MS = 20000;

export interface RunProjectOrSkipOptions {
  scene?: string;
  background?: boolean;
  bridgePort?: number;
  profiling?: boolean;
  /** Passed to waitForBridge. Default: 20000ms. */
  waitMs?: number;
}

/**
 * Runs the project, waits for the bridge, and either returns once it is
 * ready, calls `ctx.skip()` for a headless-environment failure (which throws
 * to abort the test as skipped, not passed), or throws for any other
 * failure - a real bug that must not pass silently.
 */
export async function runProjectOrSkip(
  runner: GodotRunner,
  ctx: Pick<TestContext, 'skip'>,
  projectPath: string,
  opts: RunProjectOrSkipOptions = {},
): Promise<{ ready: true }> {
  await runner.runProject(
    projectPath,
    opts.scene,
    opts.background ?? false,
    opts.bridgePort,
    opts.profiling ?? false,
  );
  const bridgeResult = await runner.waitForBridge(opts.waitMs ?? DEFAULT_BRIDGE_WAIT_MS);

  if (!bridgeResult.ready) {
    // Distinguish "no display server" (acceptable skip) from "process exited
    // / port collision / bridge code is broken" (real failure that must not
    // pass silently). ctx.skip() reports the test as skipped - a bare
    // `return` would silently mark it passed, hiding the no-display case.
    if (isHeadlessEnvironmentError(bridgeResult.error)) {
      ctx.skip(`display server unavailable (${bridgeResult.error})`);
    }
    throw new Error(
      `Bridge failed to initialise: ${bridgeResult.error ?? 'unknown error'}. ` +
        `This is not a "no display" skip - runProject or the bridge is broken.`,
    );
  }

  return { ready: true };
}
