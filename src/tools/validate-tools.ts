import { join } from 'path';
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import type { GodotRunner } from '../utils/godot-runner.js';
import type { HandlerResult, OperationParams, ToolDefinition } from '../mcp.types.js';
import { normalizeParameters } from '../utils/parameter-conversion.js';
import { validateSubPath } from '../utils/path-validation.js';
import { createErrorResponse, extractGdError, getErrorMessage } from '../utils/error-response.js';
import { parseProjectArgs, optionalString } from '../utils/arg-parsing.js';
import { parseScriptDiagnostics } from '../utils/output-parsing.js';
import { ok, err } from '../utils/result.js';
import { VALIDATE_RES_DIR, validateTempDir } from '../utils/artifact-paths.js';
import { IMPORT_NEEDED_MARKER } from '../utils/headless-op.js';
import { runRenderCheck } from '../utils/render-check.js';

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
      enum: ['structure', 'signals', 'render'],
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
    frames: {
      type: 'integer',
      description: '[render] Number of frames to capture before evaluating (default 15)',
    },
    minChromatic: {
      type: 'number',
      description: '[render] Minimum chromatic ratio to pass (default 0.01)',
    },
    maxDominant: {
      type: 'number',
      description: '[render] Maximum dominant-color share to pass (default 0.98)',
    },
    minDistinct: {
      type: 'integer',
      description: '[render] Minimum distinct colors to pass (default 3)',
    },
  },
  required: ['type'],
} as const;

