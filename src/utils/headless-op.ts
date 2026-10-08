import {
  CLIENT_REQUEST_TIMEOUT_MS,
  HEADLESS_OPERATION_TIMEOUT_MS,
  type GodotRunner,
} from './godot-runner.js';
import type { HandlerResult, OperationParams } from '../mcp.types.js';
import {
  createErrorResponse,
  extractGdError,
  getErrorMessage,
  NO_SCRIPT_ERROR_LINE_MESSAGE,
  stderrTailLines,
} from './error-response.js';
import { createStructuredResponse, leadWithWarnings } from './structured-response.js';
import {
  BridgeRegistryUnreadableError,
  foreignHostOwnerRemedy,
  type BridgeOwnerInfo,
  type OwnerRegistryRead,
} from './bridge-manager.js';
import {
  extractOperationPayload,
  parseScriptDiagnostics,
  projectPathKey,
  stripOperationSentinel,
  type StderrDiagnostic,
} from './output-parsing.js';
import { ok, err } from './result.js';
import { liveSessionRemedy } from './session-report.js';
import { engineNewerThanProject, readProjectFeatureVersion } from './engine-version.js';
import {
  beginSceneGuard,
  finishSceneGuard,
  resolveIntentPaths,
  restateSceneGuard,
  type SceneWriteIntent,
  type UncheckedSave,
} from './scene-loss-guard.js';

/** Max stderr diagnostic entries surfaced in an early-exit error message. */
const MAX_STDERR_DIAGNOSTIC_LINES = 5;

/** Trailing stdout lines surfaced when an early-exit stdout tail is shown. */
const STDOUT_TAIL_LINES = 10;

/**
 * How much of the client's request timeout a headless call keeps back for
 * delivering its answer. The rest is the call's budget, counted from its
 * start.
 */
export const HEADLESS_RESPONSE_MARGIN_MS = 5000;
/**
 * The least a cold-import retry is run with. The wait for the import ends
 * this long before the call's budget does, so an import that finishes in
 * time always leaves the retry a usable timeout.
 */
export const IMPORT_RETRY_RESERVE_MS = 10000;

