/**
 * Direct unit tests for executeSceneOp.
 *
 * Currently only covered transitively via the 15 scene/node mutation
 * handlers. A direct test localizes the failure when its contract drifts —
 * the empty-stdout branch and the catch branch are easy to break in a
 * refactor.
 */

import { describe, it, expect } from 'vitest';
import { executeSceneOp } from '../../src/utils/headless-op.js';
import { createFakeRunner } from '../helpers/fake-runner.js';
import { hasError, expectErrorMatching, unwrap } from '../helpers/assertions.js';
import { cleanStdout } from '../../src/utils/output-parsing.js';

const TEST_FAILURE_PREFIX = 'Failed to op';
const EMPTY_SOLUTIONS = ['empty: a', 'empty: b'];
const EXCEPTION_SOLUTIONS = ['exc: a', 'exc: b'];

describe('executeSceneOp', () => {
  it('returns the runner stdout verbatim when non-empty (no isError)', async () => {
    const fake = createFakeRunner({ stdout: '{"node":"ok"}' });
    const result = await executeSceneOp(
      fake.asRunner,
      'add_node',
      { foo: 1 },
      '/p',
      TEST_FAILURE_PREFIX,
      EMPTY_SOLUTIONS,
      EXCEPTION_SOLUTIONS,
    );
    expect(hasError(result)).toBe(false);
    expect(unwrap(result).content).toEqual([{ type: 'text', text: '{"node":"ok"}' }]);
  });

  it('forwards (operation, params, projectPath) to the runner unchanged', async () => {
    const fake = createFakeRunner({ stdout: '{}' });
    await executeSceneOp(
      fake.asRunner,
      'delete_nodes',
      { nodePaths: ['a', 'b'] },
      '/some/project',
      TEST_FAILURE_PREFIX,
      EMPTY_SOLUTIONS,
      EXCEPTION_SOLUTIONS,
    );
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      operation: 'delete_nodes',
      params: { nodePaths: ['a', 'b'] },
      projectPath: '/some/project',
    });
  });

  it('escalates empty stdout into an isError with extracted GD error from stderr', async () => {
    const fake = createFakeRunner({
      stdout: '   \n  ',
      stderr: 'Godot v4.4 ...\n[ERROR] node not found at root/Missing\nmore noise',
    });
    const result = await executeSceneOp(
      fake.asRunner,
      'delete_nodes',
      {},
      '/p',
      TEST_FAILURE_PREFIX,
      EMPTY_SOLUTIONS,
      EXCEPTION_SOLUTIONS,
    );
    expectErrorMatching(result, /Failed to op/);
    expectErrorMatching(result, /node not found at root\/Missing/);
    // Empty-stdout-specific solutions surface in the secondary text block.
    const solutionsText = unwrap(result).content[1]?.text ?? '';
    expect(solutionsText).toContain('empty: a');
    expect(solutionsText).not.toContain('exc: a');
  });

  it('escalates empty stdout to a generic message when stderr has no [ERROR] line', async () => {
    const fake = createFakeRunner({ stdout: '', stderr: 'just some banner output' });
    const result = await executeSceneOp(
      fake.asRunner,
      'delete_nodes',
      {},
      '/p',
      TEST_FAILURE_PREFIX,
      EMPTY_SOLUTIONS,
      EXCEPTION_SOLUTIONS,
    );
    expectErrorMatching(result, /see get_debug_output for details/);
  });

  it('wraps a thrown runner error with failurePrefix and exceptionSolutions', async () => {
    const fake = createFakeRunner({ throws: new Error('spawn ENOENT') });
    const result = await executeSceneOp(
      fake.asRunner,
      'add_node',
      {},
      '/p',
      TEST_FAILURE_PREFIX,
      EMPTY_SOLUTIONS,
      EXCEPTION_SOLUTIONS,
    );
    expectErrorMatching(result, /Failed to op: spawn ENOENT/);
    const solutionsText = unwrap(result).content[1]?.text ?? '';
    expect(solutionsText).toContain('exc: a');
    expect(solutionsText).not.toContain('empty: a');
  });
});

