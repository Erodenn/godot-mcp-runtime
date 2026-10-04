import { join, basename, resolve } from 'path';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
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
import { scanTscn } from '../utils/scene-parsing.js';
import { findSetting, readProjectSettings, scanProjectFile } from '../utils/project-godot.js';
import { engineNewerThanProject } from '../utils/engine-version.js';

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
    type: { type: 'string', enum: ['file', 'dir', 'link'] },
    path: { type: 'string', description: 'Project-relative path; "." for the root.' },
    extension: { type: 'string', description: 'Files only, lower case, no dot.' },
    children: {
      type: ['array', 'null'],
      description:
        'Directories only. Each child has this same shape. Null when the directory was not opened (maxDepth) or could not be read.',
      items: { type: 'object' },
    },
    warnings: {
      type: 'array',
      items: { type: 'string' },
      description: 'Root node only: depth cuts, unreadable paths and links that were not followed.',
    },
  },
  required: ['name', 'type', 'path'],
} as const;

export const projectToolDefinitions = [
  {
    name: 'list_projects',
    description:
      'Find Godot projects under a directory by locating project.godot files. Use when the user has not named a project; to inspect a known one use check_project. recursive: true descends into subdirectories (skipping .git, .godot, .mcp, node_modules and the like); the default checks the directory and its immediate children. Returns: projects[], each { projectPath, name }; empty when none. warnings leads when a path could not be read or a link was not followed. Errors if directory is not a directory.',
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
        warnings: { type: 'array', items: { type: 'string' } },
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
      "Get project metadata and the Godot version, plus a runtime block. runtime.activeSession, sessionMode and bridgeResponsive describe the current session, projectPath its project (null when none), liveSessions all live ones. With projectPath, runtime.project is that project's session: live, exited or none. Returns: { name?, projectPath?, structure?, godotVersion, runtime }; warnings leads if structure is partial or the engine is newer than the project. Errors if projectPath lacks project.godot.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description:
            'Path to the Godot project directory (optional - omit to get Godot version and runtime status only). An empty string is treated as omitted.',
        },
      },
      required: [],
    },
    outputSchema: {
      type: 'object',
      properties: {
        warnings: { type: 'array', items: { type: 'string' } },
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
      'Return the file tree of a Godot project. Use to discover project structure when paths are unknown. extensions filters files (e.g. ["gd","tscn"]); maxDepth caps recursion (-1 is unlimited, else 0 or more). Skips dot-prefixed entries, .mcp included. Returns: the root node { name, type, path, children[] }; a child is a file, a directory, or a link (type "link", not followed). A directory not opened or not readable has children null; warnings leads then.',
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
      'Plain-text (substring) search across project files. Use to find references, callers or signatures. Default fileTypes is ["gd","tscn","cs","gdshader"]; caseSensitive default false; maxResults integer >= 1, default 100. Skips hidden entries and the .mcp directory. Returns: matches[] (project-relative file, 1-indexed lineNumber, line text), truncated, filesSearched and fileTypes. warnings leads when no file had a searched extension or a path could not be read. Errors if pattern holds a line break.',
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
        maxResults: {
          type: 'number',
          description: 'Maximum matches to return, an integer of 1 or more (default: 100)',
        },
      },
      required: ['projectPath', 'pattern'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        warnings: { type: 'array', items: { type: 'string' } },
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
        filesSearched: { type: 'number', description: 'Files read and searched.' },
        fileTypes: {
          type: 'array',
          items: { type: 'string' },
          description: 'The extensions that were searched.',
        },
      },
      required: ['matches', 'truncated', 'filesSearched', 'fileTypes'],
    },
  },
  {
    name: 'get_scene_dependencies',
    description:
      'Parse a .tscn file for ext_resource references (scripts, textures, subscenes). Use to see what a scene depends on before refactoring or moving files. Returns: scenePath and dependencies[], one per ext_resource reference (path, type, optional uid). warnings leads when ext_resource lines could not be read. Errors if the file does not exist or is not a text scene or resource.',
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
        warnings: { type: 'array', items: { type: 'string' } },
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
            'Filter to a specific INI section (e.g. "display", "application"). Omit for all sections; an empty string is treated as omitted.',
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

// --- Walk problems: what a directory walk could not read or did not follow ---

/** A header line the scene scanner could not read but that was meant as a dependency. */
const EXT_RESOURCE_HEADER_PATTERN = /^\[\s*ext_resource\b/;

/** Where Godot keeps the project's display name. */
const APPLICATION_SECTION = 'application';
const CONFIG_NAME_KEY = 'config/name';

/** Matches `search_project` returns when `maxResults` is omitted. */
const DEFAULT_SEARCH_MAX_RESULTS = 100;
/** The smallest `maxResults` that returns anything. */
const MIN_SEARCH_MAX_RESULTS = 1;

/** The maxDepth value that lists every level. */
const UNLIMITED_DEPTH = -1;

/** Longest list of paths quoted in one walk warning; the rest is counted. */
const MAX_WALK_PROBLEMS_SHOWN = 5;

interface WalkProblems {
  unreadable: Array<{ path: string; reason: string }>;
  links: string[];
}

function newWalkProblems(): WalkProblems {
  return { unreadable: [], links: [] };
}

function recordUnreadable(problems: WalkProblems, path: string, error: unknown): void {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  problems.unreadable.push({
    path,
    reason: typeof code === 'string' ? code : getErrorMessage(error),
  });
}

function listWithCap(items: string[]): string {
  const shown = items.slice(0, MAX_WALK_PROBLEMS_SHOWN).join(', ');
  const hidden = items.length - MAX_WALK_PROBLEMS_SHOWN;
  return hidden > 0 ? `${shown} +${hidden} more` : shown;
}

/** One warning per kind of problem; empty when the walk covered everything it met. */
function summarizeWalkProblems(problems: WalkProblems): string[] {
  const warnings: string[] = [];
  if (problems.unreadable.length > 0) {
    const named = problems.unreadable.map((entry) => `${entry.path} (${entry.reason})`);
    warnings.push(
      `${problems.unreadable.length} path(s) could not be read and are missing from this result: ${listWithCap(named)}`,
    );
  }
  if (problems.links.length > 0) {
    warnings.push(
      `${problems.links.length} symbolic link(s) or junction(s) were not followed: ${listWithCap(problems.links)}`,
    );
  }
  return warnings;
}

function findGodotProjects(
  directory: string,
  recursive: boolean,
  problems: WalkProblems,
): Array<{ path: string; name: string }> {
  const projects: Array<{ path: string; name: string }> = [];

  if (existsSync(projectGodotPath(directory))) {
    projects.push({ path: directory, name: basename(directory) });
  }

  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    recordUnreadable(problems, directory, error);
    return projects;
  }
  for (const entry of entries) {
    if (PROJECT_SCAN_BLACKLIST.has(entry.name)) continue;
    const subdir = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      problems.links.push(subdir);
      continue;
    }
    if (!entry.isDirectory()) continue;
    if (existsSync(projectGodotPath(subdir))) {
      projects.push({ path: subdir, name: entry.name });
    } else if (recursive) {
      projects.push(...findGodotProjects(subdir, true, problems));
    }
  }

  return projects;
}