/**
 * The `[IMPORT_NEEDED]` marker godot_operations.gd prints when a scene-load
 * probe finds a dependency that exists on disk but was never imported, as the
 * script prints it: at the start of a stderr line, through `log_error`, so
 * behind an `[ERROR] ` prefix. Matching the text anywhere in stderr would also
 * match a line that merely quotes it, and those exist: with DEBUG=true the
 * script echoes its params to stderr, so a Label text or node name holding the
 * marker text would ask for a replay of an operation that asked for none.
 * KEEP IN SYNC with `_report_import_needed` in src/scripts/godot_operations.gd.
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
  const diagnostics = renderParsedDiagnostics(stderr);
  if (diagnostics !== undefined) return diagnostics;
  const tail = stderrTailLines(stderr);
  return tail.length > 0 ? `stderr (last lines): ${tail.join('\n')}` : undefined;
}

/** The parsed script and compile diagnostics of a stderr, or undefined when it holds none. */
function renderParsedDiagnostics(stderr: string): string | undefined {
  const diagnostics = parseScriptDiagnostics(stderr);
  if (diagnostics.length === 0) return undefined;
  const rendered = diagnostics
    .slice(0, MAX_STDERR_DIAGNOSTIC_LINES)
    .map(renderStderrDiagnostic)
    .join('\n');
  return `stderr: ${rendered}`;
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
    // With no [ERROR] line anywhere, parsed diagnostics lead for their file
    // and line; failing those, extractGdError carries the end of stderr itself
    // (or says it was empty), so the message is never the bare "no reason".
    const reasons = scriptErrorLines(stderr);
    if (!stderr.includes('[ERROR]')) {
      const diagnostics = renderParsedDiagnostics(stderr);
      const message =
        diagnostics === undefined
          ? `${failurePrefix}: ${extractGdError(stderr)}`
          : `${failurePrefix}: ${NO_SCRIPT_ERROR_LINE_MESSAGE}\n${diagnostics}`;
      return err(createErrorResponse(message, emptyStdoutSolutions));
    }
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

export interface SceneOpOptions {
  parseStdoutAsJson?: boolean;
  /**
   * True for an operation that writes into the project. It is refused while a
   * game is running on the project (see `rejectIfLiveSessionOnProject`).
   */
  mutatesSceneFile?: boolean;
  /**
   * The scene files this operation writes and what it asks to change in each.
   * When given, the files are compared before and after (see
   * `scene-loss-guard.ts`) and content lost outside that intent leads the
   * payload as warnings. The engine-newer-than-project note is given for
   * these files too, and only when one of them was written.
   */
  sceneWrites?: SceneWriteIntent[];
  /**
   * `sceneWrites` restated from the operation's own payload, for an operation
   * whose report says more than its request (a batch knows which of its
   * save-as steps succeeded). Called only for a success payload. Without it
   * the payload still restates the node paths of `sceneWrites`: see
   * `resolveIntentPaths`.
   */
  refineSceneWrites?: (payload: Record<string, unknown>) => SceneWriteIntent[];
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

/**
 * The projects each runner has already given the engine-newer note for, by
 * `projectPathKey`. One runner is one server session, so the note is given
 * once per project per session: it describes the project, not the call, and
 * repeating it on every save buries the warnings that are about the call.
 */
const engineNewerNoted = new WeakMap<GodotRunner, Set<string>>();

/**
 * The scene files each runner has already said were saved unchecked, by the
 * file's identity key. One runner is one server session. A scene that cannot
 * be compared (a binary `.scn`) cannot be compared on any save, so the notice
 * is given once per file per session, the same way as the engine-newer note:
 * said on every mutation it would lead every payload of a binary-scene project
 * and bury the warnings that are about the call.
 */
const uncheckedSaveNoted = new WeakMap<GodotRunner, Set<string>>();

/** The unchecked-save notices this session has not given yet, each marked as said once. */
function newUncheckedSaveWarnings(runner: GodotRunner, unchecked: UncheckedSave[]): string[] {
  if (unchecked.length === 0) return [];
  const noted = uncheckedSaveNoted.get(runner) ?? new Set<string>();
  uncheckedSaveNoted.set(runner, noted);
  const warnings: string[] = [];
  for (const { fileKey, warning } of unchecked) {
    if (noted.has(fileKey)) continue;
    noted.add(fileKey);
    warnings.push(`${warning} Said once per file in this server session.`);
  }
  return warnings;
}

/**
 * The warning for a project last saved by an older engine than the one that
 * just wrote one of its scenes, or null when the versions are in order, either
 * is unknown, or this session has already said so for this project. The
 * project's version is read first: a project that states none costs no engine
 * probe. `check_project` reports the same condition on every call.
 */
async function engineNewerWarning(
  runner: GodotRunner,
  projectPath: string,
): Promise<string | null> {
  try {
    const key = projectPathKey(projectPath);
    const noted = engineNewerNoted.get(runner) ?? new Set<string>();
    if (noted.has(key)) return null;
    if (readProjectFeatureVersion(projectPath) === null) return null;
    const newer = engineNewerThanProject(await runner.getVersion(), projectPath);
    if (newer === null) return null;
    noted.add(key);
    engineNewerNoted.set(runner, noted);
    const { engine, project } = newer;
    return `Godot ${engine.major}.${engine.minor} is newer than this project's config/features version ${project.major}.${project.minor}: this save may write scene-file format the project's engine predates (4.6 adds unique_id to every node, for example). Said once per project in this server session; check_project reports it on every call.`;
  } catch {
    // A version that cannot be read is not a reason to fail a finished save.
    return null;
  }
}

/**
 * Wraps the execute + empty-stdout-check + try/catch around a headless GDScript
 * operation. Used by the 15 headless handlers in tools/scene-tools.ts and
 * tools/node-tools.ts (12 that write, and the 3 reads get_scene_tree,
 * get_node_properties and get_node_signals) to eliminate identical
 * error-handling duplication.
 *
 * Handlers retain control of: parameter normalization, project/scene validation,
 * field validation, and constructing the `params` object — those run before the
 * call. Returns the canonical `Result<ToolSuccessPayload, ToolResponse>` shape;
 * the dispatch edge maps it back to the MCP wire envelope.
 *
 * Reacts to the `[IMPORT_NEEDED]` stderr marker (see `stderrRequestsImport`)
 * by running `runner.importAssets` and retrying the operation exactly once,
 * capped structurally rather than by a loop — a marker on the retried run
 * falls through to normal error handling instead of importing again. A run
 * that already reported applied work is never retried at all (see
 * `classifyMarkedRun`): the replay would redo what it already saved. A marker
 * counts only as a line the script itself printed (see `stderrRequestsImport`).
 *
 * Three kinds of warning are put ahead of the payload after the run, in this
 * order: what the save dropped that the operation did not ask to change (when
 * `sceneWrites` is given, see `scene-loss-guard.ts`), that a save could not be
 * checked at all, then the engine being newer than the project. The second is
 * given once per file and the third once per project per server session. The
 * third is given only by a call that wrote one of its `sceneWrites` files: a
 * call that changed no scene file has no save to describe, and a file that is
 * not a scene (the `.res` of `export_mesh_library`) is not what the note is
 * about.
 */
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
    const guard = rejectIfLiveSessionOnProject(runner, projectPath, SCENE_EDIT);
    if (guard) return guard;
  }
  // Read before the first attempt and compared once after the last, so a
  // cold-import retry is measured against the file as the caller left it, not
  // against whatever the first attempt wrote.
  const sceneGuard =
    options.sceneWrites && options.sceneWrites.length > 0
      ? beginSceneGuard(projectPath, options.sceneWrites)
      : null;
  const lastAttempt: LastAttempt = { stderr: '' };
  const result = await runSceneOp(
    runner,
    operation,
    params,
    projectPath,
    failurePrefix,
    emptyStdoutSolutions,
    exceptionSolutions,
    options,
    lastAttempt,
  );
  if (sceneGuard === null) return result;
  const payload = result.ok ? result.value.structuredContent : undefined;
  if (payload !== undefined) {
    try {
      // The operation's report names the node each path led to, which the
      // request cannot (a `%Name` path): an operation with no restatement of
      // its own still gets its node paths replaced by those.
      const restated = options.refineSceneWrites
        ? options.refineSceneWrites(payload)
        : resolveIntentPaths(options.sceneWrites ?? [], payload);
      restateSceneGuard(sceneGuard, restated);
    } catch {
      // The request's own intent stands when the payload cannot be read.
    }
  }
  // Every exit of the run comes through here, the refusals and the thrown
  // spawn error included: a run that failed late may already have saved.
  const { warnings, unchecked, wroteScene } = finishSceneGuard(sceneGuard, lastAttempt.stderr);
  warnings.push(...newUncheckedSaveWarnings(runner, unchecked));
  // Only a save that happened is worth the version note: an error response
  // already says the operation did not complete, and a call that left every
  // scene file as it was saved nothing.
  if (wroteScene && payload !== undefined) {
    const versionWarning = await engineNewerWarning(runner, projectPath);
    if (versionWarning !== null) warnings.push(versionWarning);
  }
  return prependWarnings(result, warnings);
}

