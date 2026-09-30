/**
 * Profiler receiver tests, driven by a fake Godot on the other end of the
 * debugger socket. Everything worth verifying here is protocol behavior -
 * which commands we send, which frames we fold into the totals, and what a
 * dropped or silent debugger turns into: none of which needs a real engine.
 *
 * The frame layout mirrors what Godot 4.6/4.7 actually sends: a frame number,
 * five timing fields, a server count with that many `name, entryCount,
 * ...entries` blocks, then the flattened five-wide function rows behind their
 * length. Visual frames are a frame number, a length, then `name, cpu ms,
 * gpu ms` markers counted from the frame's first one; monitor samples are the
 * `Performance.Monitor` values in enum order, custom monitors last.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as net from 'net';
import { decodeVariant, encodeVariant, type Variant } from '../../src/utils/godot-variant.js';
import {
  DebuggerProfiler,
  ProfilerError,
  timelineBucketMs,
  type TrackCollector,
} from '../../src/utils/profiler.js';

const THREAD = 1;

type Row = [id: number, calls: number, selfSeconds: number, totalSeconds: number];

/** One `servers:profile_frame` payload, optionally preceded by server blocks. */
function frame(
  frameNumber: number,
  frameSeconds: number,
  rows: Row[],
  servers: Array<[string, Array<string | number>]> = [],
): Variant[] {
  const serverBlocks: Variant[] = [];
  for (const [name, entries] of servers) {
    serverBlocks.push(name, entries.length, ...entries);
  }
  const flat: Variant[] = [];
  for (const [id, calls, selfSeconds, totalSeconds] of rows) {
    flat.push(id, calls, selfSeconds, totalSeconds, 0);
  }
  return [
    frameNumber,
    frameSeconds,
    0.001,
    0.001,
    0.016,
    0.001,
    servers.length,
    ...serverBlocks,
    flat.length,
    ...flat,
  ];
}

class FakeGodot {
  readonly commands: Variant[] = [];
  private buffer = Buffer.alloc(0);

  private constructor(private readonly socket: net.Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 4) {
        const size = this.buffer.readUInt32LE(0);
        if (this.buffer.length < 4 + size) return;
        this.commands.push(decodeVariant(this.buffer.subarray(4, 4 + size)));
        this.buffer = this.buffer.subarray(4 + size);
      }
    });
  }

  static connect(port: number): Promise<FakeGodot> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ port, host: '127.0.0.1' }, () => {
        resolve(new FakeGodot(socket));
      });
      socket.once('error', reject);
    });
  }

  send(message: Variant): void {
    this.sendRaw(encodeVariant(message));
  }

  /** A payload built by hand, for encodings `encodeVariant` never produces. */
  sendRaw(raw: Buffer): void {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(raw.length, 0);
    this.socket.write(Buffer.concat([header, raw]));
  }

  /** Commands the profiler sent us, by name. */
  commandsNamed(name: string): Variant[][] {
    return this.commands.filter(
      (c): c is Variant[] => Array.isArray(c) && c[0] === name,
    ) as Variant[][];
  }

  close(): void {
    this.socket.destroy();
  }
}

async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

let profiler: DebuggerProfiler | null = null;
let peer: FakeGodot | null = null;

afterEach(() => {
  peer?.close();
  profiler?.close();
  peer = null;
  profiler = null;
});

/** A profiler with a connected fake engine that has already reported its pid. */
async function connectedProfiler(): Promise<{ profiler: DebuggerProfiler; peer: FakeGodot }> {
  profiler = await DebuggerProfiler.create();
  peer = await FakeGodot.connect(profiler.port);
  peer.send(['set_pid', THREAD, [4242]]);
  await waitUntil(() => profiler!.connected, 'set_pid');
  return { profiler, peer };
}

/** Feed a boundary frame plus `frames`, then resolve the pending start(). */
async function feedStart(
  fake: FakeGodot,
  running: Promise<unknown>,
  frames: Variant[][],
): Promise<void> {
  await waitUntil(() => fake.commandsNamed('profiler:servers').length >= 1, 'profiler enable');
  fake.send(['servers:function_signature', THREAD, ['res://hot.gd::8::_burn', 0]]);
  fake.send(['servers:function_signature', THREAD, ['res://hot.gd::14::_other', 1]]);
  for (const payload of frames) fake.send(['servers:profile_frame', THREAD, payload]);
  await running;
}

