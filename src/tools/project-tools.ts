import { join, basename, resolve } from 'path';
import { existsSync, readdirSync, readFileSync } from 'fs';
import type { GodotRunner, RuntimeSessionInfo } from '../utils/godot-runner.js';
import { BRIDGE_PING_TIMEOUT_MS } from '../utils/godot-runner.js';
import type { HandlerResult, OperationParams, ToolDefinition } from '../mcp.types.js';
import { normalizeParameters } from '../utils/parameter-conversion.js';
import { validatePath, projectGodotPath } from '../utils/path-validation.js';
import { createErrorResponse, getErrorMessage } from '../utils/error-response.js';
import { createStructuredResponse, leadWithWarnings } from '../utils/structured-response.js';
import {
  parseProjectArgs,
  parseSceneArgs,
  requireString,
  optionalString,
  optionalBoolean,
  optionalNumber,
  optionalStringArray,
} from '../utils/arg-parsing.js';
import { err } from '../utils/result.js';
import { logDebug } from '../utils/logger.js';
import { readQuoted } from '../utils/scene-parsing.js';

function fileExtension(name: string): string {
  const dotIdx = name.lastIndexOf('.');
  return dotIdx >= 0 ? name.slice(dotIdx + 1).toLowerCase() : '';
}

// --- Tool definitions ---

/** One node of the get_project_files tree. Children repeat this shape. */
const FILE_TREE_NODE_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    type: { type: 'string', enum: ['file', 'dir'] },
    path: { type: 'string', description: 'Project-relative path; "." for the root.' },
    extension: { type: 'string', description: 'Files only, lower case, no dot.' },
    children: {
      type: 'array',
      description: 'Directories only. Each child has this same shape.',
      items: { type: 'object' },
    },
  },
  required: ['name', 'type', 'path'],
} as const;