function getProjectStructure(
  projectPath: string,
  problems: WalkProblems,
): {
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

  const scanDirectory = (currentPath: string, relativePath: string) => {
    let entries;
    try {
      entries = readdirSync(currentPath, { withFileTypes: true });
    } catch (error) {
      recordUnreadable(problems, relativePath || '.', error);
      return;
    }

    for (const entry of entries) {
      const entryPath = join(currentPath, entry.name);
      const entryRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

      if (entry.name.startsWith('.')) {
        continue;
      }

      if (entry.isSymbolicLink()) {
        problems.links.push(entryRelativePath);
      } else if (entry.isDirectory()) {
        scanDirectory(entryPath, entryRelativePath);
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
  };

  scanDirectory(projectPath, '');
  return structure;
}

// --- Project helper: filesystem tree ---

interface FileTreeNode {
  name: string;
  type: 'file' | 'dir' | 'link';
  path: string;
  extension?: string;
  /** Null when the directory was not opened (depth limit) or could not be read. */
  children?: FileTreeNode[] | null;
}

interface TreeWalk {
  problems: WalkProblems;
  /** True once a directory was left unopened because of maxDepth. */
  depthCut: boolean;
}

function buildFilesystemTree(
  currentPath: string,
  relativePath: string,
  maxDepth: number,
  currentDepth: number,
  extensions: string[] | null,
  walk: TreeWalk,
): FileTreeNode {
  const name = basename(currentPath);
  const node: FileTreeNode = { name, type: 'dir', path: relativePath || '.' };
  if (maxDepth !== UNLIMITED_DEPTH && currentDepth >= maxDepth) {
    node.children = null;
    walk.depthCut = true;
    return node;
  }
  let entries;
  try {
    entries = readdirSync(currentPath, { withFileTypes: true });
  } catch (error) {
    recordUnreadable(walk.problems, node.path, error);
    node.children = null;
    return node;
  }
  const children: FileTreeNode[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const childRelPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      walk.problems.links.push(childRelPath);
      children.push({ name: entry.name, type: 'link', path: childRelPath });
    } else if (entry.isDirectory()) {
      children.push(
        buildFilesystemTree(
          join(currentPath, entry.name),
          childRelPath,
          maxDepth,
          currentDepth + 1,
          extensions,
          walk,
        ),
      );
    } else if (entry.isFile()) {
      const ext = fileExtension(entry.name);
      if (extensions && !extensions.includes(ext)) continue;
      children.push({ name: entry.name, type: 'file', path: childRelPath, extension: ext });
    }
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
  problems: WalkProblems,
): { matches: SearchMatch[]; truncated: boolean; filesSearched: number; typedFiles: number } {
  const matches: SearchMatch[] = [];
  let truncated = false;
  let filesSearched = 0;
  let typedFiles = 0;

  const searchDir = (currentPath: string, relBase: string) => {
    if (truncated) return;
    let entries;
    try {
      entries = readdirSync(currentPath, { withFileTypes: true });
    } catch (error) {
      recordUnreadable(problems, relBase || '.', error);
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      if (entry.name.startsWith('.')) continue;
      const childRelPath = relBase ? `${relBase}/${entry.name}` : entry.name;
      const fullPath = join(currentPath, entry.name);
      if (entry.isSymbolicLink()) {
        problems.links.push(childRelPath);
      } else if (entry.isDirectory()) {
        searchDir(fullPath, childRelPath);
      } else if (entry.isFile()) {
        const ext = fileExtension(entry.name);
        if (!fileTypes.includes(ext)) continue;
        typedFiles++;
        let content: string;
        try {
          content = readFileSync(fullPath, 'utf8');
        } catch (error) {
          recordUnreadable(problems, childRelPath, error);
          continue;
        }
        filesSearched++;
        const lines = content.split('\n');
        const needle = caseSensitive ? pattern : pattern.toLowerCase();
        for (const [i, line] of lines.entries()) {
          const haystack = caseSensitive ? line : line.toLowerCase();
          if (haystack.includes(needle)) {
            // A match past the limit is what makes the result truncated, so a
            // search with exactly maxResults matches is complete.
            if (matches.length === maxResults) {
              truncated = true;
              return;
            }
            matches.push({ file: childRelPath, lineNumber: i + 1, line });
          }
        }
      }
    }
  };

  searchDir(rootPath, '');
  return { matches, truncated, filesSearched, typedFiles };
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

    if (!statSync(directory.value).isDirectory()) {
      return err(
        createErrorResponse(`Not a directory: ${directory.value}`, [
          'Provide the directory to search, not a file',
        ]),
      );
    }

    const recursive = optionalBoolean(args, 'recursive');
    if (!recursive.ok) return recursive;

    const problems = newWalkProblems();
    const found = findGodotProjects(directory.value, recursive.value === true, problems);
    const rootProblem = problems.unreadable.find((entry) => entry.path === directory.value);
    if (rootProblem !== undefined) {
      return err(
        createErrorResponse(
          `Could not read directory ${directory.value} (${rootProblem.reason}), so nothing was searched`,
          ['Check that you have permission to read the directory'],
        ),
      );
    }
    const projects = found.map((project) => ({
      projectPath: resolve(project.path),
      name: project.name,
    }));
    return createStructuredResponse(
      leadWithWarnings({ warnings: summarizeWalkProblems(problems), projects }),
    );
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
    const structureProblems = newWalkProblems();
    const projectStructure = getProjectStructure(parsed.value.projectPath, structureProblems);

    let projectName = basename(parsed.value.projectPath);
    try {
      const projectFileContent = readFileSync(projectFile, 'utf8');
      const nameSetting = findSetting(
        scanProjectFile(projectFileContent),
        APPLICATION_SECTION,
        CONFIG_NAME_KEY,
      );
      if (typeof nameSetting?.value === 'string' && nameSetting.value !== '') {
        projectName = nameSetting.value;
        logDebug(`Found project name in config: ${projectName}`);
      }
    } catch (error) {
      logDebug(`Error reading project file: ${error}`);
    }

    const newer = engineNewerThanProject(version, parsed.value.projectPath);
    const engineWarnings =
      newer === null
        ? []
        : [
            `Godot ${newer.engine.major}.${newer.engine.minor} is newer than this project's config/features version ${newer.project.major}.${newer.project.minor}: scenes saved through this server may be written in a format the project's engine predates.`,
          ];

    return createStructuredResponse(
      leadWithWarnings({
        warnings: [...summarizeWalkProblems(structureProblems), ...engineWarnings],
        name: projectName,
        projectPath: resolve(parsed.value.projectPath),
        godotVersion: version,
        structure: projectStructure,
        runtime,
      }),
    );
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
    const maxDepth = maxDepthResult.value ?? UNLIMITED_DEPTH;
    if (!Number.isInteger(maxDepth) || maxDepth < UNLIMITED_DEPTH) {
      return err(
        createErrorResponse(`maxDepth must be an integer of ${UNLIMITED_DEPTH} or more`, [
          `Use ${UNLIMITED_DEPTH} for an unlimited listing, or 0 or more to limit the depth`,
        ]),
      );
    }

    const extensionsResult = optionalStringArray(args, 'extensions');
    if (!extensionsResult.ok) return extensionsResult;
    const extensions = extensionsResult.value
      ? extensionsResult.value.map((e) => e.toLowerCase().replace(/^\./, ''))
      : null;

    const walk: TreeWalk = { problems: newWalkProblems(), depthCut: false };
    const tree = buildFilesystemTree(parsed.value.projectPath, '', maxDepth, 0, extensions, walk);
    const warnings = [
      ...(walk.depthCut
        ? [`maxDepth ${maxDepth} cut the listing: directories at that depth have children null`]
        : []),
      ...summarizeWalkProblems(walk.problems),
    ];
    return createStructuredResponse(leadWithWarnings({ warnings, ...tree }));
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
  if (/[\r\n]/.test(pattern.value)) {
    return err(
      createErrorResponse('pattern must not contain a line break: the search matches one line', [
        'Search for one line of the text, or run the search once per line',
      ]),
    );
  }

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
    const maxResults = maxResultsResult.value ?? DEFAULT_SEARCH_MAX_RESULTS;
    if (!Number.isInteger(maxResults) || maxResults < MIN_SEARCH_MAX_RESULTS) {
      return err(
        createErrorResponse(`maxResults must be an integer of ${MIN_SEARCH_MAX_RESULTS} or more`, [
          `Omit maxResults for the default of ${DEFAULT_SEARCH_MAX_RESULTS}, or pass a whole number of ${MIN_SEARCH_MAX_RESULTS} or more`,
        ]),
      );
    }

    const problems = newWalkProblems();
    const result = searchInFiles(
      parsed.value.projectPath,
      pattern.value,
      fileTypes,
      caseSensitive,
      maxResults,
      problems,
    );
    // "Exists under the project" is only known when the whole tree was read.
    // With an unreadable path or a link that was not followed, the claim is
    // limited to what the walk reached.
    const walkWasComplete = problems.unreadable.length === 0 && problems.links.length === 0;
    const searchedTypes = fileTypes.length > 0 ? fileTypes.join(', ') : '(none given)';
    const warnings =
      result.typedFiles === 0
        ? [
            walkWasComplete
              ? `No file with extension(s) ${searchedTypes} exists under the project, so nothing was searched`
              : `No file with extension(s) ${searchedTypes} was found in the part of the project that could be read, so nothing was searched`,
          ]
        : [];
    warnings.push(...summarizeWalkProblems(problems));
    return createStructuredResponse(
      leadWithWarnings({
        warnings,
        matches: result.matches,
        truncated: result.truncated,
        filesSearched: result.filesSearched,
        fileTypes,
      }),
    );
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
    const { scene } = parsed.value;
    const scan = scanTscn(readFileSync(scene.absPath, 'utf8'));
    if (!scan.isTextResource) {
      return err(
        createErrorResponse(`${scene.input} is not a text scene or resource file`, [
          'Binary .scn and .res files cannot be read here; use a .tscn or .tres file',
        ]),
      );
    }
    const dependencies: Array<{ path: string; type: string; uid?: string }> = [];
    const malformedDependencies = scan.malformed.filter((entry) =>
      EXT_RESOURCE_HEADER_PATTERN.test(entry.raw),
    );
    let unreadLines = malformedDependencies.length;
    for (const header of scan.headers) {
      if (header.tag !== 'ext_resource') continue;
      const path = header.attrs.get('path');
      if (path === undefined) {
        unreadLines++;
        continue;
      }
      const dep: { path: string; type: string; uid?: string } = {
        path: path.replace(/^res:\/\//, ''),
        type: header.attrs.get('type') ?? 'Unknown',
      };
      const uid = header.attrs.get('uid');
      if (uid !== undefined) dep.uid = uid;
      dependencies.push(dep);
    }
    const warnings =
      unreadLines > 0
        ? [`${unreadLines} ext_resource line(s) could not be read and are not listed`]
        : [];
    return createStructuredResponse(
      leadWithWarnings({ warnings, scenePath: scene.input, dependencies }),
    );
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
    const { settings: allSettings, warnings: parseWarnings } = readProjectSettings(
      readFileSync(projectFile, 'utf8'),
    );
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
