// get_ui_elements must report a control clipped by its ScrollContainer or a clip_contents ancestor as off screen, and click_element must scroll a scrollable target into view or refuse a clipped one by name.
// Press counts live on the root script of `input_probe_scroll.tscn` and are read through run_script, so a stray press shows up even when the result says nothing.

import { describe, beforeAll, beforeEach, afterEach, afterAll, expect } from 'vitest';
import { cpSync, readFileSync, writeFileSync } from 'fs';
import { removeTmpDir } from '../helpers/tmp.js';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { itGodot } from '../helpers/godot-skip.js';
import { runProjectOrSkip } from '../helpers/run-project-or-skip.js';
import { fixtureProjectPath, inputScrollScenePath } from '../helpers/fixture-paths.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { handleGetUiElements, handleSimulateInput } from '../../src/tools/runtime-tools.js';

const ROOT = '/root/ScrollProbe';
const SCROLL = `${ROOT}/Scroll`;
const TEST_TIMEOUT_MS = 60000;
const BRIDGE_CMD_TIMEOUT_MS = 15000;

interface InputPayload {
  success?: boolean;
  results: Record<string, unknown>[];
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface UiElement {
  path: string;
  visible: boolean;
  onScreen: boolean;
  rect: Rect;
  visibleRect?: Rect;
}

const tmpDirs: string[] = [];
let runner: GodotRunner;

function makeProject(): string {
  const dst = join(tmpdir(), `godot-mcp-scroll-${randomBytes(6).toString('hex')}`);
  cpSync(fixtureProjectPath, dst, { recursive: true });
  const projectFile = join(dst, 'project.godot');
  const content = readFileSync(projectFile, 'utf8').replace(
    'res://main.tscn',
    `res://${inputScrollScenePath}`,
  );
  expect(content).toContain(inputScrollScenePath);
  writeFileSync(projectFile, content, 'utf8');
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
  if (parsed.error) throw new Error(`bridge run_script failed: ${JSON.stringify(parsed)}`);
  return parsed.result;
}

async function pressCounts(): Promise<Record<string, number>> {
  return (await script([
    `var probe: Node = scene_tree.root.get_node("${ROOT.slice('/root/'.length)}")`,
    'return probe.presses',
  ])) as Record<string, number>;
}

async function scrollOffset(): Promise<number> {
  const result = (await script([
    `return {"v": scene_tree.root.get_node("${SCROLL.slice('/root/'.length)}").scroll_vertical}`,
  ])) as { v: number };
  return result.v;
}

async function simulate(args: Record<string, unknown>): Promise<InputPayload> {
  const result = await handleSimulateInput(runner, args);
  if (!result.ok) throw new Error(`simulate_input error: ${JSON.stringify(result.error)}`);
  return result.value.structuredContent as unknown as InputPayload;
}

async function elements(visibleOnly: boolean): Promise<Map<string, UiElement>> {
  const result = await handleGetUiElements(runner, { visibleOnly });
  if (!result.ok) throw new Error(`get_ui_elements error: ${JSON.stringify(result.error)}`);
  const list = (result.value.structuredContent as unknown as { elements: UiElement[] }).elements;
  return new Map(list.map((element) => [element.path, element]));
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

describe('get_ui_elements clipping (live bridge)', () => {
  itGodot(
    'a control scrolled or clipped out of view is not on screen',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, currentProject());

      const listed = await elements(true);
      expect(listed.get(`${SCROLL}/Box/Item0`)?.onScreen).toBe(true);
      expect(listed.has(`${SCROLL}/Box/Item9`), 'a scrolled-out control is not listed').toBe(false);
      expect(listed.has(`${ROOT}/ClipPanel/Hidden`), 'a fully clipped control is not listed').toBe(
        false,
      );

      const partial = listed.get(`${ROOT}/ClipPanel/Partial`)!;
      expect(partial.onScreen).toBe(true);
      expect(partial.visibleRect, JSON.stringify(partial)).toBeDefined();
      expect(partial.visibleRect!.height).toBeLessThan(partial.rect.height);
      expect(partial.visibleRect!.y).toBe(partial.rect.y);

      const all = await elements(false);
      for (const path of [`${SCROLL}/Box/Item9`, `${ROOT}/ClipPanel/Hidden`]) {
        const element = all.get(path)!;
        expect(element.visible, path).toBe(true);
        expect(element.onScreen, path).toBe(false);
        expect(element.visibleRect, path).toBeUndefined();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe('simulate_input click_element and clipping (live bridge)', () => {
  itGodot(
    'a target scrolled out of its ScrollContainer is scrolled into view and pressed',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, currentProject());
      expect(await scrollOffset()).toBe(0);

      const payload = await simulate({
        actions: [{ type: 'click_element', element: `${SCROLL}/Box/Item9` }],
      });
      const entry = payload.results[0]!;

      expect(entry.ok, `entry=${JSON.stringify(entry)}`).toBe(true);
      expect(entry.scrolled).toEqual([SCROLL]);
      expect(await scrollOffset()).toBeGreaterThan(0);
      expect(await pressCounts()).toEqual({ Item9: 1 });
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'a target already in view is clicked without scrolling, and one scrolled past is scrolled back',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, currentProject());

      const payload = await simulate({
        actions: [
          { type: 'click_element', element: `${SCROLL}/Box/Item0` },
          { type: 'click_element', element: `${SCROLL}/Box/Item9` },
          { type: 'click_element', element: `${SCROLL}/Box/Item0` },
        ],
      });

      expect(payload.success, `payload=${JSON.stringify(payload)}`).toBe(true);
      expect(payload.results[0]).not.toHaveProperty('scrolled');
      expect(payload.results[1]!.scrolled).toEqual([SCROLL]);
      expect(payload.results[2]!.scrolled).toEqual([SCROLL]);
      expect(await pressCounts()).toEqual({ Item0: 2, Item9: 1 });
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'a target clipped by a non-scrolling ancestor is refused as clipped, not occluded, and nothing is pressed',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, currentProject());

      const payload = await simulate({
        actions: [{ type: 'click_element', element: `${ROOT}/ClipPanel/Hidden` }],
      });
      const entry = payload.results[0]!;

      expect(entry.ok, `entry=${JSON.stringify(entry)}`).toBe(false);
      expect(String(entry.error)).toMatch(/clipped by .*ClipPanel/);
      expect(String(entry.error)).not.toMatch(/occluded/);
      expect(entry).not.toHaveProperty('scrolled');
      expect(entry).not.toHaveProperty('hit');
      expect(await pressCounts()).toEqual({});
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'a target whose centre is clipped but whose edge shows is refused too',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, currentProject());

      const payload = await simulate({
        actions: [{ type: 'click_element', element: `${ROOT}/ClipPanel/Partial` }],
      });
      const entry = payload.results[0]!;

      expect(entry.ok, `entry=${JSON.stringify(entry)}`).toBe(false);
      expect(String(entry.error)).toMatch(/clipped by .*ClipPanel/);
      expect(await pressCounts()).toEqual({});
    },
    TEST_TIMEOUT_MS,
  );
});