export const projectToolDefinitions = [
  {
    name: 'list_projects',
    description:
      'Find Godot projects under a directory by locating project.godot files. Use to discover projects when the user has not named one; to inspect a known project use check_project. recursive: true descends into subdirectories (skipping .git, .godot, .mcp, node_modules and the like); the default checks only the directory and its immediate children. Returns: projects[], each { projectPath, name }; empty when nothing matches.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Directory to search for Godot projects',
        },
        recursive: {
          type: 'boolean',
          description: 'Whether to search recursively (default: false)',
        },
      },
      required: ['directory'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        projects: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              projectPath: { type: 'string' },
              name: { type: 'string' },
            },
            required: ['projectPath', 'name'],
          },
        },
      },
      required: ['projects'],
    },
  },
  {
    name: 'check_project',
    description:
      "Get project metadata and the Godot version, plus a runtime block. runtime.activeSession, sessionMode and bridgeResponsive describe the current session, the one the runtime tools act on; runtime.projectPath names its project (null when none) and runtime.liveSessions lists every live session. With projectPath, runtime.project reports that project's own session: live, exited or none. Returns: { name?, projectPath?, structure?, godotVersion, runtime }. Errors if projectPath lacks project.godot.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description:
            'Path to the Godot project directory (optional - omit to get Godot version and runtime status only)',
        },
      },
      required: [],
    },
    outputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        projectPath: { type: 'string' },
        godotVersion: { type: 'string' },
        structure: {
          type: 'object',
          properties: {
            scenes: { type: 'number' },
            scripts: { type: 'number' },
            assets: { type: 'number' },
            other: { type: 'number' },
          },
        },
        runtime: {
          type: 'object',
          properties: {
            activeSession: { type: 'boolean' },
            projectPath: { type: ['string', 'null'] },
            sessionMode: { type: 'string', enum: ['spawned', 'attached'] },
            processExited: { type: 'boolean' },
            exitCode: { type: ['number', 'null'] },
            bridgeResponsive: { type: 'boolean' },
            diagnostics: { type: 'array', items: { type: 'string' } },
            liveSessions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  projectPath: { type: 'string' },
                  sessionMode: { type: 'string', enum: ['spawned', 'attached'] },
                  current: { type: 'boolean' },
                  bridgePort: { type: ['number', 'null'] },
                },
                required: ['projectPath', 'sessionMode', 'current', 'bridgePort'],
              },
            },
            project: {
              type: 'object',
              properties: {
                projectPath: { type: 'string' },
                session: { type: 'string', enum: ['live', 'exited', 'none'] },
                current: { type: 'boolean' },
                sessionMode: { type: 'string', enum: ['spawned', 'attached'] },
                exitCode: { type: ['number', 'null'] },
              },
              required: ['projectPath', 'session', 'current'],
            },
          },
          required: ['activeSession', 'projectPath', 'liveSessions'],
        },
      },
      required: ['godotVersion', 'runtime'],
    },
  },
  {
    name: 'get_project_files',
    description:
      'Return the file tree of a Godot project. Use to discover project structure when paths are unknown. extensions filters files (e.g. ["gd","tscn"]); maxDepth caps recursion (-1 is unlimited). Skips dot-prefixed entries, .mcp included. Returns: the root directory node { name, type, path, children[] }; each child is a file { name, type, path, extension } or a nested directory.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
        maxDepth: {
          type: 'number',
          description: 'Maximum recursion depth. -1 means unlimited (default: -1)',
        },
        extensions: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Filter to only these file extensions (e.g. ["gd", "tscn"]). Omit to include all.',
        },
      },
      required: ['projectPath'],
    },
    outputSchema: FILE_TREE_NODE_SCHEMA,
  },
  {
    name: 'search_project',
    description:
      'Plain-text (substring) search across project files. Use to find references, callers, or signatures across the codebase. Default fileTypes is ["gd","tscn","cs","gdshader"]; caseSensitive default false; maxResults default 100. Skips hidden entries and the .mcp directory. Returns: matches[] (project-relative file, 1-indexed lineNumber, line text) and truncated:true when maxResults was hit - consider raising it.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
        pattern: { type: 'string', description: 'Plain-text string to search for' },
        fileTypes: {
          type: 'array',
          items: { type: 'string' },
          description: 'File extensions to search (default: ["gd", "tscn", "cs", "gdshader"])',
        },
        caseSensitive: { type: 'boolean', description: 'Case-sensitive search (default: false)' },
        maxResults: { type: 'number', description: 'Maximum matches to return (default: 100)' },
      },
      required: ['projectPath', 'pattern'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        matches: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              file: { type: 'string' },
              lineNumber: { type: 'number' },
              line: { type: 'string' },
            },
          },
        },
        truncated: { type: 'boolean' },
      },
    },
  },
  {
    name: 'get_scene_dependencies',
    description:
      'Parse a .tscn file for ext_resource references (scripts, textures, subscenes). Use to see what a scene depends on before refactoring or moving files. Returns: scenePath and dependencies[], one per ext_resource reference (path, type, optional uid). Errors if the scene file does not exist.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
        scenePath: {
          type: 'string',
          description:
            'Path to the .tscn file relative to the project root (e.g. "scenes/main.tscn")',
        },
      },
      required: ['projectPath', 'scenePath'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        scenePath: { type: 'string' },
        dependencies: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              type: { type: 'string' },
              uid: { type: 'string' },
            },
          },
        },
      },
      required: ['scenePath', 'dependencies'],
    },
  },
  {
    name: 'get_project_settings',
    description:
      'Parse project.godot into JSON without launching Godot. Use to inspect display, input and rendering settings. Pass section for one INI section (e.g. "display"). Returns: settings as { [section]: { [key]: value } }, or { [key]: value } plus section. Strings are unescaped, an empty value is null, complex values stay raw text. Keys before any section, config_version included, are under __global__. warnings leads when the section is absent, a value is unterminated or empty, or a line was skipped.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
        section: {
          type: 'string',
          description:
            'Filter to a specific INI section (e.g. "display", "application"). Omit for all sections.',
        },
      },
      required: ['projectPath'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        warnings: { type: 'array', items: { type: 'string' } },
        section: { type: 'string', description: 'Present when a section filter was applied.' },
        settings: {
          type: 'object',
          description:
            'Without section: { [section]: { [key]: value } }. With section: { [key]: value }. A value is a string, number, boolean or null (an empty value).',
        },
      },
      required: ['settings'],
    },
  },
] as const satisfies readonly ToolDefinition[];

// --- Helpers ---

const PROJECT_SCAN_BLACKLIST = new Set(['.git', '.godot', '.mcp', 'node_modules', '.svn', '.hg']);

