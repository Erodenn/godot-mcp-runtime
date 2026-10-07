/**
 * Engine-side behavior of the bridge that a Node test can only read as text:
 *
 * - a run_script result that contains itself is answered at once, with the
 *   recursion cut by a marker, instead of walking 4^32 steps on the game's
 *   main thread;
 * - a result too large to frame is answered with an error naming its size,
 *   instead of with silence and a command timeout;
 * - a wait longer than the batch ceiling is refused by the bridge itself;
 * - a spawned game quits when its connection to the server is lost, which is
 *   what a hard-killed server looks like from the game.
 *
 * Requires GODOT_PATH.
 */

import { describe, beforeAll, afterEach, expect } from 'vitest';
import { cpSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { removeTmpDir } from '../helpers/tmp.js';
import { itGodot } from '../helpers/godot-skip.js';
import { runProjectOrSkip } from '../helpers/run-project-or-skip.js';
import { fixtureProjectPath } from '../helpers/fixture-paths.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { handleRunScript, MAX_INPUT_BATCH_BUDGET_MS } from '../../src/tools/runtime-tools.js';
import { MAX_FRAME_BYTES } from '../../src/utils/bridge-protocol.js';
import { hasError, unwrap } from '../helpers/assertions.js';

const BRIDGE_WAIT_MS = 20000;
const CASE_TIMEOUT_MS = 60000;
/** A script that answers at all answers well inside this. A walk of 4^32 steps never would. */
const SCRIPT_TIMEOUT_MS = 15000;
/** How many times the test array holds itself. */
const SELF_REFERENCES = 4;
/** Strings of this length, this many of them, serialize past the 16 MiB frame limit. */
const BIG_STRING_CHARS = 1_000_000;
const BIG_STRING_COUNT = 20;
/** The bridge checks its parent connection every 2 s and needs two checks at most. */
const PARENT_WATCH_EXIT_WAIT_MS = 15000;

const CYCLE_MARKER = '<truncated: this container contains itself>';

const SELF_CONTAINING_ARRAY_SCRIPT = [
  'extends RefCounted',
  'func execute(scene_tree: SceneTree) -> Variant:',
  '\tvar a = []',
  `\tfor i in ${SELF_REFERENCES}:`,
  '\t\ta.append(a)',
  '\treturn a',
  '',
].join('\n');

const SELF_CONTAINING_DICTIONARY_SCRIPT = [
  'extends RefCounted',
  'func execute(scene_tree: SceneTree) -> Variant:',
  '\tvar d = {"name": "root"}',
  '\td["self"] = d',
  '\td["list"] = [d]',
  '\treturn d',
  '',
].join('\n');

const SHARED_NOT_CYCLIC_SCRIPT = [
  'extends RefCounted',
  'func execute(scene_tree: SceneTree) -> Variant:',
  '\tvar shared = [1, 2]',
  '\treturn [shared, shared]',
  '',
].join('\n');

const OVERSIZE_RESULT_SCRIPT = [
  'extends RefCounted',
  'func execute(scene_tree: SceneTree) -> Variant:',
  '\tvar out = []',
  `\tfor i in ${BIG_STRING_COUNT}:`,
  `\t\tout.append("x".repeat(${BIG_STRING_CHARS}))`,
  '\treturn out',
  '',
].join('\n');

describe('bridge serialization bounds and the parent watch', () => {
  let runner: GodotRunner;
  let tmpProject: string | null = null;

  beforeAll(async () => {
    runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
    await runner.detectGodotPath();
  });

  // Runs even when an assertion above threw, so no Godot is stranded.
  afterEach(async () => {
    try {
      await runner.stopProject();
    } catch {
      // already stopped
    }
    if (tmpProject) {
      try {
        removeTmpDir(tmpProject);
      } catch {
        // best-effort
      }
      tmpProject = null;
    }
  });

  function copyFixture(tag: string): string {
    const id = randomBytes(6).toString('hex');
    tmpProject = join(tmpdir(), `godot-mcp-runtime-${tag}-${id}`);
    cpSync(fixtureProjectPath, tmpProject, { recursive: true });
    return tmpProject;
  }

  function resultOf(result: unknown): unknown {
    const payload = JSON.parse(unwrap(result).content[0]!.text!) as { result: unknown };
    return payload.result;
  }

  itGodot(
    'answers a run_script result that contains itself, with the recursion cut where it recurs',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, copyFixture('cycle'), { waitMs: BRIDGE_WAIT_MS });

      const array = await handleRunScript(runner, {
        script: SELF_CONTAINING_ARRAY_SCRIPT,
        timeout: SCRIPT_TIMEOUT_MS,
      });
      expect(hasError(array)).toBe(false);
      expect(resultOf(array)).toEqual(Array.from({ length: SELF_REFERENCES }, () => CYCLE_MARKER));

      const dictionary = await handleRunScript(runner, {
        script: SELF_CONTAINING_DICTIONARY_SCRIPT,
        timeout: SCRIPT_TIMEOUT_MS,
      });
      expect(hasError(dictionary)).toBe(false);
      expect(resultOf(dictionary)).toEqual({
        name: 'root',
        self: CYCLE_MARKER,
        list: [CYCLE_MARKER],
      });
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'serializes a container that appears twice without being its own ancestor in full, both times',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, copyFixture('shared'), { waitMs: BRIDGE_WAIT_MS });

      const result = await handleRunScript(runner, {
        script: SHARED_NOT_CYCLIC_SCRIPT,
        timeout: SCRIPT_TIMEOUT_MS,
      });

      expect(hasError(result)).toBe(false);
      expect(resultOf(result)).toEqual([
        [1, 2],
        [1, 2],
      ]);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'answers a result too large to frame with an error naming its size, not with a timeout',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, copyFixture('oversize'), { waitMs: BRIDGE_WAIT_MS });
      const started = Date.now();

      const result = await handleRunScript(runner, {
        script: OVERSIZE_RESULT_SCRIPT,
        timeout: SCRIPT_TIMEOUT_MS,
      });

      expect(hasError(result)).toBe(true);
      const text = unwrap(result).content[0]!.text!;
      expect(text).toContain(`over the ${MAX_FRAME_BYTES} byte frame limit`);
      expect(text).not.toMatch(/timed out/);
      expect(Date.now() - started).toBeLessThan(SCRIPT_TIMEOUT_MS);

      // The peer is not left waiting: the next command is answered.
      const next = await handleRunScript(runner, {
        script: 'extends RefCounted\nfunc execute(scene_tree: SceneTree) -> Variant:\n\treturn 7\n',
        timeout: SCRIPT_TIMEOUT_MS,
      });
      expect(resultOf(next)).toBe(7);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'the bridge itself refuses a batch whose waits pass the ceiling, before injecting anything',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, copyFixture('batchwait'), { waitMs: BRIDGE_WAIT_MS });

      // Straight to the bridge, past the handler's own check.
      const { response } = await runner.sendCommandWithErrors('input', {
        actions: [
          { type: 'wait', ms: MAX_INPUT_BATCH_BUDGET_MS },
          { type: 'wait', ms: 1 },
        ],
      });

      const parsed = JSON.parse(response) as { error?: string; results?: unknown[] };
      expect(parsed.error).toMatch(/over the 600000 ms ceiling/);
      expect(parsed.results).toBeUndefined();
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'a spawned game quits by itself when its connection to the server is lost',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, copyFixture('parentwatch'), { waitMs: BRIDGE_WAIT_MS });
      const spawned = runner.activeProcess!;
      const exited = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('the game did not quit after losing its parent connection')),
          PARENT_WATCH_EXIT_WAIT_MS,
        );
        spawned.process.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });

      // What a hard-killed server looks like from the game: every socket it
      // held is closed, and nothing else is said.
      (runner as unknown as { parentWatch: { close(): void } }).parentWatch.close();

      await exited;
      expect(spawned.hasExited).toBe(true);
      expect(runner.hasActiveRuntimeSession()).toBe(false);
    },
    CASE_TIMEOUT_MS,
  );
});
