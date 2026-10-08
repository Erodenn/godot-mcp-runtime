import { describe, it, expect, afterEach, vi } from 'vitest';
import * as net from 'net';
import {
  ACTION_BOUNDARY_SENTINEL,
  MAX_FRAME_BYTES,
  MAX_TIMER_DELAY_MS,
  ParentWatchListener,
  bucketBySentinel,
  clampTimerDelay,
  encodeFrame,
  findFreePort,
  parseActionBoundary,
  parseFrames,
} from '../../src/utils/bridge-protocol.js';

describe('encodeFrame / parseFrames round trip', () => {
  it('encodes and decodes a simple JSON payload', () => {
    const payload = JSON.stringify({ command: 'ping' });
    const frame = encodeFrame(payload);
    expect(frame.readUInt32BE(0)).toBe(Buffer.byteLength(payload, 'utf8'));
    const { frames, remainder } = parseFrames(frame);
    expect(frames).toHaveLength(1);
    expect(frames[0].toString('utf8')).toBe(payload);
    expect(remainder.length).toBe(0);
  });

  it('round-trips multi-byte UTF-8 payloads', () => {
    const payload = '{"emoji":"🎮","kanji":"日本語"}';
    const frame = encodeFrame(payload);
    const { frames } = parseFrames(frame);
    expect(frames[0].toString('utf8')).toBe(payload);
  });

  it('handles a zero-length frame', () => {
    const frame = encodeFrame('');
    const { frames, remainder } = parseFrames(frame);
    expect(frames).toHaveLength(1);
    expect(frames[0].length).toBe(0);
    expect(remainder.length).toBe(0);
  });
});

describe('parseFrames partial input', () => {
  it.each([1, 2, 3])(
    'returns empty frames and full buffer when only %i header bytes are present',
    (len) => {
      const partial = Buffer.alloc(len);
      const { frames, remainder } = parseFrames(partial);
      expect(frames).toEqual([]);
      expect(remainder.length).toBe(len);
    },
  );

  it('returns empty frames when header is complete but body is short', () => {
    const payload = 'hello';
    const frame = encodeFrame(payload);
    const cut = frame.subarray(0, frame.length - 1); // drop last byte of body
    const { frames, remainder } = parseFrames(cut);
    expect(frames).toEqual([]);
    expect(remainder.length).toBe(cut.length);
  });

  it('extracts the frame once the missing tail arrives', () => {
    const payload = 'hello';
    const frame = encodeFrame(payload);
    const head = frame.subarray(0, frame.length - 1);
    const tail = frame.subarray(frame.length - 1);
    const { frames: f1, remainder: r1 } = parseFrames(head);
    expect(f1).toEqual([]);
    const { frames: f2, remainder: r2 } = parseFrames(Buffer.concat([r1, tail]));
    expect(f2).toHaveLength(1);
    expect(f2[0].toString('utf8')).toBe(payload);
    expect(r2.length).toBe(0);
  });
});

describe('parseFrames concatenation', () => {
  it('extracts two frames from a single buffer', () => {
    const a = encodeFrame('{"i":1}');
    const b = encodeFrame('{"i":2}');
    const { frames, remainder } = parseFrames(Buffer.concat([a, b]));
    expect(frames).toHaveLength(2);
    expect(frames[0].toString('utf8')).toBe('{"i":1}');
    expect(frames[1].toString('utf8')).toBe('{"i":2}');
    expect(remainder.length).toBe(0);
  });

  it('extracts the first frame and keeps the partial second as remainder', () => {
    const a = encodeFrame('{"i":1}');
    const b = encodeFrame('{"i":2}');
    const partial = Buffer.concat([a, b.subarray(0, 5)]); // 4-byte header + 1 body byte
    const { frames, remainder } = parseFrames(partial);
    expect(frames).toHaveLength(1);
    expect(frames[0].toString('utf8')).toBe('{"i":1}');
    expect(remainder.length).toBe(5);
  });
});

