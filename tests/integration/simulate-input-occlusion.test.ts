// A click_element whose target is covered must be refused before any press reaches the engine, and a target that a layout refresh moved must be clicked where it is now.
// Press counts live on the root script of `input_probe_occlusion.tscn` and are read through run_script, so a stray press on the wrong control shows up even when the result says nothing.

import { describe, beforeAll, beforeEach, afterEach, afterAll, expect } from 'vitest';
import { cpSync, readFileSync, writeFileSync } from 'fs';
import { removeTmpDir } from '../helpers/tmp.js';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { itGodot } from '../helpers/godot-skip.js';
import { runProjectOrSkip } from '../helpers/run-project-or-skip.js';
import { fixtureProjectPath, inputOcclusionScenePath } from '../helpers/fixture-paths.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { handleSimulateInput } from '../../src/tools/runtime-tools.js';

const ROOT = '/root/OcclusionProbe';
const TEST_TIMEOUT_MS = 60000;
const BRIDGE_CMD_TIMEOUT_MS = 15000;

interface InputPayload {
  success?: boolean;
  results: Record<string, unknown>[];
}

interface PressCounts {
  target: number;
  occluder: number;
  rowOne: number;
  rowTwo: number;
  blocker: number;
}

const tmpDirs: string[] = [];
let runner: GodotRunner;

function makeProject(): string {
  const dst = join(tmpdir(), `godot-mcp-occlusion-${randomBytes(6).toString('hex')}`);
  cpSync(fixtureProjectPath, dst, { recursive: true });
  const projectFile = join(dst, 'project.godot');
  const content = readFileSync(projectFile, 'utf8').replace(
    'res://main.tscn',
    `res://${inputOcclusionScenePath}`,
  );
  expect(content).toContain(inputOcclusionScenePath);
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

async function hasHoverApi(): Promise<boolean> {
  const result = (await script([
    'return {"has_api": scene_tree.root.has_method("gui_get_hovered_control")}',
  ])) as { has_api?: boolean } | null;
  return result?.has_api === true;
}

async function pressCounts(): Promise<PressCounts> {
  const raw = (await script([
    `var probe: Node = scene_tree.root.get_node("${ROOT.slice('/root/'.length)}")`,
    'return {"target": probe.target_presses, "occluder": probe.occluder_presses, "rowOne": probe.row_one_presses, "rowTwo": probe.row_two_presses, "blocker": probe.blocker_presses}',
  ])) as PressCounts;
  return raw;
}

async function simulate(args: Record<string, unknown>): Promise<InputPayload> {
  const result = await handleSimulateInput(runner, args);
  if (!result.ok) throw new Error(`simulate_input error: ${JSON.stringify(result.error)}`);
  return result.value.structuredContent as unknown as InputPayload;
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

describe('simulate_input click preflight (live bridge)', () => {
  itGodot(
    'an occluded click fails without pressing the occluder',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, currentProject());
      const hoverApi = await hasHoverApi();

      const payload = await simulate({
        actions: [{ type: 'click_element', element: `${ROOT}/Target` }],
      });
      const entry = payload.results[0]!;
      const counts = await pressCounts();

      if (hoverApi) {
        expect(entry.ok, `entry=${JSON.stringify(entry)}`).toBe(false);
        expect(String(entry.error)).toMatch(/occluded by .*Occluder/);
        expect(entry.hit).toBe(`${ROOT}/Occluder`);
        expect(counts, 'a refused click must not press anything').toMatchObject({
          target: 0,
          occluder: 0,
        });
      } else {
        // Without the hovered-control API nothing can tell, so the click goes through as before.
        expect(entry.ok).toBe(true);
      }
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'a click lands on the row a same-batch layout refresh moved',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, currentProject());

      const payload = await simulate({
        actions: [
          { type: 'click_element', element: `${ROOT}/Rows/RowOne` },
          { type: 'click_element', element: `${ROOT}/Rows/RowTwo` },
        ],
      });
      const counts = await pressCounts();

      expect(payload.success, `payload=${JSON.stringify(payload)}`).toBe(true);
      expect(counts).toMatchObject({ rowOne: 1, rowTwo: 1, blocker: 0 });
    },
    TEST_TIMEOUT_MS,
  );
});
