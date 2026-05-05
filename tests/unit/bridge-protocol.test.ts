import { describe, it, expect } from 'vitest';
import {
  DEFAULT_BRIDGE_PORT,
  MAX_FRAME_BYTES,
  encodeFrame,
  getBridgePort,
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

describe('getBridgePort', () => {
  it('returns DEFAULT_BRIDGE_PORT when MCP_BRIDGE_PORT is unset', () => {
    const prev = process.env.MCP_BRIDGE_PORT;
    delete process.env.MCP_BRIDGE_PORT;
    try {
      expect(getBridgePort()).toBe(DEFAULT_BRIDGE_PORT);
    } finally {
      if (prev !== undefined) process.env.MCP_BRIDGE_PORT = prev;
    }
  });

  it('honours a valid MCP_BRIDGE_PORT', () => {
    const prev = process.env.MCP_BRIDGE_PORT;
    process.env.MCP_BRIDGE_PORT = '12345';
    try {
      expect(getBridgePort()).toBe(12345);
    } finally {
      if (prev === undefined) delete process.env.MCP_BRIDGE_PORT;
      else process.env.MCP_BRIDGE_PORT = prev;
    }
  });

  it.each(['', 'abc', '0', '-1', '99999'])(
    'falls back to DEFAULT_BRIDGE_PORT for invalid value %j',
    (bad) => {
      const prev = process.env.MCP_BRIDGE_PORT;
      process.env.MCP_BRIDGE_PORT = bad;
      try {
        expect(getBridgePort()).toBe(DEFAULT_BRIDGE_PORT);
      } finally {
        if (prev === undefined) delete process.env.MCP_BRIDGE_PORT;
        else process.env.MCP_BRIDGE_PORT = prev;
      }
    },
  );
});
