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
