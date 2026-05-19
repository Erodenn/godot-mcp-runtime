import { join } from 'path';
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import type { GodotRunner } from '../utils/godot-runner.js';
import type { OperationParams, ToolDefinition } from '../mcp.types.js';
import { normalizeParameters } from '../utils/parameter-conversion.js';
import { validateSubPath } from '../utils/path-validation.js';
import {
  validateProjectArgs,
  createErrorResponse,
  extractGdError,
  getErrorMessage,
} from '../utils/error-response.js';

export const validateToolDefinitions: ToolDefinition[] = [
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
];

interface ValidationError {
  line?: number;
  message: string;
}

interface ParsedErrorEntry {
  message: string;
  line?: number;
  filePath?: string;
}

/**
 * Core Godot stderr parser. Returns a flat list of error entries, each with an
 * optional line number and optional res:// file path (from the "at:" line).
 */
function parseGodotErrorEntries(stderr: string): ParsedErrorEntry[] {
  const entries: ParsedErrorEntry[] = [];
  if (!stderr) return entries;

  const lines = stderr.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;

    // Pattern: "SCRIPT ERROR: Parse Error: MESSAGE" or "ERROR: MESSAGE"
    // followed by "   at: res://...:LINE" or "   at: ...:LINE"
    const scriptErrorMatch = line.match(/SCRIPT ERROR:\s*(?:Parse Error:\s*)?(.+)/);
    const errorMatch = !scriptErrorMatch ? line.match(/^ERROR:\s*(.+)/) : null;
    const match = scriptErrorMatch || errorMatch;

    if (match) {
      const [, rawMessage = ''] = match;
      const message = rawMessage.trim();
      let lineNum: number | undefined;
      let filePath: string | undefined;

      const next = lines[i + 1];
      if (next !== undefined) {
        // Try res:// path first (captures file + line). Tolerates an optional
        // "<method> (" prefix before res:// so we catch both
        //   "   at: res://foo.gd:3"
        // and
        //   "   at: GDScript::reload (res://foo.gd:3)"
        // Real Godot 4.5 stderr uses the parenthesized form.
        const resAtMatch = next.match(/\s*at:\s*(?:[^()\n]*\()?(res:\/\/[^):"\s]+):(\d+)/);
        if (resAtMatch) {
          const [, path = '', lineStr = '0'] = resAtMatch;
          filePath = path;
          lineNum = parseInt(lineStr, 10);
          i++;
        } else {
          // Fall back to loose match (line only, e.g. native code "at:" lines)
          const looseAtMatch = next.match(/\s*at:\s*.+:(\d+)/);
          if (looseAtMatch) {
            lineNum = parseInt(looseAtMatch[1] ?? '0', 10);
            i++;
          }
        }
      }

      // Parse-error entries reference synthetic gdscript:// URIs in their `at:` line
      // rather than a res:// path. Peek forward up to 10 lines for the secondary
      // "Failed to load script/resource: \"res://...\"" message that names the file,
      // and adopt that path so batch error attribution can find it. The window is
      // intentionally wide enough to clear a full GDScript backtrace.
      if (!filePath && /Parse Error/i.test(line)) {
        const lookaheadLimit = Math.min(i + 11, lines.length);
        for (let j = i + 1; j < lookaheadLimit; j++) {
          const lookLine = lines[j];
          if (lookLine === undefined) continue;
          const failMatch = lookLine.match(
            /Failed to load (?:script|resource):?\s*"?(res:\/\/[^":\s]+)/,
          );
          if (failMatch) {
            filePath = failMatch[1];
            break;
          }
        }
      }

      const entry: ParsedErrorEntry = { message };
      if (lineNum !== undefined) entry.line = lineNum;
      if (filePath !== undefined) entry.filePath = filePath;
      entries.push(entry);
      continue;
    }

    // Pattern: "Parse Error: MESSAGE at line LINE"
    const parseErrorMatch = line.match(/Parse Error:\s*(.+?)\s+at line\s+(\d+)/);
    if (parseErrorMatch) {
      const [, parseMsg = '', parseLine = '0'] = parseErrorMatch;
      entries.push({
        line: parseInt(parseLine, 10),
        message: parseMsg.trim(),
      });
    }
  }

  return entries;
}

function parseGodotErrors(stderr: string): ValidationError[] {
  return parseGodotErrorEntries(stderr).map(({ message, line }) => {
    const err: ValidationError = { message };
    if (line !== undefined) err.line = line;
    return err;
  });
}

/**
 * Write inline GDScript source to a uniquely-named file under <projectPath>/.mcp/
 * for validation. Returns the project-relative path (e.g. ".mcp/validate_temp_xxx.gd")
 * that the runner consumes plus the absolute path the caller cleans up.
 */
function writeTempGdScript(
  projectPath: string,
  source: string,
  prefix: 'validate_temp' | 'validate_batch',
): { resPath: string; absPath: string } {
  const mcpDir = join(projectPath, '.mcp');
  mkdirSync(mcpDir, { recursive: true });
  const name = `${prefix}_${randomUUID()}.gd`;
  const absPath = join(mcpDir, name);
  writeFileSync(absPath, source, 'utf8');
  return { resPath: `.mcp/${name}`, absPath };
}

