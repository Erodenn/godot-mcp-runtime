/**
 * What the runner observes of the processes it starts: output decoded across
 * pipe chunk boundaries, a timed-out headless run killed as a tree and its
 * exit confirmed before the timeout is reported, headless children killed by
 * the exit hook, and the parent-watch port handed to spawned games only.
 *
 * `child_process.spawn` is mocked at the I/O boundary, as in the session
 * lifecycle tests, so the runner's real bodies run without a Godot binary.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as net from 'net';
import type * as childProcess from 'child_process';
import { PARENT_WATCH_PORT_ENV } from '../../src/utils/bridge-protocol.js';
import {
  extractOperationPayload,
  OPERATION_RESULT_SENTINEL,
  OPERATION_RESULT_TOKEN_END,
  OPERATION_RESULT_TOKEN_ENV,
} from '../../src/utils/output-parsing.js';
import { useTmpDirs } from '../helpers/tmp.js';

const spawnMock = vi.fn();
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  return { ...actual, spawn: (...args: unknown[]) => spawnMock(...args) };
});

const { GodotRunner, HEADLESS_SHUTDOWN_WAIT_MS } = await import('../../src/utils/godot-runner.js');
type Runner = InstanceType<typeof GodotRunner>;

const HEADLESS_PID = 51515;
const GAME_PID = 51516;
const GAME_BRIDGE_PORT = 19961;
/** Timeout handed to a headless operation in the timeout cases. */
const OPERATION_TIMEOUT_MS = 25;
/** The runner's own wait for a killed headless child to report `close`. */
const KILL_CONFIRM_WAIT_MS = 3000;
const TASKKILL_STATUS_NOT_FOUND = 128;
const REPLACEMENT_CHARACTER = '�';

interface FakeChild extends EventEmitter {
  pid: number | undefined;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeChild(pid: number | undefined): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  return child;
}

/** Replace the runner's BridgeManager: nothing here touches a project's files. */
function stubBridge(runner: Runner): void {
  (runner as unknown as { bridge: unknown }).bridge = {
    precheckInject: () => '',
    inject: () => {},
    cleanup: () => [],
    repairOrphaned: () => {},
    isBridgeAutoloadRegistered: () => true,
    listOtherLiveOwners: () => [],
  };
}

/** Fake the OS kill calls for a Windows host and record what was killed. */
function fakeTreeKill(
  runner: Runner,
  taskkill: (pid: string) => number = () => 0,
): { taskkillPids: string[] } {
  const taskkillPids: string[] = [];
  (runner as unknown as { killTreeDeps: unknown }).killTreeDeps = {
    platform: 'win32',
    spawnSync: (_command: string, args: string[]) => {
      const pid = args[1] ?? '';
      taskkillPids.push(pid);
      return { status: taskkill(pid) };
    },
    kill: () => {},
  };
  return { taskkillPids };
}

/** Split a buffer inside the first multi-byte sequence it holds. */
function splitInsideFirstMultiByteSequence(bytes: Buffer): [Buffer, Buffer] {
  const lead = bytes.findIndex((byte) => byte >= 0xc0);
  if (lead === -1) throw new Error('the text holds no multi-byte character');
  return [bytes.subarray(0, lead + 1), bytes.subarray(lead + 1)];
}

/** Index of the options object in a `spawn(cmd, args, options)` call. */
const SPAWN_OPTIONS_ARG = 2;

/** The result token the runner put in the environment of its `call`-th spawn. */
function resultTokenOfSpawn(call: number): string {
  const options = spawnMock.mock.calls[call]?.[SPAWN_OPTIONS_ARG] as
    | { env?: Record<string, string | undefined> }
    | undefined;
  const token = options?.env?.[OPERATION_RESULT_TOKEN_ENV];
  if (token === undefined) throw new Error(`spawn ${call} was given no result token`);
  return token;
}

/** A result line as godot_operations.gd writes it for a run holding `token`. */
function resultLine(token: string, payload: string): string {
  return `${OPERATION_RESULT_SENTINEL}${token}${OPERATION_RESULT_TOKEN_END}${payload}\n`;
}

const tmp = useTmpDirs();

