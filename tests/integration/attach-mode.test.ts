/**
 * `run_project` with `attach: true` against a real Godot launched by the test
 * itself, the way a CI pipeline or a user's own shell would launch it: the
 * bridge is injected first, the externally started process loads it, runtime
 * tools work, and `stop_project` detaches without stopping that process.
 *
 * Requires GODOT_PATH and a display server.
 */

import { describe, afterEach, expect } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { readFileSync, cpSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { itGodot } from '../helpers/godot-skip.js';
import { fixtureProjectPath } from '../helpers/fixture-paths.js';
import { showTestWindows } from '../helpers/run-project-or-skip.js';
import { hasError, unwrap } from '../helpers/assertions.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { createNullContext } from '../../src/utils/mcp-context.js';
import { checkDisplayAvailable } from '../../src/utils/path-validation.js';
import {
  handleGetUiElements,
  handleRunProject,
  handleStopProject,
} from '../../src/tools/runtime-tools.js';

/** Above the 45 s connected-readiness budget, with room for teardown. */
const CASE_TIMEOUT_MS = 90000;
/** How long the bridge inject may take before the external launch is abandoned. */
const INJECT_WAIT_MS = 10000;
const INJECT_POLL_INTERVAL_MS = 50;
/** How long the external Godot is watched after stop_project to prove it was left running. */
const SURVIVAL_OBSERVATION_MS = 2000;
/** How long to wait for the OS to deliver the killed process's exit event. */
const EXIT_WAIT_MS = 15000;
/** Bound on the teardown hook: one exit wait plus the session cleanup. */
const TEARDOWN_TIMEOUT_MS = 30000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Kill an externally launched Godot and wait, bounded, for it to be gone. */
async function killAndAwaitExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, EXIT_WAIT_MS);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  child.kill('SIGKILL');
  await exited;
}

describe('run_project attach mode', () => {
  let runner: GodotRunner | null = null;
  let tmpProject: string | null = null;
  let externalGodot: ChildProcess | null = null;

  // Runs even when an assertion above threw, so no Godot is stranded.
  afterEach(async () => {
    if (externalGodot) {
      await killAndAwaitExit(externalGodot);
      externalGodot = null;
    }
    if (runner) {
      try {
        await runner.stopProject();
      } catch {
        // already stopped
      }
      runner = null;
    }
    if (tmpProject) {
      try {
        rmSync(tmpProject, { recursive: true, force: true });
      } catch {
        // best-effort
      }
      tmpProject = null;
    }
  }, TEARDOWN_TIMEOUT_MS);

  itGodot(
    'attaches to an externally launched Godot and detaches without stopping it',
    async (ctx) => {
      if (!checkDisplayAvailable()) ctx.skip('display server unavailable');

      const id = randomBytes(6).toString('hex');
      tmpProject = join(tmpdir(), `godot-mcp-runtime-attach-${id}`);
      cpSync(fixtureProjectPath, tmpProject, { recursive: true });
      runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });

      // The null context declines every elicitation, so an attach that asked
      // for the launch confirmation would come back as an error here.
      let settled = false;
      const pending = handleRunProject(
        runner,
        { projectPath: tmpProject, attach: true },
        createNullContext(),
      ).finally(() => {
        settled = true;
      });

      // Godot reads autoloads at startup, so launch only once the bridge is in.
      const injectDeadline = Date.now() + INJECT_WAIT_MS;
      while (runner.activeSessionMode !== 'attached' && !settled && Date.now() < injectDeadline) {
        await sleep(INJECT_POLL_INTERVAL_MS);
      }
      expect(runner.activeSessionMode).toBe('attached');

      let spawnError: Error | null = null;
      externalGodot = spawn(process.env.GODOT_PATH!, ['--path', tmpProject], {
        stdio: 'ignore',
        windowsHide: !showTestWindows(),
      });
      externalGodot.once('error', (error) => {
        spawnError = error;
      });

      const runResult = await pending;
      expect(spawnError).toBeNull();
      expect(hasError(runResult), JSON.stringify(unwrap(runResult).content)).toBe(false);
      const started = unwrap(runResult).structuredContent as Record<string, unknown>;
      expect(started.sessionMode).toBe('attached');
      expect(started).not.toHaveProperty('bridgeReady');
      expect(typeof started.bridgePort).toBe('number');
      // Nothing was spawned by this server.
      expect(runner.activeProcess).toBeNull();

      const uiResult = await handleGetUiElements(runner, {});
      expect(hasError(uiResult), JSON.stringify(unwrap(uiResult).content)).toBe(false);

      const stopResult = await handleStopProject(runner);
      expect(hasError(stopResult)).toBe(false);
      const stopped = unwrap(stopResult).structuredContent as Record<string, unknown>;
      expect(stopped.sessionMode).toBe('attached');
      expect(stopped.externalProcessPreserved).toBe(true);

      // The external process is still alive, and the bridge registration is gone.
      // Checked after a pause: an exit that stop_project triggered would not
      // have reached this process's exit event in the same tick.
      await sleep(SURVIVAL_OBSERVATION_MS);
      expect(externalGodot.exitCode).toBeNull();
      expect(externalGodot.signalCode).toBeNull();
      expect(readFileSync(join(tmpProject, 'project.godot'), 'utf8')).not.toContain('McpBridge=');
    },
    CASE_TIMEOUT_MS,
  );
});
