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
 * the catch branch. Pass `godotVersion` to satisfy version-gated handlers
 * (e.g. handleManageUids).
 *
 * `runner.calls` is a spy surface — use it sparingly. The default rubric is
 * "assert outputs, not internal calls." Reach for `calls` only to confirm a
 * boundary contract that the result shape cannot — e.g. that a batch handler
 * actually invoked the batch operation rather than the single-target one.
 */

import type {
  GodotRunner,
  OperationParams,
  OperationResult,
} from '../../src/utils/godot-runner.js';

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
   * isGodot44OrLater() is derived from it. Default: "4.3.stable".
   */
  godotVersion?: string;
}

export interface FakeRunner {
  /** Recorded calls to executeOperation, in order. */
  calls: FakeRunnerCall[];
  /** The runner cast to GodotRunner — pass directly to handlers. */
  asRunner: GodotRunner;
}

export function createFakeRunner(options: FakeRunnerOptions = {}): FakeRunner {
  const calls: FakeRunnerCall[] = [];
  const defaults: Pick<FakeRunnerOptions, 'stdout' | 'stderr' | 'throws'> = {
    stdout: options.stdout ?? '',
    stderr: options.stderr ?? '',
    throws: options.throws,
  };
  const responses = options.responses ?? [];
  const godotVersion = options.godotVersion ?? '4.3.stable';

  function parseMajorMinor(version: string): [number, number] {
    const [major = '0', minor = '0'] = version.split('.');
    return [Number(major) || 0, Number(minor) || 0];
  }

  const fake = {
    calls,
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
    async getVersion(): Promise<string> {
      return godotVersion;
    },
    isGodot44OrLater(version: string = godotVersion): boolean {
      const [major, minor] = parseMajorMinor(version);
      return major > 4 || (major === 4 && minor >= 4);
    },
  };

  return {
    calls,
    asRunner: fake as unknown as GodotRunner,
  };
}
