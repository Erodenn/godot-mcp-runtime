import { describe, it, expect } from 'vitest';
import { deflateSync } from 'zlib';
import { decodePng } from '../../src/utils/png-decoder.js';

/** Build a minimal valid PNG from raw RGBA pixel data (colorType 6). */
function buildPng(width: number, height: number, rgba: Uint8Array): Buffer {
  const channels = 4;
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const filterOffset = y * (stride + 1);
    raw[filterOffset] = 0; // filter: None
    for (let x = 0; x < stride; x++) {
      raw[filterOffset + 1 + x] = rgba[y * stride + x]!;
    }
  }
  return wrapChunks(width, height, 8, 6, deflateSync(raw));
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function crc32(buf: Buffer): number {
  // Simple CRC-32 (PNG requirement is a valid CRC only for strict readers;
  // our decoder ignores CRC bytes).
  let c: number = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return ~c >>> 0;
}

function wrapChunks(
  width: number,
  height: number,
  bitDepth: number,
  colorType: number,
  idat: Buffer,
  interlace = 0,
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[12] = interlace;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Raw pixel stream builder with an explicit per-scanline filter byte. */
function buildFiltered(
  width: number,
  height: number,
  filter: number,
  scanlineProvider: (y: number) => Uint8Array,
): Buffer {
  const channels = 4;
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1);
    raw[base] = filter;
    raw.set(scanlineProvider(y), base + 1);
  }
  return deflateSync(raw);
}

describe('decodePng', () => {
  it('decodes a 2x2 RGBA image with filter None', () => {
    const rgba = new Uint8Array([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
    ]);
    const png = buildPng(2, 2, rgba);
    const decoded = decodePng(png);
    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(2);
    expect(Array.from(decoded.data)).toEqual(Array.from(rgba));
  });

  it('reverses the Sub filter (predict from left neighbor)', () => {
    const width = 3;
    const height = 1;
    // Filter Sub: byte = raw - left. All-zero deltas reconstruct solid color.
    const deltas = new Uint8Array(width * 4);
    const png = wrapChunks(
      width,
      height,
      8,
      6,
      buildFiltered(width, height, 1, () => deltas),
    );
    const decoded = decodePng(png);
    for (let i = 0; i < width; i++) {
      expect(decoded.data[i * 4]).toBe(0);
      expect(decoded.data[i * 4 + 1]).toBe(0);
      expect(decoded.data[i * 4 + 2]).toBe(0);
      expect(decoded.data[i * 4 + 3]).toBe(0);
    }
  });

  it('reverses the Up filter (predict from row above)', () => {
    const width = 1;
    const height = 2;
    const deltas = new Uint8Array(width * 4);
    const png = wrapChunks(
      width,
      height,
      8,
      6,
      buildFiltered(width, height, 2, () => deltas),
    );
    const decoded = decodePng(png);
    // Solid zeros across both rows
    expect(decoded.data.every((b) => b === 0)).toBe(true);
  });

  it('rejects a non-PNG buffer', () => {
    expect(() => decodePng(Buffer.from('not a png at all'))).toThrow(/bad signature/);
  });

  it('rejects unsupported color types (palette)', () => {
    const png = wrapChunks(1, 1, 8, 3, deflateSync(Buffer.from([0, 0, 0, 0, 0])));
    expect(() => decodePng(png)).toThrow(/Unsupported PNG format/);
  });

  it('rejects 16-bit depth', () => {
    const png = wrapChunks(1, 1, 16, 6, deflateSync(Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0])));
    expect(() => decodePng(png)).toThrow(/Unsupported PNG format/);
  });
});
