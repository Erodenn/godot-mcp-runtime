import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'fs';
import { join } from 'path';
import {
  computeFrameDifference,
  computePixelStats,
  forEachSampleOffset,
  isLikelyBlank,
  measurePngBuffer,
  measurePngFile,
  sampleStep,
  BLANK_CHANNEL_TOLERANCE,
  MOTION_CHANNEL_THRESHOLD,
  MOTION_MIN_CHANGED_PIXELS,
  MOTION_REFERENCE_FRAME_PIXELS,
  motionMinChangedPixels,
  showsMotion,
} from '../../src/utils/pixel-stats.js';
import { encodePng, invalidPng, solidRgba } from '../helpers/png-fixtures.js';
import { useTmpDirs } from '../helpers/tmp.js';

const BYTES_PER_PIXEL = 4;
const DARK: readonly [number, number, number, number] = [16, 16, 16, 255];
const RED: readonly [number, number, number, number] = [255, 0, 0, 255];

function setPixel(
  data: Uint8Array,
  index: number,
  pixel: readonly [number, number, number, number],
): void {
  data.set(pixel, index * BYTES_PER_PIXEL);
}

describe('computePixelStats', () => {
  it('reports chromatic fraction and dominant share for a mixed frame', () => {
    // 2x2: red, green, blue, black
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 0, 255]);
    const stats = computePixelStats({ width: 2, height: 2, data: rgba });
    expect(stats.chromatic).toBe(0.75); // 3 colorful pixels out of 4
    expect(stats.dominant).toBe(0.25); // no color repeats
    expect(stats.distinct).toBe(4);
  });

  it('flags a uniform dark frame as low-chromatic, high-dominant', () => {
    // 4x4 all black
    const rgba = new Uint8Array(64);
    const stats = computePixelStats({ width: 4, height: 4, data: rgba });
    expect(stats.chromatic).toBe(0);
    expect(stats.dominant).toBe(1);
    expect(stats.distinct).toBe(1);
  });

  it('handles RGB-only input (fills alpha to 255)', () => {
    // 1x1 RGB red
    const rgba = new Uint8Array([255, 0, 0]);
    const stats = computePixelStats({ width: 1, height: 1, data: rgba });
    expect(stats.chromatic).toBe(1);
    expect(stats.dominant).toBe(1);
  });

  it('measures only the sampling grid', () => {
    const size = 256; // the grid steps by 2 at this size
    const data = solidRgba(size, size, [0, 0, 0, 255]);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (x % 2 === 1 || y % 2 === 1) setPixel(data, y * size + x, RED);
      }
    }
    const stats = computePixelStats({ width: size, height: size, data });
    expect(stats.chromatic).toBe(0);
    expect(stats.dominant).toBe(1);
    expect(stats.distinct).toBe(1);
  });

  it('throws on a frame with no pixels', () => {
    expect(() => computePixelStats({ width: 0, height: 0, data: new Uint8Array(0) })).toThrow(
      RangeError,
    );
  });
});

describe('sampling grid', () => {
  it('steps by 1 below the sample target', () => {
    expect(sampleStep(2, 2)).toBe(1);
  });

  it.each([
    [128, 128, 1],
    [1152, 648, 9],
    [1920, 1080, 15],
  ])('steps %i x %i frames by %i', (width, height, expected) => {
    expect(sampleStep(width, height)).toBe(expected);
  });

  it('visits row-major byte offsets and returns the count', () => {
    const small: number[] = [];
    expect(forEachSampleOffset(4, 4, (offset) => small.push(offset))).toBe(16);
    expect(small.slice(0, 3)).toEqual([0, 4, 8]);

    const large: number[] = [];
    expect(forEachSampleOffset(128, 128, (offset) => large.push(offset))).toBe(16384);
    expect(large[1]).toBe(4);
    expect(large[64]).toBe(256);
  });
});

