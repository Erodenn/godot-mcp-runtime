import type { GodotRunner } from './godot-runner.js';
import type { HandlerResult, OperationParams } from '../mcp.types.js';
import { createErrorResponse, extractGdError, getErrorMessage } from './error-response.js';
import { createStructuredResponse, leadWithWarnings } from './structured-response.js';
import { BridgeRegistryUnreadableError, type BridgeOwnerInfo } from './bridge-manager.js';
import {
  extractOperationPayload,
  parseScriptDiagnostics,
  stripOperationSentinel,
  type StderrDiagnostic,
} from './output-parsing.js';
import { ok, err } from './result.js';
import { liveSessionRemedy } from './session-report.js';
import { beginSceneGuard, finishSceneGuard, type SceneWriteIntent } from './scene-loss-guard.js';

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
 * The marker as godot_operations.gd prints it: at the start of a stderr line,
 * through `log_error`, so behind an `[ERROR] ` prefix. Matching the text
 * anywhere in stderr would also match a line that merely quotes it, and those
 * exist: with DEBUG=true the script echoes its params to stderr, so a Label
 * text or node name holding the marker text would ask for a replay of an
 * operation that asked for none.
 */
const IMPORT_NEEDED_LINE = /^(?:\[ERROR\] )?\[IMPORT_NEEDED\] /m;

/** True when a line of this stderr is the script's own request for an asset import. */
export function stderrRequestsImport(stderr: string): boolean {
  return IMPORT_NEEDED_LINE.test(stderr);
}

/** Prefix of the lines godot_operations.gd prints through `log_error`. */
const SCRIPT_ERROR_PREFIX = '[ERROR] ';

/**
 * The reasons godot_operations.gd gave for a failure, in the order it printed
 * them. An operation that fails says why on one of these lines and quits, so
 * they are the first thing an early-exit message owes the caller: engine
 * diagnostics printed around them (a leak warning at exit, an unrelated
 * `ERROR:` line) describe the process, not the failure.
 */
function scriptErrorLines(stderr: string): string[] {
  return stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(SCRIPT_ERROR_PREFIX))
    .map((line) => line.slice(SCRIPT_ERROR_PREFIX.length).trim())
    .filter((line) => line !== '');
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
 * What a run that asked for an import had already done.
 *
 * - `nothing`: no payload, or one that reports no applied step. The retry is
 *   exactly what the operation needs.
 * - `applied-steps`: a multi-step payload with a successful step.
 * - `completed`: a single-step payload, which an operation emits only after
 *   its work is done and saved.
 */
type MarkedRunState = 'nothing' | 'applied-steps' | 'completed';

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
 * A single-step operation (`add_node`, `duplicate_node`, `attach_script`)
 * emits its payload after it has saved, and never together with the marker. A
 * payload of that kind beside a marker line means the line came from somewhere
 * else (a script in the project printing it), and the operation is finished:
 * replaying it would add the node a second time under a success response.
 *
 * Stdout without a payload line answers `nothing`: an operation that never
 * emitted a payload never reported applied work. So does a payload that
 * carries a top-level `error` string, which describes work that did not happen.
 */
