import { describe, it, expect } from 'vitest';
import { decodePng } from '../../src/utils/png-decoder.js';
import { encodePng } from '../helpers/png-fixtures.js';

const IMAGE_WIDTH = 5;
const IMAGE_HEIGHT = 4;
const RGBA_CHANNELS = 4;
const ALPHA_OFFSET = 3;
const OPAQUE_ALPHA = 255;
const BYTE_RANGE = 256;
/** Multipliers chosen so neighbouring bytes differ and no row repeats its predecessor. */
const BYTE_STRIDE = 37;
const ROW_STRIDE = 91;
const BYTE_SEED = 11;

/** Deterministic RGBA data where every byte varies. */
function makeRgba(): Uint8Array {
  const data = new Uint8Array(IMAGE_WIDTH * IMAGE_HEIGHT * RGBA_CHANNELS);
  for (let y = 0; y < IMAGE_HEIGHT; y++) {
    for (let i = 0; i < IMAGE_WIDTH * RGBA_CHANNELS; i++) {
      data[y * IMAGE_WIDTH * RGBA_CHANNELS + i] =
        (BYTE_SEED + i * BYTE_STRIDE + y * ROW_STRIDE) % BYTE_RANGE;
    }
  }
  return data;
}

const FILTERS = [0, 1, 2, 3, 4] as const;
const CASES = ([3, 4] as const).flatMap((channels) =>
  FILTERS.map((filter) => [channels, filter] as const),
);

describe('decodePng round trip', () => {
  it.each(CASES)('round-trips a %i-channel image through filter %i', (channels, filter) => {
    const source = makeRgba();
    const decoded = decodePng(encodePng(IMAGE_WIDTH, IMAGE_HEIGHT, source, { filter, channels }));
    const expected = Uint8Array.from(source);
    if (channels === 3) {
      for (let i = ALPHA_OFFSET; i < expected.length; i += RGBA_CHANNELS) {
        expected[i] = OPAQUE_ALPHA;
      }
    }
    expect(decoded.width).toBe(IMAGE_WIDTH);
    expect(decoded.height).toBe(IMAGE_HEIGHT);
    expect(Array.from(decoded.data)).toEqual(Array.from(expected));
  });
});
