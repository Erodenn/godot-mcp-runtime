/** CI installs Godot in the `godot-integration` matrix job; locally set `GODOT_PATH`. When unset, `itGodot` cases are skipped, not failed. */

import { it } from 'vitest';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { parseMajorMinor, type MajorMinor } from '../../src/utils/engine-version.js';

export const hasGodot = Boolean(process.env.GODOT_PATH);

export const itGodot = it.skipIf(!hasGodot);

/** Call only where `hasGodot` is true; tests needing a newer engine than CI's oldest (typed dictionaries need 4.4) branch on it. */
export async function engineMajorMinor(): Promise<MajorMinor> {
  const runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
  const parsed = parseMajorMinor(await runner.getVersion());
  if (parsed === null) {
    throw new Error('Could not read the Godot version from "--version" output');
  }
  return parsed;
}

/** Used only by the render_movie test to word its failure; `runProjectOrSkip` decides its skip from `checkDisplayAvailable()` before launch, because a failure substring also matches real window-creation defects. */
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