function findGodotProjects(
  directory: string,
  recursive: boolean,
): Array<{ path: string; name: string }> {
  const projects: Array<{ path: string; name: string }> = [];

  try {
    const projectFile = projectGodotPath(directory);
    if (existsSync(projectFile)) {
      projects.push({
        path: directory,
        name: basename(directory),
      });
    }

    const entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || PROJECT_SCAN_BLACKLIST.has(entry.name)) continue;
      const subdir = join(directory, entry.name);
      if (existsSync(projectGodotPath(subdir))) {
        projects.push({ path: subdir, name: entry.name });
      } else if (recursive) {
        projects.push(...findGodotProjects(subdir, true));
      }
    }
  } catch (error) {
    logDebug(`Error searching directory ${directory}: ${error}`);
  }

  return projects;
}

function getProjectStructure(projectPath: string): {
  scenes: number;
  scripts: number;
  assets: number;
  other: number;
} {
  const structure = {
    scenes: 0,
    scripts: 0,
    assets: 0,
    other: 0,
  };

  const scanDirectory = (currentPath: string) => {
    try {
      const entries = readdirSync(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        const entryPath = join(currentPath, entry.name);

        if (entry.name.startsWith('.')) {
          continue;
        }

        if (entry.isDirectory()) {
          scanDirectory(entryPath);
        } else if (entry.isFile()) {
          const ext = fileExtension(entry.name);

          if (ext === 'tscn') {
            structure.scenes++;
          } else if (ext === 'gd' || ext === 'gdscript' || ext === 'cs') {
            structure.scripts++;
          } else if (
            ['png', 'jpg', 'jpeg', 'webp', 'svg', 'ttf', 'wav', 'mp3', 'ogg'].includes(ext || '')
          ) {
            structure.assets++;
          } else {
            structure.other++;
          }
        }
      }
    } catch (error) {
      logDebug(`Error scanning directory ${currentPath}: ${error}`);
    }
  };

  scanDirectory(projectPath);
  return structure;
}

// --- Project helper: filesystem tree ---

interface FileTreeNode {
  name: string;
  type: 'file' | 'dir';
  path: string;
  extension?: string;
  children?: FileTreeNode[];
}

function buildFilesystemTree(
  currentPath: string,
  relativePath: string,
  maxDepth: number,
  currentDepth: number,
  extensions: string[] | null,
): FileTreeNode {
  const name = basename(currentPath);
  const node: FileTreeNode = { name, type: 'dir', path: relativePath || '.' };
  if (maxDepth !== -1 && currentDepth >= maxDepth) {
    node.children = [];
    return node;
  }
  const children: FileTreeNode[] = [];
  try {
    const entries = readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const childRelPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        children.push(
          buildFilesystemTree(
            join(currentPath, entry.name),
            childRelPath,
            maxDepth,
            currentDepth + 1,
            extensions,
          ),
        );
      } else if (entry.isFile()) {
        const ext = fileExtension(entry.name);
        if (extensions && !extensions.includes(ext)) continue;
        children.push({ name: entry.name, type: 'file', path: childRelPath, extension: ext });
      }
    }
  } catch (err) {
    logDebug(`buildFilesystemTree error at ${currentPath}: ${err}`);
  }
  node.children = children;
  return node;
}

// --- Project helper: search in files ---

interface SearchMatch {
  file: string;
  lineNumber: number;
  line: string;
}

function searchInFiles(
  rootPath: string,
  pattern: string,
  fileTypes: string[],
  caseSensitive: boolean,
  maxResults: number,
): { matches: SearchMatch[]; truncated: boolean } {
  const matches: SearchMatch[] = [];
  let truncated = false;

  const searchDir = (currentPath: string, relBase: string) => {
    if (truncated) return;
    let entries;
    try {
      entries = readdirSync(currentPath, { withFileTypes: true });
    } catch (err) {
      logDebug(`searchInFiles readdir error at ${currentPath}: ${err}`);
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      if (entry.name.startsWith('.')) continue;
      const childRelPath = relBase ? `${relBase}/${entry.name}` : entry.name;
      const fullPath = join(currentPath, entry.name);
      if (entry.isDirectory()) {
        searchDir(fullPath, childRelPath);
      } else if (entry.isFile()) {
        const ext = fileExtension(entry.name);
        if (!fileTypes.includes(ext)) continue;
        let content: string;
        try {
          content = readFileSync(fullPath, 'utf8');
        } catch {
          continue;
        }
        const lines = content.split('\n');
        const needle = caseSensitive ? pattern : pattern.toLowerCase();
        for (const [i, line] of lines.entries()) {
          const haystack = caseSensitive ? line : line.toLowerCase();
          if (haystack.includes(needle)) {
            matches.push({ file: childRelPath, lineNumber: i + 1, line });
            if (matches.length >= maxResults) {
              truncated = true;
              return;
            }
          }
        }
      }
    }
  };

  searchDir(rootPath, '');
  return { matches, truncated };
}