describe('headless child output is decoded across chunk boundaries', () => {
  let runner: Runner;
  let child: FakeChild;
  let projectPath: string;

  beforeEach(() => {
    child = makeFakeChild(HEADLESS_PID);
    spawnMock.mockReset();
    spawnMock.mockReturnValue(child);
    runner = new GodotRunner({ godotPath: 'godot' });
    stubBridge(runner);
    projectPath = tmp.makeProject('godot-mcp-headless-');
  });

  it('returns a result payload whose multi-byte character was split across two stdout chunks', async () => {
    const payload = JSON.stringify({ name: 'José', label: '日本語' });

    const pending = runner.executeOperation('get_scene_tree', {}, projectPath);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    const [head, tail] = splitInsideFirstMultiByteSequence(
      Buffer.from(resultLine(resultTokenOfSpawn(0), payload), 'utf8'),
    );
    child.stderr.emit('data', Buffer.from('[INFO] Operation: get_scene_tree\n'));
    child.stdout.emit('data', head);
    child.stdout.emit('data', tail);
    child.emit('close', 0);
    const { stdout } = await pending;

    // The payload still parses when a sequence is decoded per chunk; it is
    // the strings inside it that come out wrong, silently.
    expect(stdout).not.toContain(REPLACEMENT_CHARACTER);
    expect(stdout).toContain(payload);
  });

  it('does the same for stderr', async () => {
    const line = '[INFO] Operation: add_node — nœud ajouté\n';
    const [head, tail] = splitInsideFirstMultiByteSequence(Buffer.from(line, 'utf8'));

    const pending = runner.executeOperation('add_node', {}, projectPath);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    child.stderr.emit('data', head);
    child.stderr.emit('data', tail);
    child.emit('close', 0);
    const { stderr } = await pending;

    expect(stderr).toBe(line);
  });

  it('surfaces the bytes a stream ended in the middle of, instead of dropping them', async () => {
    const [head] = splitInsideFirstMultiByteSequence(Buffer.from('café', 'utf8'));

    const pending = runner.getVersion();
    child.stdout.emit('data', head);
    child.emit('close', 0);

    expect(await pending).toBe(`caf${REPLACEMENT_CHARACTER}`);
  });
});

// A project script can print the sentinel: an autoload's _init before the
// operation is dispatched, its _exit_tree after the result is written. The
// runner tells its own result line by the token it handed that run.
describe('a headless run returns its own result, not a sentinel line a project script printed', () => {
  const REAL_PAYLOAD = JSON.stringify({ name: 'Main', children: [] });
  const FORGED_MARKER = 'forged-by-a-project-script';
  const FORGED_LINE = `${OPERATION_RESULT_SENTINEL}${JSON.stringify({ name: FORGED_MARKER })}\n`;
  const OPERATION_STARTED_LINE = '[INFO] Operation: get_scene_tree\n';

  let runner: Runner;
  let projectPath: string;

  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => makeFakeChild(HEADLESS_PID));
    runner = new GodotRunner({ godotPath: 'godot' });
    stubBridge(runner);
    projectPath = tmp.makeProject('godot-mcp-forged-');
  });

  /** Run one operation whose child writes what `stdoutFor` returns for the run's token. */
  async function runWithStdout(
    stdoutFor: (token: string) => string,
    stderr = OPERATION_STARTED_LINE,
  ): Promise<{ stdout: string; token: string }> {
    const call = spawnMock.mock.calls.length;
    const pending = runner.executeOperation('get_scene_tree', {}, projectPath);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(call + 1));
    const child = spawnMock.mock.results[call]?.value as FakeChild;
    const token = resultTokenOfSpawn(call);
    if (stderr !== '') child.stderr.emit('data', Buffer.from(stderr));
    child.stdout.emit('data', Buffer.from(stdoutFor(token), 'utf8'));
    child.emit('close', 0);
    return { stdout: (await pending).stdout, token };
  }

  it.each([
    ['after the result, as _exit_tree does', (real: string) => `banner\n${real}${FORGED_LINE}`],
    ['before the result, as _init does', (real: string) => `banner\n${FORGED_LINE}${real}`],
    ['on both sides', (real: string) => `${FORGED_LINE}${real}${FORGED_LINE}`],
  ])('when the forged line is printed %s', async (_where, layout) => {
    const { stdout } = await runWithStdout((token) => layout(resultLine(token, REAL_PAYLOAD)));

    expect(extractOperationPayload(stdout)).toBe(REAL_PAYLOAD);
    expect(stdout).not.toContain(FORGED_MARKER);
  });

  it('reports no payload when the only sentinel line is a forged one', async () => {
    const { stdout } = await runWithStdout(() => `banner\n${FORGED_LINE}`);

    expect(extractOperationPayload(stdout)).toBeNull();
    expect(stdout).not.toContain(OPERATION_RESULT_SENTINEL);
  });

  it('does not take a forged line as proof that the operation was dispatched', async () => {
    const pending = runWithStdout(
      () => FORGED_LINE,
      'SCRIPT ERROR: Parse Error: broken autoload\n',
    );

    await expect(pending).rejects.toThrow(/failed before the operation could run/);
  });

  it("does not accept one run's result line in the next run", async () => {
    const first = await runWithStdout((token) => resultLine(token, REAL_PAYLOAD));
    const second = await runWithStdout(() => resultLine(first.token, REAL_PAYLOAD));

    expect(second.token).not.toBe(first.token);
    expect(extractOperationPayload(first.stdout)).toBe(REAL_PAYLOAD);
    expect(extractOperationPayload(second.stdout)).toBeNull();
  });
});