describe('DebuggerProfiler capture', () => {
  it('enables the engine profiler with the requested row limit', async () => {
    const { profiler: p, peer: fake } = await connectedProfiler();
    const running = p.start(5, 256);
    await feedStart(fake, running, [frame(10, 0.01, [[0, 1, 0.001, 0.002]]), frame(11, 0.02, [])]);

    expect(fake.commandsNamed('profiler:servers')[0]).toEqual([
      'profiler:servers',
      THREAD,
      [true, [256, false]],
    ]);
    expect(await running).toMatchObject({ active: true, maxSeconds: 5, captureLimit: 256 });
  });

  it('sums received frames, skips the boundary frame, and ranks by own time', async () => {
    const { profiler: p, peer: fake } = await connectedProfiler();
    const running = p.start(5, 512);
    await feedStart(fake, running, [
      // Boundary frame: enabling inside a VM call makes this sample fiction.
      frame(10, 0.5, [[0, 99, 0.5, 0.5]]),
      frame(
        11,
        0.02,
        [
          [0, 2, 0.004, 0.006],
          [1, 1, 0.001, 0.001],
        ],
        [['audio_thread', ['audio_driver_process', 0.002, 'audio_server_process', 0.001]]],
      ),
      // Frame 12 never arrives: one transport gap.
      frame(13, 0.01, [[0, 1, 0.002, 0.003]]),
    ]);

    const stopped = p.stop(10, 'selfMs');
    await waitUntil(() => fake.commandsNamed('profiler:servers').length >= 2, 'profiler disable');
    expect(fake.commandsNamed('profiler:servers')[1]).toEqual([
      'profiler:servers',
      THREAD,
      [false],
    ]);
    fake.send(['servers:profile_total', THREAD, frame(13, 0.01, [])]);
    const result = await stopped;

    expect(result).toMatchObject({
      frames: 2,
      framesReceived: 3,
      firstFrame: 11,
      lastFrame: 13,
      frameGaps: 1,
      limitReached: false,
      functionsReceived: 2,
      unresolvedFunctions: 0,
      sort: 'selfMs',
    });
    const [burn, other] = result.rows;
    expect(burn).toMatchObject({
      function: '_burn',
      file: 'res://hot.gd',
      line: 8,
      calls: 3,
      sourceResolved: true,
    });
    expect(burn!.selfMs).toBeCloseTo(6, 6);
    expect(burn!.totalMs).toBeCloseTo(9, 6);
    expect(burn!.callsPerFrame).toBeCloseTo(1.5, 6);
    expect(burn!.msPerCall).toBeCloseTo(3, 6);
    expect(burn!.peak).toMatchObject({ frame: 11 });
    expect(other!.function).toBe('_other');
    // 4.5 ms of a 15 ms average frame: the editor's "Frame %" measure.
    expect(burn!.percentOfFrame).toBeCloseTo(30, 6);
    expect(result.worstFrame).toMatchObject({ frame: 11 });
    expect(result.worstFrame!.frameMs).toBeCloseTo(20, 6);
    expect(result.worstFrame!.physicsFrameMs).toBeCloseTo(16, 6);
  });

  it('averages the engine frame budget and the server timings over the capture', async () => {
    const { profiler: p, peer: fake } = await connectedProfiler();
    const running = p.start(5, 512);
    await feedStart(fake, running, [
      frame(10, 0.5, [[0, 99, 0.5, 0.5]]),
      frame(
        11,
        0.02,
        [[0, 2, 0.004, 0.006]],
        [['audio_thread', ['audio_driver_process', 0.002, 'audio_server_process', 0.001]]],
      ),
      frame(13, 0.01, [[0, 1, 0.002, 0.003]]),
    ]);
    const stopped = p.stop(10, 'selfMs');
    await waitUntil(() => fake.commandsNamed('profiler:servers').length >= 2, 'profiler disable');
    fake.send(['servers:profile_total', THREAD, frame(13, 0.01, [])]);
    const result = await stopped;

    // Frames 11 (20 ms) and 13 (10 ms); the boundary frame's 500 ms is excluded.
    expect(result.frame.frameMs.avg).toBeCloseTo(15, 6);
    expect(result.frame.frameMs.max).toBeCloseTo(20, 6);
    expect(result.frame.processMs.avg).toBeCloseTo(1, 6);
    expect(result.frame.physicsFrameMs.avg).toBeCloseTo(16, 6);
    expect(result.frame.scriptMs.avg).toBeCloseTo(1, 6);

    // The server block arrived in one of the two frames, so its cost halves.
    expect(result.servers).toHaveLength(1);
    const audio = result.servers[0]!;
    expect(audio.name).toBe('audio_thread');
    expect(audio.msPerFrame).toBeCloseTo(1.5, 6);
    expect(audio.functions.map((f) => f.name)).toEqual([
      'audio_driver_process',
      'audio_server_process',
    ]);
    expect(audio.functions[0]!.msPerFrame).toBeCloseTo(1, 6);
  });

  it('re-reads a finished capture under a different sort', async () => {
    const { profiler: p, peer: fake } = await connectedProfiler();
    const running = p.start(5, 512);
    await feedStart(fake, running, [
      frame(1, 0.01, []),
      frame(
        2,
        0.01,
        [
          [0, 1, 0.005, 0.005],
          [1, 50, 0.001, 0.001],
        ],
        [],
      ),
    ]);
    const stopped = p.stop(10, 'selfMs');
    await waitUntil(() => fake.commandsNamed('profiler:servers').length >= 2, 'profiler disable');
    fake.send(['servers:profile_total', THREAD, frame(2, 0.01, [])]);
    expect((await stopped).rows[0]!.function).toBe('_burn');

    const byCalls = await p.stop(1, 'calls');
    expect(byCalls.rows).toHaveLength(1);
    expect(byCalls.rows[0]!.function).toBe('_other');
  });

  it('reports unresolved signature ids instead of dropping their cost', async () => {
    const { profiler: p, peer: fake } = await connectedProfiler();
    const running = p.start(5, 512);
    await feedStart(fake, running, [frame(1, 0.01, []), frame(2, 0.01, [[77, 1, 0.001, 0.001]])]);
    const stopped = p.stop(10, 'selfMs');
    await waitUntil(() => fake.commandsNamed('profiler:servers').length >= 2, 'profiler disable');
    fake.send(['servers:profile_total', THREAD, frame(2, 0.01, [])]);
    const result = await stopped;

    expect(result.unresolvedFunctions).toBe(1);
    expect(result.rows[0]).toMatchObject({ signature: '<unresolved:77>', sourceResolved: false });
  });

  it('flags a capture that hit the engine row limit', async () => {
    const { profiler: p, peer: fake } = await connectedProfiler();
    const running = p.start(5, 16);
    const rows: Row[] = Array.from({ length: 16 }, (_, i) => [i, 1, 0.001, 0.001]);
    await feedStart(fake, running, [frame(1, 0.01, []), frame(2, 0.01, rows)]);
    const stopped = p.stop(10, 'totalMs');
    await waitUntil(() => fake.commandsNamed('profiler:servers').length >= 2, 'profiler disable');
    fake.send(['servers:profile_total', THREAD, frame(2, 0.01, [])]);

    expect((await stopped).limitReached).toBe(true);
  });

  it('stops itself at the time limit without a stop_profiler call', async () => {
    const { profiler: p, peer: fake } = await connectedProfiler();
    const running = p.start(0.2, 512);
    await feedStart(fake, running, [frame(1, 0.01, []), frame(2, 0.01, [[0, 1, 0.001, 0.001]])]);

    await waitUntil(() => fake.commandsNamed('profiler:servers').length >= 2, 'automatic stop');
    fake.send(['servers:profile_total', THREAD, frame(2, 0.01, [])]);
    expect((await p.stop(10, 'selfMs')).frames).toBe(1);
  });

  it('resumes the game when Godot breaks on an error or breakpoint', async () => {
    const { peer: fake } = await connectedProfiler();
    fake.send(['debug_enter', THREAD, [false, 'Cannot call method on a null value.', true, 1]]);

    await waitUntil(() => fake.commandsNamed('continue').length === 1, 'continue');
    expect(fake.commandsNamed('continue')[0]).toEqual(['continue', THREAD, []]);
  });
});

describe('DebuggerProfiler error contract', () => {
  it('refuses a second capture while one is active', async () => {
    const { profiler: p, peer: fake } = await connectedProfiler();
    const running = p.start(5, 512);
    await feedStart(fake, running, [frame(1, 0.01, []), frame(2, 0.01, [[0, 1, 0.001, 0.001]])]);

    await expect(p.start(5, 512)).rejects.toMatchObject({ code: 'profile_busy' });
  });

  it('refuses to stop a capture that was never started', async () => {
    const { profiler: p } = await connectedProfiler();
    await expect(p.stop(10, 'selfMs')).rejects.toMatchObject({ code: 'profile_not_started' });
  });

  it.each([
    ['seconds of 0', 0, 512, 10],
    ['seconds beyond the 60s ceiling', 61, 512, 10],
    ['a capture limit below the engine range', 5, 8, 10],
    ['a capture limit above the engine range', 5, 1024, 10],
  ])('rejects %s', async (_label, seconds, limit) => {
    const { profiler: p } = await connectedProfiler();
    await expect(p.start(seconds, limit)).rejects.toMatchObject({ code: 'bad_args' });
  });

  it.each([
    ['top below 1', 0, 'selfMs'],
    ['top above 100', 101, 'selfMs'],
    ['an unknown sort key', 10, 'wallMs'],
  ])('rejects %s', async (_label, top, sort) => {
    const { profiler: p } = await connectedProfiler();
    await expect(p.stop(top, sort as 'selfMs')).rejects.toBeInstanceOf(ProfilerError);
  });

  it('times out when Godot never sends a frame', async () => {
    profiler = await DebuggerProfiler.create();
    await expect(profiler.start(5, 512)).rejects.toMatchObject({ code: 'profile_timeout' });
  }, 10000);

  it('surfaces a dropped debugger connection as a disconnect', async () => {
    const { profiler: p, peer: fake } = await connectedProfiler();
    const running = p.start(5, 512);
    await feedStart(fake, running, [frame(1, 0.01, []), frame(2, 0.01, [[0, 1, 0.001, 0.001]])]);

    const stopped = p.stop(10, 'selfMs');
    fake.close();
    await expect(stopped).rejects.toMatchObject({ code: 'profile_disconnected' });
  });
});

