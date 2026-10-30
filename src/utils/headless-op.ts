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

/** How much of the client's request timeout a headless call keeps back for delivering its answer; the rest is the call's budget. */
export const HEADLESS_RESPONSE_MARGIN_MS = 5000;
/** The least a cold-import retry runs with: the import wait ends this long before the budget, so a finished import always leaves the retry a usable timeout. */
export const IMPORT_RETRY_RESERVE_MS = 10000;

/** The `[IMPORT_NEEDED]` marker, matched only at the start of a stderr line behind `[ERROR] `: a DEBUG=true param echo can quote it and would trigger a replay.
 * KEEP IN SYNC with `_report_import_needed` in src/scripts/godot_operations.gd. */
const IMPORT_NEEDED_LINE = /^(?:\[ERROR\] )?\[IMPORT_NEEDED\] /m;

/** True when a line of this stderr is the script's own request for an asset import. */
export function stderrRequestsImport(stderr: string): boolean {
  return IMPORT_NEEDED_LINE.test(stderr);
}

/** Prefix of the lines godot_operations.gd prints through `log_error`. */
const SCRIPT_ERROR_PREFIX = '[ERROR] ';

/** The reasons godot_operations.gd gave for a failure, in print order: engine diagnostics around them (a leak warning, an unrelated `ERROR:` line) describe the process, not the failure. */
function scriptErrorLines(stderr: string): string[] {
  return stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(SCRIPT_ERROR_PREFIX))
    .map((line) => line.slice(SCRIPT_ERROR_PREFIX.length).trim())
    .filter((line) => line !== '');
}

/** Renders one parsed stderr diagnostic keeping its file+line location, the most useful part of the diagnosis. */
function renderStderrDiagnostic(d: StderrDiagnostic): string {
  const location = d.filePath
    ? `${d.filePath}${d.line !== undefined ? `:${d.line}` : ''}: `
    : d.line !== undefined
      ? `line ${d.line}: `
      : '';
  return `${location}${d.message}`;
}

/** Stderr portion of an early-exit error: parsed diagnostics for their file+line, else the raw tail. */
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

/** What a run that asked for an import had already done: `nothing`, `applied-steps` (a multi-step payload with a successful step), or `completed` (a single-step payload, emitted only after its work is saved). */
type MarkedRunState = 'nothing' | 'applied-steps' | 'completed';

/** Did this run already report applied work? The cold-import retry re-runs from the start, correct only while nothing was written; a batch saves every scene it mutated, so a replay would apply its steps twice.
 * Keyed on the payload, not the operation name. A single-step payload beside a marker means the line came from elsewhere (a project script). No payload, or a top-level `error`, is `nothing`. */
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

/** Interprets a finished operation's stdout and stderr into a HandlerResult; the one path used whether or not an import retry ran, differing only in `failurePrefix`. */
function interpretOperationResult(
  stdout: string,
  stderr: string,
  failurePrefix: string,
  emptyStdoutSolutions: string[],
  options: { parseStdoutAsJson?: boolean },
): HandlerResult {
  if (!stdout.trim()) {
    // The script's own [ERROR] line leads. Without one the script was stopped (runtime errors print SCRIPT ERROR lines only), so parsed diagnostics lead, then the end of stderr: never the bare 'no reason'.
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
      // No result sentinel: the operation quit before emitting a payload and stdout is noise, never parsed as one; stderr carries the failure (compile errors print there).
      const parts = [
        `${failurePrefix}: no JSON payload was emitted - the operation likely exited early on an error.`,
      ];
      // The operation's own reason leads: it sits on stderr behind engine diagnostics, which renderStderrForEarlyExit shows first when it finds any.
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
      // A payload with a top-level error string is a failure reported by the wrong channel (every operation fails to stderr without a payload): the work did not happen.
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
  /** True for an operation that writes into the project; refused while a game runs on it (see `rejectIfLiveSessionOnProject`). */
  mutatesSceneFile?: boolean;
  /** The scene files this operation writes and what it asks to change in each; compared before and after (`scene-loss-guard.ts`), and the engine-newer note is given only when one was written. */
  sceneWrites?: SceneWriteIntent[];
  /** `sceneWrites` restated from the operation's own payload (a batch knows which save-as steps succeeded); called only for a success payload. */
  refineSceneWrites?: (payload: Record<string, unknown>) => SceneWriteIntent[];
}

/** Puts `warnings` ahead of the result: a success gains a leading `warnings` array, a failure one more text block, since a file written before failing still lost what it lost. */
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

/** Projects each runner has given the engine-newer note for: one runner is one session, and repeating a project-level note on every save buries the warnings about the call. */
const engineNewerNoted = new WeakMap<GodotRunner, Set<string>>();

/** Scene files each runner has said were saved unchecked, once per file per session: a binary `.scn` cannot be compared on any save and would otherwise lead every payload. */
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

/** Warning for a project last saved by an older engine than the one that just wrote a scene; null when versions are in order, unknown, or already said this session. The project's version is read first so a project stating none costs no engine probe. */
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

/** Runs a headless GDScript operation: execute, empty-stdout check and try/catch shared by the headless scene and node handlers.
 * On the `[IMPORT_NEEDED]` marker it imports and retries exactly once, never after a run that already reported applied work (`classifyMarkedRun`). Warnings lead the payload in order: scene loss, unchecked save, engine-newer note (only from a call that wrote one of its `sceneWrites` files). */
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
  // Read before the first attempt and compared once after the last, so a cold-import retry is measured against the file as the caller left it.
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
      // The operation's report names the node each path led to, which the request cannot (a `%Name` path).
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
  // Only a save that happened is worth the version note: an error response or an untouched scene file saved nothing.
  if (wroteScene && payload !== undefined) {
    const versionWarning = await engineNewerWarning(runner, projectPath);
    if (versionWarning !== null) warnings.push(versionWarning);
  }
  return prependWarnings(result, warnings);
}

