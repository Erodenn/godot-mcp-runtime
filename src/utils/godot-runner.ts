import { fileURLToPath } from 'url';
import { join, dirname, normalize } from 'path';
import { existsSync, readFileSync, writeFileSync, copyFileSync, unlinkSync, mkdirSync } from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { createSocket } from 'dgram';

// Derive __filename and __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Debug mode from environment
const DEBUG_MODE = process.env.DEBUG === 'true';

/**
 * Extract JSON from Godot output by finding the first { or [ and matching to the end.
 * This strips debug logs, version banners, and other noise.
 */
function extractJson(output: string): string {
  // Find the first occurrence of { or [
  const jsonStartBrace = output.indexOf('{');
  const jsonStartBracket = output.indexOf('[');

  let jsonStart = -1;
  if (jsonStartBrace === -1 && jsonStartBracket === -1) {
    return output; // No JSON found, return as-is
  } else if (jsonStartBrace === -1) {
    jsonStart = jsonStartBracket;
  } else if (jsonStartBracket === -1) {
    jsonStart = jsonStartBrace;
  } else {
    jsonStart = Math.min(jsonStartBrace, jsonStartBracket);
  }

  // Extract from JSON start to end
  const jsonPart = output.substring(jsonStart);

  // Try to parse to validate, if it fails return original
  try {
    JSON.parse(jsonPart.trim());
    return jsonPart.trim();
  } catch {
    // If the extracted part isn't valid JSON, try to find the last } or ]
    const lastBrace = jsonPart.lastIndexOf('}');
    const lastBracket = jsonPart.lastIndexOf(']');
    const lastEnd = Math.max(lastBrace, lastBracket);

    if (lastEnd > 0) {
      const extracted = jsonPart.substring(0, lastEnd + 1);
      try {
        JSON.parse(extracted);
        return extracted;
      } catch {
        return output; // Return original if still can't parse
      }
    }
    return output;
  }
}

/**
 * Strip Godot banner and debug lines from output, keeping only meaningful content.
 */
function cleanOutput(output: string): string {
  const lines = output.split('\n');
  const cleanedLines = lines.filter(line => {
    const trimmed = line.trim();
    // Skip empty lines
    if (!trimmed) return false;
    // Skip Godot version banner
    if (trimmed.startsWith('Godot Engine v')) return false;
    // Skip debug lines
    if (trimmed.startsWith('[DEBUG]')) return false;
    // Skip info lines that are just status updates
    if (trimmed.startsWith('[INFO] Operation:')) return false;
    if (trimmed.startsWith('[INFO] Executing operation:')) return false;
    return true;
  });
  return cleanedLines.join('\n');
}

export interface GodotProcess {
  process: ChildProcess;
  output: string[];
  errors: string[];
  exitCode: number | null;
  hasExited: boolean;
}

export interface GodotServerConfig {
  godotPath?: string;
  debugMode?: boolean;
  strictPathValidation?: boolean;
}

export interface OperationParams {
  [key: string]: unknown;
}

export interface OperationResult {
  stdout: string;
  stderr: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, unknown>;
    required: string[];
  };
}

// Parameter mappings between snake_case and camelCase
const parameterMappings: Record<string, string> = {
  'project_path': 'projectPath',
  'scene_path': 'scenePath',
  'root_node_type': 'rootNodeType',
  'parent_node_path': 'parentNodePath',
  'node_type': 'nodeType',
  'node_name': 'nodeName',
  'texture_path': 'texturePath',
  'node_path': 'nodePath',
  'output_path': 'outputPath',
  'mesh_item_names': 'meshItemNames',
  'new_path': 'newPath',
  'file_path': 'filePath',
  'script_path': 'scriptPath',
};

// Reverse mapping from camelCase to snake_case
const reverseParameterMappings: Record<string, string> = {};
for (const [snakeCase, camelCase] of Object.entries(parameterMappings)) {
  reverseParameterMappings[camelCase] = snakeCase;
}

export function logDebug(message: string): void {
  if (DEBUG_MODE) {
    console.error(`[DEBUG] ${message}`);
  }
}

export function logError(message: string): void {
  console.error(`[SERVER] ${message}`);
}

