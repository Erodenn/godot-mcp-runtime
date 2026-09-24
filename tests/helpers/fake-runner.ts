/**
 * Spy-capable fake GodotRunner for handler unit tests.
 *
 * Handler tests should *not* mock the real GodotRunner internals or the
 * Godot binary. They want to assert: "given this validated input, did the
 * handler call executeOperation with the right (operation, params,
 * projectPath), and did it shape the result correctly?"
 *
 * Build a FakeRunner with `createFakeRunner({ stdout, stderr })` for the
 * happy path, or `createFakeRunner({ throws: new Error(...) })` to exercise
 * the catch branch. Pass `godotVersion` to control what `getVersion()`
 * returns for handlers that read it (e.g. handleCheckProject). Pass
 * `importThrows` to make `importAssets()` reject, for tests of the
 * cold-import retry's failure path in `executeSceneOp`.
 *
 * `runner.calls` is a spy surface: use it sparingly. The default rubric is
 * "assert outputs, not internal calls." Reach for `calls` only to confirm a
 * boundary contract that the result shape cannot: e.g. that a batch handler
 * actually invoked the batch operation rather than the single-target one.
 */

import type { GodotRunner, OperationResult } from '../../src/utils/godot-runner.js';
import type { OperationParams } from '../../src/mcp.types.js';

export interface FakeRunnerCall {
  operation: string;
  params: OperationParams;
  projectPath: string;
  timeoutMs?: number;
}

export interface FakeRunnerOptions {
  /** Stdout the runner returns. Default: empty string. */
  stdout?: string;
  /** Stderr the runner returns. Default: empty string. */
  stderr?: string;
  /** If set, executeOperation throws this instead of returning. */
  throws?: Error;
  /** Override per call by index. Each entry shadows the defaults above. */
  responses?: Array<Partial<Pick<FakeRunnerOptions, 'stdout' | 'stderr' | 'throws'>>>;
  /**
   * Godot version string returned by getVersion() (e.g. "4.4.1.stable").
   * Default: "4.3.stable".
   */
  godotVersion?: string;
  /**
   * Path returned by getGodotPath() for handlers that need the executable
   * (e.g. server-side render checks). Default: "/fake/godot". Set to null
   * to simulate an undetected Godot.
   */
  godotPath?: string | null;
  /** If set, importAssets() rejects with this error instead of resolving. */
  importThrows?: Error;
}

export interface FakeRunner {
  /** Recorded calls to executeOperation, in order. */
  calls: FakeRunnerCall[];
  /** Project paths passed to importAssets(), in order. */
  importCalls: string[];
  /** The runner cast to GodotRunner: pass directly to handlers. */
  asRunner: GodotRunner;
}

export function createFakeRunner(options: FakeRunnerOptions = {}): FakeRunner {
  const calls: FakeRunnerCall[] = [];
  const importCalls: string[] = [];
  const defaults: Pick<FakeRunnerOptions, 'stdout' | 'stderr' | 'throws'> = {
    stdout: options.stdout ?? '',
    stderr: options.stderr ?? '',
    throws: options.throws,
  };
  const responses = options.responses ?? [];
  const godotVersion = options.godotVersion ?? '4.3.stable';
  const importThrows = options.importThrows;

  const fake = {
    calls,
    importCalls,
    // No live runtime session by default -- tests that need one (e.g. the
    // executeSceneOp guard tests) set these fields directly on `asRunner`.
    activeSessionMode: null as 'spawned' | 'attached' | null,
    activeProjectPath: null as string | null,
    activeProcess: null as { hasExited: boolean } | null,
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
      return { stdout: merged.stdout ?? '', stderr: merged.stderr ?? '' };
    },
    async importAssets(projectPath: string): Promise<void> {
      importCalls.push(projectPath);
      if (importThrows) throw importThrows;
    },
    async getVersion(): Promise<string> {
      return godotVersion;
    },
    getGodotPath(): string | null {
      return options.godotPath !== undefined ? options.godotPath : '/fake/godot';
    },
    // Mirrors the real GodotRunner.hasActiveRuntimeSession() predicate so
    // guard tests exercise the same liveness logic production code does.
    hasActiveRuntimeSession(): boolean {
      if (!fake.activeSessionMode || !fake.activeProjectPath) return false;
      if (fake.activeSessionMode === 'spawned') {
        return fake.activeProcess !== null && !fake.activeProcess.hasExited;
      }
      return true;
    },
  };

  return {
    calls,
    importCalls,
    asRunner: fake as unknown as GodotRunner,
  };
}