// --- Project helper: project settings parser ---

type SettingsValue = string | number | boolean | null;

interface ParsedSettings {
  settings: Record<string, Record<string, SettingsValue>>;
  warnings: string[];
}

/** Settings keys that precede every section header are reported under this name. */
const GLOBAL_SECTION = '__global__';

/** Longest slice of an unparsed line quoted in a warning. */
const UNPARSED_LINE_SNIPPET_MAX = 120;

// Godot section headers are a bare identifier-ish name in brackets on its own
// line (e.g. "[input]"), never containing commas or spaces the way a
// multi-line array/dict literal's closing lines can. Used only to cap a runaway
// multi-line value at the next real section boundary.
const SECTION_HEADER_REGEX = /^\[[A-Za-z0-9_/.]+\]$/;

/** A statement-level header: any bracketed line, the test `walkIniSection` applies. */
const SECTION_LINE_REGEX = /^\[.*\]$/;

const NUMBER_VALUE_REGEX = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

interface RawValue {
  raw: string;
  /** Index of the line break that ended the value, or the content length. */
  end: number;
  unterminated: boolean;
}

/**
 * Read one value starting at `start` (just after the `=`). Quoted strings keep
 * their backslash escapes and may span lines; `{ [ (` depth is tracked outside
 * strings, and the value ends at the first line break at depth zero outside a
 * string. While inside brackets, a following line that is a section header ends
 * the value as unterminated, so a malformed file cannot swallow the rest of it.
 */
