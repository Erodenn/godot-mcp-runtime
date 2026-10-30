import { inflateSync } from 'zlib';

/** Minimal dependency-free PNG decoder for 8-bit RGB(A): parses IHDR + IDAT, inflates, reverses the scanline filters; returns RGBA bytes (alpha 255 for RGB) plus dimensions, and throws on palette, 16-bit or interlaced images. */

const PNG_SIGNATURE: Buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_SIGNATURE_LENGTH = PNG_SIGNATURE.length;
/** A chunk is length (4), type (4), data, CRC (4). */
const CHUNK_LENGTH_BYTES = 4;
const CHUNK_TYPE_BYTES = 4;
const CHUNK_CRC_BYTES = 4;
const CHUNK_HEADER_BYTES = CHUNK_LENGTH_BYTES + CHUNK_TYPE_BYTES;
const CHUNK_OVERHEAD_BYTES = CHUNK_HEADER_BYTES + CHUNK_CRC_BYTES;
const IHDR_WIDTH_OFFSET = 0;
const IHDR_HEIGHT_OFFSET = 4;
const IHDR_BIT_DEPTH_OFFSET = 8;
const IHDR_COLOR_TYPE_OFFSET = 9;
const IHDR_INTERLACE_OFFSET = 12;
const SUPPORTED_BIT_DEPTH = 8;
const COLOR_TYPE_RGB = 2;
const COLOR_TYPE_RGBA = 6;
const CHANNELS_RGB = 3;
const CHANNELS_RGBA = 4;
const OUTPUT_CHANNELS = 4;
const OPAQUE_ALPHA = 255;
const BYTE_MASK = 0xff;
const NO_INTERLACE = 0;
const FILTER_NONE = 0;
const FILTER_SUB = 1;
const FILTER_UP = 2;
const FILTER_AVERAGE = 3;
const FILTER_PAETH = 4;
/** Bytes in an IHDR payload: width, height, bit depth, color type, compression, filter, interlace. */
const IHDR_DATA_LENGTH = 13;
/** Largest side accepted. 8K frames are 7680 x 4320, so this leaves 2x headroom. */
export const PNG_MAX_DIMENSION = 16384;
/** Largest pixel count accepted: 8192 x 8192, twice an 8K frame. Bounds the inflate and output buffers. */
const PNG_MAX_PIXELS_SIDE = 8192;
export const PNG_MAX_PIXELS = PNG_MAX_PIXELS_SIDE * PNG_MAX_PIXELS_SIDE;

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export interface DecodedPng {
  width: number;
  height: number;
  data: Uint8Array;
}

export function decodePng(buffer: Buffer): DecodedPng {
  if (
    buffer.length < PNG_SIGNATURE_LENGTH ||
    !buffer.subarray(0, PNG_SIGNATURE_LENGTH).equals(PNG_SIGNATURE)
  ) {
    throw new Error('Not a valid PNG file (bad signature)');
  }

  let offset = PNG_SIGNATURE_LENGTH;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatChunks: Buffer[] = [];

  while (offset + CHUNK_HEADER_BYTES <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer
      .subarray(offset + CHUNK_LENGTH_BYTES, offset + CHUNK_HEADER_BYTES)
      .toString('ascii');
    const data = buffer.subarray(offset + CHUNK_HEADER_BYTES, offset + CHUNK_HEADER_BYTES + length);

    if (type === 'IHDR') {
      if (data.length < IHDR_DATA_LENGTH) {
        throw new Error(
          `PNG IHDR chunk truncated: ${data.length} bytes, expected ${IHDR_DATA_LENGTH}`,
        );
      }
      width = data.readUInt32BE(IHDR_WIDTH_OFFSET);
      height = data.readUInt32BE(IHDR_HEIGHT_OFFSET);
      bitDepth = data[IHDR_BIT_DEPTH_OFFSET]!;
      colorType = data[IHDR_COLOR_TYPE_OFFSET]!;
      interlace = data[IHDR_INTERLACE_OFFSET]!;
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += CHUNK_OVERHEAD_BYTES + length;
  }

  if (
    bitDepth !== SUPPORTED_BIT_DEPTH ||
    (colorType !== COLOR_TYPE_RGB && colorType !== COLOR_TYPE_RGBA)
  ) {
    throw new Error(
      `Unsupported PNG format: bitDepth=${bitDepth} colorType=${colorType} (need 8-bit RGB/RGBA)`,
    );
  }
  if (interlace !== NO_INTERLACE) {
    throw new Error('Interlaced PNG is not supported');
  }

  if (width === 0 || height === 0) {
    throw new Error(`PNG has zero dimensions: ${width}x${height}`);
  }
  if (width > PNG_MAX_DIMENSION || height > PNG_MAX_DIMENSION || width * height > PNG_MAX_PIXELS) {
    throw new Error(
      `PNG dimensions ${width}x${height} exceed the supported maximum (${PNG_MAX_DIMENSION} per side, ${PNG_MAX_PIXELS} pixels)`,
    );
  }

  const channels = colorType === COLOR_TYPE_RGBA ? CHANNELS_RGBA : CHANNELS_RGB;
  const bytesPerPixel = channels;
  const stride = width * bytesPerPixel;
  const expectedRawLength = height * (stride + 1);
  // The cap is the exact expected size, so a small file cannot inflate past it.
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idatChunks), { maxOutputLength: expectedRawLength });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new Error(`PNG data inflates beyond the expected ${expectedRawLength} bytes`);
    }
    throw error;
  }
  if (raw.length < expectedRawLength) {
    throw new Error(`PNG data truncated: ${raw.length} bytes, expected ${expectedRawLength}`);
  }

  const out = new Uint8Array(width * height * OUTPUT_CHANNELS);
  let prevLine: Uint8Array | null = null;
  let rawOffset = 0;

  for (let y = 0; y < height; y++) {
    const filter = raw[rawOffset++]!;
    const line = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[rawOffset + x]!;
      const left = x >= bytesPerPixel ? line[x - bytesPerPixel]! : 0;
      const up = prevLine ? prevLine[x]! : 0;
      const upLeft = prevLine && x >= bytesPerPixel ? prevLine[x - bytesPerPixel]! : 0;
      let predicted: number;
      switch (filter) {
        case FILTER_NONE:
          predicted = rawByte;
          break;
        case FILTER_SUB:
          predicted = rawByte + left;
          break;
        case FILTER_UP:
          predicted = rawByte + up;
          break;
        case FILTER_AVERAGE:
          predicted = rawByte + Math.floor((left + up) / 2);
          break;
        case FILTER_PAETH:
          predicted = rawByte + paethPredictor(left, up, upLeft);
          break;
        default:
          throw new Error(`Unknown PNG scanline filter: ${filter}`);
      }
      line[x] = predicted & BYTE_MASK;
    }
    rawOffset += stride;
    prevLine = line;
    for (let x = 0; x < width; x++) {
      const src = x * bytesPerPixel;
      const dst = (y * width + x) * OUTPUT_CHANNELS;
      out[dst] = line[src]!;
      out[dst + 1] = line[src + 1]!;
      out[dst + 2] = line[src + 2]!;
      out[dst + 3] = channels === CHANNELS_RGBA ? line[src + 3]! : OPAQUE_ALPHA;
    }
  }

  return { width, height, data: out };
}
