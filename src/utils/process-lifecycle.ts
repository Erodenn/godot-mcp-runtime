// Standalone because src/index.ts boots a server at import time; a test importing it would attach process.exit-capable handlers to the worker's stdin.

import { HEADLESS_SHUTDOWN_WAIT_MS, type GodotRunner } from './godot-runner.js';
import { logError } from './logger.js';

const GRACEFUL_EXIT_CODE = 0;

/** Stop every session, then give headless runs up to `headlessWaitMs`. Order matters: stopping sessions refuses new headless runs (the waited-on set only shrinks), and the wait precedes the exit whose hook kills what is left. */
export async function shutDownRunner(
  runner: GodotRunner,
  headlessWaitMs: number = HEADLESS_SHUTDOWN_WAIT_MS,
): Promise<void> {
  await runner.stopAllSessions();
  await runner.waitForHeadlessChildren(headlessWaitMs);
}

/** The slice of `process` registration touches, narrow so a test can inject a fake. */
export interface LifecycleProcess {
  on(event: string, listener: (...args: never[]) => void): unknown;
  stdin: { on(event: string, listener: (...args: never[]) => void): unknown };
}

/** Register every process-lifetime teardown path; the constructor's call with defaults is the production wiring. Listening for stdin 'end'/'close' does not start flowing mode, so StdioServerTransport keeps the stream. */
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
      // A failed cleanup must not strand the process: the sync 'exit' backstop would never run.
      logError(`Cleanup failed during shutdown: ${String(err)}`);
    }
    exit(GRACEFUL_EXIT_CODE);
  };
  const startShutdown = (): void => {
    void shutdown();
  };

  proc.on('SIGINT', startShutdown);
  proc.on('SIGTERM', startShutdown);
  // SIGHUP's default action ends Node without the 'exit' handler, and outside Windows the games and headless runs lead their own groups so the terminal's signal misses them.
  // On Windows the system ends the process a few seconds after the console closes, which the graceful path can outlast, so it exits at once.
  proc.on('SIGHUP', platform === 'win32' ? () => exit(GRACEFUL_EXIT_CODE) : startShutdown);
  proc.stdin.on('end', startShutdown);
  proc.stdin.on('close', startShutdown);

  proc.on('exit', () => {
    // Games first: one left running would outlive the server with its bridge removed. This finds what the graceful path missed (a headless run that outlasted the wait, or an exit that skipped it).
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
