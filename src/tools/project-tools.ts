import { join, basename, resolve } from 'path';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import type { GodotRunner, RuntimeSessionInfo } from '../utils/godot-runner.js';
import { BRIDGE_PING_TIMEOUT_MS } from '../utils/godot-runner.js';
import type { HandlerResult, OperationParams, ToolDefinition } from '../mcp.types.js';
import { normalizeParameters } from '../utils/parameter-conversion.js';
import { declaredParameters, unknownParameterError } from '../utils/unknown-params.js';
import {
  validatePath,
  projectGodotPath,
  resolveProjectPath,
  projectSubPathError,
} from '../utils/path-validation.js';
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
import { SessionQueueTimeoutError } from '../utils/session-queue.js';
import { logDebug } from '../utils/logger.js';
import { scanTscn } from '../utils/scene-parsing.js';
import {
  checkSettingLiteral,
  describeNonCanonical,
  findSetting,
  godotLiteralFromJson,
  readProjectSettings,
  scanProjectFile,
  settingTargetError,
  writeProjectSetting,
} from '../utils/project-godot.js';
import { engineNewerThanProject } from '../utils/engine-version.js';

function fileExtension(name: string): string {
  const dotIdx = name.lastIndexOf('.');
  return dotIdx >= 0 ? name.slice(dotIdx + 1).toLowerCase() : '';
}

