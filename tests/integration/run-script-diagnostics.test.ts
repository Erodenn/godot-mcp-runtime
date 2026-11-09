import { describe, beforeAll, beforeEach, afterEach, afterAll, expect } from 'vitest';
import { cpSync } from 'fs';
import { removeTmpDir } from '../helpers/tmp.js';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { itGodot } from '../helpers/godot-skip.js';
import { runProjectOrSkip } from '../helpers/run-project-or-skip.js';
import { fixtureProjectPath } from '../helpers/fixture-paths.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { handleGetDebugOutput, handleRunScript } from '../../src/tools/runtime-tools.js';
import type { HandlerResult } from '../../src/mcp.types.js';
function makeTmpProject(): string {
  const id = randomBytes(6).toString('hex');
  const dst = join(tmpdir(), `godot-mcp-runscript-diag-${id}`);
  cpSync(fixtureProjectPath, dst, { recursive: true });
  return dst;
}

const STEP_TIMEOUT_MS = 15000;
const SHORT_TIMEOUT_MS = 3000;
const SOCKET_GRACE_MS = 500;
const CASE_TIMEOUT_MS = 60000;
const STDERR_SETTLE_MS = 500;
const DEBUG_LINE_LIMIT = 500;

function textOf(result: HandlerResult): string {
  if (result.ok) return result.value.content[0]?.text ?? '';
  const payload = result.error as { content?: Array<{ text?: string }> };
  return payload.content?.[0]?.text ?? '';
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

describe('run_script compile-error diagnostics (live bridge)', () => {
  itGodot(
    'enriches error-43 compile failures with stderr compiler diagnostics',
    async (ctx) => {
      const tmpProject = tmpDirs[tmpDirs.length - 1]!;
      await runProjectOrSkip(runner, ctx, tmpProject);

      const badScript =
        'extends RefCounted\n' +
        'func execute(scene_tree: SceneTree) -> Variant:\n' +
        '\treturn some_missing_identifier\n';

      const result = await handleRunScript(runner, { script: badScript, timeout: 15000 });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      const payload = result.error as { content?: Array<{ text?: string }> };
      const text = payload.content?.[0]?.text ?? '';

      expect(text).toContain('Script compilation failed');
      expect(text).toContain('Compiler diagnostics');
      expect(text).toContain('some_missing_identifier');
      expect(text).toMatch(/:3\b/);
    },
    60000,
  );

  itGodot(
    'a syntactically valid script still executes normally',
    async (ctx) => {
      const tmpProject = tmpDirs[tmpDirs.length - 1]!;
      await runProjectOrSkip(runner, ctx, tmpProject);

      const goodScript =
        'extends RefCounted\n' +
        'func execute(scene_tree: SceneTree) -> Variant:\n' +
        '\treturn 1 + 1\n';

      const result = await handleRunScript(runner, { script: goodScript, timeout: 15000 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const text = result.value.content[0]?.text ?? '';
      expect(text).toContain('"result":2');
    },
    60000,
  );

  itGodot(
    'a compile failure returns its diagnostics without reaching the game error log',
    async (ctx) => {
      // Red when the bridge stops printing the compile span between its markers, or the Node side retains the span in proc.errors.
      const tmpProject = tmpDirs[tmpDirs.length - 1]!;
      await runProjectOrSkip(runner, ctx, tmpProject);

      const badScript =
        'extends RefCounted\n' +
        'func execute(scene_tree: SceneTree) -> Variant:\n' +
        '\treturn some_missing_identifier\n';
      const failed = await handleRunScript(runner, { script: badScript, timeout: STEP_TIMEOUT_MS });
      expect(failed.ok).toBe(false);
      if (failed.ok) return;
      expect(textOf(failed)).toContain('some_missing_identifier');
      await new Promise((resolve) => setTimeout(resolve, STDERR_SETTLE_MS));

      const debug = handleGetDebugOutput(runner, { limit: DEBUG_LINE_LIMIT });
      expect(debug.ok).toBe(true);
      if (!debug.ok) return;
      const errors = (debug.value.structuredContent?.errors ?? []) as string[];
      expect(errors.filter((line) => /gdscript:\/\/|some_missing_identifier/.test(line))).toEqual(
        [],
      );
      expect(errors.some((line) => line.includes('MCP_COMPILE'))).toBe(false);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'execute may await frames and returns its value',
    async (ctx) => {
      // Red when the bridge calls execute without waiting for the coroutine it returns.
      const tmpProject = tmpDirs[tmpDirs.length - 1]!;
      await runProjectOrSkip(runner, ctx, tmpProject);

      const script =
        'extends RefCounted\n' +
        'func execute(scene_tree: SceneTree) -> Variant:\n' +
        '\tvar start := Engine.get_process_frames()\n' +
        '\tfor i in 3:\n' +
        '\t\tawait scene_tree.process_frame\n' +
        '\treturn Engine.get_process_frames() - start\n';
      const result = await handleRunScript(runner, { script, timeout: STEP_TIMEOUT_MS });
      expect(result.ok, textOf(result)).toBe(true);
      if (!result.ok) return;
      const frames = result.value.structuredContent?.result as number;
      expect(frames).toBeGreaterThanOrEqual(3);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'finds the await past a multi-line literal at column 0 and after an annotation on the func line',
    async (ctx) => {
      // Red when the await scan ends the body at a literal's column-0 line: the plain call then raises and no value comes back.
      const tmpProject = tmpDirs[tmpDirs.length - 1]!;
      await runProjectOrSkip(runner, ctx, tmpProject);

      const multiLine =
        'extends RefCounted\n' +
        'func execute(scene_tree: SceneTree) -> Variant:\n' +
        '\tvar text := """\nfirst\n"""\n' +
        '\tvar list := [\n1,\n]\n' +
        '\tawait scene_tree.process_frame\n' +
        '\treturn text.length() + list.size()\n';
      const fromMultiLine = await handleRunScript(runner, {
        script: multiLine,
        timeout: STEP_TIMEOUT_MS,
      });
      expect(fromMultiLine.ok, textOf(fromMultiLine)).toBe(true);
      if (!fromMultiLine.ok) return;
      expect(fromMultiLine.value.structuredContent?.result).toBe('\nfirst\n'.length + 1);

      const annotated =
        'extends RefCounted\n' +
        '@warning_ignore("unused_parameter") func execute(scene_tree: SceneTree) -> Variant:\n' +
        '\tawait scene_tree.process_frame\n' +
        '\treturn 5\n';
      const fromAnnotated = await handleRunScript(runner, {
        script: annotated,
        timeout: STEP_TIMEOUT_MS,
      });
      expect(fromAnnotated.ok, textOf(fromAnnotated)).toBe(true);
      if (!fromAnnotated.ok) return;
      expect(fromAnnotated.value.structuredContent?.result).toBe(5);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'an await only in a string or a comment leaves execute a plain call',
    async (ctx) => {
      // Red when a stray match sends a plain execute down the awaiting path, where awaiting a freed Object raises and the call times out.
      const tmpProject = tmpDirs[tmpDirs.length - 1]!;
      await runProjectOrSkip(runner, ctx, tmpProject);

      const script =
        'extends RefCounted\n' +
        'func execute(scene_tree: SceneTree) -> Variant:\n' +
        '\tvar note := "await" # await\n' +
        '\tvar node := Node.new()\n' +
        '\tnode.free()\n' +
        '\treturn node\n';
      const started = Date.now();
      const result = await handleRunScript(runner, { script, timeout: SHORT_TIMEOUT_MS });
      expect(result.ok, textOf(result)).toBe(true);
      expect(Date.now() - started).toBeLessThan(SHORT_TIMEOUT_MS);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'an execute that never resumes returns a typed timeout and the next call still runs',
    async (ctx) => {
      // Red when the bridge awaits with no bound (a silent hang to the socket timeout) or does not answer before the Node side's timeout.
      const tmpProject = tmpDirs[tmpDirs.length - 1]!;
      await runProjectOrSkip(runner, ctx, tmpProject);

      const stuck =
        'extends RefCounted\n' +
        'signal never_fires\n' +
        'func execute(scene_tree: SceneTree) -> Variant:\n' +
        '\tawait never_fires\n' +
        '\treturn 1\n';
      const started = Date.now();
      const timedOut = await handleRunScript(runner, { script: stuck, timeout: SHORT_TIMEOUT_MS });
      const elapsed = Date.now() - started;
      expect(timedOut.ok).toBe(false);
      expect(textOf(timedOut)).toContain('run_script timed out');
      expect(elapsed).toBeLessThan(SHORT_TIMEOUT_MS + SOCKET_GRACE_MS);

      const after = await handleRunScript(runner, {
        script: 'extends RefCounted\nfunc execute(scene_tree: SceneTree) -> Variant:\n\treturn 7\n',
        timeout: STEP_TIMEOUT_MS,
      });
      expect(after.ok, textOf(after)).toBe(true);
      if (!after.ok) return;
      expect(after.value.structuredContent?.result).toBe(7);
    },
    CASE_TIMEOUT_MS,
  );
});
