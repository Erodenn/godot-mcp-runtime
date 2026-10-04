import { isAbsolute, join } from 'path';
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import type { GodotRunner } from '../utils/godot-runner.js';
import type { HandlerResult, OperationParams, ToolDefinition } from '../mcp.types.js';
import { normalizeParameters } from '../utils/parameter-conversion.js';
import { resolveProjectPath, type ResolvedProjectPath } from '../utils/path-validation.js';
import { createErrorResponse, extractGdError, getErrorMessage } from '../utils/error-response.js';
import { parseProjectArgs, optionalString } from '../utils/arg-parsing.js';
import {
  extractOperationPayload,
  parseScriptDiagnostics,
  stripOperationSentinel,
} from '../utils/output-parsing.js';
import { err } from '../utils/result.js';
import { createStructuredResponse, leadWithWarnings } from '../utils/structured-response.js';
import { VALIDATE_RES_DIR, validateTempDir } from '../utils/artifact-paths.js';
import { findLiveSessionOnProject, stderrRequestsImport } from '../utils/headless-op.js';
import { BridgeRegistryUnreadableError } from '../utils/bridge-manager.js';

/**
 * Item schema for the checks[] array. Referenced by both the top-level
 * `checks` property and `targets[].checks`, which are the same shape;
 * inputSchema ships on every handshake, so the duplicate costs bytes as
 * well as maintenance.
 */
const CHECK_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: ['structure', 'signals'],
      description: 'The kind of check to run',
    },
    schema: {
      type: 'object',
      description:
        '[structure] Recursive node schema: { type?: string, children?: Schema[], hasProperty?: string }. Checks the root node and subtree.',
    },
    nodePath: {
      type: 'string',
      description: '[signals] Optional node path to scope the check to a subtree (e.g. "root/HUD")',
    },
  },
  required: ['type'],
} as const;

/** Most diagnostics that matched no target a batch result lists before it counts the rest. */
const MAX_UNATTRIBUTED_DIAGNOSTICS_SHOWN = 10;

/**
 * The error a target gets when the engine called it invalid and no diagnostic
 * could be tied to it. The first form points at `warnings`, so it is used only
 * when the batch has unattributed diagnostics to show there.
 */
const UNATTRIBUTED_FAILURE_MESSAGE =
  'The file failed to load. Its diagnostics could not be attributed to this path; see warnings.';
const UNEXPLAINED_FAILURE_MESSAGE =
  'The file failed to load, and the engine printed no diagnostic that names it.';

/** Keys a structure schema node accepts. `has_property` is the snake_case spelling of `hasProperty`. */
const SCHEMA_NODE_KEYS: readonly string[] = ['type', 'children', 'hasProperty', 'has_property'];
/**
 * Top-level keys the tool accepts, after `normalizeParameters` has folded the
 * snake_case spellings. Anything else is a misspelling that would be dropped
 * without a word, such as `scenepath` or a lone `check`, and the call would
 * validate nothing it was asked to.
 */
const VALIDATE_TOP_LEVEL_KEYS: readonly string[] = [
  'projectPath',
  'scriptPath',
  'source',
  'scenePath',
  'checks',
  'targets',
];
/** Keys one `targets[]` item accepts, in both spellings: items are not normalized. */
const VALIDATE_TARGET_KEYS: readonly string[] = [
  'scriptPath',
  'script_path',
  'source',
  'scenePath',
  'scene_path',
  'checks',
];
/** Keys a check item accepts, per check type. `node_path` is the snake_case spelling of `nodePath`. */
const STRUCTURE_CHECK_KEYS: readonly string[] = ['type', 'schema'];
const SIGNALS_CHECK_KEYS: readonly string[] = ['type', 'nodePath', 'node_path'];

/** One entry of an `errors` array: a parse error, or a checks[] finding. */
const VALIDATE_ERROR_SCHEMA = {
  type: 'object',
  properties: {
    message: { type: 'string' },
    line: { type: 'number', description: 'Parse errors only, when Godot reported a line.' },
    check: { type: 'string', description: 'checks[] findings: "structure" or "signals".' },
    path: { type: 'string', description: 'Structure findings about one node.' },
    node: { type: 'string' },
    signal: { type: 'string' },
    target: { type: 'string' },
    method: { type: 'string' },
    problem: { type: 'string', description: 'Signals findings: the problem code.' },
  },
  required: ['message'],
} as const;