describe('isLikelyBlank', () => {
  const BLACK: readonly [number, number, number, number] = [0, 0, 0, 255];
  const WHITE: readonly [number, number, number, number] = [255, 255, 255, 255];
  const HD_WIDTH = 1920;
  const HD_HEIGHT = 1080;
  const GREY = 100;

  function blank(width: number, height: number, data: Uint8Array): boolean {
    return isLikelyBlank({ width, height, data });
  }

  it('pins the tolerance', () => {
    expect(BLANK_CHANNEL_TOLERANCE).toBe(8);
  });

  it('a frame of one flat colour is blank', () => {
    expect(blank(4, 4, solidRgba(4, 4, BLACK))).toBe(true);
    expect(blank(4, 4, solidRgba(4, 4, RED))).toBe(true);
  });

  it('a frame whose only content is one small sprite between the sampling points is not blank', () => {
    const data = solidRgba(HD_WIDTH, HD_HEIGHT, DARK);
    const step = sampleStep(HD_WIDTH, HD_HEIGHT);
    expect(step).toBeGreaterThan(2);
    // One pixel, placed where no grid point lands, so the sampled stats see a flat frame.
    setPixel(data, HD_WIDTH + 1, RED);
    const stats = computePixelStats({ width: HD_WIDTH, height: HD_HEIGHT, data });
    expect(stats.distinct).toBe(1);
    expect(blank(HD_WIDTH, HD_HEIGHT, data)).toBe(false);
  });

  it('white text on black is not blank: two colours and no chroma is rendered content', () => {
    const data = solidRgba(10, 10, BLACK);
    for (const index of [0, 1, 10, 11]) setPixel(data, index, WHITE);
    const stats = computePixelStats({ width: 10, height: 10, data });
    expect(stats.chromatic).toBe(0);
    expect(stats.distinct).toBe(2);
    expect(blank(10, 10, data)).toBe(false);
  });

  it('a 1-bit black and white frame is not blank', () => {
    const data = solidRgba(8, 8, BLACK);
    for (let index = 0; index < 64; index += 2) setPixel(data, index, WHITE);
    expect(blank(8, 8, data)).toBe(false);
  });

  it('a flat frame whose channels wander within the tolerance is blank', () => {
    const data = solidRgba(4, 4, [GREY, GREY, GREY, 255]);
    setPixel(data, 3, [GREY + BLANK_CHANNEL_TOLERANCE, GREY, GREY, 255]);
    setPixel(data, 7, [GREY, GREY + BLANK_CHANNEL_TOLERANCE / 2, GREY, 255]);
    expect(blank(4, 4, data)).toBe(true);
  });

  it('one channel one step past the tolerance is not blank, whichever pixel comes first', () => {
    const over = GREY + BLANK_CHANNEL_TOLERANCE + 1;
    const late = solidRgba(4, 4, [GREY, GREY, GREY, 255]);
    setPixel(late, 15, [GREY, GREY, over, 255]);
    expect(blank(4, 4, late)).toBe(false);
    const early = solidRgba(4, 4, [GREY, GREY, GREY, 255]);
    setPixel(early, 0, [GREY, GREY, over, 255]);
    expect(blank(4, 4, early)).toBe(false);
  });

  it('ignores alpha', () => {
    const data = solidRgba(2, 2, [GREY, GREY, GREY, 255]);
    setPixel(data, 1, [GREY, GREY, GREY, 0]);
    expect(blank(2, 2, data)).toBe(true);
  });

  it('throws on an empty frame', () => {
    expect(() => blank(0, 0, new Uint8Array(0))).toThrow(RangeError);
  });
});

describe('measurePngBuffer and measurePngFile', () => {
  const tmp = useTmpDirs();

  it('measures an encoded PNG and returns the decoded frame', () => {
    const data = solidRgba(4, 4, [0, 0, 0, 255]);
    const result = measurePngBuffer(encodePng(4, 4, data));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stats).toEqual(computePixelStats({ width: 4, height: 4, data }));
    expect(result.value.frame.width).toBe(4);
    expect(result.value.frame.height).toBe(4);
    expect(result.value.likelyBlank).toBe(true);
  });

  it('judges blankness on the whole frame, not on the sampled stats', () => {
    const SIDE = 256;
    const data = solidRgba(SIDE, SIDE, DARK);
    expect(sampleStep(SIDE, SIDE)).toBeGreaterThan(1);
    setPixel(data, SIDE + 1, RED);
    const result = measurePngBuffer(encodePng(SIDE, SIDE, data));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stats.distinct).toBe(1);
    expect(result.value.likelyBlank).toBe(false);
  });

  it('returns a decode reason for bytes that are not a PNG', () => {
    const result = measurePngBuffer(invalidPng());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/could not decode the PNG/);
  });

  it('returns a read reason for a missing file', () => {
    const result = measurePngFile(join(tmp.make('pixel-stats-'), 'missing.png'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/could not read the PNG file/);
  });

  it('measures a PNG file on disk', () => {
    const filePath = join(tmp.make('pixel-stats-'), 'frame.png');
    writeFileSync(filePath, encodePng(2, 2, solidRgba(2, 2, RED)));
    const result = measurePngFile(filePath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stats.chromatic).toBe(1);
    expect(result.value.stats.dominant).toBe(1);
  });
});

