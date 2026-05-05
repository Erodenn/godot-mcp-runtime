import { fileURLToPath } from 'url';
import { join, dirname, normalize } from 'path';
import { existsSync } from 'fs';
import type { ChildProcess, SpawnOptions } from 'child_process';
import { spawn } from 'child_process';
import * as net from 'net';
import { randomBytes } from 'crypto';
import { BridgeManager } from './bridge-manager.js';
import { encodeFrame, getBridgePort, parseFrames } from './bridge-protocol.js';

/**
 * Thrown when the bridge socket closes (Godot exited, port closed, or peer
 * dropped the connection mid-flight). Lets callers distinguish
 * "session ended" from generic transport errors.
 */
export class BridgeDisconnectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeDisconnectedError';
  }
}

// Derive __filename and __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Debug mode from environment
const DEBUG_MODE = process.env.DEBUG === 'true';

// Bridge readiness polling
export const BRIDGE_WAIT_SPAWNED_TIMEOUT_MS = 8000;
const BRIDGE_WAIT_SPAWNED_INTERVAL_MS = 300;
const BRIDGE_WAIT_ATTACHED_TIMEOUT_MS = 15000;
const BRIDGE_WAIT_ATTACHED_INTERVAL_MS = 500;
const BRIDGE_PING_TIMEOUT_MS = 1000;
const BRIDGE_SHUTDOWN_SPAWNED_TIMEOUT_MS = 500;
const BRIDGE_SHUTDOWN_ATTACHED_TIMEOUT_MS = 1500;
const BRIDGE_PROCESS_EXIT_TIMEOUT_MS = 2000;

/**
 * Normalize a path for cross-platform comparison.
 * Folds Windows backslashes to forward slashes and strips trailing slashes,
 * so Node's `path.normalize` output matches Godot's `globalize_path("res://")`.
 */