const DEFAULT_SEARCH_MAX_RESULTS = 100;
export const MIN_SEARCH_MAX_RESULTS = 1;

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
      'Find Godot projects under a directory by locating project.godot files. Use when no project is named; to inspect a known one use check_project. recursive: true descends into subdirectories (skipping .git, .godot, node_modules); the default checks the directory and its immediate children. Returns: projects[], each { projectPath, name }, name being config/name else the folder name. warnings leads when a path could not be read or a link was not followed. Errors if directory is not a directory.',
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
              name: {
                type: 'string',
                description: 'config/name from project.godot; the folder name when unset.',
              },
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
            bridgeResponsive: {
              type: ['boolean', 'null'],
              description:
                'Whether the current live session answered a ping. null when the ping was not sent because another runtime operation was still running; diagnostics says which.',
            },
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
      'Return the file tree of a Godot project. Use to discover project structure when paths are unknown. subfolder lists one folder as the root (maxDepth counts from it). extensions filters files (e.g. ["gd","tscn"]) and drops directories with no match; maxDepth -1 is unlimited. Skips dot-prefixed entries. Returns: the root node { name, type, path, children[] }; a child is a file, a directory, or a link (not followed). A directory not opened or unreadable has children null; warnings leads then.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
        subfolder: {
          type: 'string',
          description:
            'Folder inside the project to list instead of the whole project (e.g. "ui/themes" or "res://ui"). Must exist and be a directory. Omit for the project root.',
        },
        maxDepth: {
          type: 'number',
          description:
            'Maximum recursion depth, counted from the listed root. -1 means unlimited (default: -1)',
        },
        extensions: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Filter to only these file extensions (e.g. ["gd", "tscn"]); directories with no match are left out. Omit to include all.',
        },
      },
      required: ['projectPath'],
    },
    outputSchema: FILE_TREE_NODE_SCHEMA,
  },
  {
    name: 'search_project',
    description:
      'Plain-text (substring, not regex) search across project files; the text goes in `pattern`. Default fileTypes ["gd","tscn","cs","gdshader"]; caseSensitive false; maxResults integer >= 1, default 100. Skips hidden entries and .mcp. Returns: matches[] (project-relative file, 1-indexed lineNumber, line), truncated, filesSearched, fileTypes. warnings leads when no file had a searched extension or a path was unreadable. Errors if pattern holds a line break or a parameter is undeclared.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
        pattern: {
          type: 'string',
          description:
            'Plain-text string to search for (required; there is no query or regex parameter)',
        },
        fileTypes: {
          type: 'array',
          items: { type: 'string' },
          description: 'File extensions to search (default: ["gd", "tscn", "cs", "gdshader"])',
        },
        caseSensitive: { type: 'boolean', description: 'Case-sensitive search (default: false)' },
        maxResults: {
          type: 'integer',
          minimum: MIN_SEARCH_MAX_RESULTS,
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
      'Parse project.godot into JSON without launching Godot. Use to inspect display, input and rendering settings. Pass section for one INI section. Returns: settings as { [section]: { [key]: value } }, or { [key]: value } plus section. Strings are unescaped, an empty value is null, complex values stay raw text. Keys before any section are under __global__. warnings leads when the section is absent, a value is unterminated or empty, a line is not as Godot writes it, or a setting is assigned twice.',
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
        warnings: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Present only when there is something to say. One entry names, by line number, every line that is not in the form Godot writes (two statements on a line, a statement after a header, a # line, a value that is not one whole value): the engine may read such a line differently from what settings shows.',
        },
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
  {
    name: 'set_project_setting',
    description:
      'Set one project.godot setting without launching Godot. Pass value (JSON string, number, boolean, array or object, converted to the Godot literal) or literal (raw Godot text, e.g. "Vector2i(1280, 720)" or "2.0"), not both. Rewrites the last assignment in place or adds the key, creating the section if missing; other lines stay byte for byte. Refuses autoload/* (use the autoload tools). Returns: { section, key, value read back, created, sectionCreated, previous? }.',
    annotations: { idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
        section: {
          type: 'string',
          description:
            'INI section, e.g. "display" or "application". Letters, digits and _ . - /, no spaces.',
        },
        key: {
          type: 'string',
          description:
            'Setting key within the section, e.g. "window/size/viewport_width". Same character set as section.',
        },
        value: {
          description:
            'JSON value converted to a Godot literal: a string is quoted, an integer-valued number is an int (write 2 as literal "2.0" for a float), a boolean is true/false, an array becomes [a, b], an object a dictionary. null is not accepted; use literal "null".',
        },
        literal: {
          type: 'string',
          description:
            'Raw Godot literal written as is, on one line, with no trailing comment: "str", 1.5, true, null, [1, 2], {"a": 1} or a constructor such as Vector2i(1, 2) or PackedStringArray("a"). Checked by reading it back as one complete value.',
        },
      },
      required: ['projectPath', 'section', 'key'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        warnings: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Present only when there is something to say, e.g. project.godot has lines not in the form Godot writes.',
        },
        section: { type: 'string' },
        key: { type: 'string' },
        value: {
          type: ['string', 'number', 'boolean', 'null'],
          description:
            'The setting as get_project_settings reads it back after the write: a string unescaped, a number or boolean typed, anything else its raw text.',
        },
        created: {
          type: 'boolean',
          description:
            'True when the key was added, false when an existing assignment was rewritten.',
        },
        sectionCreated: {
          type: 'boolean',
          description: 'True when the section did not exist and was appended.',
        },
        previous: {
          type: ['string', 'number', 'boolean', 'null'],
          description: 'The value that was replaced; absent when created.',
        },
      },
      required: ['section', 'key', 'value', 'created', 'sectionCreated'],
    },
  },
] as const satisfies readonly ToolDefinition[];

const PROJECT_SCAN_BLACKLIST = new Set([
  '.git',
  '.godot',
  '.mcp',
  '.claude',
  'node_modules',
  '.svn',
  '.hg',
]);

const EXT_RESOURCE_HEADER_PATTERN = /^\[\s*ext_resource\b/;

const APPLICATION_SECTION = 'application';
const CONFIG_NAME_KEY = 'config/name';

const UNLIMITED_DEPTH = -1;

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

/** The project's `application/config/name`, else `fallback` (absent, empty, not a string, or the file unreadable). */
function readProjectName(projectFile: string, fallback: string): string {
  try {
    const nameSetting = findSetting(
      scanProjectFile(readFileSync(projectFile, 'utf8')),
      APPLICATION_SECTION,
      CONFIG_NAME_KEY,
    );
    if (typeof nameSetting?.value === 'string' && nameSetting.value !== '') {
      return nameSetting.value;
    }
  } catch (error) {
    logDebug(`Error reading project file: ${error}`);
  }
  return fallback;
}

function findGodotProjects(
  directory: string,
  recursive: boolean,
  problems: WalkProblems,
): Array<{ path: string; name: string }> {
  const projects: Array<{ path: string; name: string }> = [];

  if (existsSync(projectGodotPath(directory))) {
    projects.push({
      path: directory,
      name: readProjectName(projectGodotPath(directory), basename(directory)),
    });
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
      projects.push({
        path: subdir,
        name: readProjectName(projectGodotPath(subdir), entry.name),
      });
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
      const child = buildFilesystemTree(
        join(currentPath, entry.name),
        childRelPath,
        maxDepth,
        currentDepth + 1,
        extensions,
        walk,
      );
      // Under a filter a directory that was opened and holds no match is noise; one not opened (children null) stays, its content is unknown.
      if (extensions && child.children?.length === 0) continue;
      children.push(child);
    } else if (entry.isFile()) {
      const ext = fileExtension(entry.name);
      if (extensions && !extensions.includes(ext)) continue;
      children.push({ name: entry.name, type: 'file', path: childRelPath, extension: ext });
    }
  }
  node.children = children;
  return node;
}

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
            // A match past the limit is what makes the result truncated.
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