function classifyMarkedRun(stdout: string): MarkedRunState {
  const candidate = extractOperationPayload(stdout);
  if (!candidate) return 'nothing';
  try {
    const payload: unknown = JSON.parse(candidate);
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return 'nothing';
    }
    const { results, error } = payload as { results?: unknown; error?: unknown };
    if (!Array.isArray(results)) return typeof error === 'string' ? 'nothing' : 'completed';
    const anyApplied = results.some(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        (entry as { success?: unknown }).success === true,
    );
    return anyApplied ? 'applied-steps' : 'nothing';
  } catch {
    return 'nothing';
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
    // The script's own [ERROR] line when there is one. Without one the script
    // itself was stopped (a runtime error inside godot_operations.gd prints
    // SCRIPT ERROR lines and no [ERROR] line), and the engine's diagnostics are
    // the only account of why, so they are shown instead of being dropped.
    const reasons = scriptErrorLines(stderr);
    const stderrPart = reasons.length === 0 ? renderStderrForEarlyExit(stderr) : undefined;
    const message = `${failurePrefix}: ${extractGdError(stderr)}`;
    return err(
      createErrorResponse(
        stderrPart === undefined ? message : `${message}\n${stderrPart}`,
        emptyStdoutSolutions,
      ),
    );
  }
  const payload = extractOperationPayload(stdout);
  if (options.parseStdoutAsJson) {
    if (payload === null) {
      // No line carried the result sentinel: the operation exited before it
      // could emit a payload (early quit on error), and everything on stdout
      // is engine or user noise. Nothing here is ever parsed as a payload.
      // stderr carries the actual failure (compile errors print to stderr in
      // Godot's canonical format).
      const parts = [
        `${failurePrefix}: no JSON payload was emitted - the operation likely exited early on an error.`,
      ];
      // The operation's own reason leads. It is on stderr behind the engine's
      // diagnostics, and renderStderrForEarlyExit shows those when it finds any,
      // so without this line the one sentence that explains the failure is the
      // one left out.
      const reasons = scriptErrorLines(stderr);
      if (reasons.length > 0) parts.push(`reason: ${reasons.join('\n')}`);
      const stderrPart = renderStderrForEarlyExit(stderr);
      if (stderrPart) parts.push(stderrPart);
      const stdoutTail = stripOperationSentinel(stdout.trim())
        .split('\n')
        .slice(-STDOUT_TAIL_LINES)
        .join('\n');
      if (stdoutTail) parts.push(`stdout (last lines): ${stdoutTail}`);
      return err(
        createErrorResponse(parts.join('\n'), [
          'Check the surfaced stdout/stderr above - this is the operation failing before it could emit its JSON payload, not a JSON formatting bug',
          'A headless operation keeps no log: get_debug_output reads a runtime session, not this run',
        ]),
      );
    }
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      // A payload that carries a top-level error string is a failure the script
      // reported by the wrong channel: the work it describes did not happen.
      // Every operation fails by printing to stderr and quitting without a
      // payload, so this is the backstop for one that does not.
      if (typeof parsed?.error === 'string') {
        const message = `${failurePrefix}: ${parsed.error}`;
        return err(createErrorResponse(message, emptyStdoutSolutions));
      }
      return createStructuredResponse(leadWithWarnings(parsed));
    } catch (parseErr) {
      return err(
        createErrorResponse(
          `${failurePrefix}: GDScript returned invalid JSON (${getErrorMessage(parseErr)})`,
          [
            'This indicates a bug in godot_operations.gd - the operation should emit a JSON payload matching its outputSchema',
            'A headless operation keeps no log: get_debug_output reads a runtime session, not this run',
          ],
        ),
      );
    }
  }
  return ok({ content: [{ type: 'text', text: payload ?? stripOperationSentinel(stdout) }] });
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
 * `classifyMarkedRun`): the replay would redo what it already saved. A marker
 * counts only as a line the script itself printed (see `stderrRequestsImport`).
 */
export interface SceneOpOptions {
  parseStdoutAsJson?: boolean;
  mutatesSceneFile?: boolean;
  /**
   * The scene files this operation writes and what it asks to change in each.
   * When given, the files are compared before and after (see
   * `scene-loss-guard.ts`) and content lost outside that intent leads the
   * payload as warnings.
   */
  sceneWrites?: SceneWriteIntent[];
}

/**
 * Put `warnings` ahead of whatever the result already carries. A success keeps
 * its payload and gains (or extends) a leading `warnings` array. A failure
 * gains one more text block: the operation failed, but a file it wrote before
 * failing is still on disk, and what that file lost is still worth saying.
 */
function prependWarnings(result: HandlerResult, warnings: string[]): HandlerResult {
  if (warnings.length === 0) return result;
  if (!result.ok) {
    result.error.content.push({ type: 'text', text: warnings.join('\n') });
    return result;
  }
  const payload = result.value.structuredContent;
  if (payload === undefined) {
    // A plain-text result has no payload to lead; the warnings still go out.
    result.value.content.unshift({ type: 'text', text: warnings.join('\n') });
    return result;
  }
  const existing = Array.isArray(payload.warnings) ? (payload.warnings as unknown[]) : [];
  return createStructuredResponse(
    leadWithWarnings({ ...payload, warnings: [...warnings, ...existing] }),
  );
}

export async function executeSceneOp(
  runner: GodotRunner,
  operation: string,
  params: OperationParams,
  projectPath: string,
  failurePrefix: string,
  emptyStdoutSolutions: string[],
  exceptionSolutions: string[] = ['Ensure Godot is installed correctly'],
  options: SceneOpOptions = {},
): Promise<HandlerResult> {
  if (options.mutatesSceneFile) {
    const guard = rejectIfLiveSessionOnProject(runner, projectPath);
    if (guard) return guard;
  }
  // Read before the first attempt and compared once after the last, so a
  // cold-import retry is measured against the file as the caller left it, not
  // against whatever the first attempt wrote.
  const sceneGuard =
    options.sceneWrites && options.sceneWrites.length > 0
      ? beginSceneGuard(projectPath, options.sceneWrites)
      : null;
  const stderrSeen: string[] = [];
  const result = await runSceneOp(
    runner,
    operation,
    params,
    projectPath,
    failurePrefix,
    emptyStdoutSolutions,
    exceptionSolutions,
    options,
    stderrSeen,
  );
  // Every exit of the run comes through here, the refusals and the thrown
  // spawn error included: a run that failed late may already have saved.
  const lossWarnings =
    sceneGuard === null ? [] : finishSceneGuard(sceneGuard, stderrSeen.join('\n'));
  return prependWarnings(result, lossWarnings);
}

