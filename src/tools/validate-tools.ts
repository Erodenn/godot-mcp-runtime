import { join } from 'path';
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import type { GodotRunner } from '../utils/godot-runner.js';
import type { HandlerResult, OperationParams, ToolDefinition, ToolResponse } from '../mcp.types.js';
import { normalizeParameters } from '../utils/parameter-conversion.js';
import { validateSubPath } from '../utils/path-validation.js';
import { createErrorResponse, extractGdError, getErrorMessage } from '../utils/error-response.js';
import { parseProjectArgs, optionalString } from '../utils/arg-parsing.js';
import { parseScriptDiagnostics } from '../utils/output-parsing.js';
import { ok, err } from '../utils/result.js';
import type { Result } from '../utils/result.js';
import { VALIDATE_RES_DIR, validateTempDir } from '../utils/artifact-paths.js';
import { IMPORT_NEEDED_MARKER } from '../utils/headless-op.js';

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

export const validateToolDefinitions = [
  {
    name: 'validate',
    description:
      'Validate GDScript syntax or scene integrity using headless Godot. Use before attach_script or run_script to catch parse errors early. Give exactly one of scriptPath, source, or scenePath, or a targets array validated in one Godot process. Returns { valid, errors } for one target, { results: [{ target, valid, errors }] } for a batch. An errors entry is { line?, message } for a parse error, or { check, problem?, message } for a checks[] finding. Any parse error yields valid:false; never throws.',
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
            '[single, requires scenePath] Structural and signal-verification checks to run against the scene. Types: "structure" (validate node tree against a schema) and "signals" (verify signal connections and handler methods, optional nodePath scope). Merged into the errors array with a "check" discriminator.',
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

    const params: OperationParams = {};
    if (resolvedScriptPath) params.scriptPath = resolvedScriptPath;
    if (resolvedScenePath) params.scenePath = resolvedScenePath;

    const { stdout, stderr } = await runner.executeOperation(
      'validate_resource',
      params,
      projectPath,
    );

    // Parse stdout for the base valid/invalid signal from GDScript
    let valid = false;
    let gdErrors: ValidationError[] = [];
    try {
      const parsed = JSON.parse(stdout.trim());
      valid = parsed.valid === true;
      if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
        gdErrors = parsed.errors;
      }
    } catch {
      // stdout wasn't JSON — treat as invalid
      valid = false;
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
    if (hasChecks && resolvedScenePath) {
      const checkErrors = await runSceneChecks(runner, projectPath, resolvedScenePath, checksRaw);
      if (!checkErrors.ok) return err(checkErrors.error);
      if (checkErrors.value.length > 0) {
        result = {
          valid: false,
          errors: [...result.errors, ...checkErrors.value],
        };
      }
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

/**
 * Validate one structure schema node and its children[] recursively, returning
 * the error response to surface or null when the node is well formed. The
 * GDScript side hedges too, but rejecting here keeps the diagnosis specific: a
 * bad nested entry otherwise surfaces as a generic "Scene checks failed" with
 * nothing naming the offending part. `path` is a caller-facing breadcrumb like
 * "schema.children[0]".
 */
function validateSchemaNode(schema: unknown, path: string): ToolResponse | null {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return createErrorResponse(
      `Invalid schema at ${path}: must be an object like { type?, children?, hasProperty? }`,
      [SCHEMA_EXAMPLE_SOLUTION],
    );
  }
  const node = schema as { type?: unknown; children?: unknown; hasProperty?: unknown };
  if (node.type === undefined && node.children === undefined && node.hasProperty === undefined) {
    return createErrorResponse(
      `Invalid schema at ${path}: at least one of type, children, or hasProperty is required`,
      [SCHEMA_EXAMPLE_SOLUTION],
    );
  }
  if (node.children !== undefined) {
    if (!Array.isArray(node.children)) {
      return createErrorResponse(`Invalid schema at ${path}: children must be an array`, [
        SCHEMA_EXAMPLE_SOLUTION,
      ]);
    }
    for (const [i, child] of node.children.entries()) {
      const childError = validateSchemaNode(child, `${path}.children[${i}]`);
      if (childError) return childError;
    }
  }
  return null;
}

/**
 * Run structural / signal-verification checks against one scene via the
 * validate_checks GDScript op. Used by handleValidate when the caller passes
 * a checks[] array alongside scenePath (single mode) or inside a targets[]
 * item (batch mode). Returns either check-attributed errors to merge into
 * the caller's error list, or a HandlerResult failure to return directly.
 */
async function runSceneChecks(
  runner: GodotRunner,
  projectPath: string,
  scenePath: string,
  checks: unknown,
): Promise<Result<CheckError[], ToolResponse>> {
  if (!Array.isArray(checks)) {
    return err(
      createErrorResponse(
        'Invalid checks: must be an array of { type: "structure" | "signals", ... }',
        [
          'Example: { "scenePath": "main.tscn", "checks": [{ "type": "structure", "schema": { "type": "Node2D" } }] }',
        ],
      ),
    );
  }
  for (const check of checks) {
    if (typeof check !== 'object' || check === null) {
      return err(
        createErrorResponse('Invalid checks: each item must be an object', [
          'Example: { "type": "signals", "nodePath": "root/HUD" }',
        ]),
      );
    }
    const t = (check as { type?: unknown }).type;
    if (t !== 'structure' && t !== 'signals') {
      return err(
        createErrorResponse(
          `Invalid check type: ${String(t)} (expected "structure" or "signals")`,
          ['Supported types: "structure" (with schema) and "signals" (optional nodePath)'],
        ),
      );
    }
    if (t === 'structure') {
      const schemaError = validateSchemaNode((check as { schema?: unknown }).schema, 'schema');
      if (schemaError) return err(schemaError);
    }
  }

  try {
    const opParams: OperationParams = { scene_path: scenePath, checks };
    const { stdout, stderr } = await executeValidateOp(
      runner,
      'validate_checks',
      opParams,
      projectPath,
    );
    if (!stdout.trim()) {
      return err(
        createErrorResponse(`Scene checks failed: ${extractGdError(stderr)}`, [
          'Check if the scene path is correct',
          'Ensure the schema follows the documented shape',
        ]),
      );
    }
    let parsed: { valid?: boolean; errors?: unknown[] };
    try {
      parsed = JSON.parse(stdout.trim());
    } catch {
      return err(
        createErrorResponse(`Invalid response from validate_checks: ${stdout}`, [
          'Ensure Godot is installed correctly',
        ]),
      );
    }
    const errors = Array.isArray(parsed.errors) ? (parsed.errors as CheckError[]) : [];
    return ok(errors);
  } catch (error: unknown) {
    return err(
      createErrorResponse(`Scene checks failed: ${getErrorMessage(error)}`, [
        'Ensure Godot is installed correctly',
        'Check if the GODOT_PATH environment variable is set correctly',
      ]),
    );
  }
}
