import { inflateSync } from 'zlib';

/**
 * Minimal PNG decoder for RGB(A) 8-bit images. Parses IHDR + IDAT chunks,
 * inflates the pixel stream, and reverses the per-scanline filters.
 * No external dependencies - keeps the server's zero-dep footprint.
 *
 * Returns raw RGBA bytes (8 bits per channel, alpha filled to 255 for RGB)
 * plus dimensions, or throws on unsupported formats (palette, 16-bit,
 * interlaced).
 */

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
  /** RGBA, 4 bytes per pixel, row-major */
  data: Uint8Array;
}

export function decodePng(buffer: Buffer): DecodedPng {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(signature)) {
    throw new Error('Not a valid PNG file (bad signature)');
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatChunks: Buffer[] = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buffer.subarray(offset + 8, offset + 8 + length);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      interlace = data[12]!;
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length; // length + type + data + CRC
  }

  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(
      `Unsupported PNG format: bitDepth=${bitDepth} colorType=${colorType} (need 8-bit RGB/RGBA)`,
    );
  }
  if (interlace !== 0) {
    throw new Error('Interlaced PNG is not supported');
  }

  const channels = colorType === 6 ? 4 : 3;
  const bytesPerPixel = channels;
  const stride = width * bytesPerPixel;
  const raw = inflateSync(Buffer.concat(idatChunks));
  if (raw.length < height * (stride + 1)) {
    throw new Error(`PNG data truncated: ${raw.length} bytes, expected ${height * (stride + 1)}`);
  }

  const out = new Uint8Array(width * height * 4);
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
        case 0:
          predicted = rawByte;
          break;
        case 1:
          predicted = rawByte + left;
          break;
        case 2:
          predicted = rawByte + up;
          break;
        case 3:
          predicted = rawByte + ((left + up) >> 1);
          break;
        case 4:
          predicted = rawByte + paethPredictor(left, up, upLeft);
          break;
        default:
          throw new Error(`Unknown PNG scanline filter: ${filter}`);
      }
      line[x] = predicted & 0xff;
    }
    rawOffset += stride;
    prevLine = line;
    for (let x = 0; x < width; x++) {
      const src = x * bytesPerPixel;
      const dst = (y * width + x) * 4;
      out[dst] = line[src]!;
      out[dst + 1] = line[src + 1]!;
      out[dst + 2] = line[src + 2]!;
      out[dst + 3] = channels === 4 ? line[src + 3]! : 255;
    }
  }

  return { width, height, data: out };
}