describe('session game output is decoded across chunk boundaries', () => {
  let savedDisplay: string | undefined;

  beforeEach(() => {
    savedDisplay = process.env.DISPLAY;
    if (process.platform === 'linux' && !process.env.DISPLAY) process.env.DISPLAY = ':0';
  });

  afterEach(() => {
    if (savedDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = savedDisplay;
  });

  it('retains a log line whose multi-byte character was split across two chunks, on both streams', async () => {
    const child = makeFakeChild(undefined);
    spawnMock.mockReset();
    spawnMock.mockReturnValue(child);
    const runner = new GodotRunner({ godotPath: 'godot' });
    stubBridge(runner);
    await runner.runProject(tmp.makeProject('godot-mcp-game-'), undefined, false, GAME_BRIDGE_PORT);

    const outLine = 'Joueur prêt\n';
    const errLine = 'SCRIPT ERROR: valeur inattendue « x »\n';
    for (const [stream, line] of [
      [child.stdout, outLine],
      [child.stderr, errLine],
    ] as const) {
      const [head, tail] = splitInsideFirstMultiByteSequence(Buffer.from(line, 'utf8'));
      stream.emit('data', head);
      stream.emit('data', tail);
    }

    expect(runner.activeProcess?.output).toEqual([outLine.trimEnd()]);
    expect(runner.activeProcess?.errors).toEqual([errLine.trimEnd()]);
  });

  it('retains the line a stream ended in the middle of once the stream ends', async () => {
    const child = makeFakeChild(undefined);
    spawnMock.mockReset();
    spawnMock.mockReturnValue(child);
    const runner = new GodotRunner({ godotPath: 'godot' });
    stubBridge(runner);
    await runner.runProject(tmp.makeProject('godot-mcp-game-'), undefined, false, GAME_BRIDGE_PORT);

    child.stderr.emit('data', Buffer.from('first\nlast words, no newline'));
    expect(runner.activeProcess?.errors).toEqual(['first']);
    child.stderr.emit('end');

    expect(runner.activeProcess?.errors).toEqual(['first', 'last words, no newline']);
  });
});

describe('a headless run that times out', () => {
  let runner: Runner;
  let child: FakeChild;
  let projectPath: string;

  beforeEach(() => {
    child = makeFakeChild(HEADLESS_PID);
    spawnMock.mockReset();
    spawnMock.mockReturnValue(child);
    runner = new GodotRunner({ godotPath: 'godot' });
    stubBridge(runner);
    projectPath = tmp.makeProject('godot-mcp-timeout-');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('kills the process tree, not the one pid, and reports the timeout once the exit is confirmed', async () => {
    // The pid may be a wrapper: killing it alone leaves the engine running,
    // free to save the scene after the tool reported a timeout.
    const kills = fakeTreeKill(runner, () => {
      queueMicrotask(() => child.emit('close', null));
      return 0;
    });

    await expect(
      runner.executeOperation('save_scene', {}, projectPath, OPERATION_TIMEOUT_MS),
    ).rejects.toThrow(/timed out after 25ms and was killed; its exit was confirmed/);

    expect(kills.taskkillPids).toEqual([String(HEADLESS_PID)]);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('says the kill was not confirmed, with the pid, when the process never reports its exit', async () => {
    vi.useFakeTimers();
    fakeTreeKill(runner);

    const pending = runner
      .executeOperation('save_scene', {}, projectPath, OPERATION_TIMEOUT_MS)
      .catch((error: unknown) => error as Error);
    await vi.advanceTimersByTimeAsync(OPERATION_TIMEOUT_MS);
    // Not reported yet: the runner is waiting to see the process go.
    await vi.advanceTimersByTimeAsync(KILL_CONFIRM_WAIT_MS - 1);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const error = await pending;

    expect(error.message).toMatch(/timed out after 25ms/);
    expect(error.message).toContain(`pid ${HEADLESS_PID}`);
    expect(error.message).toMatch(/did not report its exit .* may still be running/);
  });

  it('does not wait on a process the operating system reports as already gone', async () => {
    fakeTreeKill(runner, () => TASKKILL_STATUS_NOT_FOUND);
    const started = Date.now();

    await expect(
      runner.executeOperation('save_scene', {}, projectPath, OPERATION_TIMEOUT_MS),
    ).rejects.toThrow(/its exit was confirmed/);

    expect(Date.now() - started).toBeLessThan(KILL_CONFIRM_WAIT_MS);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('a timeout past the largest timer delay does not fire at once', async () => {
    vi.useFakeTimers();
    fakeTreeKill(runner);
    const pastTimerMaximum = 2 ** 40;

    let settled = false;
    const pending = runner
      .executeOperation('save_scene', {}, projectPath, pastTimerMaximum)
      .finally(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(OPERATION_TIMEOUT_MS);
    expect(settled).toBe(false);

    child.stderr.emit('data', Buffer.from('[INFO] Operation: save_scene\n'));
    child.emit('close', 0);
    await expect(pending).resolves.toBeDefined();
  });
});

describe('the exit hook and headless children', () => {
  it('kills a headless child that is still running, and forgets it once it has closed', async () => {
    const child = makeFakeChild(HEADLESS_PID);
    spawnMock.mockReset();
    spawnMock.mockReturnValue(child);
    const runner = new GodotRunner({ godotPath: 'godot' });
    stubBridge(runner);
    const kills = fakeTreeKill(runner);

    const pending = runner.executeOperation('validate', {}, tmp.makeProject('godot-mcp-exit-'));
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));

    runner.killSpawnedProcessesSync();
    expect(kills.taskkillPids).toEqual([String(HEADLESS_PID)]);

    child.stderr.emit('data', Buffer.from('[INFO] Operation: validate\n'));
    child.emit('close', 0);
    await pending;
    runner.killSpawnedProcessesSync();

    // Nothing is left to kill: the list was not grown by the second call.
    expect(kills.taskkillPids).toEqual([String(HEADLESS_PID)]);
  });
});

/** Promise hops between an event or a timer and the answer built on it; generous. */
const MICROTASK_FLUSHES = 50;

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < MICROTASK_FLUSHES; i++) await Promise.resolve();
}

describe('a graceful shutdown and the headless runs in flight', () => {
  let runner: Runner;
  let child: FakeChild;
  let projectPath: string;
  let kills: { taskkillPids: string[] };

  beforeEach(() => {
    child = makeFakeChild(HEADLESS_PID);
    spawnMock.mockReset();
    spawnMock.mockReturnValue(child);
    runner = new GodotRunner({ godotPath: 'godot' });
    stubBridge(runner);
    kills = fakeTreeKill(runner);
    projectPath = tmp.makeProject('godot-mcp-shutdown-');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for a run that closes inside the bound, and nothing is killed', async () => {
    const pending = runner.executeOperation('save_scene', {}, projectPath);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    let waited: boolean | undefined;
    void runner.waitForHeadlessChildren().then((value) => {
      waited = value;
    });
    await flushMicrotasks();
    // Red when the wait resolves without looking at the set.
    expect(waited).toBeUndefined();

    child.stderr.emit('data', Buffer.from('[INFO] Operation: save_scene\n'));
    child.emit('close', 0);
    await pending;
    await flushMicrotasks();

    expect(waited).toBe(true);
    runner.killSpawnedProcessesSync();
    expect(kills.taskkillPids).toEqual([]);
  });

  it('gives up exactly at the bound, kills nothing itself, and leaves the run for the exit hook', async () => {
    vi.useFakeTimers();
    const pending = runner
      .executeOperation('save_scene', {}, projectPath)
      .catch((error: unknown) => error);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    let waited: boolean | undefined;
    void runner.waitForHeadlessChildren().then((value) => {
      waited = value;
    });
    await vi.advanceTimersByTimeAsync(HEADLESS_SHUTDOWN_WAIT_MS - 1);
    await flushMicrotasks();
    expect(waited).toBeUndefined();

    // Red when the wait has no bound: it would still be pending here, and a
    // shutdown would hang on a wedged engine.
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(waited).toBe(false);
    // Red when the wait kills: the kill belongs to the exit hook, after it.
    expect(kills.taskkillPids).toEqual([]);

    runner.killSpawnedProcessesSync();
    expect(kills.taskkillPids).toEqual([String(HEADLESS_PID)]);

    child.emit('close', null);
    await pending;
  });

  it('answers at once when no headless run is in flight', async () => {
    expect(await runner.waitForHeadlessChildren()).toBe(true);
  });

  it('refuses a headless operation and an import once the shutdown has begun', async () => {
    await runner.stopAllSessions();

    // Red when either starts: the shutdown has stopped looking for runs to
    // wait for, so the exit hook would kill it partway through its work.
    await expect(runner.executeOperation('save_scene', {}, projectPath)).rejects.toThrow(
      /server is shutting down, so the save_scene operation was not started/,
    );
    await expect(runner.importAssets(projectPath)).rejects.toThrow(
      /server is shutting down, so the asset import was not started/,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('one asset import per project at a time', () => {
  it('hands a second caller the import in flight, and starts a new one only after it has finished', async () => {
    const child = makeFakeChild(HEADLESS_PID);
    spawnMock.mockReset();
    spawnMock.mockReturnValue(child);
    const runner = new GodotRunner({ godotPath: 'godot' });
    stubBridge(runner);
    const projectPath = tmp.makeProject('godot-mcp-import-join-');

    const first = runner.importAssets(projectPath);
    // The same project under another spelling.
    const second = runner.importAssets(`${projectPath}/`);
    // Red when importAssets spawns per call: two engines would be importing
    // one project.
    expect(spawnMock).toHaveBeenCalledTimes(1);

    child.emit('close', 0);
    await Promise.all([first, second]);

    const third = runner.importAssets(projectPath);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    child.emit('close', 0);
    await third;
  });

  it('gives every caller of a failed import its error, and does not keep the failure for the next call', async () => {
    const child = makeFakeChild(HEADLESS_PID);
    spawnMock.mockReset();
    spawnMock.mockReturnValue(child);
    const runner = new GodotRunner({ godotPath: 'godot' });
    stubBridge(runner);
    const projectPath = tmp.makeProject('godot-mcp-import-fail-');

    const first = runner.importAssets(projectPath).catch((error: unknown) => error as Error);
    const second = runner.importAssets(projectPath).catch((error: unknown) => error as Error);
    child.stderr.emit('data', Buffer.from("ERROR: Error importing 'res://bad.png'\n"));
    child.emit('close', 0);

    expect(((await first) as Error).message).toMatch(/Asset import reported errors for 1 file/);
    expect(((await second) as Error).message).toMatch(/Asset import reported errors for 1 file/);

    const retry = runner.importAssets(projectPath);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    child.emit('close', 0);
    await expect(retry).resolves.toBeUndefined();
  });
});

describe('a Godot path whose version probe failed', () => {
  let savedGodotPath: string | undefined;

  beforeEach(() => {
    savedGodotPath = process.env.GODOT_PATH;
    // A file that exists, so the probe is reached; it is never run.
    process.env.GODOT_PATH = process.execPath;
  });

  afterEach(() => {
    if (savedGodotPath === undefined) delete process.env.GODOT_PATH;
    else process.env.GODOT_PATH = savedGodotPath;
  });

  it.each([
    {
      label: 'an exit code and the end of its stderr',
      close: [3, null] as const,
      stderr: 'first line\n\nlast line\n',
      expected:
        /Could not find a valid Godot executable path\. Probed ".+": Process exited with code 3; stderr: first line \| last line/,
    },
    {
      label: 'the signal that ended it',
      close: [null, 'SIGKILL'] as const,
      stderr: '',
      expected:
        /Could not find a valid Godot executable path\. Probed ".+": Process was ended by signal SIGKILL$/,
    },
  ])('is reported with $label', async ({ close, stderr, expected }) => {
    const child = makeFakeChild(HEADLESS_PID);
    spawnMock.mockReset();
    spawnMock.mockReturnValue(child);
    const runner = new GodotRunner();
    stubBridge(runner);

    const pending = runner
      .executeOperation('validate', {}, tmp.makeProject('godot-mcp-probe-'))
      .catch((error: unknown) => error as Error);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    if (stderr !== '') child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', ...close);

    // Red when the bare message comes back: a probe that failed for a passing
    // reason would read the same as a path that was never there.
    expect(((await pending) as Error).message).toMatch(expected);
  });
});

describe('the parent-watch port', () => {
  let savedDisplay: string | undefined;

  beforeEach(() => {
    savedDisplay = process.env.DISPLAY;
    if (process.platform === 'linux' && !process.env.DISPLAY) process.env.DISPLAY = ':0';
    spawnMock.mockReset();
  });

  afterEach(() => {
    if (savedDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = savedDisplay;
  });

  function spawnEnv(call: number): Record<string, string> {
    return (spawnMock.mock.calls[call]?.[2] as { env: Record<string, string> }).env;
  }

  it('is given to a spawned game, next to its token and bridge port, and something is listening on it', async () => {
    spawnMock.mockReturnValue(makeFakeChild(GAME_PID));
    const runner = new GodotRunner({ godotPath: 'godot' });
    stubBridge(runner);

    await runner.runProject(tmp.makeProject('godot-mcp-watch-'), undefined, true, GAME_BRIDGE_PORT);

    const env = spawnEnv(0);
    expect(env.MCP_BRIDGE_PORT).toBe(String(GAME_BRIDGE_PORT));
    expect(env.MCP_SESSION_TOKEN).toMatch(/^[0-9a-f]+$/);
    const watchPort = Number(env[PARENT_WATCH_PORT_ENV]);
    expect(Number.isInteger(watchPort) && watchPort > 0).toBe(true);

    // The game connects and writes heartbeats; the server accepts and discards.
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(watchPort, '127.0.0.1');
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.write(Buffer.from([0]), () => {
          socket.destroy();
          resolve();
        });
      });
    });
  });

  it('is the same listener for every game this server spawns', async () => {
    spawnMock.mockImplementation(() => makeFakeChild(undefined));
    const runner = new GodotRunner({ godotPath: 'godot' });
    stubBridge(runner);

    await runner.runProject(
      tmp.makeProject('godot-mcp-watch-a-'),
      undefined,
      true,
      GAME_BRIDGE_PORT,
    );
    await runner.runProject(
      tmp.makeProject('godot-mcp-watch-b-'),
      undefined,
      true,
      GAME_BRIDGE_PORT + 1,
    );

    expect(spawnEnv(0)[PARENT_WATCH_PORT_ENV]).toBe(spawnEnv(1)[PARENT_WATCH_PORT_ENV]);
  });

  it('is never part of an attach: nothing is spawned, so there is no environment to carry it', async () => {
    const runner = new GodotRunner({ godotPath: 'godot' });
    stubBridge(runner);

    await runner.attachProject(tmp.makeProject('godot-mcp-watch-attach-'), GAME_BRIDGE_PORT);

    expect(spawnMock).not.toHaveBeenCalled();
  });
});
