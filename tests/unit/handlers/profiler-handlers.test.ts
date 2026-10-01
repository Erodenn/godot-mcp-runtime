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
  profilerToolDefinitions,
  handleProfileProject,
  handleStartProfiler,
  handleStopProfiler,
} from '../../../src/tools/profiler-tools.js';
import {
  MONITOR_NAMES,
  ProfilerError,
  timelineBucketMs,
  type CaptureOptions,
  type DebuggerProfiler,
  type TrackCollector,
} from '../../../src/utils/profiler.js';
import type { GodotProcess, GodotRunner } from '../../../src/utils/godot-runner.js';
import { expectErrorMatching, hasError, unwrap } from '../../helpers/assertions.js';
import { fakeSessionApi } from '../../helpers/fake-sessions.js';
import { expectMatchesOutputSchema } from '../../helpers/schema-assert.js';

interface ProfilerCall {
  method: 'start' | 'stop' | 'captureWindow' | 'attachTrack';
  args: unknown[];
}

interface ProfilerFake {
  asRunner: GodotRunner;
  calls: ProfilerCall[];
  /** Bridge commands the handler sent, in order. */
  bridge: Array<{ command: string; params: Record<string, unknown> }>;
}

// Every field DebuggerProfiler.summarize returns: the schema requires them all.
const FRAME_STAT = { avg: 16, max: 20 };
const MONITOR_STAT = { avg: 4, min: 2, max: 6 };

/** The options a handler passes when no capture option was given. */
const PLAIN = { visual: false, timelineMs: null, targetFps: 60, track: [] };

const captureResult = {
  complete: true,
  frame: {
    frameMs: FRAME_STAT,
    processMs: FRAME_STAT,
    physicsMs: FRAME_STAT,
    physicsFrameMs: FRAME_STAT,
    scriptMs: FRAME_STAT,
  },
  servers: [],
  seconds: 5,
  frames: 300,
  fps: 60,
  targetFps: 60,
  slowFrames: 0,
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
  monitors: {
    samples: 2,
    ...Object.fromEntries(MONITOR_NAMES.map((name) => [name, MONITOR_STAT])),
    pipelineCompilations: null,
    custom: [],
  },
  visual: null,
  timeline: null,
};

