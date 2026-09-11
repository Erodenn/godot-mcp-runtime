/**
 * Gate for tests that require a real Godot binary.
 *
 * CI does not have Godot installed. Locally, set `GODOT_PATH` to enable
 * these tests. Use `itGodot` exactly like `it`:
 *
 *     import { itGodot } from '../helpers/godot-skip.js';
 *     itGodot('runs a real headless Godot operation', async () => { ... });
 *
 * When `GODOT_PATH` is unset, the case is skipped (not failed).
 */

import { it } from 'vitest';

export const hasGodot = Boolean(process.env.GODOT_PATH);

export const itGodot = it.skipIf(!hasGodot);

/**
 * Heuristic: bridge failures we treat as "no display server" (skip-worthy)
 * rather than real failures. Anything else means runProject or the bridge is
 * genuinely broken and the test must fail loudly.
 *
 * This is the only condition an itGodot runtime test may skip on beyond the
 * `hasGodot` gate above. Do not add others.
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
