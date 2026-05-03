import { join } from 'path';
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import type { GodotRunner, OperationParams, ToolDefinition } from '../utils/godot-runner.js';
import {
  normalizeParameters,
  validatePath,
  createErrorResponse,
  extractGdError,
} from '../utils/godot-runner.js';

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

    // Pattern: "SCRIPT ERROR: Parse Error: MESSAGE" or "ERROR: MESSAGE"
    // followed by "   at: res://...:LINE" or "   at: ...:LINE"
    const scriptErrorMatch = line.match(/SCRIPT ERROR:\s*(?:Parse Error:\s*)?(.+)/);
    const errorMatch = !scriptErrorMatch ? line.match(/^ERROR:\s*(.+)/) : null;
    const match = scriptErrorMatch || errorMatch;

    if (match) {
      const message = match[1].trim();
      let lineNum: number | undefined;
      let filePath: string | undefined;

      if (i + 1 < lines.length) {
        // Try res:// path first (captures file + line)
        const resAtMatch = lines[i + 1].match(/\s*at:\s*(res:\/\/[^:]+):(\d+)/);
        if (resAtMatch) {
          filePath = resAtMatch[1];
          lineNum = parseInt(resAtMatch[2], 10);
          i++;
        } else {
          // Fall back to loose match (line only, e.g. native code "at:" lines)
          const looseAtMatch = lines[i + 1].match(/\s*at:\s*.+:(\d+)/);
          if (looseAtMatch) {
            lineNum = parseInt(looseAtMatch[1], 10);
            i++;
          }
        }
      }

      entries.push({ message, line: lineNum, filePath });
      continue;
    }

    // Pattern: "Parse Error: MESSAGE at line LINE"
    const parseErrorMatch = line.match(/Parse Error:\s*(.+?)\s+at line\s+(\d+)/);
    if (parseErrorMatch) {
      entries.push({
        line: parseInt(parseErrorMatch[2], 10),
        message: parseErrorMatch[1].trim(),
      });
    }
  }

  return entries;
}

function parseGodotErrors(stderr: string): ValidationError[] {
  return parseGodotErrorEntries(stderr).map(({ message, line }) => ({ message, line }));
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
      result.get(filePath)!.push({ line, message });
    }
  }
  return result;
}

export async function handleValidate(runner: GodotRunner, args: OperationParams) {
  args = normalizeParameters(args);

  if (!args.projectPath) {
    return createErrorResponse('projectPath is required', [
      'Provide the path to a Godot project directory',
    ]);
  }

  if (!validatePath(args.projectPath as string)) {
    return createErrorResponse('Invalid projectPath', ['Provide a valid path without ".."']);
  }

  const projectFile = join(args.projectPath as string, 'project.godot');
  if (!existsSync(projectFile)) {
    return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`, [
      'Ensure the path points to a directory containing a project.godot file',
    ]);
  }

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

      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        if (t.source) {
          const mcpDir = join(args.projectPath as string, '.mcp');
          if (!existsSync(mcpDir)) mkdirSync(mcpDir, { recursive: true });
          const tempName = `validate_batch_${randomUUID()}.gd`;
          const tempPath = join(mcpDir, tempName);
          writeFileSync(tempPath, t.source, 'utf8');
          tempFiles.push(tempPath);
          snakeTargets.push({ script_path: `.mcp/${tempName}` });
        } else if (t.scriptPath) {
          snakeTargets.push({ script_path: t.scriptPath });
        } else if (t.scenePath) {
          snakeTargets.push({ scene_path: t.scenePath });
        } else {
          snakeTargets.push({});
        }
      }

      const { stdout, stderr } = await runner.executeOperation(
        'validate_batch',
        { targets: snakeTargets },
        args.projectPath as string,
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

      const results = parsed.results.map((r) => {
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

      return { content: [{ type: 'text', text: JSON.stringify({ results }, null, 2) }] };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return createErrorResponse(`Batch validation failed: ${errorMessage}`, [
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
      // Write inline source to a temp file inside .mcp/
      const mcpDir = join(args.projectPath as string, '.mcp');
      if (!existsSync(mcpDir)) {
        mkdirSync(mcpDir, { recursive: true });
      }
      const tempFileName = `validate_temp_${Date.now()}.gd`;
      const tempFilePath = join(mcpDir, tempFileName);
      writeFileSync(tempFilePath, args.source as string, 'utf8');
      resolvedScriptPath = `.mcp/${tempFileName}`;
      tempFile = true;
    } else if (args.scriptPath) {
      if (!validatePath(args.scriptPath as string)) {
        return createErrorResponse('Invalid scriptPath', ['Provide a valid path without ".."']);
      }
      const fullPath = join(args.projectPath as string, args.scriptPath as string);
      if (!existsSync(fullPath)) {
        return createErrorResponse(`Script file does not exist: ${args.scriptPath}`, [
          'Ensure the path is correct relative to the project directory',
        ]);
      }
      resolvedScriptPath = args.scriptPath as string;
    } else if (args.scenePath) {
      if (!validatePath(args.scenePath as string)) {
        return createErrorResponse('Invalid scenePath', ['Provide a valid path without ".."']);
      }
      const fullPath = join(args.projectPath as string, args.scenePath as string);
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
      args.projectPath as string,
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

    const result = {
      valid,
      errors: allErrors,
    };

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Validation failed: ${errorMessage}`, [
      'Ensure Godot is installed correctly',
      'Check if the GODOT_PATH environment variable is set correctly',
    ]);
  } finally {
    if (tempFile && resolvedScriptPath) {
      const tempFilePath = join(args.projectPath as string, resolvedScriptPath);
      try {
        unlinkSync(tempFilePath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}
