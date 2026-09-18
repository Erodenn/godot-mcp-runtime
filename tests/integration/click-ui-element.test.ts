/**
 * Integration tests for click_ui_element tool.
 *
 * Requires GODOT_PATH. Skipped in CI without it.
 */

import { describe, beforeAll, beforeEach, afterAll, expect } from 'vitest';
import { cpSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { itGodot } from '../helpers/godot-skip.js';
import { runProjectOrSkip } from '../helpers/run-project-or-skip.js';
import { fixtureProjectPath } from '../helpers/fixture-paths.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';

function makeTmpProject(): string {
  const id = randomBytes(6).toString('hex');
  const dst = join(tmpdir(), `godot-mcp-test-${id}`);
  cpSync(fixtureProjectPath, dst, { recursive: true });
  return dst;
}

const tmpDirs: string[] = [];

let runner: GodotRunner;

beforeAll(async () => {
  runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
  await runner.detectGodotPath();
});

beforeEach(() => {
  tmpDirs.push(makeTmpProject());
});

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe('click_ui_element', () => {
  itGodot(
    'click_ui_element clicks a Button and reports button_pressed state change',
    async (ctx) => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];

      await runProjectOrSkip(runner, ctx, tmpProject);

      // Create a Button with a Label
      const setupScript = `
extends RefCounted
func execute(scene_tree: SceneTree) -> Variant:
	var btn = Button.new()
	btn.name = "TestButton"
	btn.text = "Click Me"
	btn.toggle_mode = true
	btn.button_pressed = false
	scene_tree.root.add_child(btn)
	return {"created": true}
`;
      const setupResp = JSON.parse(
        await runner.sendCommand('run_script', { source: setupScript }, 10000),
      ) as { result?: { created?: boolean }; error?: string };
      expect(setupResp.error).toBeUndefined();
      expect(setupResp.result?.created).toBe(true);

      // Click the button
      const clickResp = JSON.parse(
        await runner.sendCommand('click_ui_element', { element: 'root/TestButton' }, 15000),
      ) as { clicked?: boolean; signal_emitted?: string; new_value?: boolean; error?: string };

      expect(clickResp.error).toBeUndefined();
      expect(clickResp.clicked).toBe(true);
      expect(clickResp.signal_emitted).toBe('toggled');
      expect(clickResp.new_value).toBe(true);
    },
    60000,
  );

  itGodot(
    'click_ui_element rejects nonexistent element',
    async (ctx) => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];

      await runProjectOrSkip(runner, ctx, tmpProject);

      const resp = JSON.parse(
        await runner.sendCommand('click_ui_element', { element: 'NoSuchElement' }, 15000),
      ) as { error?: string };

      expect(resp.error).toContain('Could not find UI element');
    },
    60000,
  );

  itGodot(
    'click_ui_element works with node name (BFS resolution)',
    async (ctx) => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];

      await runProjectOrSkip(runner, ctx, tmpProject);

      const setupScript = `
extends RefCounted
func execute(scene_tree: SceneTree) -> Variant:
	var btn = Button.new()
	btn.name = "MyButton"
	btn.text = "OK"
	scene_tree.root.add_child(btn)
	return {"created": true}
`;
      await runner.sendCommand('run_script', { source: setupScript }, 10000);

      // Click by name only (no path prefix)
      const clickResp = JSON.parse(
        await runner.sendCommand('click_ui_element', { element: 'MyButton' }, 15000),
      ) as { clicked?: boolean; error?: string };

      expect(clickResp.error).toBeUndefined();
      expect(clickResp.clicked).toBe(true);
    },
    60000,
  );
});