describe('DebuggerProfiler capture quality signals', () => {
  it('reports truncation from the rows the engine sent, not the rows we kept', async () => {
    const { profiler: p, peer: fake } = await connectedProfiler();
    const running = p.start(5, 16);
    // 16 raw rows is the cap the engine was given, but half report no calls and
    // get filtered: the truncation is real even though `rows` comes back short.
    const rows: Row[] = [];
    for (let i = 0; i < 16; i++) rows.push([i, i % 2 === 0 ? 0 : 3, 0.001, 0.002]);
    await feedStart(fake, running, [
      frame(1, 0.016, [[0, 1, 0.001, 0.002]]),
      frame(2, 0.016, rows),
    ]);

    fake.send(['servers:profile_total', THREAD, frame(3, 0.016, [])]);
    const result = await p.stop(10, 'selfMs');
    expect(result.limitReached).toBe(true);
  });

  it('does not report truncation from the discarded boundary frame', async () => {
    const { profiler: p, peer: fake } = await connectedProfiler();
    const running = p.start(5, 16);
    // The boundary frame is at the cap, but its numbers are thrown away, so the
    // truncation it reports describes data no result ever contains.
    const atCap: Row[] = [];
    for (let i = 0; i < 16; i++) atCap.push([i, 5, 0.001, 0.002]);
    await feedStart(fake, running, [
      frame(1, 0.016, atCap),
      frame(2, 0.016, [[0, 5, 0.001, 0.002]]),
    ]);

    fake.send(['servers:profile_total', THREAD, frame(3, 0.016, [])]);
    const result = await p.stop(10, 'selfMs');
    expect(result.limitReached).toBe(false);
  });

  it('does not report truncation from the totals packet', async () => {
    const { profiler: p, peer: fake } = await connectedProfiler();
    const running = p.start(5, 16);
    await feedStart(fake, running, [
      frame(1, 0.016, [[0, 1, 0.001, 0.002]]),
      frame(2, 0.016, [[0, 5, 0.001, 0.002]]),
    ]);

    // The engine's totals list every function it saw all session. That row
    // count hitting the limit says nothing about any one frame being cut.
    const allSession: Row[] = [];
    for (let i = 0; i < 16; i++) allSession.push([i, 5, 0.001, 0.002]);
    fake.send(['servers:profile_total', THREAD, frame(3, 0.016, allSession)]);
    const result = await p.stop(10, 'selfMs');
    expect(result.limitReached).toBe(false);
  });

  it('refuses to summarize a capture that folded no frames', async () => {
    const { profiler: p, peer: fake } = await connectedProfiler();
    const running = p.start(5, 512);
    await waitUntil(() => fake.commandsNamed('profiler:servers').length >= 1, 'profiler enable');
    // Only the boundary frame arrives, so nothing survives the discard. An
    // all-zero payload here would read as "nothing in this game is slow".
    fake.send(['servers:profile_frame', THREAD, frame(1, 0.016, [[0, 1, 0.001, 0.002]])]);
    fake.send(['servers:profile_total', THREAD, frame(2, 0.016, [])]);
    await running;

    await expect(p.stop(10, 'selfMs')).rejects.toMatchObject({ code: 'profile_no_frames' });
  });

  it('rejects a frame whose counts are not whole numbers', async () => {
    const { profiler: p, peer: fake } = await connectedProfiler();
    const running = p.start(5, 512);
    await waitUntil(() => fake.commandsNamed('profiler:servers').length >= 1, 'profiler enable');
    // A layout shift lands a timing value where the server count belongs.
    const malformed = frame(1, 0.016, [[0, 1, 0.001, 0.002]]);
    malformed[6] = 0.016;
    fake.send(['servers:profile_frame', THREAD, malformed]);

    await expect(running).rejects.toMatchObject({ code: 'profile_bad_frame' });
  });
});

