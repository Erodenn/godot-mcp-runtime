import type { SpawnOptions } from 'child_process';

/**
 * Which kind of Godot process a spawn starts:
 * - `headless`: a short-lived `--headless` run (version probe, headless
 *   operation, asset import). It has no window.
 * - `run`: the game for `run_project`. Its window is the point.
 * - `run-background`: the game for `run_project` with `background: true`.
 * - `movie`: the bounded movie-writer run for `render_movie`. It renders in a
 *   real window nobody needs to see, and it is killed as a process tree.
 * - `editor`: the editor GUI for `launch_editor`.
 */
export type GodotSpawnKind = 'headless' | 'run' | 'run-background' | 'movie' | 'editor';

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
 * so it gets the flag. `run` and `editor` never hide, because their windows
 * must show, so they never carry the key at all. `movie` and `run-background` hide
 * because the caller asked for a game nobody looks at; the window is never
 * shown, while rendering, screenshots and injected input still work. A
 * no-focus flag at window creation cannot be combined with the hidden
 * show-state (such a window is shown anyway), which is why the focus flags
 * stay in the bridge. The option is ignored outside Windows, where the bridge
 * moves the window off-screen instead.
 *
 * Every kind keeps piped stdio. A Godot whose standard handles are not pipes
 * writes its ordinary output to the parent console instead, which is the same
 * symptom by a shorter route. Pipes that are opened have to be read, so each
 * caller either consumes them or drains them.
 *
 * Every kind this server later kills leads its own process group outside
 * Windows (`detached`). The executable may be a wrapper script whose child is
 * the real engine, and a signal sent to the group reaches both, where a signal
 * sent to the one pid leaves the engine running (see `killProcessTree`). That
 * holds for `headless` as much as for the games: its timeout is the only
 * bound on a headless run, and a timeout that kills a wrapper and leaves the
 * engine running has bounded nothing.
 *
 * A group leader is not signalled along with the server by the terminal
 * (Ctrl+C, or SIGHUP when the terminal closes), so the caller of each such
 * kind keeps the child in a set its exit hook kills, and the server handles
 * SIGINT, SIGTERM and SIGHUP so that hook runs (`process-lifecycle.ts`). A
 * server ended by SIGKILL runs no hook and nothing reaps these children. A
 * spawned game notices through its parent watch and quits. A headless run
 * does not: it runs on to its own end with no timeout left to cut it short,
 * as a wrapper's engine child already did before headless runs led a group.
 * Windows kills by tree with `taskkill /T` and needs no group. The editor is
 * never killed by the server and stays in the server's group.
 *
 * None of this can be asserted by a test: no test can observe a terminal being
 * painted over. The tests cover the options returned here and nothing else.
 */
export function godotSpawnOptions(kind: GodotSpawnKind): SpawnOptions {
  const leadsOwnGroup = process.platform !== 'win32';
  if (kind === 'headless' || kind === 'run-background') {
    return { stdio: 'pipe', detached: leadsOwnGroup, windowsHide: true };
  }
  // Stdin is ignored: nothing is ever written to a movie run.
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
