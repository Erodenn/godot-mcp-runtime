import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'fs';
import { join } from 'path';
import {
  computePixelStats,
  forEachSampleOffset,
  isLikelyBlank,
  measurePngBuffer,
  measurePngFile,
  sampleStep,
  LIKELY_BLANK_MAX_DOMINANT,
  LIKELY_BLANK_MIN_CHROMATIC,
  LIKELY_BLANK_MIN_DISTINCT,
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
    const size = 128;
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
    [128, 128, 2],
    [1152, 648, 13],
    [1920, 1080, 22],
  ])('steps %i x %i frames by %i', (width, height, expected) => {
    expect(sampleStep(width, height)).toBe(expected);
  });

  it('visits row-major byte offsets and returns the count', () => {
    const small: number[] = [];
    expect(forEachSampleOffset(4, 4, (offset) => small.push(offset))).toBe(16);
    expect(small.slice(0, 3)).toEqual([0, 4, 8]);

    const large: number[] = [];
    expect(forEachSampleOffset(128, 128, (offset) => large.push(offset))).toBe(4096);
    expect(large[1]).toBe(8);
    expect(large[64]).toBe(1024);
  });
});

describe('isLikelyBlank', () => {
  it('pins the three thresholds', () => {
    expect(LIKELY_BLANK_MIN_CHROMATIC).toBe(0.01);
    expect(LIKELY_BLANK_MAX_DOMINANT).toBe(0.98);
    expect(LIKELY_BLANK_MIN_DISTINCT).toBe(3);
  });

  it('uniform frame is likely blank', () => {
    const stats = computePixelStats({
      width: 4,
      height: 4,
      data: solidRgba(4, 4, [0, 0, 0, 255]),
    });
    expect(isLikelyBlank(stats)).toBe(true);
  });

  it('sprite on a dark background is not blank', () => {
    const data = solidRgba(10, 10, DARK);
    for (const index of [0, 1, 10, 11]) setPixel(data, index, RED);
    const stats = computePixelStats({ width: 10, height: 10, data });
    expect(stats.chromatic).toBe(0.04);
    expect(stats.dominant).toBe(0.96);
    expect(stats.distinct).toBe(2);
    expect(isLikelyBlank(stats)).toBe(false);
  });

  it('monochrome but textured frame is not blank via the distinct rule', () => {
    const data = solidRgba(10, 10, DARK);
    setPixel(data, 0, [128, 128, 128, 255]);
    setPixel(data, 1, [240, 240, 240, 255]);
    const stats = computePixelStats({ width: 10, height: 10, data });
    expect(stats.chromatic).toBe(0);
    expect(stats.dominant).toBe(0.98);
    expect(stats.distinct).toBe(3);
    expect(isLikelyBlank(stats)).toBe(false);
  });

  it('chromatic boundary is inclusive', () => {
    expect(
      isLikelyBlank({ chromatic: LIKELY_BLANK_MIN_CHROMATIC, dominant: 0.5, distinct: 1 }),
    ).toBe(false);
    expect(isLikelyBlank({ chromatic: 0.0099, dominant: 0.5, distinct: 1 })).toBe(true);
  });

  it('dominant boundary is exclusive', () => {
    expect(
      isLikelyBlank({ chromatic: 0.5, dominant: LIKELY_BLANK_MAX_DOMINANT, distinct: 2 }),
    ).toBe(true);
    expect(isLikelyBlank({ chromatic: 0.5, dominant: 0.9799, distinct: 2 })).toBe(false);
  });

  it('distinct boundary is inclusive', () => {
    expect(isLikelyBlank({ chromatic: 0, dominant: 1, distinct: LIKELY_BLANK_MIN_DISTINCT })).toBe(
      false,
    );
    expect(isLikelyBlank({ chromatic: 0, dominant: 1, distinct: 2 })).toBe(true);
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
