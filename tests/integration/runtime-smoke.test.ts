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

import { describe, beforeAll, afterEach, expect } from 'vitest';
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
    'take_screenshot saves a PNG file after run_project',
    async (ctx) => {
      // Use a tmp copy so the injected McpBridge autoload does not pollute
      // the committed fixture project.godot
      const id = randomBytes(6).toString('hex');
      tmpProject = join(tmpdir(), `godot-mcp-runtime-smoke-${id}`);
      cpSync(fixtureProjectPath, tmpProject, { recursive: true });

      // Start the project — waitForBridge polls until the TCP ping responds
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

  itGodot(
    'simulate_input key actions populate event.unicode for ASCII letters (Bug #6)',
    async (ctx) => {
      const id = randomBytes(6).toString('hex');
      tmpProject = join(tmpdir(), `godot-mcp-runtime-input-${id}`);
      cpSync(fixtureProjectPath, tmpProject, { recursive: true });

      runner.runProject(tmpProject);
      const bridgeResult = await runner.waitForBridge(12000);

      if (!bridgeResult.ready) {
        if (isHeadlessEnvironmentError(bridgeResult.error)) {
          ctx.skip(`display server unavailable (${bridgeResult.error})`);
        }
        throw new Error(`Bridge failed to initialise: ${bridgeResult.error ?? 'unknown error'}`);
      }

      // Inject a LineEdit, focus it via run_script
      const setupScript = `
extends RefCounted
func execute(scene_tree: SceneTree) -> Variant:
	var le = LineEdit.new()
	le.name = "TestEntry"
	scene_tree.root.add_child(le)
	le.text = ""
	le.grab_focus()
	return {"focused": le.has_focus()}
`;
      const setupResp = JSON.parse(
        await runner.sendCommand('run_script', { source: setupScript }, 10000),
      ) as { result?: { focused?: boolean }; error?: string };
      expect(setupResp.error).toBeUndefined();
      expect(setupResp.result?.focused).toBe(true);

      // Send "H" (shift+H gives uppercase) then "i" via simulate_input bridge
      await runner.sendCommand(
        'input',
        {
          actions: [
            { type: 'key', key: 'H', shift: true, pressed: true },
            { type: 'key', key: 'H', shift: true, pressed: false },
            { type: 'wait', ms: 30 },
            { type: 'key', key: 'I', pressed: true },
            { type: 'key', key: 'I', pressed: false },
            { type: 'wait', ms: 30 },
          ],
        },
        10000,
      );

      const readScript = `
extends RefCounted
func execute(scene_tree: SceneTree) -> Variant:
	var le = scene_tree.root.find_child("TestEntry", true, false)
	return {"text": le.text if le else ""}
`;
      const readResp = JSON.parse(
        await runner.sendCommand('run_script', { source: readScript }, 10000),
      ) as { result?: { text?: string }; error?: string };
      expect(readResp.error).toBeUndefined();
      // Expect "Hi": shift+H → 'H' (uppercase via auto-derive), then 'I' alone
      // would be lowercase 'i' (no shift). The fix maps KEY_A..KEY_Z + shift to
      // KEY_A..KEY_Z (uppercase), no-shift to lowercase.
      expect(readResp.result?.text).toBe('Hi');
    },
    60000,
  );
});
