/** The runner exposes its session through read-only accessors, so tests install a record here; it comes from the runner's own `createSession`, so only the registration is hand-done. */

import type {
  GodotProcess,
  GodotRunner,
  RuntimeSession,
  RuntimeSessionMode,
} from '../../src/utils/godot-runner.js';

export const PLACEHOLDER_PROJECT_PATH = '/session-install/placeholder-project';

export interface InstallSessionOptions {
  projectPath?: string;
  mode?: RuntimeSessionMode | null;
  bridgePort?: number | null;
  token?: string | null;
  process?: GodotProcess | null;
  profiler?: unknown;
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

export function currentRecord(runner: GodotRunner): RuntimeSession {
  const session = (runner as unknown as RunnerSessionInternals).current;
  if (session === null) throw new Error('currentRecord: the runner has no current session');
  return session;
}
