import { describe, it, expect } from 'vitest';
import { buildFramePreview, downscaleRgba } from '../../src/utils/frame-preview.js';
import { decodePng } from '../../src/utils/png-decoder.js';
import { solidRgba } from '../helpers/png-fixtures.js';
import type { RgbaFrame } from '../../src/utils/pixel-stats.js';

const BYTES_PER_PIXEL = 4;
const OPAQUE = 255;
const PREVIEW_MAX_WIDTH = 960;
const PREVIEW_MAX_HEIGHT = 540;
const GENEROUS_BYTE_CAP = 10 * 1024 * 1024;
const NOISE_SIZE = 256;
const NOISE_BYTE_CAP = 2000;
const LCG_MULTIPLIER = 1664525;
const LCG_INCREMENT = 1013904223;
const LCG_MODULUS = 4294967296;
const LCG_BYTE_SHIFT = 24;

function solidFrame(width: number, height: number): RgbaFrame {
  return { width, height, data: solidRgba(width, height, [40, 90, 160, OPAQUE]) };
}

function noiseFrame(size: number): RgbaFrame {
  const data = new Uint8Array(size * size * BYTES_PER_PIXEL);
  let state = 1;
  for (let i = 0; i < data.length; i++) {
    state = (state * LCG_MULTIPLIER + LCG_INCREMENT) % LCG_MODULUS;
    data[i] = i % BYTES_PER_PIXEL === BYTES_PER_PIXEL - 1 ? OPAQUE : state >>> LCG_BYTE_SHIFT;
  }
  return { width: size, height: size, data };
}

describe('downscaleRgba', () => {
  it('factor 1 returns the same pixels', () => {
    const frame = noiseFrame(4);
    const out = downscaleRgba(frame, 1);
    expect(out.width).toBe(4);
    expect(out.height).toBe(4);
    expect(Array.from(out.data)).toEqual(Array.from(frame.data));
  });

  it('averages each 2x2 block', () => {
    // 4x4 made of four flat 2x2 blocks: 0, 100, 200, 250 on the red channel.
    const blockValues = [0, 100, 200, 250];
    const data = new Uint8Array(4 * 4 * BYTES_PER_PIXEL);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const block = Math.floor(y / 2) * 2 + Math.floor(x / 2);
        data.set([blockValues[block]!, 0, 0, OPAQUE], (y * 4 + x) * BYTES_PER_PIXEL);
      }
    }
    const out = downscaleRgba({ width: 4, height: 4, data }, 2);
    expect(out.width).toBe(2);
    expect(out.height).toBe(2);
    const reds = [0, 1, 2, 3].map((i) => out.data[i * BYTES_PER_PIXEL]);
    expect(reds).toEqual(blockValues);
  });

  it('floors a size that does not divide', () => {
    const out = downscaleRgba(solidFrame(5, 3), 2);
    expect(out.width).toBe(2);
    expect(out.height).toBe(1);
  });
});

describe('buildFramePreview', () => {
  it('fits 1920x1080 into 960x540 at factor 2', () => {
    const preview = buildFramePreview(
      solidFrame(1920, 1080),
      PREVIEW_MAX_WIDTH,
      PREVIEW_MAX_HEIGHT,
      GENEROUS_BYTE_CAP,
    );
    expect(preview.factor).toBe(2);
    expect(preview.width).toBe(960);
    expect(preview.height).toBe(540);
  });

  it('leaves 960x540 at factor 1', () => {
    const preview = buildFramePreview(
      solidFrame(960, 540),
      PREVIEW_MAX_WIDTH,
      PREVIEW_MAX_HEIGHT,
      GENEROUS_BYTE_CAP,
    );
    expect(preview.factor).toBe(1);
    expect(preview.width).toBe(960);
    expect(preview.height).toBe(540);
  });

  it('halves again until under the byte cap', () => {
    const preview = buildFramePreview(
      noiseFrame(NOISE_SIZE),
      PREVIEW_MAX_WIDTH,
      PREVIEW_MAX_HEIGHT,
      NOISE_BYTE_CAP,
    );
    expect(preview.png.length).toBeLessThanOrEqual(NOISE_BYTE_CAP);
    expect(preview.factor).toBeGreaterThan(1);
    const decoded = decodePng(preview.png);
    expect(decoded.width).toBe(preview.width);
    expect(decoded.height).toBe(preview.height);
  });

  it('the preview decodes to its reported size', () => {
    const preview = buildFramePreview(
      solidFrame(1000, 700),
      PREVIEW_MAX_WIDTH,
      PREVIEW_MAX_HEIGHT,
      GENEROUS_BYTE_CAP,
    );
    const decoded = decodePng(preview.png);
    expect(decoded.width).toBe(preview.width);
    expect(decoded.height).toBe(preview.height);
  });
});