export const validateToolDefinitions = [
  {
    name: 'validate',
    description:
      "Validate GDScript syntax or scene integrity in headless Godot. Use before attach_script or run_script. Give exactly one of scriptPath, source or scenePath, or a targets array (one process); an unknown key is an error. checks needs scenePath and instantiates the scene, running each attached script's _init(). Returns: { valid, errors } for one target, { warnings?, results: [{ target, valid, errors }] } for targets; an invalid result always has an error.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Path to the Godot project directory',
        },
        scriptPath: {
          type: 'string',
          description:
            '[single] Path to a .gd file relative to the project to validate (e.g. "scripts/player.gd"). A file that does not load as a GDScript is reported invalid with a "Not validated" error, since nothing checks it.',
        },
        source: {
          type: 'string',
          description:
            '[single] Inline GDScript source code to validate. Written to a temporary file and validated against the project.',
        },
        scenePath: {
          type: 'string',
          description:
            '[single] Path to a .tscn scene file relative to the project to validate (e.g. "scenes/main.tscn")',
        },
        checks: {
          type: 'array',
          description:
            '[single, requires scenePath] Structural and signal-verification checks to run against the scene. Types: "structure" (validate node tree against a schema) and "signals" (verify signal connections and handler methods, optional nodePath scope). Merged into the errors array with a "check" discriminator. Not accepted alongside targets: put checks on the target they belong to.',
          items: CHECK_ITEM_SCHEMA,
        },
        targets: {
          type: 'array',
          description:
            '[batch] Array of targets to validate in a single Godot process. Each item must have exactly one of: scriptPath, source, or scenePath. Cannot be combined with the top-level scriptPath, source, scenePath or checks.',
          items: {
            type: 'object',
            properties: {
              scriptPath: {
                type: 'string',
                description: 'Path to a .gd file relative to the project',
              },
              source: { type: 'string', description: 'Inline GDScript source code' },
              scenePath: {
                type: 'string',
                description: 'Path to a .tscn scene file relative to the project',
              },
              checks: {
                type: 'array',
                description:
                  '[requires scenePath] Structural / signal checks for this target, run in the same Godot process as the rest of the batch. Same shape as the top-level checks array.',
                items: CHECK_ITEM_SCHEMA,
              },
            },
          },
        },
      },
      required: ['projectPath'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        warnings: {
          type: 'array',
          items: { type: 'string' },
          description:
            'targets only. Engine diagnostics that matched no target, as "<file>:<line>: <message>", capped with a "+N more" tail.',
        },
        valid: { type: 'boolean', description: 'Single target only.' },
        errors: { type: 'array', description: 'Single target only.', items: VALIDATE_ERROR_SCHEMA },
        results: {
          type: 'array',
          description: 'targets only: one entry per target, in input order.',
          items: {
            type: 'object',
            properties: {
              target: { type: 'string' },
              valid: { type: 'boolean' },
              errors: { type: 'array', items: VALIDATE_ERROR_SCHEMA },
            },
            required: ['target', 'valid', 'errors'],
          },
        },
      },
    },
  },
] as const satisfies readonly ToolDefinition[];

interface ValidationError {
  line?: number;
  message: string;
}

/** A check-attributed error from the checks[] array (structure/signals). */
interface CheckError {
  check?: string;
  message: string;
  [key: string]: unknown;
}

function parseGodotErrors(stderr: string): ValidationError[] {
  return parseScriptDiagnostics(stderr).map(({ message, line }) => {
    const err: ValidationError = { message };
    if (line !== undefined) err.line = line;
    return err;
  });
}

/**
 * Write inline GDScript source to a uniquely-named file under
 * <projectPath>/.mcp/godot-runtime/validate/ for validation. Returns the
 * project-relative path (e.g. ".mcp/godot-runtime/validate/validate_temp_xxx.gd")
 * that the runner consumes plus the absolute path the caller cleans up.
 *
 * The file is deleted per call at the two unlinkSync sites below; there is no
 * orphan sweep. It needs no .gdignore of its own — it is handed to Godot as an
 * explicit script_path on a headless run and never resolved through the
 * importer, and .mcp/.gdignore (owned by BridgeManager) covers the subtree
 * whenever this server has run the project.
 */
function writeTempGdScript(
  projectPath: string,
  source: string,
  prefix: 'validate_temp' | 'validate_batch',
): { resPath: string; absPath: string } {
  const tempDir = validateTempDir(projectPath);
  mkdirSync(tempDir, { recursive: true });
  const name = `${prefix}_${randomUUID()}.gd`;
  const absPath = join(tempDir, name);
  writeFileSync(absPath, source, 'utf8');
  return { resPath: `${VALIDATE_RES_DIR}/${name}`, absPath };
}

/**
 * The spelling a batch target is forwarded in. GDScript echoes the forwarded
 * string back as the result's `target`, so the caller's own spelling is kept
 * (a bare path or a `res://` path reads back as given). An absolute path is the
 * exception: GDScript cannot resolve it, so it travels as the project-relative
 * path and that is what the result reports.
 */
function batchTargetSpelling(resolved: ResolvedProjectPath): string {
  return isAbsolute(resolved.input) ? resolved.relPath : resolved.input;
}

/** A stderr diagnostic that named no res:// file. */
interface UnpathedDiagnostic {
  message: string;
  line?: number;
}

/**
 * Group Godot stderr errors by their res:// file path.
 * Used for batch validation where multiple files produce output in one stderr
 * stream. Diagnostics that named no res:// file come back in `unpathed`, so a
 * caller can count them instead of losing them.
 */
function parseGodotErrorsByPath(stderr: string): {
  byPath: Map<string, ValidationError[]>;
  unpathed: UnpathedDiagnostic[];
} {
  const byPath = new Map<string, ValidationError[]>();
  const unpathed: UnpathedDiagnostic[] = [];
  for (const { message, line, filePath } of parseScriptDiagnostics(stderr)) {
    const err: ValidationError = { message };
    if (line !== undefined) err.line = line;
    if (!filePath) {
      unpathed.push(err);
      continue;
    }
    if (!byPath.has(filePath)) byPath.set(filePath, []);
    byPath.get(filePath)!.push(err);
  }
  return { byPath, unpathed };
}