/**
 * Group Godot stderr errors by their res:// file path.
 * Used for batch validation where multiple files produce output in one stderr stream.
 */
function parseGodotErrorsByPath(stderr: string): Map<string, ValidationError[]> {
  const result = new Map<string, ValidationError[]>();
  for (const { message, line, filePath } of parseGodotErrorEntries(stderr)) {
    if (filePath) {
      if (!result.has(filePath)) result.set(filePath, []);
      const err: ValidationError = { message };
      if (line !== undefined) err.line = line;
      result.get(filePath)!.push(err);
    }
  }
  return result;
}

export async function handleValidate(runner: GodotRunner, args: OperationParams) {
  args = normalizeParameters(args);

  const pv = validateProjectArgs(args);
  if ('isError' in pv) return pv;

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
          const { resPath, absPath } = writeTempGdScript(
            pv.projectPath,
            t.source,
            'validate_batch',
          );
          tempFiles.push(absPath);
          snakeTargets.push({ script_path: resPath });
        } else if (t.scriptPath) {
          if (!validateSubPath(pv.projectPath, t.scriptPath)) {
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
          if (!validateSubPath(pv.projectPath, t.scenePath)) {
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
        return { content: [{ type: 'text', text: JSON.stringify({ results }, null, 2) }] };
      }

      const { stdout, stderr } = await runner.executeOperation(
        'validate_batch',
        { targets: snakeTargets },
        pv.projectPath,
      );

      if (!stdout.trim()) {
        return createErrorResponse(`Batch validate failed: ${extractGdError(stderr)}`, [
          'Check that all target paths are valid',
          'Ensure Godot is installed correctly',
        ]);
      }

      let parsed: { results: Array<{ target: string; valid: boolean; errors: ValidationError[] }> };
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        return createErrorResponse(`Invalid response from validate_batch: ${stdout}`, [
          'Ensure Godot is installed correctly',
        ]);
      }

      const errorsByPath = parseGodotErrorsByPath(stderr || '');

      const godotResults = parsed.results.map((r) => {
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

      return { content: [{ type: 'text', text: JSON.stringify({ results }, null, 2) }] };
    } catch (error: unknown) {
      return createErrorResponse(`Batch validation failed: ${getErrorMessage(error)}`, [
        'Ensure Godot is installed correctly',
        'Check if the GODOT_PATH environment variable is set correctly',
      ]);
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

  // Determine mode — exactly one must be provided
  const modeCount = [args.scriptPath, args.source, args.scenePath].filter(Boolean).length;
  if (modeCount === 0) {
    return createErrorResponse('One of scriptPath, source, or scenePath is required', [
      'Provide scriptPath to validate an existing .gd file, source to validate inline GDScript, or scenePath to validate a .tscn file',
    ]);
  }
  if (modeCount > 1) {
    return createErrorResponse(
      'Provide exactly one of scriptPath, source, or scenePath — not multiple',
      ['Only one target can be validated per call'],
    );
  }

  let tempFile = false;
  let resolvedScriptPath: string | undefined;
  let resolvedScenePath: string | undefined;

  try {
    if (args.source) {
      const { resPath } = writeTempGdScript(pv.projectPath, args.source as string, 'validate_temp');
      resolvedScriptPath = resPath;
      tempFile = true;
    } else if (args.scriptPath) {
      if (!validateSubPath(pv.projectPath, args.scriptPath as string)) {
        return createErrorResponse('Invalid scriptPath', [
          'Provide a valid relative path without ".." that stays inside the project directory',
        ]);
      }
      const fullPath = join(pv.projectPath, args.scriptPath as string);
      if (!existsSync(fullPath)) {
        return createErrorResponse(`Script file does not exist: ${args.scriptPath}`, [
          'Ensure the path is correct relative to the project directory',
        ]);
      }
      resolvedScriptPath = args.scriptPath as string;
    } else if (args.scenePath) {
      if (!validateSubPath(pv.projectPath, args.scenePath as string)) {
        return createErrorResponse('Invalid scenePath', [
          'Provide a valid relative path without ".." that stays inside the project directory',
        ]);
      }
      const fullPath = join(pv.projectPath, args.scenePath as string);
      if (!existsSync(fullPath)) {
        return createErrorResponse(`Scene file does not exist: ${args.scenePath}`, [
          'Ensure the path is correct relative to the project directory',
        ]);
      }
      resolvedScenePath = args.scenePath as string;
    }

    const params: OperationParams = {};
    if (resolvedScriptPath) params.scriptPath = resolvedScriptPath;
    if (resolvedScenePath) params.scenePath = resolvedScenePath;

    const { stdout, stderr } = await runner.executeOperation(
      'validate_resource',
      params,
      pv.projectPath,
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

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (error: unknown) {
    return createErrorResponse(`Validation failed: ${getErrorMessage(error)}`, [
      'Ensure Godot is installed correctly',
      'Check if the GODOT_PATH environment variable is set correctly',
    ]);
  } finally {
    if (tempFile && resolvedScriptPath) {
      const tempFilePath = join(pv.projectPath, resolvedScriptPath);
      try {
        unlinkSync(tempFilePath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}
