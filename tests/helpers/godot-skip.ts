/**
 * Gate for tests that require a real Godot binary.
 *
 * CI does install Godot, in the dedicated `godot-integration` matrix job
 * (see `.github/workflows/ci.yml`), which sets `GODOT_PATH` before running
 * the suite. Locally, set `GODOT_PATH` yourself to enable these tests. Use
 * `itGodot` exactly like `it`:
 *
 *     import { itGodot } from '../helpers/godot-skip.js';
 *     itGodot('runs a real headless Godot operation', async () => { ... });
 *
 * When `GODOT_PATH` is unset, the case is skipped (not failed).
 */

import { it } from 'vitest';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { parseMajorMinor, type MajorMinor } from '../../src/utils/engine-version.js';

export const hasGodot = Boolean(process.env.GODOT_PATH);

export const itGodot = it.skipIf(!hasGodot);

/**
 * The major.minor of the Godot binary at `GODOT_PATH`. Call it only from a
 * test body or hook that runs when `hasGodot` is true. Tests that need a newer
 * engine than CI's oldest one (typed dictionaries need 4.4) branch on it.
 */
export async function engineMajorMinor(): Promise<MajorMinor> {
  const runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
  const parsed = parseMajorMinor(await runner.getVersion());
  if (parsed === null) {
    throw new Error('Could not read the Godot version from "--version" output');
  }
  return parsed;
}

/**
 * Heuristic: engine output that names a missing display server. Used only by
 * the render_movie test, which already skips on `checkDisplayAvailable()` and
 * reads this to word its failure. `runProjectOrSkip` does not use it: it
 * decides its one skip from `checkDisplayAvailable()` before launching, since
 * a substring of a failure also matches real window-creation defects.
 */
export function isHeadlessEnvironmentError(err: string | undefined): boolean {
  if (!err) return false;
  const lower = err.toLowerCase();
  return (
    lower.includes('display') ||
    lower.includes('no x server') ||
    lower.includes('wayland') ||
    lower.includes('cannot open display')
  );
}
