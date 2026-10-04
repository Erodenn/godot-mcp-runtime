/**
 * Integration tests for background mode against a real Godot process.
 *
 * Background mode parks the game window off-screen after startup. Doing that
 * must not disturb the viewport: a window that grows when it goes borderless
 * shifts the viewport's final transform, and every injected click then lands
 * somewhere other than where it was aimed. These tests launch the probe scene
 * with `background: true` and check that the transform is still the identity,
 * the window still has the viewport's size, and a click at a button's centre
 * (by name and by coordinates) still presses that button.
 *
 * Requires GODOT_PATH; skipped when it is unset. `hit` depends on the
 * viewport's hovered-control API, so that assertion branches on the same
 * engine probe `simulate-input-observed.test.ts` uses.
 */

import { describe, beforeAll, beforeEach, afterEach, afterAll, expect } from 'vitest';
import { cpSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { itGodot } from '../helpers/godot-skip.js';
import { runProjectOrSkip } from '../helpers/run-project-or-skip.js';
import { fixtureProjectPath, inputProbeScenePath } from '../helpers/fixture-paths.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { handleSimulateInput } from '../../src/tools/runtime-tools.js';

const PLAIN_BTN = '/root/InputProbe/PlainBtn';
const TEST_TIMEOUT_MS = 60000;
const BRIDGE_CMD_TIMEOUT_MS = 15000;
/**
 * The bridge applies the background flags in its `_ready`, and a window
 * manager can take a moment to settle the new size afterwards. The transform
 * is read after this many milliseconds so a late change would be seen.
 */
const SETTLE_MS = 2500;
/** Decimal places the transform must match the identity to: float noise only, far below the 0.8 percent the bug produced. */
const TRANSFORM_PRECISION_DIGITS = 4;

interface InputEntry {
  ok?: boolean;
  signals?: string[];
  hit?: string;
}

const tmpDirs: string[] = [];

let runner: GodotRunner;

/** A throwaway copy of the fixture project whose main scene is the probe scene. */
function makeProbeProject(): string {
  const id = randomBytes(6).toString('hex');
  const dst = join(tmpdir(), `godot-mcp-background-${id}`);
  cpSync(fixtureProjectPath, dst, { recursive: true });
  const projectFile = join(dst, 'project.godot');
  const content = readFileSync(projectFile, 'utf8').replace(
    'res://main.tscn',
    `res://${inputProbeScenePath}`,
  );
  expect(content, 'project.godot main scene must point at the probe scene').toContain(
    inputProbeScenePath,
  );
  writeFileSync(projectFile, content, 'utf8');
  return dst;
}

function currentProject(): string {
  return tmpDirs[tmpDirs.length - 1]!;
}

/** Run GDScript in the live process through the bridge. `bodyLines` are the body of `execute`. */
async function script(bodyLines: string[]): Promise<unknown> {
  const source =
    'extends RefCounted\n' +
    'func execute(scene_tree: SceneTree) -> Variant:\n' +
    `${bodyLines.map((line) => `\t${line}`).join('\n')}\n`;
  const raw = await runner.sendCommand('run_script', { source }, BRIDGE_CMD_TIMEOUT_MS);
  const parsed = JSON.parse(raw) as { error?: string; result?: unknown };
  if (parsed.error) {
    throw new Error(`bridge run_script failed: ${JSON.stringify(parsed)}`);
  }
  return parsed.result;
}

async function probeHoverApi(): Promise<boolean> {
  const result = (await script([
    'return {"has_api": scene_tree.root.has_method("gui_get_hovered_control")}',
  ])) as { has_api?: boolean } | null;
  return result?.has_api === true;
}

/** The handler's results[] for a batch. Throws on an error response. */
async function simulate(actions: Record<string, unknown>[]): Promise<InputEntry[]> {
  const result = await handleSimulateInput(runner, { actions });
  if (!result.ok) {
    throw new Error(`simulate_input returned an error response: ${JSON.stringify(result.error)}`);
  }
  const structured = result.value.structuredContent as unknown as { results: InputEntry[] };
  return structured.results;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeAll(async () => {
  runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
  await runner.detectGodotPath();
});

beforeEach(() => {
  tmpDirs.push(makeProbeProject());
});

afterEach(async () => {
  await runner.stopProject().catch(() => undefined);
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

describe('background mode (live bridge)', () => {
  itGodot(
    'keeps the viewport transform an identity and the window at the viewport size',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, currentProject(), { background: true });
      await sleep(SETTLE_MS);

      const state = (await script([
        'var t := scene_tree.root.get_final_transform()',
        'var w := DisplayServer.window_get_size()',
        'var v := scene_tree.root.size',
        'return {"x_x": t.x.x, "x_y": t.x.y, "y_x": t.y.x, "y_y": t.y.y, "o_x": t.origin.x, "o_y": t.origin.y, "win_w": w.x, "win_h": w.y, "view_w": v.x, "view_h": v.y}',
      ])) as Record<string, number>;

      const description = JSON.stringify(state);
      expect(state.x_x, description).toBeCloseTo(1, TRANSFORM_PRECISION_DIGITS);
      expect(state.x_y, description).toBeCloseTo(0, TRANSFORM_PRECISION_DIGITS);
      expect(state.y_x, description).toBeCloseTo(0, TRANSFORM_PRECISION_DIGITS);
      expect(state.y_y, description).toBeCloseTo(1, TRANSFORM_PRECISION_DIGITS);
      expect(state.o_x, description).toBeCloseTo(0, TRANSFORM_PRECISION_DIGITS);
      expect(state.o_y, description).toBeCloseTo(0, TRANSFORM_PRECISION_DIGITS);
      expect(state.win_w, description).toBe(state.view_w);
      expect(state.win_h, description).toBe(state.view_h);
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'click_element presses the plain button and reports it as the hit control',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, currentProject(), { background: true });
      await sleep(SETTLE_MS);
      const hoverApi = await probeHoverApi();

      const results = await simulate([{ type: 'click_element', element: PLAIN_BTN }]);

      expect(results).toHaveLength(1);
      const entry = results[0]!;
      expect(entry.ok, JSON.stringify(entry)).toBe(true);
      expect(entry.signals, JSON.stringify(entry)).toEqual(['pressed']);
      if (hoverApi) {
        expect(entry.hit, JSON.stringify(entry)).toBe(PLAIN_BTN);
      } else {
        expect(entry.hit).toBeUndefined();
      }
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'a mouse_button click at the button centre presses it',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, currentProject(), { background: true });
      await sleep(SETTLE_MS);

      const centre = (await script([
        `var c := (scene_tree.root.get_node("${PLAIN_BTN.replace('/root/', '')}") as Control).get_global_rect().get_center()`,
        'return {"x": c.x, "y": c.y}',
      ])) as { x: number; y: number };

      // Observe the press from inside the engine: a bare mouse_button action
      // reports no signals, so count `pressed` on the button for the click.
      await script([
        `var btn := scene_tree.root.get_node("${PLAIN_BTN.replace('/root/', '')}") as Button`,
        'btn.set_meta("mcp_press_count", 0)',
        'btn.pressed.connect(func(): btn.set_meta("mcp_press_count", int(btn.get_meta("mcp_press_count")) + 1))',
        'return null',
      ]);

      const results = await simulate([
        { type: 'mouse_button', button: 'left', x: centre.x, y: centre.y },
      ]);
      expect(results[0]?.ok, JSON.stringify(results)).toBe(true);

      const counted = (await script([
        `var btn := scene_tree.root.get_node("${PLAIN_BTN.replace('/root/', '')}")`,
        'return {"count": int(btn.get_meta("mcp_press_count"))}',
      ])) as { count: number };
      expect(counted.count, `click at ${JSON.stringify(centre)}`).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );
});
