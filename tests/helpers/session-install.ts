/**
 * Put a runtime session record on a real GodotRunner without spawning Godot.
 *
 * The runner exposes its current session through read-only accessors
 * (`activeSessionMode`, `activeProcess`, ...), so a test that needs a session
 * in a given state installs a record here instead of assigning those names.
 * The record is built by the runner's own `createSession`, so its key and
 * shape are the production ones; only the registration is done by hand.
 */

import type {
  GodotProcess,
  GodotRunner,
  RuntimeSession,
  RuntimeSessionMode,
} from '../../src/utils/godot-runner.js';

/** Project path for tests that need a record but never touch the disk. */
export const PLACEHOLDER_PROJECT_PATH = '/session-install/placeholder-project';

export interface InstallSessionOptions {
  /** Default: {@link PLACEHOLDER_PROJECT_PATH}. */
  projectPath?: string;
  /** Default: null, the state of a session whose process exited by itself. */
  mode?: RuntimeSessionMode | null;
  bridgePort?: number | null;
  token?: string | null;
  process?: GodotProcess | null;
  /** A stand-in is enough: the runner only reads `hasResult` and calls `close()`. */
  profiler?: unknown;
  /** Make the record the current session. Default: true. */
  current?: boolean;
}

interface RunnerSessionInternals {
  sessions: Map<string, RuntimeSession>;
  current: RuntimeSession | null;
  createSession(projectPath: string, mode: RuntimeSessionMode | null): RuntimeSession;
}

export function installSession(
  runner: GodotRunner,
  opts: InstallSessionOptions = {},
): RuntimeSession {
  const internals = runner as unknown as RunnerSessionInternals;
  const session = internals.createSession(
    opts.projectPath ?? PLACEHOLDER_PROJECT_PATH,
    opts.mode ?? null,
  );
  session.bridgePort = opts.bridgePort ?? null;
  session.token = opts.token ?? null;
  session.process = opts.process ?? null;
  session.profiler = (opts.profiler ?? null) as RuntimeSession['profiler'];
  internals.sessions.set(session.key, session);
  if (opts.current ?? true) internals.current = session;
  return session;
}

/** The runner's current session record. Throws when there is none. */
export function currentRecord(runner: GodotRunner): RuntimeSession {
  const session = (runner as unknown as RunnerSessionInternals).current;
  if (session === null) throw new Error('currentRecord: the runner has no current session');
  return session;
}
