import type { GodotRunner } from './godot-runner.js';
import type { HandlerResult, OperationParams } from '../mcp.types.js';
import { createErrorResponse, extractGdError, getErrorMessage } from './error-response.js';
import { createStructuredResponse } from './structured-response.js';
import {
  extractJson,
  normalizeForCompare,
  parseScriptDiagnostics,
  type StderrDiagnostic,
} from './output-parsing.js';
import { ok, err } from './result.js';

/**
 * Godot engine exit-noise line shapes: RID-leak warnings, the version
 * banner, and debug/info status lines that print on quit(1) before a
 * payload is ever emitted. Mirrors the prefixes `cleanOutput` filters
 * elsewhere in this codebase.
 */
const STDOUT_NOISE_LINE_PATTERN =
  /^(ERROR|WARNING|SCRIPT ERROR|USER SCRIPT ERROR):|^Godot Engine v|^\[DEBUG\]|^\[INFO\]/;

/** Max stderr diagnostic entries surfaced in an early-exit error message. */
const MAX_STDERR_DIAGNOSTIC_LINES = 5;

/** Trailing stdout lines surfaced when an early-exit stdout tail is shown. */
const STDOUT_TAIL_LINES = 10;

/** Trailing stderr lines surfaced when parseScriptDiagnostics finds nothing. */
const STDERR_TAIL_LINES = 5;

/**
 * Stderr marker godot_operations.gd prints when a scene-load probe finds a
 * dependency that exists on disk but was never imported. `executeSceneOp`
 * reacts by running the import step and retrying the operation once, capped
 * structurally at one retry (see `executeSceneOp`).
 */
export const IMPORT_NEEDED_MARKER = '[IMPORT_NEEDED]';

/**
 * Heuristic: does this non-JSON stdout look like the operation quit(1) before
 * emitting its payload? Canonical shape: a script compile error makes the
 * headless operation exit early, so stdout contains ONLY engine exit noise —
 * RID-leak warnings are the usual content. Bracket presence alone can't
 * classify this: exit noise routinely contains a stray `[` or `{` (e.g. a
 * `[Resource file res://x:4]` location suffix), and a genuinely JSON-shaped
 * but broken payload can look just as bracket-free or bracket-heavy either
 * way. Classify by line shape instead: early quit unless some line is
 * positive evidence of a payload attempt — a JSON opener on a line that
 * isn't recognized engine noise.
 *
 * The asymmetry is deliberate. A whitelist ("every line is known noise")
 * would send any unrecognized line — a stray `print()` before the script
 * died, a message shape a future Godot adds — back to the invalid-JSON
 * blame this function exists to prevent. Requiring evidence for the
 * emission-bug verdict instead means unknown output degrades to the
 * early-exit message, which carries the raw stdout tail and stays
 * self-correcting.
 */
function stdoutLooksLikeEarlyQuitNoise(stdout: string): boolean {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const looksLikePayloadAttempt = (line: string): boolean =>
    !STDOUT_NOISE_LINE_PATTERN.test(line) && (line.includes('{') || line.includes('['));
  return !lines.some(looksLikePayloadAttempt);
}

/**
 * Render one parsed stderr diagnostic, preserving the file+line location
 * `parseScriptDiagnostics` recovers — that location is the single most
 * useful part of the diagnosis, and dropping it (as a bare message-only
 * filter would) sends the caller hunting for the failing line by hand.
 */
function renderStderrDiagnostic(d: StderrDiagnostic): string {
  const location = d.filePath
    ? `${d.filePath}${d.line !== undefined ? `:${d.line}` : ''}: `
    : d.line !== undefined
      ? `line ${d.line}: `
      : '';
  return `${location}${d.message}`;
}

/**
 * Build the stderr portion of an early-exit error message. Prefers parsed
 * script/compile diagnostics for their file+line location; falls back to a
 * raw stderr tail when nothing parses — an unparseable stderr is still
 * better than dropping it entirely.
 */
function renderStderrForEarlyExit(stderr: string): string | undefined {
  const diagnostics = parseScriptDiagnostics(stderr);
  if (diagnostics.length > 0) {
    const rendered = diagnostics
      .slice(0, MAX_STDERR_DIAGNOSTIC_LINES)
      .map(renderStderrDiagnostic)
      .join('\n');
    return `stderr: ${rendered}`;
  }
  if (stderr.trim()) {
    const stderrTail = stderr.trim().split('\n').slice(-STDERR_TAIL_LINES).join('\n');
    return `stderr (last lines): ${stderrTail}`;
  }
  return undefined;
}

