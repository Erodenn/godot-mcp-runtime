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
/** A script that answers at all answers well inside this; a 4^32-step walk never would. */
const SCRIPT_TIMEOUT_MS = 15000;
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

/** The bridge's MAX_RESULT_ELEMENTS: a run_script result serializes this many container elements before it is cut. */
const RESULT_ELEMENT_BUDGET = 50000;
/** A bridge command that answers at all answers well inside this. */
const WRONG_TYPE_REPLY_TIMEOUT_MS = 5000;

const VALUE_SHAPES_SCRIPT = [
  'extends RefCounted',
  'func execute(scene_tree: SceneTree) -> Variant:',
  '\treturn {',
  '\t\t"vector4": Vector4(1, 2, 3, 4),',
  '\t\t"vector4i": Vector4i(5, 6, 7, 8),',
  '\t\t"packedVector2": PackedVector2Array([Vector2(1, 2)]),',
  '\t\t"packedFloat32": PackedFloat32Array([1.5, INF]),',
  '\t\t"packedInt32": PackedInt32Array([1, 2, 3]),',
  '\t\t"packedString": PackedStringArray(["a", "b"]),',
  '\t\t"packedColor": PackedColorArray([Color(1, 0, 0, 1)]),',
  '\t}',
  '',
].join('\n');

const PACKED_OVER_BUDGET_SCRIPT = [
  'extends RefCounted',
  'func execute(scene_tree: SceneTree) -> Variant:',
  '\tvar bytes := PackedByteArray()',
  `\tbytes.resize(${RESULT_ELEMENT_BUDGET + 1})`,
  '\treturn bytes',
  '',
].join('\n');

const FREED_NODE_SCRIPT = [
  'extends RefCounted',
  'func execute(scene_tree: SceneTree) -> Variant:',
  '\tvar node := Node.new()',
  '\tnode.free()',
  '\treturn node',
  '',
].join('\n');

describe('bridge serialization bounds and the parent watch', () => {
  let runner: GodotRunner;
  let tmpProject: string | null = null;

  beforeAll(async () => {
    runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
    await runner.detectGodotPath();
  });

  afterEach(async () => {
    try {
      await runner.stopProject();
    } catch {}
    if (tmpProject) {
      try {
        removeTmpDir(tmpProject);
      } catch {}
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

  function payloadOf(result: unknown): { result: unknown; warnings?: string[] } {
    return JSON.parse(unwrap(result).content[0]!.text!) as {
      result: unknown;
      warnings?: string[];
    };
  }

  // Red when a Vector4 or a packed array falls back to its text form, or the INF stops being counted:
  // `result` would then differ from what get_node_properties returns for the same value.
  itGodot(
    'serializes Vector4 and packed arrays in the shapes get_node_properties returns, a non-finite element as null and counted',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, copyFixture('shapes'), { waitMs: BRIDGE_WAIT_MS });

      const result = await handleRunScript(runner, {
        script: VALUE_SHAPES_SCRIPT,
        timeout: SCRIPT_TIMEOUT_MS,
      });

      expect(hasError(result)).toBe(false);
      const payload = payloadOf(result);
      expect(payload.result).toEqual({
        vector4: { x: 1, y: 2, z: 3, w: 4 },
        vector4i: { x: 5, y: 6, z: 7, w: 8 },
        packedVector2: [{ x: 1, y: 2 }],
        packedFloat32: [1.5, null],
        packedInt32: [1, 2, 3],
        packedString: ['a', 'b'],
        packedColor: [{ r: 1, g: 0, b: 0, a: 1 }],
      });
      expect(payload.warnings).toEqual(['1 non-finite numbers (INF, NAN) were returned as null']);
    },
    CASE_TIMEOUT_MS,
  );

  // Red when a packed array is walked outside the element budget: a result of this size would come back
  // whole, or the cut would carry no marker.
  itGodot(
    'cuts a packed array at the result element budget and marks the cut',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, copyFixture('packedbudget'), { waitMs: BRIDGE_WAIT_MS });

      const result = await handleRunScript(runner, {
        script: PACKED_OVER_BUDGET_SCRIPT,
        timeout: SCRIPT_TIMEOUT_MS,
      });

      expect(hasError(result)).toBe(false);
      const elements = payloadOf(result).result as unknown[];
      expect(elements).toHaveLength(RESULT_ELEMENT_BUDGET + 1);
      expect(elements[RESULT_ELEMENT_BUDGET - 1]).toBe(0);
      expect(elements[RESULT_ELEMENT_BUDGET]).toBe('<truncated: 1 more elements>');
    },
    CASE_TIMEOUT_MS,
  );

  // Red when the freed-Object guard in _serialize_bounded is removed (a reply still comes, with result null),
  // or when _handle_run_script awaits the returned value unconditionally (no reply comes).
  itGodot(
    'run_script returns a freed node as the freed-Object marker, with no script error',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, copyFixture('freed'), { waitMs: BRIDGE_WAIT_MS });

      const result = await handleRunScript(runner, {
        script: FREED_NODE_SCRIPT,
        timeout: SCRIPT_TIMEOUT_MS,
      });

      expect(hasError(result)).toBe(false);
      const payload = payloadOf(result);
      expect(payload.result).toBe('<Freed Object>');
      expect(JSON.stringify(payload.warnings ?? [])).not.toContain('SCRIPT ERROR');
    },
    CASE_TIMEOUT_MS,
  );

  // Red when a handler goes back to a typed read of its payload field: the engine raises on the wrong
  // type, no reply is sent, and sendCommand rejects at its timeout instead of returning an error.
  itGodot(
    'answers get_ui_elements and run_script with a wrong-typed field with an error, not a timeout',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, copyFixture('wrongtype'), { waitMs: BRIDGE_WAIT_MS });

      const cases: Array<[string, Record<string, unknown>, RegExp]> = [
        ['get_ui_elements', { visible_only: 'yes' }, /visible_only must be a boolean/],
        ['get_ui_elements', { type_filter: 5 }, /type_filter must be a string/],
        ['run_script', { source: 5 }, /source must be a string/],
        ['run_script', { source: null }, /source must be a string/],
      ];
      for (const [command, params, expected] of cases) {
        const raw = await runner.sendCommand(command, params, WRONG_TYPE_REPLY_TIMEOUT_MS);
        const reply = JSON.parse(raw) as { error?: string };
        expect(reply.error, `${command} ${JSON.stringify(params)} must be refused`).toMatch(
          expected,
        );
      }

      // The peer is still usable: no handler was left holding it.
      const pong = JSON.parse(
        await runner.sendCommand('ping', {}, WRONG_TYPE_REPLY_TIMEOUT_MS),
      ) as { status?: string };
      expect(pong.status).toBe('pong');
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

      // What a hard-killed server looks like from the game: every socket it held is closed, nothing else is said.
      (runner as unknown as { parentWatch: { close(): void } }).parentWatch.close();

      await exited;
      expect(spawned.hasExited).toBe(true);
      expect(runner.hasActiveRuntimeSession()).toBe(false);
    },
    CASE_TIMEOUT_MS,
  );
});