export async function handleListProjects(args: OperationParams): Promise<HandlerResult> {
  args = normalizeParameters(args);

  const directory = requireString(args, 'directory');
  if (!directory.ok) return directory;

  if (!validatePath(directory.value)) {
    return err(
      createErrorResponse('Invalid directory path', [
        'Provide the path of the directory to search, without a ".." segment',
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

// A failed or timed-out ping downgrades bridgeResponsive and adds a diagnostic; it never turns the call into an error.
// A live session's status read and ping hold the session queue so the one reported is the one pinged; if the queue is not free in time, read without it with bridgeResponsive null.
async function buildRuntimeReport(
  runner: GodotRunner,
  askedProjectPath: string | null,
): Promise<Record<string, unknown>> {
  if (runner.getRuntimeSessionStatus().state !== 'live') {
    return describeRuntime(runner, askedProjectPath, null);
  }
  try {
    return await runner.runExclusive('check_project', () =>
      describeRuntime(runner, askedProjectPath, null),
    );
  } catch (error: unknown) {
    if (!(error instanceof SessionQueueTimeoutError)) throw error;
    return describeRuntime(runner, askedProjectPath, `Bridge not pinged: ${error.message}`);
  }
}

/** `pingSkipped` is null to ping a live current session, else the reason no ping is sent. */
async function describeRuntime(
  runner: GodotRunner,
  askedProjectPath: string | null,
  pingSkipped: string | null,
): Promise<Record<string, unknown>> {
  const status = runner.getRuntimeSessionStatus();
  const current = status.current;
  const diagnostics: string[] = [];
  let runtime: Record<string, unknown>;
  if (current === null) {
    runtime = { activeSession: false };
  } else if (status.state === 'live') {
    runtime = { activeSession: true, sessionMode: current.mode };
    if (pingSkipped !== null) {
      runtime.bridgeResponsive = null;
      diagnostics.push(pingSkipped);
    } else {
      try {
        // A failed ping reports bridgeResponsive:false without ending the session: ping is exempt from the attached-mode disconnect probe (DISCONNECT_EXEMPT_BRIDGE_COMMANDS in godot-runner.ts).
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

    const projectName = readProjectName(projectFile, basename(parsed.value.projectPath));

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

    const subfolderResult = optionalString(args, 'subfolder');
    if (!subfolderResult.ok) return subfolderResult;
    let scopePath: string = parsed.value.projectPath;
    let scopeRelPath = '';
    if (subfolderResult.value !== undefined) {
      const resolved = resolveProjectPath(parsed.value.projectPath, subfolderResult.value, 'read');
      if (
        resolved === null ||
        resolved.relPath.split('/').some((segment) => segment.startsWith('.'))
      ) {
        return err(
          createErrorResponse(projectSubPathError('subfolder', subfolderResult.value), [
            'Pass a folder inside the project, such as "ui" or "res://ui/themes", with no dot-prefixed segment',
            'Omit subfolder to list the whole project',
          ]),
        );
      }
      if (!existsSync(resolved.absPath) || !statSync(resolved.absPath).isDirectory()) {
        return err(
          createErrorResponse(`subfolder is not a directory in the project: ${resolved.resPath}`, [
            'Check the folder name; get_project_files without subfolder lists the top level',
          ]),
        );
      }
      scopePath = resolved.absPath;
      scopeRelPath = resolved.relPath;
    }

    const walk: TreeWalk = { problems: newWalkProblems(), depthCut: false };
    const tree = buildFilesystemTree(scopePath, scopeRelPath, maxDepth, 0, extensions, walk);
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

/** Names agents have reached for in place of `pattern`. */
const SEARCH_PROJECT_ALIASES = {
  query: 'pattern',
  regex: 'pattern',
  text: 'pattern',
  search: 'pattern',
  term: 'pattern',
  needle: 'pattern',
  q: 'pattern',
  string: 'pattern',
} as const;

export async function handleSearchProject(args: OperationParams): Promise<HandlerResult> {
  args = normalizeParameters(args);
  const parsed = parseProjectArgs(args);
  if (!parsed.ok) return parsed;

  const searchDefinition = projectToolDefinitions.find((d) => d.name === 'search_project')!;
  const unknownParameter = unknownParameterError(args, declaredParameters(searchDefinition), {
    aliases: SEARCH_PROJECT_ALIASES,
  });
  if (unknownParameter) return err(unknownParameter);

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
    // "Exists under the project" is only known when the whole tree was read; with an unreadable path or unfollowed link the claim is limited to what the walk reached.
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
  const parsed = parseSceneArgs(args, 'read');
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
      leadWithWarnings({ warnings, scenePath: scene.relPath, dependencies }),
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

export async function handleSetProjectSetting(args: OperationParams): Promise<HandlerResult> {
  args = normalizeParameters(args);
  const parsed = parseProjectArgs(args);
  if (!parsed.ok) return parsed;

  const section = requireString(args, 'section');
  if (!section.ok) return section;
  const key = requireString(args, 'key');
  if (!key.ok) return key;
  const literalArg = optionalString(args, 'literal');
  if (!literalArg.ok) return literalArg;

  const targetError = settingTargetError(section.value, key.value);
  if (targetError !== null) {
    return err(
      createErrorResponse(`Cannot set ${section.value}/${key.value}: ${targetError}`, [
        'Use get_project_settings to see the sections and keys that exist',
      ]),
    );
  }

  const hasValue = args.value !== undefined;
  const hasLiteral = literalArg.value !== undefined;
  if (hasValue === hasLiteral) {
    return err(
      createErrorResponse(
        hasValue
          ? 'Pass either value or literal, not both'
          : 'Pass value (a JSON value) or literal (raw Godot text)',
        ['Use value for strings, numbers, booleans, arrays and objects; literal for typed values'],
      ),
    );
  }

  let literal: string;
  if (hasLiteral) {
    literal = literalArg.value!.trim();
  } else {
    try {
      literal = godotLiteralFromJson(args.value);
    } catch (error: unknown) {
      return err(
        createErrorResponse(getErrorMessage(error), ['Use literal for a raw Godot value']),
      );
    }
  }
  const literalError = checkSettingLiteral(literal);
  if (literalError !== null) {
    return err(
      createErrorResponse(`Cannot set ${section.value}/${key.value}: ${literalError}`, [
        'Write one complete Godot value on a single line',
      ]),
    );
  }

  try {
    const projectFile = projectGodotPath(parsed.value.projectPath);
    const content = readFileSync(projectFile, 'utf8');
    const nonCanonical = describeNonCanonical(scanProjectFile(content));
    const written = writeProjectSetting(projectFile, section.value, key.value, literal, content);

    const readBack = findSetting(
      scanProjectFile(readFileSync(projectFile, 'utf8')),
      section.value,
      key.value,
    );
    if (readBack === undefined || readBack.raw !== literal) {
      return err(
        createErrorResponse(
          `Setting ${section.value}/${key.value} was written but does not read back as written`,
          ['Open project.godot and check the line for a malformed neighbour'],
        ),
      );
    }
    return createStructuredResponse(
      leadWithWarnings({
        warnings: nonCanonical === null ? [] : [nonCanonical],
        section: section.value,
        key: key.value,
        value: readBack.value,
        created: written.created,
        sectionCreated: written.sectionCreated,
        ...(written.created ? {} : { previous: written.previous }),
      }),
    );
  } catch (error: unknown) {
    return err(
      createErrorResponse(`Failed to set project setting: ${getErrorMessage(error)}`, [
        'Check if project.godot is accessible',
      ]),
    );
  }
}
