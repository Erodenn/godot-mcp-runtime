import { join, basename } from 'path';
import { existsSync, readdirSync, readFileSync } from 'fs';
import type { GodotRunner, OperationParams, ToolDefinition } from '../utils/godot-runner.js';
import {
  normalizeParameters,
  validatePath,
  validateProjectArgs,
  createErrorResponse,
  logDebug,
} from '../utils/godot-runner.js';

// --- Tool definitions ---

export const projectToolDefinitions: ToolDefinition[] = [
  {
    name: 'list_projects',
    description:
      'Find Godot projects under a directory by locating project.godot files. Use to discover available projects when the user has not specified one; for inspecting a known project, use get_project_info. recursive:true descends into subdirectories (skipping hidden ones); default false checks only the directory itself and its immediate children. Returns { projects: [{ path, name }] }, empty array on no matches.',
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
  },
  {
    name: 'get_project_info',
    description:
      'Get metadata about a Godot project: name, path, Godot version, and a structure summary (counts of scenes/scripts/assets/other). Omit projectPath to get just the Godot version (useful for capability checks). Returns { name, path, godotVersion, structure } or { godotVersion } when projectPath is omitted. Errors if projectPath is set but lacks project.godot.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description:
            'Path to the Godot project directory (optional — omit to get Godot version only)',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_project_files',
    description:
      'Return a recursive file tree of a Godot project as nested { name, type, path, extension?, children? } objects. Use to discover project structure when paths are unknown. Pass extensions to filter (e.g. ["gd","tscn"]); maxDepth caps recursion (-1 unlimited). Skips hidden (dot-prefixed) entries and the .mcp directory.',
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
  },
  {
    name: 'search_project',
    description:
      'Plain-text (substring) search across project files. Use to find references, callers, or signatures across the codebase. Default fileTypes is ["gd","tscn","cs","gdshader"]; caseSensitive default false; maxResults default 100 (truncated:true if hit). Returns { matches: [{ file, lineNumber, line }], truncated }. Skips hidden entries and the .mcp directory.',
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
  },
  {
    name: 'get_scene_dependencies',
    description:
      'Parse a .tscn file for ext_resource references (scripts, textures, subscenes). Use to inspect what a scene depends on before refactoring or moving files. Returns { scene, dependencies: [{ path, type, uid? }] }. Errors if scene file does not exist.',
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
  },
  {
    name: 'get_project_settings',
    description:
      'Parse project.godot into structured JSON. Use to inspect configured display, input, rendering, etc. settings without launching Godot. Pass section to filter to one INI section (e.g. "display", "application"). Returns { settings: { [section]: { [key]: value } } } or { settings: { [key]: value } } when section is given. Complex Godot types are returned as raw strings; keys outside any section appear under __global__.',
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
  },
];

// --- Helpers ---