// parseStdoutAsJson failure diagnosis: when a headless operation exits before
// emitting its JSON payload (early quit(1) on error), stdout contains only
// engine noise — RID-leak warnings are the canonical production shape (the
// JSON-absent case). Blaming "GDScript returned invalid JSON" sends the
// caller debugging the operation script instead of the actual failure; the
// error must surface the offending stdout content and any stderr diagnostics.
describe('executeSceneOp parseStdoutAsJson failure diagnosis', () => {
  it('reports the non-JSON stdout content in the parse-failure error', async () => {
    const ridNoise = "ERROR: 5 RID allocations of type 'P11GodotBody2D' were leaked at exit.\n";
    const fake = createFakeRunner({ stdout: ridNoise, stderr: '' });
    const result = await executeSceneOp(
      fake.asRunner,
      'attach_script',
      {},
      '/p',
      TEST_FAILURE_PREFIX,
      EMPTY_SOLUTIONS,
      EXCEPTION_SOLUTIONS,
      { parseStdoutAsJson: true },
    );
    expect(hasError(result)).toBe(true);
    expectErrorMatching(result, /Failed to op/);
    // The misleading blame is gone...
    const message = unwrap(result).content[0]?.text ?? '';
    expect(message).not.toContain('bug in godot_operations.gd');
    // ...and the offending stdout is surfaced so the real cause is visible.
    expect(message).toContain('RID allocations');
  });

  it('surfaces stderr diagnostics alongside the offending stdout when JSON is absent', async () => {
    const fake = createFakeRunner({
      stdout: "ERROR: 3 RID allocations of type 'P11GodotBody2D' were leaked at exit.\n",
      stderr: 'ERROR: Condition "!p_values" is true. Failed to load script.',
    });
    const result = await executeSceneOp(
      fake.asRunner,
      'attach_script',
      {},
      '/p',
      TEST_FAILURE_PREFIX,
      EMPTY_SOLUTIONS,
      EXCEPTION_SOLUTIONS,
      { parseStdoutAsJson: true },
    );
    expectErrorMatching(result, /Failed to op/);
    expectErrorMatching(result, /Condition "!p_values"/);
    const messageText = unwrap(result).content[0]?.text ?? '';
    expect(messageText).toContain('no JSON payload was emitted');
  });

  it('keeps the generic invalid-JSON message when stdout is JSON-shaped (true op bug, no disguise)', async () => {
    const fake = createFakeRunner({ stdout: 'not json { but has braces }', stderr: '' });
    const result = await executeSceneOp(
      fake.asRunner,
      'attach_script',
      {},
      '/p',
      TEST_FAILURE_PREFIX,
      EMPTY_SOLUTIONS,
      EXCEPTION_SOLUTIONS,
      { parseStdoutAsJson: true },
    );
    expectErrorMatching(result, /GDScript returned invalid JSON/);
  });

  it('does not mask a mid-stdout JSON parse failure (truncated payload after leading noise)', async () => {
    const fake = createFakeRunner({
      stdout: 'WARNING: noise\n{"results": [{"ok": tru',
      stderr: '',
    });
    const result = await executeSceneOp(
      fake.asRunner,
      'attach_script',
      {},
      '/p',
      TEST_FAILURE_PREFIX,
      EMPTY_SOLUTIONS,
      EXCEPTION_SOLUTIONS,
      { parseStdoutAsJson: true },
    );
    expectErrorMatching(result, /GDScript returned invalid JSON/);
  });

  it('parses a valid payload preceded by leading ERROR/WARNING engine noise', async () => {
    const fake = createFakeRunner({
      stdout: 'WARNING: upload timing\nERROR: transient probe\n{"results": [{"ok": true}]}\n',
      stderr: '',
    });
    const result = await executeSceneOp(
      fake.asRunner,
      'attach_script',
      {},
      '/p',
      TEST_FAILURE_PREFIX,
      EMPTY_SOLUTIONS,
      EXCEPTION_SOLUTIONS,
      { parseStdoutAsJson: true },
    );
    expect(hasError(result)).toBe(false);
  });

  it('includes SCRIPT ERROR lines from stderr in the early-exit diagnosis, with file+line preserved', async () => {
    const fake = createFakeRunner({
      stdout: "ERROR: 1 RID allocation of type 'P11GodotBody2D' was leaked at exit.\n",
      stderr:
        'SCRIPT ERROR: Parse Error: Identifier "Foo" not declared in the current scope.\n     at: GDScript::reload (res://scripts/bar.gd:3)',
    });
    const result = await executeSceneOp(
      fake.asRunner,
      'attach_script',
      {},
      '/p',
      TEST_FAILURE_PREFIX,
      EMPTY_SOLUTIONS,
      EXCEPTION_SOLUTIONS,
      { parseStdoutAsJson: true },
    );
    expectErrorMatching(result, /Identifier "Foo" not declared/);
    // The continuation line carries the file+line — the single most useful
    // part of a Godot diagnostic — and must survive into the error message.
    expectErrorMatching(result, /res:\/\/scripts\/bar\.gd/);
    expectErrorMatching(result, /:3/);
  });

  it('classifies unrecognized bracket-free stdout as an early exit rather than a JSON bug', async () => {
    // A line shape the noise whitelist does not know (a stray print() from
    // the operation script before it died) must not fall back to blaming
    // JSON emission: with no JSON opener anywhere, nothing was emitted.
    const fake = createFakeRunner({
      stdout:
        "Attaching script to root/Player\nERROR: 2 RID allocations of type 'P11GodotBody2D' were leaked at exit.",
      stderr: '',
    });
    const result = await executeSceneOp(
      fake.asRunner,
      'attach_script',
      {},
      '/p',
      TEST_FAILURE_PREFIX,
      EMPTY_SOLUTIONS,
      EXCEPTION_SOLUTIONS,
      { parseStdoutAsJson: true },
    );
    const message = unwrap(result).content[0]?.text ?? '';
    expect(message).toContain('no JSON payload was emitted');
    expect(message).not.toContain('bug in godot_operations.gd');
    expect(message).toContain('Attaching script to root/Player');
  });

  it('classifies early-quit stdout containing a stray bracket as an early exit, not a JSON bug', async () => {
    const fake = createFakeRunner({
      stdout:
        "ERROR: Parse Error: Parse error. [Resource file res://main.tscn:4]\nERROR: 5 RID allocations of type 'P11GodotBody2D' were leaked at exit.",
      stderr: '',
    });
    const result = await executeSceneOp(
      fake.asRunner,
      'attach_script',
      {},
      '/p',
      TEST_FAILURE_PREFIX,
      EMPTY_SOLUTIONS,
      EXCEPTION_SOLUTIONS,
      { parseStdoutAsJson: true },
    );
    const message = unwrap(result).content[0]?.text ?? '';
    expect(message).toContain('no JSON payload was emitted');
    expect(message).not.toContain('bug in godot_operations.gd');
  });
});

