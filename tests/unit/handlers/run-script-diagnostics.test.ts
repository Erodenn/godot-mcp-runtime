/**
 * Regression tests: run_script compile-error diagnostics enrichment (Phase 7).
 *
 * Observed in production agent workflows: run_script compile failures each
 * returned only "Script compilation failed (error 43). Check syntax." — no
 * line, no message. Agents blindly retried identical scripts and repeatedly
 * called get_debug_output hunting for details that were sitting on the
 * engine process stderr.
 *
 * The fix: handleRunScript, on a compilation-failure error, parses the
 * runtimeErrors captured by sendCommandWithErrors (which include the
 * engine-stderr SCRIPT ERROR block) and appends "Compiler diagnostics:" with
 * message + line to the error response.
 *
 * Uses a minimal fake runner — run_script's handler path needs a runtime
 * session shape, not the executeOperation fake.
 */

import { describe, it, expect } from 'vitest';
import type { GodotRunner } from '../../../src/utils/godot-runner.js';

interface FakeRunnerOverrides {
  response: string;
  runtimeErrors: string[];
  sessionMode?: 'spawned' | 'attached' | null;
}

function makeFakeRunner(o: FakeRunnerOverrides): GodotRunner {
  const fake = {
    activeProjectPath: '/fake/project',
    activeSessionMode: o.sessionMode ?? 'spawned',
    activeProcess: { hasExited: false },
    async sendCommandWithErrors(): Promise<{
      response: string;
      runtimeErrors: string[];
      stderrWindow: string[];
    }> {
      return {
        response: o.response,
        runtimeErrors: o.runtimeErrors,
        stderrWindow: o.runtimeErrors,
      };
    },
  };
  return fake as unknown as GodotRunner;
}

// A benign script that passes the policy gate (no flagged primitives).
const BENIGN_SCRIPT =
  'extends RefCounted\nfunc execute(scene_tree: SceneTree) -> Variant:\n\treturn 1\n';

const COMPILE_FAIL_RESPONSE = JSON.stringify({
  error: 'Script compilation failed (error 43). Check syntax.',
});

const ERROR43_STDERR = [
  'SCRIPT ERROR: Parse Error: Identifier "some_missing_thing" not declared in the current scope.',
  '          at: GDScript::reload (gdscript://-9223372010447436344.gd:4)',
  '          GDScript backtrace (most recent call first):',
];

describe('handleRunScript compile-error diagnostics (error-43 class)', () => {
  it('enriches "Script compilation failed" errors with stderr compiler diagnostics', async () => {
    const { handleRunScript } = await import('../../../src/tools/runtime-tools.js');
    const fake = makeFakeRunner({
      response: COMPILE_FAIL_RESPONSE,
      runtimeErrors: [...ERROR43_STDERR],
    });
    const result = await handleRunScript(fake, { script: BENIGN_SCRIPT });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const text = JSON.stringify(result.error);
    expect(text).toContain('Compiler diagnostics');
    expect(text).toContain('some_missing_thing');
    expect(text).toContain(':4');
  });

  it('still returns the bare error when stderr yields no diagnostics', async () => {
    const { handleRunScript } = await import('../../../src/tools/runtime-tools.js');
    const fake = makeFakeRunner({
      response: COMPILE_FAIL_RESPONSE,
      runtimeErrors: [],
    });
    const result = await handleRunScript(fake, { script: BENIGN_SCRIPT });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const text = JSON.stringify(result.error);
    expect(text).toContain('Script compilation failed (error 43)');
    expect(text).not.toContain('Compiler diagnostics');
  });

  it('non-compilation bridge errors are not enriched', async () => {
    const { handleRunScript } = await import('../../../src/tools/runtime-tools.js');
    const fake = makeFakeRunner({
      response: JSON.stringify({ error: 'Script must define func execute' }),
      runtimeErrors: [...ERROR43_STDERR],
    });
    const result = await handleRunScript(fake, { script: BENIGN_SCRIPT });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const text = JSON.stringify(result.error);
    expect(text).not.toContain('Compiler diagnostics');
  });
});
