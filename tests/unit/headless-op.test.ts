/**
 * Direct unit tests for executeSceneOp.
 *
 * Currently only covered transitively via the 15 scene/node mutation
 * handlers. A direct test localizes the failure when its contract drifts -
 * the empty-stdout branch and the catch branch are easy to break in a
 * refactor.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { executeSceneOp, findLiveSessionOnProject } from '../../src/utils/headless-op.js';
import { leadWithWarnings } from '../../src/utils/structured-response.js';
import { createFakeRunner } from '../helpers/fake-runner.js';
import type { FakeRunner } from '../helpers/fake-runner.js';
import { hasError, expectErrorMatching, unwrap } from '../helpers/assertions.js';
import { cleanStdout, OPERATION_RESULT_SENTINEL } from '../../src/utils/output-parsing.js';
import type { GodotRunner } from '../../src/utils/godot-runner.js';
import { BridgeRegistryUnreadableError } from '../../src/utils/bridge-manager.js';

const TEST_FAILURE_PREFIX = 'Failed to op';
const EMPTY_SOLUTIONS = ['empty: a', 'empty: b'];
const EXCEPTION_SOLUTIONS = ['exc: a', 'exc: b'];

interface LiveSession {
  mode: 'spawned' | 'attached';
  projectPath: string;
  /** Only meaningful for a 'spawned' session. Default: false (process still running). */
  hasExited?: boolean;
}

/**
 * Fake runner with live runtime-session state for the guard tests. Sets the
 * fields `hasActiveRuntimeSession()` actually reads, so the tests exercise
 * the real predicate rather than a stand-in.
 */
function runnerWithLiveSession(session: LiveSession | null): FakeRunner {
  const fake = createFakeRunner({ stdout: '{"ok":true}' });
  const runner = fake.asRunner as GodotRunner & {
    activeSessionMode: 'spawned' | 'attached' | null;
    activeProjectPath: string | null;
    activeProcess: { hasExited: boolean } | null;
  };
  runner.activeSessionMode = session?.mode ?? null;
  runner.activeProjectPath = session?.projectPath ?? null;
  runner.activeProcess =
    session?.mode === 'spawned' ? { hasExited: session.hasExited ?? false } : null;
  return fake;
}

