/**
 * Process-lifetime destructors: signals, stdin close, and the synchronous
 * exit handler.
 *
 * `registerProcessLifecycle` is the function the server constructor calls with
 * its two optional arguments defaulted, so driving it here with an injected
 * fake `process` exercises the production registration path rather than a
 * re-implementation of it. Only the `process` object and `process.exit` are
 * substituted.
 *
 * The literal `dist/index.js` child-process proof cannot live in vitest:
 * `npm test` runs before `npm run build` in `scripts/verify.sh`, and CI's
 * `godot-integration` job has no build step at all, so the child would
 * exercise a stale build locally and a missing one in CI.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { registerProcessLifecycle, shutDownRunner } from '../../src/utils/process-lifecycle.js';
import type { LifecycleProcess } from '../../src/utils/process-lifecycle.js';
import { GodotRunner, type GodotProcess } from '../../src/utils/godot-runner.js';
import { bridgeDir, bridgeScriptAbsPath, mcpDir } from '../../src/utils/artifact-paths.js';
import { projectGodotPath } from '../../src/utils/path-validation.js';
import { useTmpDirs } from '../helpers/tmp.js';
import { installSession } from '../helpers/session-install.js';

type Listener = (...args: never[]) => void;

/** Pid of a fake child; the OS kill calls are faked, nothing real is signalled. */
const STILL_RUNNING_GAME_PID = 43299;

interface FakeProcess extends LifecycleProcess {
  emit(event: string): void;
  stdinEmit(event: string): void;
  listenerCount(event: string): number;
}

function makeFakeProcess(): FakeProcess {
  const procListeners = new Map<string, Listener[]>();
  const stdinListeners = new Map<string, Listener[]>();
  const add = (map: Map<string, Listener[]>, event: string, fn: Listener): void => {
    const list = map.get(event) ?? [];
    list.push(fn);
    map.set(event, list);
  };
  const fire = (map: Map<string, Listener[]>, event: string): void => {
    for (const fn of map.get(event) ?? []) fn();
  };
  return {
    on(event, listener) {
      add(procListeners, event, listener);
      return this;
    },
    stdin: {
      on(event, listener) {
        add(stdinListeners, event, listener);
        return this;
      },
    },
    emit: (event) => fire(procListeners, event),
    stdinEmit: (event) => fire(stdinListeners, event),
    listenerCount: (event) => (procListeners.get(event) ?? []).length,
  };
}

const tmp = useTmpDirs();

/** Pid of a fake headless child; nothing real is signalled. */
const HEADLESS_RUN_PID = 43300;
/** The bound the shutdown tests give the wait for headless runs. */
const TEST_HEADLESS_WAIT_MS = 400;
/** Promise hops between a timer or an event and the exit built on it; generous. */
const MICROTASK_FLUSHES = 50;

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < MICROTASK_FLUSHES; i++) await Promise.resolve();
}