describe('DebuggerProfiler readability after the engine goes away', () => {
  it('keeps a finished capture readable and re-rankable', async () => {
    const { profiler: p, peer: fake } = await connectedProfiler();
    const running = p.start(5, 512);
    await feedStart(fake, running, [
      frame(1, 0.016, [[0, 1, 0.001, 0.002]]),
      frame(2, 0.016, [
        [0, 3, 0.009, 0.012],
        [1, 9, 0.001, 0.004],
      ]),
    ]);
    fake.send(['servers:profile_total', THREAD, frame(3, 0.016, [])]);
    await p.stop(10, 'selfMs');

    expect(p.hasResult).toBe(true);
    // The peer dropping is exactly the post-crash case worth reading back.
    fake.close();
    await waitUntil(() => !p.connected, 'peer disconnect');
    const reread = await p.stop(1, 'calls');
    expect(p.hasResult).toBe(true);
    expect(reread.rows[0]?.function).toBe('_other');
  });

  it('ignores a second totals packet instead of corrupting the result', async () => {
    const { profiler: p, peer: fake } = await connectedProfiler();
    const running = p.start(5, 512);
    await feedStart(fake, running, [
      frame(1, 0.016, [[0, 1, 0.001, 0.002]]),
      frame(2, 0.016, [[0, 4, 0.008, 0.01]]),
    ]);
    fake.send(['servers:profile_total', THREAD, frame(3, 0.016, [])]);
    const first = await p.stop(10, 'selfMs');

    fake.send(['servers:profile_total', THREAD, frame(4, 0.016, [[0, 999, 9, 9]])]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await p.stop(10, 'selfMs');
    expect(second.rows[0]?.calls).toBe(first.rows[0]?.calls);
  });

  it('answers a mid-capture debug_enter without disturbing the capture', async () => {
    const { profiler: p, peer: fake } = await connectedProfiler();
    const running = p.start(5, 512);
    await waitUntil(() => fake.commandsNamed('profiler:servers').length >= 1, 'profiler enable');
    fake.send(['servers:function_signature', THREAD, ['res://hot.gd::8::_burn', 0]]);
    fake.send(['servers:profile_frame', THREAD, frame(1, 0.016, [[0, 1, 0.001, 0.002]])]);
    // A script error mid-capture must resume the game, not strand the capture.
    fake.send(['debug_enter', THREAD, [true, 'Breakpoint']]);
    fake.send(['servers:profile_frame', THREAD, frame(2, 0.016, [[0, 6, 0.006, 0.009]])]);
    await running;

    fake.send(['servers:profile_total', THREAD, frame(3, 0.016, [])]);
    const result = await p.stop(10, 'selfMs');
    await waitUntil(() => fake.commandsNamed('continue').length === 1, 'continue reply');
    expect(result.frames).toBe(1);
    expect(result.rows[0]?.calls).toBe(6);
  });
});

describe('DebuggerProfiler concurrent starts', () => {
  it('lets only one of two starts that arrive together open a capture', async () => {
    const { profiler: p, peer: fake } = await connectedProfiler();
    // Both calls pass the first busy check before either has opened anything.
    const first = p.start(5, 512, { visual: true });
    const second = p.start(5, 512);
    await expect(second).rejects.toMatchObject({ code: 'profile_busy' });
    await feedStart(fake, first, [frame(1, 0.016, []), frame(2, 0.016, [])]);
    expect(await first).toMatchObject({ active: true, visual: true });

    const result = await stopCapture(p, fake);
    expect(result.frames).toBe(1);
    expect(fake.commandsNamed('profiler:servers').map((c) => c[2])).toEqual([
      [true, [512, false]],
      [false],
    ]);
    await waitUntil(() => fake.commandsNamed('profiler:visual').length >= 2, 'visual disable');
    expect(fake.commandsNamed('profiler:visual').map((c) => c[2])).toEqual([[true], [false]]);
  });
});

type Marker = [name: string, cpuMs: number, gpuMs: number];

/** One `visual:profile_frame` payload. */
function visualFrame(frameNumber: number, markers: Marker[]): Variant[] {
  return [frameNumber, markers.length * 3, ...markers.flat()];
}

/** A stage's path: its groups and its own name, outermost first. */
const path = (...names: string[]): string => names.join(' > ');

/**
 * A Forward+-shaped frame: cumulative timestamps, groups bracketed by
 * `>name` / `<name`. Stage times are the gaps to the next marker. The shadow
 * stage carries the engine's real name, slash included.
 */
const RENDER_FRAME: Marker[] = [
  ['Frame Begin', 0, 0],
  ['Prepare Render Frame', 0, 0],
  ['> Render Viewports', 0.1, 0],
  ['> Render Viewport 0', 0.2, 0],
  ['> Render 3D Scene', 0.3, 0.1],
  ['Render Directional/SpotLight Shadows', 0.4, 0.2],
  ['Render Opaque Pass', 0.6, 1.2],
  ['< Render 3D Scene', 1.0, 3.2],
  ['Cull 2D Lights', 1.0, 3.2],
  ['< Render Viewport 0', 1.5, 3.5],
  ['< Render Viewports', 1.6, 3.6],
];

/** A whole frame an order of magnitude slower than RENDER_FRAME. */
const STALE_FRAME: Marker[] = RENDER_FRAME.map(([name, cpu, gpu]) => [name, cpu * 10, gpu * 10]);

/** A frame that ran out of timestamp slots inside a group: its close never came. */
const CUT_FRAME: Marker[] = [
  ['Frame Begin', 0, 0],
  ['> Render Viewports', 0.1, 0],
  ['Render Canvas', 0.2, 0],
  ['Render Canvas Items', 0.9, 0],
];

/** What the Compatibility renderer hands back right after the profiler turns on. */
const WARMUP_FRAME: Marker[] = [
  ['Internal Begin', 0, 0],
  ['Internal End', 3.4, 4],
];

/**
 * The five frames every enable hands back first. The receiver skips them
 * whatever they hold, so they are sent here as heavy, realistic-looking
 * frames: any of them leaking into a result would show.
 */
function sendSettleFrames(fake: FakeGodot, firstNumber = 30): void {
  for (let i = 0; i < 5; i++) {
    fake.send(['visual:profile_frame', THREAD, visualFrame(firstNumber + i, STALE_FRAME)]);
  }
}

/** Open a visual capture, feed it `frames` after the settle frames, and stop it. */
async function visualCapture(
  frames: Variant[][],
  top = 100,
): Promise<Awaited<ReturnType<DebuggerProfiler['stop']>>> {
  const { profiler: p, peer: fake } = await connectedProfiler();
  const running = p.start(5, 512, { visual: true });
  await waitUntil(() => fake.commandsNamed('profiler:visual').length >= 1, 'visual enable');
  sendSettleFrames(fake);
  for (const payload of frames) fake.send(['visual:profile_frame', THREAD, payload]);
  await feedStart(fake, running, [frame(1, 0.016, []), frame(2, 0.016, [])]);
  return stopCapture(p, fake, top);
}

/** Stop a running capture and answer it with the engine's closing totals. */
async function stopCapture(
  p: DebuggerProfiler,
  fake: FakeGodot,
  top = 10,
  collect?: TrackCollector,
): Promise<Awaited<ReturnType<DebuggerProfiler['stop']>>> {
  const disabled = fake.commandsNamed('profiler:servers').length + 1;
  const stopped = p.stop(top, 'selfMs', collect);
  await waitUntil(
    () => fake.commandsNamed('profiler:servers').length >= disabled,
    'profiler disable',
  );
  fake.send(['servers:profile_total', THREAD, frame(99, 0.016, [])]);
  return stopped;
}

describe('DebuggerProfiler visual capture', () => {
  it('turns the visual profiler on only when asked, and off with the capture', async () => {
    const { profiler: p, peer: fake } = await connectedProfiler();
    const running = p.start(5, 512, { visual: true });
    await feedStart(fake, running, [frame(1, 0.016, []), frame(2, 0.016, [])]);
    expect(await running).toMatchObject({ active: true, visual: true });
    expect(fake.commandsNamed('profiler:visual')).toEqual([['profiler:visual', THREAD, [true]]]);

    await stopCapture(p, fake);
    await waitUntil(() => fake.commandsNamed('profiler:visual').length >= 2, 'visual disable');
    expect(fake.commandsNamed('profiler:visual')[1]).toEqual(['profiler:visual', THREAD, [false]]);
  });

  it('leaves the visual profiler alone for a plain capture and reports no visual section', async () => {
    const { profiler: p, peer: fake } = await connectedProfiler();
    const running = p.start(5, 512);
    await feedStart(fake, running, [frame(1, 0.016, []), frame(2, 0.016, [])]);
    // A stray visual frame (even a malformed one) must not reach a plain capture.
    fake.send(['visual:profile_frame', THREAD, [3, 7]]);
    const result = await stopCapture(p, fake);

    expect(fake.commandsNamed('profiler:visual')).toHaveLength(0);
    expect(result.visual).toBeNull();
  });

  it('skips the frames a fresh enable hands back, then any timed while profiling was off', async () => {
    const result = await visualCapture([
      visualFrame(40, WARMUP_FRAME),
      visualFrame(41, RENDER_FRAME),
    ]);

    expect(result.visual).toMatchObject({ framesReceived: 7, frames: 1 });
    // None of the heavy settle frames reached the numbers.
    expect(result.visual!.cpuMs.max).toBeCloseTo(1.6, 6);
  });

  it('turns markers into stage times, group spans and uncovered (other) time', async () => {
    const { profiler: p, peer: fake } = await connectedProfiler();
    const running = p.start(5, 512, { visual: true });
    await waitUntil(() => fake.commandsNamed('profiler:visual').length >= 1, 'visual enable');
    fake.send(['visual:hardware_info', THREAD, ['Test CPU', 'Test GPU']]);
    sendSettleFrames(fake);
    fake.send(['visual:profile_frame', THREAD, visualFrame(41, RENDER_FRAME)]);
    await feedStart(fake, running, [frame(1, 0.016, []), frame(2, 0.016, [])]);
    const result = await stopCapture(p, fake, 100);

    const visual = result.visual!;
    expect(visual).toMatchObject({
      hardware: { cpu: 'Test CPU', gpu: 'Test GPU' },
      frames: 1,
      gpuTimed: true,
    });
    expect(visual.cpuMs.avg).toBeCloseTo(1.6, 6);
    expect(visual.gpuMs.max).toBeCloseTo(3.6, 6);

    const area = (stagePath: string) => {
      const found = visual.areas.find((a) => a.path === stagePath);
      expect(
        found,
        `no ${stagePath} in ${visual.areas.map((a) => a.path).join(', ')}`,
      ).toBeDefined();
      return found!;
    };
    // A group spans its own markers and says so.
    const scene = area(path('Render Viewports', 'Render Viewport 0', 'Render 3D Scene'));
    expect(scene.group).toBe(true);
    expect(scene.cpuMs.avg).toBeCloseTo(0.7, 6);
    expect(scene.gpuMs.avg).toBeCloseTo(3.1, 6);
    // A stage runs until the next marker, whatever kind that marker is.
    const opaque = area(
      path('Render Viewports', 'Render Viewport 0', 'Render 3D Scene', 'Render Opaque Pass'),
    );
    expect(opaque).toMatchObject({ name: 'Render Opaque Pass', group: false, frames: 1 });
    expect(opaque.cpuMs.avg).toBeCloseTo(0.4, 6);
    expect(opaque.gpuMs.avg).toBeCloseTo(2, 6);
    // A slash in an engine stage name is part of the name, not a level.
    const shadows = area(
      path(
        'Render Viewports',
        'Render Viewport 0',
        'Render 3D Scene',
        'Render Directional/SpotLight Shadows',
      ),
    );
    expect(shadows.gpuMs.avg).toBeCloseTo(1, 6);
    // The time a group's children leave uncovered is surfaced, not dropped.
    const other = area(path('Render Viewports', 'Render Viewport 0', '(other)'));
    expect(other.cpuMs.avg).toBeCloseTo(0.1, 6);
    expect(other.gpuMs.avg).toBeCloseTo(0.1, 6);
    expect(area('Prepare Render Frame').cpuMs.avg).toBeCloseTo(0.1, 6);
    // The timeline's own start marker is not a stage.
    expect(visual.areas.some((a) => a.name === 'Frame Begin')).toBe(false);
    // Ranked by the heavier of the two timelines, so the outermost group leads.
    expect(visual.areas[0]!.path).toBe('Render Viewports');
  });

  it('counts a draw the engine re-sends while nothing new is drawn only once', async () => {
    // A minimized window re-sends the last drawn frame under the same number.
    const result = await visualCapture([
      visualFrame(41, RENDER_FRAME),
      visualFrame(41, RENDER_FRAME),
      visualFrame(41, RENDER_FRAME),
      visualFrame(42, RENDER_FRAME),
    ]);

    expect(result.visual).toMatchObject({ framesReceived: 9, frames: 2 });
  });

  it('keeps the slowest rendered frame with its stages, not its groups', async () => {
    // Every GPU timestamp doubles, so each GPU gap doubles with it.
    const slow: Marker[] = RENDER_FRAME.map(([name, cpu, gpu]) => [name, cpu, gpu * 2]);
    const result = await visualCapture([visualFrame(41, RENDER_FRAME), visualFrame(42, slow)], 3);

    const visual = result.visual!;
    expect(visual.frames).toBe(2);
    expect(visual.worstFrame).toMatchObject({ frame: 42 });
    expect(visual.worstFrame!.gpuMs).toBeCloseTo(7.2, 6);
    expect(visual.worstFrame!.areas.some((a) => a.path.endsWith('Render 3D Scene'))).toBe(false);
    expect(visual.worstFrame!.areas[0]!.path).toBe(
      path('Render Viewports', 'Render Viewport 0', 'Render 3D Scene', 'Render Opaque Pass'),
    );
    expect(visual.worstFrame!.areas[0]!.gpuMs).toBeCloseTo(4, 6);
    // `top` caps the list; `areasReceived` says how long it was.
    expect(visual.areas).toHaveLength(3);
    expect(visual.areasReceived).toBeGreaterThan(3);
  });

  it('says so when the renderer timed no GPU work', async () => {
    const cpuOnly: Marker[] = RENDER_FRAME.map(([name, cpu]) => [name, cpu, 0]);
    const result = await visualCapture([visualFrame(41, cpuOnly)]);

    expect(result.visual).toMatchObject({ frames: 1, gpuTimed: false });
    expect(result.visual!.gpuMs.max).toBe(0);
  });

  it('keeps a group the engine re-opens as a sibling of its first pass, not its child', async () => {
    // The engine opens the 2D directional shadow group once per light but
    // closes it once, after the loop.
    const twoLights: Marker[] = [
      ['Frame Begin', 0, 0],
      ['> Render Viewport 0', 0.1, 0],
      ['> Render DirectionalLight2D Shadows', 0.2, 0],
      ['> Render DirectionalLight2D Shadows', 0.3, 0],
      ['< Render DirectionalLight2D Shadows', 0.35, 0],
      ['> Render Canvas 0', 0.4, 0],
      ['< Render Canvas 0', 0.6, 0],
      ['< Render Viewport 0', 4, 0],
    ];
    const result = await visualCapture([visualFrame(41, twoLights)]);

    const visual = result.visual!;
    expect(visual.truncatedFrames).toBe(0);
    const at = (...names: string[]) => visual.areas.find((a) => a.path === path(...names));
    // Both passes, under the viewport, as one row.
    const shadows = at('Render Viewport 0', 'Render DirectionalLight2D Shadows');
    expect(shadows?.cpuMs.avg).toBeCloseTo(0.15, 6);
    // The canvas is the shadows' sibling, and the swap stays the viewport's.
    expect(at('Render Viewport 0', 'Render Canvas 0')?.cpuMs.avg).toBeCloseTo(0.2, 6);
    expect(at('Render Viewport 0', '(other)')?.cpuMs.avg).toBeCloseTo(3.55, 6);
    expect(visual.areas.some((a) => a.path.includes('Shadows > Render'))).toBe(false);
  });

  it('switches the visual profiler off when frames keep running out of timestamp slots', async () => {
    const { profiler: p, peer: fake } = await connectedProfiler();
    const running = p.start(5, 512, { visual: true });
    await waitUntil(() => fake.commandsNamed('profiler:visual').length >= 1, 'visual enable');
    sendSettleFrames(fake);
    await feedStart(fake, running, [frame(1, 0.016, []), frame(2, 0.016, [])]);
    fake.send(['visual:profile_frame', THREAD, visualFrame(41, CUT_FRAME)]);
    // A whole frame in between: one cut frame alone does not switch it off.
    fake.send(['visual:profile_frame', THREAD, visualFrame(42, RENDER_FRAME)]);
    for (let n = 43; n <= 45; n++) {
      fake.send(['visual:profile_frame', THREAD, visualFrame(n, CUT_FRAME)]);
    }
    await waitUntil(() => fake.commandsNamed('profiler:visual').length >= 2, 'visual switch-off');
    // A frame already on its way when it was switched off goes with it.
    fake.send(['visual:profile_frame', THREAD, visualFrame(46, CUT_FRAME)]);
    const result = await stopCapture(p, fake);

    expect(result.visual).toMatchObject({ frames: 5, truncatedFrames: 4 });
    expect(result.visual!.stoppedAt).not.toBeNull();
    // Switched off once: the capture's own stop does not repeat it.
    expect(fake.commandsNamed('profiler:visual').map((c) => c[2])).toEqual([[true], [false]]);
  });

  it('keeps the visual profiler on for the whole capture when no frame is cut', async () => {
    const result = await visualCapture([
      visualFrame(41, RENDER_FRAME),
      visualFrame(42, RENDER_FRAME),
      visualFrame(43, RENDER_FRAME),
    ]);

    expect(result.visual).toMatchObject({ frames: 3, truncatedFrames: 0, stoppedAt: null });
  });

  it('survives a stray close marker and closes a group left open at the end', async () => {
    const unbalanced: Marker[] = [
      ['Frame Begin', 0, 0],
      ['> Render Viewports', 0.1, 0],
      ['< Not Open', 0.2, 0],
      ['Render Canvas', 0.2, 0],
      ['Frame End', 1.1, 0],
    ];
    const result = await visualCapture([visualFrame(41, unbalanced)]);

    // A group the frame never closed means the renderer ran out of slots.
    expect(result.visual!.truncatedFrames).toBe(1);
    const areas = result.visual!.areas;
    expect(areas.find((a) => a.path === 'Render Viewports')?.cpuMs.avg).toBeCloseTo(1, 6);
    const canvas = areas.find((a) => a.path === path('Render Viewports', 'Render Canvas'));
    expect(canvas?.cpuMs.avg).toBeCloseTo(0.9, 6);
  });

  it('starts a second visual capture from scratch', async () => {
    const { profiler: p, peer: fake } = await connectedProfiler();
    const running = p.start(5, 512, { visual: true });
    await waitUntil(() => fake.commandsNamed('profiler:visual').length >= 1, 'visual enable');
    sendSettleFrames(fake);
    fake.send(['visual:profile_frame', THREAD, visualFrame(41, STALE_FRAME)]);
    await feedStart(fake, running, [frame(1, 0.016, []), frame(2, 0.016, [])]);
    expect((await stopCapture(p, fake)).visual!.frames).toBe(1);

    const again = p.start(5, 512, { visual: true });
    await waitUntil(() => fake.commandsNamed('profiler:visual').length >= 3, 'visual re-enable');
    // A capture right after another gets the previous one's frames back first,
    // under fresh numbers: the settle frames stand for exactly that.
    sendSettleFrames(fake, 50);
    fake.send(['visual:profile_frame', THREAD, visualFrame(60, RENDER_FRAME)]);
    fake.send(['servers:profile_frame', THREAD, frame(10, 0.016, [])]);
    fake.send(['servers:profile_frame', THREAD, frame(11, 0.016, [])]);
    await again;
    const result = await stopCapture(p, fake);

    expect(result.visual).toMatchObject({ framesReceived: 6, frames: 1 });
    expect(result.visual!.cpuMs.max).toBeCloseTo(1.6, 6);
    await waitUntil(() => fake.commandsNamed('profiler:visual').length >= 4, 'visual disable');
    expect(fake.commandsNamed('profiler:visual').map((c) => c[2])).toEqual([
      [true],
      [false],
      [true],
      [false],
    ]);
  });

  it('turns the visual profiler off when the profiler closes mid-capture', async () => {
    const { profiler: p, peer: fake } = await connectedProfiler();
    const running = p.start(5, 512, { visual: true });
    await feedStart(fake, running, [frame(1, 0.016, []), frame(2, 0.016, [])]);
    p.close();

    await waitUntil(() => fake.commandsNamed('profiler:visual').length >= 2, 'visual disable');
    expect(fake.commandsNamed('profiler:visual')[1]).toEqual(['profiler:visual', THREAD, [false]]);
  });

  it('rejects a visual frame whose marker block does not fill the packet', async () => {
    const { profiler: p, peer: fake } = await connectedProfiler();
    const running = p.start(5, 512, { visual: true });
    await waitUntil(() => fake.commandsNamed('profiler:visual').length >= 1, 'visual enable');
    fake.send(['visual:profile_frame', THREAD, [41, 6, 'Frame Begin', 0, 0]]);

    await expect(running).rejects.toMatchObject({ code: 'profile_bad_frame' });
  });

  it('rejects a visual timestamp that is not a finite number', async () => {
    const { profiler: p, peer: fake } = await connectedProfiler();
    const running = p.start(5, 512, { visual: true });
    await waitUntil(() => fake.commandsNamed('profiler:visual').length >= 1, 'visual enable');
    // NaN would serialize as null and break the output schema.
    fake.send(['visual:profile_frame', THREAD, visualFrame(41, [['Frame Begin', NaN, 0]])]);

    await expect(running).rejects.toMatchObject({ code: 'profile_bad_frame' });
  });
});

/** A `performance:profile_frame`: `length` built-in monitors, then `custom` values. */
function monitorSample(
  values: Record<number, number>,
  length = 59,
  custom: Array<number | null> = [],
): Variant[] {
  const builtin: Variant[] = Array.from({ length }, (_, i) => values[i] ?? 0);
  return [...builtin, ...custom];
}

/**
 * Wait until every message sent so far has been handled: the break round
 * trip comes back only after the packets queued ahead of it.
 */
async function drain(fake: FakeGodot): Promise<void> {
  const answered = fake.commandsNamed('continue').length + 1;
  fake.send(['debug_enter', THREAD, [false, 'barrier', true, 1]]);
  await waitUntil(() => fake.commandsNamed('continue').length >= answered, 'barrier');
}

/** Open a plain capture, feed it `samples` as monitor packets, and stop it. */
async function monitorCapture(
  samples: Variant[][],
  before: (fake: FakeGodot) => Promise<void> = async () => {},
): Promise<Awaited<ReturnType<DebuggerProfiler['stop']>>> {
  const { profiler: p, peer: fake } = await connectedProfiler();
  await before(fake);
  const running = p.start(5, 512);
  await feedStart(fake, running, [frame(1, 0.016, []), frame(2, 0.016, [])]);
  for (const sample of samples) fake.send(['performance:profile_frame', THREAD, sample]);
  return stopCapture(p, fake);
}

describe('DebuggerProfiler monitors', () => {
  const MIB = 1024 * 1024;

  it('summarizes the monitors sampled while the capture was open', async () => {
    const result = await monitorCapture(
      [
        monitorSample({ 9: 100, 13: 10, 14: 64 * MIB, 34: 2, 36: 3 }),
        monitorSample({ 9: 104, 13: 30, 14: 128 * MIB, 34: 2, 36: 10 }),
      ],
      async (fake) => {
        // Sampled before the capture: not part of it, but its compilation
        // total is where the capture's count starts.
        fake.send(['performance:profile_frame', THREAD, monitorSample({ 13: 999, 34: 1, 36: 1 })]);
        await drain(fake);
      },
    );

    const monitors = result.monitors!;
    expect(monitors.samples).toBe(2);
    expect(monitors.drawCallsInFrame).toEqual({ avg: 20, min: 10, max: 30 });
    expect(monitors.videoMemMiB).toEqual({ avg: 96, min: 64, max: 128 });
    expect(monitors.nodes).toEqual({ avg: 102, min: 100, max: 104 });
    expect(monitors.pipelineCompilations).toEqual({ duringCapture: 10, total: 12 });
    expect(monitors.custom).toEqual([]);
  });

  it('counts compilations in a one-sample capture from the sample before it', async () => {
    const result = await monitorCapture([monitorSample({ 35: 45 })], async (fake) => {
      fake.send(['performance:profile_frame', THREAD, monitorSample({ 35: 40 })]);
      await drain(fake);
    });

    expect(result.monitors!.pipelineCompilations).toEqual({ duringCapture: 5, total: 45 });
  });

  it('does not claim zero compilations when nothing precedes a lone sample', async () => {
    const result = await monitorCapture([monitorSample({ 35: 40 })]);

    expect(result.monitors!.pipelineCompilations).toEqual({ duringCapture: null, total: 40 });
  });

  it('returns null monitors when no sample arrived during the capture', async () => {
    expect((await monitorCapture([])).monitors).toBeNull();
  });

  it('leaves out pipeline compilations on builds that predate them', async () => {
    // Godot 4.0-4.3 send 33 built-in monitors.
    const result = await monitorCapture([monitorSample({ 13: 5 }, 33)]);

    expect(result.monitors!.drawCallsInFrame.avg).toBe(5);
    expect(result.monitors!.pipelineCompilations).toBeNull();
  });

  it.each([
    ['4.0-4.5 shape (the names alone)', (names: string[]): Variant => names],
    ['4.6+ shape (names, then types)', (names: string[]): Variant => [names, names.map(() => 0)]],
  ])('reads custom monitors by name from the %s', async (_label, payload) => {
    const result = await monitorCapture(
      [monitorSample({ 13: 4 }, 59, [10, 200]), monitorSample({ 13: 4 }, 59, [30, null])],
      async (fake) => {
        // Names arrive when the set changes, usually before any capture opens.
        fake.send(['performance:profile_names', THREAD, payload(['game/enemies', 'game/bullets'])]);
      },
    );

    expect(result.monitors!.drawCallsInFrame.avg).toBe(4);
    expect(result.monitors!.custom).toEqual([
      { name: 'game/enemies', avg: 20, min: 10, max: 30 },
      { name: 'game/bullets', avg: 200, min: 200, max: 200 },
    ]);
  });

  it('reads custom monitor names sent as a typed array, as the engine sends them', async () => {
    const result = await monitorCapture([monitorSample({}, 59, [7])], async (fake) => {
      // ["performance:profile_names", THREAD, TypedArray<StringName>["game/enemies"]]
      const u32 = (value: number): Buffer => {
        const buf = Buffer.alloc(4);
        buf.writeUInt32LE(value, 0);
        return buf;
      };
      const name = Buffer.from('game/enemies', 'utf8');
      fake.sendRaw(
        Buffer.concat([
          u32(28),
          u32(3),
          encodeVariant('performance:profile_names'),
          encodeVariant(THREAD),
          u32(28 | (1 << 16)),
          u32(21),
          u32(1),
          u32(21),
          u32(name.length),
          name,
        ]),
      );
    });

    expect(result.monitors!.custom).toEqual([{ name: 'game/enemies', avg: 7, min: 7, max: 7 }]);
  });

  it('follows the custom monitor names as they change mid-capture', async () => {
    const { profiler: p, peer: fake } = await connectedProfiler();
    fake.send(['performance:profile_names', THREAD, ['a']]);
    const running = p.start(5, 512);
    await feedStart(fake, running, [frame(1, 0.016, []), frame(2, 0.016, [])]);
    fake.send(['performance:profile_frame', THREAD, monitorSample({}, 59, [1])]);
    fake.send(['performance:profile_names', THREAD, ['a', 'b']]);
    fake.send(['performance:profile_frame', THREAD, monitorSample({}, 59, [3, 7])]);
    const result = await stopCapture(p, fake);

    expect(result.monitors!.custom).toEqual([
      { name: 'a', avg: 2, min: 1, max: 3 },
      { name: 'b', avg: 7, min: 7, max: 7 },
    ]);
  });

  it('drops custom monitor values that are not finite numbers', async () => {
    // A custom monitor dividing by zero reports INF, which the engine forwards.
    const result = await monitorCapture(
      [monitorSample({}, 59, [Infinity]), monitorSample({}, 59, [5]), monitorSample({}, 59, [NaN])],
      async (fake) => {
        fake.send(['performance:profile_names', THREAD, ['game/ratio']]);
      },
    );

    expect(result.monitors!.custom).toEqual([{ name: 'game/ratio', avg: 5, min: 5, max: 5 }]);
  });

  it('tracks a bounded number of custom monitors', async () => {
    const names = Array.from({ length: 70 }, (_, i) => `game/m${i}`);
    const result = await monitorCapture(
      [
        monitorSample(
          {},
          59,
          names.map((_, i) => i),
        ),
      ],
      async (fake) => {
        fake.send(['performance:profile_names', THREAD, names]);
      },
    );

    expect(result.monitors!.custom).toHaveLength(64);
  });
});

describe('DebuggerProfiler fps', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('measures frames per second from the frames the capture folded', async () => {
    // Only the clock is fake: sockets and timers still run for real.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    const { profiler: p, peer: fake } = await connectedProfiler();
    const running = p.start(5, 512);
    await feedStart(fake, running, [frame(1, 0.016, []), frame(2, 0.016, [])]);
    vi.setSystemTime(1_000_250);
    fake.send(['servers:profile_frame', THREAD, frame(27, 0.016, [])]);
    const result = await stopCapture(p, fake);

    // 25 engine frames across 250 ms of wall time.
    expect(result.fps).toBe(100);
  });

  it('has no fps for a capture that folded a single frame', async () => {
    const { profiler: p, peer: fake } = await connectedProfiler();
    const running = p.start(5, 512);
    await feedStart(fake, running, [frame(1, 0.016, []), frame(2, 0.016, [])]);

    expect((await stopCapture(p, fake)).fps).toBeNull();
  });
});

