import { describe, it, expect } from 'vitest';
import { encodeRgbPng } from '../../src/utils/png-encoder.js';
import { decodePng } from '../../src/utils/png-decoder.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Zero length, the type "IEND", and CRC-32("IEND") = 0xae426082. */
const IEND_CHUNK = Buffer.from([
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);
const OPAQUE = 255;

describe('encodeRgbPng', () => {
  it('starts with the PNG signature', () => {
    const png = encodeRgbPng({ width: 1, height: 1, data: new Uint8Array([1, 2, 3, OPAQUE]) });
    expect(png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)).toBe(true);
  });

  // The decoder ignores CRC bytes, so the round trips below cannot catch a
  // wrong checksum. An empty IEND chunk has one fixed CRC in every valid PNG.
  it('ends with an IEND chunk carrying the standard CRC', () => {
    const png = encodeRgbPng({ width: 1, height: 1, data: new Uint8Array([1, 2, 3, OPAQUE]) });
    expect(png.subarray(png.length - IEND_CHUNK.length).equals(IEND_CHUNK)).toBe(true);
  });

  it('round-trips RGB through decodePng', () => {
    // 3x2, six distinct pixels
    const rgba = new Uint8Array([
      10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255, 130, 140, 150, 255,
      160, 170, 180, 255,
    ]);
    const decoded = decodePng(encodeRgbPng({ width: 3, height: 2, data: rgba }));
    expect(decoded.width).toBe(3);
    expect(decoded.height).toBe(2);
    expect(Array.from(decoded.data)).toEqual(Array.from(rgba));
  });

  it('drops source alpha', () => {
    const decoded = decodePng(
      encodeRgbPng({ width: 1, height: 1, data: new Uint8Array([9, 8, 7, 12]) }),
    );
    expect(Array.from(decoded.data)).toEqual([9, 8, 7, OPAQUE]);
  });

  it('encodes a 1x1 frame', () => {
    const decoded = decodePng(
      encodeRgbPng({ width: 1, height: 1, data: new Uint8Array([255, 0, 0, OPAQUE]) }),
    );
    expect(decoded.width).toBe(1);
    expect(decoded.height).toBe(1);
    expect(Array.from(decoded.data)).toEqual([255, 0, 0, OPAQUE]);
  });
});
