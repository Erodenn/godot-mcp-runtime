/**
 * Unit tests for the profiler-tools handlers.
 *
 * The handlers own argument defaults, the sort enum, and the mapping from a
 * `ProfilerError` code to a user-facing solution list. The receiver itself is
 * covered in `unit/profiler.test.ts`, so here it is a stub that records what
 * the handler asked it for.
 */

import { describe, it, expect } from 'vitest';
import {
  handleProfileProject,
  handleStartProfiler,
  handleStopProfiler,
} from '../../../src/tools/profiler-tools.js';
import { ProfilerError, type DebuggerProfiler } from '../../../src/utils/profiler.js';
import type { GodotProcess, GodotRunner } from '../../../src/utils/godot-runner.js';
import { expectErrorMatching, hasError, unwrap } from '../../helpers/assertions.js';

interface ProfilerCall {
  method: 'start' | 'stop' | 'captureWindow';
  args: unknown[];
}

interface ProfilerFake {
  asRunner: GodotRunner;
  calls: ProfilerCall[];
}

const captureResult = {
  seconds: 5,
  frames: 300,
  framesReceived: 301,
  firstFrame: 10,
  lastFrame: 309,
  frameGaps: 0,
  undecodablePackets: 0,
  captureLimit: 512,
  limitReached: false,
  sort: 'selfMs',
  functionsReceived: 2,
  unresolvedFunctions: 0,
  rows: [{ function: '_burn', selfMs: 480 }],
  worstFrame: null,
};

function createProfilerFake(
  options: { profiler?: boolean; exited?: boolean; throws?: Error; session?: boolean } = {},
): ProfilerFake {
  const calls: ProfilerCall[] = [];
  const record = (method: ProfilerCall['method'], args: unknown[], result: unknown): unknown => {
    calls.push({ method, args });
    if (options.throws) throw options.throws;
    return result;
  };
  const profiler = {
    async start(...args: unknown[]) {
      return record('start', args, {
        active: true,
        maxSeconds: args[0],
        firstFrame: 10,
        captureLimit: args[1],
      });
    },
    async stop(...args: unknown[]) {
      return record('stop', args, { ...captureResult, sort: args[1] });
    },
    async captureWindow(...args: unknown[]) {
      return record('captureWindow', args, { ...captureResult, sort: args[2] });
    },
  };
  const runner = {
    activeProfiler: options.profiler === false ? null : (profiler as unknown as DebuggerProfiler),
    activeProcess: { hasExited: options.exited === true } as GodotProcess,
    activeSessionMode: options.session === false ? null : 'spawned',
    activeProjectPath: options.session === false ? null : 'D:/proj',
  };
  return { asRunner: runner as unknown as GodotRunner, calls };
}

describe('profiler handlers — session requirements', () => {
  it.each([
    ['profile_project', handleProfileProject],
    ['start_profiler', handleStartProfiler],
    ['stop_profiler', handleStopProfiler],
  ])('%s rejects a session launched without profiling', async (_name, handler) => {
    const fake = createProfilerFake({ profiler: false });
    expectErrorMatching(await handler(fake.asRunner, {}), /Profiling is not enabled/);
  });

  it.each([
    ['profile_project', handleProfileProject],
    ['start_profiler', handleStartProfiler],
    ['stop_profiler', handleStopProfiler],
  ])('%s distinguishes no session at all from no profiling', async (_name, handler) => {
    const fake = createProfilerFake({ profiler: false, session: false });
    expectErrorMatching(await handler(fake.asRunner, {}), /No active runtime session/);
  });

  it.each([
    ['profile_project', handleProfileProject],
    ['start_profiler', handleStartProfiler],
    ['stop_profiler', handleStopProfiler],
  ])('%s rejects a Godot process that already exited', async (_name, handler) => {
    const fake = createProfilerFake({ exited: true });
    expectErrorMatching(await handler(fake.asRunner, {}), /has exited/);
  });
});

describe('handleProfileProject', () => {
  it('captures a five-second window ranked by own time by default', async () => {
    const fake = createProfilerFake();
    const result = await handleProfileProject(fake.asRunner, {});

    expect(hasError(result)).toBe(false);
    expect(fake.calls[0]).toEqual({ method: 'captureWindow', args: [5, 20, 'selfMs', 512] });
    expect(unwrap(result).structuredContent).toMatchObject({ frames: 300, sort: 'selfMs' });
  });

  it('forwards seconds, top and sort', async () => {
    const fake = createProfilerFake();
    await handleProfileProject(fake.asRunner, { seconds: 12, top: 5, sort: 'totalMs' });

    expect(fake.calls[0]).toEqual({ method: 'captureWindow', args: [12, 5, 'totalMs', 512] });
  });

  it('rejects a sort key outside the enum', async () => {
    const fake = createProfilerFake();
    expectErrorMatching(
      await handleProfileProject(fake.asRunner, { sort: 'wallMs' }),
      /Invalid sort/,
    );
  });

  it('rejects a non-numeric seconds before touching the profiler', async () => {
    const fake = createProfilerFake();
    expect(hasError(await handleProfileProject(fake.asRunner, { seconds: 'five' }))).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('handleStartProfiler', () => {
  it('defaults to a 30 second window at the full engine row limit', async () => {
    const fake = createProfilerFake();
    const result = await handleStartProfiler(fake.asRunner, {});

    expect(fake.calls[0]).toEqual({ method: 'start', args: [30, 512] });
    expect(unwrap(result).structuredContent).toMatchObject({ active: true, captureLimit: 512 });
  });

  it('accepts captureLimit in snake_case as well as camelCase', async () => {
    const fake = createProfilerFake();
    await handleStartProfiler(fake.asRunner, { seconds: 10, capture_limit: 64 });

    expect(fake.calls[0]).toEqual({ method: 'start', args: [10, 64] });
  });

  it('explains how to clear an already-running capture', async () => {
    const fake = createProfilerFake({
      throws: new ProfilerError('profile_busy', 'A capture is already active'),
    });
    const result = await handleStartProfiler(fake.asRunner, {});

    expectErrorMatching(result, /already active/);
    expect(unwrap(result).content[1]?.text).toMatch(/stop_profiler/);
  });
});

describe('handleStopProfiler', () => {
  it('returns the top 20 by own time by default', async () => {
    const fake = createProfilerFake();
    const result = await handleStopProfiler(fake.asRunner, {});

    expect(fake.calls[0]).toEqual({ method: 'stop', args: [20, 'selfMs'] });
    expect(unwrap(result).structuredContent).toMatchObject({ sort: 'selfMs' });
  });

  it('points at start_profiler when no capture was started', async () => {
    const fake = createProfilerFake({
      throws: new ProfilerError('profile_not_started', 'Start a capture first'),
    });
    const result = await handleStopProfiler(fake.asRunner, {});

    expectErrorMatching(result, /Start a capture first/);
    expect(unwrap(result).content[1]?.text).toMatch(/start_profiler/);
  });
});
