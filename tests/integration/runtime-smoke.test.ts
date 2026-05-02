/**
 * Smoke tests for the runtime bridge (run_project → take_screenshot).
 *
 * These tests launch a real Godot window (or attempt to), verify the MCP
 * bridge initialises, and check that take_screenshot saves a PNG file.
 *
 * NOTE: take_screenshot requires a live display / rendering context. In
 * truly headless environments (no X server, no Wayland, no Windows desktop)
 * Godot's display server will fail to start and the test will time out or
 * error before the bridge is ready. If this is the case in your environment,
 * the test is marked it.skip with a comment — do not remove the test, flag
 * it to the team lead instead.
 *
 * Requires GODOT_PATH. Skipped in CI.
 */

import { describe, beforeAll, afterEach } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { cpSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { itGodot } from '../helpers/godot-skip.js';
import { fixtureProjectPath } from '../helpers/fixture-paths.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';

// Heuristic: bridge failures we treat as "no display server" (skip-worthy)
// rather than real failures. Anything else means runProject or the bridge is
// genuinely broken and the test must fail loudly.
function isHeadlessEnvironmentError(err: string | undefined): boolean {
  if (!err) return false;
  const lower = err.toLowerCase();
  return (
    lower.includes('display') ||
    lower.includes('no x server') ||
    lower.includes('wayland') ||
    lower.includes('cannot open display')
  );
}

describe('runtime bridge smoke', () => {
  let runner: GodotRunner;
  let tmpProject: string | null = null;

  beforeAll(async () => {
    runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
    await runner.detectGodotPath();
  });

  afterEach(async () => {
    try {
      runner.stopProject();
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
    'take_screenshot saves a PNG file after run_project',
    async (ctx) => {
      // Use a tmp copy so the injected McpBridge autoload does not pollute
      // the committed fixture project.godot
      const id = randomBytes(6).toString('hex');
      tmpProject = join(tmpdir(), `godot-mcp-runtime-smoke-${id}`);
      cpSync(fixtureProjectPath, tmpProject, { recursive: true });

      // Start the project — waitForBridge polls until the UDP ping responds
      runner.runProject(tmpProject);
      const bridgeResult = await runner.waitForBridge(12000);

      if (!bridgeResult.ready) {
        // Distinguish "no display server" (acceptable skip) from "process exited
        // / port collision / bridge code is broken" (real failure that must not
        // pass silently). ctx.skip() reports the test as skipped — a bare
        // `return` would silently mark it passed, hiding the no-display case.
        if (isHeadlessEnvironmentError(bridgeResult.error)) {
          ctx.skip(`display server unavailable (${bridgeResult.error})`);
        }
        throw new Error(
          `Bridge failed to initialise: ${bridgeResult.error ?? 'unknown error'}. ` +
            `This is not a "no display" skip — runProject or the bridge is broken.`,
        );
      }

      const response = await runner.sendCommand('screenshot', {}, 15000);
      const parsed = JSON.parse(response) as { path?: string; error?: string };

      if (parsed.error) {
        // Surface the error clearly rather than a confusing assertion failure
        throw new Error(`Screenshot bridge error: ${parsed.error}`);
      }

      expect(parsed).toHaveProperty('path');
      expect(typeof parsed.path).toBe('string');

      // The path comes back as a forward-slash Godot path; normalise for Windows
      const screenshotPath =
        process.platform === 'win32'
          ? (parsed.path as string).replace(/\//g, '\\')
          : (parsed.path as string);

      expect(existsSync(screenshotPath)).toBe(true);

      // The file should live inside .mcp/screenshots/ within the project dir
      const screenshotDir = join(tmpProject, '.mcp', 'screenshots');
      expect(
        screenshotPath.startsWith(screenshotDir.replace(/\\/g, '/')) ||
          screenshotPath.startsWith(screenshotDir),
      ).toBe(true);
    },
    60000,
  );
});
