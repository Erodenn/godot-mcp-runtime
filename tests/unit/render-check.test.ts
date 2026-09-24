import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { deflateSync } from 'zlib';
import { join } from 'path';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { computeRenderStats, runRenderCheck } from '../../src/utils/render-check.js';

// Stub the Godot spawn to write planted frames into the --write-movie directory
// and exit cleanly. Tests call planFrames() to queue frames; the stub writes
// them to the correct directory before the process "exits".
const plantedFrames: Buffer[] = [];
vi.mock('child_process', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    spawn: vi.fn((cmd: string, args: string[]) => {
      const prefixIndex = args.indexOf('--write-movie');
      if (prefixIndex !== -1) {
        const prefix = args[prefixIndex + 1] as string;
        const dir = prefix.substring(0, prefix.lastIndexOf('/'));
        mkdirSync(dir, { recursive: true });
        for (const [i, frame] of plantedFrames.entries()) {
          writeFileSync(join(dir, `frame${String(i).padStart(5, '0')}.png`), frame);
        }
        plantedFrames.length = 0;
      }
      return {
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: (event: string, cb: (arg?: unknown) => void) => {
          if (event === 'close') setTimeout(() => cb(0), 1);
        },
        kill: () => {},
      };
    }),
  };
});

/** Queue frames that the stubbed Godot run will "write" to the movie dir. */
function planFrames(...frames: Buffer[]): void {
  plantedFrames.push(...frames);
}

/** Build a minimal valid PNG from raw RGBA pixel data (colorType 6). */
function buildPng(width: number, height: number, rgba: Uint8Array): Buffer {
  const channels = 4;
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const filterOffset = y * (stride + 1);
    raw[filterOffset] = 0; // filter: None
    for (let x = 0; x < stride; x++) {
      raw[filterOffset + 1 + x] = rgba[y * stride + x]!;
    }
  }
  return wrapChunks(width, height, 8, 6, deflateSync(raw));
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function crc32(buf: Buffer): number {
  let c: number = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return ~c >>> 0;
}

function wrapChunks(
  width: number,
  height: number,
  bitDepth: number,
  colorType: number,
  idat: Buffer,
  interlace = 0,
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[12] = interlace;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('computeRenderStats', () => {
  it('reports chromatic fraction and dominant share for a mixed frame', () => {
    // 2x2: red, green, blue, black
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 0, 255]);
    const stats = computeRenderStats({ width: 2, height: 2, data: rgba });
    expect(stats.chromatic).toBe(0.75); // 3 colorful pixels out of 4
    expect(stats.dominant).toBe(0.25); // no color repeats
    expect(stats.distinct).toBe(4);
  });

  it('flags a uniform dark frame as low-chromatic, high-dominant', () => {
    // 4x4 all black
    const rgba = new Uint8Array(64);
    const stats = computeRenderStats({ width: 4, height: 4, data: rgba });
    expect(stats.chromatic).toBe(0);
    expect(stats.dominant).toBe(1);
    expect(stats.distinct).toBe(1);
  });

  it('handles RGB-only input (fills alpha to 255)', () => {
    // 1x1 RGB red
    const rgba = new Uint8Array([255, 0, 0]);
    const stats = computeRenderStats({ width: 1, height: 1, data: rgba });
    expect(stats.chromatic).toBe(1);
    expect(stats.dominant).toBe(1);
  });
});

describe('runRenderCheck', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'render-check-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('passes when frames contain rendered content', async () => {
    const rgba = new Uint8Array([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
    ]);
    planFrames(buildPng(2, 2, rgba));

    const result = await runRenderCheck('/fake/godot', tempDir, undefined, {
      frames: 1,
      minChromatic: 0.01,
      maxDominant: 0.98,
    });
    expect(result.ok).toBe(true);
    expect(result.stats!.chromatic).toBeGreaterThan(0.01);
  });

  it('fails when frames are blank', async () => {
    const rgba = new Uint8Array(64); // all black
    planFrames(buildPng(4, 4, rgba));

    const result = await runRenderCheck('/fake/godot', tempDir, undefined, {
      frames: 1,
      minChromatic: 0.01,
      maxDominant: 0.98,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Frame appears blank/);
    expect(result.stats!.chromatic).toBe(0);
  });

  it('evaluates the last frame when multiple are present', async () => {
    // First two frames blank, last colorful
    for (let i = 0; i < 3; i++) {
      const rgba =
        i === 2
          ? new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255])
          : new Uint8Array(64);
      planFrames(buildPng(2, 2, rgba));
    }

    const result = await runRenderCheck('/fake/godot', tempDir, undefined, {
      frames: 3,
      minChromatic: 0.01,
      maxDominant: 0.98,
    });
    expect(result.ok).toBe(true);
  });

  it('throws when no frames are produced', async () => {
    await expect(runRenderCheck('/fake/godot', tempDir, undefined)).rejects.toThrow(
      /produced no frames/,
    );
  });
});
