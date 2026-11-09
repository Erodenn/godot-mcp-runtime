// Controls under a transformed CanvasLayer, a viewport canvas_transform and a runtime content_scale_factor (issue #76).
// Each transform is read back from the running game before an assertion uses it, so a platform that ignores one fails instead of passing vacuously.

import { describe, beforeAll, beforeEach, afterEach, afterAll, expect } from 'vitest';
import { cpSync } from 'fs';
import { removeTmpDir } from '../helpers/tmp.js';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { itGodot } from '../helpers/godot-skip.js';
import { runProjectOrSkip } from '../helpers/run-project-or-skip.js';
import {
  canvasLayerFixtureProjectPath,
  canvasLayerProbeScenePath,
  contentScaleProbeScenePath,
} from '../helpers/fixture-paths.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { handleSimulateInput } from '../../src/tools/runtime-tools.js';

const LAYER_ROOT = '/root/CanvasLayerProbe';
const LAYERED_BTN = `${LAYER_ROOT}/Layer/LayeredBtn`;
const PLAIN_BTN = `${LAYER_ROOT}/PlainBtn`;
const SCALE_ROOT = '/root/ContentScaleProbe';
const SCALE_BTN_PATHS = {
  left: `${SCALE_ROOT}/LeftBtn`,
  middle: `${SCALE_ROOT}/MiddleBtn`,
  right: `${SCALE_ROOT}/RightBtn`,
};
const BRIDGE_CMD_TIMEOUT_MS = 15000;
const TEST_TIMEOUT_MS = 60000;
const RECT_TOLERANCE_PX = 0.6;
const SCALE_TOLERANCE = 0.001;
/** Must match the layer in canvas_layer_probe.tscn; the test reads the live values and only then compares. */
const LAYER_SCALE = 2;
const CANVAS_SHIFT_X = 40;
const CANVAS_SHIFT_Y = 30;
// KEEP IN SYNC: CONTENT_SCALE_FACTOR in tests/fixtures/godot-canvas-layer-project/content_scale_probe.gd
const CONTENT_SCALE_FACTOR = 0.7;
const FACTOR_IN_EFFECT_MIN_DELTA = 0.05;

type InputEntry = Record<string, unknown>;

