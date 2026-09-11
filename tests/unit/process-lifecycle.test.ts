/**
 * D16 destructors (AC3.12's unit half).
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

import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { registerProcessLifecycle } from '../../src/utils/process-lifecycle.js';
import type { LifecycleProcess } from '../../src/utils/process-lifecycle.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { bridgeDir, bridgeScriptAbsPath, mcpDir } from '../../src/utils/artifact-paths.js';
import { projectGodotPath } from '../../src/utils/path-validation.js';
import { useTmpDirs } from '../helpers/tmp.js';

type Listener = (...args: never[]) => void;

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

  it("removes the bridge artifacts synchronously from the 'exit' handler", () => {
    const projectPath = tmp.makeProject('godot-mcp-exit-');
    mkdirSync(bridgeDir(projectPath), { recursive: true });
    writeFileSync(bridgeScriptAbsPath(projectPath), 'extends Node\n', 'utf8');
    writeFileSync(
      projectGodotPath(projectPath),
      'config_version=5\n\n[autoload]\n\nMcpBridge="*res://.mcp/godot-runtime/bridge/mcp_bridge.gd"\n',
      'utf8',
    );
    (runner as unknown as { activeProjectPath: string }).activeProjectPath = projectPath;

    proc.emit('exit');

    expect(existsSync(bridgeScriptAbsPath(projectPath))).toBe(false);
    expect(existsSync(bridgeDir(projectPath))).toBe(false);
    // Only bridge/ is session-scoped; the importer marker stays put.
    expect(existsSync(mcpDir(projectPath))).toBe(true);
  });

  it("does not throw from the 'exit' handler when there is no active project", () => {
    expect(runner.activeProjectPath).toBeNull();
    expect(() => proc.emit('exit')).not.toThrow();
  });
});