/**
 * Did this run already report work it applied?
 *
 * The cold-import retry re-runs the operation from the start, which is only
 * correct while the run wrote nothing. A multi-step operation
 * (`batch_scene_operations`) reports each step in a `results` array and saves
 * every scene it mutated before it returns, so a run that reports a successful
 * step AND asks for an import has already written: replaying it would apply
 * those steps a second time. `godot_operations.gd` stops printing the marker
 * once that happens, so this is the second line of defense rather than the
 * first, and it keys on the payload rather than the operation name so any
 * future multi-step operation inherits it.
 *
 * Unparseable stdout answers false: an operation that never emitted a payload
 * never reported applied work, and the retry is exactly what it needs.
 */
function reportsAppliedWork(stdout: string): boolean {
  const trimmed = stdout.trim();
  if (!trimmed) return false;
  try {
    const payload = JSON.parse(extractJson(trimmed)) as { results?: unknown };
    if (!Array.isArray(payload.results)) return false;
    return payload.results.some(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        (entry as { success?: unknown }).success === true,
    );
  } catch {
    return false;
  }
}

/**
 * Interprets a finished operation's {stdout, stderr} into a HandlerResult.
 * The single interpretation path used by `executeSceneOp` regardless of
 * whether an import retry ran first — the empty-stdout check and the
 * parseStdoutAsJson/plain-text branches are identical either way, only the
 * failurePrefix differs (an import retry that still failed gets a prefix
 * noting the import step ran, so the caller doesn't mistake this for the
 * marker never having been seen).
 */
function interpretOperationResult(
  stdout: string,
  stderr: string,
  failurePrefix: string,
  emptyStdoutSolutions: string[],
  options: { parseStdoutAsJson?: boolean },
): HandlerResult {
  if (!stdout.trim()) {
    return err(
      createErrorResponse(`${failurePrefix}: ${extractGdError(stderr)}`, emptyStdoutSolutions),
    );
  }
  if (options.parseStdoutAsJson) {
    // extractJson already strips leading/trailing engine noise around a
    // payload (GodotRunner.executeOperation normally routes stdout through
    // cleanStdout/extractJson before handlers ever see it — this call is
    // belt-and-braces for callers that bypass that, e.g. fake runners in
    // tests). No separate leading-noise stripper needed here.
    const jsonCandidate = extractJson(stdout.trim());
    try {
      const payload = JSON.parse(jsonCandidate) as Record<string, unknown>;
      return createStructuredResponse(payload);
    } catch (parseErr) {
      if (stdoutLooksLikeEarlyQuitNoise(stdout)) {
        // The operation exited before emitting its JSON payload (early
        // quit on error): stdout contains only engine exit noise. Surface
        // the offending output instead of blaming the operation script's
        // JSON emission. stderr carries the actual failure (compile
        // errors print to stderr in Godot's canonical format).
        const parts = [
          `${failurePrefix}: no JSON payload was emitted - the operation likely exited early on an error.`,
        ];
        const stderrPart = renderStderrForEarlyExit(stderr);
        if (stderrPart) parts.push(stderrPart);
        const stdoutTail = stdout.trim().split('\n').slice(-STDOUT_TAIL_LINES).join('\n');
        if (stdoutTail) parts.push(`stdout (last lines): ${stdoutTail}`);
        return err(
          createErrorResponse(parts.join('\n'), [
            'Check the surfaced stdout/stderr above - this is the operation failing before it could emit its JSON payload, not a JSON formatting bug',
            'Check get_debug_output for the raw output',
          ]),
        );
      }
      return err(
        createErrorResponse(
          `${failurePrefix}: GDScript returned invalid JSON (${getErrorMessage(parseErr)})`,
          [
            'This indicates a bug in godot_operations.gd - the operation should emit a JSON payload matching its outputSchema',
            'Check get_debug_output for the raw stdout and stderr',
          ],
        ),
      );
    }
  }
  return ok({ content: [{ type: 'text', text: stdout }] });
}

/**
 * Wraps the execute + empty-stdout-check + try/catch around a headless GDScript
 * operation. Used by the 15 scene/node mutation handlers in tools/scene-tools.ts
 * and tools/node-tools.ts to eliminate identical error-handling duplication.
 *
 * Handlers retain control of: parameter normalization, project/scene validation,
 * field validation, and constructing the `params` object — those run before the
 * call. Returns the canonical `Result<ToolSuccessPayload, ToolResponse>` shape;
 * the dispatch edge maps it back to the MCP wire envelope.
 *
 * Reacts to the `[IMPORT_NEEDED]` stderr marker (see `IMPORT_NEEDED_MARKER`)
 * by running `runner.importAssets` and retrying the operation exactly once,
 * capped structurally rather than by a loop — a marker on the retried run
 * falls through to normal error handling instead of importing again. A run
 * that already reported applied work is never retried at all (see
 * `reportsAppliedWork`): the replay would redo what it already saved.
 */