interface InputPayload {
  success?: boolean;
  results: InputEntry[];
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface UiElement {
  path: string;
  rect: Rect;
  onScreen: boolean;
  visibleRect?: Rect;
}

const tmpDirs: string[] = [];
let runner: GodotRunner;

function makeProject(): string {
  const dst = join(tmpdir(), `godot-mcp-canvas-layer-${randomBytes(6).toString('hex')}`);
  cpSync(canvasLayerFixtureProjectPath, dst, { recursive: true });
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

async function simulate(args: Record<string, unknown>): Promise<InputPayload> {
  const result = await handleSimulateInput(runner, args);
  if (!result.ok) {
    throw new Error(`simulate_input returned an error response: ${JSON.stringify(result.error)}`);
  }
  return result.value.structuredContent as unknown as InputPayload;
}

async function uiElement(path: string): Promise<UiElement> {
  const raw = await runner.sendCommand(
    'get_ui_elements',
    { visible_only: true },
    BRIDGE_CMD_TIMEOUT_MS,
  );
  const parsed = JSON.parse(raw) as { elements: UiElement[] };
  const found = parsed.elements.find((element) => element.path === path);
  expect(found, `get_ui_elements must list ${path}; got ${raw}`).toBeDefined();
  return found!;
}

function center(rect: Rect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function expectRectNear(actual: Rect, expected: Rect): void {
  const message = `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`;
  expect(Math.abs(actual.x - expected.x), message).toBeLessThanOrEqual(RECT_TOLERANCE_PX);
  expect(Math.abs(actual.y - expected.y), message).toBeLessThanOrEqual(RECT_TOLERANCE_PX);
  expect(Math.abs(actual.width - expected.width), message).toBeLessThanOrEqual(RECT_TOLERANCE_PX);
  expect(Math.abs(actual.height - expected.height), message).toBeLessThanOrEqual(RECT_TOLERANCE_PX);
}

interface LayerFacts {
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
  local: Rect;
}

/** The layer's live transform and the button's local rect, asserted to be in effect before anything is compared with them. */
async function layerFacts(): Promise<LayerFacts> {
  const facts = (await script([
    'var layer := scene_tree.root.get_node("CanvasLayerProbe/Layer") as CanvasLayer',
    'var btn := scene_tree.root.get_node("CanvasLayerProbe/Layer/LayeredBtn") as Button',
    'return {"scaleX": layer.scale.x, "scaleY": layer.scale.y, "offsetX": layer.offset.x, "offsetY": layer.offset.y, "local": {"x": btn.position.x, "y": btn.position.y, "width": btn.size.x, "height": btn.size.y}}',
  ])) as LayerFacts;
  expect(
    Math.abs(facts.scaleX - LAYER_SCALE),
    `the layer scale is not in effect, so the other assertions would pass vacuously; facts=${JSON.stringify(facts)}`,
  ).toBeLessThan(SCALE_TOLERANCE);
  expect(facts.scaleY).toBeCloseTo(LAYER_SCALE, 3);
  expect(
    facts.offsetX !== 0 || facts.offsetY !== 0,
    `the layer offset is zero; facts=${JSON.stringify(facts)}`,
  ).toBe(true);
  return facts;
}

function drawnRect(facts: LayerFacts, shiftX = 0, shiftY = 0): Rect {
  return {
    x: facts.offsetX + facts.local.x * facts.scaleX + shiftX,
    y: facts.offsetY + facts.local.y * facts.scaleY + shiftY,
    width: facts.local.width * facts.scaleX,
    height: facts.local.height * facts.scaleY,
  };
}

async function layerCounts(): Promise<{ layered: number; decoy: number; plain: number }> {
  return (await script([
    'var probe: Node = scene_tree.root.get_node("CanvasLayerProbe")',
    'return {"layered": probe.layered_presses, "decoy": probe.decoy_presses, "plain": probe.plain_presses}',
  ])) as { layered: number; decoy: number; plain: number };
}

async function scaleCounts(): Promise<{ left: number; middle: number; right: number }> {
  return (await script([
    'var probe: Node = scene_tree.root.get_node("ContentScaleProbe")',
    'return {"left": probe.left_presses, "middle": probe.middle_presses, "right": probe.right_presses}',
  ])) as { left: number; middle: number; right: number };
}

beforeAll(async () => {
  runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
  await runner.detectGodotPath();
});

beforeEach(() => {
  tmpDirs.push(makeProject());
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

describe('controls under a transformed CanvasLayer (live bridge)', () => {
  itGodot(
    'get_ui_elements reports the rect the Button is drawn at',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, currentProject(), { scene: canvasLayerProbeScenePath });
      const facts = await layerFacts();

      const element = await uiElement(LAYERED_BTN);

      expectRectNear(element.rect, drawnRect(facts));
      expect(element.onScreen, `element=${JSON.stringify(element)}`).toBe(true);
      expect(element.visibleRect).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'click_element presses the layered Button and not the control under its local rect',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, currentProject(), { scene: canvasLayerProbeScenePath });
      await layerFacts();

      const payload = await simulate({
        actions: [{ type: 'click_element', element: LAYERED_BTN }],
      });

      expect(payload.results[0], `payload=${JSON.stringify(payload)}`).toMatchObject({ ok: true });
      expect(await layerCounts()).toEqual({ layered: 1, decoy: 0, plain: 0 });
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'mouse_button at the center get_ui_elements reports presses the layered Button',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, currentProject(), { scene: canvasLayerProbeScenePath });
      await layerFacts();
      const { x, y } = center((await uiElement(LAYERED_BTN)).rect);

      const payload = await simulate({
        actions: [
          { type: 'mouse_button', x, y, pressed: true },
          { type: 'mouse_button', x, y, pressed: false },
        ],
      });

      expect(payload.success, `payload=${JSON.stringify(payload)}`).toBe(true);
      expect(await layerCounts()).toEqual({ layered: 1, decoy: 0, plain: 0 });
    },
    TEST_TIMEOUT_MS,
  );
});

describe('controls under a viewport canvas_transform (live bridge)', () => {
  itGodot(
    'get_ui_elements and click_element follow a shifted canvas_transform',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, currentProject(), { scene: canvasLayerProbeScenePath });
      const applied = (await script([
        `scene_tree.root.canvas_transform = Transform2D(0.0, Vector2(${CANVAS_SHIFT_X}, ${CANVAS_SHIFT_Y}))`,
        'var plain := scene_tree.root.get_node("CanvasLayerProbe/PlainBtn") as Button',
        'return {"shiftX": scene_tree.root.canvas_transform.origin.x, "shiftY": scene_tree.root.canvas_transform.origin.y, "x": plain.global_position.x, "y": plain.global_position.y, "width": plain.size.x, "height": plain.size.y}',
      ])) as { shiftX: number; shiftY: number } & Rect;
      expect(applied.shiftX, `canvas_transform was not applied; ${JSON.stringify(applied)}`).toBe(
        CANVAS_SHIFT_X,
      );

      const element = await uiElement(PLAIN_BTN);
      expectRectNear(element.rect, {
        x: applied.x + CANVAS_SHIFT_X,
        y: applied.y + CANVAS_SHIFT_Y,
        width: applied.width,
        height: applied.height,
      });

      const payload = await simulate({ actions: [{ type: 'click_element', element: PLAIN_BTN }] });
      expect(payload.results[0], `payload=${JSON.stringify(payload)}`).toMatchObject({ ok: true });
      expect(await layerCounts()).toEqual({ layered: 0, decoy: 0, plain: 1 });
    },
    TEST_TIMEOUT_MS,
  );
});

