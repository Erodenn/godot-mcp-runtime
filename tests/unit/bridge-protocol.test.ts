import { describe, it, expect } from 'vitest';
import {
  ACTION_BOUNDARY_SENTINEL,
  MAX_FRAME_BYTES,
  bucketBySentinel,
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

// ---------------------------------------------------------------------------
// Action-boundary sentinel parsing and bucketing
//
// These two helpers are the whole of the per-action error attribution used by
// simulate_input: the bridge prints one sentinel per action on stderr and the
// runner splits its stderr window on the recorded marks. Both are pure so the
// attribution logic is testable without a Godot process.
// ---------------------------------------------------------------------------

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