// The production cleanup is `shutDownRunner` followed by closing the MCP
// server (src/index.ts), so these drive the real shutdown step and the real
// registration, with a headless child put in the runner's set by hand.
describe('a graceful shutdown with a headless run in flight', () => {
  let runner: GodotRunner;
  let proc: FakeProcess;
  let events: string[];
  let child: EventEmitter & { pid: number };
  let headlessChildren: Set<unknown>;

  beforeEach(() => {
    vi.useFakeTimers();
    runner = new GodotRunner({ godotPath: 'godot' });
    proc = makeFakeProcess();
    events = [];
    child = Object.assign(new EventEmitter(), { pid: HEADLESS_RUN_PID });
    const internals = runner as unknown as {
      killTreeDeps: unknown;
      headlessChildren: Set<unknown>;
    };
    headlessChildren = internals.headlessChildren;
    headlessChildren.add(child);
    internals.killTreeDeps = {
      platform: 'win32',
      spawnSync: (_command: string, args: string[]) => {
        events.push(`taskkill ${args.join(' ')}`);
        return { status: 0 };
      },
      kill: () => {},
    };
    registerProcessLifecycle({
      runner,
      cleanup: () => shutDownRunner(runner, TEST_HEADLESS_WAIT_MS),
      proc,
      // As process.exit does: the 'exit' listeners run inside the call.
      exit: (code) => {
        events.push(`exit ${code}`);
        proc.emit('exit');
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('exits as soon as the run has closed, without killing it', async () => {
    proc.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(TEST_HEADLESS_WAIT_MS / 2);
    await flushMicrotasks();
    // Red when the shutdown does not wait: the exit, and the kill in its
    // hook, would already be here.
    expect(events).toEqual([]);

    // What the runner's own 'close' listener does for a real child.
    headlessChildren.delete(child);
    child.emit('close', 0);
    await flushMicrotasks();

    expect(events).toEqual(['exit 0']);
  });

  it('exits at the bound when the run has not closed, and only then is the run killed', async () => {
    proc.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(TEST_HEADLESS_WAIT_MS - 1);
    await flushMicrotasks();
    expect(events).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    // Red when the kill comes before the wait (the order is reversed or the
    // list starts with the kill), or when the wait has no bound (no exit).
    expect(events).toEqual(['exit 0', `taskkill /PID ${HEADLESS_RUN_PID} /T /F`]);
  });
});

describe('registerProcessLifecycle', () => {
  let runner: GodotRunner;
  let proc: FakeProcess;
  let cleanupCalls: number;
  let exitCodes: number[];

  beforeEach(() => {
    runner = new GodotRunner({ godotPath: 'godot' });
    proc = makeFakeProcess();
    cleanupCalls = 0;
    exitCodes = [];
    registerProcessLifecycle({
      runner,
      cleanup: async () => {
        cleanupCalls += 1;
      },
      proc,
      exit: (code) => exitCodes.push(code),
    });
  });

  it('registers SIGINT, SIGTERM, exit, and both stdin close events', () => {
    expect(proc.listenerCount('SIGINT')).toBe(1);
    expect(proc.listenerCount('SIGTERM')).toBe(1);
    expect(proc.listenerCount('exit')).toBe(1);
  });

  /** Register on a fresh fake process as the named platform would. */
  function registerOn(platform: NodeJS.Platform): {
    proc: FakeProcess;
    exits: number[];
    cleanups: () => number;
  } {
    const platformProc = makeFakeProcess();
    const exits: number[] = [];
    let cleanups = 0;
    registerProcessLifecycle({
      runner,
      cleanup: async () => {
        cleanups += 1;
      },
      proc: platformProc,
      exit: (code) => exits.push(code),
      platform,
    });
    return { proc: platformProc, exits, cleanups: () => cleanups };
  }

  // Outside Windows the games and headless runs lead their own process
  // groups, so the terminal's hangup does not reach them, and SIGHUP's default
  // action would end Node without running the exit handler.
  it.each(['linux', 'darwin'] as const)(
    'gives SIGHUP the graceful shutdown on %s: cleanup first, then the exit',
    async (platform) => {
      const registered = registerOn(platform);

      registered.proc.emit('SIGHUP');
      expect(registered.cleanups()).toBe(1);
      expect(registered.exits).toEqual([]);
      await Promise.resolve();
      await Promise.resolve();

      expect(registered.exits).toEqual([0]);
    },
  );

  // Windows ends the process a few seconds after the console closes, which
  // the graceful path can outlast: the synchronous exit handler does the work.
  it('exits at once on SIGHUP on Windows, without the asynchronous cleanup', () => {
    const registered = registerOn('win32');

    registered.proc.emit('SIGHUP');

    expect(registered.exits).toEqual([0]);
    expect(registered.cleanups()).toBe(0);
  });

  it("runs cleanup once on stdin 'end' and not again on a following 'close'", async () => {
    proc.stdinEmit('end');
    proc.stdinEmit('close');
    // Both handlers are async; let their microtasks drain.
    await Promise.resolve();
    await Promise.resolve();

    expect(cleanupCalls).toBe(1);
    expect(exitCodes).toEqual([0]);
  });

  it('runs cleanup once when SIGINT follows a stdin close', async () => {
    proc.stdinEmit('close');
    proc.emit('SIGINT');
    await Promise.resolve();
    await Promise.resolve();

    expect(cleanupCalls).toBe(1);
  });

  // A cleanup that throws must not strand the process: without the exit, the
  // server outlives the client that closed stdin.
  it('still exits when cleanup rejects', async () => {
    const failingProc = makeFakeProcess();
    const exits: number[] = [];
    registerProcessLifecycle({
      runner,
      cleanup: () => Promise.reject(new Error('cleanup blew up')),
      proc: failingProc,
      exit: (code) => exits.push(code),
    });

    failingProc.stdinEmit('end');
    await Promise.resolve();
    await Promise.resolve();

    expect(exits).toEqual([0]);
  });

  it("removes the bridge artifacts synchronously from the 'exit' handler", () => {
    const projectPath = tmp.makeProject('godot-mcp-exit-');
    mkdirSync(bridgeDir(projectPath), { recursive: true });
    writeFileSync(bridgeScriptAbsPath(projectPath), 'extends Node\n', 'utf8');
    writeFileSync(
      projectGodotPath(projectPath),
      'config_version=5\n\n[autoload]\n\nMcpBridge="*res://.mcp/godot-runtime/bridge/mcp_bridge.gd"\n',
      'utf8',
    );
    installSession(runner, { mode: 'attached', projectPath });

    proc.emit('exit');

    expect(existsSync(bridgeScriptAbsPath(projectPath))).toBe(false);
    expect(existsSync(bridgeDir(projectPath))).toBe(false);
    // Only bridge/ is session-scoped; the importer marker stays put.
    expect(existsSync(mcpDir(projectPath))).toBe(true);
  });

  it("removes the bridge artifacts of every session from the 'exit' handler", () => {
    const projects = [tmp.makeProject('godot-mcp-exit-a-'), tmp.makeProject('godot-mcp-exit-b-')];
    for (const projectPath of projects) {
      mkdirSync(bridgeDir(projectPath), { recursive: true });
      writeFileSync(bridgeScriptAbsPath(projectPath), 'extends Node\n', 'utf8');
      writeFileSync(
        projectGodotPath(projectPath),
        'config_version=5\n\n[autoload]\n\nMcpBridge="*res://.mcp/godot-runtime/bridge/mcp_bridge.gd"\n',
        'utf8',
      );
      // Only the last one installed is the current session; the handler has
      // to reach the other one too.
      installSession(runner, { mode: 'attached', projectPath });
    }

    proc.emit('exit');

    for (const projectPath of projects) {
      expect(existsSync(bridgeScriptAbsPath(projectPath))).toBe(false);
      expect(existsSync(bridgeDir(projectPath))).toBe(false);
      expect(existsSync(mcpDir(projectPath))).toBe(true);
    }
  });

  it("kills a spawned game that is still running from the 'exit' handler, before its bridge is removed", () => {
    const projectPath = tmp.makeProject('godot-mcp-exit-kill-');
    const order: string[] = [];
    const child = { pid: STILL_RUNNING_GAME_PID, kill: () => true };
    installSession(runner, {
      mode: 'spawned',
      projectPath,
      process: {
        process: child as unknown as GodotProcess['process'],
        output: [],
        errors: [],
        totalErrorsWritten: 0,
        exitCode: null,
        hasExited: false,
        sessionToken: 'exit-kill-token',
      },
    });
    const internals = runner as unknown as {
      killTreeDeps: unknown;
      bridge: { cleanup(projectPath: string): string[] };
    };
    internals.killTreeDeps = {
      platform: 'win32',
      spawnSync: (_command: string, args: string[]) => {
        order.push(`taskkill ${args.join(' ')}`);
        return { status: 0 };
      },
      kill: () => {},
    };
    const realCleanup = internals.bridge.cleanup.bind(internals.bridge);
    internals.bridge.cleanup = (path: string): string[] => {
      order.push('bridge cleanup');
      return realCleanup(path);
    };

    proc.emit('exit');

    expect(order).toEqual([`taskkill /PID ${STILL_RUNNING_GAME_PID} /T /F`, 'bridge cleanup']);
  });

  it("does not throw from the 'exit' handler when there is no active project", () => {
    expect(runner.activeProjectPath).toBeNull();
    expect(() => proc.emit('exit')).not.toThrow();
  });
});