export async function executeSceneOp(
  runner: GodotRunner,
  operation: string,
  params: OperationParams,
  projectPath: string,
  failurePrefix: string,
  emptyStdoutSolutions: string[],
  exceptionSolutions: string[] = ['Ensure Godot is installed correctly'],
  options: { parseStdoutAsJson?: boolean; mutatesSceneFile?: boolean } = {},
): Promise<HandlerResult> {
  if (options.mutatesSceneFile) {
    const guard = rejectIfLiveSessionOnProject(runner, projectPath);
    if (guard) return guard;
  }
  try {
    let { stdout, stderr } = await runner.executeOperation(operation, params, projectPath);
    let effectiveFailurePrefix = failurePrefix;

    // Check for the cold-import marker (may appear even if stdout has a JSON
    // error). One retry, structurally: this branch runs at most once per
    // call, so a second marker on the retried run falls through to the
    // normal interpretation path below rather than importing again.
    if (stderr.includes(IMPORT_NEEDED_MARKER)) {
      if (reportsAppliedWork(stdout)) {
        return err(
          createErrorResponse(
            `${failurePrefix}: an asset still needed importing after part of this operation had already been applied and saved. Refusing the automatic import-and-retry, which would apply those steps a second time.\nreported by this run: ${stdout.trim()}`,
            [
              'The steps reported as successful above have been applied and saved - do not re-run them',
              'Import the project assets (any tool call on this project once the asset is imported will do), then re-run only the steps that failed',
            ],
          ),
        );
      }
      // importAssets writes .godot/ under the project. A running session on
      // this same project is a second writer racing it, same as the
      // mutatesSceneFile guard above — check it here too since this branch
      // is reachable by read-only handlers that never pass that option.
      const guard = rejectIfLiveSessionOnProject(runner, projectPath, [
        'This project also needs an asset import, which will run automatically once the session is stopped',
      ]);
      if (guard) return guard;
      try {
        await runner.importAssets(projectPath);
      } catch (importErr) {
        return err(
          createErrorResponse(
            `${failurePrefix}: asset import failed - ${getErrorMessage(importErr)}`,
            [
              'A broken asset anywhere in the project blocks the import, not just one related to this operation',
              'The file named in the import error is not necessarily the scene or asset this operation targeted',
              'Fix or remove the broken asset, then retry',
            ],
          ),
        );
      }
      ({ stdout, stderr } = await runner.executeOperation(operation, params, projectPath));
      effectiveFailurePrefix = `${failurePrefix} (after the asset import step ran)`;
    }

    return interpretOperationResult(
      stdout,
      stderr,
      effectiveFailurePrefix,
      emptyStdoutSolutions,
      options,
    );
  } catch (error: unknown) {
    return err(
      createErrorResponse(`${failurePrefix}: ${getErrorMessage(error)}`, exceptionSolutions),
    );
  }
}

// A running (spawned or attached) engine process can write its own project's
// scene files at any point during its lifetime -- not just in response to an
// MCP call. An autoload's _process loop calling ResourceSaver.save is enough;
// no run_script invocation is required. A headless mutation writes the same
// files from outside that process. Two writers on one file race regardless of
// which one triggers the write, so the guard covers the whole session rather
// than trying to serialize around individual calls.
function rejectIfLiveSessionOnProject(
  runner: GodotRunner,
  projectPath: string,
  extraSolutions: string[] = [],
): HandlerResult | null {
  if (runner.hasActiveRuntimeSession()) {
    const activeProject = runner.activeProjectPath;
    const isSameProject =
      activeProject !== null &&
      normalizeForCompare(activeProject).toLowerCase() ===
        normalizeForCompare(projectPath).toLowerCase();
    if (isSameProject) {
      return err(
        createErrorResponse(
          "A Godot runtime session is active on this project. The running process can write this project's scene files at any point while it lives, so a headless edit here would be a second writer racing it. Stop the session before editing scene files.",
          [
            'Call stop_project (or detach_project for attached sessions), then retry the scene edit',
            ...extraSolutions,
          ],
        ),
      );
    }
  }

  // Own-session check above covers this server. A sibling server process (or
  // a second BridgeManager instance in this one) can also be running the
  // game on this project, and this runner has no way to stop that session —
  // it isn't its own.
  const otherOwners = runner.otherLiveSessionsOnProject(projectPath);
  const other = otherOwners[0];
  if (other) {
    return err(
      createErrorResponse(
        `Another MCP session (server pid ${other.pid}, ${other.mode} mode) is running this ` +
          "project's game. That game belongs to the other session, not this one, and only it can " +
          "stop it. A running game can write this project's scene files at any time, so a " +
          'headless edit now would race it. Wait for the other session to finish (stop_project / ' +
          'detach_project there), then retry.',
        [
          'Wait and retry once the other MCP session has stopped or detached its game',
          "check_project on this project shows this session's own state, not the other session's",
          ...extraSolutions,
        ],
      ),
    );
  }

  return null;
}
