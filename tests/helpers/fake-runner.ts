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

import { GodotRunner, sessionKey, type OperationResult } from '../../src/utils/godot-runner.js';
import type { OperationParams } from '../../src/mcp.types.js';
import type { BridgeOwnerInfo } from '../../src/utils/bridge-manager.js';
import { OPERATION_RESULT_SENTINEL } from '../../src/utils/output-parsing.js';
import { fakeSessionApi, liveSessionInfo } from './fake-sessions.js';

/**
 * What the real runner hands back for an operation that emitted a JSON
 * result: the sentinel line godot_operations.gd prints. A fixture whose whole
 * stdout is one bare JSON object or array is framed the same way, so a test
 * can write the payload without repeating the framing. Anything else (noise,
 * several lines, text that is not valid JSON, text already carrying the
 * sentinel) passes through untouched, which is how a test expresses "no
 * payload line" or a payload that is not valid JSON.
 */
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
   * (e.g. render_movie). Default: "/fake/godot". Set to null to simulate an
   * undetected Godot.
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
  const godotPath = options.godotPath !== undefined ? options.godotPath : '/fake/godot';

  const fake = {
    calls,
    importCalls,
    // No live runtime session by default -- tests that need one (e.g. the
    // executeSceneOp guard tests) set these fields directly on `asRunner`.
    // They model the current session; `extraLiveSessionPaths` below models
    // live sessions on other projects.
    activeSessionMode: null as 'spawned' | 'attached' | null,
    activeProjectPath: null as string | null,
    activeProcess: null as { hasExited: boolean } | null,
    // No other MCP session on this project by default -- the cross-server
    // edit guard test sets this directly on `asRunner`.
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
    async importAssets(projectPath: string): Promise<void> {
      importCalls.push(projectPath);
      if (importThrows) throw importThrows;
    },
    async getVersion(): Promise<string> {
      return godotVersion;
    },
    getGodotPath(): string | null {
      return godotPath;
    },
    async detectGodotPath(): Promise<void> {
      // Detection is a no-op: godotPath is fixed by the option.
    },
    // The real filter, which reads no instance state.
    extractRuntimeErrors: (lines: string[]): string[] =>
      GodotRunner.prototype.extractRuntimeErrors.call(undefined, lines),
    // Mirrors the real GodotRunner.hasActiveRuntimeSession() predicate so
    // guard tests exercise the same liveness logic production code does.
    hasActiveRuntimeSession(): boolean {
      if (!fake.activeSessionMode || !fake.activeProjectPath) return false;
      if (fake.activeSessionMode === 'spawned') {
        return fake.activeProcess !== null && !fake.activeProcess.hasExited;
      }
      return true;
    },
    // Projects with a live session that is not the current one. The fields
    // above model the current session only; a test of the per-project guard
    // lists the others here.
    extraLiveSessionPaths: [] as string[],
    // Mirrors GodotRunner.hasLiveSessionOnProject(): any live session on the
    // project counts, current or not, under the runner's own path key.
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
    asRunner: fake as unknown as GodotRunner,
  };
}
