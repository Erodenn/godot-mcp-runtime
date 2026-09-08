/**
 * Profiler receiver tests, driven by a fake Godot on the other end of the
 * debugger socket. Everything worth verifying here is protocol behavior —
 * which commands we send, which frames we fold into the totals, and what a
 * dropped or silent debugger turns into — none of which needs a real engine.
 *
 * The frame layout mirrors what Godot 4.6/4.7 actually sends: a frame number,
 * five timing fields, a server count with that many `name, entryCount,
 * ...entries` blocks, then the flattened five-wide function rows behind their
 * length.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as net from 'net';
import { decodeVariant, encodeVariant, type Variant } from '../../src/utils/godot-variant.js';
import { DebuggerProfiler, ProfilerError } from '../../src/utils/profiler.js';

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
    const raw = encodeVariant(message);
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
      // Frame 12 never arrives — one transport gap.
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
    // 4.5 ms of a 15 ms average frame — the editor's "Frame %" measure.
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
    // get filtered — the truncation is real even though `rows` comes back short.
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
