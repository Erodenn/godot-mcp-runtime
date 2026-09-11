/**
 * Process-lifetime teardown wiring for the MCP server entry point.
 *
 * Lives outside `src/index.ts` on purpose: that module instantiates and starts
 * the server at import time, so a test importing it would boot a real server
 * and, worse, attach these `process.exit`-capable handlers to the test
 * worker's own stdin. The wiring is a standalone module instead, and the
 * server constructor's single call to it is the production registration path.
 */

import type { GodotRunner } from './godot-runner.js';

/** Exit code used for every graceful shutdown path below. */
const GRACEFUL_EXIT_CODE = 0;

/**
 * The slice of `process` `registerProcessLifecycle` touches. Narrow on purpose
 * so a test can inject a fake without reconstructing Node's process object.
 */
export interface LifecycleProcess {
  on(event: string, listener: (...args: never[]) => void): unknown;
  stdin: { on(event: string, listener: (...args: never[]) => void): unknown };
}

/**
 * Register every process-lifetime teardown path (D16). Extracted from the
 * server constructor so a test can drive the real registration rather than a
 * re-implementation of it; the constructor's call, with both optional
 * arguments defaulted, IS the production wiring.
 *
 * - `SIGINT` / `SIGTERM` and stdin `'end'` / `'close'` all run the async
 *   `cleanup` (which stops any running project) exactly once — `'end'` and
 *   `'close'` both fire on a normal stdin close, and an MCP client going away
 *   is the case stdin EOF covers.
 * - `'exit'` runs the synchronous bridge-artifact removal, the only teardown
 *   that can still do useful work once the event loop is done.
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
}): void {
  const proc = opts.proc ?? (process as unknown as LifecycleProcess);
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let shuttingDown = false;

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await opts.cleanup();
    exit(GRACEFUL_EXIT_CODE);
  };
  const startShutdown = (): void => {
    void shutdown();
  };

  proc.on('SIGINT', startShutdown);
  proc.on('SIGTERM', startShutdown);
  proc.stdin.on('end', startShutdown);
  proc.stdin.on('close', startShutdown);

  proc.on('exit', () => {
    try {
      opts.runner.cleanupBridgeArtifactsSync();
    } catch {
      // Exit handlers must not throw.
    }
  });
}