/** Give the fake live sessions on projects other than its current one. */
function withExtraLiveSessions(fake: FakeRunner, projectPaths: string[]): void {
  (fake.asRunner as GodotRunner & { extraLiveSessionPaths: string[] }).extraLiveSessionPaths =
    projectPaths;
}

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

  describe('live-session scene guard', () => {
    it('errors when mutating a scene while a spawned session is active on the same project', async () => {
      const fake = runnerWithLiveSession({ mode: 'spawned', projectPath: '/proj' });
      const result = await executeSceneOp(
        fake.asRunner,
        'add_node',
        { scenePath: 'scenes/main.tscn' },
        '/proj',
        TEST_FAILURE_PREFIX,
        EMPTY_SOLUTIONS,
        EXCEPTION_SOLUTIONS,
        { mutatesSceneFile: true },
      );
      expectErrorMatching(result, /active.*session|session.*active/i);
      expect(fake.calls.length).toBe(0); // rejected before spawning headless Godot
    });

    it('errors when mutating a scene while an attached session is active on the same project', async () => {
      const fake = runnerWithLiveSession({ mode: 'attached', projectPath: '/proj' });
      const result = await executeSceneOp(
        fake.asRunner,
        'attach_script',
        { scenePath: 'scenes/main.tscn' },
        '/proj',
        TEST_FAILURE_PREFIX,
        EMPTY_SOLUTIONS,
        EXCEPTION_SOLUTIONS,
        { mutatesSceneFile: true },
      );
      expectErrorMatching(result, /active.*session|session.*active/i);
      expect(fake.calls.length).toBe(0);
    });

    it('allows scene mutations when no runtime session is active', async () => {
      const fake = runnerWithLiveSession(null);
      const result = await executeSceneOp(
        fake.asRunner,
        'add_node',
        { scenePath: 'scenes/main.tscn' },
        '/proj',
        TEST_FAILURE_PREFIX,
        EMPTY_SOLUTIONS,
        EXCEPTION_SOLUTIONS,
        { mutatesSceneFile: true },
      );
      expect(hasError(result)).toBe(false);
      expect(fake.calls.length).toBe(1);
    });

    it('allows scene mutations when the live session is on a different project', async () => {
      const fake = runnerWithLiveSession({ mode: 'spawned', projectPath: '/other' });
      const result = await executeSceneOp(
        fake.asRunner,
        'add_node',
        { scenePath: 'scenes/main.tscn' },
        '/proj',
        TEST_FAILURE_PREFIX,
        EMPTY_SOLUTIONS,
        EXCEPTION_SOLUTIONS,
        { mutatesSceneFile: true },
      );
      expect(hasError(result)).toBe(false);
      expect(fake.calls.length).toBe(1);
    });

    it('refuses a scene mutation on a project whose live session is not current', async () => {
      // The current session is on another project; /proj is still being run
      // by this server, so its engine is still a second writer.
      const fake = runnerWithLiveSession({ mode: 'spawned', projectPath: '/current' });
      withExtraLiveSessions(fake, ['/proj']);
      const result = await executeSceneOp(
        fake.asRunner,
        'add_node',
        { scenePath: 'scenes/main.tscn' },
        '/proj',
        TEST_FAILURE_PREFIX,
        EMPTY_SOLUTIONS,
        EXCEPTION_SOLUTIONS,
        { mutatesSceneFile: true },
      );
      expectErrorMatching(result, /active.*session|session.*active/i);
      expect(fake.calls.length).toBe(0);
    });

    it('tells the caller to switch first when the live session is not current', async () => {
      const fake = runnerWithLiveSession({ mode: 'spawned', projectPath: '/current' });
      withExtraLiveSessions(fake, ['/proj']);
      const result = await executeSceneOp(
        fake.asRunner,
        'add_node',
        { scenePath: 'scenes/main.tscn' },
        '/proj',
        TEST_FAILURE_PREFIX,
        EMPTY_SOLUTIONS,
        EXCEPTION_SOLUTIONS,
        { mutatesSceneFile: true },
      );
      expectErrorMatching(result, /not the current one/);
      const content = unwrap(result)
        .content.map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n');
      expect(content).toContain('switch_project');
      expect(content).toContain('"/proj"');
      expect(fake.calls.length).toBe(0);
    });

    it('keeps the plain stop_project remedy for the current session', async () => {
      const fake = runnerWithLiveSession({ mode: 'spawned', projectPath: '/proj' });
      const result = await executeSceneOp(
        fake.asRunner,
        'add_node',
        { scenePath: 'scenes/main.tscn' },
        '/proj',
        TEST_FAILURE_PREFIX,
        EMPTY_SOLUTIONS,
        EXCEPTION_SOLUTIONS,
        { mutatesSceneFile: true },
      );
      const content = JSON.stringify(unwrap(result).content);
      expect(content).toContain('Call stop_project, then retry the scene edit');
      expect(content).not.toContain('switch_project');
    });

    it('points the caller at stop_project as the remedy', async () => {
      const fake = runnerWithLiveSession({ mode: 'spawned', projectPath: '/proj' });
      const result = await executeSceneOp(
        fake.asRunner,
        'add_node',
        { scenePath: 'scenes/main.tscn' },
        '/proj',
        TEST_FAILURE_PREFIX,
        EMPTY_SOLUTIONS,
        EXCEPTION_SOLUTIONS,
        { mutatesSceneFile: true },
      );
      const solutionsText = JSON.stringify(unwrap(result).content);
      expect(solutionsText).toMatch(/stop_project/i);
    });

    it('allows a read-only op (no mutatesSceneFile) while a session is live on the same project', async () => {
      const fake = runnerWithLiveSession({ mode: 'spawned', projectPath: '/proj' });
      const result = await executeSceneOp(
        fake.asRunner,
        'get_scene_tree',
        { scenePath: 'scenes/main.tscn' },
        '/proj',
        TEST_FAILURE_PREFIX,
        EMPTY_SOLUTIONS,
        EXCEPTION_SOLUTIONS,
      );
      expect(hasError(result)).toBe(false);
      expect(fake.calls.length).toBe(1);
    });

    it('does not block a mutating op once the spawned process has exited', async () => {
      const fake = runnerWithLiveSession({
        mode: 'spawned',
        projectPath: '/proj',
        hasExited: true,
      });
      const result = await executeSceneOp(
        fake.asRunner,
        'add_node',
        { scenePath: 'scenes/main.tscn' },
        '/proj',
        TEST_FAILURE_PREFIX,
        EMPTY_SOLUTIONS,
        EXCEPTION_SOLUTIONS,
        { mutatesSceneFile: true },
      );
      expect(hasError(result)).toBe(false);
      expect(fake.calls.length).toBe(1);
    });

    it('errors with a distinct cross-server message when another MCP session owns the game on this project', async () => {
      const fake = runnerWithLiveSession(null);
      (fake.asRunner as GodotRunner & { otherLiveSessions: unknown[] }).otherLiveSessions = [
        {
          pid: 4242,
          instanceId: 'abc123',
          hostname: 'some-host',
          mode: 'spawned',
          startedAt: new Date().toISOString(),
          port: 9900,
        },
      ];
      const result = await executeSceneOp(
        fake.asRunner,
        'add_node',
        { scenePath: 'scenes/main.tscn' },
        '/proj',
        TEST_FAILURE_PREFIX,
        EMPTY_SOLUTIONS,
        EXCEPTION_SOLUTIONS,
        { mutatesSceneFile: true },
      );
      expectErrorMatching(result, /Another MCP session/);
      expectErrorMatching(result, /pid 4242/);
      expectErrorMatching(result, /wait/i);
      expect(fake.calls.length).toBe(0);
    });

    it('allows scene mutations when the other live session it can see is on a different project', async () => {
      const fake = runnerWithLiveSession(null);
      (fake.asRunner as GodotRunner & { otherLiveSessions: unknown[] }).otherLiveSessions = [];
      const result = await executeSceneOp(
        fake.asRunner,
        'add_node',
        { scenePath: 'scenes/main.tscn' },
        '/proj',
        TEST_FAILURE_PREFIX,
        EMPTY_SOLUTIONS,
        EXCEPTION_SOLUTIONS,
        { mutatesSceneFile: true },
      );
      expect(hasError(result)).toBe(false);
      expect(fake.calls.length).toBe(1);
    });

    it('tolerates a trailing slash and a "." segment when comparing project paths', async () => {
      const fake = runnerWithLiveSession({ mode: 'spawned', projectPath: '/proj/' });
      const result = await executeSceneOp(
        fake.asRunner,
        'add_node',
        { scenePath: 'scenes/main.tscn' },
        '/proj/./',
        TEST_FAILURE_PREFIX,
        EMPTY_SOLUTIONS,
        EXCEPTION_SOLUTIONS,
        { mutatesSceneFile: true },
      );
      expectErrorMatching(result, /active.*session|session.*active/i);
      expect(fake.calls.length).toBe(0);
    });

    // The guard asks "is another session running this project's game". A
    // registry that cannot be read does not answer no.
    it('an unreadable owner registry refuses the scene edit with the reason', async () => {
      const fake = runnerWithLiveSession(null);
      const reason = 'cannot list /proj/.mcp/godot-runtime/bridge/owners: EACCES';
      const runner = fake.asRunner as GodotRunner & { otherLiveSessionsOnProject: () => never };
      runner.otherLiveSessionsOnProject = () => {
        throw new BridgeRegistryUnreadableError(reason);
      };
      const result = await executeSceneOp(
        fake.asRunner,
        'add_node',
        { scenePath: 'scenes/main.tscn' },
        '/proj',
        TEST_FAILURE_PREFIX,
        EMPTY_SOLUTIONS,
        EXCEPTION_SOLUTIONS,
        { mutatesSceneFile: true },
      );
      expectErrorMatching(result, /Could not read this project's bridge owner registry/);
      expectErrorMatching(result, /bridge\/owners: EACCES/);
      expectErrorMatching(result, /unknown whether another MCP session is running its game/);
      expectErrorMatching(result, /Refusing the scene edit/);
      expect(fake.calls.length).toBe(0);
    });
  });
});

