/**
 * The Variant codec is a boundary against bytes we don't control, so the
 * interesting cases are the malformed ones: a length field that overruns the
 * packet, a type outside the supported subset, trailing bytes after a value.
 */

import { describe, it, expect } from 'vitest';
import { decodeVariant, encodeVariant, type Variant } from '../../src/utils/godot-variant.js';

function roundTrip(value: Variant): Variant {
  return decodeVariant(encodeVariant(value));
}

describe('encodeVariant / decodeVariant round-trip', () => {
  it.each([
    ['null', null],
    ['bool true', true],
    ['bool false', false],
    ['int', 42],
    ['negative int', -7],
    ['float', 0.015625],
    ['string', 'servers:profile_frame'],
    ['string needing padding', 'abc'],
    ['empty string', ''],
    ['non-ascii string', 'res://scène.gd::12::_procès'],
    ['array', ['profiler:servers', 1, [true, [512, false]]]],
  ] as Array<[string, Variant]>)('preserves %s', (_label, value) => {
    expect(roundTrip(value)).toEqual(value);
  });

  it('rejects values Godot never accepts from a debugger host', () => {
    expect(() => encodeVariant({ nope: 1 } as unknown as Variant)).toThrow(/Unsupported outgoing/);
  });
});

describe('decodeVariant rejects malformed packets', () => {
  it('rejects a truncated value', () => {
    const raw = encodeVariant(1234);
    expect(() => decodeVariant(raw.subarray(0, raw.length - 2))).toThrow(/Truncated/);
  });

  it('rejects a truncated string body', () => {
    const raw = encodeVariant('godot');
    expect(() => decodeVariant(raw.subarray(0, 10))).toThrow(/Truncated/);
  });

  it('rejects trailing bytes after a complete value', () => {
    const raw = Buffer.concat([encodeVariant(1), Buffer.alloc(4)]);
    expect(() => decodeVariant(raw)).toThrow(/Trailing Variant bytes/);
  });

  it('rejects an array length the packet cannot hold', () => {
    const raw = Buffer.alloc(8);
    raw.writeUInt32LE(28, 0);
    raw.writeUInt32LE(1_000_000, 4);
    expect(() => decodeVariant(raw)).toThrow(/Invalid array length/);
  });

  it('rejects a packed array length the packet cannot hold', () => {
    const raw = Buffer.alloc(8);
    raw.writeUInt32LE(30, 0);
    raw.writeUInt32LE(1_000_000, 4);
    expect(() => decodeVariant(raw)).toThrow(/Invalid packed array length/);
  });

  it('rejects an unsupported type (objects and vectors are never decoded)', () => {
    const raw = Buffer.alloc(8);
    raw.writeUInt32LE(24, 0);
    expect(() => decodeVariant(raw)).toThrow(/Unsupported debugger Variant/);
  });

  it('decodes a packed float array as plain numbers', () => {
    const raw = Buffer.alloc(8 + 8);
    raw.writeUInt32LE(33, 0);
    raw.writeUInt32LE(1, 4);
    raw.writeDoubleLE(1.5, 8);
    expect(decodeVariant(raw)).toEqual([1.5]);
  });
});

/**
 * The encoder only ever emits the 64-bit form, so a round-trip test can never
 * reach the 32-bit branch — but the wire format allows it and a real engine may
 * send it. These build the narrow encodings by hand.
 */
describe('decodeVariant handles the encodings our encoder never emits', () => {
  const TYPE_INT = 2;
  const TYPE_FLOAT = 3;

  function narrow(kind: number, write: (buf: Buffer) => void, width: number): Buffer {
    const buf = Buffer.alloc(4 + width);
    buf.writeUInt32LE(kind, 0);
    write(buf);
    return buf;
  }

  it('decodes a 32-bit int', () => {
    const raw = narrow(TYPE_INT, (b) => b.writeInt32LE(-123456, 4), 4);
    expect(decodeVariant(raw)).toBe(-123456);
  });

  it('decodes a 32-bit float', () => {
    const raw = narrow(TYPE_FLOAT, (b) => b.writeFloatLE(0.5, 4), 4);
    expect(decodeVariant(raw)).toBe(0.5);
  });

  it('decodes a StringName the same way as a String', () => {
    const TYPE_STRING_NAME = 21;
    const text = Buffer.from('physics_2d', 'utf8');
    const raw = Buffer.alloc(8 + text.length + ((4 - (text.length % 4)) % 4));
    raw.writeUInt32LE(TYPE_STRING_NAME, 0);
    raw.writeUInt32LE(text.length, 4);
    text.copy(raw, 8);
    expect(decodeVariant(raw)).toBe('physics_2d');
  });

  it.each([
    ['byte', 29, 1, (b: Buffer, at: number) => b.writeUInt8(7, at), 7],
    ['int32', 30, 4, (b: Buffer, at: number) => b.writeInt32LE(-9, at), -9],
    ['int64', 31, 8, (b: Buffer, at: number) => b.writeBigInt64LE(-9n, at), -9],
    ['float32', 32, 4, (b: Buffer, at: number) => b.writeFloatLE(0.25, at), 0.25],
    ['float64', 33, 8, (b: Buffer, at: number) => b.writeDoubleLE(0.1, at), 0.1],
  ] as Array<[string, number, number, (b: Buffer, at: number) => void, number]>)(
    'decodes a packed %s array',
    (_label, kind, width, write, expected) => {
      // The byte array is the only one that pads to a 4-byte boundary.
      const pad = kind === 29 ? (4 - (1 % 4)) % 4 : 0;
      const raw = Buffer.alloc(8 + width + pad);
      raw.writeUInt32LE(kind, 0);
      raw.writeUInt32LE(1, 4);
      write(raw, 8);
      expect(decodeVariant(raw)).toEqual([expected]);
    },
  );

  it('rejects an array nested past the depth limit', () => {
    // 65 opening ARRAY headers, each declaring one element.
    const TYPE_ARRAY = 28;
    const parts: Buffer[] = [];
    for (let i = 0; i < 65; i++) {
      const head = Buffer.alloc(8);
      head.writeUInt32LE(TYPE_ARRAY, 0);
      head.writeUInt32LE(1, 4);
      parts.push(head);
    }
    const nil = Buffer.alloc(4);
    parts.push(nil);
    expect(() => decodeVariant(Buffer.concat(parts))).toThrow(/nesting limit/);
  });
});