/** One unattributed diagnostic as a warning line: "<file>:<line>: <message>", or the message alone. */
function formatUnattributedDiagnostic(file: string | undefined, error: ValidationError): string {
  if (file === undefined) return error.message;
  const where = error.line === undefined ? file : `${file}:${error.line}`;
  return `${where}: ${error.message}`;
}

/** Cap a warning list at `MAX_UNATTRIBUTED_DIAGNOSTICS_SHOWN` entries and say how many were cut. */
function capUnattributedWarnings(lines: string[]): string[] {
  if (lines.length <= MAX_UNATTRIBUTED_DIAGNOSTICS_SHOWN) return lines;
  const hidden = lines.length - MAX_UNATTRIBUTED_DIAGNOSTICS_SHOWN;
  return [...lines.slice(0, MAX_UNATTRIBUTED_DIAGNOSTICS_SHOWN), `+${hidden} more`];
}

/**
 * Runs a validate operation, and on the `[IMPORT_NEEDED]` stderr marker runs
 * the asset import step and retries exactly once. Structurally capped: a
 * marker on the retried run falls through to the caller's normal error
 * handling instead of importing again. Mirrors the retry in `executeSceneOp`,
 * which validate cannot use (it returns a wrapped HandlerResult, while both
 * validate branches need raw stdout plus stderr for the per-path diagnostic
 * overlay).
 *
 * The retry is skipped while a game is, or may be, running on this project:
 * this server's own session (current or not), another MCP server's session,
 * or an owner registry that cannot be read. importAssets writes .godot/ under
 * the project and a running engine there is a second writer. A session on
 * another project does not block it. Skipping costs the caller the import
 * only: the target's own result names the dependency that was not imported.
 *
 * An importAssets rejection propagates: both call sites sit inside a try whose
 * catch produces a structured error response.
 */
async function executeValidateOp(
  runner: GodotRunner,
  operation: string,
  params: OperationParams,
  projectPath: string,
): Promise<{ stdout: string; stderr: string }> {
  const first = await runner.executeOperation(operation, params, projectPath);
  if (!stderrRequestsImport(first.stderr) || gameMayBeRunningOnProject(runner, projectPath)) {
    return first;
  }
  await runner.importAssets(projectPath);
  return runner.executeOperation(operation, params, projectPath);
}

/**
 * True when a session is live on the project, whoever owns it, or when that
 * cannot be ruled out. The same detector the scene-edit guard uses, so a
 * validate call never runs an asset import under another server's game.
 */
function gameMayBeRunningOnProject(runner: GodotRunner, projectPath: string): boolean {
  try {
    return findLiveSessionOnProject(runner, projectPath) !== null;
  } catch (error: unknown) {
    if (error instanceof BridgeRegistryUnreadableError) return true;
    throw error;
  }
}

/** The single-target parameters, which a call that passes `targets` must not also pass. */
const SINGLE_TARGET_PATH_PARAMS = ['scriptPath', 'source', 'scenePath'] as const;

/** A defined `checks` value that asks for something: anything but an empty array. */
function requestsChecks(checks: unknown): boolean {
  return checks !== undefined && (!Array.isArray(checks) || checks.length > 0);
}

/** One `targets[]` item as the batch loop reads it, after both key spellings are folded. */
interface BatchTarget {
  scriptPath?: unknown;
  source?: unknown;
  scenePath?: unknown;
  checks?: unknown;
}

/**
 * Read one `targets[]` item. `normalizeParameters` does not descend into
 * arrays, so an item reaches the handler spelled however the caller wrote it;
 * both spellings are read, as the items of `nodes`, `updates` and `operations`
 * are. Null when the item is not an object.
 */
function readBatchTarget(raw: unknown): BatchTarget | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  return {
    scriptPath: item.scriptPath !== undefined ? item.scriptPath : item.script_path,
    source: item.source,
    scenePath: item.scenePath !== undefined ? item.scenePath : item.scene_path,
    checks: item.checks,
  };
}

const TARGET_SHAPE_MESSAGE = 'Target must have exactly one of scriptPath, source, or scenePath';

/** Most engine diagnostics quoted when a validate run ended without a result. */
const MAX_NO_RESULT_DIAGNOSTICS_SHOWN = 5;

const NO_RESULT_SOLUTIONS = [
  'Check that the script or scene path is correct',
  'An autoload that fails or quits while the project starts stops the run before it reports: list_autoloads shows what is registered',
  'Ensure Godot is installed correctly',
];

/**
 * The error for a validate run that printed no result line. All three branches
 * (single, single with checks, targets) word it the same way: what the script
 * said on its own [ERROR] line, and when it said nothing, the engine
 * diagnostics that are the only account of why it stopped.
 */
function noResultMessage(prefix: string, stderr: string): string {
  const head = `${prefix}: no result was emitted - ${extractGdError(stderr)}`;
  if (stderr.includes('[ERROR]')) return head;
  const diagnostics = parseScriptDiagnostics(stderr)
    .slice(0, MAX_NO_RESULT_DIAGNOSTICS_SHOWN)
    .map((d) => {
      const where = d.filePath ? `${d.filePath}${d.line !== undefined ? `:${d.line}` : ''}: ` : '';
      return `${where}${d.message}`;
    });
  return diagnostics.length === 0 ? head : `${head}\nstderr: ${diagnostics.join('\n')}`;
}

