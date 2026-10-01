import { deflateSync } from 'zlib';
import { RGBA_BYTES_PER_PIXEL, type RgbaFrame } from './pixel-stats.js';

/**
 * Minimal PNG encoder: 8-bit RGB (color type 2), filter 0 on every row, one
 * IDAT chunk. The counterpart of `decodePng` for the one place this server
 * writes an image of its own (downscaled inline frame previews). No external
 * dependencies; Node 20 has no `zlib.crc32`, so the CRC table is built here.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IHDR_LENGTH = 13;
const BIT_DEPTH = 8;
const COLOR_TYPE_RGB = 2;
const RGB_CHANNELS = 3;
const FILTER_NONE = 0;
const CRC32_POLYNOMIAL = 0xedb88320;
const CRC32_TABLE_SIZE = 256;
const BITS_PER_BYTE = 8;
const BYTE_MASK = 0xff;
const UINT32_BYTES = 4;
const CRC32_INITIAL = 0xffffffff;
const IHDR_BIT_DEPTH_OFFSET = 8;
const IHDR_COLOR_TYPE_OFFSET = 9;

const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(CRC32_TABLE_SIZE);
  for (let n = 0; n < CRC32_TABLE_SIZE; n++) {
    let c = n;
    for (let k = 0; k < BITS_PER_BYTE; k++) {
      c = c & 1 ? CRC32_POLYNOMIAL ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = CRC32_INITIAL;
  for (const byte of buffer) {
    c = CRC32_TABLE[(c ^ byte) & BYTE_MASK]! ^ (c >>> BITS_PER_BYTE);
  }
  return (c ^ CRC32_INITIAL) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(UINT32_BYTES);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(UINT32_BYTES);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/** Encode an RGBA frame as an 8-bit RGB PNG. Alpha is dropped. */
export function encodeRgbPng(frame: RgbaFrame): Buffer {
  const { width, height, data } = frame;
  const stride = width * RGB_CHANNELS;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (stride + 1);
    raw[rowOffset] = FILTER_NONE;
    for (let x = 0; x < width; x++) {
      const source = (y * width + x) * RGBA_BYTES_PER_PIXEL;
      const target = rowOffset + 1 + x * RGB_CHANNELS;
      for (let channel = 0; channel < RGB_CHANNELS; channel++) {
        raw[target + channel] = data[source + channel]!;
      }
    }
  }
  const header = Buffer.alloc(IHDR_LENGTH);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, UINT32_BYTES);
  header[IHDR_BIT_DEPTH_OFFSET] = BIT_DEPTH;
  header[IHDR_COLOR_TYPE_OFFSET] = COLOR_TYPE_RGB;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