export function normalizeForCompare(p: string): string {
  return normalize(p).replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Extract JSON from Godot output by finding the first { or [ and matching to the end.
 * This strips debug logs, version banners, and other noise.
 */
export function extractJson(output: string): string {
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
export function cleanOutput(output: string): string {
  const lines = output.split('\n');
  const cleanedLines = lines.filter((line) => {
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

export function cleanStdout(stdout: string): string {
  if (stdout.includes('{') || stdout.includes('[')) {
    return extractJson(stdout);
  }
  return cleanOutput(stdout);
}

export interface GodotProcess {
  process: ChildProcess;
  output: string[];
  errors: string[];
  totalErrorsWritten: number;
  exitCode: number | null;
  hasExited: boolean;
  sessionToken: string;
}

export type RuntimeSessionMode = 'spawned' | 'attached';

export interface RuntimeStopResult {
  mode: RuntimeSessionMode;
  output: string[];
  errors: string[];
  externalProcessPreserved?: boolean;
}

export interface GodotServerConfig {
  godotPath?: string;
  debugMode?: boolean;
}

export interface OperationParams {
  [key: string]: unknown;
}

export interface OperationResult {
  stdout: string;
  stderr: string;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  title?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, unknown>;
    required: string[];
  };
  outputSchema?: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  annotations?: ToolAnnotations;
}

// Parameter mappings between snake_case and camelCase
const parameterMappings: Record<string, string> = {
  project_path: 'projectPath',
  scene_path: 'scenePath',
  root_node_type: 'rootNodeType',
  parent_node_path: 'parentNodePath',
  node_type: 'nodeType',
  node_name: 'nodeName',
  texture_path: 'texturePath',
  node_path: 'nodePath',
  output_path: 'outputPath',
  mesh_item_names: 'meshItemNames',
  new_path: 'newPath',
  file_path: 'filePath',
  script_path: 'scriptPath',
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
      const snakeKey =
        reverseParameterMappings[key] ||
        key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

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

/**
 * Extract the first [ERROR] message from GDScript stderr output.
 * Falls back to a generic message if no [ERROR] line is found.
 */
export function extractGdError(stderr: string): string {
  const errLine = stderr.split('\n').find((l) => l.includes('[ERROR]'));
  return errLine
    ? errLine.replace(/.*\[ERROR\]\s*/, '').trim()
    : 'see get_debug_output for details';
}

export function createErrorResponse(
  message: string,
  possibleSolutions: string[] = [],
): {
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

// --- Shared validation helpers ---

interface ValidatedProjectArgs {
  projectPath: string;
}

interface ValidatedSceneArgs {
  projectPath: string;
  scenePath: string;
}

type ValidationErrorResult = ReturnType<typeof createErrorResponse>;

export function validateProjectArgs(
  args: OperationParams,
): ValidatedProjectArgs | ValidationErrorResult {
  if (!args.projectPath) {
    return createErrorResponse('projectPath is required', [
      'Provide a valid path to a Godot project directory',
    ]);
  }

  if (!validatePath(args.projectPath as string)) {
    return createErrorResponse('Invalid project path', [
      'Provide a valid path without ".." or other potentially unsafe characters',
    ]);
  }

  const projectFile = join(args.projectPath as string, 'project.godot');
  if (!existsSync(projectFile)) {
    return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`, [
      'Ensure the path points to a directory containing a project.godot file',
    ]);
  }

  return { projectPath: args.projectPath as string };
}

export function validateSceneArgs(
  args: OperationParams,
  opts?: { sceneRequired?: boolean },
): ValidatedSceneArgs | ValidationErrorResult {
  const projectResult = validateProjectArgs(args);
  if ('isError' in projectResult) return projectResult;

  const sceneRequired = opts?.sceneRequired !== false;

  if (!args.scenePath) {
    if (sceneRequired) {
      return createErrorResponse('scenePath is required', [
        'Provide the scene file path relative to the project',
      ]);
    }
    return { projectPath: projectResult.projectPath, scenePath: '' };
  }

  if (!validatePath(args.scenePath as string)) {
    return createErrorResponse('Invalid scene path', [
      'Provide a valid path without ".." or other potentially unsafe characters',
    ]);
  }

  if (sceneRequired) {
    const sceneFullPath = join(projectResult.projectPath, args.scenePath as string);
    if (!existsSync(sceneFullPath)) {
      return createErrorResponse(`Scene file does not exist: ${args.scenePath}`, [
        'Ensure the scene path is correct',
        'Use create_scene to create a new scene first',
      ]);
    }
  }

  return { projectPath: projectResult.projectPath, scenePath: args.scenePath as string };
}

interface InFlightCommand {
  command: string;
  resolve: (value: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class GodotRunner {
  private godotPath: string | null = null;
  private operationsScriptPath: string;
  private bridge: BridgeManager;
  private validatedPaths: Map<string, boolean> = new Map();
  private cachedVersion: string | null = null;
  public activeProcess: GodotProcess | null = null;
  public activeProjectPath: string | null = null;
  public activeSessionMode: RuntimeSessionMode | null = null;

  private socket: net.Socket | null = null;
  private rxBuffer: Buffer = Buffer.alloc(0);
  private inFlight: InFlightCommand | null = null;

  constructor(config?: GodotServerConfig) {
    this.operationsScriptPath = join(__dirname, '..', 'scripts', 'godot_operations.gd');
    const bridgeScriptPath = join(__dirname, '..', 'scripts', 'mcp_bridge.gd');
    this.bridge = new BridgeManager(bridgeScriptPath);
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

  private spawnAsync(
    cmd: string,
    args: string[],
    timeoutMs: number = 10000,
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, { stdio: 'pipe' });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error(`Process timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          const err = new Error(`Process exited with code ${code}`) as Error & {
            stdout: string;
            stderr: string;
            code: number | null;
          };
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
    if (this.godotPath && (await this.isValidGodotPath(this.godotPath))) {
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
        `${process.env.HOME}/Applications/Godot.app/Contents/MacOS/Godot`,
      );
    } else if (osPlatform === 'win32') {
      possiblePaths.push(
        'C:\\Program Files\\Godot\\Godot.exe',
        'C:\\Program Files (x86)\\Godot\\Godot.exe',
        `${process.env.USERPROFILE}\\Godot\\Godot.exe`,
      );
    } else if (osPlatform === 'linux') {
      possiblePaths.push(
        '/usr/bin/godot',
        '/usr/local/bin/godot',
        '/snap/bin/godot',
        `${process.env.HOME}/.local/bin/godot`,
      );
    }

    const normalizedCandidates = possiblePaths.map((p) => normalize(p));
    const probeResults = await Promise.all(
      normalizedCandidates.map(async (p) => ({ path: p, valid: await this.isValidGodotPath(p) })),
    );
    const winner = probeResults.find((r) => r.valid);
    if (winner) {
      this.godotPath = winner.path;
      logDebug(`Found Godot at: ${winner.path}`);
      return;
    }

    logDebug(`Warning: Could not find Godot in common locations for ${osPlatform}`);
    logError(`Could not find Godot in common locations for ${osPlatform}`);

    if (osPlatform === 'win32') {
      this.godotPath = normalize('C:\\Program Files\\Godot\\Godot.exe');
    } else if (osPlatform === 'darwin') {
      this.godotPath = normalize('/Applications/Godot.app/Contents/MacOS/Godot');
    } else {
      this.godotPath = normalize('/usr/bin/godot');
    }
    logDebug(`Using default path: ${this.godotPath}, but this may not work.`);
  }

  getGodotPath(): string | null {
    return this.godotPath;
  }

  async getVersion(): Promise<string> {
    if (this.cachedVersion !== null) {
      return this.cachedVersion;
    }
    if (!this.godotPath) {
      await this.detectGodotPath();
      if (!this.godotPath) {
        throw new Error('Could not find a valid Godot executable path');
      }
    }

    const { stdout } = await this.spawnAsync(this.godotPath, ['--version']);
    this.cachedVersion = stdout.trim();
    return this.cachedVersion;
  }

  async executeOperation(
    operation: string,
    params: OperationParams,
    projectPath: string,
    timeoutMs: number = 30000,
  ): Promise<OperationResult> {
    logDebug(`Executing operation: ${operation} in project: ${projectPath}`);
    logDebug(`Original operation params: ${JSON.stringify(params)}`);

    this.bridge.repairOrphaned(projectPath);

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
      '--path',
      projectPath,
      '--script',
      this.operationsScriptPath,
      operation,
      paramsJson,
      ...(DEBUG_MODE ? ['--debug-godot'] : []),
    ];

    logDebug(`Command: ${this.godotPath} ${args.join(' ')}`);

    let stdout = '';
    let stderr = '';
    try {
      ({ stdout, stderr } = await this.spawnAsync(this.godotPath, args, timeoutMs));
    } catch (error: unknown) {
      if (error instanceof Error && 'stdout' in error && 'stderr' in error) {
        const execError = error as Error & { stdout: string; stderr: string };
        stdout = execError.stdout;
        stderr = execError.stderr;
      } else {
        throw error;
      }
    }

    // If the process produced no operation output but has errors, initialization
    // failed before the script ran. Autoload errors are the most common cause.
    const operationRan = stdout.trim().length > 0 || stderr.includes('[INFO] Operation:');
    if (!operationRan && (stderr.includes('ERROR:') || stderr.includes('SCRIPT ERROR:'))) {
      throw new Error(
        `Headless Godot failed before the operation could run — likely an autoload initialization error.\n` +
          `Stderr:\n${stderr.trim()}\n\n` +
          `Use list_autoloads and remove_autoload to inspect or remove the failing autoload, then retry.`,
      );
    }

    return { stdout: cleanStdout(stdout), stderr };
  }

  launchEditor(projectPath: string): ChildProcess {
    if (!this.godotPath) {
      throw new Error('Godot path not set. Call detectGodotPath first.');
    }
    return spawn(this.godotPath, ['-e', '--path', projectPath], { stdio: 'pipe' });
  }

  runProject(projectPath: string, scene?: string, background: boolean = false): GodotProcess {
    if (!this.godotPath) {
      throw new Error('Godot path not set. Call detectGodotPath first.');
    }

    if (this.activeSessionMode === 'spawned' && this.activeProcess) {
      logDebug('Killing existing Godot process before starting a new one');
      this.activeProcess.process.kill();
      if (this.activeProjectPath && this.activeProjectPath !== projectPath) {
        this.bridge.cleanup(this.activeProjectPath);
      }
    } else if (
      this.activeSessionMode === 'attached' &&
      this.activeProjectPath &&
      this.activeProjectPath !== projectPath
    ) {
      this.bridge.cleanup(this.activeProjectPath);
    }

    try {
      this.bridge.inject(projectPath);
    } catch (err) {
      logDebug(`Non-fatal: Failed to inject bridge autoload: ${err}`);
    }
    this.activeProjectPath = projectPath;
    this.activeSessionMode = 'spawned';

    const cmdArgs = ['--path', projectPath];
    if (scene && validatePath(scene)) {
      logDebug(`Adding scene parameter: ${scene}`);
      cmdArgs.push(scene);
    }

    logDebug(`Running Godot project: ${projectPath}`);
    const sessionToken = randomBytes(16).toString('hex');
    const spawnOptions: SpawnOptions = {
      stdio: 'pipe',
      env: { ...process.env, MCP_SESSION_TOKEN: sessionToken },
    };
    if (background) {
      spawnOptions.env = { ...spawnOptions.env, MCP_BACKGROUND: '1' };
    }
    const proc = spawn(this.godotPath, cmdArgs, spawnOptions);
    const output: string[] = [];
    const errors: string[] = [];

    const godotProcess: GodotProcess = {
      process: proc,
      output,
      errors,
      totalErrorsWritten: 0,
      exitCode: null,
      hasExited: false,
      sessionToken,
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
      godotProcess.totalErrorsWritten += lines.length;
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

  async attachProject(projectPath: string): Promise<void> {
    if (this.activeSessionMode === 'spawned' && this.activeProcess) {
      await this.stopProject();
    } else if (
      this.activeSessionMode === 'attached' &&
      this.activeProjectPath &&
      this.activeProjectPath !== projectPath
    ) {
      // Different project — detach the old one cleanly so its bridge
      // releases the port before we inject into the new project.
      try {
        await this.sendCommand('shutdown', {}, BRIDGE_SHUTDOWN_ATTACHED_TIMEOUT_MS);
      } catch (err) {
        logDebug(`Shutdown command failed during attach swap (ignored): ${err}`);
      }
      this.closeConnection();
      this.bridge.cleanup(this.activeProjectPath);
      this.activeProjectPath = null;
      this.activeSessionMode = null;
    }

    this.bridge.inject(projectPath);
    this.activeProjectPath = projectPath;
    this.activeSessionMode = 'attached';
    this.activeProcess = null;
  }

  async stopProject(): Promise<RuntimeStopResult | null> {
    if (!this.activeSessionMode) {
      return null;
    }

    if (this.activeSessionMode === 'attached') {
      // Ask the bridge to shut down so the user's still-running Godot
      // releases the port. A timeout here is non-fatal — same end state
      // as today, the bridge dies when the user closes Godot.
      try {
        await this.sendCommand('shutdown', {}, BRIDGE_SHUTDOWN_ATTACHED_TIMEOUT_MS);
      } catch (err) {
        logDebug(`Attached shutdown timed out or failed (continuing cleanup): ${err}`);
      }
      this.closeConnection();
      const projectPath = this.activeProjectPath;
      if (projectPath) {
        this.bridge.cleanup(projectPath);
      }
      this.activeProjectPath = null;
      this.activeSessionMode = null;
      this.activeProcess = null;
      return {
        mode: 'attached',
        output: [],
        errors: [],
        externalProcessPreserved: true,
      };
    }

    if (!this.activeProcess) {
      return null;
    }

    // Spawned: try graceful shutdown so the bridge releases the port,
    // then ensure the process actually exits.
    try {
      await this.sendCommand('shutdown', {}, BRIDGE_SHUTDOWN_SPAWNED_TIMEOUT_MS);
    } catch {
      // Bridge may already be unreachable — proceed to kill.
    }
    this.closeConnection();

    logDebug('Stopping active Godot process');
    const proc = this.activeProcess.process;
    proc.kill();

    // Wait up to BRIDGE_PROCESS_EXIT_TIMEOUT_MS for graceful exit; otherwise SIGKILL.
    if (!this.activeProcess.hasExited) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {
            // already dead
          }
          resolve();
        }, BRIDGE_PROCESS_EXIT_TIMEOUT_MS);
        proc.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    const result: RuntimeStopResult = {
      mode: 'spawned',
      output: this.activeProcess.output,
      errors: this.activeProcess.errors,
    };
    this.activeProcess = null;

    if (this.activeProjectPath) {
      this.bridge.cleanup(this.activeProjectPath);
      this.activeProjectPath = null;
    }
    this.activeSessionMode = null;

    return result;
  }

  hasActiveRuntimeSession(): boolean {
    if (!this.activeSessionMode || !this.activeProjectPath) {
      return false;
    }
    if (this.activeSessionMode === 'spawned') {
      return this.activeProcess !== null && !this.activeProcess.hasExited;
    }
    return true;
  }

  /**
   * Send a JSON command to the McpBridge over a long-lived TCP connection.
   *
   * MCP serializes tool calls so we hold one in-flight command at a time. The
   * socket is lazy-connected on first call and persists across commands until
   * `closeConnection` (or a peer-side close). A close mid-flight rejects with
   * `BridgeDisconnectedError`; a per-command timeout rejects but does NOT
   * close the socket — a slow command does not invalidate the session.
   */
  sendCommand(
    command: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = 10000,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.inFlight) {
        reject(
          new Error(
            `Command '${command}' rejected: another command ('${this.inFlight.command}') is in flight`,
          ),
        );
        return;
      }

      const settle = (err: Error | null, value?: string): void => {
        if (!this.inFlight) return;
        const flight = this.inFlight;
        this.inFlight = null;
        clearTimeout(flight.timer);
        if (err) {
          flight.reject(err);
        } else {
          flight.resolve(value ?? '');
        }
      };

      const timer = setTimeout(() => {
        // Timeout rejects but leaves the socket open — a single slow command
        // should not poison the session.
        settle(
          new Error(`Command '${command}' timed out after ${timeoutMs}ms. Is the game running?`),
        );
      }, timeoutMs);

      this.inFlight = { command, resolve, reject, timer };

      const ensureSocket = (cb: (err?: Error) => void): void => {
        if (this.socket) {
          cb();
          return;
        }
        const port = getBridgePort();
        const sock = net.connect(port, '127.0.0.1');
        const onConnect = (): void => {
          sock.setNoDelay(true);
          sock.removeListener('error', onConnectError);
          this.socket = sock;
          this.rxBuffer = Buffer.alloc(0);

          sock.on('data', (chunk: Buffer) => {
            this.rxBuffer = Buffer.concat([this.rxBuffer, chunk]);
            try {
              const { frames, remainder } = parseFrames(this.rxBuffer);
              this.rxBuffer = remainder;
              for (const frame of frames) {
                settle(null, frame.toString('utf8'));
              }
            } catch (parseErr) {
              const message = parseErr instanceof Error ? parseErr.message : String(parseErr);
              this.socket = null;
              sock.destroy();
              settle(new BridgeDisconnectedError(`Bridge framing error: ${message}`));
            }
          });

          const onClose = (): void => {
            this.socket = null;
            settle(
              new BridgeDisconnectedError(
                `Bridge connection closed before '${command}' response was received`,
              ),
            );
          };
          sock.once('close', onClose);
          sock.on('error', (sockErr: Error) => {
            this.socket = null;
            settle(
              new BridgeDisconnectedError(
                `Bridge socket error during '${command}': ${sockErr.message}`,
              ),
            );
          });

          cb();
        };
        const onConnectError = (connErr: Error): void => {
          sock.destroy();
          cb(connErr);
        };
        sock.once('connect', onConnect);
        sock.once('error', onConnectError);
      };

      ensureSocket((err) => {
        if (err) {
          settle(
            new BridgeDisconnectedError(
              `Failed to connect to bridge for '${command}': ${err.message}`,
            ),
          );
          return;
        }
        if (!this.socket) {
          settle(new BridgeDisconnectedError(`Bridge socket unavailable for '${command}'`));
          return;
        }
        try {
          const payload = JSON.stringify({ command, ...params });
          this.socket.write(encodeFrame(payload));
        } catch (writeErr) {
          const message = writeErr instanceof Error ? writeErr.message : String(writeErr);
          settle(new Error(`Failed to send command '${command}': ${message}`));
        }
      });
    });
  }

  /**
   * Tear down the bridge socket. Idempotent. Any in-flight command is
   * rejected with a session-ended error.
   */
  closeConnection(): void {
    if (this.inFlight) {
      const flight = this.inFlight;
      this.inFlight = null;
      clearTimeout(flight.timer);
      flight.reject(new BridgeDisconnectedError('Bridge session ended'));
    }
    if (this.socket) {
      const sock = this.socket;
      this.socket = null;
      sock.removeAllListeners();
      sock.destroy();
    }
    this.rxBuffer = Buffer.alloc(0);
  }

  getErrorCount(): number {
    return this.activeProcess?.totalErrorsWritten ?? 0;
  }

  getErrorsSince(marker: number): string[] {
    if (!this.activeProcess) return [];
    const { errors, totalErrorsWritten } = this.activeProcess;
    const delta = totalErrorsWritten - marker;
    if (delta <= 0) return [];
    const window = delta >= errors.length ? errors.slice() : errors.slice(errors.length - delta);
    return window.filter((line) => line.trim() !== '');
  }

  private static readonly SCRIPT_ERROR_PATTERNS = ['SCRIPT ERROR:', 'USER SCRIPT ERROR:'];

  extractRuntimeErrors(lines: string[]): string[] {
    return lines.filter((line) => GodotRunner.SCRIPT_ERROR_PATTERNS.some((p) => line.includes(p)));
  }

  async sendCommandWithErrors(
    command: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = 10000,
  ): Promise<{ response: string; runtimeErrors: string[] }> {
    const marker = this.getErrorCount();
    const response = await this.sendCommand(command, params, timeoutMs);
    const newErrors = this.getErrorsSince(marker);
    const runtimeErrors =
      this.activeSessionMode === 'spawned' ? this.extractRuntimeErrors(newErrors) : [];
    return { response, runtimeErrors };
  }

  async waitForBridgeAttached(
    timeoutMs: number = BRIDGE_WAIT_ATTACHED_TIMEOUT_MS,
    intervalMs: number = BRIDGE_WAIT_ATTACHED_INTERVAL_MS,
  ): Promise<{ ready: boolean; error?: string }> {
    const deadline = Date.now() + timeoutMs;
    const expectedPath = this.activeProjectPath
      ? normalizeForCompare(this.activeProjectPath)
      : null;

    while (Date.now() < deadline) {
      try {
        const response = await this.sendCommand('ping', {}, BRIDGE_PING_TIMEOUT_MS);
        const parsed = JSON.parse(response);
        if (parsed.status === 'pong') {
          if (expectedPath && parsed.project_path) {
            const bridgePath = normalizeForCompare(parsed.project_path);
            if (bridgePath !== expectedPath) {
              return {
                ready: false,
                error: `Bridge is running for a different project (${bridgePath}), expected ${expectedPath}`,
              };
            }
          }
          return { ready: true };
        }
      } catch {
        // Expected: ping will fail until bridge is listening
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    return {
      ready: false,
      error:
        'Bridge did not respond within timeout — is Godot running with the McpBridge autoload?',
    };
  }

  async waitForBridge(
    timeoutMs: number = BRIDGE_WAIT_SPAWNED_TIMEOUT_MS,
    intervalMs: number = BRIDGE_WAIT_SPAWNED_INTERVAL_MS,
  ): Promise<{ ready: boolean; error?: string }> {
    const deadline = Date.now() + timeoutMs;
    const expectedToken = this.activeProcess?.sessionToken;
    const expectedPath = this.activeProjectPath
      ? normalizeForCompare(this.activeProjectPath)
      : null;

    if (!expectedToken) {
      return { ready: false, error: 'No active spawned Godot process to verify' };
    }

    while (Date.now() < deadline) {
      if (this.activeProcess && this.activeProcess.hasExited) {
        const lastErrors = this.getRecentErrors(20);
        const errorText = lastErrors.length > 0 ? `\nLast stderr:\n${lastErrors.join('\n')}` : '';
        return {
          ready: false,
          error: `Process exited with code ${this.activeProcess.exitCode} before bridge was ready.${errorText}`,
        };
      }

      try {
        const response = await this.sendCommand(
          'ping',
          { session_token: expectedToken },
          BRIDGE_PING_TIMEOUT_MS,
        );
        const parsed = JSON.parse(response);
        if (parsed.status === 'pong' && parsed.session_token === expectedToken) {
          if (expectedPath && parsed.project_path) {
            const bridgePath = normalizeForCompare(parsed.project_path);
            if (bridgePath !== expectedPath) {
              return {
                ready: false,
                error: `Bridge reports project ${bridgePath}, expected ${expectedPath}`,
              };
            }
          }
          return { ready: true };
        }
      } catch {
        // Expected: ping will fail until bridge is listening
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    return {
      ready: false,
      error: 'Bridge did not respond with the expected session token within timeout',
    };
  }

  getRecentErrors(count: number = 20): string[] {
    if (!this.activeProcess) return [];
    return this.activeProcess.errors.slice(-count).filter((line) => line.trim() !== '');
  }
}