/** The run itself: one attempt, plus the cold-import retry. `stderrSeen` collects each attempt's stderr. */
async function runSceneOp(
  runner: GodotRunner,
  operation: string,
  params: OperationParams,
  projectPath: string,
  failurePrefix: string,
  emptyStdoutSolutions: string[],
  exceptionSolutions: string[],
  options: SceneOpOptions,
  stderrSeen: string[],
): Promise<HandlerResult> {
  try {
    let { stdout, stderr } = await runner.executeOperation(operation, params, projectPath);
    stderrSeen.push(stderr);
    let effectiveFailurePrefix = failurePrefix;

    // Check for the cold-import marker (may appear even if stdout has a JSON
    // error). One retry, structurally: this branch runs at most once per
    // call, so a second marker on the retried run falls through to the
    // normal interpretation path below rather than importing again.
    // A run that emitted a single-step result is finished and asked for
    // nothing: its payload is interpreted as it stands (see classifyMarkedRun).
    const markedRun = stderrRequestsImport(stderr) ? classifyMarkedRun(stdout) : null;
    if (markedRun !== null && markedRun !== 'completed') {
      if (markedRun === 'applied-steps') {
        return err(
          createErrorResponse(
            `${failurePrefix}: an asset still needed importing after part of this operation had already been applied and saved. Refusing the automatic import-and-retry, which would apply those steps a second time.\nreported by this run: ${stripOperationSentinel(stdout.trim())}`,
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
      stderrSeen.push(stderr);
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

/** Who is running a game on a project, as seen from this server. */
export type LiveSessionOnProject = { owner: 'self' } | { owner: 'other'; info: BridgeOwnerInfo };

/**
 * The one live-session detector. Own sessions first (this runner has a live
 * session on this project, whether or not it is the current one), then any
 * other MCP session registered as an owner of the project. Null when nothing
 * is running it.
 */
export function findLiveSessionOnProject(
  runner: GodotRunner,
  projectPath: string,
): LiveSessionOnProject | null {
  if (runner.hasLiveSessionOnProject(projectPath)) return { owner: 'self' };

  // Own-session check above covers this server. A sibling server process (or
  // a second BridgeManager instance in this one) can also be running the
  // game on this project, and this runner has no way to stop that session —
  // it isn't its own.
  const other = runner.otherLiveSessionsOnProject(projectPath)[0];
  if (other) return { owner: 'other', info: other };

  return null;
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
  let live: LiveSessionOnProject | null;
  try {
    live = findLiveSessionOnProject(runner, projectPath);
  } catch (error: unknown) {
    // An owner registry that cannot be read is "unknown", and the guard exists
    // for exactly the case it cannot rule out. Refuse, and say why.
    if (!(error instanceof BridgeRegistryUnreadableError)) throw error;
    return err(
      createErrorResponse(
        `Could not read this project's bridge owner registry (${error.reason}), so it is unknown whether another MCP session is running its game. Refusing the scene edit.`,
        [
          'Retry: a registry file that another session was writing at that moment is readable again a moment later',
          'If it keeps failing, check the permissions on .mcp/godot-runtime/bridge/owners/ in the project',
          ...extraSolutions,
        ],
      ),
    );
  }
  if (live === null) return null;

  if (live.owner === 'self') {
    const remedy = liveSessionRemedy(runner, projectPath, 'the scene edit');
    return err(
      createErrorResponse(
        `A Godot runtime session is active on this project.${remedy.note} The running process can write this project's scene files at any point while it lives, so a headless edit here would be a second writer racing it. Stop the session before editing scene files.`,
        [...remedy.solutions, ...extraSolutions],
      ),
    );
  }

  const other = live.info;
  return err(
    createErrorResponse(
      `Another MCP session (server pid ${other.pid}, ${other.mode} mode) is running this ` +
        "project's game. That game belongs to the other session, not this one, and only it can " +
        "stop it. A running game can write this project's scene files at any time, so a " +
        'headless edit now would race it. Wait for the other session to finish (stop_project ' +
        'there), then retry.',
      [
        'Wait and retry once the other MCP session has stopped or detached its game',
        "check_project on this project shows this session's own state, not the other session's",
        ...extraSolutions,
      ],
    ),
  );
}