function findGodotProjects(
  directory: string,
  recursive: boolean,
): Array<{ path: string; name: string }> {
  const projects: Array<{ path: string; name: string }> = [];

  try {
    const projectFile = join(directory, 'project.godot');
    if (existsSync(projectFile)) {
      projects.push({
        path: directory,
        name: basename(directory),
      });
    }

    const entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const subdir = join(directory, entry.name);
      if (existsSync(join(subdir, 'project.godot'))) {
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
          const dotIdx = entry.name.lastIndexOf('.');
          const ext = dotIdx >= 0 ? entry.name.slice(dotIdx + 1).toLowerCase() : '';

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
        const dotIdx = entry.name.lastIndexOf('.');
        const ext = dotIdx >= 0 ? entry.name.slice(dotIdx + 1).toLowerCase() : '';
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
        const dotIdx = entry.name.lastIndexOf('.');
        const ext = dotIdx >= 0 ? entry.name.slice(dotIdx + 1).toLowerCase() : '';
        if (!fileTypes.includes(ext)) continue;
        let content: string;
        try {
          content = readFileSync(fullPath, 'utf8');
        } catch {
          continue;
        }
        const lines = content.split('\n');
        const needle = caseSensitive ? pattern : pattern.toLowerCase();
        for (let i = 0; i < lines.length; i++) {
          const haystack = caseSensitive ? lines[i] : lines[i].toLowerCase();
          if (haystack.includes(needle)) {
            matches.push({ file: childRelPath, lineNumber: i + 1, line: lines[i] });
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

type SettingsValue = string | number | boolean;

function parseProjectSettings(
  projectFilePath: string,
): Record<string, Record<string, SettingsValue>> {
  const content = readFileSync(projectFilePath, 'utf8');
  const result: Record<string, Record<string, SettingsValue>> = {};
  let currentSection = '__global__';

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith(';') || line.startsWith('#')) continue;
    if (line.startsWith('config_version')) continue; // header line
    if (line.startsWith('[') && line.endsWith(']')) {
      currentSection = line.slice(1, -1);
      continue;
    }
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    const rawVal = line.slice(eqIdx + 1).trim();
    let value: SettingsValue;
    if (rawVal.startsWith('"') && rawVal.endsWith('"')) {
      value = rawVal.slice(1, -1);
    } else if (rawVal === 'true') {
      value = true;
    } else if (rawVal === 'false') {
      value = false;
    } else {
      const num = Number(rawVal);
      value = isNaN(num) ? rawVal : num;
    }
    if (!result[currentSection]) result[currentSection] = {};
    result[currentSection][key] = value;
  }
  return result;
}

// --- Handlers ---

export async function handleListProjects(args: OperationParams) {
  args = normalizeParameters(args);

  if (!args.directory) {
    return createErrorResponse('Directory is required', [
      'Provide a valid directory path to search for Godot projects',
    ]);
  }

  if (!validatePath(args.directory as string)) {
    return createErrorResponse('Invalid directory path', [
      'Provide a valid path without ".." or other potentially unsafe characters',
    ]);
  }

  try {
    if (!existsSync(args.directory as string)) {
      return createErrorResponse(`Directory does not exist: ${args.directory}`, [
        'Provide a valid directory path that exists on the system',
      ]);
    }

    const recursive = args.recursive === true;
    const projects = findGodotProjects(args.directory as string, recursive);

    return {
      content: [{ type: 'text', text: JSON.stringify(projects) }],
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Failed to list projects: ${errorMessage}`, [
      'Ensure the directory exists and is accessible',
      'Check if you have permission to read the directory',
    ]);
  }
}

export async function handleGetProjectInfo(runner: GodotRunner, args: OperationParams) {
  args = normalizeParameters(args);

  try {
    const version = await runner.getVersion();

    // If no project path, return just the Godot version
    if (!args.projectPath) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ godotVersion: version }) }],
      };
    }

    const v = validateProjectArgs(args);
    if ('isError' in v) return v;

    const projectFile = join(v.projectPath, 'project.godot');
    const projectStructure = getProjectStructure(v.projectPath);

    let projectName = basename(v.projectPath);
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

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            name: projectName,
            path: v.projectPath,
            godotVersion: version,
            structure: projectStructure,
          }),
        },
      ],
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Failed to get project info: ${errorMessage}`, [
      'Ensure Godot is installed correctly',
      'Check if the GODOT_PATH environment variable is set correctly',
    ]);
  }
}

export async function handleGetProjectFiles(args: OperationParams) {
  args = normalizeParameters(args);
  const v = validateProjectArgs(args);
  if ('isError' in v) return v;

  try {
    const maxDepth = typeof args.maxDepth === 'number' ? args.maxDepth : -1;
    const extensions = Array.isArray(args.extensions)
      ? (args.extensions as string[]).map((e) => e.toLowerCase().replace(/^\./, ''))
      : null;
    const tree = buildFilesystemTree(v.projectPath, '', maxDepth, 0, extensions);
    return { content: [{ type: 'text', text: JSON.stringify(tree) }] };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Failed to get project files: ${errorMessage}`, [
      'Check if the project directory is accessible',
    ]);
  }
}

export async function handleSearchProject(args: OperationParams) {
  args = normalizeParameters(args);
  const v = validateProjectArgs(args);
  if ('isError' in v) return v;

  if (!args.pattern || typeof args.pattern !== 'string') {
    return createErrorResponse('pattern is required', ['Provide a plain-text search string']);
  }

  try {
    const fileTypes = Array.isArray(args.fileTypes)
      ? (args.fileTypes as string[]).map((e) => e.toLowerCase().replace(/^\./, ''))
      : ['gd', 'tscn', 'cs', 'gdshader'];
    const caseSensitive = args.caseSensitive === true;
    const maxResults = typeof args.maxResults === 'number' ? args.maxResults : 100;
    const result = searchInFiles(
      v.projectPath,
      args.pattern as string,
      fileTypes,
      caseSensitive,
      maxResults,
    );
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Failed to search project: ${errorMessage}`, [
      'Check if the project directory is accessible',
    ]);
  }
}

export async function handleGetSceneDependencies(args: OperationParams) {
  args = normalizeParameters(args);
  const v = validateProjectArgs(args);
  if ('isError' in v) return v;

  if (!args.scenePath || typeof args.scenePath !== 'string') {
    return createErrorResponse('scenePath is required', [
      'Provide a path relative to the project root, e.g. "scenes/main.tscn"',
    ]);
  }
  if (!validatePath(args.scenePath as string)) {
    return createErrorResponse('Invalid scenePath', ['Provide a valid path without ".."']);
  }

  try {
    const sceneFullPath = join(v.projectPath, args.scenePath as string);
    if (!existsSync(sceneFullPath)) {
      return createErrorResponse(`Scene file not found: ${args.scenePath}`, [
        'Verify the path is relative to the project root',
        'Use get_project_files to list available .tscn files',
      ]);
    }
    const sceneContent = readFileSync(sceneFullPath, 'utf8');
    const dependencies: Array<{ path: string; type: string; uid?: string }> = [];
    const extResourcePattern = /^\[ext_resource([^\]]*)\]/gm;
    let match;
    while ((match = extResourcePattern.exec(sceneContent)) !== null) {
      const attrs = match[1];
      const typeMatch = attrs.match(/\btype="([^"]*)"/);
      const pathMatch = attrs.match(/\bpath="([^"]*)"/);
      const uidMatch = attrs.match(/\buid="([^"]*)"/);
      if (pathMatch) {
        const depPath = pathMatch[1].replace(/^res:\/\//, '');
        const dep: { path: string; type: string; uid?: string } = {
          path: depPath,
          type: typeMatch ? typeMatch[1] : 'Unknown',
        };
        if (uidMatch) dep.uid = uidMatch[1];
        dependencies.push(dep);
      }
    }
    return {
      content: [{ type: 'text', text: JSON.stringify({ scene: args.scenePath, dependencies }) }],
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Failed to get scene dependencies: ${errorMessage}`, [
      'Check if the scene file is accessible',
    ]);
  }
}

export async function handleGetProjectSettings(args: OperationParams) {
  args = normalizeParameters(args);
  const v = validateProjectArgs(args);
  if ('isError' in v) return v;

  try {
    const projectFile = join(v.projectPath, 'project.godot');
    const allSettings = parseProjectSettings(projectFile);
    if (args.section && typeof args.section === 'string') {
      const sectionData = allSettings[args.section as string] ?? {};
      return { content: [{ type: 'text', text: JSON.stringify({ settings: sectionData }) }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify({ settings: allSettings }) }] };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Failed to get project settings: ${errorMessage}`, [
      'Check if project.godot is accessible',
    ]);
  }
}