describe('DebuggerProfiler timeline', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Send one frame and wait until it is folded, so the fake clock reads the
   * same when the profiler stamps it as when the test set it.
   */
  async function sendAt(fake: FakeGodot, at: number, message: Variant): Promise<void> {
    vi.setSystemTime(at);
    fake.send(message);
    await drain(fake);
  }

  it('is off unless asked for', async () => {
    const { profiler: p, peer: fake } = await connectedProfiler();
    const running = p.start(5, 512);
    await feedStart(fake, running, [frame(1, 0.016, []), frame(2, 0.016, [])]);

    const result = await stopCapture(p, fake);
    expect(result.timeline).toBeNull();
    expect(result).toMatchObject({ targetFps: 60, slowFrames: 0 });
  });

  it('slices the capture into intervals: rate, budget, freezes and what was heaviest', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    const { profiler: p, peer: fake } = await connectedProfiler();
    const running = p.start(5, 512, { timelineMs: 500, targetFps: 100 });
    await feedStart(fake, running, [
      frame(1, 0.004, []),
      frame(2, 0.004, [[0, 1, 0.001, 0.002]], [['physics_3d', ['Finalize Islands', 0.0005]]]),
    ]);
    await sendAt(fake, 1_000_200, ['servers:profile_frame', THREAD, frame(3, 0.004, [])]);
    // Over the 10 ms budget of 100 fps, in the second interval.
    await sendAt(fake, 1_000_600, [
      'servers:profile_frame',
      THREAD,
      frame(4, 0.02, [[0, 5, 0.015, 0.016]]),
    ]);
    // Nothing for a whole interval: a freeze. The next frame lands after it.
    await sendAt(fake, 1_001_600, ['servers:profile_frame', THREAD, frame(5, 0.004, [])]);
    const result = await stopCapture(p, fake);

    expect(result.slowFrames).toBe(1);
    const timeline = result.timeline!;
    expect(timeline).toMatchObject({ bucketMs: 500, track: [], trackError: null });
    const buckets = timeline.buckets;
    expect(buckets.map((b) => b.t)).toEqual([0, 0.5, 1, 1.5]);
    expect(buckets.map((b) => b.frames)).toEqual([2, 1, 0, 1]);
    expect(buckets[0]!.fps).toBe(4);
    expect(buckets[0]!.top).toContainEqual(
      expect.objectContaining({ kind: 'server', name: 'physics_3d/Finalize Islands' }),
    );
    expect(buckets[1]).toMatchObject({ slowFrames: 1, frameMs: { avg: 20, max: 20 } });
    expect(buckets[1]!.top[0]).toEqual({
      kind: 'script',
      name: '_burn (res://hot.gd:8)',
      ms: 15,
      maxMs: 15,
    });
    expect(buckets[2]).toMatchObject({ frames: 0, fps: 0, frameMs: null, top: [] });
    // The capture ended 100 ms into its last interval: too short to divide by.
    expect(buckets[3]!.fps).toBeNull();
  });

  it('puts render time and draw calls on the timeline', async () => {
    const { profiler: p, peer: fake } = await connectedProfiler();
    const running = p.start(5, 512, { visual: true, timelineMs: 5000 });
    await feedStart(fake, running, [frame(1, 0.016, []), frame(2, 0.016, [])]);
    sendSettleFrames(fake);
    fake.send(['visual:profile_frame', THREAD, visualFrame(41, RENDER_FRAME)]);
    fake.send(['performance:profile_frame', THREAD, monitorSample({ 13: 12 })]);
    const result = await stopCapture(p, fake);

    const bucket = result.timeline!.buckets[0]!;
    expect(bucket.render!.cpuMs).toBeCloseTo(1.6, 6);
    expect(bucket.render!.gpuMs).toBeCloseTo(3.6, 6);
    expect(bucket.drawCalls).toBe(12);
    // Render stages rank by the heavier of their CPU and GPU time.
    const opaque = bucket.top.find((item) => item.kind === 'render');
    expect(opaque).toMatchObject({
      name: path('Render Viewports', 'Render Viewport 0', 'Render 3D Scene', 'Render Opaque Pass'),
      ms: 2,
    });
  });

  it('places track samples on the interval whose frames they were taken on', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(2_000_000);
    const { profiler: p, peer: fake } = await connectedProfiler();
    const running = p.start(5, 512, { timelineMs: 500, track: ['/root/Main/Player:position'] });
    await feedStart(fake, running, [frame(1, 0.016, []), frame(2, 0.016, [])]);
    await sendAt(fake, 2_000_100, ['servers:profile_frame', THREAD, frame(3, 0.016, [])]);
    await sendAt(fake, 2_000_700, ['servers:profile_frame', THREAD, frame(4, 0.016, [])]);
    const collect = vi.fn(async () => ({
      samples: [
        { frame: 4, values: { at: 'second' } },
        { frame: 2, values: { at: 'first-early' } },
        { frame: 3, values: { at: 'first' } },
        // Taken after the capture: on no interval.
        { frame: 99, values: { at: 'late' } },
      ],
      error: null,
    }));
    const result = await stopCapture(p, fake, 10, collect);

    const timeline = result.timeline!;
    expect(timeline.track).toEqual(['/root/Main/Player:position']);
    expect(timeline.buckets.map((b) => b.track)).toEqual([{ at: 'first' }, { at: 'second' }]);
    // Only the first hand-over counts: a re-read neither asks again nor swaps them.
    const again = vi.fn(async () => ({
      samples: [{ frame: 2, values: { at: 'other' } }],
      error: null,
    }));
    const reread = await p.stop(10, 'totalMs', again);
    expect(again).not.toHaveBeenCalled();
    expect(reread.timeline!.buckets.map((b) => b.track)).toEqual([
      { at: 'first' },
      { at: 'second' },
    ]);
  });

  it('says why tracked values are missing', async () => {
    const { profiler: p, peer: fake } = await connectedProfiler();
    const running = p.start(5, 512, { timelineMs: 500, track: ['/root/Main/Player:position'] });
    await feedStart(fake, running, [frame(1, 0.016, []), frame(2, 0.016, [])]);
    const result = await stopCapture(p, fake, 10, async () => ({
      samples: null,
      error: 'Command track_stop timed out',
    }));

    expect(result.timeline).toMatchObject({ trackError: 'Command track_stop timed out' });
    expect(result.timeline!.buckets[0]!.track).toBeNull();
  });

  it('collects the track only once the capture has closed', async () => {
    const { profiler: p, peer: fake } = await connectedProfiler();
    const running = p.start(5, 512, { timelineMs: 500, track: ['/root/Main/Player:position'] });
    await feedStart(fake, running, [frame(1, 0.016, []), frame(2, 0.016, [])]);
    let closedWhenAsked: boolean | null = null;
    await stopCapture(p, fake, 10, async () => {
      closedWhenAsked = p.hasResult;
      return { samples: [], error: null };
    });

    // The bridge serializes its samples in one frame: not a frame to measure.
    expect(closedWhenAsked).toBe(true);
  });

  it('hands a track to the capture that asked for it, even once another has opened', async () => {
    const { profiler: p, peer: fake } = await connectedProfiler();
    const running = p.start(5, 512, { timelineMs: 500, track: ['/root/Main/Player:position'] });
    await feedStart(fake, running, [frame(1, 0.016, []), frame(2, 0.016, [])]);
    let handOver: (value: Awaited<ReturnType<TrackCollector>>) => void = () => {};
    const collect = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<TrackCollector>>>((resolve) => {
          handOver = resolve;
        }),
    );
    const first = stopCapture(p, fake, 10, collect);
    await waitUntil(() => collect.mock.calls.length === 1, 'track collection');
    // A new capture opens while the first one's track is still on its way.
    const second = p.start(5, 512);
    await waitUntil(() => fake.commandsNamed('profiler:servers').length >= 3, 'second enable');
    fake.send(['servers:profile_frame', THREAD, frame(10, 0.016, [])]);
    fake.send(['servers:profile_frame', THREAD, frame(11, 0.016, [])]);
    await second;
    handOver({ samples: [{ frame: 2, values: { at: 'first' } }], error: null });

    expect((await first).timeline!.buckets[0]!.track).toEqual({ at: 'first' });
    expect((await stopCapture(p, fake)).timeline).toBeNull();
  });

  it.each([
    [500, 30, 500],
    [250, 15, 250],
    [250, 60, 1000],
    [250, 31, 550],
    [2000, 60, 2000],
  ])('turns %i ms over %i s into %i ms intervals', (requested, seconds, expected) => {
    expect(timelineBucketMs(requested, seconds)).toBe(expected);
  });

  it('widens the interval so a long window stays within 60 intervals', async () => {
    const { profiler: p, peer: fake } = await connectedProfiler();
    const running = p.start(60, 512, { timelineMs: 250 });
    await feedStart(fake, running, [frame(1, 0.016, []), frame(2, 0.016, [])]);

    expect(await running).toMatchObject({ timeline: true, timelineMs: 1000 });
    expect((await stopCapture(p, fake)).timeline!.bucketMs).toBe(1000);
  });

  it('ranks a bucket by the per-frame time each thing reports', async () => {
    const { profiler: p, peer: fake } = await connectedProfiler();
    const running = p.start(5, 512, { visual: true, timelineMs: 5000 });
    await waitUntil(() => fake.commandsNamed('profiler:visual').length >= 1, 'visual enable');
    const script: Row[] = [[0, 1, 0.0003, 0.0003]];
    await feedStart(fake, running, [frame(1, 0.016, script), frame(2, 0.016, script)]);
    for (let n = 3; n <= 11; n++) {
      fake.send(['servers:profile_frame', THREAD, frame(n, 0.016, script)]);
    }
    sendSettleFrames(fake);
    fake.send(['visual:profile_frame', THREAD, visualFrame(41, RENDER_FRAME)]);
    const result = await stopCapture(p, fake);

    // 0.3 ms in each of ten frames sums past the opaque pass's 2 ms in its one
    // rendered frame, but per frame the pass is far the heavier.
    const top = result.timeline!.buckets[0]!.top;
    expect(top[0]).toMatchObject({ kind: 'render', ms: 2 });
    expect(top.map((item) => item.kind)).toEqual(['render', 'render', 'render']);
  });

  it('keeps render stages in the ranking when scripts fill a bucket', async () => {
    const { profiler: p, peer: fake } = await connectedProfiler();
    const running = p.start(5, 512, { visual: true, timelineMs: 5000 });
    await waitUntil(() => fake.commandsNamed('profiler:visual').length >= 1, 'visual enable');
    // More cheap script functions in one frame than a bucket keeps of a kind.
    const many: Row[] = Array.from({ length: 600 }, (_, i): Row => [i, 1, 0.0001, 0.0001]);
    await feedStart(fake, running, [frame(1, 0.016, []), frame(2, 0.016, many)]);
    sendSettleFrames(fake);
    fake.send(['visual:profile_frame', THREAD, visualFrame(41, RENDER_FRAME)]);
    const result = await stopCapture(p, fake);

    expect(result.timeline!.buckets[0]!.top[0]).toMatchObject({
      kind: 'render',
      name: path('Render Viewports', 'Render Viewport 0', 'Render 3D Scene', 'Render Opaque Pass'),
      ms: 2,
    });
  });

  it.each([
    ['a timeline interval below the minimum', { timelineMs: 100 }],
    ['a timeline interval that is not whole', { timelineMs: 500.5 }],
    ['a target frame rate of 0', { targetFps: 0 }],
  ])('rejects %s', async (_label, options) => {
    const { profiler: p } = await connectedProfiler();
    await expect(p.start(5, 512, options)).rejects.toMatchObject({ code: 'bad_args' });
  });
});
