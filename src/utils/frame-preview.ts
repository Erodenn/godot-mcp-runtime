import { encodeRgbPng } from './png-encoder.js';
import { RGBA_BYTES_PER_PIXEL, type RgbaFrame } from './pixel-stats.js';

/** Each retry of a preview that is still over its byte cap doubles the downscale factor. */
const PREVIEW_HALVING_FACTOR = 2;

/** Box-downscale by an integer factor: each output pixel is the rounded mean of its source block, clamped at the frame edges; output is floor(size / factor) per axis, at least 1. */
export function downscaleRgba(frame: RgbaFrame, factor: number): RgbaFrame {
  if (factor <= 1) return frame;
  const outWidth = Math.max(1, Math.floor(frame.width / factor));
  const outHeight = Math.max(1, Math.floor(frame.height / factor));
  const out = new Uint8Array(outWidth * outHeight * RGBA_BYTES_PER_PIXEL);
  const sums = new Array<number>(RGBA_BYTES_PER_PIXEL);
  for (let oy = 0; oy < outHeight; oy++) {
    const y0 = oy * factor;
    const y1 = Math.min(frame.height, y0 + factor);
    for (let ox = 0; ox < outWidth; ox++) {
      const x0 = ox * factor;
      const x1 = Math.min(frame.width, x0 + factor);
      sums.fill(0);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const source = (y * frame.width + x) * RGBA_BYTES_PER_PIXEL;
          for (let channel = 0; channel < RGBA_BYTES_PER_PIXEL; channel++) {
            sums[channel] = sums[channel]! + frame.data[source + channel]!;
          }
        }
      }
      const count = (y1 - y0) * (x1 - x0);
      const target = (oy * outWidth + ox) * RGBA_BYTES_PER_PIXEL;
      for (let channel = 0; channel < RGBA_BYTES_PER_PIXEL; channel++) {
        out[target + channel] = Math.round(sums[channel]! / count);
      }
    }
  }
  return { width: outWidth, height: outHeight, data: out };
}

export interface FramePreview {
  png: Buffer;
  width: number;
  height: number;
  factor: number;
}

/** Downscales by the smallest integer factor fitting maxWidth x maxHeight, encodes as PNG, and keeps halving until within maxBytes (or one pixel). */
export function buildFramePreview(
  frame: RgbaFrame,
  maxWidth: number,
  maxHeight: number,
  maxBytes: number,
): FramePreview {
  let factor = Math.max(1, Math.ceil(Math.max(frame.width / maxWidth, frame.height / maxHeight)));
  let scaled = downscaleRgba(frame, factor);
  let png = encodeRgbPng(scaled);
  while (png.length > maxBytes && (scaled.width > 1 || scaled.height > 1)) {
    factor *= PREVIEW_HALVING_FACTOR;
    scaled = downscaleRgba(frame, factor);
    png = encodeRgbPng(scaled);
  }
  return { png, width: scaled.width, height: scaled.height, factor };
}