function createProfilerFake(
  options: {
    profiler?: boolean;
    exited?: boolean;
    /** A finished capture that stays readable after the game exits. */
    hasResult?: boolean;
    throws?: Error;
    /** What `assertCanStart` refuses with: a busy profiler or a bad argument. */
    refuses?: ProfilerError;
    session?: boolean;
    /** Whether the capture is waiting on track samples. */
    trackPending?: boolean;
    /** Raw bridge replies by command; an Error rejects the send. */
    replies?: Record<string, string | Error>;
  } = {},
): ProfilerFake {
  const calls: ProfilerCall[] = [];
  const bridge: ProfilerFake['bridge'] = [];
  let trackPending = options.trackPending === true;
  const record = (method: ProfilerCall['method'], args: unknown[], result: unknown): unknown => {
    calls.push({ method, args });
    if (options.throws) throw options.throws;
    return result;
  };
  /** What the real profiler does once a capture closes: fetch a pending track once. */
  const collect = async (collector: unknown): Promise<void> => {
    if (!trackPending || typeof collector !== 'function') return;
    trackPending = false;
    const { samples, error } = await (collector as TrackCollector)();
    calls.push({ method: 'attachTrack', args: [samples, error] });
  };
  const profiler = {
    hasResult: options.hasResult === true,
    assertCanStart() {
      if (options.refuses) throw options.refuses;
    },
    async start(...args: unknown[]) {
      const [seconds, , capture] = args as [number, number, CaptureOptions];
      const timelineMs = capture?.timelineMs ?? null;
      return record('start', args, {
        active: true,
        visual: capture?.visual === true,
        timeline: timelineMs !== null,
        timelineMs: timelineMs === null ? null : timelineBucketMs(timelineMs, seconds),
        maxSeconds: seconds,
        firstFrame: 10,
        captureLimit: args[1],
      });
    },
    async stop(...args: unknown[]) {
      const result = record('stop', args, { ...captureResult, sort: args[1] });
      await collect(args[2]);
      return result;
    },
    async captureWindow(...args: unknown[]) {
      const [seconds, , , , capture] = args as [number, number, string, number, CaptureOptions];
      const timelineMs = capture?.timelineMs ?? null;
      const result = record('captureWindow', args, {
        ...captureResult,
        sort: args[2],
        timeline:
          timelineMs === null
            ? null
            : {
                bucketMs: timelineBucketMs(timelineMs, seconds),
                track: capture?.track ?? [],
                trackError: null,
                buckets: [],
              },
      });
      await collect(args[5]);
      return result;
    },
  };
  const runner = {
    activeProfiler: options.profiler === false ? null : (profiler as unknown as DebuggerProfiler),
    activeProcess: { hasExited: options.exited === true } as GodotProcess,
    activeSessionMode: options.session === false ? null : 'spawned',
    activeProjectPath: options.session === false ? null : 'D:/proj',
    hasActiveRuntimeSession() {
      return options.session !== false && options.exited !== true;
    },
    async sendCommand(command: string, params: Record<string, unknown> = {}) {
      bridge.push({ command, params });
      const reply =
        options.replies?.[command] ??
        (command === 'track_stop' ? '{"samples":[]}' : '{"status":"tracking"}');
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  Object.assign(
    runner,
    fakeSessionApi(() => ({
      current: {
        mode: runner.activeSessionMode as 'spawned' | null,
        projectPath: runner.activeProjectPath,
        process: runner.activeProcess,
        profiling: runner.activeProfiler !== null,
      },
    })),
  );
  return { asRunner: runner as unknown as GodotRunner, calls, bridge };
}

describe('profiler handlers: session requirements', () => {
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

describe('profiler handlers: session project', () => {
  it.each([
    ['profile_project', handleProfileProject],
    ['start_profiler', handleStartProfiler],
    ['stop_profiler', handleStopProfiler],
  ])('%s names the session project', async (name, handler) => {
    const fake = createProfilerFake();
    const result = await handler(fake.asRunner, {});

    expect(hasError(result)).toBe(false);
    expect(unwrap(result).structuredContent).toMatchObject({ projectPath: 'D:/proj' });
    expectMatchesOutputSchema(name, result);
  });
});

describe('handleProfileProject', () => {
  it('captures a five-second window ranked by own time by default', async () => {
    const fake = createProfilerFake();
    const result = await handleProfileProject(fake.asRunner, {});

    expect(hasError(result)).toBe(false);
    expect(fake.calls[0]).toEqual({
      method: 'captureWindow',
      args: [5, 20, 'selfMs', 512, PLAIN, expect.any(Function)],
    });
    expect(fake.bridge).toHaveLength(0);
    expect(unwrap(result).structuredContent).toMatchObject({ frames: 300, sort: 'selfMs' });
  });

  it('forwards seconds, top and sort', async () => {
    const fake = createProfilerFake();
    await handleProfileProject(fake.asRunner, { seconds: 12, top: 5, sort: 'totalMs' });

    expect(fake.calls[0]?.args.slice(0, 5)).toEqual([12, 5, 'totalMs', 512, PLAIN]);
  });

  it('asks the capture for render stages when visual is set', async () => {
    const fake = createProfilerFake();
    await handleProfileProject(fake.asRunner, { visual: true });

    expect(fake.calls[0]?.args[4]).toEqual({ ...PLAIN, visual: true });
  });

  it.each([
    ['timeline alone', { timeline: true }, { timelineMs: 500 }],
    ['an interval, which implies a timeline', { timeline_ms: 1000 }, { timelineMs: 1000 }],
    ['a target frame rate', { targetFps: 90 }, { targetFps: 90 }],
  ])('passes %s to the capture', async (_label, args, expected) => {
    const fake = createProfilerFake();
    await handleProfileProject(fake.asRunner, args);

    expect(fake.calls[0]?.args[4]).toEqual({ ...PLAIN, ...expected });
  });

  it('starts the bridge track before the window and collects it once the window closed', async () => {
    const samples = [{ frame: 12, values: { '/root/Main/Player:position': { x: 1, y: 2 } } }];
    const fake = createProfilerFake({
      trackPending: true,
      replies: { track_stop: JSON.stringify({ samples }) },
    });
    const result = await handleProfileProject(fake.asRunner, {
      seconds: 5,
      track: ['/root/Main/Player:position'],
    });

    expect(hasError(result)).toBe(false);
    expect(fake.bridge.map((b) => b.command)).toEqual(['track_start', 'track_stop']);
    expect(fake.bridge[0]!.params).toEqual({
      watch: ['/root/Main/Player:position'],
      interval_ms: 250,
      max_ms: 15000,
    });
    // A track implies a timeline.
    expect(fake.calls[0]?.args[4]).toMatchObject({ timelineMs: 500 });
    expect(fake.calls.find((c) => c.method === 'attachTrack')?.args).toEqual([samples, null]);
  });

  it('reports malformed track samples as a track error instead of dropping them', async () => {
    const good = { frame: 12, values: { '/root/Main/Player:position': { x: 1, y: 2 } } };
    const fake = createProfilerFake({
      trackPending: true,
      replies: { track_stop: JSON.stringify({ samples: [good, { frame: 'bad' }] }) },
    });
    await handleProfileProject(fake.asRunner, { track: ['/root/Main/Player:position'] });

    expect(fake.calls.find((c) => c.method === 'attachTrack')?.args).toEqual([
      null,
      'The bridge returned 1 of 2 track samples in an unrecognized shape',
    ]);
  });

  it.each([
    ['an acknowledgement it does not recognize', '{"status":"ok"}', /unexpected bridge reply/],
    ['something that is not JSON', 'not json', /not JSON/],
  ])('refuses to profile when track_start answers with %s', async (_label, reply, message) => {
    const fake = createProfilerFake({ replies: { track_start: reply } });
    const result = await handleProfileProject(fake.asRunner, { track: ['/root/Main:position'] });

    expectErrorMatching(result, /Could not start the track/);
    expect(JSON.stringify(unwrap(result).content)).toMatch(message);
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses to profile when the bridge will not start the track', async () => {
    const fake = createProfilerFake({
      replies: { track_start: JSON.stringify({ error: 'track[0]: expected NodePath:property' }) },
    });
    const result = await handleProfileProject(fake.asRunner, { track: ['/root/Main:position'] });

    expectErrorMatching(result, /Could not start the track/);
    expect(fake.calls).toHaveLength(0);
  });

  it('stops the bridge track when the capture fails', async () => {
    const fake = createProfilerFake({
      throws: new ProfilerError('profile_timeout', 'Godot sent no profiler frames'),
    });
    const result = await handleProfileProject(fake.asRunner, { track: ['/root/Main:position'] });

    expectErrorMatching(result, /no profiler frames/);
    expect(fake.bridge.map((b) => b.command)).toEqual(['track_start', 'track_stop']);
  });

  it.each([
    ['a capture already running', new ProfilerError('profile_busy', 'A capture is already active')],
    ['a window the profiler rejects', new ProfilerError('bad_args', 'seconds must be in (0, 60]')],
  ])(
    'refuses %s before asking the bridge for a track, leaving the running track alone',
    async (_label, refusal) => {
      const fake = createProfilerFake({ refuses: refusal });
      const result = await handleProfileProject(fake.asRunner, { track: ['/root/Main:position'] });

      expectErrorMatching(result, new RegExp(refusal.message.replace(/[()[\]]/g, '\\$&')));
      // A track_start would have replaced the running capture's track.
      expect(fake.bridge).toHaveLength(0);
      expect(fake.calls).toHaveLength(0);
    },
  );

  it('says so when a long window widens the requested timeline interval', async () => {
    const fake = createProfilerFake();
    const result = await handleProfileProject(fake.asRunner, { seconds: 60, timelineMs: 250 });

    const content = unwrap(result).structuredContent as { warnings?: string[] };
    expect(content.warnings).toEqual([
      expect.stringMatching(/1000 ms intervals, not the requested 250 ms/),
    ]);
  });

  it.each([
    ['a non-boolean visual', { visual: 'yes' }, /visual/],
    ['an interval below the minimum', { timelineMs: 100 }, /Invalid timelineMs/],
    ['a fractional interval', { timelineMs: 250.5 }, /Invalid timelineMs/],
    ['a target frame rate of 0', { targetFps: 0 }, /Invalid targetFps/],
    ['a track entry without a property', { track: ['/root/Main'] }, /Invalid track entry/],
    [
      'more than four tracked values',
      { track: ['/a:x', '/a:y', '/a:z', '/a:w', '/a:v'] },
      /at most 4/,
    ],
  ])('rejects %s before touching the profiler or the bridge', async (_label, args, message) => {
    const fake = createProfilerFake();
    expectErrorMatching(await handleProfileProject(fake.asRunner, args), message);
    expect(fake.calls).toHaveLength(0);
    expect(fake.bridge).toHaveLength(0);
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

    expect(fake.calls[0]).toEqual({ method: 'start', args: [30, 512, PLAIN] });
    expect(unwrap(result).structuredContent).toMatchObject({ active: true, captureLimit: 512 });
  });

  it('accepts captureLimit in snake_case as well as camelCase', async () => {
    const fake = createProfilerFake();
    await handleStartProfiler(fake.asRunner, { seconds: 10, capture_limit: 64 });

    expect(fake.calls[0]).toEqual({ method: 'start', args: [10, 64, PLAIN] });
  });

  it('starts a capture that also records render stages when visual is set', async () => {
    const fake = createProfilerFake();
    await handleStartProfiler(fake.asRunner, { visual: true });

    expect(fake.calls[0]).toEqual({ method: 'start', args: [30, 512, { ...PLAIN, visual: true }] });
  });

  it('starts the bridge track for the whole window before the capture', async () => {
    const fake = createProfilerFake();
    await handleStartProfiler(fake.asRunner, {
      seconds: 20,
      timelineMs: 400,
      track: ['/root/Main/Player:global_position'],
    });

    expect(fake.bridge).toEqual([
      {
        command: 'track_start',
        params: {
          watch: ['/root/Main/Player:global_position'],
          interval_ms: 200,
          max_ms: 30000,
        },
      },
    ]);
    expect(fake.calls[0]?.args[2]).toMatchObject({
      timelineMs: 400,
      track: ['/root/Main/Player:global_position'],
    });
  });

  it('widens a timeline interval a long window cannot hold, and samples the track for it', async () => {
    const fake = createProfilerFake();
    const result = await handleStartProfiler(fake.asRunner, {
      seconds: 60,
      timelineMs: 250,
      track: ['/root/Main/Player:global_position'],
    });

    const content = unwrap(result).structuredContent as {
      timelineMs: number;
      warnings?: string[];
    };
    expect(content.timelineMs).toBe(1000);
    expect(content.warnings).toEqual([
      expect.stringMatching(/1000 ms intervals, not the requested 250 ms/),
    ]);
    // Warnings lead, so a client that cuts a long payload short keeps them.
    expect(Object.keys(content)[0]).toBe('warnings');
    // One sample per interval is all the timeline keeps.
    expect(fake.bridge[0]!.params).toMatchObject({ interval_ms: 250 });
  });

  it('widens the default interval for a long window without warning about it', async () => {
    const fake = createProfilerFake();
    const result = await handleStartProfiler(fake.asRunner, { seconds: 60, timeline: true });

    const content = unwrap(result).structuredContent as { timelineMs: number };
    expect(content.timelineMs).toBe(1000);
    expect(content).not.toHaveProperty('warnings');
  });

  it('explains how to clear an already-running capture', async () => {
    const fake = createProfilerFake({
      throws: new ProfilerError('profile_busy', 'A capture is already active'),
    });
    const result = await handleStartProfiler(fake.asRunner, {});

    expectErrorMatching(result, /already active/);
    expect(unwrap(result).content[1]?.text).toMatch(/stop_profiler/);
  });

  it('refuses a busy profiler before asking the bridge for a track', async () => {
    const fake = createProfilerFake({
      refuses: new ProfilerError('profile_busy', 'A capture is already active'),
    });
    const result = await handleStartProfiler(fake.asRunner, { track: ['/root/Main:position'] });

    expectErrorMatching(result, /already active/);
    expect(fake.bridge).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('handleStopProfiler', () => {
  it('returns the top 20 by own time by default', async () => {
    const fake = createProfilerFake();
    const result = await handleStopProfiler(fake.asRunner, {});

    expect(fake.calls[0]).toEqual({ method: 'stop', args: [20, 'selfMs', expect.any(Function)] });
    expect(fake.bridge).toHaveLength(0);
    expect(unwrap(result).structuredContent).toMatchObject({ sort: 'selfMs' });
  });

  it.each([
    ['ran the whole capture', null, /can show up in frameMs\.max, worstFrame and slowFrames/],
    ['was switched off', 2.5, /switched off 2\.5 s into the capture/],
  ])(
    'says what to do when frames ran out of render timestamp slots and visual %s',
    async (_label, stoppedAt, effect) => {
      const fake = createProfilerFake();
      const profiler = fake.asRunner.activeProfiler as unknown as {
        stop: (...args: unknown[]) => Promise<unknown>;
      };
      profiler.stop = async () => ({
        ...captureResult,
        visual: { frames: 120, truncatedFrames: 30, stoppedAt },
      });
      const result = await handleStopProfiler(fake.asRunner, {});

      const content = unwrap(result).structuredContent as { warnings?: string[] };
      expect(Object.keys(content)[0]).toBe('warnings');
      expect(content.warnings).toHaveLength(1);
      expect(content.warnings![0]).toMatch(/30 of 120 rendered frames/);
      expect(content.warnings![0]).toMatch(effect);
      expect(content.warnings![0]).toMatch(/push earlier lines out of it/);
      expect(content.warnings![0]).toMatch(/max_timestamp_query_elements=4096/);
    },
  );

  it('says a visual section with no usable render frame measured nothing', async () => {
    const fake = createProfilerFake();
    const profiler = fake.asRunner.activeProfiler as unknown as {
      stop: (...args: unknown[]) => Promise<unknown>;
    };
    profiler.stop = async () => ({
      ...captureResult,
      visual: { framesReceived: 3, frames: 0, truncatedFrames: 0, stoppedAt: null },
    });
    const result = await handleStopProfiler(fake.asRunner, {});

    const content = unwrap(result).structuredContent as { warnings?: string[] };
    expect(content.warnings).toEqual([
      expect.stringMatching(/no usable render frames \(3 received/),
    ]);
  });

  const trackedTimeline = (overrides: Record<string, unknown>) => ({
    bucketMs: 500,
    track: ['/root/Main/Player:position', '/root/Main/Typo:position'],
    trackError: null,
    buckets: [],
    ...overrides,
  });

  it.each([
    [
      'a collection error, repeated from the end of the payload',
      trackedTimeline({ trackError: 'The game exited before its track was collected' }),
      /tracked values are missing: The game exited/,
    ],
    [
      'a track none of whose samples landed on an interval',
      trackedTimeline({ buckets: [{ track: null }, { track: null }] }),
      /No track sample landed/,
    ],
    [
      'an entry that was null in every interval',
      trackedTimeline({
        buckets: [
          { track: { '/root/Main/Player:position': { x: 1 }, '/root/Main/Typo:position': null } },
          { track: null },
          { track: { '/root/Main/Player:position': { x: 2 }, '/root/Main/Typo:position': null } },
        ],
      }),
      /null in every interval: \/root\/Main\/Typo:position\./,
    ],
  ])('warns about %s', async (_label, timeline, message) => {
    const fake = createProfilerFake();
    const profiler = fake.asRunner.activeProfiler as unknown as {
      stop: (...args: unknown[]) => Promise<unknown>;
    };
    profiler.stop = async () => ({ ...captureResult, timeline });
    const result = await handleStopProfiler(fake.asRunner, {});

    const content = unwrap(result).structuredContent as { warnings?: string[] };
    expect(content.warnings).toEqual([expect.stringMatching(message)]);
  });

  it('adds no track warning when every entry resolved somewhere', async () => {
    const fake = createProfilerFake();
    const profiler = fake.asRunner.activeProfiler as unknown as {
      stop: (...args: unknown[]) => Promise<unknown>;
    };
    profiler.stop = async () => ({
      ...captureResult,
      timeline: trackedTimeline({
        track: ['/root/Main/Player:position'],
        buckets: [{ track: null }, { track: { '/root/Main/Player:position': { x: 1 } } }],
      }),
    });
    const result = await handleStopProfiler(fake.asRunner, {});

    expect(unwrap(result).structuredContent).not.toHaveProperty('warnings');
  });

  it('warns when fps could not be measured', async () => {
    const fake = createProfilerFake();
    const profiler = fake.asRunner.activeProfiler as unknown as {
      stop: (...args: unknown[]) => Promise<unknown>;
    };
    profiler.stop = async () => ({ ...captureResult, fps: null });
    const result = await handleStopProfiler(fake.asRunner, {});

    const content = unwrap(result).structuredContent as { warnings?: string[] };
    expect(Object.keys(content)[0]).toBe('warnings');
    expect(content.warnings).toEqual([expect.stringMatching(/^fps is null/)]);
  });

  it('warns when no monitor sample arrived', async () => {
    const fake = createProfilerFake();
    const profiler = fake.asRunner.activeProfiler as unknown as {
      stop: (...args: unknown[]) => Promise<unknown>;
    };
    profiler.stop = async () => ({ ...captureResult, monitors: null });
    const result = await handleStopProfiler(fake.asRunner, {});

    const content = unwrap(result).structuredContent as { warnings?: string[] };
    expect(Object.keys(content)[0]).toBe('warnings');
    expect(content.warnings).toEqual([expect.stringMatching(/^monitors is null/)]);
  });

  it('names the monitors that had no finite sample', async () => {
    const fake = createProfilerFake();
    const profiler = fake.asRunner.activeProfiler as unknown as {
      stop: (...args: unknown[]) => Promise<unknown>;
    };
    profiler.stop = async () => ({
      ...captureResult,
      monitors: { ...captureResult.monitors, drawCallsInFrame: null, nodes: null },
    });
    const result = await handleStopProfiler(fake.asRunner, {});

    const content = unwrap(result).structuredContent as { warnings?: string[] };
    expect(content.warnings).toHaveLength(1);
    expect(content.warnings![0]).toMatch(/^Monitors with no finite sample, reported as null:/);
    expect(content.warnings![0]).toContain('nodes');
    expect(content.warnings![0]).toContain('drawCallsInFrame');
  });

  it('adds no warnings to a clean capture', async () => {
    const fake = createProfilerFake();
    const result = await handleStopProfiler(fake.asRunner, {});

    expect(unwrap(result).structuredContent).not.toHaveProperty('warnings');
  });

  it('collects a pending track once the capture has closed', async () => {
    const fake = createProfilerFake({ trackPending: true });
    await handleStopProfiler(fake.asRunner, {});

    expect(fake.bridge.map((b) => b.command)).toEqual(['track_stop']);
    // The bridge's hand-over hitch lands after the capture, not inside it.
    expect(fake.calls.map((c) => c.method)).toEqual(['stop', 'attachTrack']);
  });

  it('keeps the capture when the track cannot be collected, saying why', async () => {
    const fake = createProfilerFake({
      trackPending: true,
      replies: { track_stop: new Error("Command 'track_stop' timed out after 10000ms") },
    });
    const result = await handleStopProfiler(fake.asRunner, {});

    expect(hasError(result)).toBe(false);
    expect(fake.calls[1]).toEqual({
      method: 'attachTrack',
      args: [null, "Command 'track_stop' timed out after 10000ms"],
    });
  });

  it('does not dial the bridge for a track once the game has exited', async () => {
    const fake = createProfilerFake({ exited: true, hasResult: true, trackPending: true });
    const result = await handleStopProfiler(fake.asRunner, {});

    expect(hasError(result)).toBe(false);
    // An exited session has no bridge port; the handler says so itself.
    expect(fake.bridge).toHaveLength(0);
    expect(fake.calls[1]).toEqual({
      method: 'attachTrack',
      args: [null, 'The game exited before its track was collected'],
    });
  });

  it('points at start_profiler when no capture was started', async () => {
    const fake = createProfilerFake({
      throws: new ProfilerError('profile_not_started', 'Start a capture first'),
    });
    const result = await handleStopProfiler(fake.asRunner, {});

    expectErrorMatching(result, /Start a capture first/);
    expect(unwrap(result).content[1]?.text).toMatch(/start_profiler/);
  });

  it('leaves the track uncollected when another session has become current', async () => {
    const fake = createProfilerFake({ trackPending: true });
    const owner = fake.asRunner.activeProfiler as unknown as {
      stop: (...args: unknown[]) => Promise<unknown>;
    };
    const stop = owner.stop;
    owner.stop = async (...args: unknown[]) => {
      // The runtime tools were pointed at another session while this capture closed.
      (fake.asRunner as unknown as { activeProfiler: unknown }).activeProfiler = {
        hasResult: false,
      };
      return stop(...args);
    };
    const result = await handleStopProfiler(fake.asRunner, {});

    expect(hasError(result)).toBe(false);
    // A track_stop here would have gone to the other session's game.
    expect(fake.bridge).toHaveLength(0);
    expect(fake.calls.find((c) => c.method === 'attachTrack')?.args).toEqual([
      null,
      expect.stringMatching(/no longer the current one/),
    ]);
  });
});

describe('profiler handlers: incomplete captures', () => {
  const INCOMPLETE_WARNING = 'The capture is incomplete: Godot did not send its closing totals.';
  const DESCRIPTION_MAX_CHARS = 500;
  const incompleteResult = { ...captureResult, complete: false, warnings: [INCOMPLETE_WARNING] };

  function withIncompleteCapture(): ReturnType<typeof createProfilerFake> {
    const fake = createProfilerFake();
    const profiler = (
      fake.asRunner as unknown as {
        activeProfiler: Record<string, (...args: unknown[]) => Promise<unknown>>;
      }
    ).activeProfiler;
    profiler.stop = async () => incompleteResult;
    profiler.captureWindow = async () => incompleteResult;
    return fake;
  }

  it.each([
    ['profile_project', handleProfileProject],
    ['stop_profiler', handleStopProfiler],
  ])('%s leads its payload with the capture warnings', async (name, handler) => {
    const result = await handler(withIncompleteCapture().asRunner, {});
    const payload = expectMatchesOutputSchema(name, result);
    expect(Object.keys(payload)[0]).toBe('warnings');
    expect(payload.warnings).toEqual([INCOMPLETE_WARNING]);
    expect(payload.complete).toBe(false);
  });

  it('keeps the incomplete warning ahead of everything the handler adds', async () => {
    const TRACK_ERROR = 'The game exited before its track was collected';
    const NO_TIME = { avg: 0, max: 0 };
    const fake = createProfilerFake();
    const profiler = fake.asRunner.activeProfiler as unknown as {
      stop: (...args: unknown[]) => Promise<unknown>;
    };
    profiler.stop = async () => ({
      ...incompleteResult,
      visual: {
        hardware: null,
        framesReceived: 3,
        frames: 0,
        gpuTimed: false,
        truncatedFrames: 0,
        stoppedAt: null,
        cpuMs: NO_TIME,
        gpuMs: NO_TIME,
        areasReceived: 0,
        areas: [],
        worstFrame: null,
      },
      timeline: {
        bucketMs: 500,
        track: ['/root/Main/Player:position'],
        trackError: TRACK_ERROR,
        buckets: [],
      },
    });
    const result = await handleStopProfiler(fake.asRunner, {});

    const payload = expectMatchesOutputSchema('stop_profiler', result);
    expect(payload.complete).toBe(false);
    expect(Object.keys(payload)[0]).toBe('warnings');
    const warnings = payload.warnings as string[];
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toBe(INCOMPLETE_WARNING);
    expect(warnings[1]).toMatch(/no usable render frames/);
    expect(warnings[2]).toMatch(/tracked values are missing: The game exited/);
  });

  it('declares warnings, complete and a nullable percentOfFrame, and names complete in the descriptions', () => {
    for (const name of ['profile_project', 'stop_profiler']) {
      const tool = profilerToolDefinitions.find((t) => t.name === name);
      const schema = tool?.outputSchema as unknown as {
        properties: Record<string, unknown>;
      };
      expect(schema.properties).toHaveProperty('warnings');
      expect(schema.properties.complete).toEqual({ type: 'boolean' });
      const rows = schema.properties.rows as {
        items: { properties: { percentOfFrame: { type: string[] } } };
      };
      expect(rows.items.properties.percentOfFrame.type).toEqual(['number', 'null']);
      expect(tool?.description).toContain('complete');
      expect(tool?.description.length).toBeLessThanOrEqual(DESCRIPTION_MAX_CHARS);
    }
  });
});
