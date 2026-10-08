/**
 * Direct unit tests for executeSceneOp.
 *
 * Currently only covered transitively via the 15 scene/node handlers that
 * call it. A direct test localizes the failure when its contract drifts -
 * the empty-stdout branch and the catch branch are easy to break in a
 * refactor.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { hostname as osHostname } from 'os';
import {
  executeSceneOp,
  findLiveSessionOnProject,
  HEADLESS_RESPONSE_MARGIN_MS,
  IMPORT_RETRY_RESERVE_MS,
} from '../../src/utils/headless-op.js';
import { sceneBackupsDir } from '../../src/utils/artifact-paths.js';
import {
  batchSceneWrites,
  inPlaceSceneWrite,
  type SceneWriteIntent,
} from '../../src/utils/scene-loss-guard.js';
import { useTmpDirs } from '../helpers/tmp.js';
import { leadWithWarnings } from '../../src/utils/structured-response.js';
import { createFakeRunner } from '../helpers/fake-runner.js';
import type { FakeRunner } from '../helpers/fake-runner.js';
import { hasError, expectErrorMatching, unwrap } from '../helpers/assertions.js';
import { cleanStdout, OPERATION_RESULT_SENTINEL } from '../../src/utils/output-parsing.js';
import {
  CLIENT_REQUEST_TIMEOUT_MS,
  HEADLESS_OPERATION_TIMEOUT_MS,
  type GodotRunner,
} from '../../src/utils/godot-runner.js';
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
    expectErrorMatching(result, /gave no reason \(it printed no \[ERROR\] line\)/);
    // With no reason from the script, what stderr does hold is shown, and the
    // message names no log to go and read: a headless run keeps none.
    expectErrorMatching(result, /just some banner output/);
    expect(unwrap(result).content[0]?.text ?? '').not.toContain('get_debug_output');
  });

  it('shows the engine diagnostics when the script itself stopped without an [ERROR] line', async () => {
    // A runtime error inside godot_operations.gd: SCRIPT ERROR lines, no
    // payload and no [ERROR] line. The diagnostics are the only account of it.
    const fake = createFakeRunner({
      stdout: '',
      stderr:
        "SCRIPT ERROR: Invalid assignment of property or key 'name' with value of type 'float'.\n   at: _apply_add_node (res://godot_operations.gd:537)",
    });
    const result = await executeSceneOp(
      fake.asRunner,
      'batch_scene_operations',
      {},
      '/p',
      TEST_FAILURE_PREFIX,
      EMPTY_SOLUTIONS,
      EXCEPTION_SOLUTIONS,
    );
    expectErrorMatching(result, /Invalid assignment of property or key 'name'/);
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
      // The owner is on another host, so it counts as live for as long as its
      // file exists. The refusal has to give the way out: the host it came
      // from and the file to delete.
      expectErrorMatching(result, /registered from another host \("some-host"/);
      const solutions = unwrap(result).content[1]?.text ?? '';
      expect(solutions).toContain('4242-abc123.json');
      expect(solutions).toContain('delete its owner file');
    });

    it('names no host and no owner file when the other session is on this host', async () => {
      const fake = runnerWithLiveSession(null);
      (fake.asRunner as GodotRunner & { otherLiveSessions: unknown[] }).otherLiveSessions = [
        {
          pid: 4242,
          instanceId: 'abc123',
          hostname: osHostname(),
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
      const text = unwrap(result)
        .content.map((block) => block.text ?? '')
        .join('\n');
      expect(text).not.toContain('another host');
      expect(text).not.toContain('owner file');
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

describe('executeSceneOp with no reason from the script', () => {
  it('says once what stderr ended with, and says so when stderr was empty', async () => {
    const noisy = await executeSceneOp(
      createFakeRunner({ stdout: '', stderr: 'engine line one\nengine line two\n' }).asRunner,
      'delete_nodes',
      {},
      '/p',
      TEST_FAILURE_PREFIX,
      EMPTY_SOLUTIONS,
      EXCEPTION_SOLUTIONS,
    );
    const text = unwrap(noisy).content[0]?.text ?? '';
    expect(text).toBe(
      `${TEST_FAILURE_PREFIX}: the operation gave no reason (it printed no [ERROR] line)\nstderr (last lines): engine line one\nengine line two`,
    );

    const silent = await executeSceneOp(
      createFakeRunner({ stdout: '', stderr: '' }).asRunner,
      'delete_nodes',
      {},
      '/p',
      TEST_FAILURE_PREFIX,
      EMPTY_SOLUTIONS,
      EXCEPTION_SOLUTIONS,
    );
    // Red when the bare "no reason" message comes back for an empty stderr.
    expectErrorMatching(silent, /printed no \[ERROR\] line\); its stderr was empty/);
  });
});

// The import is waited for only while a retry still fits in the request: a
// client with no progress token gives up at 60 s, and an answer sent after
// that is never read.
describe('executeSceneOp cold-import wait is bounded by the request', () => {
  const MARKER_STDERR = '[IMPORT_NEEDED] main.tscn: res://assets/tex.png';
  /** Promise hops between a timer firing and the call's answer; generous. */
  const MICROTASK_FLUSHES = 50;

  async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < MICROTASK_FLUSHES; i++) await Promise.resolve();
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  function run(fake: ReturnType<typeof createFakeRunner>) {
    return executeSceneOp(
      fake.asRunner,
      'get_scene_tree',
      { scenePath: 'main.tscn' },
      '/proj',
      TEST_FAILURE_PREFIX,
      EMPTY_SOLUTIONS,
      EXCEPTION_SOLUTIONS,
    );
  }

  it('answers "still importing, retry" before the request times out, leaves the import running, and a second call joins it', async () => {
    vi.useFakeTimers();
    let finishImport!: () => void;
    const importPending = new Promise<void>((done) => {
      finishImport = done;
    });
    const fake = createFakeRunner({
      importPending,
      responses: [
        { stdout: '', stderr: MARKER_STDERR },
        { stdout: '', stderr: MARKER_STDERR },
        { stdout: '{"ok":true}', stderr: '' },
      ],
    });

    let first: Awaited<ReturnType<typeof run>> | undefined;
    void run(fake).then((result) => {
      first = result;
    });
    await vi.advanceTimersByTimeAsync(CLIENT_REQUEST_TIMEOUT_MS - 1);
    await flushMicrotasks();

    // Red when the import is awaited unconditionally: nothing has come back
    // by the time the client stopped listening.
    expect(first).toBeDefined();
    expectErrorMatching(
      first,
      /the project's assets are still being imported, nothing was changed; retry this call/,
    );
    // The operation was not run a second time against a half-imported project.
    expect(fake.calls).toHaveLength(1);

    // The retry: its first attempt asks for the import again and is handed
    // the one still in flight, then goes on once that has finished.
    let second: Awaited<ReturnType<typeof run>> | undefined;
    void run(fake).then((result) => {
      second = result;
    });
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    expect(second).toBeUndefined();
    finishImport();
    await flushMicrotasks();

    expect(second).toBeDefined();
    expect(hasError(second)).toBe(false);
    expect(fake.importCalls).toEqual(['/proj', '/proj']);
    expect(fake.calls).toHaveLength(3);
  });

  it('gives up the wait early enough that the retry it promises still had its reserve', async () => {
    vi.useFakeTimers();
    const fake = createFakeRunner({
      importPending: new Promise<void>(() => {}),
      stdout: '',
      stderr: MARKER_STDERR,
    });
    let answered = false;
    void run(fake).then(() => {
      answered = true;
    });
    const waitEndsAt =
      CLIENT_REQUEST_TIMEOUT_MS - HEADLESS_RESPONSE_MARGIN_MS - IMPORT_RETRY_RESERVE_MS;

    await vi.advanceTimersByTimeAsync(waitEndsAt - 1);
    await flushMicrotasks();
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(answered).toBe(true);
  });

  it('retries once, with the time the request has left, when the import finishes in time', async () => {
    vi.useFakeTimers();
    const importTookMs = 40000;
    const fake = createFakeRunner({
      importPending: new Promise<void>((done) => setTimeout(done, importTookMs)),
      responses: [
        { stdout: '', stderr: MARKER_STDERR },
        { stdout: '{"ok":true}', stderr: '' },
      ],
    });
    let result: Awaited<ReturnType<typeof run>> | undefined;
    void run(fake).then((value) => {
      result = value;
    });
    await vi.advanceTimersByTimeAsync(importTookMs);
    await flushMicrotasks();

    expect(result).toBeDefined();
    expect(hasError(result)).toBe(false);
    expect(fake.importCalls).toEqual(['/proj']);
    expect(fake.calls).toHaveLength(2);
    // Red when the retry is given the default timeout whatever is left: it
    // could then outlast the request it is answering.
    expect(fake.calls[1]!.timeoutMs).toBe(
      CLIENT_REQUEST_TIMEOUT_MS - HEADLESS_RESPONSE_MARGIN_MS - importTookMs,
    );
  });

  it('gives a quick import retry the ordinary operation timeout, not more', async () => {
    const fake = createFakeRunner({
      responses: [
        { stdout: '', stderr: MARKER_STDERR },
        { stdout: '{"ok":true}', stderr: '' },
      ],
    });
    expect(hasError(await run(fake))).toBe(false);
    expect(fake.calls[1]!.timeoutMs).toBe(HEADLESS_OPERATION_TIMEOUT_MS);
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

  // A single-step operation emits its payload after it has saved. Replaying
  // one adds the node a second time: Godot renames the copy, and the caller
  // gets a success for the copy while the first node is never reported.
  describe('an operation that emitted its result is never replayed', () => {
    const ADDED = JSON.stringify({ nodeName: 'Hud', nodeType: 'Label', nodePath: 'root/Hud' });

    async function addNodeWith(stderr: string): Promise<{ fake: FakeRunner; result: unknown }> {
      const fake = createFakeRunner({ stdout: ADDED, stderr });
      const result = await executeSceneOp(
        fake.asRunner,
        'add_node',
        { scenePath: 'main.tscn' },
        '/proj',
        TEST_FAILURE_PREFIX,
        EMPTY_SOLUTIONS,
        EXCEPTION_SOLUTIONS,
        { parseStdoutAsJson: true, mutatesSceneFile: true },
      );
      return { fake, result };
    }

    it('when DEBUG=true echoes a parameter that holds the marker text', async () => {
      // What log_debug writes to stderr for add_node with a Label text of
      // "[IMPORT_NEEDED] soon": the marker text, quoted, on a line of its own kind.
      const { fake, result } = await addNodeWith(
        '[INFO] Operation: add_node\n[DEBUG] Params JSON: {"scene_path":"main.tscn","properties":{"text":"[IMPORT_NEEDED] soon"}}\n',
      );
      expect(fake.importCalls).toEqual([]);
      expect(fake.calls).toHaveLength(1);
      expect(hasError(result)).toBe(false);
      expect(unwrap(result).structuredContent).toEqual(JSON.parse(ADDED));
    });

    it('when a script in the project prints a marker line of its own', async () => {
      const { fake, result } = await addNodeWith('[IMPORT_NEEDED] autoload: res://x.png\n');
      expect(fake.importCalls).toEqual([]);
      expect(fake.calls).toHaveLength(1);
      expect(hasError(result)).toBe(false);
    });
  });

  it('does not treat the marker text quoted mid-line as a request for an import', async () => {
    const fake = createFakeRunner({
      stdout: '',
      stderr:
        '[DEBUG] Params JSON: {"node_name":"[IMPORT_NEEDED] x"}\n[ERROR] Parent node not found: root/X\n',
    });
    const result = await executeSceneOp(
      fake.asRunner,
      'add_node',
      { scenePath: 'main.tscn' },
      '/proj',
      TEST_FAILURE_PREFIX,
      EMPTY_SOLUTIONS,
      EXCEPTION_SOLUTIONS,
      { parseStdoutAsJson: true },
    );
    expect(fake.importCalls).toEqual([]);
    expect(fake.calls).toHaveLength(1);
    expectErrorMatching(result, /Parent node not found: root\/X/);
  });

  it('recognizes the marker in the form the script prints it, behind its [ERROR] prefix', async () => {
    const fake = createFakeRunner({
      responses: [
        {
          stdout: '',
          stderr:
            '[INFO] Operation: get_scene_tree\n[ERROR] [IMPORT_NEEDED] main.tscn: res://assets/tex.png\n',
        },
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

/** The result token of the captured run, which wrote no result line. */
const CAPTURED_RUN_RESULT_TOKEN = '0123456789abcdef0123456789abcdef';

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
      stdout: cleanStdout(CAPTURED_DEBUG_EARLY_EXIT_STDOUT, CAPTURED_RUN_RESULT_TOKEN),
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

  // A project whose autoload prints to stdout sends every failed operation
  // down the no-payload path. The operation's own reason is on stderr behind
  // the engine's exit-time lines, and those used to be all that was shown.
  it("leads with the operation's own reason when engine diagnostics are also on stderr", async () => {
    const fake = createFakeRunner({
      stdout: '[Audio] ready',
      stderr: [
        '[INFO] Operation: add_node',
        '[ERROR] Parent node not found: root/X',
        'ERROR: 1 resources still in use at exit.',
        '   at: clear (core/io/resource.cpp:1)',
      ].join('\n'),
    });
    const result = await executeSceneOp(
      fake.asRunner,
      'add_node',
      {},
      '/p',
      TEST_FAILURE_PREFIX,
      EMPTY_SOLUTIONS,
      EXCEPTION_SOLUTIONS,
      { parseStdoutAsJson: true },
    );
    const message = unwrap(result).content[0]?.text ?? '';
    expect(message).toContain('no JSON payload was emitted');
    expect(message).toContain('reason: Parent node not found: root/X');
    // The engine line and the project's stdout are still shown, after it.
    expect(message.indexOf('Parent node not found')).toBeLessThan(
      message.indexOf('resources still in use'),
    );
    expect(message).toContain('[Audio] ready');
    const solutions = unwrap(result).content[1]?.text ?? '';
    expect(solutions).not.toMatch(/Check get_debug_output/);
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

describe('executeSceneOp scene loss guard', () => {
  const tmp = useTmpDirs();
  const SCENE = 'main.tscn';
  const SCENE_BEFORE = [
    '[gd_scene load_steps=2 format=3]',
    '',
    '[ext_resource type="Script" path="res://main.gd" id="1_abc"]',
    '',
    '[node name="Main" type="Node2D"]',
    'script = ExtResource("1_abc")',
    'speed = 9.0',
    '',
  ].join('\n');
  const SCENE_HEALTHY = SCENE_BEFORE + '\n[node name="Added" type="Node2D" parent="."]\n';
  const SCENE_LOSSY = [
    '[gd_scene format=3]',
    '',
    '[node name="Main" type="Node2D"]',
    '',
    '[node name="Added" type="Node2D" parent="."]',
    '',
  ].join('\n');
  const ADD_NODE_STDOUT = '{"nodeName":"Added","nodePath":"root/Added","nodeType":"Node2D"}';

  /**
   * A project holding SCENE, and a fake runner whose every executeOperation
   * call writes the next entry of `sceneTexts` to it before answering, the way
   * a headless save does.
   */
  function projectWithSavingRunner(
    sceneTexts: string[],
    options: Parameters<typeof createFakeRunner>[0] = { stdout: ADD_NODE_STDOUT },
  ): { projectPath: string; fake: FakeRunner } {
    const projectPath = tmp.makeProject('loss-guard-');
    writeFileSync(join(projectPath, SCENE), SCENE_BEFORE, 'utf8');
    const fake = createFakeRunner(options);
    const runner = fake.asRunner;
    const answer = runner.executeOperation.bind(runner);
    let call = 0;
    runner.executeOperation = async (...args: Parameters<GodotRunner['executeOperation']>) => {
      const text = sceneTexts[call++];
      if (text !== undefined) writeFileSync(join(projectPath, SCENE), text, 'utf8');
      return answer(...args);
    };
    return { projectPath, fake };
  }

  function addNode(fake: FakeRunner, projectPath: string): ReturnType<typeof executeSceneOp> {
    return executeSceneOp(
      fake.asRunner,
      'add_node',
      { scenePath: SCENE },
      projectPath,
      TEST_FAILURE_PREFIX,
      EMPTY_SOLUTIONS,
      EXCEPTION_SOLUTIONS,
      { parseStdoutAsJson: true, mutatesSceneFile: true, sceneWrites: inPlaceSceneWrite(SCENE) },
    );
  }

  it('leads the payload with the loss and keeps the pre-save file', async () => {
    const { projectPath, fake } = projectWithSavingRunner([SCENE_LOSSY]);
    const result = await addNode(fake, projectPath);

    expect(hasError(result)).toBe(false);
    const payload = unwrap(result).structuredContent as Record<string, unknown>;
    expect(Object.keys(payload)[0]).toBe('warnings');
    expect(payload.nodeName).toBe('Added');
    const warnings = payload.warnings as string[];
    expect(warnings[0]).toMatch(/^Saved main\.tscn, but the file lost content/);
    expect(warnings).toContain('"root" lost its script res://main.gd');
    expect(warnings).toContain('"root" lost stored values of res://main.gd: speed');

    const backup = /\.mcp\/godot-runtime\/scene-backups\/[^/]+\/main\.tscn/.exec(warnings[0] ?? '');
    expect(backup).not.toBeNull();
    expect(readFileSync(join(projectPath, ...backup![0].split('/')), 'utf8')).toBe(SCENE_BEFORE);
    expect(existsSync(join(projectPath, '.mcp', '.gdignore'))).toBe(true);
    // The text block carries the same payload.
    expect(JSON.parse(unwrap(result).content[0]?.text ?? '')).toEqual(payload);
  });

  it('puts the loss ahead of the warnings the operation reported itself', async () => {
    const { projectPath, fake } = projectWithSavingRunner([SCENE_LOSSY], {
      stdout: '{"nodeName":"Added","warnings":["renamed"]}',
    });
    const payload = unwrap(await addNode(fake, projectPath)).structuredContent as {
      warnings: string[];
    };
    expect(payload.warnings[0]).toMatch(/scene-backups/);
    expect(payload.warnings[payload.warnings.length - 1]).toBe('renamed');
  });

  it('adds nothing and writes no backup when the save lost nothing', async () => {
    const { projectPath, fake } = projectWithSavingRunner([SCENE_HEALTHY]);
    const result = await addNode(fake, projectPath);

    expect(unwrap(result).structuredContent).toEqual(JSON.parse(ADD_NODE_STDOUT));
    expect(existsSync(sceneBackupsDir(projectPath))).toBe(false);
    expect(existsSync(join(projectPath, '.mcp'))).toBe(false);
  });

  it('compares against the file as it was before the first attempt when the import retry runs', async () => {
    // The first attempt writes a lossy file and asks for an import; the retry
    // writes the same lossy file again. Measured against the first attempt's
    // output the retry would look clean.
    const { projectPath, fake } = projectWithSavingRunner([SCENE_LOSSY, SCENE_LOSSY], {
      responses: [
        { stdout: '', stderr: '[ERROR] [IMPORT_NEEDED] res://x.png' },
        { stdout: ADD_NODE_STDOUT },
      ],
    });
    const result = await addNode(fake, projectPath);

    expect(fake.calls).toHaveLength(2);
    const payload = unwrap(result).structuredContent as { warnings: string[] };
    expect(payload.warnings[0]).toMatch(/scene-backups/);
    const backup = /\.mcp\/godot-runtime\/scene-backups\/[^/]+\/main\.tscn/.exec(
      payload.warnings[0]!,
    );
    expect(readFileSync(join(projectPath, ...backup![0].split('/')), 'utf8')).toBe(SCENE_BEFORE);
  });

  it('still reports the loss when the operation itself failed after writing', async () => {
    const { projectPath, fake } = projectWithSavingRunner([SCENE_LOSSY], {
      stdout: '',
      stderr: '[ERROR] something went wrong after the save',
    });
    const result = await addNode(fake, projectPath);

    expectErrorMatching(result, /something went wrong after the save/);
    const blocks = unwrap(result).content.map((block) => block.text ?? '');
    expect(blocks[blocks.length - 1]).toMatch(/scene-backups/);
  });

  it('reads the scripts the engine failed to load from stderr', async () => {
    // The script line survives (as it does on 4.5), only its value is gone.
    const keptScript = SCENE_BEFORE.replace('speed = 9.0\n', '');
    const { projectPath, fake } = projectWithSavingRunner([keptScript], {
      stdout: ADD_NODE_STDOUT,
      stderr: 'ERROR: Failed to load script "res://main.gd" with error "Parse error".',
    });
    const payload = unwrap(await addNode(fake, projectPath)).structuredContent as {
      warnings: string[];
    };
    expect(payload.warnings).toContain('"root" lost stored values of res://main.gd: speed');
  });

  it('does not guard a scene path that escapes the project', async () => {
    const { projectPath, fake } = projectWithSavingRunner([SCENE_LOSSY]);
    const result = await executeSceneOp(
      fake.asRunner,
      'add_node',
      { scenePath: SCENE },
      projectPath,
      TEST_FAILURE_PREFIX,
      EMPTY_SOLUTIONS,
      EXCEPTION_SOLUTIONS,
      {
        parseStdoutAsJson: true,
        mutatesSceneFile: true,
        sceneWrites: inPlaceSceneWrite('../outside.tscn'),
      },
    );
    expect(unwrap(result).structuredContent).toEqual(JSON.parse(ADD_NODE_STDOUT));
  });
});

describe('executeSceneOp engine-newer-than-project warning', () => {
  const tmp = useTmpDirs();
  const SCENE = 'main.tscn';
  const PROJECT_AT_4_5 =
    'config_version=5\n\n[application]\n\nconfig/features=PackedStringArray("4.5", "GL Compatibility")\n';
  const VERSION_WARNING =
    "Godot 4.6 is newer than this project's config/features version 4.5: this save may write scene-file format the project's engine predates (4.6 adds unique_id to every node, for example). Said once per project in this server session; check_project reports it on every call.";
  const NEWER_ENGINE = '4.6.2.stable';
  const MUTATION = {
    parseStdoutAsJson: true,
    mutatesSceneFile: true,
    sceneWrites: inPlaceSceneWrite(SCENE),
  };

  /** Counts every save any runner of this suite made, so no two write the same bytes. */
  let saveCount = 0;

  /**
   * A fake runner whose every executeOperation call saves SCENE into the
   * project it was called for, with new content each time, the way a headless
   * save does. With `saves` false it leaves the project alone.
   */
  function savingRunner(options: Parameters<typeof createFakeRunner>[0], saves = true): FakeRunner {
    const fake = createFakeRunner(options);
    const runner = fake.asRunner;
    const answer = runner.executeOperation.bind(runner);
    runner.executeOperation = async (...args: Parameters<GodotRunner['executeOperation']>) => {
      if (saves) {
        const text = `[gd_scene format=3]\n\n[node name="Main${saveCount++}" type="Node2D"]\n`;
        writeFileSync(join(args[2], SCENE), text, 'utf8');
      }
      return answer(...args);
    };
    return fake;
  }

  function op(
    fake: FakeRunner,
    projectPath: string,
    options: Parameters<typeof executeSceneOp>[7] = MUTATION,
  ): ReturnType<typeof executeSceneOp> {
    return executeSceneOp(
      fake.asRunner,
      'add_node',
      { scenePath: SCENE },
      projectPath,
      TEST_FAILURE_PREFIX,
      EMPTY_SOLUTIONS,
      EXCEPTION_SOLUTIONS,
      options,
    );
  }

  function run(
    godotVersion: string,
    stdout: string,
    options: Parameters<typeof executeSceneOp>[7] = MUTATION,
    projectContent = PROJECT_AT_4_5,
  ): ReturnType<typeof executeSceneOp> {
    const projectPath = tmp.makeProject('engine-newer-', projectContent);
    return op(savingRunner({ stdout, godotVersion }), projectPath, options);
  }

  it('leads a mutation payload with the warning when the engine is newer', async () => {
    const result = await run('4.6.2.stable.official.71f334935', '{"nodeName":"N"}');
    const payload = unwrap(result).structuredContent as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual(['warnings', 'nodeName']);
    expect(payload.warnings).toEqual([VERSION_WARNING]);
  });

  it("puts it ahead of the operation's own warnings", async () => {
    const result = await run(NEWER_ENGINE, '{"nodeName":"N","warnings":["renamed"]}');
    const payload = unwrap(result).structuredContent as { warnings: string[] };
    expect(payload.warnings).toEqual([VERSION_WARNING, 'renamed']);
  });

  it('adds nothing when the engine matches the project', async () => {
    const result = await run('4.5.1.stable', '{"nodeName":"N"}');
    expect(unwrap(result).structuredContent).toEqual({ nodeName: 'N' });
  });

  it('adds nothing when the project states no version', async () => {
    const result = await run(NEWER_ENGINE, '{"nodeName":"N"}', MUTATION, 'config_version=5\n');
    expect(unwrap(result).structuredContent).toEqual({ nodeName: 'N' });
  });

  it('adds nothing to an operation that does not mutate a scene file', async () => {
    const result = await run(NEWER_ENGINE, '{"name":"Main"}', { parseStdoutAsJson: true });
    expect(unwrap(result).structuredContent).toEqual({ name: 'Main' });
  });

  it('adds nothing to an operation that writes a file that is not a scene', async () => {
    // export_mesh_library: it mutates the project and names no sceneWrites.
    const result = await run(NEWER_ENGINE, '{"outputPath":"lib.res"}', {
      parseStdoutAsJson: true,
      mutatesSceneFile: true,
    });
    expect(unwrap(result).structuredContent).toEqual({ outputPath: 'lib.res' });
  });

  it('adds nothing to an error response', async () => {
    const result = await run(NEWER_ENGINE, '');
    expect(hasError(result)).toBe(true);
    expect(
      unwrap(result)
        .content.map((block) => block.text ?? '')
        .join('\n'),
    ).not.toContain('config/features');
  });

  it('says it once per project for the life of a runner, whichever way the path is spelled', async () => {
    const projectPath = tmp.makeProject('engine-newer-', PROJECT_AT_4_5);
    const fake = savingRunner({ stdout: '{"nodeName":"N"}', godotVersion: NEWER_ENGINE });

    const first = unwrap(await op(fake, projectPath)).structuredContent;
    expect(first).toEqual({ warnings: [VERSION_WARNING], nodeName: 'N' });
    const second = unwrap(await op(fake, projectPath)).structuredContent;
    expect(second).toEqual({ nodeName: 'N' });
    const respelled = unwrap(await op(fake, `${projectPath}/./`)).structuredContent;
    expect(respelled).toEqual({ nodeName: 'N' });
  });

  it('says it again for another project and for another server session', async () => {
    const options = { stdout: '{"nodeName":"N"}', godotVersion: NEWER_ENGINE };
    const projectA = tmp.makeProject('engine-newer-', PROJECT_AT_4_5);
    const projectB = tmp.makeProject('engine-newer-', PROJECT_AT_4_5);
    const fake = savingRunner(options);
    const noted = { warnings: [VERSION_WARNING], nodeName: 'N' };
    expect(unwrap(await op(fake, projectA)).structuredContent).toEqual(noted);
    expect(unwrap(await op(fake, projectB)).structuredContent).toEqual(noted);
    expect(unwrap(await op(savingRunner(options), projectA)).structuredContent).toEqual(noted);
  });

  it('adds nothing to a call that left the scene file as it was, and still says it on the first save', async () => {
    const projectPath = tmp.makeProject('engine-newer-', PROJECT_AT_4_5);
    writeFileSync(join(projectPath, SCENE), '[gd_scene format=3]\n', 'utf8');
    const options = {
      stdout: '{"results":[{"nodePath":"root/X","error":"not found"}]}',
      godotVersion: NEWER_ENGINE,
    };
    // Every update failed: nothing was saved, so there is no save to describe.
    const idle = savingRunner(options, false);
    const payload = unwrap(await op(idle, projectPath)).structuredContent as Record<
      string,
      unknown
    >;
    expect(payload.warnings).toBeUndefined();

    // The note was not spent on the call that wrote nothing.
    const runner = idle.asRunner;
    const answer = runner.executeOperation.bind(runner);
    runner.executeOperation = async (...args: Parameters<GodotRunner['executeOperation']>) => {
      writeFileSync(
        join(projectPath, SCENE),
        '[gd_scene format=3]\n\n[node name="M" type="Node"]\n',
        'utf8',
      );
      return answer(...args);
    };
    const saved = unwrap(await op(idle, projectPath)).structuredContent as { warnings: string[] };
    expect(saved.warnings).toEqual([VERSION_WARNING]);
  });

  it('comes after a dropped-content warning', async () => {
    const projectPath = tmp.makeProject('engine-newer-', PROJECT_AT_4_5);
    const scenePath = join(projectPath, SCENE);
    writeFileSync(
      scenePath,
      '[gd_scene format=3 uid="uid://before"]\n\n[node name="Main" type="Node2D"]\n',
      'utf8',
    );
    const fake = createFakeRunner({ stdout: '{"nodeName":"N"}', godotVersion: NEWER_ENGINE });
    const runner = fake.asRunner;
    const answer = runner.executeOperation.bind(runner);
    runner.executeOperation = async (...args: Parameters<GodotRunner['executeOperation']>) => {
      writeFileSync(scenePath, '[gd_scene format=3]\n\n[node name="Main" type="Node2D"]\n', 'utf8');
      return answer(...args);
    };
    const payload = unwrap(await op(fake, projectPath)).structuredContent as {
      warnings: string[];
    };
    expect(payload.warnings).toHaveLength(3);
    expect(payload.warnings[0]).toMatch(/scene-backups/);
    expect(payload.warnings[1]).toBe('The scene lost its uid uid://before');
    expect(payload.warnings[2]).toBe(VERSION_WARNING);
  });
});

describe('executeSceneOp scene loss guard: what it is told and what it says', () => {
  const tmp = useTmpDirs();
  const ADD_NODE_STDOUT = '{"nodeName":"Added"}';
  const SCRIPTED = [
    '[gd_scene load_steps=2 format=3]',
    '',
    '[ext_resource type="Script" path="res://main.gd" id="1_abc"]',
    '',
    '[node name="Main" type="Node2D"]',
    'script = ExtResource("1_abc")',
    'speed = 9.0',
    '',
  ].join('\n');

  /** A runner that writes `files[n]` (path -> content) into the project on its nth call. */
  function writingRunner(
    projectPath: string,
    files: Array<Record<string, string | Buffer>>,
    options: Parameters<typeof createFakeRunner>[0] = { stdout: ADD_NODE_STDOUT },
  ): FakeRunner {
    const fake = createFakeRunner(options);
    const runner = fake.asRunner;
    const answer = runner.executeOperation.bind(runner);
    let call = 0;
    runner.executeOperation = async (...args: Parameters<GodotRunner['executeOperation']>) => {
      for (const [name, content] of Object.entries(files[call++] ?? {})) {
        writeFileSync(join(projectPath, name), content);
      }
      return answer(...args);
    };
    return fake;
  }

  function guarded(
    fake: FakeRunner,
    projectPath: string,
    sceneWrites: SceneWriteIntent[],
    extra: Partial<NonNullable<Parameters<typeof executeSceneOp>[7]>> = {},
  ): ReturnType<typeof executeSceneOp> {
    return executeSceneOp(
      fake.asRunner,
      'add_node',
      {},
      projectPath,
      TEST_FAILURE_PREFIX,
      EMPTY_SOLUTIONS,
      EXCEPTION_SOLUTIONS,
      { parseStdoutAsJson: true, mutatesSceneFile: true, sceneWrites, ...extra },
    );
  }

  it('takes the failed scripts from the attempt that saved, not from the cold first attempt', async () => {
    const projectPath = tmp.makeProject('loss-guard-');
    writeFileSync(join(projectPath, 'main.tscn'), SCRIPTED, 'utf8');
    // A value equal to its default is not written back. With the script
    // counted as failed that would read as a loss.
    const saved =
      SCRIPTED.replace('speed = 9.0\n', '') + '\n[node name="N" type="Node" parent="."]\n';
    const fake = writingRunner(projectPath, [{}, { 'main.tscn': saved }], {
      responses: [
        {
          stdout: '',
          stderr:
            'ERROR: Failed to load script "res://main.gd" with error "Parse error".\n[ERROR] [IMPORT_NEEDED] res://x.png',
        },
        { stdout: ADD_NODE_STDOUT },
      ],
    });
    const result = await guarded(fake, projectPath, inPlaceSceneWrite('main.tscn'));
    expect(fake.calls).toHaveLength(2);
    expect(unwrap(result).structuredContent).toEqual(JSON.parse(ADD_NODE_STDOUT));
  });

  it('says a binary scene was saved unchecked, once, and writes no backup', async () => {
    const projectPath = tmp.makeProject('loss-guard-');
    writeFileSync(join(projectPath, 'level.scn'), Buffer.from('RSRC\u0000before'));
    const fake = writingRunner(projectPath, [{ 'level.scn': Buffer.from('RSRC\u0000after') }]);
    const payload = unwrap(await guarded(fake, projectPath, inPlaceSceneWrite('level.scn')))
      .structuredContent as { warnings: string[] };
    expect(payload.warnings).toEqual([
      'Saved level.scn, but the save was not checked for lost content: the file as it was before the save is not a text scene (a binary scene, or text with no [gd_scene] header). Said once per file in this server session.',
    ]);
    expect(existsSync(sceneBackupsDir(projectPath))).toBe(false);
  });

  it('says a binary scene was saved unchecked once per file per runner, not on every save', async () => {
    const projectPath = tmp.makeProject('loss-guard-');
    for (const name of ['level.scn', 'other.scn']) {
      writeFileSync(join(projectPath, name), Buffer.from('RSRC\u00000'));
    }
    const fake = writingRunner(projectPath, [
      { 'level.scn': Buffer.from('RSRC\u00001') },
      { 'level.scn': Buffer.from('RSRC\u00002') },
      { 'other.scn': Buffer.from('RSRC\u00003') },
    ]);
    const warningsOf = async (scene: string): Promise<string[] | undefined> =>
      (
        unwrap(await guarded(fake, projectPath, inPlaceSceneWrite(scene))).structuredContent as {
          warnings?: string[];
        }
      ).warnings;

    expect(await warningsOf('level.scn')).toHaveLength(1);
    // The second save of the same file, spelled another way, says nothing.
    expect(await warningsOf('./level.scn')).toBeUndefined();
    expect((await warningsOf('other.scn'))?.[0]).toMatch(/^Saved other\.scn, but the save was not/);

    // Another runner is another server session and says it again.
    const second = writingRunner(projectPath, [{ 'level.scn': Buffer.from('RSRC\u00004') }]);
    const again = unwrap(await guarded(second, projectPath, inPlaceSceneWrite('level.scn')))
      .structuredContent as { warnings?: string[] };
    expect(again.warnings).toHaveLength(1);
  });

  it('takes a deleted %Name from the path the operation reports, not from every node of that name', async () => {
    // Two nodes are called Enemy and neither section stores the unique flag
    // (it lives in the instanced scene). The operation deleted Squad/Enemy;
    // the save also lost Reserve/Enemy, which nobody asked for.
    const before = [
      '[gd_scene format=3]',
      '',
      '[node name="Main" type="Node2D"]',
      '',
      '[node name="Squad" type="Node2D" parent="."]',
      '',
      '[node name="Enemy" type="Node2D" parent="Squad"]',
      '',
      '[node name="Reserve" type="Node2D" parent="."]',
      '',
      '[node name="Enemy" type="Node2D" parent="Reserve"]',
      '',
    ].join('\n');
    const after = before
      .replace('[node name="Enemy" type="Node2D" parent="Squad"]\n\n', '')
      .replace('[node name="Enemy" type="Node2D" parent="Reserve"]\n', '');
    const projectPath = tmp.makeProject('loss-guard-');
    writeFileSync(join(projectPath, 'main.tscn'), before, 'utf8');
    const fake = writingRunner(projectPath, [{ 'main.tscn': after }], {
      stdout: JSON.stringify({
        results: [{ nodePath: '%Enemy', resolvedNodePath: 'root/Squad/Enemy', success: true }],
      }),
    });
    const payload = unwrap(
      await guarded(
        fake,
        projectPath,
        inPlaceSceneWrite('main.tscn', { deletedNodes: ['%Enemy'] }),
      ),
    ).structuredContent as { warnings: string[] };
    expect(payload.warnings).toHaveLength(2);
    expect(payload.warnings[0]).toMatch(/lost content this operation did not ask to change/);
    expect(payload.warnings[1]).toBe('Node "root/Reserve/Enemy" is no longer in the file');
  });

  it('says nothing about a binary scene the operation did not write', async () => {
    const projectPath = tmp.makeProject('loss-guard-');
    writeFileSync(join(projectPath, 'level.scn'), Buffer.from('RSRC\u0000before'));
    const fake = writingRunner(projectPath, [{}]);
    const result = await guarded(fake, projectPath, inPlaceSceneWrite('level.scn'));
    expect(unwrap(result).structuredContent).toEqual(JSON.parse(ADD_NODE_STDOUT));
  });

  it('does not compare a file the operation set out to replace', async () => {
    // create_scene over an existing path: everything the old file held is gone
    // by request.
    const projectPath = tmp.makeProject('loss-guard-');
    writeFileSync(join(projectPath, 'main.tscn'), SCRIPTED, 'utf8');
    const fresh = '[gd_scene format=3]\n\n[node name="Fresh" type="Node3D"]\n';
    const fake = writingRunner(projectPath, [{ 'main.tscn': fresh }]);
    const result = await guarded(
      fake,
      projectPath,
      inPlaceSceneWrite('main.tscn', { replacesFile: true }),
    );
    expect(unwrap(result).structuredContent).toEqual(JSON.parse(ADD_NODE_STDOUT));
    expect(existsSync(sceneBackupsDir(projectPath))).toBe(false);
  });

  it('guards a scene that starts with a byte order mark', async () => {
    const projectPath = tmp.makeProject('loss-guard-');
    writeFileSync(join(projectPath, 'main.tscn'), `﻿${SCRIPTED}`, 'utf8');
    const lossy = '[gd_scene format=3]\n\n[node name="Main" type="Node2D"]\n';
    const fake = writingRunner(projectPath, [{ 'main.tscn': lossy }]);
    const payload = unwrap(await guarded(fake, projectPath, inPlaceSceneWrite('main.tscn')))
      .structuredContent as { warnings: string[] };
    expect(payload.warnings).toContain('"root" lost its script res://main.gd');
  });

  it('treats two spellings of one file as one file: one warning, one backup', async () => {
    const projectPath = tmp.makeProject('loss-guard-');
    writeFileSync(join(projectPath, 'main.tscn'), SCRIPTED, 'utf8');
    const lossy = '[gd_scene format=3]\n\n[node name="Main" type="Node2D"]\n';
    const fake = writingRunner(projectPath, [{ 'main.tscn': lossy }]);
    const operations = [
      { operation: 'add_node', scenePath: 'main.tscn', nodeType: 'Node', nodeName: 'A' },
      { operation: 'add_node', scenePath: './main.tscn', nodeType: 'Node', nodeName: 'B' },
      { operation: 'add_node', scenePath: 'res://main.tscn', nodeType: 'Node', nodeName: 'C' },
    ];
    const payload = unwrap(
      await guarded(fake, projectPath, batchSceneWrites(operations, projectPath)),
    ).structuredContent as { warnings: string[] };
    expect(payload.warnings.filter((line) => line.startsWith('Saved '))).toHaveLength(1);
    expect(readdirSync(sceneBackupsDir(projectPath))).toHaveLength(1);
  });

  // Two names that differ only in case are one file where the file system
  // folds case, and two files where it does not (`fileIdentityKey`).
  it.runIf(process.platform === 'win32' || process.platform === 'darwin')(
    'treats a spelling in another case as the same file on a case-insensitive platform',
    async () => {
      const projectPath = tmp.makeProject('loss-guard-');
      writeFileSync(join(projectPath, 'main.tscn'), SCRIPTED, 'utf8');
      const lossy = '[gd_scene format=3]\n\n[node name="Main" type="Node2D"]\n';
      const fake = writingRunner(projectPath, [{ 'main.tscn': lossy }]);
      const operations = [
        { operation: 'add_node', scenePath: 'main.tscn', nodeType: 'Node', nodeName: 'A' },
        { operation: 'add_node', scenePath: 'Main.tscn', nodeType: 'Node', nodeName: 'B' },
      ];
      const payload = unwrap(
        await guarded(fake, projectPath, batchSceneWrites(operations, projectPath)),
      ).structuredContent as { warnings: string[] };
      expect(payload.warnings.filter((line) => line.startsWith('Saved '))).toHaveLength(1);
      expect(readdirSync(sceneBackupsDir(projectPath))).toHaveLength(1);
    },
  );

  const TEXTURED = [
    '[gd_scene load_steps=3 format=3]',
    '',
    '[ext_resource type="Texture2D" path="res://a.png" id="1_a"]',
    '',
    '[node name="Main" type="Node2D"]',
    '',
    '[node name="Icon" type="Sprite2D" parent="."]',
    'texture = ExtResource("1_a")',
    '',
  ].join('\n');
  const RETEXTURED = TEXTURED.replace('res://a.png', 'res://b.png');
  const SAVE_AS_THEN_EDIT = [
    { operation: 'save', scenePath: 'a.tscn', newPath: 'copy.tscn' },
    {
      operation: 'set_node_properties',
      scenePath: 'copy.tscn',
      updates: [{ nodePath: 'root/Icon', property: 'texture', value: 'res://b.png' }],
    },
  ];

  it('accepts an edit made on a save-as copy after the save-as', async () => {
    const projectPath = tmp.makeProject('loss-guard-');
    writeFileSync(join(projectPath, 'a.tscn'), TEXTURED, 'utf8');
    const fake = writingRunner(projectPath, [{ 'copy.tscn': RETEXTURED }], {
      stdout: '{"results":[{"success":true},{"success":true}]}',
    });
    const result = await guarded(
      fake,
      projectPath,
      batchSceneWrites(SAVE_AS_THEN_EDIT, projectPath),
    );
    expect((unwrap(result).structuredContent as Record<string, unknown>).warnings).toBeUndefined();
    expect(existsSync(sceneBackupsDir(projectPath))).toBe(false);
  });

  it('judges the target against itself when the payload says the save-as failed', async () => {
    // copy.tscn already existed and the save-as did not replace it, so the
    // later edit acted on the old copy: its baseline is the old copy, not a.
    const projectPath = tmp.makeProject('loss-guard-');
    writeFileSync(join(projectPath, 'a.tscn'), SCRIPTED, 'utf8');
    writeFileSync(join(projectPath, 'copy.tscn'), TEXTURED, 'utf8');
    const fake = writingRunner(projectPath, [{ 'copy.tscn': RETEXTURED }], {
      stdout: '{"results":[{"error":"Failed to save scene"},{"success":true}]}',
    });
    const result = await guarded(
      fake,
      projectPath,
      batchSceneWrites(SAVE_AS_THEN_EDIT, projectPath),
      {
        refineSceneWrites: (payload) =>
          batchSceneWrites(SAVE_AS_THEN_EDIT, projectPath, payload.results),
      },
    );
    expect((unwrap(result).structuredContent as Record<string, unknown>).warnings).toBeUndefined();
  });
});

describe('executeSceneOp refusal and recovery wording', () => {
  function liveRunner(options: Parameters<typeof createFakeRunner>[0]): FakeRunner {
    const fake = createFakeRunner(options);
    const runner = fake.asRunner as GodotRunner & {
      activeSessionMode: 'spawned' | 'attached' | null;
      activeProjectPath: string | null;
      activeProcess: { hasExited: boolean } | null;
    };
    runner.activeSessionMode = 'spawned';
    runner.activeProjectPath = '/proj';
    runner.activeProcess = { hasExited: false };
    return fake;
  }

  it('refuses a read that needs an import during a live session in the words of a read', async () => {
    const fake = liveRunner({
      stdout: '',
      stderr: '[ERROR] [IMPORT_NEEDED] main.tscn: res://assets/tex.png',
    });
    const result = await executeSceneOp(
      fake.asRunner,
      'get_scene_tree',
      { scenePath: 'main.tscn' },
      '/proj',
      TEST_FAILURE_PREFIX,
      EMPTY_SOLUTIONS,
      EXCEPTION_SOLUTIONS,
      { parseStdoutAsJson: true },
    );
    expect(fake.importCalls).toEqual([]);
    const text = unwrap(result)
      .content.map((block) => block.text ?? '')
      .join('\n');
    expect(text).toMatch(/A Godot runtime session is active on this project/);
    expect(text).toMatch(/This read changes nothing in the scene/);
    expect(text).toMatch(/then retry the scene read/);
    expect(text).not.toMatch(/editing scene files|scene edit|headless edit/);
  });

  it('keeps the edit wording for a mutation', async () => {
    const fake = liveRunner({ stdout: '{"ok":true}' });
    const result = await executeSceneOp(
      fake.asRunner,
      'add_node',
      { scenePath: 'main.tscn' },
      '/proj',
      TEST_FAILURE_PREFIX,
      EMPTY_SOLUTIONS,
      EXCEPTION_SOLUTIONS,
      { parseStdoutAsJson: true, mutatesSceneFile: true },
    );
    const text = unwrap(result)
      .content.map((block) => block.text ?? '')
      .join('\n');
    expect(text).toMatch(/Stop the session before editing scene files/);
    expect(text).toMatch(/then retry the scene edit/);
  });

  it('tells a partial batch how the missing asset gets imported', async () => {
    const partialBatch = JSON.stringify({
      results: [
        { operation: 'add_node', success: true },
        { operation: 'load_sprite', error: 'x' },
      ],
    });
    const fake = createFakeRunner({
      stdout: partialBatch,
      stderr: '[IMPORT_NEEDED] load_sprite: res://assets/tex.png',
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
    const text = unwrap(result)
      .content.map((block) => block.text ?? '')
      .join('\n');
    expect(text).toContain(
      'The next headless call on the affected scene (get_scene_tree, for example) imports the missing asset before it runs',
    );
    expect(text).not.toContain('once the asset is imported will do');
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