// Cold-import retry contract: executeSceneOp reacts to the [IMPORT_NEEDED]
// stderr marker by running importAssets() and retrying the operation exactly
// once, capped structurally (no loop that could re-enter on a second marker).
describe('executeSceneOp cold-import retry', () => {
  it('imports once and retries once when the marker appears with empty stdout, then succeeds', async () => {
    const fake = createFakeRunner({
      responses: [
        { stdout: '', stderr: '[IMPORT_NEEDED] main.tscn: res://assets/tex.png' },
        { stdout: '{"ok":true}', stderr: '' },
      ],
    });
    const result = await executeSceneOp(
      fake.asRunner,
      'get_scene_tree',
      { scenePath: 'main.tscn' },
      '/proj',
      TEST_FAILURE_PREFIX,
      EMPTY_SOLUTIONS,
      EXCEPTION_SOLUTIONS,
    );
    expect(fake.importCalls).toEqual(['/proj']);
    expect(fake.calls).toHaveLength(2);
    expect(hasError(result)).toBe(false);
    expect(unwrap(result).content).toEqual([{ type: 'text', text: '{"ok":true}' }]);
  });

  it('reports an error mentioning the import step when the retry still has empty stdout', async () => {
    const fake = createFakeRunner({
      responses: [
        { stdout: '', stderr: '[IMPORT_NEEDED] main.tscn: res://assets/tex.png' },
        { stdout: '', stderr: '[ERROR] still broken' },
      ],
    });
    const result = await executeSceneOp(
      fake.asRunner,
      'get_scene_tree',
      { scenePath: 'main.tscn' },
      '/proj',
      TEST_FAILURE_PREFIX,
      EMPTY_SOLUTIONS,
      EXCEPTION_SOLUTIONS,
    );
    expect(fake.importCalls).toEqual(['/proj']);
    expect(fake.calls).toHaveLength(2);
    expectErrorMatching(result, /import step/i);
  });

  it('reports the thrown message and does not retry the operation when importAssets throws', async () => {
    const fake = createFakeRunner({
      stdout: '',
      stderr: '[IMPORT_NEEDED] main.tscn: res://assets/tex.png',
      importThrows: new Error('Asset import reported errors for 1 file(s)'),
    });
    const result = await executeSceneOp(
      fake.asRunner,
      'get_scene_tree',
      { scenePath: 'main.tscn' },
      '/proj',
      TEST_FAILURE_PREFIX,
      EMPTY_SOLUTIONS,
      EXCEPTION_SOLUTIONS,
    );
    expect(fake.importCalls).toEqual(['/proj']);
    expect(fake.calls).toHaveLength(1);
    expectErrorMatching(result, /Asset import reported errors for 1 file\(s\)/);
  });

  it('does not import and returns the live-session guard error when a session is active on the same project', async () => {
    const fake = createFakeRunner({
      stdout: '',
      stderr: '[IMPORT_NEEDED] main.tscn: res://assets/tex.png',
    });
    const runner = fake.asRunner as GodotRunner & {
      activeSessionMode: 'spawned' | 'attached' | null;
      activeProjectPath: string | null;
      activeProcess: { hasExited: boolean } | null;
    };
    runner.activeSessionMode = 'spawned';
    runner.activeProjectPath = '/proj';
    runner.activeProcess = { hasExited: false };
    const result = await executeSceneOp(
      fake.asRunner,
      'get_scene_tree',
      { scenePath: 'main.tscn' },
      '/proj',
      TEST_FAILURE_PREFIX,
      EMPTY_SOLUTIONS,
      EXCEPTION_SOLUTIONS,
    );
    expect(fake.importCalls).toEqual([]);
    expect(fake.calls).toHaveLength(1);
    expectErrorMatching(result, /active.*session|session.*active/i);
  });

  it('refuses the import retry when the marked run already reported an applied step', async () => {
    // The batch shape the refusal exists for: step 1 mutated and was saved,
    // step 2 hit a cold asset. Re-running the batch would add step 1 twice.
    const partialBatch = JSON.stringify({
      results: [
        { operation: 'add_node', scenePath: 'main.tscn', success: true },
        {
          operation: 'load_sprite',
          scenePath: 'main.tscn',
          error: 'asset not yet imported: res://assets/tex.png',
        },
      ],
    });
    const fake = createFakeRunner({
      responses: [
        { stdout: partialBatch, stderr: '[IMPORT_NEEDED] load_sprite: res://assets/tex.png' },
      ],
    });
    const result = await executeSceneOp(
      fake.asRunner,
      'batch_scene_operations',
      { operations: [] },
      '/proj',
      TEST_FAILURE_PREFIX,
      EMPTY_SOLUTIONS,
      EXCEPTION_SOLUTIONS,
      { parseStdoutAsJson: true },
    );
    expect(fake.importCalls).toEqual([]);
    expect(fake.calls).toHaveLength(1);
    expectErrorMatching(result, /second time/i);
    // The caller has to know what did land, or it cannot resume safely.
    expectErrorMatching(result, /add_node/);
    // The quoted payload is shown without its stdout framing.
    const message = unwrap(result).content[0]?.text ?? '';
    expect(message).not.toContain(OPERATION_RESULT_SENTINEL);
    expect(message).toContain(`reported by this run: ${partialBatch}`);
  });

  it('still imports and retries when the marked run reported no applied step', async () => {
    const failedBatch = JSON.stringify({
      results: [
        {
          operation: 'load_sprite',
          scenePath: 'main.tscn',
          error: 'asset not yet imported: res://assets/tex.png',
        },
      ],
    });
    const retried = JSON.stringify({
      results: [{ operation: 'load_sprite', scenePath: 'main.tscn', success: true }],
    });
    const fake = createFakeRunner({
      responses: [
        { stdout: failedBatch, stderr: '[IMPORT_NEEDED] load_sprite: res://assets/tex.png' },
        { stdout: retried, stderr: '' },
      ],
    });
    const result = await executeSceneOp(
      fake.asRunner,
      'batch_scene_operations',
      { operations: [] },
      '/proj',
      TEST_FAILURE_PREFIX,
      EMPTY_SOLUTIONS,
      EXCEPTION_SOLUTIONS,
      { parseStdoutAsJson: true },
    );
    expect(fake.importCalls).toEqual(['/proj']);
    expect(fake.calls).toHaveLength(2);
    expect(hasError(result)).toBe(false);
  });

  it('never calls importAssets when the marker is absent', async () => {
    const fake = createFakeRunner({ stdout: '{"ok":true}', stderr: '' });
    const result = await executeSceneOp(
      fake.asRunner,
      'get_scene_tree',
      { scenePath: 'main.tscn' },
      '/proj',
      TEST_FAILURE_PREFIX,
      EMPTY_SOLUTIONS,
      EXCEPTION_SOLUTIONS,
    );
    expect(fake.importCalls).toEqual([]);
    expect(fake.calls).toHaveLength(1);
    expect(hasError(result)).toBe(false);
  });
});