export const validateToolDefinitions = [
  {
    name: 'validate',
    description:
      "Validate GDScript syntax or scene integrity using headless Godot. Use before attach_script or run_script to catch parse errors early. Give exactly one of scriptPath, source, or scenePath, or a targets array validated in one Godot process. Returns { valid, errors } for one target, { results: [{ target, valid, errors }] } for a batch. An errors entry is { line?, message } for a parse error, or { check, problem?, message } for a checks[] finding. checks requires scenePath and instantiates the scene, running each attached script's _init(). Any parse error yields valid:false. checks supports three types: 'structure' (validate node tree against a schema), 'signals' (verify signal connections and handler methods), and 'render' (mechanically verify the viewport shows rendered content, not a blank frame).",
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
            '[single] Path to a .gd file relative to the project to validate (e.g. "scripts/player.gd")',
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
            '[single, requires scenePath] Structural, signal-verification, and render checks to run against the scene. Types: "structure" (validate node tree against a schema), "signals" (verify signal connections and handler methods, optional nodePath scope), and "render" (run the scene briefly and mechanically verify the viewport shows rendered content, not a blank frame). Merged into the errors array with a "check" discriminator.',
          items: CHECK_ITEM_SCHEMA,
        },
        targets: {
          type: 'array',
          description:
            '[batch] Array of targets to validate in a single Godot process. Each item must have exactly one of: scriptPath, source, or scenePath.',
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
 * Group Godot stderr errors by their res:// file path.
 * Used for batch validation where multiple files produce output in one stderr stream.
 */
function parseGodotErrorsByPath(stderr: string): Map<string, ValidationError[]> {
  const result = new Map<string, ValidationError[]>();
  for (const { message, line, filePath } of parseScriptDiagnostics(stderr)) {
    if (filePath) {
      if (!result.has(filePath)) result.set(filePath, []);
      const err: ValidationError = { message };
      if (line !== undefined) err.line = line;
      result.get(filePath)!.push(err);
    }
  }
  return result;
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
 * The retry is skipped while any runtime session is live: importAssets writes
 * .godot/ under the project and a running engine is a second writer. Skipping
 * only costs the caller the existing unimported-dependency error.
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
  if (!first.stderr.includes(IMPORT_NEEDED_MARKER) || runner.hasActiveRuntimeSession()) {
    return first;
  }
  await runner.importAssets(projectPath);
  return runner.executeOperation(operation, params, projectPath);
}

export async function handleValidate(
  runner: GodotRunner,
  args: OperationParams,
): Promise<HandlerResult> {
  args = normalizeParameters(args);

  const parsed = parseProjectArgs(args);
  if (!parsed.ok) return parsed;
  const { projectPath } = parsed.value;

  // Batch mode: targets array
  if (args.targets && Array.isArray(args.targets)) {
    const targets = args.targets as Array<{
      scriptPath?: string;
      source?: string;
      scenePath?: string;
      checks?: unknown[];
    }>;
    const tempFiles: string[] = [];

    try {
      const snakeTargets: Array<{
        script_path?: string;
        scene_path?: string;
        checks?: unknown[];
      }> = [];
      const preErrors = new Map<number, { target: string; errors: ValidationError[] }>();

      for (const [i, t] of targets.entries()) {
        const tChecks = Array.isArray(t.checks) && t.checks.length > 0 ? t.checks : undefined;
        // A target naming more than one mode is ambiguous, and the arms below
        // pick one and drop the rest - a scriptPath plus a scenePath plus checks
        // used to report the script's validity with no sign the checks never
        // ran. Single mode rejects the same input outright; here it is this
        // target's own failure so the rest of the batch still reports.
        if ([t.scriptPath, t.source, t.scenePath].filter(Boolean).length > 1) {
          preErrors.set(i, {
            target: t.scenePath ?? t.scriptPath ?? '',
            errors: [
              { message: 'Target must have exactly one of scriptPath, source, or scenePath' },
            ],
          });
          continue;
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
          // Render checks execute server-side (separate movie-writer run), so
          // they cannot be batched with structure/signals in one Godot process.
          const hasRender =
            Array.isArray(tChecks) &&
            tChecks.some((c: unknown) => (c as { type?: string }).type === 'render');
          if (hasRender) {
            preErrors.set(i, {
              target: t.scenePath ?? '',
              errors: [
                {
                  message:
                    'render checks are not supported in batch mode yet; use single mode (scenePath + checks) for render checks',
                },
              ],
            });
            continue;
          }
        }
        if (t.source) {
          const { resPath, absPath } = writeTempGdScript(projectPath, t.source, 'validate_batch');
          tempFiles.push(absPath);
          snakeTargets.push({ script_path: resPath });
        } else if (t.scriptPath) {
          if (!validateSubPath(projectPath, t.scriptPath)) {
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
            snakeTargets.push({ script_path: t.scriptPath });
          }
        } else if (t.scenePath) {
          if (!validateSubPath(projectPath, t.scenePath)) {
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
              scene_path: t.scenePath,
            };
            if (tChecks) accepted.checks = tChecks;
            snakeTargets.push(accepted);
          }
        } else {
          snakeTargets.push({});
        }
      }

      // Short-circuit when every target failed pre-validation — no work for
      // Godot, and spawning it would just cost ~3s for a no-op.
      if (snakeTargets.length === 0 && preErrors.size === targets.length) {
        const results = targets.map((_, i) => {
          const pre = preErrors.get(i)!;
          return { target: pre.target, valid: false, errors: pre.errors };
        });
        return ok({ content: [{ type: 'text', text: JSON.stringify({ results }, null, 2) }] });
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

      let batchParsed: {
        results: Array<{
          target: string;
          valid: boolean;
          errors: ValidationError[];
          checkErrors?: CheckError[];
        }>;
      };
      try {
        batchParsed = JSON.parse(stdout.trim());
      } catch {
        return err(
          createErrorResponse(`Invalid response from validate_batch: ${stdout}`, [
            'Ensure Godot is installed correctly',
          ]),
        );
      }

      const errorsByPath = parseGodotErrorsByPath(stderr || '');

      // Three error sources per target: Godot's stderr diagnostics (which
      // supersede the GDScript-reported parse errors when present), and the
      // per-target checks[] findings, which are additive because they describe
      // something else entirely. checkErrors is internal to this merge; the
      // tool keeps returning one flat errors array per target.
      const godotResults = batchParsed.results.map((r) => {
        const key = r.target.startsWith('res://') ? r.target : `res://${r.target}`;
        const stderrErrors = errorsByPath.get(key) || errorsByPath.get(r.target) || [];
        const parseErrors = stderrErrors.length > 0 ? stderrErrors : (r.errors ?? []);
        const checkErrors = Array.isArray(r.checkErrors) ? r.checkErrors : [];
        return {
          target: r.target,
          valid: r.valid && stderrErrors.length === 0 && checkErrors.length === 0,
          errors: [...parseErrors, ...checkErrors] as Array<ValidationError | CheckError>,
        };
      });

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
          // Unreachable: godotIdx is incremented once per non-pre-error target,
          // and godotResults has exactly that many entries.
          if (r === undefined) continue;
          results.push(r);
        }
      }

      return ok({ content: [{ type: 'text', text: JSON.stringify({ results }, null, 2) }] });
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

  let tempFile = false;
  let resolvedScriptPath: string | undefined;
  let resolvedScenePath: string | undefined;

  try {
    if (sourceResult.value) {
      const { resPath } = writeTempGdScript(projectPath, sourceResult.value, 'validate_temp');
      resolvedScriptPath = resPath;
      tempFile = true;
    } else if (scriptPathResult.value) {
      if (!validateSubPath(projectPath, scriptPathResult.value)) {
        return err(
          createErrorResponse('Invalid scriptPath', [
            'Provide a valid relative path without ".." that stays inside the project directory',
          ]),
        );
      }
      const fullPath = join(projectPath, scriptPathResult.value);
      if (!existsSync(fullPath)) {
        return err(
          createErrorResponse(`Script file does not exist: ${scriptPathResult.value}`, [
            'Ensure the path is correct relative to the project directory',
          ]),
        );
      }
      resolvedScriptPath = scriptPathResult.value;
    } else if (scenePathResult.value) {
      if (!validateSubPath(projectPath, scenePathResult.value)) {
        return err(
          createErrorResponse('Invalid scenePath', [
            'Provide a valid relative path without ".." that stays inside the project directory',
          ]),
        );
      }
      const fullPath = join(projectPath, scenePathResult.value);
      if (!existsSync(fullPath)) {
        return err(
          createErrorResponse(`Scene file does not exist: ${scenePathResult.value}`, [
            'Ensure the path is correct relative to the project directory',
          ]),
        );
      }
      resolvedScenePath = scenePathResult.value;
    }

    // A scenePath plus checks is one Godot process, not two. validate_batch
    // with a single target does the parse validation and runs the checks
    // against one instantiated scene; the plain scenePath spelling of the same
    // call used to cost a second process that loaded the scene again. The
    // response shape is unchanged: the batch payload is unwrapped back into
    // { valid, errors } below.
    const combined = hasChecks && resolvedScenePath !== undefined;

    // Render findings computed server-side before/alongside the GDScript
    // batch, merged into checkErrors after the batch payload is parsed.
    let pendingRenderErrors: CheckError[] = [];

    let stdout: string;
    let stderr: string;
    if (combined) {
      const checkFailure = validateCheckItems(checksRaw);
      if (checkFailure) {
        return err(createErrorResponse(checkFailure.message, checkFailure.solutions));
      }
      // Render checks execute server-side (the headless validate process has
      // no drawable surface), so they are split out before the GDScript batch
      // runs. Structure/signals checks still travel to validate_batch.
      const renderErrors = await executeRenderChecks(
        runner,
        projectPath,
        Array.isArray(checksRaw) ? checksRaw : [],
        resolvedScenePath,
      );
      const gdChecks = Array.isArray(checksRaw)
        ? (checksRaw as Array<{ type?: string }>).filter((c) => c.type !== 'render')
        : [];
      if (gdChecks.length === 0 && renderErrors.length === 0) {
        // Only render checks, and all passed — no GDScript process needed.
        return ok({
          content: [{ type: 'text', text: JSON.stringify({ valid: true, errors: [] }, null, 2) }],
        });
      }
      if (gdChecks.length === 0) {
        // Only render checks, at least one failed — report without spawning Godot.
        return ok({
          content: [
            {
              type: 'text',
              text: JSON.stringify({ valid: false, errors: renderErrors }, null, 2),
            },
          ],
        });
      }
      // Check items travel camelCase and untouched for the same reason the
      // batch branch forwards them raw: the runner's convertCamelToSnakeCase
      // rewrites nodePath and every nested hasProperty on the way out.
      ({ stdout, stderr } = await executeValidateOp(
        runner,
        'validate_batch',
        { targets: [{ scene_path: resolvedScenePath, checks: gdChecks }] },
        projectPath,
      ));
      if (renderErrors.length > 0) {
        // Deferred merge below handles the combined result; stash for it.
        pendingRenderErrors = renderErrors;
      }
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
      let batchParsed: {
        results?: Array<{
          valid?: boolean;
          errors?: ValidationError[];
          checkErrors?: CheckError[];
        }>;
      };
      try {
        batchParsed = JSON.parse(stdout.trim());
      } catch {
        batchParsed = {};
      }
      const target = batchParsed.results?.[0];
      if (!target) {
        return err(
          createErrorResponse(`Invalid response from validate_batch: ${stdout}`, [
            'Ensure Godot is installed correctly',
          ]),
        );
      }
      valid = target.valid === true;
      if (Array.isArray(target.errors) && target.errors.length > 0) gdErrors = target.errors;
      if (Array.isArray(target.checkErrors)) checkErrors = target.checkErrors;
    } else {
      try {
        const parsed = JSON.parse(stdout.trim());
        valid = parsed.valid === true;
        if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
          gdErrors = parsed.errors;
        }
      } catch {
        // stdout wasn't JSON - treat as invalid
        valid = false;
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
    // Render findings computed server-side merge through the same channel.
    const allCheckErrors = [...checkErrors, ...pendingRenderErrors];
    if (allCheckErrors.length > 0) {
      result = {
        valid: false,
        errors: [...result.errors, ...allCheckErrors],
      };
    }

    return ok({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
  } catch (error: unknown) {
    return err(
      createErrorResponse(`Validation failed: ${getErrorMessage(error)}`, [
        'Ensure Godot is installed correctly',
        'Check if the GODOT_PATH environment variable is set correctly',
      ]),
    );
  } finally {
    if (tempFile && resolvedScriptPath) {
      const tempFilePath = join(projectPath, resolvedScriptPath);
      try {
        unlinkSync(tempFilePath);
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
  const node = schema as { type?: unknown; children?: unknown; hasProperty?: unknown };
  if (node.type === undefined && node.children === undefined && node.hasProperty === undefined) {
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
    if (t !== 'structure' && t !== 'signals' && t !== 'render') {
      return {
        message: `Invalid check type: ${String(t)} (expected "structure", "signals", or "render")`,
        solutions: [
          'Supported types: "structure" (with schema), "signals" (optional nodePath), and "render" (mechanical viewport-content verification)',
        ],
      };
    }
    if (t === 'render') {
      const item = check as { frames?: unknown; minChromatic?: unknown; maxDominant?: unknown };
      if (
        item.frames !== undefined &&
        (!Number.isInteger(item.frames) || (item.frames as number) < 1)
      ) {
        return {
          message: 'Invalid render check: frames must be a positive integer',
          solutions: ['Example: { "type": "render", "frames": 20 }'],
        };
      }
      if (
        (item.minChromatic !== undefined && !(typeof item.minChromatic === 'number')) ||
        (item.maxDominant !== undefined && !(typeof item.maxDominant === 'number'))
      ) {
        return {
          message: 'Invalid render check: minChromatic and maxDominant must be numbers',
          solutions: ['Example: { "type": "render", "minChromatic": 0.005 }'],
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

/**
 * Execute render checks for one target server-side. Returns an array of
 * CheckError entries (empty when all pass). The render check runs the
 * project briefly under the movie writer with the real renderer and
 * evaluates pixel statistics, so it cannot ride the headless
 * validate_batch process.
 */
async function executeRenderChecks(
  runner: GodotRunner,
  projectPath: string,
  checks: Array<{ type?: string; frames?: number; minChromatic?: number; maxDominant?: number }>,
  scenePath: string | undefined,
): Promise<CheckError[]> {
  const errors: CheckError[] = [];
  const godotPath = runner.getGodotPath();
  if (!godotPath) {
    errors.push({
      check: 'render',
      message: 'Cannot run render check: Godot executable path not found',
    });
    return errors;
  }

  for (const check of checks) {
    if (check.type !== 'render') continue;

    try {
      const opts: { frames?: number; minChromatic?: number; maxDominant?: number } = {};
      if (check.frames !== undefined) opts.frames = check.frames;
      if (check.minChromatic !== undefined) opts.minChromatic = check.minChromatic;
      if (check.maxDominant !== undefined) opts.maxDominant = check.maxDominant;
      const result = await runRenderCheck(godotPath, projectPath, scenePath, opts);
      if (!result.ok) {
        errors.push({
          check: 'render',
          message: result.message,
          chromatic: result.stats?.chromatic,
          dominant: result.stats?.dominant,
          distinct: result.stats?.distinct,
        });
      }
    } catch (e: unknown) {
      errors.push({
        check: 'render',
        message: `Render check failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  return errors;
}
