/**
 * Process-lifetime teardown wiring for the MCP server entry point.
 *
 * Lives outside `src/index.ts` on purpose: that module instantiates and starts
 * the server at import time, so a test importing it would boot a real server
 * and, worse, attach these `process.exit`-capable handlers to the test
 * worker's own stdin. The wiring is a standalone module instead, and the
 * server constructor's single call to it is the production registration path.
 */

import { HEADLESS_SHUTDOWN_WAIT_MS, type GodotRunner } from './godot-runner.js';
import { logError } from './logger.js';

/** Exit code used for every graceful shutdown path below. */
const GRACEFUL_EXIT_CODE = 0;

/**
 * What a graceful shutdown does with the runner before the process exits:
 * stop every session, then give the headless runs still in flight up to
 * `headlessWaitMs` to finish by themselves. The order matters. Stopping the
 * sessions is what refuses new headless runs, so the wait is over a set that
 * can only shrink; and the wait comes before the exit, whose hook kills
 * whatever is left, so a run that needed a moment more is not killed while
 * it is writing.
 */
export async function shutDownRunner(
  runner: GodotRunner,
  headlessWaitMs: number = HEADLESS_SHUTDOWN_WAIT_MS,
): Promise<void> {
  await runner.stopAllSessions();
  await runner.waitForHeadlessChildren(headlessWaitMs);
}

/**
 * The slice of `process` `registerProcessLifecycle` touches. Narrow on purpose
 * so a test can inject a fake without reconstructing Node's process object.
 */
export interface LifecycleProcess {
  on(event: string, listener: (...args: never[]) => void): unknown;
  stdin: { on(event: string, listener: (...args: never[]) => void): unknown };
}

/**
 * Register every process-lifetime teardown path. Extracted from the
 * server constructor so a test can drive the real registration rather than a
 * re-implementation of it; the constructor's call, with both optional
 * arguments defaulted, IS the production wiring.
 *
 * - `SIGINT` / `SIGTERM` and stdin `'end'` / `'close'` all run the async
 *   `cleanup` (which stops every running project and then waits, bounded, for
 *   the headless runs in flight: `shutDownRunner`) exactly once — `'end'` and
 *   `'close'` both fire on a normal stdin close, and an MCP client going away
 *   is the case stdin EOF covers.
 * - `SIGHUP` is the terminal the server runs in going away. Its default
 *   action ends Node without running the `'exit'` handler, and the games and
 *   headless runs this server started lead their own process groups outside
 *   Windows, so the terminal's signal does not reach them: without a listener
 *   they would outlive the server, and a headless run could still write the
 *   scene it was editing. Outside Windows it gets the same graceful shutdown
 *   as `SIGTERM`. On Windows Node raises it when the console window is
 *   closed and the system ends the process unconditionally a few seconds
 *   later, which the graceful path (a bridge `shutdown` and a wait for each
 *   game's exit) can outlast. There it exits at once, so the synchronous
 *   `'exit'` handler below does its work inside that window.
 * - `'exit'` runs the synchronous bridge-artifact removal for every session,
 *   the only teardown that can still do useful work once the event loop is
 *   done.
 *
 * Listening for `'end'`/`'close'` does not put stdin in flowing mode (only
 * `'data'` or `resume()` would), so StdioServerTransport keeps ownership of
 * the byte stream.
 */
export function registerProcessLifecycle(opts: {
  runner: GodotRunner;
  cleanup: () => Promise<void>;
  proc?: LifecycleProcess;
  exit?: (code: number) => void;
  platform?: NodeJS.Platform;
}): void {
  const proc = opts.proc ?? (process as unknown as LifecycleProcess);
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const platform = opts.platform ?? process.platform;
  let shuttingDown = false;

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await opts.cleanup();
    } catch (err) {
      // A failed cleanup must not strand the process: without the exit below
      // the server keeps running after its client went away, and the sync
      // `'exit'` backstop never gets a chance to remove the artifacts.
      logError(`Cleanup failed during shutdown: ${String(err)}`);
    }
    exit(GRACEFUL_EXIT_CODE);
  };
  const startShutdown = (): void => {
    void shutdown();
  };

  proc.on('SIGINT', startShutdown);
  proc.on('SIGTERM', startShutdown);
  proc.on('SIGHUP', platform === 'win32' ? () => exit(GRACEFUL_EXIT_CODE) : startShutdown);
  proc.stdin.on('end', startShutdown);
  proc.stdin.on('close', startShutdown);

  proc.on('exit', () => {
    // Games first: one still running would otherwise outlive the server while
    // its bridge is removed from under it. A graceful shutdown has already
    // stopped every session and waited for the headless runs in flight, so
    // this only finds what that path missed: a headless run that outlasted
    // the wait, or every one of them on an exit that skipped the graceful
    // path. Left alone it would go on editing a project with nobody waiting
    // for the result.
    try {
      opts.runner.killSpawnedProcessesSync();
    } catch {
      // Exit handlers must not throw.
    }
    try {
      opts.runner.cleanupBridgeArtifactsSync();
    } catch {
      // Exit handlers must not throw.
    }
  });
}