/** The stderr of the attempt whose result is returned: a cold first attempt can fail to load a script only for missing imports, so only the retry's stderr says what the saved file was written without. */
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

    // Cold-import marker (may appear even with a JSON error). One retry, structurally: a second marker on the retried run falls through to normal interpretation.
    // A run that emitted a single-step result is finished and asked for nothing (see classifyMarkedRun).
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
      // importAssets writes .godot/ under the project, so a running session on it is a second writer racing it; checked here too because read-only handlers reach this branch without `mutatesSceneFile`.
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

/** Runs or joins the project's asset import and waits only while a retry still fits before `answerBy`; returns the retry's timeout, or null while the import still runs. A failed import rejects. */
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

/** Waits for `work` until `deadlineAt`: true if it finished in time. `work` is not cancelled, and a late rejection is taken here so it is not reported as unhandled. */
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

export type LiveSessionOnProject = { owner: 'self' } | { owner: 'other'; info: BridgeOwnerInfo };

/** The one live-session detector: own sessions first, then any other MCP session registered as an owner. `registryRead: 'read-only'` skips the registry's upkeep for a caller that must not write to the project yet. */
export function findLiveSessionOnProject(
  runner: GodotRunner,
  projectPath: string,
  registryRead: OwnerRegistryRead = 'prune',
): LiveSessionOnProject | null {
  if (runner.hasLiveSessionOnProject(projectPath)) return { owner: 'self' };

  // A sibling server process (or a second BridgeManager in this one) can run the game on this project, and this runner cannot stop it.
  const other = runner.otherLiveSessionsOnProject(projectPath, registryRead)[0];
  if (other) return { owner: 'other', info: other };

  return null;
}

interface RefusedActivity {
  /** Completes "Refusing ..." and "then retry ...". */
  what: string;
  ownSessionConflict: string;
  ownSessionInstruction: string;
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

/** A read is refused only when it first needs an asset import, which writes `.godot/` under the running game. */
const SCENE_READ_NEEDING_IMPORT: RefusedActivity = {
  what: 'the scene read',
  ownSessionConflict:
    "This read changes nothing in the scene, but an asset it depends on has not been imported yet, and the import writes the project's .godot/ directory while the running game uses it.",
  ownSessionInstruction:
    'Stop the session, then repeat the read: the import runs before it automatically.',
  otherSessionConflict:
    "This read changes nothing in the scene, but an asset it depends on has not been imported yet, and the import writes the project's .godot/ directory while that game uses it.",
};

// A running engine can write its project's scene files at any time (an autoload's _process calling ResourceSaver.save), racing a headless mutation, so the guard covers the whole session, not individual calls.
// A read is refused only for the asset import it needs first (see `SCENE_READ_NEEDING_IMPORT`).
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
    // An unreadable owner registry is 'unknown', and the guard exists for exactly the case it cannot rule out: refuse, and say why.
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
