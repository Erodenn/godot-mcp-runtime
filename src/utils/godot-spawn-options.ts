import type { SpawnOptions } from 'child_process';

/**
 * Which kind of Godot process a spawn starts:
 * - `headless`: a short-lived `--headless` run (version probe, headless
 *   operation, asset import). It has no window.
 * - `run`: the game for `run_project`. Its window is the point.
 * - `editor`: the editor GUI for `launch_editor`.
 */
export type GodotSpawnKind = 'headless' | 'run' | 'editor';

/**
 * Spawn options for one kind of Godot process. The single place they are
 * decided, so the reasoning below is written once.
 *
 * On Windows the standard Godot executable is a GUI-subsystem binary that
 * attaches to its parent's console at startup. When this server runs under a
 * terminal client, that console is the client's own, and whatever Godot (or a
 * driver or child process of it) writes to the console directly is painted
 * over the client's interface. The pipes below do not prevent it: the console
 * attachment is separate from the three standard handles.
 *
 * `windowsHide: true` makes Node create the process with `CREATE_NO_WINDOW`
 * and a hidden show-window state. If Windows gives the child its own invisible
 * console under that flag, the child never attaches to ours. Whether it does
 * for a GUI-subsystem binary is not settled by the documentation, so this is
 * the cheap measure, not a proven cure. A headless run has no window to lose,
 * so it gets the flag. The game and the editor must not: a hidden show-window
 * state could hide the window the user asked for, so `run` and `editor` never
 * carry the key at all. The option is ignored outside Windows.
 *
 * Every kind keeps piped stdio. A Godot whose standard handles are not pipes
 * writes its ordinary output to the parent console instead, which is the same
 * symptom by a shorter route. Pipes that are opened have to be read, so each
 * caller either consumes them or drains them.
 *
 * None of this can be asserted by a test: no test can observe a terminal being
 * painted over. The tests cover the options returned here and nothing else.
 */
export function godotSpawnOptions(kind: GodotSpawnKind): SpawnOptions {
  if (kind === 'headless') return { stdio: 'pipe', windowsHide: true };
  return { stdio: 'pipe' };
}
