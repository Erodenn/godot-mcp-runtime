/**
 * Integration tests for simulate_input against a real Godot window.
 *
 * simulate_input reports what each action actually did: the Control it hit, the
 * signals that fired, the visible-Control delta, watch samples, and the runtime
 * errors a handler raised. Every claim in that list is observed inside the
 * engine rather than inferred from the request, so it can only be verified
 * against a live process. These tests drive the real handler over the real
 * bridge using the committed probe scene, `input_probe.tscn`.
 *
 * Requires GODOT_PATH; skipped when it is unset. CI sets it in the
 * `godot-integration` job and runs this file against Godot 4.5.1 and 4.6.2, so
 * nothing here may depend on an API that only one of them has.
 *
 * The `hit` field and the occlusion check both come from the viewport's hovered
 * control, which the bridge reaches through a `has_method` guard. Every
 * assertion that depends on them branches on the same engine probe
 * (`probeHoverApi`) so both engines pass, and each branch asserts the full
 * documented behavior for that engine rather than skipping the check.
 *
 * The probe scene is launched by rewriting `run/main_scene` in a disposable
 * copy of the fixture project. Each test gets its own launch: a toggled button
 * or a revealed panel would otherwise leak into a later UI-delta assertion.
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
import type { HandlerResult } from '../../src/mcp.types.js';

/** Absolute scene-tree path of the probe scene's root node. */
const PROBE_ROOT = '/root/InputProbe';

function p(sub: string): string {
  return `${PROBE_ROOT}/${sub}`;
}

/** `Mover.position.x` as authored in input_probe.tscn. */
const MOVER_START_X = 400;
/** Watch spec used by every test that measures the probe_move poll. */
const MOVER_WATCH = `${p('Mover')}:position:x`;
const WAIT_FRAMES_EXACT = 10;
const WAIT_MS_MIN = 200;
const SHORT_WAIT_FRAMES = 2;
const HOLD_WAIT_FRAMES = 3;
const TEST_TIMEOUT_MS = 60000;
const BRIDGE_CMD_TIMEOUT_MS = 15000;
/** Enough stderr lines to cover a whole batch's worth of engine output. */
const RECENT_ERROR_LINES = 200;
/** Long enough that the batch is still parked when its client gives up. */
const STALE_BATCH_WAIT_FRAMES = 180;
/** Client patience for the batch above: it times out almost immediately. */
const STALE_CLIENT_TIMEOUT_MS = 300;
/** Comfortably past the point where the abandoned batch would have resumed. */
const STALE_RESUME_MARGIN_MS = 8000;
/** Drain window for the boundary poll; longer than the default for headroom. */
const STALE_DRAIN_TIMEOUT_MS = 1000;

type InputEntry = Record<string, unknown>;

interface InputPayload {
  success?: boolean;
  results: InputEntry[];
  still_held?: string[];
}

const tmpDirs: string[] = [];

let runner: GodotRunner;

/**
 * A throwaway copy of the fixture project whose main scene is the probe scene.
 * Rewriting `run/main_scene` is deliberate: `runProject`'s positional scene
 * argument has no coverage anywhere in the suite, and making these tests its
 * first exerciser would make a bad scene argument indistinguishable from a bad
 * fixture.
 */
function makeProbeProject(): string {
  const id = randomBytes(6).toString('hex');
  const dst = join(tmpdir(), `godot-mcp-input-${id}`);
  cpSync(fixtureProjectPath, dst, { recursive: true });
  const projectFile = join(dst, 'project.godot');
  const content = readFileSync(projectFile, 'utf8').replace(
    'res://main.tscn',
    `res://${inputProbeScenePath}`,
  );
  // Fails here rather than in every test below if the probe scene is renamed.
  expect(content, 'project.godot main scene must point at the probe scene').toContain(
    inputProbeScenePath,
  );
  writeFileSync(projectFile, content, 'utf8');
  return dst;
}

/** The project the current test launched. */
function currentProject(): string {
  return tmpDirs[tmpDirs.length - 1]!;
}

/**
 * Run GDScript in the live process through the bridge directly, which is the
 * out-of-band read these tests use to check state simulate_input does not
 * report. `bodyLines` are the tab-indented body of `execute`.
 */
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

/**
 * Whether this engine exposes the viewport's hovered control. The bridge reads
 * `get_viewport()`, which for an autoload is the root `Window`, so this probes
 * the same object the bridge does.
 */