describe('parseFrames oversize rejection', () => {
  it('throws when a header advertises more than MAX_FRAME_BYTES', () => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    expect(() => parseFrames(header)).toThrow(/exceeds limit/);
  });
});

describe('encodeFrame oversize rejection', () => {
  it('throws when payload exceeds MAX_FRAME_BYTES', () => {
    // Stub a string whose UTF-8 length exceeds the cap. Use a Buffer-backed
    // approach to avoid actually allocating ~16 MiB.
    const oversize = 'a'.repeat(MAX_FRAME_BYTES + 1);
    expect(() => encodeFrame(oversize)).toThrow(/too large/);
  });
});

describe('findFreePort', () => {
  it('returns a valid port number', async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });

  it('returns different ports on consecutive calls', async () => {
    const a = await findFreePort();
    const b = await findFreePort();
    expect(a).not.toBe(b);
  });
});

describe('clampTimerDelay', () => {
  const ORDINARY_TIMEOUT_MS = 30000;

  afterEach(() => {
    vi.useRealTimers();
  });

  it('leaves an ordinary timeout alone', () => {
    expect(clampTimerDelay(ORDINARY_TIMEOUT_MS)).toBe(ORDINARY_TIMEOUT_MS);
  });

  it('caps a duration past the largest delay a timer honors', () => {
    expect(MAX_TIMER_DELAY_MS).toBe(2 ** 31 - 1);
    expect(clampTimerDelay(MAX_TIMER_DELAY_MS + 1)).toBe(MAX_TIMER_DELAY_MS);
    expect(clampTimerDelay(Number.MAX_SAFE_INTEGER)).toBe(MAX_TIMER_DELAY_MS);
    expect(clampTimerDelay(Number.POSITIVE_INFINITY)).toBe(MAX_TIMER_DELAY_MS);
  });

  it('never returns a delay below one millisecond, and takes a non-number for the maximum', () => {
    expect(clampTimerDelay(0)).toBe(1);
    expect(clampTimerDelay(-5)).toBe(1);
    expect(clampTimerDelay(Number.NaN)).toBe(MAX_TIMER_DELAY_MS);
  });

  it('is what keeps an over-long timeout from firing at once', () => {
    vi.useFakeTimers();
    const fired = vi.fn();
    setTimeout(fired, clampTimerDelay(MAX_TIMER_DELAY_MS * 4));

    vi.advanceTimersByTime(ORDINARY_TIMEOUT_MS);

    expect(fired).not.toHaveBeenCalled();
  });
});

describe('ParentWatchListener', () => {
  const HEARTBEAT = Buffer.from([0]);
  let listener: ParentWatchListener | null = null;

  afterEach(() => {
    listener?.close();
    listener = null;
  });

  function connect(port: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('error', reject);
      socket.once('connect', () => resolve(socket));
    });
  }

  it('binds once and hands every caller the same port', async () => {
    listener = new ParentWatchListener();
    const [first, second] = await Promise.all([listener.port(), listener.port()]);
    expect(first).toBe(second);
    expect(await listener.port()).toBe(first);
  });

  it('accepts a connection and takes heartbeats without answering or closing', async () => {
    listener = new ParentWatchListener();
    const socket = await connect(await listener.port());
    const received = vi.fn();
    const closed = vi.fn();
    socket.on('data', received);
    socket.on('close', closed);

    for (let beat = 0; beat < 3; beat += 1) {
      await new Promise<void>((resolve) => socket.write(HEARTBEAT, () => resolve()));
    }
    await new Promise((resolve) => setImmediate(resolve));

    expect(received).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    socket.destroy();
  });

  it('drops its connections when it goes away, which is the signal the game acts on', async () => {
    listener = new ParentWatchListener();
    const socket = await connect(await listener.port());
    const ended = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    socket.resume();

    listener.close();

    await ended;
    expect(socket.destroyed).toBe(true);
  });
});