function readRawValue(content: string, start: number): RawValue {
  const length = content.length;
  let depth = 0;
  let inString = false;
  let i = start;
  while (i < length) {
    const ch = content[i]!;
    if (inString) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{' || ch === '[' || ch === '(') {
      depth++;
    } else if ((ch === '}' || ch === ']' || ch === ')') && depth > 0) {
      depth--;
    } else if (ch === '\n') {
      if (depth === 0) return { raw: content.slice(start, i).trim(), end: i, unterminated: false };
      const nextEnd = content.indexOf('\n', i + 1);
      const nextLine = content.slice(i + 1, nextEnd === -1 ? length : nextEnd).trim();
      if (SECTION_HEADER_REGEX.test(nextLine)) {
        return { raw: content.slice(start, i).trim(), end: i, unterminated: true };
      }
    }
    i++;
  }
  return {
    raw: content.slice(start, length).trim(),
    end: length,
    unterminated: inString || depth > 0,
  };
}

/**
 * Convert a trimmed, non-empty raw value. A lone quoted string is unescaped;
 * `true`, `false` and plain numbers are typed; everything else (constructors
 * such as `PackedStringArray(...)`, arrays, dictionaries) stays its raw text.
 */
function convertSettingsValue(raw: string): SettingsValue {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw.startsWith('"')) {
    const quoted = readQuoted(raw, 0, raw.length);
    return quoted !== null && quoted.end === raw.length ? quoted.value : raw;
  }
  return NUMBER_VALUE_REGEX.test(raw) ? Number(raw) : raw;
}

function parseProjectSettings(projectFilePath: string): ParsedSettings {
  const content = readFileSync(projectFilePath, 'utf8');
  const settings: ParsedSettings['settings'] = Object.create(null);
  const warnings: string[] = [];
  const unparsed: string[] = [];
  let currentSection = GLOBAL_SECTION;

  let pos = 0;
  while (pos < content.length) {
    const newlineAt = content.indexOf('\n', pos);
    const lineEnd = newlineAt === -1 ? content.length : newlineAt;
    const rawLine = content.slice(pos, lineEnd);
    const line = rawLine.trim();
    if (line === '' || line.startsWith(';') || line.startsWith('#')) {
      pos = lineEnd + 1;
      continue;
    }
    if (SECTION_LINE_REGEX.test(line)) {
      currentSection = line.slice(1, -1);
      pos = lineEnd + 1;
      continue;
    }
    const equalsAt = rawLine.indexOf('=');
    const key = equalsAt === -1 ? '' : rawLine.slice(0, equalsAt).trim();
    if (key === '') {
      unparsed.push(line);
      pos = lineEnd + 1;
      continue;
    }

    const value = readRawValue(content, pos + equalsAt + 1);
    pos = value.end + 1;
    const location = `${currentSection}/${key}`;
    if (value.unterminated) {
      warnings.push(
        `Value of ${location} is unterminated and was returned as far as it could be read`,
      );
    }
    let converted: SettingsValue = null;
    if (value.raw === '') {
      if (!value.unterminated) warnings.push(`Value of ${location} is empty and is null`);
    } else {
      converted = convertSettingsValue(value.raw);
    }
    const section = (settings[currentSection] ??= Object.create(null));
    section[key] = converted;
  }

  if (unparsed.length > 0) {
    warnings.push(
      `${unparsed.length} line(s) could not be parsed and were skipped; first: ${unparsed[0]!.slice(0, UNPARSED_LINE_SNIPPET_MAX)}`,
    );
  }
  return { settings, warnings };
}

// --- Handlers ---

export async function handleListProjects(args: OperationParams): Promise<HandlerResult> {
  args = normalizeParameters(args);

  const directory = requireString(args, 'directory');
  if (!directory.ok) return directory;

  if (!validatePath(directory.value)) {
    return err(
      createErrorResponse('Invalid directory path', [
        'Provide a valid path without ".." or other potentially unsafe characters',
      ]),
    );
  }

  try {
    if (!existsSync(directory.value)) {
      return err(
        createErrorResponse(`Directory does not exist: ${directory.value}`, [
          'Provide a valid directory path that exists on the system',
        ]),
      );
    }

    const recursive = optionalBoolean(args, 'recursive');
    if (!recursive.ok) return recursive;

    const projects = findGodotProjects(directory.value, recursive.value === true).map(
      (project) => ({ projectPath: resolve(project.path), name: project.name }),
    );
    return createStructuredResponse({ projects });
  } catch (error: unknown) {
    return err(
      createErrorResponse(`Failed to list projects: ${getErrorMessage(error)}`, [
        'Ensure the directory exists and is accessible',
        'Check if you have permission to read the directory',
      ]),
    );
  }
}

function describeLiveSession(info: RuntimeSessionInfo): Record<string, unknown> {
  return {
    projectPath: info.projectPath,
    sessionMode: info.mode,
    current: info.current,
    bridgePort: info.bridgePort,
  };
}

function describeProjectSession(runner: GodotRunner, projectPath: string): Record<string, unknown> {
  const info = runner.getSessionInfo(projectPath);
  if (info === null) return { projectPath: resolve(projectPath), session: 'none', current: false };
  return {
    projectPath: info.projectPath,
    session: info.live ? 'live' : 'exited',
    current: info.current,
    ...(info.mode !== null ? { sessionMode: info.mode } : {}),
    ...(info.processExited ? { exitCode: info.exitCode } : {}),
  };
}

/**
 * Build the always-present `runtime` block for check_project. The top-level
 * fields describe the current session, in the same liveness order the runtime
 * tools gate on: a spawned process that has exited is not an active session,
 * whether or not the session fields survived it. `projectPath` names the
 * current project and `liveSessions` lists every live session; with an asked
 * project, `project` reports that project's own session. Only the current live
 * session is pinged, since the runner holds one bridge channel. The ping only
 * runs when that session is live, so the no-session path costs nothing extra
 * and a failed/timed-out ping never turns the call into an error - it only
 * downgrades bridgeResponsive and adds a diagnostic.
 */
async function buildRuntimeReport(
  runner: GodotRunner,
  askedProjectPath: string | null,
): Promise<Record<string, unknown>> {
  const status = runner.getRuntimeSessionStatus();
  const current = status.current;
  const diagnostics: string[] = [];
  let runtime: Record<string, unknown>;
  if (current === null) {
    runtime = { activeSession: false };
  } else if (status.state === 'live') {
    runtime = { activeSession: true, sessionMode: current.mode };
    try {
      // ping is exempt from the attached-mode disconnect probe (see
      // DISCONNECT_EXEMPT_BRIDGE_COMMANDS in godot-runner.ts), so a failed
      // ping here reports bridgeResponsive:false without ending the session.
      const { response } = await runner.sendCommandWithErrors('ping', {}, BRIDGE_PING_TIMEOUT_MS);
      let parsed: { status?: string } | undefined;
      try {
        parsed = JSON.parse(response) as { status?: string };
      } catch {
        diagnostics.push('Bridge returned a non-JSON ping response');
      }
      runtime.bridgeResponsive = parsed?.status === 'pong';
      if (parsed && parsed.status !== 'pong') {
        diagnostics.push('Bridge responded to ping with an unexpected payload');
      }
    } catch (error: unknown) {
      runtime.bridgeResponsive = false;
      diagnostics.push(`Bridge not responsive: ${getErrorMessage(error)}`);
    }
  } else if (current.mode === 'spawned') {
    runtime = { activeSession: false, sessionMode: 'spawned', processExited: true };
    diagnostics.push(
      'The spawned Godot process has exited; call stop_project, then run_project again',
    );
  } else if (current.processExited) {
    runtime = { activeSession: false, processExited: true, exitCode: current.exitCode };
    diagnostics.push(
      'The spawned Godot process has exited; call stop_project, then run_project again',
      'get_debug_output still returns the captured logs, and stop_project reports the exit code',
    );
  } else {
    runtime = { activeSession: false };
    diagnostics.push(
      'Only a finished profiler capture is retained for this project; stop_profiler can still read it and stop_project releases it',
    );
  }
  runtime.projectPath = current?.projectPath ?? null;
  const liveSessions = runner.listLiveSessions();
  runtime.liveSessions = liveSessions.map(describeLiveSession);
  if (askedProjectPath !== null) runtime.project = describeProjectSession(runner, askedProjectPath);
  if (status.state !== 'live' && liveSessions.length > 0) {
    diagnostics.push(
      'The runtime tools are not pointed at a live session while other sessions are live: call switch_project with a projectPath from liveSessions',
    );
  }
  if (diagnostics.length > 0) runtime.diagnostics = diagnostics;
  return runtime;
}

export async function handleCheckProject(
  runner: GodotRunner,
  args: OperationParams,
): Promise<HandlerResult> {
  args = normalizeParameters(args);

  try {
    const version = await runner.getVersion();

    // If no project path, return just the Godot version plus runtime status.
    if (!args.projectPath) {
      return createStructuredResponse({
        godotVersion: version,
        runtime: await buildRuntimeReport(runner, null),
      });
    }

    const parsed = parseProjectArgs(args);
    if (!parsed.ok) return parsed;
    const runtime = await buildRuntimeReport(runner, parsed.value.projectPath);

    const projectFile = projectGodotPath(parsed.value.projectPath);
    const projectStructure = getProjectStructure(parsed.value.projectPath);

    let projectName = basename(parsed.value.projectPath);
    try {
      const projectFileContent = readFileSync(projectFile, 'utf8');
      const configNameMatch = projectFileContent.match(/config\/name="([^"]+)"/);
      if (configNameMatch && configNameMatch[1]) {
        projectName = configNameMatch[1];
        logDebug(`Found project name in config: ${projectName}`);
      }
    } catch (error) {
      logDebug(`Error reading project file: ${error}`);
    }

    return createStructuredResponse({
      name: projectName,
      projectPath: resolve(parsed.value.projectPath),
      godotVersion: version,
      structure: projectStructure,
      runtime,
    });
  } catch (error: unknown) {
    return err(
      createErrorResponse(`Failed to check project: ${getErrorMessage(error)}`, [
        'Ensure Godot is installed correctly',
        'Check if the GODOT_PATH environment variable is set correctly',
      ]),
    );
  }
}