export function normalizeParameters(params: OperationParams): OperationParams {
  if (!params || typeof params !== 'object') {
    return params;
  }

  const result: OperationParams = {};

  for (const key in params) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      let normalizedKey = key;

      if (key.includes('_') && parameterMappings[key]) {
        normalizedKey = parameterMappings[key];
      }

      const value = params[key];
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        result[normalizedKey] = normalizeParameters(value as OperationParams);
      } else {
        result[normalizedKey] = value;
      }
    }
  }

  return result;
}

export function convertCamelToSnakeCase(params: OperationParams): OperationParams {
  const result: OperationParams = {};

  for (const key in params) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      const snakeKey = reverseParameterMappings[key] || key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);

      const value = params[key];
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        result[snakeKey] = convertCamelToSnakeCase(value as OperationParams);
      } else {
        result[snakeKey] = value;
      }
    }
  }

  return result;
}

export function validatePath(path: string): boolean {
  if (!path || path.includes('..')) {
    return false;
  }
  return true;
}

export function createErrorResponse(message: string, possibleSolutions: string[] = []): {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
} {
  logError(`Error response: ${message}`);
  if (possibleSolutions.length > 0) {
    logError(`Possible solutions: ${possibleSolutions.join(', ')}`);
  }

  const response: {
    content: Array<{ type: 'text'; text: string }>;
    isError: boolean;
  } = {
    content: [{ type: 'text', text: message }],
    isError: true,
  };

  if (possibleSolutions.length > 0) {
    response.content.push({
      type: 'text',
      text: 'Possible solutions:\n- ' + possibleSolutions.join('\n- '),
    });
  }

  return response;
}

export class GodotRunner {
  private godotPath: string | null = null;
  private operationsScriptPath: string;
  private bridgeScriptPath: string;
  private validatedPaths: Map<string, boolean> = new Map();
  private injectedProjects: Set<string> = new Set();
  private strictPathValidation: boolean;
  public activeProcess: GodotProcess | null = null;
  public activeProjectPath: string | null = null;

  constructor(config?: GodotServerConfig) {
    this.strictPathValidation = config?.strictPathValidation ?? false;
    this.operationsScriptPath = join(__dirname, '..', 'scripts', 'godot_operations.gd');
    this.bridgeScriptPath = join(__dirname, '..', 'scripts', 'mcp_bridge.gd');
    logDebug(`Operations script path: ${this.operationsScriptPath}`);

    if (config?.godotPath) {
      const normalizedPath = normalize(config.godotPath);
      if (this.isValidGodotPathSync(normalizedPath)) {
        this.godotPath = normalizedPath;
        logDebug(`Custom Godot path provided: ${this.godotPath}`);
      } else {
        console.warn(`[SERVER] Invalid custom Godot path provided: ${normalizedPath}`);
      }
    }
  }

  private isValidGodotPathSync(path: string): boolean {
    try {
      logDebug(`Quick-validating Godot path: ${path}`);
      return path === 'godot' || existsSync(path);
    } catch {
      logDebug(`Invalid Godot path: ${path}`);
      return false;
    }
  }