describe('click_element with a runtime content_scale_factor (live bridge)', () => {
  async function assertFactorInEffect(): Promise<void> {
    const state = (await script([
      'var window := scene_tree.root',
      'return {"factor": window.content_scale_factor, "finalScaleX": window.get_final_transform().x.x}',
    ])) as { factor: number; finalScaleX: number };
    expect(
      state.factor,
      `content_scale_factor was not set; state=${JSON.stringify(state)}`,
    ).toBeCloseTo(CONTENT_SCALE_FACTOR, 3);
    expect(
      Math.abs(state.finalScaleX - 1),
      `the window ignored content_scale_factor (final transform is an identity), so the click tests would pass vacuously; state=${JSON.stringify(state)}`,
    ).toBeGreaterThan(FACTOR_IN_EFFECT_MIN_DELTA);
  }

  itGodot(
    'click_element on the middle Button presses it and no neighbour',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, currentProject(), { scene: contentScaleProbeScenePath });
      await assertFactorInEffect();

      const payload = await simulate({
        actions: [{ type: 'click_element', element: SCALE_BTN_PATHS.middle }],
      });

      expect(payload.results[0], `payload=${JSON.stringify(payload)}`).toMatchObject({ ok: true });
      expect(await scaleCounts()).toEqual({ left: 0, middle: 1, right: 0 });
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'mouse_button at the center get_ui_elements reports presses the middle Button',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, currentProject(), { scene: contentScaleProbeScenePath });
      await assertFactorInEffect();
      const { x, y } = center((await uiElement(SCALE_BTN_PATHS.middle)).rect);

      const payload = await simulate({
        actions: [
          { type: 'mouse_button', x, y, pressed: true },
          { type: 'mouse_button', x, y, pressed: false },
        ],
      });

      expect(payload.success, `payload=${JSON.stringify(payload)}`).toBe(true);
      expect(await scaleCounts()).toEqual({ left: 0, middle: 1, right: 0 });
    },
    TEST_TIMEOUT_MS,
  );
});