export async function handleGetProjectFiles(args: OperationParams): Promise<HandlerResult> {
  args = normalizeParameters(args);
  const parsed = parseProjectArgs(args);
  if (!parsed.ok) return parsed;

  try {
    const maxDepthResult = optionalNumber(args, 'maxDepth');
    if (!maxDepthResult.ok) return maxDepthResult;
    const maxDepth = maxDepthResult.value ?? -1;

    const extensionsResult = optionalStringArray(args, 'extensions');
    if (!extensionsResult.ok) return extensionsResult;
    const extensions = extensionsResult.value
      ? extensionsResult.value.map((e) => e.toLowerCase().replace(/^\./, ''))
      : null;

    const tree = buildFilesystemTree(parsed.value.projectPath, '', maxDepth, 0, extensions);
    return createStructuredResponse(tree as unknown as Record<string, unknown>);
  } catch (error: unknown) {
    return err(
      createErrorResponse(`Failed to get project files: ${getErrorMessage(error)}`, [
        'Check if the project directory is accessible',
      ]),
    );
  }
}

export async function handleSearchProject(args: OperationParams): Promise<HandlerResult> {
  args = normalizeParameters(args);
  const parsed = parseProjectArgs(args);
  if (!parsed.ok) return parsed;

  const pattern = requireString(args, 'pattern');
  if (!pattern.ok) return pattern;

  try {
    const fileTypesResult = optionalStringArray(args, 'fileTypes');
    if (!fileTypesResult.ok) return fileTypesResult;
    const fileTypes = fileTypesResult.value
      ? fileTypesResult.value.map((e) => e.toLowerCase().replace(/^\./, ''))
      : ['gd', 'tscn', 'cs', 'gdshader'];

    const caseSensitiveResult = optionalBoolean(args, 'caseSensitive');
    if (!caseSensitiveResult.ok) return caseSensitiveResult;
    const caseSensitive = caseSensitiveResult.value === true;

    const maxResultsResult = optionalNumber(args, 'maxResults');
    if (!maxResultsResult.ok) return maxResultsResult;
    const maxResults = maxResultsResult.value ?? 100;

    const result = searchInFiles(
      parsed.value.projectPath,
      pattern.value,
      fileTypes,
      caseSensitive,
      maxResults,
    );
    return createStructuredResponse(result as unknown as Record<string, unknown>);
  } catch (error: unknown) {
    return err(
      createErrorResponse(`Failed to search project: ${getErrorMessage(error)}`, [
        'Check if the project directory is accessible',
      ]),
    );
  }
}