describe('parseActionBoundary', () => {
  it('accepts a zero index', () => {
    expect(parseActionBoundary(`${ACTION_BOUNDARY_SENTINEL} 0`)).toBe(0);
  });

  it('accepts surrounding whitespace and a multi-digit index', () => {
    expect(parseActionBoundary(`  ${ACTION_BOUNDARY_SENTINEL} 12 `)).toBe(12);
  });

  it('rejects the bare sentinel with no index', () => {
    expect(parseActionBoundary(ACTION_BOUNDARY_SENTINEL)).toBeNull();
  });

  it('rejects a non-numeric index', () => {
    expect(parseActionBoundary(`${ACTION_BOUNDARY_SENTINEL} x`)).toBeNull();
  });

  it('rejects an ordinary runtime-error line', () => {
    expect(parseActionBoundary('SCRIPT ERROR: Invalid call to function "foo"')).toBeNull();
  });

  it('rejects an empty line', () => {
    expect(parseActionBoundary('')).toBeNull();
  });
});

describe('bucketBySentinel', () => {
  it('attributes in-order lines to the action each sentinel closes', () => {
    const result = bucketBySentinel({
      lines: ['a', 'b', 'c', 'd'],
      startSeq: 0,
      boundaries: [
        { index: 0, seq: 1 },
        { index: 1, seq: 3 },
        { index: 2, seq: 4 },
      ],
      executedCount: 3,
    });
    expect(result.buckets).toEqual([['a'], ['b', 'c'], ['d']]);
    expect(result.trailing).toEqual([]);
  });

  it('puts lines after the last sentinel in trailing', () => {
    const result = bucketBySentinel({
      lines: ['a', 'b', 'c'],
      startSeq: 0,
      boundaries: [{ index: 0, seq: 1 }],
      executedCount: 1,
    });
    expect(result.buckets).toEqual([['a']]);
    expect(result.trailing).toEqual(['b', 'c']);
  });

  it('puts everything in trailing and leaves buckets empty when no sentinel arrived', () => {
    // The drain-timeout shape: the response came back but stderr never carried
    // a boundary, so nothing can be attributed to a specific action.
    const result = bucketBySentinel({
      lines: ['a', 'b'],
      startSeq: 0,
      boundaries: [],
      executedCount: 2,
    });
    expect(result.buckets).toEqual([[], []]);
    expect(result.trailing).toEqual(['a', 'b']);
  });

  it('honours a non-zero startSeq (window after a ring trim)', () => {
    const result = bucketBySentinel({
      lines: ['a', 'b', 'c'],
      startSeq: 10,
      boundaries: [
        { index: 0, seq: 11 },
        { index: 1, seq: 13 },
      ],
      executedCount: 2,
    });
    expect(result.buckets).toEqual([['a'], ['b', 'c']]);
    expect(result.trailing).toEqual([]);
  });

  it('leaves a bucket empty when its sentinel never arrived and still places the later ones', () => {
    const result = bucketBySentinel({
      lines: ['e0', 'e1', 'e2'],
      startSeq: 0,
      boundaries: [
        { index: 0, seq: 1 },
        { index: 2, seq: 3 },
      ],
      executedCount: 3,
    });
    expect(result.buckets[0]).toEqual(['e0']);
    expect(result.buckets[1]).toEqual([]);
    expect(result.buckets[2]).toEqual(['e1', 'e2']);
    expect(result.trailing).toEqual([]);
  });

  it('ignores a boundary index outside the executed range', () => {
    const result = bucketBySentinel({
      lines: ['a', 'b'],
      startSeq: 0,
      boundaries: [{ index: 7, seq: 1 }],
      executedCount: 2,
    });
    expect(result.buckets).toEqual([[], []]);
    expect(result.trailing).toEqual(['a', 'b']);
  });
});