describe('computeFrameDifference', () => {
  const BLACK: readonly [number, number, number, number] = [0, 0, 0, 255];
  const WHITE: readonly [number, number, number, number] = [255, 255, 255, 255];
  const MOVER_SIDE = 8;
  const WIDE_FRAME_WIDTH = 1920;
  const WIDE_FRAME_HEIGHT = 1080;
  const SUB_THRESHOLD_NOISE = MOTION_CHANNEL_THRESHOLD;
  const OVER_THRESHOLD_STEP = MOTION_CHANNEL_THRESHOLD + 1;

  function frame(
    width: number,
    height: number,
    pixel: readonly [number, number, number, number],
  ): { width: number; height: number; data: Uint8Array } {
    return { width, height, data: solidRgba(width, height, pixel) };
  }

  it('pins the motion constants', () => {
    expect(MOTION_CHANNEL_THRESHOLD).toBe(8);
    expect(MOTION_MIN_CHANGED_PIXELS).toBe(4);
  });

  it('returns 0 mean, no changed pixels and no bounds for identical frames', () => {
    const d = computeFrameDifference(frame(4, 4, RED), frame(4, 4, RED))!;
    expect(d.mean).toBe(0);
    expect(d.changedPixels).toBe(0);
    expect(d.totalPixels).toBe(16);
    expect(d.changedBounds).toBeNull();
    expect(showsMotion(d)).toBe(false);
  });

  it('returns mean 1 and every pixel changed for black against white', () => {
    const d = computeFrameDifference(frame(4, 4, BLACK), frame(4, 4, WHITE))!;
    expect(d.mean).toBe(1);
    expect(d.changedPixels).toBe(16);
    expect(d.changedBounds).toEqual({ x: 0, y: 0, width: 4, height: 4 });
  });

  it('returns mean 0.25 when one of four pixels flips black to white', () => {
    const a = frame(2, 2, BLACK);
    const b = frame(2, 2, BLACK);
    setPixel(b.data, 0, WHITE);
    const d = computeFrameDifference(a, b)!;
    expect(d.mean).toBe(0.25);
    expect(d.changedPixels).toBe(1);
  });

  it('ignores alpha', () => {
    const a = frame(4, 4, [10, 20, 30, 255]);
    const b = frame(4, 4, [10, 20, 30, 0]);
    const d = computeFrameDifference(a, b)!;
    expect(d.mean).toBe(0);
    expect(d.changedPixels).toBe(0);
  });

  it('returns null when the frames differ in size, or hold no pixel', () => {
    expect(computeFrameDifference(frame(4, 4, RED), frame(4, 2, RED))).toBeNull();
    const empty = { width: 0, height: 0, data: new Uint8Array(0) };
    expect(computeFrameDifference(empty, empty)).toBeNull();
  });

  /** Paint a `width` x `height` block of `pixel` with its top left at (x, y). */
  function paint(
    target: { width: number; data: Uint8Array },
    x: number,
    y: number,
    width: number,
    height: number,
    pixel: readonly [number, number, number, number],
  ): void {
    for (let row = y; row < y + height; row++) {
      for (let column = x; column < x + width; column++) {
        setPixel(target.data, row * target.width + column, pixel);
      }
    }
  }

  it('sees an 8x8 mover that stays between the rows and columns of the sampling grid', () => {
    const step = sampleStep(WIDE_FRAME_WIDTH, WIDE_FRAME_HEIGHT);
    expect(step).toBeGreaterThan(MOVER_SIDE + 2);
    const a = frame(WIDE_FRAME_WIDTH, WIDE_FRAME_HEIGHT, BLACK);
    const b = frame(WIDE_FRAME_WIDTH, WIDE_FRAME_HEIGHT, BLACK);
    // Both positions sit strictly inside one grid cell: no sampled point is touched.
    const cellX = step * 10 + 1;
    const cellY = step * 10 + 1;
    paint(a, cellX, cellY, MOVER_SIDE, MOVER_SIDE, WHITE);
    paint(b, cellX + 2, cellY, MOVER_SIDE, MOVER_SIDE, WHITE);
    expect(computePixelStats(a)).toEqual(computePixelStats(b));

    const d = computeFrameDifference(a, b)!;
    // Two columns left behind and two columns newly covered.
    expect(d.changedPixels).toBe(2 * 2 * MOVER_SIDE);
    expect(d.changedBounds).toEqual({
      x: cellX,
      y: cellY,
      width: MOVER_SIDE + 2,
      height: MOVER_SIDE,
    });
    expect(showsMotion(d)).toBe(true);
  });

  it('sees a 2 px wide caret that blinks off between two frames', () => {
    const CARET_WIDTH = 2;
    const CARET_HEIGHT = 14;
    const a = frame(WIDE_FRAME_WIDTH, WIDE_FRAME_HEIGHT, BLACK);
    const b = frame(WIDE_FRAME_WIDTH, WIDE_FRAME_HEIGHT, BLACK);
    paint(a, 301, 211, CARET_WIDTH, CARET_HEIGHT, WHITE);
    const d = computeFrameDifference(a, b)!;
    expect(d.changedPixels).toBe(CARET_WIDTH * CARET_HEIGHT);
    expect(d.changedBounds).toEqual({ x: 301, y: 211, width: CARET_WIDTH, height: CARET_HEIGHT });
    expect(d.mean).toBeLessThan(0.0005);
    expect(showsMotion(d)).toBe(true);
  });

  it('does not show motion for a few isolated pixels of temporal noise', () => {
    const a = frame(WIDE_FRAME_WIDTH, WIDE_FRAME_HEIGHT, BLACK);
    const b = frame(WIDE_FRAME_WIDTH, WIDE_FRAME_HEIGHT, BLACK);
    for (let n = 0; n < MOTION_MIN_CHANGED_PIXELS - 1; n++) {
      setPixel(b.data, n * 1000, WHITE);
    }
    const d = computeFrameDifference(a, b)!;
    expect(d.changedPixels).toBe(MOTION_MIN_CHANGED_PIXELS - 1);
    expect(showsMotion(d)).toBe(false);
  });

  it('scales the changed-pixel threshold with the frame and never goes under the floor', () => {
    const UHD_PIXELS = 3840 * 2160;
    expect(MOTION_REFERENCE_FRAME_PIXELS).toBe(1152 * 648);
    expect(motionMinChangedPixels(1)).toBe(MOTION_MIN_CHANGED_PIXELS);
    expect(motionMinChangedPixels(MOTION_REFERENCE_FRAME_PIXELS)).toBe(MOTION_MIN_CHANGED_PIXELS);
    expect(motionMinChangedPixels(WIDE_FRAME_WIDTH * WIDE_FRAME_HEIGHT)).toBe(12);
    expect(motionMinChangedPixels(UHD_PIXELS)).toBe(45);
  });

  it('reports the threshold a pair was held to, and decides motion by it', () => {
    const small = computeFrameDifference(frame(4, 4, BLACK), frame(4, 4, WHITE))!;
    expect(small.motionThreshold).toBe(MOTION_MIN_CHANGED_PIXELS);

    const a = frame(WIDE_FRAME_WIDTH, WIDE_FRAME_HEIGHT, BLACK);
    const b = frame(WIDE_FRAME_WIDTH, WIDE_FRAME_HEIGHT, BLACK);
    const WIDE_THRESHOLD = 12;
    // Isolated pixels: over the floor a small frame is held to, under this frame's threshold.
    for (let n = 0; n < WIDE_THRESHOLD - 1; n++) setPixel(b.data, n * 1000, WHITE);
    const below = computeFrameDifference(a, b)!;
    expect(below.motionThreshold).toBe(WIDE_THRESHOLD);
    expect(below.changedPixels).toBe(WIDE_THRESHOLD - 1);
    expect(below.changedPixels).toBeGreaterThanOrEqual(MOTION_MIN_CHANGED_PIXELS);
    expect(showsMotion(below)).toBe(false);

    setPixel(b.data, (WIDE_THRESHOLD - 1) * 1000, WHITE);
    const at = computeFrameDifference(a, b)!;
    expect(at.changedPixels).toBe(WIDE_THRESHOLD);
    expect(showsMotion(at)).toBe(true);
  });

  it('does not show motion for sub-threshold noise at every pixel', () => {
    const a = frame(WIDE_FRAME_WIDTH, WIDE_FRAME_HEIGHT, [100, 100, 100, 255]);
    const noisy = frame(WIDE_FRAME_WIDTH, WIDE_FRAME_HEIGHT, [
      100 + SUB_THRESHOLD_NOISE,
      100 - SUB_THRESHOLD_NOISE,
      100 + SUB_THRESHOLD_NOISE,
      255,
    ]);
    const d = computeFrameDifference(a, noisy)!;
    expect(d.changedPixels).toBe(0);
    expect(d.mean).toBeGreaterThan(0);
    expect(showsMotion(d)).toBe(false);
  });

  it('counts a pixel whose single channel exceeds the threshold', () => {
    const a = frame(4, 4, [100, 100, 100, 255]);
    const b = frame(4, 4, [100, 100 + OVER_THRESHOLD_STEP, 100, 255]);
    expect(computeFrameDifference(a, b)!.changedPixels).toBe(16);
  });
});
