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

export const validateToolDefinitions = [
  {
    name: 'validate',
    description:
      "Validate GDScript syntax or scene file integrity using headless Godot. Use before attach_script or run_script to catch parse errors early. Single-target: provide exactly one of scriptPath, source, or scenePath. Batch: provide a targets array — runs all in one Godot process. Returns { valid, errors: [{ line?, message }] } for single, or { results: [{ target, valid, errors }] } for batch. Line numbers appear when Godot's stderr includes them (not always). Returns valid:false on any parse error; never throws.",
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
                description: 'Path to a .tscn file relative to the project',
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
    }>;
    const tempFiles: string[] = [];

    try {
      const snakeTargets: Array<{ script_path?: string; scene_path?: string }> = [];
      const preErrors = new Map<number, { target: string; errors: ValidationError[] }>();

      for (const [i, t] of targets.entries()) {
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
            snakeTargets.push({ scene_path: t.scenePath });
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

      const { stdout, stderr } = await runner.executeOperation(
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
        results: Array<{ target: string; valid: boolean; errors: ValidationError[] }>;
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

      const godotResults = batchParsed.results.map((r) => {
        const key = r.target.startsWith('res://') ? r.target : `res://${r.target}`;
        const stderrErrors = errorsByPath.get(key) || errorsByPath.get(r.target) || [];
        const allErrors: ValidationError[] =
          stderrErrors.length > 0 ? stderrErrors : r.errors || [];
        return {
          target: r.target,
          valid: r.valid && stderrErrors.length === 0,
          errors: allErrors,
        };
      });

      // Merge pre-validation failures back into their original positions so
      // output order matches input order. Pre-validation errors are ours, not
      // Godot's — they bypass the stderr overlay above.
      const results: Array<{ target: string; valid: boolean; errors: ValidationError[] }> = [];
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

  const modeCount = [scriptPathResult.value, sourceResult.value, scenePathResult.value].filter(
    Boolean,
  ).length;
  if (modeCount === 0) {
    return err(
      createErrorResponse('One of scriptPath, source, or scenePath is required', [
        'Provide scriptPath to validate an existing .gd file, source to validate inline GDScript, or scenePath to validate a .tscn file',
      ]),
    );
  }
  if (modeCount > 1) {
    return err(
      createErrorResponse(
        'Provide exactly one of scriptPath, source, or scenePath — not multiple',
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
    const result = {
      valid: valid && allErrors.length === 0,
      errors: allErrors,
    };

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
