import { spawn } from 'child_process';
import { readdirSync, readFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { decodePng } from './png-decoder.js';
import { validateTempDir } from './artifact-paths.js';

/**
 * Render check for the validate tool's checks[] array.
 *
 * A screenshot of a running project reports its path and dimensions, not its
 * content: a fully rendered frame and a completely blank one yield identical
 * successful responses. A scene can also load cleanly and pass every static
 * check while rendering nothing — a hidden CanvasLayer, a camera aimed at
 * empty space, a failed texture import, a shader falling back — failures that
 * are only observable in pixels. This check replaces that blind spot with a
 * mechanical verdict computed from actual pixel statistics.
 *
 * Execution model: `validate` runs headless, where render targets produce
 * nothing. So the render check runs server-side: it spawns a brief
 * `--write-movie` run with the real renderer (same display-server
 * requirement as `run_project`), decodes the captured frames in-process,
 * and computes the statistics. No GDScript-side participation.
 */

/**
 * Statistics computed over one frame's pixels:
 * - chromatic: fraction of pixels whose max-min channel spread exceeds 8
 *   (meaningfully saturated; catches sprites on dark backgrounds)
 * - dominant: share of the most common color (quantized to 4 bits/channel)
 * - distinct: number of distinct quantized colors
 */
export interface RenderStats {
  chromatic: number;
  dominant: number;
  distinct: number;
  width: number;
  height: number;
}

const CHROMATIC_SPREAD_THRESHOLD = 8;
const QUANT_SHIFT = 4; // 4 bits kept per channel -> 4096 buckets

/** Compute frame statistics from decoded RGBA pixels. Sampling caps the cost. */
export function computeRenderStats(png: {
  width: number;
  height: number;
  data: Uint8Array;
}): RenderStats {
  const { width, height, data } = png;
  const totalPixels = width * height;
  const sampleStep = Math.max(1, Math.floor(Math.sqrt(totalPixels / 4096)));

  let sampled = 0;
  let chromaticPixels = 0;
  const colorCounts = new Map<number, number>();

  for (let y = 0; y < height; y += sampleStep) {
    for (let x = 0; x < width; x += sampleStep) {
      const i = (y * width + x) * 4;
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      sampled++;
      const spread = Math.max(r, g, b) - Math.min(r, g, b);
      if (spread > CHROMATIC_SPREAD_THRESHOLD) chromaticPixels++;
      const key = ((r >> QUANT_SHIFT) << 8) | ((g >> QUANT_SHIFT) << 4) | (b >> QUANT_SHIFT);
      colorCounts.set(key, (colorCounts.get(key) ?? 0) + 1);
    }
  }

  let dominantCount = 0;
  for (const count of colorCounts.values()) {
    if (count > dominantCount) dominantCount = count;
  }

  return {
    chromatic: sampled > 0 ? chromaticPixels / sampled : 0,
    dominant: sampled > 0 ? dominantCount / sampled : 1,
    distinct: colorCounts.size,
    width,
    height,
  };
}

export interface RenderCheckOptions {
  /** Frames to capture before evaluating; default 15 at ~10 fps. */
  frames?: number;
  /** Override for chromatic pass threshold (default 0.01). */
  minChromatic?: number;
  /** Override for dominant-color fail threshold (default 0.98). */
  maxDominant?: number;
  /** Override for minimum distinct colors to pass (default 3). */
  minDistinct?: number;
}

export interface RenderCheckResult {
  ok: boolean;
  stats: RenderStats | null;
  message: string;
  framesEvaluated: number;
}

/** Default thresholds, empirically calibrated against rendered vs blank frames. */
export const DEFAULT_MIN_CHROMATIC = 0.01;
export const DEFAULT_MAX_DOMINANT = 0.98;
export const DEFAULT_MIN_DISTINCT = 3;

/**
 * Run the project briefly under the movie writer and evaluate the captured
 * frames. Evaluates the LAST frame (post-startup) — the first frames of a
 * run are legitimately blank while the scene loads. Throws on spawn or
 * decode failure; callers translate to a structured error entry.
 */
export async function runRenderCheck(
  godotPath: string,
  projectPath: string,
  scenePath: string | undefined,
  options: RenderCheckOptions = {},
): Promise<RenderCheckResult> {
  const frames = options.frames ?? 15;
  const minChromatic = options.minChromatic ?? DEFAULT_MIN_CHROMATIC;
  const maxDominant = options.maxDominant ?? DEFAULT_MAX_DOMINANT;
  const minDistinct = options.minDistinct ?? DEFAULT_MIN_DISTINCT;

  const outDir = join(validateTempDir(projectPath), `render_${randomUUID()}`);
  const prefix = join(outDir, 'frame.png');
  // The movie writer requires the output directory to exist; it does not
  // create parent directories itself (write_begin fails with a null DirAccess).
  mkdirSync(outDir, { recursive: true });

  const args = [
    `--write-movie`,
    prefix,
    '--fixed-fps',
    '10',
    '--quit-after',
    String(frames),
    '--path',
    projectPath,
  ];
  if (scenePath) {
    // Pass the scene directly so the check evaluates the target scene rather
    // than the project's configured main scene.
    args.push(scenePath);
  }

  // Scale timeout: 10s base + 2s per frame (startup + capture window).
  const timeoutMs = 10000 + frames * 2000;
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(godotPath, args, { stdio: 'pipe' });
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Render check run timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const err = new Error(
          `Render check run exited with code ${code}: ${stderr.slice(-500)}`,
        ) as Error & {
          stderr: string;
        };
        err.stderr = stderr;
        reject(err);
      } else {
        resolve();
      }
    });
  });

  // Movie writer emits frame00000.png, frame00001.png, ...
  let files: string[];
  try {
    // The movie writer splits the --write-movie path at its extension and
    // inserts the frame number: "frame.png" -> "frame00000000.png",
    // "frame00000001.png", ...
    files = readdirSync(outDir)
      .filter((f) => f.startsWith('frame') && f.endsWith('.png'))
      .sort();
  } catch {
    throw new Error('Render check produced no frames (movie writer wrote nothing)');
  }
  if (files.length === 0) {
    throw new Error('Render check produced no frames (movie writer wrote nothing)');
  }

  // Evaluate the last frame. If it fails thresholds, also try a middle frame
  // in case the tail is a transition/load artifact; report the best result.
  const candidates = [files[files.length - 1]!];
  if (files.length > 2) candidates.push(files[Math.floor(files.length / 2)]!);

  let best: { stats: RenderStats; valid: boolean } | null = null;
  let evaluated = 0;
  for (const file of candidates) {
    const png = decodePng(readFileSync(join(outDir, file)));
    const stats = computeRenderStats(png);
    evaluated++;
    const valid = stats.chromatic >= minChromatic && stats.dominant < maxDominant;
    if (valid) {
      best = { stats, valid };
      break;
    }
    if (!best) best = { stats, valid };
  }

  // Cleanup: frames are diagnostics; keeping them would accumulate megabytes
  // per check run under .mcp/, which screenshots already occupy.
  rmSync(outDir, { recursive: true, force: true });

  const result = best!;
  if (result.valid) {
    return {
      ok: true,
      stats: result.stats,
      message: `Frame renders with content (chromatic ${(result.stats.chromatic * 100).toFixed(2)}%, dominant ${(result.stats.dominant * 100).toFixed(2)}%, ${result.stats.distinct} distinct colors)`,
      framesEvaluated: evaluated,
    };
  }
  // OR-gate: pass if chromatic threshold OR distinct-color threshold is met,
  // even when dominant share is high (monochrome but textured scene).
  const altPass = result.stats.distinct >= minDistinct;
  if (altPass) {
    return {
      ok: true,
      stats: result.stats,
      message: `Frame has sufficient color variety (${result.stats.distinct} distinct colors) despite low chromatic content`,
      framesEvaluated: evaluated,
    };
  }
  return {
    ok: false,
    stats: result.stats,
    message: `Frame appears blank or uniform (chromatic ${(result.stats.chromatic * 100).toFixed(2)}% < ${(minChromatic * 100).toFixed(2)}%, dominant ${(result.stats.dominant * 100).toFixed(2)}% >= ${(maxDominant * 100).toFixed(2)}%, ${result.stats.distinct} distinct colors < ${minDistinct}) — expected rendered content but the viewport shows a near-uniform color`,
    framesEvaluated: evaluated,
  };
}
