// Positioned injection under `canvas_items` stretch with a window size different from the viewport (issue #76).
// `hit`-dependent assertions branch on the engine hovered-control probe, as simulate-input-observed does.

import { describe, beforeAll, beforeEach, afterEach, afterAll, expect } from 'vitest';
import { cpSync } from 'fs';
import { removeTmpDir } from '../helpers/tmp.js';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { itGodot } from '../helpers/godot-skip.js';
import { runProjectOrSkip } from '../helpers/run-project-or-skip.js';
import { stretchFixtureProjectPath } from '../helpers/fixture-paths.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { handleSimulateInput } from '../../src/tools/runtime-tools.js';

const PROBE_ROOT = '/root/StretchProbe';
const CLICK_BTN = `${PROBE_ROOT}/ClickBtn`;
const GHOST_BTN = `${PROBE_ROOT}/GhostBtn`;
const BRIDGE_CMD_TIMEOUT_MS = 15000;
const TEST_TIMEOUT_MS = 60000;
/** The request is in viewport pixels and inside the 720x1280 viewport; its window-pixel image is a factor of 0.75 smaller. */
const MOTION_X = 500;
const MOTION_Y = 900;
const MOTION_TOLERANCE_PX = 1;

type InputEntry = Record<string, unknown>;

interface InputPayload {
  success?: boolean;
  results: InputEntry[];
}

interface UiElement {
  path: string;
  rect: { x: number; y: number; width: number; height: number };
}

const tmpDirs: string[] = [];
let runner: GodotRunner;

function makeStretchProject(): string {
  const dst = join(tmpdir(), `godot-mcp-stretch-${randomBytes(6).toString('hex')}`);
  cpSync(stretchFixtureProjectPath, dst, { recursive: true });
  return dst;
}

function currentProject(): string {
  return tmpDirs[tmpDirs.length - 1]!;
}

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

async function pressCounts(): Promise<{ press: number; ghost: number }> {
  return (await script([
    'var probe = scene_tree.root.get_node("StretchProbe")',
    'return {"press": probe.press_count, "ghost": probe.ghost_press_count}',
  ])) as { press: number; ghost: number };
}

async function simulate(args: Record<string, unknown>): Promise<InputPayload> {
  const result = await handleSimulateInput(runner, args);
  if (!result.ok) {
    throw new Error(`simulate_input returned an error response: ${JSON.stringify(result.error)}`);
  }
  return result.value.structuredContent as unknown as InputPayload;
}

async function uiRect(path: string): Promise<UiElement['rect']> {
  const raw = await runner.sendCommand(
    'get_ui_elements',
    { visible_only: true },
    BRIDGE_CMD_TIMEOUT_MS,
  );
  const parsed = JSON.parse(raw) as { elements: UiElement[] };
  const found = parsed.elements.find((element) => element.path === path);
  expect(found, `get_ui_elements must list ${path}; got ${raw}`).toBeDefined();
  return found!.rect;
}

beforeAll(async () => {
  runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
  await runner.detectGodotPath();
});

beforeEach(() => {
  tmpDirs.push(makeStretchProject());
});

afterEach(async () => {
  await runner.stopProject().catch(() => undefined);
});

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      removeTmpDir(dir);
    } catch {}
  }
});

describe('simulate_input under canvas_items stretch (live bridge)', () => {
  itGodot(
    'the running window size differs from the viewport size',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, currentProject());
      const sizes = (await script([
        'return {"window": [scene_tree.root.size.x, scene_tree.root.size.y], "viewport": [scene_tree.root.content_scale_size.x, scene_tree.root.content_scale_size.y]}',
      ])) as { window: number[]; viewport: number[] };

      expect(
        sizes.window,
        `the platform ignored the window override, so the other tests would pass vacuously; sizes=${JSON.stringify(sizes)}`,
      ).not.toEqual(sizes.viewport);
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'click_element on the Button runs its pressed handler',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, currentProject());

      const payload = await simulate({ actions: [{ type: 'click_element', element: CLICK_BTN }] });
      const entry = payload.results[0]!;

      expect(entry, `entry=${JSON.stringify(entry)}`).toMatchObject({ ok: true });
      expect(await pressCounts()).toEqual({ press: 1, ghost: 0 });
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'mouse_button press and release at the Button center from get_ui_elements runs the handler',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, currentProject());
      const rect = await uiRect(CLICK_BTN);
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;

      const payload = await simulate({
        actions: [
          { type: 'mouse_button', x, y, pressed: true },
          { type: 'mouse_button', x, y, pressed: false },
        ],
      });

      expect(payload.success, `payload=${JSON.stringify(payload)}`).toBe(true);
      expect(await pressCounts()).toEqual({ press: 1, ghost: 0 });
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'mouse_motion to viewport coordinates reports a position within 1 px of the request',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, currentProject());

      const payload = await simulate({
        actions: [{ type: 'mouse_motion', x: MOTION_X, y: MOTION_Y }],
      });
      const entry = payload.results[0]!;
      const position = entry.position as { x: number; y: number } | undefined;

      expect(position, `entry=${JSON.stringify(entry)}`).toBeDefined();
      expect(Math.abs(position!.x - MOTION_X)).toBeLessThanOrEqual(MOTION_TOLERANCE_PX);
      expect(Math.abs(position!.y - MOTION_Y)).toBeLessThanOrEqual(MOTION_TOLERANCE_PX);
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'click_element on a Control the click cannot reach reports a failure entry',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, currentProject());
      const hoverApi = await probeHoverApi();

      const payload = await simulate({ actions: [{ type: 'click_element', element: GHOST_BTN }] });
      const entry = payload.results[0]!;

      expect(await pressCounts()).toEqual({ press: 0, ghost: 0 });
      if (hoverApi) {
        expect(entry.ok, `entry=${JSON.stringify(entry)}`).toBe(false);
        expect(typeof entry.error, `entry=${JSON.stringify(entry)}`).toBe('string');
        expect(payload.success).toBe(false);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
