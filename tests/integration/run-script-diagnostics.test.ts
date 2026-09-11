/**
 * Integration test: run_script compile-error diagnostics.
 *
 * End-to-end regression for a real-world failure class: run_script compile
 * failures returned only "Script compilation failed (error 43). Check
 * syntax." — the parser's
 * actual message + line number sat on the engine process stderr. Agents
 * retried identical scripts and hunted get_debug_output for details.
 *
 * The fix: handleRunScript parses the runtimeErrors captured since the
 * command marker and appends "Compiler diagnostics:" (message + line) to the
 * error response. This test runs a REAL engine + bridge and asserts the
 * enriched error comes back over the live MCP path.
 *
 * Requires GODOT_PATH. Skipped in CI without it.
 */

import { describe, beforeAll, beforeEach, afterEach, afterAll, expect } from 'vitest';
import { cpSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { itGodot, isHeadlessEnvironmentError } from '../helpers/godot-skip.js';
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
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe('run_script compile-error diagnostics (live bridge)', () => {
  itGodot(
    'enriches error-43 compile failures with stderr compiler diagnostics',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1]!;
      await runner.runProject(tmpProject);
      const bridgeResult = await runner.waitForBridge(20000);
      if (!bridgeResult.ready) {
        if (isHeadlessEnvironmentError(bridgeResult.error)) {
          return; // no display server — same skip semantics as runtime-smoke
        }
        throw new Error(`Bridge failed to initialise: ${bridgeResult.error ?? 'unknown error'}`);
      }

      // Line 3 references an undeclared identifier — compile error 43 class.
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
      // The diagnostic names the offender and its line in the submitted source
      expect(text).toContain('some_missing_identifier');
      expect(text).toMatch(/:3\b/);
    },
    60000,
  );

  itGodot(
    'a syntactically valid script still executes normally',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1]!;
      await runner.runProject(tmpProject);
      const bridgeResult = await runner.waitForBridge(20000);
      if (!bridgeResult.ready) {
        if (isHeadlessEnvironmentError(bridgeResult.error)) {
          return;
        }
        throw new Error(`Bridge failed to initialise: ${bridgeResult.error ?? 'unknown error'}`);
      }

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
