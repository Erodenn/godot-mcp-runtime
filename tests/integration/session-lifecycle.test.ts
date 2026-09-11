/**
 * AC3.9's real-process half: a spawned Godot that dies on its own (killed
 * from outside, the same shape as a crash or a window the user closed) must
 * clear its own session and bridge artifacts, keep its captured logs readable
 * through `get_debug_output`, and let `stop_project` succeed idempotently.
 *
 * Requires GODOT_PATH.
 */

import { describe, beforeAll, afterEach, expect } from 'vitest';
import { existsSync, readFileSync, cpSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { itGodot, isHeadlessEnvironmentError } from '../helpers/godot-skip.js';
import { fixtureProjectPath } from '../helpers/fixture-paths.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { handleGetDebugOutput, handleStopProject } from '../../src/tools/runtime-tools.js';
import { hasError, unwrap } from '../helpers/assertions.js';
import { bridgeDir, mcpDir } from '../../src/utils/artifact-paths.js';

const BRIDGE_WAIT_MS = 20000;
const CASE_TIMEOUT_MS = 60000;
/** How long to wait for the OS to deliver the killed process's exit event. */
const EXIT_WAIT_MS = 15000;

describe('spawned session self-exit', () => {
  let runner: GodotRunner;
  let tmpProject: string | null = null;

  beforeAll(async () => {
    runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
    await runner.detectGodotPath();
  });

  // Runs even when an assertion above threw, so no Godot is stranded.
  afterEach(async () => {
    try {
      await runner.stopProject();
    } catch {
      // already stopped
    }
    if (tmpProject) {
      try {
        rmSync(tmpProject, { recursive: true, force: true });
      } catch {
        // best-effort
      }
      tmpProject = null;
    }
  });

  itGodot(
    'auto-clears the session and stays idempotent when the process is killed externally',
    async (ctx) => {
      const id = randomBytes(6).toString('hex');
      tmpProject = join(tmpdir(), `godot-mcp-runtime-selfexit-${id}`);
      cpSync(fixtureProjectPath, tmpProject, { recursive: true });

      const spawned = await runner.runProject(tmpProject);
      const bridgeResult = await runner.waitForBridge(BRIDGE_WAIT_MS);
      if (!bridgeResult.ready) {
        if (isHeadlessEnvironmentError(bridgeResult.error)) {
          ctx.skip(`display server unavailable (${bridgeResult.error})`);
        }
        throw new Error(`Bridge failed to initialise: ${bridgeResult.error ?? 'unknown error'}`);
      }
      expect(existsSync(bridgeDir(tmpProject))).toBe(true);

      // Kill it the way the engine crashing or the user closing the window
      // would: from outside, with no stop_project call.
      const exited = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Godot process did not exit within timeout')),
          EXIT_WAIT_MS,
        );
        spawned.process.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      spawned.process.kill('SIGKILL');
      await exited;
      // The 'exit' listener under test is registered before this one, so it
      // has already run by the time the promise settles.

      // D10: session fields cleared, process and its logs retained.
      expect(runner.activeSessionMode).toBeNull();
      expect(runner.activeProjectPath).toBeNull();
      expect(runner.activeBridgePort).toBeNull();
      expect(runner.hasActiveRuntimeSession()).toBe(false);
      expect(runner.activeProcess).not.toBeNull();
      expect(runner.activeProcess!.hasExited).toBe(true);

      // Bridge artifacts are gone from disk; the .mcp container is not.
      expect(existsSync(bridgeDir(tmpProject))).toBe(false);
      expect(readFileSync(join(tmpProject, 'project.godot'), 'utf8')).not.toContain('McpBridge=');
      expect(existsSync(mcpDir(tmpProject))).toBe(true);

      // AC3.9: the logs are still reachable and the exit is reported.
      const debugResult = handleGetDebugOutput(runner, {});
      expect(hasError(debugResult)).toBe(false);
      const debug = JSON.parse(unwrap(debugResult).content[0].text);
      expect(debug.running).toBe(false);
      expect(debug.exitCode !== undefined).toBe(true);

      // D11: stop_project succeeds and says the process had already exited.
      const stopResult = await handleStopProject(runner);
      expect(hasError(stopResult)).toBe(false);
      const stopped = JSON.parse(unwrap(stopResult).content[0].text);
      expect(stopped.alreadyExited).toBe(true);
      expect(stopped.mode).toBe('spawned');
      expect(runner.activeProcess).toBeNull();
    },
    CASE_TIMEOUT_MS,
  );
});