// parseStdoutAsJson failure diagnosis: when a headless operation exits before
// emitting its JSON payload (early quit(1) on error), stdout contains only
// engine noise: RID-leak warnings are the canonical production shape (the
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

  it('keeps the generic invalid-JSON message when a sentinel line carries unparseable JSON (true op bug, no disguise)', async () => {
    const fake = createFakeRunner({
      stdout: `${OPERATION_RESULT_SENTINEL}not json { but has braces }`,
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

  it('does not mask a mid-stdout JSON parse failure (truncated payload after leading noise)', async () => {
    const fake = createFakeRunner({
      stdout: `WARNING: noise\n${OPERATION_RESULT_SENTINEL}{"results": [{"ok": tru`,
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
      stdout: `WARNING: upload timing\nERROR: transient probe\n${OPERATION_RESULT_SENTINEL}{"results": [{"ok": true}]}\n`,
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
    // The continuation line carries the file+line: the single most useful
    // part of a Godot diagnostic: and must survive into the error message.
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
// against a missing node (log_error + quit(1)) with DEBUG=true, back when
// log_debug still wrote to stdout. It is kept as the fixture because it is the
// worst stdout a headless op can produce: non-empty, non-JSON, and carrying
// `{`/`[` from the echoed params, so any classifier keying on bracket presence
// reads it as a payload attempt and reports a JSON emission bug. The debug
// lines now go to stderr (see the logging invariant at the end of this file),
// so this exact stdout is no longer producible -- the classifier still has to
// handle it, and anything else that ever lands non-JSON on stdout.
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
    // Every line of this stdout is banner or [DEBUG] status, which cleanStdout
    // drops, so the run arrives as empty output and gets the same diagnosis
    // the run produces without DEBUG: the operation's own [ERROR] line from
    // stderr, with the handler's solutions. Pinned exactly, so a change that
    // sends this case anywhere else (the no-payload message, or a JSON
    // emission blame) fails here.
    expect(message).toBe(`${TEST_FAILURE_PREFIX}: Node not found: NoSuchNode`);
    expect(unwrap(result).content[1]?.text ?? '').toContain(EMPTY_SOLUTIONS[0]);
  });

  it('classifies the same captured stdout as no-payload when it reaches the parser uncleaned', async () => {
    // Not a shape GodotRunner.executeOperation can hand over (it always
    // cleans). This holds the interpreter itself to the rule: bracket-heavy
    // text with no sentinel line is "no payload", never a parse attempt.
    const fake = createFakeRunner({
      stdout: CAPTURED_DEBUG_EARLY_EXIT_STDOUT,
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
    expect(message).toContain('Node not found: NoSuchNode');
  });
});

/**
 * stdout is the JSON channel for a headless operation and both validate check
 * paths strict-parse it, so a debug line there is not noise the parser skips:
 * it puts a `[` at column 0 of the very stream the payload shares, and nothing
 * but the sentinel framing keeps the two apart. Asserted against the script source
 * because only a real Godot run would otherwise catch it, and DEBUG=true is not
 * a mode the suite runs in.
 */
describe('godot_operations.gd logging channel', () => {
  const operationsSource = readFileSync(
    new URL('../../src/scripts/godot_operations.gd', import.meta.url),
    'utf8',
  );

  it('routes log_debug to stderr so DEBUG=true cannot corrupt a JSON payload', () => {
    const afterDeclaration = operationsSource.split('func log_debug')[1] ?? '';
    const logDebugBody = afterDeclaration.split('func ')[0] ?? '';
    expect(logDebugBody).toContain('printerr("[DEBUG] "');
    expect(logDebugBody).not.toMatch(/(^|[^r])print\("\[DEBUG\]/);
  });
});

// Engine banner, the payload, and any print() from an autoload or a scene
// script share stdout. Brackets in that noise used to make the payload
// extraction pick the wrong span and report "invalid JSON".
describe('executeSceneOp reads only the sentinel line as the payload', () => {
  const PAYLOAD = { results: [{ success: true }] };
  const PAYLOAD_LINE = `${OPERATION_RESULT_SENTINEL}${JSON.stringify(PAYLOAD)}`;

  async function runWithStdout(stdout: string) {
    const fake = createFakeRunner({ stdout, stderr: '' });
    return executeSceneOp(
      fake.asRunner,
      'set_node_properties',
      {},
      '/p',
      TEST_FAILURE_PREFIX,
      EMPTY_SOLUTIONS,
      EXCEPTION_SOLUTIONS,
      { parseStdoutAsJson: true },
    );
  }

  const noisyShapes: Array<[string, string]> = [
    ['a bracketed line before the payload', `[Autoload] ready\n${PAYLOAD_LINE}`],
    ['a bracketed line after the payload', `${PAYLOAD_LINE}\n[Audio] shutdown`],
    ['a printed dictionary on each side', `{"a": 1}\n${PAYLOAD_LINE}\n{"b": 2}`],
    ['a JSON-looking array after the payload', `${PAYLOAD_LINE}\n[1, 2]`],
  ];

  for (const [label, noise] of noisyShapes) {
    it(`returns the payload despite ${label}`, async () => {
      const result = await runWithStdout(`Godot Engine v4.6.2.stable\n${noise}\n`);
      expect(hasError(result)).toBe(false);
      expect(unwrap(result).structuredContent).toEqual(PAYLOAD);
    });
  }

  it('reports no payload, never invalid JSON, when bracketed noise has no sentinel line', async () => {
    const result = await runWithStdout(
      'Godot Engine v4.6.2.stable\n[Audio] ready\n{"unrelated": true}\n[1, 2]\n',
    );
    expect(hasError(result)).toBe(true);
    const message = unwrap(result).content[0]?.text ?? '';
    expect(message).toContain('no JSON payload was emitted');
    expect(message).not.toContain('invalid JSON');
    expect(message).toContain('[Audio] ready');
  });

  it('never shows the sentinel when the raw text of a payload is returned', async () => {
    const fake = createFakeRunner({ stdout: PAYLOAD_LINE, stderr: '' });
    const result = await executeSceneOp(
      fake.asRunner,
      'get_node_properties',
      {},
      '/p',
      TEST_FAILURE_PREFIX,
      EMPTY_SOLUTIONS,
      EXCEPTION_SOLUTIONS,
    );
    const text = unwrap(result).content[0]?.text ?? '';
    expect(text).not.toContain(OPERATION_RESULT_SENTINEL);
    expect(JSON.parse(text)).toEqual(PAYLOAD);
  });
});

describe('executeSceneOp puts warnings first', () => {
  async function runWithPayload(payload: Record<string, unknown>) {
    const fake = createFakeRunner({
      stdout: `${OPERATION_RESULT_SENTINEL}${JSON.stringify(payload)}`,
      stderr: '',
    });
    return executeSceneOp(
      fake.asRunner,
      'set_node_properties',
      {},
      '/p',
      TEST_FAILURE_PREFIX,
      EMPTY_SOLUTIONS,
      EXCEPTION_SOLUTIONS,
      { parseStdoutAsJson: true },
    );
  }

  it('moves a non-empty warnings array to the front', async () => {
    // Keys arrive sorted, so warnings is last in the emitted JSON.
    const result = await runWithPayload({ results: [], warnings: ['w'] });
    const payload = unwrap(result).structuredContent as Record<string, unknown>;
    expect(Object.keys(payload)[0]).toBe('warnings');
    expect(payload).toEqual({ warnings: ['w'], results: [] });
  });

  it('drops an empty warnings array', async () => {
    const result = await runWithPayload({ results: [], warnings: [] });
    expect(unwrap(result).structuredContent).toEqual({ results: [] });
  });

  it('leaves a payload without warnings unchanged', async () => {
    const result = await runWithPayload({ results: [] });
    expect(unwrap(result).structuredContent).toEqual({ results: [] });
  });
});

describe('leadWithWarnings', () => {
  it('moves a non-empty warnings array first', () => {
    const led = leadWithWarnings({ results: [], warnings: ['w'] });
    expect(Object.keys(led)).toEqual(['warnings', 'results']);
  });

  it('drops an empty warnings array', () => {
    expect(leadWithWarnings({ results: [], warnings: [] })).toEqual({ results: [] });
  });

  it('leaves a non-array warnings value untouched', () => {
    const payload = { results: [], warnings: 'x' };
    expect(leadWithWarnings(payload)).toBe(payload);
  });
});

describe('findLiveSessionOnProject', () => {
  const OTHER_PID = 4242;

  it('returns null with no session and no other owner', () => {
    const fake = runnerWithLiveSession(null);
    expect(findLiveSessionOnProject(fake.asRunner, '/proj')).toBeNull();
  });

  it('reports self for a live session on the same project, ignoring case and separators', () => {
    const fake = runnerWithLiveSession({ mode: 'spawned', projectPath: 'C:\\Games\\Proj\\' });
    expect(findLiveSessionOnProject(fake.asRunner, 'c:/games/proj')).toEqual({ owner: 'self' });
  });

  it('returns null for a live session on a different project', () => {
    const fake = runnerWithLiveSession({ mode: 'attached', projectPath: '/other' });
    expect(findLiveSessionOnProject(fake.asRunner, '/proj')).toBeNull();
  });

  it('reports self for a live session on the project that is not the current session', () => {
    const fake = runnerWithLiveSession({ mode: 'attached', projectPath: '/current' });
    withExtraLiveSessions(fake, ['C:\\Games\\Proj\\']);
    expect(findLiveSessionOnProject(fake.asRunner, 'c:/games/proj')).toEqual({ owner: 'self' });
    expect(findLiveSessionOnProject(fake.asRunner, '/unrelated')).toBeNull();
  });

  it("reports the other owner's info", () => {
    const fake = runnerWithLiveSession(null);
    const info = {
      pid: OTHER_PID,
      instanceId: 'abc123',
      hostname: 'some-host',
      mode: 'spawned',
      startedAt: new Date().toISOString(),
      port: 9900,
    };
    (fake.asRunner as GodotRunner & { otherLiveSessions: unknown[] }).otherLiveSessions = [info];
    expect(findLiveSessionOnProject(fake.asRunner, '/proj')).toEqual({ owner: 'other', info });
  });
});
