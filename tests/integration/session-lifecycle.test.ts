import { describe, beforeAll, afterEach, expect } from 'vitest';
import { existsSync, readFileSync, cpSync } from 'fs';
import { removeTmpDir } from '../helpers/tmp.js';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { itGodot } from '../helpers/godot-skip.js';
import { runProjectOrSkip } from '../helpers/run-project-or-skip.js';
import { fixtureProjectPath } from '../helpers/fixture-paths.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { handleGetDebugOutput, handleStopProject } from '../../src/tools/runtime-tools.js';
import { hasError, unwrap } from '../helpers/assertions.js';
import { bridgeDir, mcpDir } from '../../src/utils/artifact-paths.js';

const BRIDGE_WAIT_MS = 20000;
const CASE_TIMEOUT_MS = 60000;
const EXIT_WAIT_MS = 15000;

describe('spawned session self-exit', () => {
  let runner: GodotRunner;
  let tmpProject: string | null = null;

  beforeAll(async () => {
    runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
    await runner.detectGodotPath();
  });

  afterEach(async () => {
    try {
      await runner.stopProject();
    } catch {}
    if (tmpProject) {
      try {
        removeTmpDir(tmpProject);
      } catch {}
      tmpProject = null;
    }
  });

  itGodot(
    'auto-clears the session and stays idempotent when the process is killed externally',
    async (ctx) => {
      const id = randomBytes(6).toString('hex');
      tmpProject = join(tmpdir(), `godot-mcp-runtime-selfexit-${id}`);
      cpSync(fixtureProjectPath, tmpProject, { recursive: true });

      await runProjectOrSkip(runner, ctx, tmpProject, { waitMs: BRIDGE_WAIT_MS });
      const spawned = runner.activeProcess!;
      expect(existsSync(bridgeDir(tmpProject))).toBe(true);

      // Killed from outside with no stop_project call, the way a crash or a closed window would.
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
      // The 'exit' listener under test is registered before this one, so it has already run when the promise settles.

      expect(runner.activeSessionMode).toBeNull();
      expect(runner.activeProjectPath).toBeNull();
      expect(runner.activeBridgePort).toBeNull();
      expect(runner.hasActiveRuntimeSession()).toBe(false);
      expect(runner.activeProcess).not.toBeNull();
      expect(runner.activeProcess!.hasExited).toBe(true);

      expect(existsSync(bridgeDir(tmpProject))).toBe(false);
      expect(readFileSync(join(tmpProject, 'project.godot'), 'utf8')).not.toContain('McpBridge=');
      expect(existsSync(mcpDir(tmpProject))).toBe(true);

      const debugResult = handleGetDebugOutput(runner, {});
      expect(hasError(debugResult)).toBe(false);
      const debug = JSON.parse(unwrap(debugResult).content[0].text);
      expect(debug.running).toBe(false);
      expect(debug.exitCode !== undefined).toBe(true);

      const stopResult = await handleStopProject(runner);
      expect(hasError(stopResult)).toBe(false);
      const stopped = JSON.parse(unwrap(stopResult).content[0].text);
      expect(stopped.alreadyExited).toBe(true);
      expect(stopped.sessionMode).toBe('spawned');
      expect(runner.activeProcess).toBeNull();
    },
    CASE_TIMEOUT_MS,
  );
});
