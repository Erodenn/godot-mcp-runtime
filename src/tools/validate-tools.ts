import { join } from 'path';
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import {
  GodotRunner,
  normalizeParameters,
  validatePath,
  createErrorResponse,
  OperationParams,
  ToolDefinition,
} from '../utils/godot-runner.js';

export const validateToolDefinitions: ToolDefinition[] = [
  {
    name: 'validate',
    description: 'Validate GDScript syntax or scene file integrity using headless Godot. Returns { valid, errors: [{ line?, message }] } — line numbers are present when Godot\'s error output includes them, which is not always the case. If valid is false, fix the reported errors and re-validate before calling attach_script or run_script.\n\nProvide exactly one of: scriptPath (path to an existing .gd file), source (inline GDScript written to a temp file and validated), or scenePath (path to a .tscn file — validates that all ext_resource references resolve).',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Path to the Godot project directory',
        },
        scriptPath: {
          type: 'string',
          description: 'Path to a .gd file relative to the project to validate (e.g. "scripts/player.gd")',
        },
        source: {
          type: 'string',
          description: 'Inline GDScript source code to validate. Written to a temporary file and validated against the project.',
        },
        scenePath: {
          type: 'string',
          description: 'Path to a .tscn scene file relative to the project to validate (e.g. "scenes/main.tscn")',
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

/**
 * Parse Godot stderr output for structured error information.
 * Godot emits parse errors to stderr when load() fails on a script.
 */
function parseGodotErrors(stderr: string): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!stderr) return errors;

  const lines = stderr.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Pattern: "SCRIPT ERROR: Parse Error: MESSAGE"
    // followed by "   at: res://...:LINE"
    const scriptErrorMatch = line.match(/SCRIPT ERROR:\s*(?:Parse Error:\s*)?(.+)/);
    if (scriptErrorMatch) {
      const message = scriptErrorMatch[1].trim();
      let lineNum: number | undefined;
      // Look ahead for the "at:" line
      if (i + 1 < lines.length) {
        const atMatch = lines[i + 1].match(/\s*at:\s*.+:(\d+)/);
        if (atMatch) {
          lineNum = parseInt(atMatch[1], 10);
          i++; // consume the "at:" line
        }
      }
      errors.push({ line: lineNum, message });
      continue;
    }

    // Pattern: "ERROR: ...\n   at: res://...:LINE"
    const errorMatch = line.match(/^ERROR:\s*(.+)/);
    if (errorMatch) {
      const message = errorMatch[1].trim();
      let lineNum: number | undefined;
      if (i + 1 < lines.length) {
        const atMatch = lines[i + 1].match(/\s*at:\s*.+:(\d+)/);
        if (atMatch) {
          lineNum = parseInt(atMatch[1], 10);
          i++;
        }
      }
      errors.push({ line: lineNum, message });
      continue;
    }

    // Pattern: "Parse Error: MESSAGE at line LINE"
    const parseErrorMatch = line.match(/Parse Error:\s*(.+?)\s+at line\s+(\d+)/);
    if (parseErrorMatch) {
      errors.push({
        line: parseInt(parseErrorMatch[2], 10),
        message: parseErrorMatch[1].trim(),
      });
    }
  }

  return errors;
}

export async function handleValidate(runner: GodotRunner, args: OperationParams) {
  args = normalizeParameters(args);

  if (!args.projectPath) {
    return createErrorResponse('projectPath is required', ['Provide the path to a Godot project directory']);
  }

  if (!validatePath(args.projectPath as string)) {
    return createErrorResponse('Invalid projectPath', ['Provide a valid path without ".."']);
  }

  const projectFile = join(args.projectPath as string, 'project.godot');
  if (!existsSync(projectFile)) {
    return createErrorResponse(
      `Not a valid Godot project: ${args.projectPath}`,
      ['Ensure the path points to a directory containing a project.godot file']
    );
  }

  // Determine mode — exactly one must be provided
  const modeCount = [args.scriptPath, args.source, args.scenePath].filter(Boolean).length;
  if (modeCount === 0) {
    return createErrorResponse(
      'One of scriptPath, source, or scenePath is required',
      ['Provide scriptPath to validate an existing .gd file, source to validate inline GDScript, or scenePath to validate a .tscn file']
    );
  }
  if (modeCount > 1) {
    return createErrorResponse(
      'Provide exactly one of scriptPath, source, or scenePath — not multiple',
      ['Only one target can be validated per call']
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
        return createErrorResponse(
          `Script file does not exist: ${args.scriptPath}`,
          ['Ensure the path is correct relative to the project directory']
        );
      }
      resolvedScriptPath = args.scriptPath as string;
    } else if (args.scenePath) {
      if (!validatePath(args.scenePath as string)) {
        return createErrorResponse('Invalid scenePath', ['Provide a valid path without ".."']);
      }
      const fullPath = join(args.projectPath as string, args.scenePath as string);
      if (!existsSync(fullPath)) {
        return createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          ['Ensure the path is correct relative to the project directory']
        );
      }
      resolvedScenePath = args.scenePath as string;
    }

    const params: OperationParams = {};
    if (resolvedScriptPath) params.scriptPath = resolvedScriptPath;
    if (resolvedScenePath) params.scenePath = resolvedScenePath;

    const { stdout, stderr } = await runner.executeOperation('validate_resource', params, args.projectPath as string);

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
    return createErrorResponse(
      `Validation failed: ${errorMessage}`,
      ['Ensure Godot is installed correctly', 'Check if the GODOT_PATH environment variable is set correctly']
    );
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