/**
 * The stderr of the attempt whose result is returned. A cold first attempt can
 * fail to load a script only because its dependencies were not imported yet;
 * the retry that saved loaded it, so only that attempt's stderr says which
 * scripts the saved file was written without.
 */
interface LastAttempt {
  stderr: string;
}

/** The run itself: one attempt, plus the cold-import retry. `lastAttempt` receives the stderr of the attempt that counts. */
async function runSceneOp(
  runner: GodotRunner,
  operation: string,
  params: OperationParams,
  projectPath: string,
  failurePrefix: string,
  emptyStdoutSolutions: string[],
  exceptionSolutions: string[],
  options: SceneOpOptions,
  lastAttempt: LastAttempt,
): Promise<HandlerResult> {
  // A read never passes `mutatesSceneFile`, so a refusal reached from here by
  // a read is worded for a read.
  const refused = options.mutatesSceneFile ? SCENE_EDIT : SCENE_READ_NEEDING_IMPORT;
  const answerBy = headlessAnswerDeadline();
  try {
    let { stdout, stderr } = await runner.executeOperation(operation, params, projectPath);
    lastAttempt.stderr = stderr;
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
              'The next headless call on the affected scene (get_scene_tree, for example) imports the missing asset before it runs. After it, re-run only the steps that failed',
            ],
          ),
        );
      }
      // importAssets writes .godot/ under the project. A running session on
      // this same project is a second writer racing it, same as the
      // mutatesSceneFile guard above. It is checked here too because this
      // branch is reachable by read-only handlers that never pass that option.
      const guard = rejectIfLiveSessionOnProject(runner, projectPath, refused, [
        'This project also needs an asset import, which will run automatically once the session is stopped',
      ]);
      if (guard) return guard;
      let retryTimeoutMs: number | null;
      try {
        retryTimeoutMs = await importWithinBudget(runner, projectPath, answerBy);
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
      if (retryTimeoutMs === null) {
        return err(
          createErrorResponse(
            `${failurePrefix}: ${IMPORT_STILL_RUNNING_MESSAGE}`,
            IMPORT_STILL_RUNNING_SOLUTIONS,
          ),
        );
      }
      ({ stdout, stderr } = await runner.executeOperation(
        operation,
        params,
        projectPath,
        retryTimeoutMs,
      ));
      lastAttempt.stderr = stderr;
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

/** What a call answers when the import it needed outlasted its budget. The import was left running. */
export const IMPORT_STILL_RUNNING_MESSAGE =
  "the project's assets are still being imported, nothing was changed; retry this call.";
export const IMPORT_STILL_RUNNING_SOLUTIONS = [
  'Retry this call: it joins the import that is already running and goes on once it has finished',
  'A first import of a large project can take a few minutes, so several retries may be needed',
];

/** When a headless call that starts now has to have answered: inside the client's request timeout. */
export function headlessAnswerDeadline(): number {
  return Date.now() + CLIENT_REQUEST_TIMEOUT_MS - HEADLESS_RESPONSE_MARGIN_MS;
}

/**
 * Run or join the project's asset import and wait for it only while a retry
 * still fits before `answerBy`. Returns the timeout the retry may run with, or
 * null when the import is still running; a failed import rejects.
 */
export async function importWithinBudget(
  runner: GodotRunner,
  projectPath: string,
  answerBy: number,
): Promise<number | null> {
  const imported = await finishesBy(
    runner.importAssets(projectPath),
    answerBy - IMPORT_RETRY_RESERVE_MS,
  );
  if (!imported) return null;
  return Math.min(HEADLESS_OPERATION_TIMEOUT_MS, Math.max(0, answerBy - Date.now()));
}

/**
 * Wait for `work` until `deadlineAt` (a `Date.now()` value). True when it
 * finished in time, false when the deadline came first; a rejection in time is
 * rethrown. `work` is not cancelled, and a rejection that comes after the
 * deadline is taken here so it is not reported as unhandled.
 */
function finishesBy(work: Promise<void>, deadlineAt: number): Promise<boolean> {
  return new Promise<boolean>((resolveWait, rejectWait) => {
    const timer = setTimeout(() => resolveWait(false), Math.max(0, deadlineAt - Date.now()));
    work.then(
      () => {
        clearTimeout(timer);
        resolveWait(true);
      },
      (error: unknown) => {
        clearTimeout(timer);
        rejectWait(error);
      },
    );
  });
}

/** Who is running a game on a project, as seen from this server. */
export type LiveSessionOnProject = { owner: 'self' } | { owner: 'other'; info: BridgeOwnerInfo };

/**
 * The one live-session detector. Own sessions first (this runner has a live
 * session on this project, whether or not it is the current one), then any
 * other MCP session registered as an owner of the project. Null when nothing
 * is running it. `registryRead` `'read-only'` asks the owner registry without
 * its upkeep (dead owner files are left in place), for a caller that must not
 * write to the project yet.
 */
export function findLiveSessionOnProject(
  runner: GodotRunner,
  projectPath: string,
  registryRead: OwnerRegistryRead = 'prune',
): LiveSessionOnProject | null {
  if (runner.hasLiveSessionOnProject(projectPath)) return { owner: 'self' };

  // Own-session check above covers this server. A sibling server process (or
  // a second BridgeManager instance in this one) can also be running the
  // game on this project, and this runner has no way to stop that session —
  // it isn't its own.
  const other = runner.otherLiveSessionsOnProject(projectPath, registryRead)[0];
  if (other) return { owner: 'other', info: other };

  return null;
}

/** What a live game on the project is being refused for, in the words of that kind of call. */
interface RefusedActivity {
  /** Completes "Refusing ..." and "then retry ...". */
  what: string;
  /** Why this server's own running game rules the call out. */
  ownSessionConflict: string;
  /** What to do about this server's own running game. */
  ownSessionInstruction: string;
  /** Why another session's running game rules the call out. */
  otherSessionConflict: string;
}

const SCENE_EDIT: RefusedActivity = {
  what: 'the scene edit',
  ownSessionConflict:
    "The running process can write this project's scene files at any point while it lives, so a headless edit here would be a second writer racing it.",
  ownSessionInstruction: 'Stop the session before editing scene files.',
  otherSessionConflict:
    "A running game can write this project's scene files at any time, so a headless edit now would race it.",
};

/**
 * A read changes no scene file, so a live game never refuses it by itself. It
 * is refused only when it first needs an asset import, which writes the
 * project's `.godot/` directory under the running game.
 */
const SCENE_READ_NEEDING_IMPORT: RefusedActivity = {
  what: 'the scene read',
  ownSessionConflict:
    "This read changes nothing in the scene, but an asset it depends on has not been imported yet, and the import writes the project's .godot/ directory while the running game uses it.",
  ownSessionInstruction:
    'Stop the session, then repeat the read: the import runs before it automatically.',
  otherSessionConflict:
    "This read changes nothing in the scene, but an asset it depends on has not been imported yet, and the import writes the project's .godot/ directory while that game uses it.",
};

// A running (spawned or attached) engine process can write its own project's
// scene files at any point during its lifetime -- not just in response to an
// MCP call. An autoload's _process loop calling ResourceSaver.save is enough;
// no run_script invocation is required. A headless mutation writes the same
// files from outside that process. Two writers on one file race regardless of
// which one triggers the write, so the guard covers the whole session rather
// than trying to serialize around individual calls. A read is refused here
// only for the asset import it needs first (see `SCENE_READ_NEEDING_IMPORT`).
function rejectIfLiveSessionOnProject(
  runner: GodotRunner,
  projectPath: string,
  refused: RefusedActivity,
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
        `Could not read this project's bridge owner registry (${error.reason}), so it is unknown whether another MCP session is running its game. Refusing ${refused.what}.`,
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
    const remedy = liveSessionRemedy(runner, projectPath, refused.what);
    return err(
      createErrorResponse(
        `A Godot runtime session is active on this project.${remedy.note} ${refused.ownSessionConflict} ${refused.ownSessionInstruction}`,
        [...remedy.solutions, ...extraSolutions],
      ),
    );
  }

  const other = live.info;
  const foreign = foreignHostOwnerRemedy(other, projectPath);
  return err(
    createErrorResponse(
      `Another MCP session (server pid ${other.pid}, ${other.mode} mode) is running this ` +
        "project's game. That game belongs to the other session, not this one, and only it can " +
        `stop it. ${refused.otherSessionConflict} Wait for the other session to finish ` +
        `(stop_project there), then retry.${foreign?.note ?? ''}`,
      [
        'Wait and retry once the other MCP session has stopped or detached its game',
        "check_project on this project shows this session's own state, not the other session's",
        ...(foreign !== null ? [foreign.solution] : []),
        ...extraSolutions,
      ],
    ),
  );
}
