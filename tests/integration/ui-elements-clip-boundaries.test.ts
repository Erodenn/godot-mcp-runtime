/** A clip_contents Control clips through CanvasItem children only: get_ui_elements and the click_element clip check must both stop it at a CanvasLayer or a plain Node and carry it through a Node2D. */

import { describe, beforeAll, afterEach, afterAll, expect } from 'vitest';
import { cpSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import type { TestContext } from 'vitest';
import { removeTmpDir } from '../helpers/tmp.js';
import { itGodot } from '../helpers/godot-skip.js';
import { runProjectOrSkip } from '../helpers/run-project-or-skip.js';
import { fixtureProjectPath } from '../helpers/fixture-paths.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { handleGetUiElements, handleSimulateInput } from '../../src/tools/runtime-tools.js';

const TEST_TIMEOUT_MS = 60000;
const BRIDGE_CMD_TIMEOUT_MS = 15000;
const TMP_ID_BYTES = 6;
const CLIP = '/root/ClipBoundary';
const LAYER_BTN = `${CLIP}/Layer/LayerBtn`;
const PLAIN_BTN = `${CLIP}/Plain/PlainBtn`;
const BODY_BTN = `${CLIP}/Body/BodyBtn`;

/** ClipBoundary is 10x10 at (20, 20); every button is drawn well outside it. */
const BUILD_SCENE = [
  'var clip := Control.new()',
  'clip.name = "ClipBoundary"',
  'clip.clip_contents = true',
  'clip.position = Vector2(20, 20)',
  'clip.size = Vector2(10, 10)',
  'scene_tree.root.add_child(clip)',
  'var layer := CanvasLayer.new()',
  'layer.name = "Layer"',
  'clip.add_child(layer)',
  'var plain := Node.new()',
  'plain.name = "Plain"',
  'clip.add_child(plain)',
  'var body := Node2D.new()',
  'body.name = "Body"',
  'clip.add_child(body)',
  'var parents := {"LayerBtn": [layer, Vector2(80, 40)], "PlainBtn": [plain, Vector2(80, 120)], "BodyBtn": [body, Vector2(60, 180)]}',
  'for btn_name: String in parents:',
  '\tvar btn := Button.new()',
  '\tbtn.name = btn_name',
  '\tbtn.position = parents[btn_name][1]',
  '\tbtn.size = Vector2(60, 40)',
  '\tbtn.pressed.connect(scene_tree.root.set_meta.bind("pressed_" + btn_name, true))',
  '\tparents[btn_name][0].add_child(btn)',
  'return true',
];

interface UiElement {
  path: string;
  onScreen: boolean;
}

let runner: GodotRunner;
const tmpDirs: string[] = [];

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

async function startWithClipScene(ctx: Pick<TestContext, 'skip'>): Promise<void> {
  const project = join(tmpdir(), `godot-mcp-clip-${randomBytes(TMP_ID_BYTES).toString('hex')}`);
  cpSync(fixtureProjectPath, project, { recursive: true });
  tmpDirs.push(project);
  await runProjectOrSkip(runner, ctx, project);
  expect(await script(BUILD_SCENE)).toBe(true);
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

describe('clipping across canvas boundaries (live bridge)', () => {
  itGodot(
    'get_ui_elements lists controls under a CanvasLayer or a plain Node as on screen, and one under a Node2D as clipped',
    async (ctx) => {
      await startWithClipScene(ctx);

      const listed = await elements(true);
      expect(listed.get(LAYER_BTN)?.onScreen, [...listed.keys()].join(', ')).toBe(true);
      expect(listed.get(PLAIN_BTN)?.onScreen, [...listed.keys()].join(', ')).toBe(true);
      expect(listed.has(BODY_BTN), 'a control clipped through a Node2D is not listed').toBe(false);

      const all = await elements(false);
      expect(all.get(BODY_BTN)?.onScreen).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'click_element presses the controls the listing shows and refuses the clipped one by name',
    async (ctx) => {
      await startWithClipScene(ctx);

      const result = await handleSimulateInput(runner, {
        actions: [
          { type: 'click_element', element: LAYER_BTN },
          { type: 'click_element', element: PLAIN_BTN },
        ],
      });
      if (!result.ok) throw new Error(`simulate_input error: ${JSON.stringify(result.error)}`);
      const pressed = result.value.structuredContent as unknown as {
        success?: boolean;
        results: Record<string, unknown>[];
      };
      expect(pressed.success, JSON.stringify(pressed)).toBe(true);

      const refused = await handleSimulateInput(runner, {
        actions: [{ type: 'click_element', element: BODY_BTN }],
      });
      if (!refused.ok) throw new Error(`simulate_input error: ${JSON.stringify(refused.error)}`);
      const entry = (
        refused.value.structuredContent as unknown as { results: Record<string, unknown>[] }
      ).results[0]!;
      expect(entry.ok, JSON.stringify(entry)).toBe(false);
      expect(String(entry.error)).toMatch(/clipped by .*ClipBoundary/);

      expect(
        await script([
          'var root := scene_tree.root',
          'return [root.get_meta("pressed_LayerBtn", false), root.get_meta("pressed_PlainBtn", false), root.get_meta("pressed_BodyBtn", false)]',
        ]),
      ).toEqual([true, true, false]);
    },
    TEST_TIMEOUT_MS,
  );
});
