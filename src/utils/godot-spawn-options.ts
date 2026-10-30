import type { SpawnOptions } from 'child_process';

/** Which Godot process a spawn starts: `headless` (version probe, operation, import), `run`, `run-background`, `movie` (render_movie) or `editor`. */
export type GodotSpawnKind = 'headless' | 'run' | 'run-background' | 'movie' | 'editor';

/** Spawn options for one kind, decided only here (rationale: docs/architecture.md, "Headless operation lifecycle"). Every kind keeps piped stdio, so callers must read or drain it. */
// windowsHide is a cheap measure against console painting, not a proven cure; killed kinds are `detached` so a signal to the group reaches a wrapper's engine.
export function godotSpawnOptions(kind: GodotSpawnKind): SpawnOptions {
  const leadsOwnGroup = process.platform !== 'win32';
  if (kind === 'headless' || kind === 'run-background') {
    return { stdio: 'pipe', detached: leadsOwnGroup, windowsHide: true };
  }
  // Stdin is ignored: nothing is written to a movie run.
  if (kind === 'movie') {
    return {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: leadsOwnGroup,
      windowsHide: true,
    };
  }
  if (kind === 'run') return { stdio: 'pipe', detached: leadsOwnGroup };
  return { stdio: 'pipe' };
}
