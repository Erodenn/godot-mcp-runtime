/**
 * Pixel statistics for a rendered frame, measured from a decoded PNG.
 *
 * This is the single statistics implementation for take_screenshot and movie
 * frames; there is no GDScript copy. The colour numbers (chromatic, dominant,
 * distinct) are observations of one frame sampled on a regular grid, which is
 * what a colour distribution wants. The two verdicts are not sampled: whether
 * a frame is blank (isLikelyBlank) and whether two frames differ
 * (computeFrameDifference, showsMotion) are decided over every pixel, because
 * the thing they ask about, one small sprite or a two-pixel caret, fits
 * between the points of any grid. Their thresholds are not parameters: fixed
 * constants, and for motion a count that follows the frame's size.
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
const RGB_CHANNELS = 3;
const CHANNEL_MAX = 255;
const COLOR_BITS_KEPT = BITS_PER_CHANNEL - COLOR_QUANT_SHIFT;
/**
 * A frame is blank when no channel varies by more than this (of 255) across
 * the whole frame: one flat colour, give or take the +-1..2 steps debanding
 * and dithering add to a cleared viewport.
 */
export const BLANK_CHANNEL_TOLERANCE = 8;

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

/**
 * True when the whole frame is one flat colour, within
 * BLANK_CHANNEL_TOLERANCE per channel. Every pixel is read, so a frame whose
 * only content is one small sprite is not blank, and neither is a frame of
 * two colours however few there are: white text on black, or a 1-bit game, is
 * rendered content. Alpha is ignored.
 */
export function isLikelyBlank(frame: RgbaFrame): boolean {
  const { data } = frame;
  const end = frame.width * frame.height * RGBA_BYTES_PER_PIXEL;
  if (end === 0) throw new RangeError('isLikelyBlank requires at least one pixel');
  // The running range of each channel. The scan stops at the first pixel
  // that widens one past the tolerance, so a rendered frame costs a few
  // pixels and only a blank one is read to the end.
  const low = new Uint8Array(RGB_CHANNELS).fill(CHANNEL_MAX);
  const high = new Uint8Array(RGB_CHANNELS);
  for (let i = 0; i < end; i += RGBA_BYTES_PER_PIXEL) {
    for (let channel = 0; channel < RGB_CHANNELS; channel++) {
      const value = data[i + channel]!;
      if (value < low[channel]!) low[channel] = value;
      if (value > high[channel]!) high[channel] = value;
      if (high[channel]! - low[channel]! > BLANK_CHANNEL_TOLERANCE) return false;
    }
  }
  return true;
}

/** Never throws. The error is a short reason, without trailing punctuation. */
export function measurePngBuffer(buffer: Buffer): Result<MeasuredFrame, string> {
  try {
    const frame = decodePng(buffer);
    const stats = computePixelStats(frame);
    return ok({ stats, likelyBlank: isLikelyBlank(frame), frame });
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

/**
 * A pixel counts as changed when any of its R, G, B channels differs by more than this
 * (of 255). Above the +-1..2 steps that dithering and lossy encoders add to a still
 * scene, and below the shift a real sprite, tint or fade produces.
 */
export const MOTION_CHANNEL_THRESHOLD = 8;
/**
 * The fewest changed pixels that show motion, at any frame size. A two-pixel caret blinking
 * or an 8x8 sprite moving changes far more; one or two pixels flickering past the channel
 * threshold is what temporal anti-aliasing and reprojection noise leave on a still scene.
 */
export const MOTION_MIN_CHANGED_PIXELS = 4;
export const MOTION_REFERENCE_FRAME_WIDTH = 1152;
export const MOTION_REFERENCE_FRAME_HEIGHT = 648;
/** The frame the floor is sized for: Godot's default viewport. */
export const MOTION_REFERENCE_FRAME_PIXELS =
  MOTION_REFERENCE_FRAME_WIDTH * MOTION_REFERENCE_FRAME_HEIGHT;

/**
 * The changed-pixel count a pair of frames of `totalPixels` needs to show motion. Noise
 * pixels grow with the frame's area, so the threshold does too: the floor up to the
 * reference frame, then in proportion (12 at 1920x1080, 45 at 3840x2160).
 */
export function motionMinChangedPixels(totalPixels: number): number {
  return Math.max(
    MOTION_MIN_CHANGED_PIXELS,
    Math.ceil((MOTION_MIN_CHANGED_PIXELS * totalPixels) / MOTION_REFERENCE_FRAME_PIXELS),
  );
}

/** The smallest rectangle holding every changed pixel, in frame pixels from the top left. */
export interface ChangedBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FrameDifference {
  /** Mean absolute R, G, B difference over every pixel, 0..1. */
  mean: number;
  /** Pixels where any channel moved by more than MOTION_CHANNEL_THRESHOLD. */
  changedPixels: number;
  /** Pixels compared, so changedPixels / totalPixels is the changed fraction. */
  totalPixels: number;
  /** The changedPixels count this pair needs to show motion; see motionMinChangedPixels. */
  motionThreshold: number;
  /** Null when no pixel changed. */
  changedBounds: ChangedBounds | null;
}

/**
 * Compare two frames pixel by pixel. Alpha is ignored. Null when the sizes differ,
 * because no pairing of pixels is defined then, or when there is no pixel to compare.
 */
export function computeFrameDifference(a: RgbaFrame, b: RgbaFrame): FrameDifference | null {
  if (a.width !== b.width || a.height !== b.height) return null;
  const { width, height } = a;
  const totalPixels = width * height;
  if (totalPixels === 0) return null;
  let total = 0;
  let changedPixels = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let i = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i += RGBA_BYTES_PER_PIXEL) {
      const red = Math.abs(a.data[i]! - b.data[i]!);
      const green = Math.abs(a.data[i + 1]! - b.data[i + 1]!);
      const blue = Math.abs(a.data[i + 2]! - b.data[i + 2]!);
      total += red + green + blue;
      if (
        red <= MOTION_CHANNEL_THRESHOLD &&
        green <= MOTION_CHANNEL_THRESHOLD &&
        blue <= MOTION_CHANNEL_THRESHOLD
      ) {
        continue;
      }
      changedPixels++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return {
    mean: total / (totalPixels * RGB_CHANNELS * CHANNEL_MAX),
    changedPixels,
    totalPixels,
    motionThreshold: motionMinChangedPixels(totalPixels),
    changedBounds:
      changedPixels === 0
        ? null
        : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
  };
}

/** True when enough pixels changed for the frame's size. Decided by count, not by the mean. */
export function showsMotion(
  difference: Pick<FrameDifference, 'changedPixels' | 'motionThreshold'>,
): boolean {
  return difference.changedPixels >= difference.motionThreshold;
}
