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
import { handleRunScript } from '../../src/tools/runtime-tools.js';
function makeTmpProject(): string {
  const id = randomBytes(6).toString('hex');
  const dst = join(tmpdir(), `godot-mcp-runscript-diag-${id}`);
  cpSync(fixtureProjectPath, dst, { recursive: true });
  return dst;
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
});
