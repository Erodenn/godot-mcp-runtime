/**
 * Shared PNG fixtures: the cold-import integration tests
 * (reactive-import.test.ts, batch-import-prepass.test.ts) and the pixel-statistics
 * tests (encodePng, solidRgba).
 */

import { deflateSync } from 'zlib';

/** 1x1 transparent PNG. */
export function minimalPng(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
}

/** Garbage bytes with a .png extension -- import fails but writes an .import sidecar. */
export function invalidPng(): Buffer {
  return Buffer.from('this is not a png at all');
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IHDR_LENGTH = 13;
const BIT_DEPTH_8 = 8;
const COLOR_TYPE_RGB = 2;
const COLOR_TYPE_RGBA = 6;
const RGBA_CHANNELS = 4;
const RGB_CHANNELS = 3;
const BYTE_MASK = 0xff;
const CRC32_POLYNOMIAL = 0xedb88320;
const BITS_PER_BYTE = 8;

// Module-private copies of the helpers of the same names in tests/unit/png-decoder.test.ts.
function crc32(buf: Buffer): number {
  let c: number = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < BITS_PER_BYTE; k++) {
      c = (c >>> 1) ^ (CRC32_POLYNOMIAL & -(c & 1));
    }
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** width*height copies of one RGBA pixel. */
export function solidRgba(
  width: number,
  height: number,
  pixel: readonly [number, number, number, number],
): Uint8Array {
  const data = new Uint8Array(width * height * RGBA_CHANNELS);
  for (let i = 0; i < width * height; i++) data.set(pixel, i * RGBA_CHANNELS);
  return data;
}

export interface EncodePngOptions {
  /** PNG row filter applied to every row (0 None, 1 Sub, 2 Up, 3 Average, 4 Paeth). */
  filter?: 0 | 1 | 2 | 3 | 4;
  /** 4 writes RGBA (color type 6); 3 drops alpha and writes RGB (color type 2). */
  channels?: 3 | 4;
}

/** Encode RGBA pixel data as an 8-bit PNG using one chosen filter for every row. */
export function encodePng(
  width: number,
  height: number,
  rgba: Uint8Array,
  opts: EncodePngOptions = {},
): Buffer {
  const filter = opts.filter ?? 0;
  const channels = opts.channels ?? RGBA_CHANNELS;
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));
  let prev: Uint8Array | null = null;
  for (let y = 0; y < height; y++) {
    const line = new Uint8Array(stride);
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < channels; c++) {
        line[x * channels + c] = rgba[(y * width + x) * RGBA_CHANNELS + c]!;
      }
    }
    const rowOffset = y * (stride + 1);
    raw[rowOffset] = filter;
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? line[i - channels]! : 0;
      const up = prev ? prev[i]! : 0;
      const upLeft = prev && i >= channels ? prev[i - channels]! : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) predictor = paeth(left, up, upLeft);
      raw[rowOffset + 1 + i] = (line[i]! - predictor) & BYTE_MASK;
    }
    prev = line;
  }
  const ihdr = Buffer.alloc(IHDR_LENGTH);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = BIT_DEPTH_8;
  ihdr[9] = channels === RGB_CHANNELS ? COLOR_TYPE_RGB : COLOR_TYPE_RGBA;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