async function probeHoverApi(): Promise<boolean> {
  const result = (await script([
    'return {"has_api": scene_tree.root.has_method("gui_get_hovered_control")}',
  ])) as { has_api?: boolean } | null;
  return result?.has_api === true;
}

/** The handler's success payload. Throws on an error response. */
async function simulate(args: Record<string, unknown>): Promise<InputPayload> {
  const result = await handleSimulateInput(runner, args);
  if (!result.ok) {
    throw new Error(`simulate_input returned an error response: ${JSON.stringify(result.error)}`);
  }
  const structured = result.value.structuredContent;
  expect(structured, 'a simulate_input success must carry structuredContent').toBeDefined();
  return structured as unknown as InputPayload;
}

/** The raw handler result, for the cases that assert on an error response. */
function simulateExpectingError(args: Record<string, unknown>): Promise<HandlerResult> {
  return handleSimulateInput(runner, args);
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

describe('simulate_input observed results (live bridge)', () => {
  itGodot(
    'plain click reports the pressed signal and the Control it hit',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, currentProject());
      const hoverApi = await probeHoverApi();

      const payload = await simulate({
        actions: [{ type: 'click_element', element: p('PlainBtn') }],
      });

      expect(payload.results).toHaveLength(1);
      const entry = payload.results[0]!;
      expect(entry).toMatchObject({
        index: 0,
        type: 'click_element',
        ok: true,
        signals: ['pressed'],
      });
      expect(payload.success).toBe(true);
      if (hoverApi) {
        expect(entry.hit, `hit must name the clicked Button; entry=${JSON.stringify(entry)}`).toBe(
          p('PlainBtn'),
        );
      } else {
        expect(entry.hit).toBeUndefined();
      }
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'toggle click reports the toggled signal',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, currentProject());

      const payload = await simulate({
        actions: [{ type: 'click_element', element: p('ToggleBtn') }],
      });

      expect(payload.results).toHaveLength(1);
      const entry = payload.results[0]!;
      expect(entry).toMatchObject({ index: 0, type: 'click_element', ok: true });
      // A toggle Button emits pressed as well, so the exact array is not the
      // contract; the presence of toggled is.
      expect(entry.signals, `toggled must be observed; entry=${JSON.stringify(entry)}`).toContain(
        'toggled',
      );
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'click on a disabled button fails with no signals',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, currentProject());

      const payload = await simulate({
        actions: [{ type: 'click_element', element: p('DisabledBtn') }],
      });

      expect(payload.results).toHaveLength(1);
      const entry = payload.results[0]!;
      expect(entry).toMatchObject({ index: 0, type: 'click_element', ok: false });
      expect(entry.signals).toBeUndefined();
      expect(String(entry.error)).toMatch(/disabled/i);
      // The refusal comes from the explicit disabled pre-check, before any
      // injection, so this action hovered nothing either.
      expect(entry.hit).toBeUndefined();
      expect(payload.success).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'occluded click fails, names the occluder, and skips the rest of the batch',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, currentProject());
      const hoverApi = await probeHoverApi();

      const result = await simulateExpectingError({
        actions: [
          { type: 'click_element', element: p('CoveredBtn') },
          { type: 'wait', frames: 1 },
        ],
      });

      // A partial batch is never an error response: the timeline is the value.
      expect(
        result.ok,
        `a partially failed batch must return a success-shaped response; result=${JSON.stringify(result)}`,
      ).toBe(true);
      if (!result.ok) return;
      const payload = result.value.structuredContent as unknown as InputPayload;
      expect(payload.results).toHaveLength(2);
      const first = payload.results[0]!;
      const second = payload.results[1]!;

      if (hoverApi) {
        expect(first).toMatchObject({ index: 0, type: 'click_element', ok: false });
        expect(String(first.error)).toMatch(/occluded by .*Occluder/);
        expect(second).toMatchObject({ index: 1, type: 'wait', skipped: true });
        expect(payload.success).toBe(false);
      } else {
        // Documented degradation: without the hovered-control API there is no
        // occlusion signal at all, so the click reports plain success.
        expect(first).toMatchObject({ index: 0, type: 'click_element', ok: true });
        expect(first.error).toBeUndefined();
        expect(second.skipped).toBeUndefined();
        expect(payload.success).toBe(true);
      }
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'panel-opening click reports the panel in changes.appeared without its children',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, currentProject());

      const payload = await simulate({
        actions: [{ type: 'click_element', element: p('PanelBtn') }],
      });

      expect(payload.results).toHaveLength(1);
      const entry = payload.results[0]!;
      expect(entry.ok).toBe(true);
      const changes = entry.changes as { appeared?: string[] } | undefined;
      const seen = `changes=${JSON.stringify(entry.changes)}`;
      expect(changes?.appeared, `the revealed Panel must appear; ${seen}`).toContain(
        p('HiddenPanel'),
      );
      // Subtree collapse: an ancestor in the same list stands in for its
      // descendants.
      expect(changes?.appeared, `PanelLabel must be collapsed away; ${seen}`).not.toContain(
        p('HiddenPanel/PanelLabel'),
      );
      expect(changes?.appeared, `InnerBtn must be collapsed away; ${seen}`).not.toContain(
        p('HiddenPanel/InnerBtn'),
      );
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'a script error in a handler is attributed to that action only',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, currentProject());

      const payload = await simulate({
        actions: [
          { type: 'click_element', element: p('PlainBtn') },
          { type: 'click_element', element: p('ErrorBtn') },
          { type: 'wait', frames: SHORT_WAIT_FRAMES },
        ],
      });

      expect(payload.results).toHaveLength(3);
      const [clean, failing, trailing] = payload.results as [InputEntry, InputEntry, InputEntry];
      // A handler raising an error does not make the action itself fail: the
      // click was delivered and the signal fired.
      expect(payload.success).toBe(true);
      expect(clean.errors).toBeUndefined();
      expect(trailing.errors).toBeUndefined();
      const errors = failing.errors as string[] | undefined;
      expect(
        Array.isArray(errors) && errors.length > 0,
        `the erroring handler's action must carry errors; results=${JSON.stringify(payload.results)}`,
      ).toBe(true);
      expect((errors ?? []).join('\n')).toContain('SCRIPT ERROR');

      // The boundary sentinels are stripped at the single stderr ingestion
      // site, so this one assertion covers get_debug_output and
      // stop_project's finalErrors too: all three read the same buffer.
      expect(runner.getRecentErrors(RECENT_ERROR_LINES).join('\n')).not.toContain(
        'MCP_ACTION_BOUNDARY',
      );
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'a key tap with pressed omitted drives an is_action_pressed poll',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, currentProject());

      const payload = await simulate({
        watch: [MOVER_WATCH],
        actions: [
          { type: 'wait', frames: SHORT_WAIT_FRAMES },
          { type: 'key', key: 'W' },
        ],
      });

      expect(payload.results).toHaveLength(2);
      const [baseline, tap] = payload.results as [InputEntry, InputEntry];
      const before = (baseline.watch as Record<string, unknown> | undefined)?.[MOVER_WATCH];
      const after = (tap.watch as Record<string, unknown> | undefined)?.[MOVER_WATCH];
      const seen = `results=${JSON.stringify(payload.results)}`;

      expect(typeof before, `baseline sample must be a number; ${seen}`).toBe('number');
      expect(typeof after, `post-tap sample must be a number; ${seen}`).toBe('number');
      expect(before, `the Mover must start where the scene places it; ${seen}`).toBe(MOVER_START_X);
      expect(
        after as number,
        'Mover x must advance across the tap. Three things can break this: the ' +
          'project.godot InputMap entry not matching the injected event, the ' +
          'injected key event not carrying the keycode the map is bound to, or ' +
          "the event never reaching the engine's action state. " +
          seen,
      ).toBeGreaterThan(before as number);
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'an explicit key press reports still_held and a later call releases it',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, currentProject());
      const watch = [MOVER_WATCH];

      const held = await simulate({
        watch,
        actions: [
          { type: 'key', key: 'W', pressed: true },
          { type: 'wait', frames: HOLD_WAIT_FRAMES },
        ],
      });
      expect(held.results).toHaveLength(2);
      expect(
        held.still_held,
        `an unreleased press must be reported; payload=${JSON.stringify(held)}`,
      ).toContain('key:W');
      const atPress = (held.results[0]!.watch as Record<string, unknown>)[MOVER_WATCH] as number;
      const afterHold = (held.results[1]!.watch as Record<string, unknown>)[MOVER_WATCH] as number;
      expect(
        afterHold,
        `the hold must keep moving the Mover; results=${JSON.stringify(held.results)}`,
      ).toBeGreaterThan(atPress);

      const released = await simulate({
        watch,
        actions: [
          { type: 'key', key: 'W', pressed: false },
          { type: 'wait', frames: HOLD_WAIT_FRAMES },
        ],
      });
      expect(released.results).toHaveLength(2);
      // still_held is per call: this batch pressed nothing of its own.
      expect(released.still_held).toBeUndefined();

      // Samples are only compared across a later call: the release event
      // flushes on the following frame, so one more step of movement inside
      // the release batch itself is legitimate.
      const settled = await simulate({
        watch,
        actions: [
          { type: 'wait', frames: SHORT_WAIT_FRAMES },
          { type: 'wait', frames: SHORT_WAIT_FRAMES },
        ],
      });
      expect(settled.results).toHaveLength(2);
      const restA = (settled.results[0]!.watch as Record<string, unknown>)[MOVER_WATCH];
      const restB = (settled.results[1]!.watch as Record<string, unknown>)[MOVER_WATCH];
      expect(
        restB,
        `the Mover must be at rest once the release landed; results=${JSON.stringify(settled.results)}`,
      ).toBe(restA);
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'text types into the focused LineEdit and reports its value',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, currentProject());

      const focused = (await script([
        'var entry := scene_tree.root.get_node("InputProbe/Entry") as LineEdit',
        'entry.grab_focus()',
        'return {"focused": entry.has_focus()}',
      ])) as { focused?: boolean } | null;
      expect(
        focused?.focused,
        `the LineEdit must hold focus before typing; probe=${JSON.stringify(focused)}`,
      ).toBe(true);

      const payload = await simulate({ actions: [{ type: 'text', text: 'abc' }] });

      expect(payload.results).toHaveLength(1);
      expect(payload.results[0]!).toMatchObject({
        index: 0,
        type: 'text',
        ok: true,
        value: 'abc',
        focus: p('Entry'),
      });
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'text with nothing focused fails',
    async (ctx) => {
      // The probe scene never calls grab_focus, which is what makes this
      // launch's focus owner empty.
      await runProjectOrSkip(runner, ctx, currentProject());

      const result = await simulateExpectingError({ actions: [{ type: 'text', text: 'x' }] });
      expect(result.ok, `result=${JSON.stringify(result)}`).toBe(true);
      if (!result.ok) return;
      const payload = result.value.structuredContent as unknown as InputPayload;

      expect(payload.results).toHaveLength(1);
      const entry = payload.results[0]!;
      expect(entry).toMatchObject({ index: 0, type: 'text', ok: false });
      expect(String(entry.error)).toMatch(/focus/i);
      expect(payload.success).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'wait advances frame by exactly the requested frames and elapsed_ms by at least the requested ms',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, currentProject());

      const byFrames = await simulate({ actions: [{ type: 'wait', frames: WAIT_FRAMES_EXACT }] });
      expect(byFrames.results).toHaveLength(1);
      // Exactly N: a wait injects nothing, so it adds no settle frame.
      expect(byFrames.results[0]!).toMatchObject({
        index: 0,
        type: 'wait',
        ok: true,
        frame: WAIT_FRAMES_EXACT,
      });

      const byMs = await simulate({ actions: [{ type: 'wait', ms: WAIT_MS_MIN }] });
      expect(byMs.results).toHaveLength(1);
      const entry = byMs.results[0]!;
      expect(entry).toMatchObject({ index: 0, type: 'wait', ok: true });
      expect(
        entry.elapsed_ms as number,
        `a ms wait has a lower bound and no upper bound; entry=${JSON.stringify(entry)}`,
      ).toBeGreaterThanOrEqual(WAIT_MS_MIN);
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'a malformed batch is rejected and injects nothing',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, currentProject());

      const result = await simulateExpectingError({
        actions: [
          { type: 'action', action: 'probe_move', pressed: true },
          { type: 'key', key: 'NotARealKeyName' },
        ],
      });

      expect(
        result.ok,
        `a batch rejected before injection must be an error response; result=${JSON.stringify(result)}`,
      ).toBe(false);
      if (result.ok) return;
      const text = JSON.stringify(result.error);
      expect(text).toContain('action 1');
      expect(text).toContain('NotARealKeyName');

      // The whole batch is validated before anything is injected, so the
      // action at index 0 must never have been pressed.
      const state = (await script([
        'return {',
        '\t"pressed": Input.is_action_pressed("probe_move"),',
        '\t"x": scene_tree.root.get_node("InputProbe/Mover").position.x,',
        '}',
      ])) as { pressed?: boolean; x?: number } | null;
      expect(state?.pressed, `nothing may be held; state=${JSON.stringify(state)}`).toBe(false);
      expect(state?.x, `the Mover must not have moved; state=${JSON.stringify(state)}`).toBe(
        MOVER_START_X,
      );
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'a non-boolean double_click is rejected before anything is injected',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, currentProject());

      const result = await simulateExpectingError({
        actions: [{ type: 'click_element', element: p('PanelBtn'), double_click: 'yes' }],
      });

      expect(
        result.ok,
        `a batch rejected before injection must be an error response; result=${JSON.stringify(result)}`,
      ).toBe(false);
      if (result.ok) return;
      const text = JSON.stringify(result.error);
      expect(text).toContain('action 0');
      expect(text).toContain('double_click');

      // Rejected in the bridge's own pre-validation, so nothing was injected:
      // the panel the click would have revealed must still be hidden.
      const state = (await script([
        'return {',
        '\t"visible": scene_tree.root.get_node("InputProbe/HiddenPanel").visible,',
        '}',
      ])) as { visible?: boolean } | null;
      expect(state?.visible, `the panel must not have opened; state=${JSON.stringify(state)}`).toBe(
        false,
      );
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'an unresolvable watch path samples null',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, currentProject());
      const missing = '/root/NoSuchNode:position';

      const payload = await simulate({
        watch: [missing, MOVER_WATCH],
        actions: [{ type: 'wait', frames: 1 }],
      });

      expect(payload.results).toHaveLength(1);
      const entry = payload.results[0]!;
      expect(entry.ok).toBe(true);
      // Exactly null, not merely falsy: an omitted key would mean the sample
      // was skipped rather than attempted.
      expect(entry).toHaveProperty(['watch', missing], null);
      expect(
        typeof (entry.watch as Record<string, unknown>)[MOVER_WATCH],
        `the resolvable spec must still sample; entry=${JSON.stringify(entry)}`,
      ).toBe('number');
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'a handler that frees its own target does not break the post-action read',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, currentProject());

      const payload = await simulate({
        actions: [
          { type: 'click_element', element: p('FreeMe/FreeSelfBtn') },
          { type: 'wait', frames: SHORT_WAIT_FRAMES },
        ],
      });

      expect(payload.results).toHaveLength(2);
      // The load-bearing claim is that the post-action read survived the target
      // being freed by its own handler. changes.disappeared is deliberately not
      // asserted: queue_free's timing relative to the settle frame is exactly
      // what this test cannot know.
      expect(payload.results[0]!).toMatchObject({ index: 0, type: 'click_element', ok: true });
      expect(payload.results[1]!).toMatchObject({ index: 1, type: 'wait', ok: true });

      const state = (await script([
        'return {',
        '\t"alive": true,',
        '\t"gone": scene_tree.root.get_node_or_null("InputProbe/FreeMe") == null,',
        '}',
      ])) as { alive?: boolean; gone?: boolean } | null;
      expect(state?.alive, `the game must still be running; state=${JSON.stringify(state)}`).toBe(
        true,
      );
      expect(
        state?.gone,
        `the handler's queue_free must have landed; state=${JSON.stringify(state)}`,
      ).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'a batch abandoned by a client timeout stops instead of marking a later window',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, currentProject());

      // Give the batch a wait far longer than the timeout the client allows it,
      // so the command times out - which destroys the socket - while the batch
      // is still parked inside the wait.
      await expect(
        runner.sendCommand(
          'input',
          {
            actions: [
              { type: 'wait', frames: STALE_BATCH_WAIT_FRAMES },
              { type: 'key', key: 'W' },
            ],
          },
          STALE_CLIENT_TIMEOUT_MS,
        ),
      ).rejects.toThrow(/timed out/);

      // What the next simulate_input would do: open a fresh attribution window.
      // A resumed stale batch prints its own MCP_ACTION_BOUNDARY marks, and the
      // ingestion site cannot tell them from this window's own.
      const capture = runner.beginActionErrorCapture();
      await new Promise((resolve) => setTimeout(resolve, STALE_RESUME_MARGIN_MS));
      const collected = await runner.collectActionErrors(capture, 1, STALE_DRAIN_TIMEOUT_MS);

      expect(
        collected.sentinelTimedOut,
        'no action boundary may arrive from a batch whose client is gone',
      ).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});
