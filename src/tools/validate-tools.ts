import { isAbsolute, join } from 'path';
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import type { GodotRunner } from '../utils/godot-runner.js';
import type { HandlerResult, OperationParams, ToolDefinition, ToolResponse } from '../mcp.types.js';
import { normalizeParameters } from '../utils/parameter-conversion.js';
import {
  projectSubPathError,
  PROJECT_SUB_PATH_SOLUTIONS,
  resolveProjectPath,
  type ResolvedProjectPath,
} from '../utils/path-validation.js';
import {
  createErrorResponse,
  extractGdError,
  getErrorMessage,
  NO_SCRIPT_ERROR_LINE_MESSAGE,
} from '../utils/error-response.js';
import { parseProjectArgs, optionalString } from '../utils/arg-parsing.js';
import {
  extractOperationPayload,
  parseScriptDiagnostics,
  stripOperationSentinel,
} from '../utils/output-parsing.js';
import { err } from '../utils/result.js';
import { createStructuredResponse, leadWithWarnings } from '../utils/structured-response.js';
import { VALIDATE_RES_DIR, validateTempDir } from '../utils/artifact-paths.js';
import {
  findLiveSessionOnProject,
  headlessAnswerDeadline,
  IMPORT_STILL_RUNNING_MESSAGE,
  IMPORT_STILL_RUNNING_SOLUTIONS,
  importWithinBudget,
  stderrRequestsImport,
} from '../utils/headless-op.js';
import { BridgeManager, BridgeRegistryUnreadableError } from '../utils/bridge-manager.js';

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

const MAX_UNATTRIBUTED_DIAGNOSTICS_SHOWN = 10;

const UNATTRIBUTED_FAILURE_MESSAGE =
  'The file failed to load. Its diagnostics could not be attributed to this path; see warnings.';
const UNEXPLAINED_FAILURE_MESSAGE =
  'The file failed to load, and the engine printed no diagnostic that names it.';

const SCHEMA_NODE_KEYS: readonly string[] = ['type', 'children', 'hasProperty', 'has_property'];
// Anything else is a misspelling that would be dropped without a word, and the call would validate nothing it was asked to.
const VALIDATE_TOP_LEVEL_KEYS: readonly string[] = [
  'projectPath',
  'scriptPath',
  'source',
  'scenePath',
  'checks',
  'targets',
];
// Both spellings: `targets[]` items are not normalized.
const VALIDATE_TARGET_KEYS: readonly string[] = [
  'scriptPath',
  'script_path',
  'source',
  'scenePath',
  'scene_path',
  'checks',
];
const STRUCTURE_CHECK_KEYS: readonly string[] = ['type', 'schema'];
const SIGNALS_CHECK_KEYS: readonly string[] = ['type', 'nodePath', 'node_path'];

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

// Deleted per call at the two unlinkSync sites; no orphan sweep. `ensureArtifactRoot` runs first so `.mcp/.gdignore` exists before any `.gd` lands.
function writeTempGdScript(
  projectPath: string,
  source: string,
  prefix: 'validate_temp' | 'validate_batch',
): { resPath: string; absPath: string } {
  BridgeManager.ensureArtifactRoot(projectPath);
  const tempDir = validateTempDir(projectPath);
  mkdirSync(tempDir, { recursive: true });
  const name = `${prefix}_${randomUUID()}.gd`;
  const absPath = join(tempDir, name);
  writeFileSync(absPath, source, 'utf8');
  return { resPath: `${VALIDATE_RES_DIR}/${name}`, absPath };
}

/** Only the echo: what travels to GDScript is always `relPath`. */
function batchTargetEcho(resolved: ResolvedProjectPath): string {
  return isAbsolute(resolved.input) ? resolved.relPath : resolved.input;
}

interface UnpathedDiagnostic {
  message: string;
  line?: number;
}

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

function formatUnattributedDiagnostic(file: string | undefined, error: ValidationError): string {
  if (file === undefined) return error.message;
  const where = error.line === undefined ? file : `${file}:${error.line}`;
  return `${where}: ${error.message}`;
}