  private spawnAsync(cmd: string, args: string[], timeoutMs: number = 10000): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, { stdio: 'pipe' });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error(`Process timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      proc.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
      proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
      proc.on('error', (err) => { clearTimeout(timer); reject(err); });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          const err = new Error(`Process exited with code ${code}`) as Error & { stdout: string; stderr: string; code: number | null };
          err.stdout = stdout;
          err.stderr = stderr;
          err.code = code;
          reject(err);
        }
      });
    });
  }

  private async isValidGodotPath(path: string): Promise<boolean> {
    if (this.validatedPaths.has(path)) {
      return this.validatedPaths.get(path)!;
    }

    try {
      logDebug(`Validating Godot path: ${path}`);

      if (path !== 'godot' && !existsSync(path)) {
        logDebug(`Path does not exist: ${path}`);
        this.validatedPaths.set(path, false);
        return false;
      }

      await this.spawnAsync(path, ['--version']);

      logDebug(`Valid Godot path: ${path}`);
      this.validatedPaths.set(path, true);
      return true;
    } catch {
      logDebug(`Invalid Godot path: ${path}`);
      this.validatedPaths.set(path, false);
      return false;
    }
  }

  async detectGodotPath(): Promise<void> {
    if (this.godotPath && await this.isValidGodotPath(this.godotPath)) {
      logDebug(`Using existing Godot path: ${this.godotPath}`);
      return;
    }

    if (process.env.GODOT_PATH) {
      const normalizedPath = normalize(process.env.GODOT_PATH);
      logDebug(`Checking GODOT_PATH environment variable: ${normalizedPath}`);
      if (await this.isValidGodotPath(normalizedPath)) {
        this.godotPath = normalizedPath;
        logDebug(`Using Godot path from environment: ${this.godotPath}`);
        return;
      }
    }

    const osPlatform = process.platform;
    logDebug(`Auto-detecting Godot path for platform: ${osPlatform}`);

    const possiblePaths: string[] = ['godot'];

    if (osPlatform === 'darwin') {
      possiblePaths.push(
        '/Applications/Godot.app/Contents/MacOS/Godot',
        '/Applications/Godot_4.app/Contents/MacOS/Godot',
        `${process.env.HOME}/Applications/Godot.app/Contents/MacOS/Godot`
      );
    } else if (osPlatform === 'win32') {
      possiblePaths.push(
        'C:\\Program Files\\Godot\\Godot.exe',
        'C:\\Program Files (x86)\\Godot\\Godot.exe',
        `${process.env.USERPROFILE}\\Godot\\Godot.exe`
      );
    } else if (osPlatform === 'linux') {
      possiblePaths.push(
        '/usr/bin/godot',
        '/usr/local/bin/godot',
        '/snap/bin/godot',
        `${process.env.HOME}/.local/bin/godot`
      );
    }

    for (const path of possiblePaths) {
      const normalizedPath = normalize(path);
      if (await this.isValidGodotPath(normalizedPath)) {
        this.godotPath = normalizedPath;
        logDebug(`Found Godot at: ${normalizedPath}`);
        return;
      }
    }

    logDebug(`Warning: Could not find Godot in common locations for ${osPlatform}`);
    logError(`Could not find Godot in common locations for ${osPlatform}`);

    if (this.strictPathValidation) {
      throw new Error('Could not find a valid Godot executable. Set GODOT_PATH or provide a valid path in config.');
    } else {
      if (osPlatform === 'win32') {
        this.godotPath = normalize('C:\\Program Files\\Godot\\Godot.exe');
      } else if (osPlatform === 'darwin') {
        this.godotPath = normalize('/Applications/Godot.app/Contents/MacOS/Godot');
      } else {
        this.godotPath = normalize('/usr/bin/godot');
      }
      logDebug(`Using default path: ${this.godotPath}, but this may not work.`);
    }
  }

  getGodotPath(): string | null {
    return this.godotPath;
  }

  async getVersion(): Promise<string> {
    if (!this.godotPath) {
      await this.detectGodotPath();
      if (!this.godotPath) {
        throw new Error('Could not find a valid Godot executable path');
      }
    }

    const { stdout } = await this.spawnAsync(this.godotPath, ['--version']);
    return stdout.trim();
  }

  isGodot44OrLater(version: string): boolean {
    const match = version.match(/^(\d+)\.(\d+)/);
    if (match) {
      const major = parseInt(match[1], 10);
      const minor = parseInt(match[2], 10);
      return major > 4 || (major === 4 && minor >= 4);
    }
    return false;
  }

  async executeOperation(
    operation: string,
    params: OperationParams,
    projectPath: string,
    timeoutMs: number = 30000
  ): Promise<OperationResult> {
    logDebug(`Executing operation: ${operation} in project: ${projectPath}`);
    logDebug(`Original operation params: ${JSON.stringify(params)}`);

    const snakeCaseParams = convertCamelToSnakeCase(params);
    logDebug(`Converted snake_case params: ${JSON.stringify(snakeCaseParams)}`);

    if (!this.godotPath) {
      await this.detectGodotPath();
      if (!this.godotPath) {
        throw new Error('Could not find a valid Godot executable path');
      }
    }

    const paramsJson = JSON.stringify(snakeCaseParams);
    const args = [
      '--headless',
      '--path', projectPath,
      '--script', this.operationsScriptPath,
      operation,
      paramsJson,
      ...(DEBUG_MODE ? ['--debug-godot'] : []),
    ];

    logDebug(`Command: ${this.godotPath} ${args.join(' ')}`);

    function cleanStdout(stdout: string): string {
      if (stdout.includes('{') || stdout.includes('[')) {
        return extractJson(stdout);
      }
      return cleanOutput(stdout);
    }

    try {
      const { stdout, stderr } = await this.spawnAsync(this.godotPath, args, timeoutMs);
      return { stdout: cleanStdout(stdout), stderr };
    } catch (error: unknown) {
      if (error instanceof Error && 'stdout' in error && 'stderr' in error) {
        const execError = error as Error & { stdout: string; stderr: string };
        return {
          stdout: cleanStdout(execError.stdout),
          stderr: execError.stderr,
        };
      }
      throw error;
    }
  }

  launchEditor(projectPath: string): ChildProcess {
    if (!this.godotPath) {
      throw new Error('Godot path not set. Call detectGodotPath first.');
    }
    return spawn(this.godotPath, ['-e', '--path', projectPath], { stdio: 'pipe' });
  }

  runProject(projectPath: string, scene?: string): GodotProcess {
    if (!this.godotPath) {
      throw new Error('Godot path not set. Call detectGodotPath first.');
    }

    if (this.activeProcess) {
      logDebug('Killing existing Godot process before starting a new one');
      this.activeProcess.process.kill();
      // Clean up old project's autoload if switching projects
      if (this.activeProjectPath && this.activeProjectPath !== projectPath) {
        this.cleanupBridgeAutoload(this.activeProjectPath);
      }
    }

    try {
      this.injectBridgeAutoload(projectPath);
    } catch (err) {
      logDebug(`Non-fatal: Failed to inject bridge autoload: ${err}`);
    }
    this.activeProjectPath = projectPath;

    const cmdArgs = ['-d', '--path', projectPath];
    if (scene && validatePath(scene)) {
      logDebug(`Adding scene parameter: ${scene}`);
      cmdArgs.push(scene);
    }

    logDebug(`Running Godot project: ${projectPath}`);
    const proc = spawn(this.godotPath, cmdArgs, { stdio: 'pipe' });
    const output: string[] = [];
    const errors: string[] = [];

    const godotProcess: GodotProcess = {
      process: proc,
      output,
      errors,
      exitCode: null,
      hasExited: false,
    };

    proc.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      output.push(...lines);
      if (output.length > 500) output.splice(0, output.length - 500);
      lines.forEach((line: string) => {
        if (line.trim()) logDebug(`[Godot stdout] ${line}`);
      });
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      errors.push(...lines);
      if (errors.length > 500) errors.splice(0, errors.length - 500);
      lines.forEach((line: string) => {
        if (line.trim()) logDebug(`[Godot stderr] ${line}`);
      });
    });

    proc.on('exit', (code: number | null) => {
      logDebug(`Godot process exited with code ${code}`);
      godotProcess.exitCode = code;
      godotProcess.hasExited = true;
      // Don't clear activeProcess immediately - keep it so output can be retrieved
    });

    proc.on('error', (err: Error) => {
      console.error('Failed to start Godot process:', err);
      errors.push(`Process error: ${err.message}`);
      godotProcess.hasExited = true;
    });

    this.activeProcess = godotProcess;
    return this.activeProcess;
  }

  stopProject(): { output: string[]; errors: string[] } | null {
    if (!this.activeProcess) {
      return null;
    }

    logDebug('Stopping active Godot process');
    this.activeProcess.process.kill();
    const result = {
      output: this.activeProcess.output,
      errors: this.activeProcess.errors,
    };
    this.activeProcess = null;

    if (this.activeProjectPath) {
      this.cleanupBridgeAutoload(this.activeProjectPath);
      this.activeProjectPath = null;
    }

    return result;
  }

  private removeAutoloadEntry(projectPath: string, entryName: string, scriptFilename: string): void {
    try {
      const projectFile = join(projectPath, 'project.godot');
      if (existsSync(projectFile)) {
        let content = readFileSync(projectFile, 'utf8');
        const autoloadEntry = `${entryName}="*res://${scriptFilename}"`;

        if (content.includes(autoloadEntry)) {
          content = content.replace(new RegExp(`\\n?${autoloadEntry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'), '');
          content = content.replace(/\[autoload\]\s*(?=\n\[|\n*$)/g, '');
          content = content.trimEnd() + '\n';
          writeFileSync(projectFile, content, 'utf8');
          logDebug(`Removed ${entryName} autoload from project.godot`);
        }
      }
    } catch (err) {
      logDebug(`Non-fatal: Failed to clean ${entryName} from project.godot: ${err}`);
    }

    try {
      const scriptFile = join(projectPath, scriptFilename);
      if (existsSync(scriptFile)) {
        unlinkSync(scriptFile);
        logDebug(`Removed ${scriptFilename} from project`);
      }
    } catch (err) {
      logDebug(`Non-fatal: Failed to remove ${scriptFilename}: ${err}`);
    }

    try {
      const uidFile = join(projectPath, `${scriptFilename}.uid`);
      if (existsSync(uidFile)) {
        unlinkSync(uidFile);
        logDebug(`Removed ${scriptFilename}.uid from project`);
      }
    } catch (err) {
      logDebug(`Non-fatal: Failed to remove ${scriptFilename}.uid: ${err}`);
    }
  }

  injectBridgeAutoload(projectPath: string): void {
    if (this.injectedProjects.has(projectPath)) {
      logDebug('Bridge already injected for this project, skipping');
      return;
    }

    // Ensure .mcp/ directory exists with .gdignore so Godot skips it
    const mcpDir = join(projectPath, '.mcp');
    if (!existsSync(mcpDir)) {
      mkdirSync(mcpDir, { recursive: true });
    }
    const gdignorePath = join(mcpDir, '.gdignore');
    if (!existsSync(gdignorePath)) {
      writeFileSync(gdignorePath, '', 'utf8');
      logDebug('Created .mcp/.gdignore');
    }

    // Also add .mcp/ to .gitignore if not already present
    const gitignorePath = join(projectPath, '.gitignore');
    const mcpGitignoreEntry = '.mcp/';
    if (existsSync(gitignorePath)) {
      const gitignoreContent = readFileSync(gitignorePath, 'utf8');
      if (!gitignoreContent.includes(mcpGitignoreEntry)) {
        const newline = gitignoreContent.endsWith('\n') ? '' : '\n';
        writeFileSync(gitignorePath, gitignoreContent + newline + mcpGitignoreEntry + '\n', 'utf8');
        logDebug('Added .mcp/ to existing .gitignore');
      }
    } else {
      writeFileSync(gitignorePath, mcpGitignoreEntry + '\n', 'utf8');
      logDebug('Created .gitignore with .mcp/ entry');
    }

    // Clean up legacy screenshot server if present
    this.removeAutoloadEntry(projectPath, 'McpScreenshotServer', 'mcp_screenshot_server.gd');

    const destScript = join(projectPath, 'mcp_bridge.gd');
    copyFileSync(this.bridgeScriptPath, destScript);
    logDebug(`Copied bridge autoload to ${destScript}`);

    const projectFile = join(projectPath, 'project.godot');
    let content = readFileSync(projectFile, 'utf8');

    const autoloadEntry = 'McpBridge="*res://mcp_bridge.gd"';

    if (content.includes(autoloadEntry)) {
      logDebug('Bridge autoload already present, skipping injection');
      this.injectedProjects.add(projectPath);
      return;
    }

    const autoloadSectionRegex = /^\[autoload\]\s*$/m;
    if (autoloadSectionRegex.test(content)) {
      content = content.replace(autoloadSectionRegex, `[autoload]\n${autoloadEntry}`);
    } else {
      content = content.trimEnd() + `\n\n[autoload]\n${autoloadEntry}\n`;
    }

    writeFileSync(projectFile, content, 'utf8');
    logDebug('Injected bridge autoload into project.godot');
    this.injectedProjects.add(projectPath);
  }

  cleanupBridgeAutoload(projectPath: string): void {
    this.removeAutoloadEntry(projectPath, 'McpBridge', 'mcp_bridge.gd');
    this.injectedProjects.delete(projectPath);
  }

  sendCommand(command: string, params: Record<string, unknown> = {}, timeoutMs: number = 10000): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = createSocket('udp4');
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.close();
          reject(new Error(`Command '${command}' timed out after ${timeoutMs}ms. Is the game running?`));
        }
      }, timeoutMs);

      socket.on('message', (msg) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          socket.close();
          resolve(msg.toString('utf8'));
        }
      });

      socket.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          socket.close();
          reject(new Error(`UDP error for command '${command}': ${err.message}`));
        }
      });

      const payload = JSON.stringify({ command, ...params });
      const message = Buffer.from(payload);
      socket.send(message, 9900, '127.0.0.1', (err) => {
        if (err && !settled) {
          settled = true;
          clearTimeout(timer);
          socket.close();
          reject(new Error(`Failed to send command '${command}': ${err.message}`));
        }
      });
    });
  }
}