export async function handleValidate(
  runner: GodotRunner,
  args: OperationParams,
): Promise<HandlerResult> {
  args = normalizeParameters(args);

  const parsed = parseProjectArgs(args);
  if (!parsed.ok) return parsed;
  const { projectPath } = parsed.value;

  const unknownKey = Object.keys(args).find((key) => !VALIDATE_TOP_LEVEL_KEYS.includes(key));
  if (unknownKey !== undefined) {
    return err(
      createErrorResponse(
        `Unknown parameter "${unknownKey}" (allowed: projectPath, scriptPath, source, scenePath, checks, targets)`,
        [
          `Check the spelling of "${unknownKey}": an unknown parameter is refused instead of ignored`,
          'Give exactly one of scriptPath, source or scenePath, or a targets array',
        ],
      ),
    );
  }

  // Batch mode: targets array
  if (args.targets && Array.isArray(args.targets)) {
    // The batch branch reads `targets` and nothing else. A single-target
    // parameter passed beside it used to be dropped without a word, so a
    // top-level `checks` came back as targets reported valid with the checks
    // never run. Single mode refuses every mixed combination; so does this.
    for (const key of SINGLE_TARGET_PATH_PARAMS) {
      if (args[key] !== undefined && args[key] !== '') {
        return err(
          createErrorResponse(
            `"${key}" cannot be combined with targets: with a targets array, only the targets are validated and a top-level ${key} would be ignored.`,
            [
              `Add it as another item of targets, e.g. { "${key}": ... }`,
              `Or remove targets to validate the one ${key}`,
            ],
          ),
        );
      }
    }
    if (requestsChecks(args.checks)) {
      return err(
        createErrorResponse(
          '"checks" cannot be combined with targets: top-level checks apply to a single scenePath and would not run on any target.',
          [
            'Move the checks into the target they belong to: targets: [{ "scenePath": "main.tscn", "checks": [...] }]',
            'Or remove targets and pass scenePath with checks',
          ],
        ),
      );
    }

    const targets = args.targets as unknown[];
    const tempFiles: string[] = [];

    try {
      const snakeTargets: Array<{
        script_path?: string;
        scene_path?: string;
        checks?: unknown[];
      }> = [];
      const preErrors = new Map<number, { target: string; errors: ValidationError[] }>();

      for (const [i, raw] of targets.entries()) {
        // A target that is not an object, or names a path with something other
        // than a string, is this target's own failure. Reading it further would
        // throw and cost every other target its result.
        const read = readBatchTarget(raw);
        const mistyped =
          read === null
            ? undefined
            : SINGLE_TARGET_PATH_PARAMS.find(
                (key) => read[key] !== undefined && typeof read[key] !== 'string',
              );
        if (read === null || mistyped !== undefined) {
          preErrors.set(i, {
            target: '',
            errors: [
              {
                message:
                  read === null
                    ? `targets[${i}] must be an object with exactly one of scriptPath, source, or scenePath`
                    : `targets[${i}].${mistyped} must be a string`,
              },
            ],
          });
          continue;
        }
        // A key the target does not take is a misspelling (`check` for `checks`):
        // forwarded, the target would be validated without what it asked for and
        // come back valid. It is this target's own failure; the rest still run.
        const unknownTargetKey = Object.keys(raw as Record<string, unknown>).find(
          (key) => !VALIDATE_TARGET_KEYS.includes(key),
        );
        if (unknownTargetKey !== undefined) {
          const named = read.scenePath ?? read.scriptPath;
          preErrors.set(i, {
            target: typeof named === 'string' ? named : '',
            errors: [
              {
                message: `targets[${i}]: unknown key "${unknownTargetKey}" (allowed: scriptPath, source, scenePath, checks)`,
              },
            ],
          });
          continue;
        }
        const t = read as {
          scriptPath?: string;
          source?: string;
          scenePath?: string;
          checks?: unknown;
        };
        // An empty array means no checks, as in single mode. Any other defined
        // value that is not an array is not "no checks": it is a mistake that
        // used to be dropped, leaving the target reported valid with its checks
        // never run.
        const tChecks = Array.isArray(t.checks) && t.checks.length > 0 ? t.checks : undefined;
        // A target naming more than one mode is ambiguous, and the arms below
        // pick one and drop the rest - a scriptPath plus a scenePath plus checks
        // used to report the script's validity with no sign the checks never
        // ran. Single mode rejects the same input outright; here it is this
        // target's own failure so the rest of the batch still reports.
        if ([t.scriptPath, t.source, t.scenePath].filter(Boolean).length > 1) {
          preErrors.set(i, {
            target: t.scenePath ?? t.scriptPath ?? '',
            errors: [{ message: TARGET_SHAPE_MESSAGE }],
          });
          continue;
        }
        if (t.checks !== undefined && !Array.isArray(t.checks)) {
          const shapeFailure = validateCheckItems(t.checks);
          if (shapeFailure) {
            preErrors.set(i, {
              target: t.scenePath ?? t.scriptPath ?? '',
              errors: [{ message: shapeFailure.message }],
            });
            continue;
          }
        }
        // Checks run against an instantiated scene, so a target without a
        // scenePath has nothing to run them on. That is this target's own
        // failure: it is never forwarded, and every other target still reports.
        if (tChecks && !t.scenePath) {
          preErrors.set(i, {
            target: t.scriptPath ?? '',
            errors: [{ message: 'Target checks require scenePath - checks run against a scene' }],
          });
          continue;
        }
        // Same shape guards single mode runs. Without them a structure check
        // with a missing or misspelled schema crosses into GDScript, asserts
        // nothing, and comes back valid:true for this target.
        if (tChecks) {
          const checkFailure = validateCheckItems(tChecks);
          if (checkFailure) {
            preErrors.set(i, {
              target: t.scenePath ?? '',
              errors: [{ message: checkFailure.message }],
            });
            continue;
          }
        }
        if (t.source) {
          const { resPath, absPath } = writeTempGdScript(projectPath, t.source, 'validate_batch');
          tempFiles.push(absPath);
          snakeTargets.push({ script_path: resPath });
        } else if (t.scriptPath) {
          const scriptTarget = resolveProjectPath(projectPath, t.scriptPath);
          if (!scriptTarget) {
            preErrors.set(i, {
              target: t.scriptPath,
              errors: [
                {
                  message:
                    'Invalid scriptPath: must be a relative path inside the project root, no ".."',
                },
              ],
            });
          } else {
            snakeTargets.push({ script_path: batchTargetSpelling(scriptTarget) });
          }
        } else if (t.scenePath) {
          const sceneTarget = resolveProjectPath(projectPath, t.scenePath);
          if (!sceneTarget) {
            preErrors.set(i, {
              target: t.scenePath,
              errors: [
                {
                  message:
                    'Invalid scenePath: must be a relative path inside the project root, no ".."',
                },
              ],
            });
          } else {
            // Check items are forwarded camelCase and untouched: the runner's
            // convertCamelToSnakeCase rewrites nodePath and every nested
            // hasProperty on the way out, so pre-converting here would
            // double-convert.
            const accepted: { scene_path: string; checks?: unknown[] } = {
              scene_path: batchTargetSpelling(sceneTarget),
            };
            if (tChecks) accepted.checks = tChecks;
            snakeTargets.push(accepted);
          }
        } else {
          // A target that names nothing never reaches Godot. Forwarded empty, it
          // came back as "provide script_path or scene_path", which names keys
          // the tool does not declare and, for a caller who misspelled one,
          // the keys it had just provided.
          preErrors.set(i, {
            target: '',
            errors: [{ message: `targets[${i}]: ${TARGET_SHAPE_MESSAGE}` }],
          });
        }
      }

      // Short-circuit when every target failed pre-validation — no work for
      // Godot, and spawning it would just cost ~3s for a no-op.
      if (snakeTargets.length === 0 && preErrors.size === targets.length) {
        const results = targets.map((_, i) => {
          const pre = preErrors.get(i)!;
          return { target: pre.target, valid: false, errors: pre.errors };
        });
        return createStructuredResponse({ results });
      }

      const { stdout, stderr } = await executeValidateOp(
        runner,
        'validate_batch',
        { targets: snakeTargets },
        projectPath,
      );

      if (!stdout.trim()) {
        return err(
          createErrorResponse(`Batch validate failed: ${extractGdError(stderr)}`, [
            'Check that all target paths are valid',
            'Ensure Godot is installed correctly',
          ]),
        );
      }

      const batchPayload = extractOperationPayload(stdout);
      if (batchPayload === null) {
        // Output without a result line: the script stopped before it emitted
        // one, and stdout is engine or project noise. The reason is on stderr.
        return err(
          createErrorResponse(
            noResultMessage('Batch validate failed', stderr),
            NO_RESULT_SOLUTIONS,
          ),
        );
      }

      let batchParsed: {
        results: Array<{
          target: string;
          resolvedPath?: string;
          valid: boolean;
          errors: ValidationError[];
          checkErrors?: CheckError[];
        }>;
      };
      try {
        batchParsed = JSON.parse(batchPayload);
      } catch {
        return err(
          createErrorResponse(
            `Invalid response from validate_batch: ${stripOperationSentinel(stdout)}`,
            ['Ensure Godot is installed correctly'],
          ),
        );
      }

      const { byPath: errorsByPath, unpathed } = parseGodotErrorsByPath(stderr || '');

      // Three error sources per target: Godot's stderr diagnostics (which
      // supersede the GDScript-reported parse errors when present), and the
      // per-target checks[] findings, which are additive because they describe
      // something else entirely. checkErrors is internal to this merge; the
      // tool keeps returning one flat errors array per target.
      //
      // The attribution key is the path Godot resolved (`resolvedPath`), the
      // spelling its diagnostics use. The raw target is only a fallback for a
      // payload without one: a path written "./a.gd", with a backslash, or under
      // a directory containing a space never equals the engine's own spelling.
      const claimedPaths = new Set<string>();
      // The errors arrays of targets the engine called invalid with nothing to
      // explain it. Their one entry is written after the unattributed
      // diagnostics are known, because its wording depends on them.
      const unexplainedFailures: Array<Array<ValidationError | CheckError>> = [];
      const godotResults = batchParsed.results.map((r) => {
        const key =
          r.resolvedPath ?? (r.target.startsWith('res://') ? r.target : `res://${r.target}`);
        claimedPaths.add(key);
        claimedPaths.add(r.target);
        const stderrErrors = errorsByPath.get(key) || errorsByPath.get(r.target) || [];
        const parseErrors = stderrErrors.length > 0 ? stderrErrors : (r.errors ?? []);
        const checkErrors = Array.isArray(r.checkErrors) ? r.checkErrors : [];
        const errors = [...parseErrors, ...checkErrors] as Array<ValidationError | CheckError>;
        // The engine's own verdict was "invalid" and nothing explains it: say so
        // instead of returning valid:false with an empty errors array.
        if (r.valid === false && errors.length === 0) unexplainedFailures.push(errors);
        return {
          target: r.target,
          valid: r.valid && stderrErrors.length === 0 && checkErrors.length === 0,
          errors,
        };
      });

      // Diagnostics that belong to no target: a script attached inside a
      // validated scene, or an `at:` line that named no file. Single mode takes
      // every diagnostic; here they lead the payload so a clean-looking target
      // is not the whole story.
      const unattributed: string[] = [];
      for (const [file, errors] of errorsByPath) {
        if (claimedPaths.has(file)) continue;
        for (const error of errors) unattributed.push(formatUnattributedDiagnostic(file, error));
      }
      for (const error of unpathed) {
        unattributed.push(formatUnattributedDiagnostic(undefined, error));
      }
      const unexplainedMessage =
        unattributed.length > 0 ? UNATTRIBUTED_FAILURE_MESSAGE : UNEXPLAINED_FAILURE_MESSAGE;
      for (const errors of unexplainedFailures) errors.push({ message: unexplainedMessage });

      // Merge pre-validation failures back into their original positions so
      // output order matches input order. Pre-validation errors are ours, not
      // Godot's — they bypass the stderr overlay above.
      const results: Array<{
        target: string;
        valid: boolean;
        errors: Array<ValidationError | CheckError>;
      }> = [];
      let godotIdx = 0;
      for (let i = 0; i < targets.length; i++) {
        if (preErrors.has(i)) {
          const pre = preErrors.get(i)!;
          results.push({ target: pre.target, valid: false, errors: pre.errors });
        } else {
          const r = godotResults[godotIdx++];
          // Not reachable with the shipped script, which answers every target
          // it is sent. If it ever answered fewer, the target is reported as
          // not validated: leaving it out would shorten `results` without a
          // sign and shift every later entry onto the wrong input.
          if (r === undefined) {
            const unanswered = readBatchTarget(targets[i]);
            const label = unanswered?.scenePath ?? unanswered?.scriptPath;
            results.push({
              target: typeof label === 'string' ? label : '',
              valid: false,
              errors: [{ message: 'Not validated: the engine returned no result for this target' }],
            });
            continue;
          }
          results.push(r);
        }
      }

      return createStructuredResponse(
        leadWithWarnings({ warnings: capUnattributedWarnings(unattributed), results }),
      );
    } catch (error: unknown) {
      return err(
        createErrorResponse(`Batch validation failed: ${getErrorMessage(error)}`, [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
        ]),
      );
    } finally {
      for (const f of tempFiles) {
        try {
          unlinkSync(f);
        } catch {
          /* ignore */
        }
      }
    }
  }

  // Single mode — parse each optional field then enforce exactly-one rule
  const scriptPathResult = optionalString(args, 'scriptPath');
  if (!scriptPathResult.ok) return scriptPathResult;
  const sourceResult = optionalString(args, 'source');
  if (!sourceResult.ok) return sourceResult;
  const scenePathResult = optionalString(args, 'scenePath');
  if (!scenePathResult.ok) return scenePathResult;

  const checksRaw = args.checks;
  const hasChecks = checksRaw !== undefined && (!Array.isArray(checksRaw) || checksRaw.length > 0);

  const modeCount = [scriptPathResult.value, sourceResult.value, scenePathResult.value].filter(
    Boolean,
  ).length;
  if (modeCount === 0 && !hasChecks) {
    return err(
      createErrorResponse('One of scriptPath, source, or scenePath is required', [
        'Provide scriptPath to validate an existing .gd file, source to validate inline GDScript, or scenePath to validate a .tscn file',
      ]),
    );
  }
  if (hasChecks && scenePathResult.value === undefined) {
    return err(
      createErrorResponse('checks requires scenePath - checks run against a scene', [
        'Pass scenePath alongside checks, e.g. { "scenePath": "main.tscn", "checks": [{ "type": "structure", "schema": {...} }] }',
      ]),
    );
  }
  if (modeCount > 1) {
    return err(
      createErrorResponse(
        'Provide exactly one of scriptPath, source, or scenePath - not multiple',
        ['Only one target can be validated per call'],
      ),
    );
  }

  let resolvedScriptPath: string | undefined;
  let resolvedScenePath: string | undefined;
  let tempFileAbsPath: string | undefined;

  try {
    if (sourceResult.value) {
      const { resPath, absPath } = writeTempGdScript(
        projectPath,
        sourceResult.value,
        'validate_temp',
      );
      resolvedScriptPath = resPath;
      tempFileAbsPath = absPath;
    } else if (scriptPathResult.value) {
      const script = resolveProjectPath(projectPath, scriptPathResult.value);
      if (!script) {
        return err(
          createErrorResponse('Invalid scriptPath', [
            'Provide a valid relative path without ".." that stays inside the project directory',
          ]),
        );
      }
      if (!existsSync(script.absPath)) {
        return err(
          createErrorResponse(`Script file does not exist: ${scriptPathResult.value}`, [
            'Ensure the path is correct relative to the project directory',
          ]),
        );
      }
      resolvedScriptPath = script.relPath;
    } else if (scenePathResult.value) {
      const scene = resolveProjectPath(projectPath, scenePathResult.value);
      if (!scene) {
        return err(
          createErrorResponse('Invalid scenePath', [
            'Provide a valid relative path without ".." that stays inside the project directory',
          ]),
        );
      }
      if (!existsSync(scene.absPath)) {
        return err(
          createErrorResponse(`Scene file does not exist: ${scenePathResult.value}`, [
            'Ensure the path is correct relative to the project directory',
          ]),
        );
      }
      resolvedScenePath = scene.relPath;
    }

    // A scenePath plus checks is one Godot process, not two. validate_batch
    // with a single target does the parse validation and runs the checks
    // against one instantiated scene; the plain scenePath spelling of the same
    // call used to cost a second process that loaded the scene again. The
    // response shape is unchanged: the batch payload is unwrapped back into
    // { valid, errors } below.
    const combined = hasChecks && resolvedScenePath !== undefined;

    let stdout: string;
    let stderr: string;
    if (combined) {
      const checkFailure = validateCheckItems(checksRaw);
      if (checkFailure) {
        return err(createErrorResponse(checkFailure.message, checkFailure.solutions));
      }
      // Check items travel camelCase and untouched for the same reason the
      // batch branch forwards them raw: the runner's convertCamelToSnakeCase
      // rewrites nodePath and every nested hasProperty on the way out.
      ({ stdout, stderr } = await executeValidateOp(
        runner,
        'validate_batch',
        { targets: [{ scene_path: resolvedScenePath, checks: checksRaw }] },
        projectPath,
      ));
    } else {
      const params: OperationParams = {};
      if (resolvedScriptPath) params.scriptPath = resolvedScriptPath;
      if (resolvedScenePath) params.scenePath = resolvedScenePath;
      ({ stdout, stderr } = await runner.executeOperation(
        'validate_resource',
        params,
        projectPath,
      ));
    }

    // Parse stdout for the base valid/invalid signal from GDScript
    let valid = false;
    let gdErrors: ValidationError[] = [];
    let checkErrors: CheckError[] = [];
    if (combined) {
      if (!stdout.trim()) {
        return err(
          createErrorResponse(`Scene checks failed: ${extractGdError(stderr)}`, [
            'Check if the scene path is correct',
            'Ensure the schema follows the documented shape',
          ]),
        );
      }
      const combinedPayload = extractOperationPayload(stdout);
      if (combinedPayload === null) {
        return err(
          createErrorResponse(noResultMessage('Scene checks failed', stderr), NO_RESULT_SOLUTIONS),
        );
      }
      let batchParsed: {
        results?: Array<{
          valid?: boolean;
          errors?: ValidationError[];
          checkErrors?: CheckError[];
        }>;
      };
      try {
        batchParsed = JSON.parse(combinedPayload);
      } catch {
        batchParsed = {};
      }
      const target = batchParsed.results?.[0];
      if (!target) {
        return err(
          createErrorResponse(
            `Invalid response from validate_batch: ${stripOperationSentinel(stdout)}`,
            ['Ensure Godot is installed correctly'],
          ),
        );
      }
      valid = target.valid === true;
      if (Array.isArray(target.errors) && target.errors.length > 0) gdErrors = target.errors;
      if (Array.isArray(target.checkErrors)) checkErrors = target.checkErrors;
    } else {
      // No payload, or one that is not a JSON object, means nothing was
      // validated. That is a failed call, never a verdict: the batch and
      // combined branches answer the same condition the same way.
      let parsed: { valid?: unknown; errors?: unknown } | null = null;
      try {
        const candidate: unknown = JSON.parse(extractOperationPayload(stdout) ?? '');
        if (typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)) {
          parsed = candidate as { valid?: unknown; errors?: unknown };
        }
      } catch {
        parsed = null;
      }
      if (parsed === null) {
        return err(
          createErrorResponse(noResultMessage('Validation failed', stderr), NO_RESULT_SOLUTIONS),
        );
      }
      valid = parsed.valid === true;
      if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
        gdErrors = parsed.errors as ValidationError[];
      }
    }

    // Parse stderr for detailed error messages from Godot's script compiler
    const stderrErrors = parseGodotErrors(stderr || '');

    // Merge errors: prefer detailed stderr errors when available, otherwise keep gdErrors
    const allErrors: ValidationError[] = stderrErrors.length > 0 ? stderrErrors : gdErrors;

    // The GDScript-side `valid` flag is unreliable for malformed scripts: load()
    // returns a non-null placeholder Resource even when parsing fails, so
    // resource != null is true. Fall back to the parsed stderr errors as the
    // authoritative signal — matches the batch branch above.
    let result: { valid: boolean; errors: Array<ValidationError | CheckError> } = {
      valid: valid && allErrors.length === 0,
      errors: allErrors,
    };

    // checks[]: structural / signal verification against the scene, merged
    // into the same output shape with a `check` discriminator per error.
    if (checkErrors.length > 0) {
      result = {
        valid: false,
        errors: [...result.errors, ...checkErrors],
      };
    }

    // An invalid verdict always carries a reason, as it does in targets mode:
    // valid:false with an empty errors array leaves the caller nothing to act on.
    if (!result.valid && result.errors.length === 0) {
      result = { valid: false, errors: [{ message: UNEXPLAINED_FAILURE_MESSAGE }] };
    }

    return createStructuredResponse(result);
  } catch (error: unknown) {
    return err(
      createErrorResponse(`Validation failed: ${getErrorMessage(error)}`, [
        'Ensure Godot is installed correctly',
        'Check if the GODOT_PATH environment variable is set correctly',
      ]),
    );
  } finally {
    if (tempFileAbsPath) {
      try {
        unlinkSync(tempFileAbsPath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

const SCHEMA_EXAMPLE_SOLUTION =
  'Example: { "type": "Node2D", "children": [{ "type": "CollisionShape2D", "hasProperty": "shape" }] }';

/** A rejected checks[] array, before it is turned into a response. */
interface CheckValidationFailure {
  message: string;
  solutions: string[];
}

/**
 * Validate one structure schema node and its children[] recursively, returning
 * the failure to surface or null when the node is well formed. The
 * GDScript side hedges too, but rejecting here keeps the diagnosis specific: a
 * bad nested entry otherwise surfaces as a generic "Scene checks failed" with
 * nothing naming the offending part. `path` is a caller-facing breadcrumb like
 * "schema.children[0]".
 */
function validateSchemaNode(schema: unknown, path: string): CheckValidationFailure | null {
  const solutions = [SCHEMA_EXAMPLE_SOLUTION];
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return {
      message: `Invalid schema at ${path}: must be an object like { type?, children?, hasProperty? }`,
      solutions,
    };
  }
  // A key outside the documented set is a misspelling that would assert
  // nothing: a schema node with one recognized key and one typo'd one used to
  // pass, with the typo'd assertion never evaluated.
  for (const key of Object.keys(schema)) {
    if (!SCHEMA_NODE_KEYS.includes(key)) {
      return {
        message: `Invalid schema at ${path}: unknown key "${key}" (allowed: type, children, hasProperty)`,
        solutions,
      };
    }
  }
  const node = schema as {
    type?: unknown;
    children?: unknown;
    hasProperty?: unknown;
    has_property?: unknown;
  };
  if (
    node.type === undefined &&
    node.children === undefined &&
    node.hasProperty === undefined &&
    node.has_property === undefined
  ) {
    return {
      message: `Invalid schema at ${path}: at least one of type, children, or hasProperty is required`,
      solutions,
    };
  }
  if (node.children !== undefined) {
    if (!Array.isArray(node.children)) {
      return { message: `Invalid schema at ${path}: children must be an array`, solutions };
    }
    for (const [i, child] of node.children.entries()) {
      const childError = validateSchemaNode(child, `${path}.children[${i}]`);
      if (childError) return childError;
    }
  }
  return null;
}

/**
 * Shape-check one checks[] array before it crosses into GDScript. Shared by
 * single mode and by every batch target that carries checks, so a malformed
 * check is rejected identically either way: the GDScript side reads a missing
 * `schema` as an empty Dictionary and appends no finding, which would report a
 * structure check that never ran as `valid: true`.
 *
 * Returns the failure to surface, or null when the array is well formed. The
 * caller decides what a failure costs - a whole error response in single mode,
 * one target's own result in batch mode.
 */
function validateCheckItems(checks: unknown): CheckValidationFailure | null {
  if (!Array.isArray(checks)) {
    return {
      message: 'Invalid checks: must be an array of { type: "structure" | "signals", ... }',
      solutions: [
        'Example: { "scenePath": "main.tscn", "checks": [{ "type": "structure", "schema": { "type": "Node2D" } }] }',
      ],
    };
  }
  for (const check of checks) {
    if (typeof check !== 'object' || check === null) {
      return {
        message: 'Invalid checks: each item must be an object',
        solutions: ['Example: { "type": "signals", "nodePath": "root/HUD" }'],
      };
    }
    const t = (check as { type?: unknown }).type;
    if (t !== 'structure' && t !== 'signals') {
      return {
        message: `Invalid check type: ${String(t)} (expected "structure" or "signals")`,
        solutions: ['Supported types: "structure" (with schema) and "signals" (optional nodePath)'],
      };
    }
    const allowedKeys = t === 'structure' ? STRUCTURE_CHECK_KEYS : SIGNALS_CHECK_KEYS;
    for (const key of Object.keys(check)) {
      if (!allowedKeys.includes(key)) {
        return {
          message: `Invalid check: unknown key "${key}" on a ${t} check (allowed: ${allowedKeys.join(', ')})`,
          solutions: [
            t === 'structure'
              ? 'A structure check takes type and schema'
              : 'A signals check takes type and an optional nodePath',
          ],
        };
      }
    }
    if (t === 'structure') {
      const schemaError = validateSchemaNode((check as { schema?: unknown }).schema, 'schema');
      if (schemaError) return schemaError;
    }
  }
  return null;
}