// Captured verbatim from Godot 4.6.2.stable.mono on Windows: attach_script
// against a missing node (log_error + quit(1)) with DEBUG=true. This is the
// production shape that reaches the parseStdoutAsJson branch at all -- with
// DEBUG off, stdout is the version banner alone, cleanStdout empties it, and
// the empty-stdout branch above handles it. The [DEBUG] lines are what keep
// stdout non-empty AND non-JSON, and they carry `{`/`[` from the echoed
// params, so any classifier keying on bracket presence reads this as a
// payload attempt and reports a JSON emission bug.
const CAPTURED_DEBUG_EARLY_EXIT_STDOUT = [
  'Godot Engine v4.6.2.stable.mono.official.71f334935 - https://godotengine.org',
  '',
  '[DEBUG] All arguments: ["--script", "dist/scripts/godot_operations.gd", "attach_script", "{\\"scene_path\\":\\"_capture/target.tscn\\",\\"node_path\\":\\"NoSuchNode\\"}", "--debug-godot"]',
  '[DEBUG] Params JSON: {"scene_path":"_capture/target.tscn","node_path":"NoSuchNode"}',
  '[DEBUG] Loading scene from: res://_capture/target.tscn',
].join('\n');

const CAPTURED_DEBUG_EARLY_EXIT_STDERR = [
  '[INFO] Operation: attach_script',
  '[ERROR] Node not found: NoSuchNode',
  'WARNING: 1 RID of type "CanvasItem" was leaked.',
  '   at: _free_rids (servers/rendering/renderer_canvas_cull.cpp:2690)',
].join('\n');

describe('executeSceneOp early-exit diagnosis against captured Godot output', () => {
  it('classifies a real DEBUG-mode early exit as such, not as a JSON emission bug', async () => {
    // cleanStdout is what GodotRunner.executeOperation applies before a
    // handler ever sees stdout, so applying it here keeps the fixture
    // faithful to the production path rather than testing a shape that
    // only a fake runner can produce.
    const fake = createFakeRunner({
      stdout: cleanStdout(CAPTURED_DEBUG_EARLY_EXIT_STDOUT),
      stderr: CAPTURED_DEBUG_EARLY_EXIT_STDERR,
    });
    const result = await executeSceneOp(
      fake.asRunner,
      'attach_script',
      {},
      '/p',
      TEST_FAILURE_PREFIX,
      EMPTY_SOLUTIONS,
      EXCEPTION_SOLUTIONS,
      { parseStdoutAsJson: true },
    );
    const message = unwrap(result).content[0]?.text ?? '';
    expect(message).toContain('no JSON payload was emitted');
    expect(message).not.toContain('bug in godot_operations.gd');
    // The actual cause. parseScriptDiagnostics does not match the bracketed
    // [ERROR] form the operation script emits, so this arrives via the raw
    // stderr tail -- which is exactly why that fallback has to exist.
    expect(message).toContain('Node not found: NoSuchNode');
  });
});