export async function handleGetSceneDependencies(args: OperationParams): Promise<HandlerResult> {
  args = normalizeParameters(args);
  const parsed = parseSceneArgs(args);
  if (!parsed.ok) return parsed;

  try {
    const sceneFullPath = join(parsed.value.projectPath, parsed.value.scenePath);
    const sceneContent = readFileSync(sceneFullPath, 'utf8');
    const dependencies: Array<{ path: string; type: string; uid?: string }> = [];
    const extResourcePattern = /^\[ext_resource([^\]]*)\]/gm;
    let match;
    while ((match = extResourcePattern.exec(sceneContent)) !== null) {
      const [, attrs = ''] = match;
      const typeMatch = attrs.match(/\btype="([^"]*)"/);
      const pathMatch = attrs.match(/\bpath="([^"]*)"/);
      const uidMatch = attrs.match(/\buid="([^"]*)"/);
      if (pathMatch) {
        const depPath = (pathMatch[1] ?? '').replace(/^res:\/\//, '');
        const dep: { path: string; type: string; uid?: string } = {
          path: depPath,
          type: typeMatch?.[1] ?? 'Unknown',
        };
        if (uidMatch?.[1] !== undefined) dep.uid = uidMatch[1];
        dependencies.push(dep);
      }
    }
    return createStructuredResponse({
      scenePath: parsed.value.scenePath,
      dependencies,
    });
  } catch (error: unknown) {
    return err(
      createErrorResponse(`Failed to get scene dependencies: ${getErrorMessage(error)}`, [
        'Check if the scene file is accessible',
      ]),
    );
  }
}

export async function handleGetProjectSettings(args: OperationParams): Promise<HandlerResult> {
  args = normalizeParameters(args);
  const parsed = parseProjectArgs(args);
  if (!parsed.ok) return parsed;

  const section = optionalString(args, 'section');
  if (!section.ok) return section;

  try {
    const projectFile = projectGodotPath(parsed.value.projectPath);
    const { settings: allSettings, warnings: parseWarnings } = parseProjectSettings(projectFile);
    if (section.value) {
      const sectionData = Object.hasOwn(allSettings, section.value)
        ? allSettings[section.value]
        : undefined;
      const warnings =
        sectionData === undefined
          ? [
              `Section "${section.value}" is not present in project.godot, so settings is empty`,
              ...parseWarnings,
            ]
          : parseWarnings;
      return createStructuredResponse(
        leadWithWarnings({ warnings, section: section.value, settings: sectionData ?? {} }),
      );
    }
    return createStructuredResponse(
      leadWithWarnings({ warnings: parseWarnings, settings: allSettings }),
    );
  } catch (error: unknown) {
    return err(
      createErrorResponse(`Failed to get project settings: ${getErrorMessage(error)}`, [
        'Check if project.godot is accessible',
      ]),
    );
  }
}
