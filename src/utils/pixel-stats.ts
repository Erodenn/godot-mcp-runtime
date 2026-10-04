/**
 * Pixel statistics for a rendered frame, measured from a decoded PNG.
 *
 * This is the single statistics implementation for take_screenshot and movie
 * frames; there is no GDScript copy. The numbers (chromatic, dominant, distinct)
 * are observations of one frame sampled on a regular grid. isLikelyBlank is the
 * only derived verdict, and its thresholds are fixed constants, not parameters.
 *
 * The statistics code originates in PR 63 by Mickael Canevet.
 */

import { readFileSync } from 'fs';
import { decodePng } from './png-decoder.js';
import { getErrorMessage } from './error-response.js';
import { ok, err, type Result } from './result.js';

export const RGBA_BYTES_PER_PIXEL = 4;
/**
 * Sampling aims at about this many pixels per frame; the grid visits fewer than 4x this.
 * At 1920x1080 the step is 15 px (9,216 points); it was 22 px (4,400 points) at a target of 4096.
 */
export const PIXEL_SAMPLE_TARGET = 8192;
/** A pixel is chromatic when max(r,g,b) - min(r,g,b) exceeds this. */
export const CHROMATIC_SPREAD_THRESHOLD = 8;
/** Low bits dropped per channel before counting colors (4 bits kept). */
export const COLOR_QUANT_SHIFT = 4;
const BITS_PER_CHANNEL = 8;
const COLOR_BITS_KEPT = BITS_PER_CHANNEL - COLOR_QUANT_SHIFT;
export const LIKELY_BLANK_MIN_CHROMATIC = 0.01;
export const LIKELY_BLANK_MAX_DOMINANT = 0.98;
export const LIKELY_BLANK_MIN_DISTINCT = 3;

/** RGBA, row-major. */
export interface RgbaFrame {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface PixelStats {
  width: number;
  height: number;
  chromatic: number;
  dominant: number;
  distinct: number;
}

export interface MeasuredFrame {
  stats: PixelStats;
  likelyBlank: boolean;
  frame: RgbaFrame;
}

export function sampleStep(width: number, height: number): number {
  return Math.max(1, Math.floor(Math.sqrt((width * height) / PIXEL_SAMPLE_TARGET)));
}

/**
 * The one definition of the sampling grid. Calls visit with the byte offset of each
 * sampled pixel (x and y from 0 in steps of sampleStep) and returns how many were visited.
 */
export function forEachSampleOffset(
  width: number,
  height: number,
  visit: (byteOffset: number) => void,
): number {
  const step = sampleStep(width, height);
  let sampled = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      visit((y * width + x) * RGBA_BYTES_PER_PIXEL);
      sampled++;
    }
  }
  return sampled;
}

export function computePixelStats(frame: RgbaFrame): PixelStats {
  const { width, height, data } = frame;
  let chromaticPixels = 0;
  const colorCounts = new Map<number, number>();
  const sampled = forEachSampleOffset(width, height, (i) => {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    if (Math.max(r, g, b) - Math.min(r, g, b) > CHROMATIC_SPREAD_THRESHOLD) chromaticPixels++;
    const key =
      ((r >> COLOR_QUANT_SHIFT) << (2 * COLOR_BITS_KEPT)) |
      ((g >> COLOR_QUANT_SHIFT) << COLOR_BITS_KEPT) |
      (b >> COLOR_QUANT_SHIFT);
    colorCounts.set(key, (colorCounts.get(key) ?? 0) + 1);
  });
  if (sampled === 0) throw new RangeError('computePixelStats requires at least one pixel');
  let dominantCount = 0;
  for (const count of colorCounts.values()) if (count > dominantCount) dominantCount = count;
  return {
    width,
    height,
    chromatic: chromaticPixels / sampled,
    dominant: dominantCount / sampled,
    distinct: colorCounts.size,
  };
}

/** The only derived verdict. */
export function isLikelyBlank(
  stats: Pick<PixelStats, 'chromatic' | 'dominant' | 'distinct'>,
): boolean {
  if (stats.chromatic >= LIKELY_BLANK_MIN_CHROMATIC && stats.dominant < LIKELY_BLANK_MAX_DOMINANT) {
    return false;
  }
  return stats.distinct < LIKELY_BLANK_MIN_DISTINCT;
}

/** Never throws. The error is a short reason, without trailing punctuation. */
export function measurePngBuffer(buffer: Buffer): Result<MeasuredFrame, string> {
  try {
    const frame = decodePng(buffer);
    const stats = computePixelStats(frame);
    return ok({ stats, likelyBlank: isLikelyBlank(stats), frame });
  } catch (error) {
    return err(`could not decode the PNG (${getErrorMessage(error)})`);
  }
}

/** Never throws. */
export function measurePngFile(filePath: string): Result<MeasuredFrame, string> {
  let buffer: Buffer;
  try {
    buffer = readFileSync(filePath);
  } catch (error) {
    return err(`could not read the PNG file (${getErrorMessage(error)})`);
  }
  return measurePngBuffer(buffer);
}

const RGB_CHANNELS = 3;
const CHANNEL_MAX = 255;
/**
 * A sampled point counts as changed when any of its R, G, B channels differs by more than
 * this (of 255). Above the +-1..2 steps that dithering and lossy encoders add to a still
 * scene, and below the shift a real sprite, tint or fade produces.
 */
export const MOTION_CHANNEL_THRESHOLD = 8;
/** A pair shows motion when at least this many sampled points changed. */
export const MOTION_MIN_CHANGED_SAMPLES = 1;

export interface FrameDifference {
  /** Mean absolute R, G, B difference over the sampled points, 0..1. */
  mean: number;
  /** Sampled points where any channel moved by more than MOTION_CHANNEL_THRESHOLD. */
  changedSamples: number;
  /** Points on the sampling grid, so changedSamples / sampledPoints is the changed fraction. */
  sampledPoints: number;
}

/**
 * Compare two frames over the stats sampling grid. Alpha is ignored. Null when the
 * sizes differ, because no pairing of pixels is defined then.
 */
export function computeFrameDifference(a: RgbaFrame, b: RgbaFrame): FrameDifference | null {
  if (a.width !== b.width || a.height !== b.height) return null;
  let total = 0;
  let changedSamples = 0;
  const sampled = forEachSampleOffset(a.width, a.height, (i) => {
    let changed = false;
    for (let channel = 0; channel < RGB_CHANNELS; channel++) {
      const delta = Math.abs(a.data[i + channel]! - b.data[i + channel]!);
      total += delta;
      if (delta > MOTION_CHANNEL_THRESHOLD) changed = true;
    }
    if (changed) changedSamples++;
  });
  if (sampled === 0) return null;
  return {
    mean: total / (sampled * RGB_CHANNELS * CHANNEL_MAX),
    changedSamples,
    sampledPoints: sampled,
  };
}

/** True when enough sampled points changed. Decided by count, not by the mean. */
export function showsMotion(difference: Pick<FrameDifference, 'changedSamples'>): boolean {
  return difference.changedSamples >= MOTION_MIN_CHANGED_SAMPLES;
}