function capUnattributedWarnings(lines: string[]): string[] {
  if (lines.length <= MAX_UNATTRIBUTED_DIAGNOSTICS_SHOWN) return lines;
  const hidden = lines.length - MAX_UNATTRIBUTED_DIAGNOSTICS_SHOWN;
  return [...lines.slice(0, MAX_UNATTRIBUTED_DIAGNOSTICS_SHOWN), `+${hidden} more`];
}

// Retries once after the asset import on [IMPORT_NEEDED]; skipped while a game is or may be running on this project (importAssets writes .godot/, a second writer).
// A still-running or failed import throws; both call sites catch and answer with an error.
async function executeValidateOp(
  runner: GodotRunner,
  operation: string,
  params: OperationParams,
  projectPath: string,
): Promise<{ stdout: string; stderr: string }> {
  const answerBy = headlessAnswerDeadline();
  const first = await runner.executeOperation(operation, params, projectPath);
  if (!stderrRequestsImport(first.stderr) || gameMayBeRunningOnProject(runner, projectPath)) {
    return first;
  }
  const retryTimeoutMs = await importWithinBudget(runner, projectPath, answerBy);
  if (retryTimeoutMs === null) throw new ImportStillRunningError();
  return runner.executeOperation(operation, params, projectPath, retryTimeoutMs);
}

class ImportStillRunningError extends Error {
  constructor() {
    super(IMPORT_STILL_RUNNING_MESSAGE);
    this.name = 'ImportStillRunningError';
  }
}

function validateExceptionResponse(prefix: string, error: unknown): ToolResponse {
  if (error instanceof ImportStillRunningError) {
    return createErrorResponse(`${prefix}: ${error.message}`, IMPORT_STILL_RUNNING_SOLUTIONS);
  }
  return createErrorResponse(`${prefix}: ${getErrorMessage(error)}`, [
    'Ensure Godot is installed correctly',
    'Check if the GODOT_PATH environment variable is set correctly',
  ]);
}

function gameMayBeRunningOnProject(runner: GodotRunner, projectPath: string): boolean {
  try {
    return findLiveSessionOnProject(runner, projectPath) !== null;
  } catch (error: unknown) {
    if (error instanceof BridgeRegistryUnreadableError) return true;
    throw error;
  }
}

const SINGLE_TARGET_PATH_PARAMS = ['scriptPath', 'source', 'scenePath'] as const;

function requestsChecks(checks: unknown): boolean {
  return checks !== undefined && (!Array.isArray(checks) || checks.length > 0);
}

interface BatchTarget {
  scriptPath?: unknown;
  source?: unknown;
  scenePath?: unknown;
  checks?: unknown;
}

/** `normalizeParameters` does not descend into arrays: both key spellings are read and the value is forwarded under a key this handler writes. */
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

const MAX_NO_RESULT_DIAGNOSTICS_SHOWN = 5;

const NO_RESULT_SOLUTIONS = [
  'Check that the script or scene path is correct',
  'An autoload that fails or quits while the project starts stops the run before it reports: list_autoloads shows what is registered',
  'Ensure Godot is installed correctly',
];

