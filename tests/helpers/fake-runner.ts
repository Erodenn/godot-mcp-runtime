/** Spy-capable fake GodotRunner for handler tests; assert outputs, and use `runner.calls` only for a boundary contract the result shape cannot show. */

import { GodotRunner, sessionKey, type OperationResult } from '../../src/utils/godot-runner.js';
import type { OperationParams } from '../../src/mcp.types.js';
import type { BridgeOwnerInfo } from '../../src/utils/bridge-manager.js';
import { OPERATION_RESULT_SENTINEL } from '../../src/utils/output-parsing.js';
import { SessionQueue } from '../../src/utils/session-queue.js';
import { fakeSessionApi, liveSessionInfo } from './fake-sessions.js';

/** Frames a bare JSON stdout with the sentinel line godot_operations.gd prints; anything else passes through untouched, which is how a test expresses no payload line or invalid JSON. */
function frameBareJsonResult(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return stdout;
  if (trimmed.includes(OPERATION_RESULT_SENTINEL)) return stdout;
  try {
    JSON.parse(trimmed);
  } catch {
    return stdout;
  }
  return OPERATION_RESULT_SENTINEL + trimmed;
}

export interface FakeRunnerCall {
  operation: string;
  params: OperationParams;
  projectPath: string;
  timeoutMs?: number;
}

export interface FakeRunnerOptions {
  stdout?: string;
  stderr?: string;
  throws?: Error;
  responses?: Array<Partial<Pick<FakeRunnerOptions, 'stdout' | 'stderr' | 'throws'>>>;
  godotVersion?: string;
  /** Null simulates an undetected Godot. */
  godotPath?: string | null;
  importThrows?: Error;
  /** The same promise goes to every caller, like the real runner's import in flight. */
  importPending?: Promise<void>;
  exclusiveThrows?: Error;
}

export interface FakeMovieRun {
  projectPath: string;
  queueHeldBy: string | null;
  ended: boolean;
}

export interface FakeRunner {
  calls: FakeRunnerCall[];
  importCalls: string[];
  movieRuns: FakeMovieRun[];
  queue: SessionQueue;
  asRunner: GodotRunner;
}

export function createFakeRunner(options: FakeRunnerOptions = {}): FakeRunner {
  const calls: FakeRunnerCall[] = [];
  const importCalls: string[] = [];
  const movieRuns: FakeMovieRun[] = [];
  const queue = new SessionQueue();
  const defaults: Pick<FakeRunnerOptions, 'stdout' | 'stderr' | 'throws'> = {
    stdout: options.stdout ?? '',
    stderr: options.stderr ?? '',
    throws: options.throws,
  };
  const responses = options.responses ?? [];
  const godotVersion = options.godotVersion ?? '4.3.stable';
  const importThrows = options.importThrows;
  const godotPath = options.godotPath !== undefined ? options.godotPath : '/fake/godot';

  const fake = {
    calls,
    importCalls,
    // No live runtime session by default; tests needing one set these fields on `asRunner`.
    activeSessionMode: null as 'spawned' | 'attached' | null,
    activeProjectPath: null as string | null,
    activeProcess: null as { hasExited: boolean } | null,
    ...fakeSessionApi(() => ({
      current: {
        mode: fake.activeSessionMode,
        projectPath: fake.activeProjectPath,
        process: fake.activeProcess,
      },
      others: fake.extraLiveSessionPaths.map((path) => liveSessionInfo(path)),
    })),
    otherLiveSessions: [] as BridgeOwnerInfo[],
    otherLiveSessionsOnProject(_projectPath: string): BridgeOwnerInfo[] {
      return fake.otherLiveSessions;
    },
    async executeOperation(
      operation: string,
      params: OperationParams,
      projectPath: string,
      timeoutMs?: number,
    ): Promise<OperationResult> {
      const callIndex = calls.length;
      calls.push({ operation, params, projectPath, timeoutMs });
      const override = responses[callIndex] ?? {};
      const merged = { ...defaults, ...override };
      if (merged.throws) throw merged.throws;
      return { stdout: frameBareJsonResult(merged.stdout ?? ''), stderr: merged.stderr ?? '' };
    },
    importAssets(projectPath: string): Promise<void> {
      importCalls.push(projectPath);
      if (importThrows) return Promise.reject(importThrows);
      return options.importPending ?? Promise.resolve();
    },
    runExclusive<T>(label: string, operation: () => Promise<T>): Promise<T> {
      if (options.exclusiveThrows) return Promise.reject(options.exclusiveThrows);
      return queue.run(label, operation);
    },
    queueTurn() {
      return queue.turn();
    },
    beginMovieRun(projectPath: string): () => void {
      const run: FakeMovieRun = { projectPath, queueHeldBy: queue.running, ended: false };
      movieRuns.push(run);
      return () => {
        run.ended = true;
      };
    },
    async getVersion(): Promise<string> {
      return godotVersion;
    },
    getGodotPath(): string | null {
      return godotPath;
    },
    async detectGodotPath(): Promise<void> {},
    extractRuntimeErrors: (lines: string[]): string[] =>
      GodotRunner.prototype.extractRuntimeErrors.call(undefined, lines),
    // Mirrors the real hasActiveRuntimeSession() predicate.
    hasActiveRuntimeSession(): boolean {
      if (!fake.activeSessionMode || !fake.activeProjectPath) return false;
      if (fake.activeSessionMode === 'spawned') {
        return fake.activeProcess !== null && !fake.activeProcess.hasExited;
      }
      return true;
    },
    extraLiveSessionPaths: [] as string[],
    // Mirrors the real hasLiveSessionOnProject(): any live session on the project counts, under the runner's own path key.
    hasLiveSessionOnProject(projectPath: string): boolean {
      const key = sessionKey(projectPath);
      if (
        fake.hasActiveRuntimeSession() &&
        fake.activeProjectPath !== null &&
        sessionKey(fake.activeProjectPath) === key
      ) {
        return true;
      }
      return fake.extraLiveSessionPaths.some((path) => sessionKey(path) === key);
    },
  };

  return {
    calls,
    importCalls,
    movieRuns,
    queue,
    asRunner: fake as unknown as GodotRunner,
  };
}