function noResultMessage(prefix: string, stderr: string): string {
  const head = `${prefix}: no result was emitted - `;
  if (stderr.includes('[ERROR]')) return `${head}${extractGdError(stderr)}`;
  const diagnostics = parseScriptDiagnostics(stderr)
    .slice(0, MAX_NO_RESULT_DIAGNOSTICS_SHOWN)
    .map((d) => {
      const where = d.filePath ? `${d.filePath}${d.line !== undefined ? `:${d.line}` : ''}: ` : '';
      return `${where}${d.message}`;
    });
  // One account of stderr, not two: extractGdError carries its tail when nothing parsed.
  return diagnostics.length === 0
    ? `${head}${extractGdError(stderr)}`
    : `${head}${NO_SCRIPT_ERROR_LINE_MESSAGE}\nstderr: ${diagnostics.join('\n')}`;
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

  // An unread `targets` would fall through to single mode and validate less than asked.
  if (args.targets !== undefined && !Array.isArray(args.targets)) {
    return err(
      createErrorResponse('targets must be an array of { scriptPath | source | scenePath } items', [
        'Pass targets as an array, e.g. targets: [{ "scenePath": "main.tscn" }]',
        'Or remove targets and pass one of scriptPath, source or scenePath',
      ]),
    );
  }

  if (Array.isArray(args.targets)) {
    // The batch branch reads `targets` alone: a single-target parameter beside it was once dropped silently, leaving checks never run.
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
      // One entry per forwarded target: its reported `target`, or null to keep the script's path (inline source).
      const targetEchoes: Array<string | null> = [];
      const preErrors = new Map<number, { target: string; errors: ValidationError[] }>();

      for (const [i, raw] of targets.entries()) {
        // A malformed target is its own failure: reading further would throw and cost every other target its result.
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
        // An unknown key is a misspelling (`check`): forwarded, the target would come back valid without the checks.
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
        // An empty array means no checks; any other non-array value is a mistake, not "no checks".
        const tChecks = Array.isArray(t.checks) && t.checks.length > 0 ? t.checks : undefined;
        // More than one mode is ambiguous and the arms below would drop the rest; it is this target's own failure so the batch still reports.
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
        // Checks need a scenePath to run on; this target fails alone and is never forwarded.
        if (tChecks && !t.scenePath) {
          preErrors.set(i, {
            target: t.scriptPath ?? '',
            errors: [{ message: 'Target checks require scenePath - checks run against a scene' }],
          });
          continue;
        }
        // Same shape guards as single mode: a bad structure check would cross into GDScript and come back valid:true.
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
          targetEchoes.push(null);
        } else if (t.scriptPath) {
          const scriptTarget = resolveProjectPath(projectPath, t.scriptPath, 'read');
          if (!scriptTarget) {
            preErrors.set(i, {
              target: t.scriptPath,
              errors: [{ message: projectSubPathError('scriptPath', t.scriptPath) }],
            });
          } else {
            snakeTargets.push({ script_path: scriptTarget.relPath });
            targetEchoes.push(batchTargetEcho(scriptTarget));
          }
        } else if (t.scenePath) {
          const sceneTarget = resolveProjectPath(projectPath, t.scenePath, 'read');
          if (!sceneTarget) {
            preErrors.set(i, {
              target: t.scenePath,
              errors: [{ message: projectSubPathError('scenePath', t.scenePath) }],
            });
          } else {
            // Forwarded camelCase: the runner's convertCamelToSnakeCase rewrites nodePath and nested hasProperty; pre-converting would double-convert.
            const accepted: { scene_path: string; checks?: unknown[] } = {
              scene_path: sceneTarget.relPath,
            };
            if (tChecks) accepted.checks = tChecks;
            snakeTargets.push(accepted);
            targetEchoes.push(batchTargetEcho(sceneTarget));
          }
        } else {
          // A target that names nothing never reaches Godot: forwarded empty, its error named keys the tool does not declare.
          preErrors.set(i, {
            target: '',
            errors: [{ message: `targets[${i}]: ${TARGET_SHAPE_MESSAGE}` }],
          });
        }
      }

      // Every target failed pre-validation: skip spawning Godot.
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
        // No result line: the script stopped before emitting one and stdout is noise; the reason is on stderr.
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

      // Godot's stderr diagnostics supersede GDScript parse errors; checks[] findings are additive. Attribution keys on `resolvedPath`,
      // the engine's spelling: a raw "./a.gd", a backslash path or a path with a space never equals it.
      const claimedPaths = new Set<string>();
      // Targets the engine called invalid with nothing to explain it; their entry is written once the unattributed diagnostics are known.
      const unexplainedFailures: Array<Array<ValidationError | CheckError>> = [];
      const godotResults = batchParsed.results.map((r, resultIndex) => {
        const key =
          r.resolvedPath ?? (r.target.startsWith('res://') ? r.target : `res://${r.target}`);
        claimedPaths.add(key);
        claimedPaths.add(r.target);
        const stderrErrors = errorsByPath.get(key) || errorsByPath.get(r.target) || [];
        const parseErrors = stderrErrors.length > 0 ? stderrErrors : (r.errors ?? []);
        const checkErrors = Array.isArray(r.checkErrors) ? r.checkErrors : [];
        const errors = [...parseErrors, ...checkErrors] as Array<ValidationError | CheckError>;
        // Invalid with nothing to explain it: say so rather than valid:false with an empty errors array.
        if (r.valid === false && errors.length === 0) unexplainedFailures.push(errors);
        return {
          target: targetEchoes[resultIndex] ?? r.target,
          valid: r.valid && stderrErrors.length === 0 && checkErrors.length === 0,
          errors,
        };
      });

      // Diagnostics for no target (a script attached inside a validated scene, an `at:` line naming no file) lead the payload.
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

      // Pre-validation failures are ours, not Godot's: merged back by input position, bypassing the stderr overlay.
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
          // Unreachable with the shipped script; if it answered fewer, report the target as not validated rather than shift later entries onto the wrong input.
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
      return err(validateExceptionResponse('Batch validation failed', error));
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
      const script = resolveProjectPath(projectPath, scriptPathResult.value, 'read');
      if (!script) {
        return err(
          createErrorResponse(projectSubPathError('scriptPath', scriptPathResult.value), [
            ...PROJECT_SUB_PATH_SOLUTIONS,
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
      const scene = resolveProjectPath(projectPath, scenePathResult.value, 'read');
      if (!scene) {
        return err(
          createErrorResponse(projectSubPathError('scenePath', scenePathResult.value), [
            ...PROJECT_SUB_PATH_SOLUTIONS,
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

    // scenePath plus checks is one Godot process via a single-target batch; the batch payload is unwrapped to { valid, errors } below.
    const combined = hasChecks && resolvedScenePath !== undefined;

    let stdout: string;
    let stderr: string;
    if (combined) {
      const checkFailure = validateCheckItems(checksRaw);
      if (checkFailure) {
        return err(createErrorResponse(checkFailure.message, checkFailure.solutions));
      }
      // Camel-case and untouched, as in the batch branch (see convertCamelToSnakeCase).
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
      // No payload, or a non-object, means nothing was validated: a failed call, never a verdict.
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

    const stderrErrors = parseGodotErrors(stderr || '');

    const allErrors: ValidationError[] = stderrErrors.length > 0 ? stderrErrors : gdErrors;

    // The GDScript `valid` flag is unreliable: load() returns a non-null placeholder Resource on a parse failure, so stderr errors decide.
    let result: { valid: boolean; errors: Array<ValidationError | CheckError> } = {
      valid: valid && allErrors.length === 0,
      errors: allErrors,
    };

    if (checkErrors.length > 0) {
      result = {
        valid: false,
        errors: [...result.errors, ...checkErrors],
      };
    }

    // An invalid verdict always carries a reason; valid:false with no errors leaves the caller nothing to act on.
    if (!result.valid && result.errors.length === 0) {
      result = { valid: false, errors: [{ message: UNEXPLAINED_FAILURE_MESSAGE }] };
    }

    return createStructuredResponse(result);
  } catch (error: unknown) {
    return err(validateExceptionResponse('Validation failed', error));
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

interface CheckValidationFailure {
  message: string;
  solutions: string[];
}

/** The GDScript side hedges too; rejecting here keeps the diagnosis specific instead of a generic "Scene checks failed". */
function validateSchemaNode(schema: unknown, path: string): CheckValidationFailure | null {
  const solutions = [SCHEMA_EXAMPLE_SOLUTION];
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return {
      message: `Invalid schema at ${path}: must be an object like { type?, children?, hasProperty? }`,
      solutions,
    };
  }
  // A key outside the documented set is a misspelling whose assertion would never be evaluated.
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

/** The GDScript side reads a missing `schema` as empty and appends no finding, which would report a structure check that never ran as `valid: true`. */
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
