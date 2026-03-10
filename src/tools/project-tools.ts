import { join, basename } from 'path';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import {
  GodotRunner,
  normalizeParameters,
  validatePath,
  createErrorResponse,
  logDebug,
  OperationParams,
  ToolDefinition,
} from '../utils/godot-runner.js';

// --- Autoload / project.godot helpers (no Godot process needed) ---

interface AutoloadEntry {
  name: string;
  path: string;
  singleton: boolean;
}

function parseAutoloads(projectFilePath: string): AutoloadEntry[] {
  const content = readFileSync(projectFilePath, 'utf8');
  const autoloads: AutoloadEntry[] = [];
  let inAutoloadSection = false;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inAutoloadSection = trimmed === '[autoload]';
      continue;
    }
    if (!inAutoloadSection || trimmed === '' || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^(\w+)="(\*?)([^"]*)"$/);
    if (match) {
      autoloads.push({ name: match[1], singleton: match[2] === '*', path: match[3] });
    }
  }
  return autoloads;
}

function normalizeAutoloadPath(p: string): string {
  return p.startsWith('res://') ? p : `res://${p}`;
}

function addAutoloadEntry(projectFilePath: string, name: string, path: string, singleton: boolean): void {
  const content = readFileSync(projectFilePath, 'utf8');
  const lines = content.split('\n');
  const entry = `${name}="${singleton ? '*' : ''}${normalizeAutoloadPath(path)}"`;

  const sectionIdx = lines.findIndex(l => l.trim() === '[autoload]');
  if (sectionIdx === -1) {
    writeFileSync(projectFilePath, content.trimEnd() + '\n\n[autoload]\n' + entry + '\n', 'utf8');
    return;
  }

  let insertIdx = sectionIdx + 1;
  while (insertIdx < lines.length && !lines[insertIdx].trim().startsWith('[')) {
    insertIdx++;
  }
  lines.splice(insertIdx, 0, entry);
  writeFileSync(projectFilePath, lines.join('\n'), 'utf8');
}

function removeAutoloadEntry(projectFilePath: string, name: string): boolean {
  const content = readFileSync(projectFilePath, 'utf8');
  const lines = content.split('\n');
  let inAutoloadSection = false;
  let removed = false;

  const newLines = lines.filter(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) { inAutoloadSection = trimmed === '[autoload]'; return true; }
    if (inAutoloadSection) {
      const match = trimmed.match(/^(\w+)=/);
      if (match && match[1] === name) { removed = true; return false; }
    }
    return true;
  });

  if (removed) writeFileSync(projectFilePath, newLines.join('\n'), 'utf8');
  return removed;
}

function updateAutoloadEntry(projectFilePath: string, name: string, newPath?: string, singleton?: boolean): boolean {
  const content = readFileSync(projectFilePath, 'utf8');
  const lines = content.split('\n');
  let inAutoloadSection = false;
  let updated = false;

  const newLines = lines.map(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) { inAutoloadSection = trimmed === '[autoload]'; return line; }
    if (inAutoloadSection) {
      const match = trimmed.match(/^(\w+)="(\*?)([^"]*)"$/);
      if (match && match[1] === name) {
        const effectiveSingleton = singleton !== undefined ? singleton : match[2] === '*';
        const effectivePath = newPath !== undefined ? normalizeAutoloadPath(newPath) : match[3];
        updated = true;
        return `${name}="${effectiveSingleton ? '*' : ''}${effectivePath}"`;
      }
    }
    return line;
  });

  if (updated) writeFileSync(projectFilePath, newLines.join('\n'), 'utf8');
  return updated;
}

// --- Tool definitions ---

export const projectToolDefinitions: ToolDefinition[] = [
  {
    name: 'launch_editor',
    description: 'Open the Godot editor GUI for a project. The editor is a display application — it cannot be controlled programmatically and returns immediately. For headless project modification, use manage_scene and manage_node instead.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Path to the Godot project directory',
        },
      },
      required: ['projectPath'],
    },
  },
  {
    name: 'run_project',
    description: 'Run a Godot project in debug mode. Required before calling take_screenshot, simulate_input, get_ui_elements, run_script, or get_debug_output. After starting, wait 2–3 seconds for the MCP bridge to initialize before using those tools. Call stop_project when done.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Path to the Godot project directory',
        },
        scene: {
          type: 'string',
          description: 'Scene to run (path relative to project, e.g. "scenes/main.tscn"). Omit to use the project\'s main scene.',
        },
      },
      required: ['projectPath'],
    },
  },
  {
    name: 'get_debug_output',
    description: 'Get stdout/stderr output from the running Godot project. Requires run_project first. Returns the last N lines of output and errors, a running flag, and an exit code if the process has ended. Use this to check GDScript errors, print() calls, and crash messages.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Max lines to return (default: 200, from end of output)',
        },
      },
      required: [],
    },
  },
  {
    name: 'stop_project',
    description: 'Stop the running Godot project and clean up the MCP bridge. Always call this when done with runtime testing — even if the game crashed — to free the process slot so run_project can be called again.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'list_projects',
    description: 'List Godot projects in a directory',
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
    description: 'Retrieve metadata about a Godot project, or just the Godot version if no projectPath is provided',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Path to the Godot project directory (optional — omit to get Godot version only)',
        },
      },
      required: [],
    },
  },
  {
    name: 'take_screenshot',
    description: 'Capture a PNG screenshot of the running Godot viewport. Requires run_project first; wait 2–3 seconds after starting for the bridge to initialize. Returns the image inline. Screenshots are also saved to .mcp/screenshots/ in the project directory.',
    inputSchema: {
      type: 'object',
      properties: {
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds to wait for the screenshot (default: 10000)',
        },
      },
      required: [],
    },
  },
  {
    name: 'simulate_input',
    description: 'Simulate batched sequential input in a running Godot project. Requires run_project first; wait 2–3 seconds after starting. Use get_ui_elements first to discover element names and paths for click_element actions.\n\nEach action object requires a "type" field. Valid types and their specific fields:\n- key: keyboard event (key: string, pressed: bool, shift/ctrl/alt: bool)\n- mouse_button: click at coordinates (x, y: number, button: "left"|"right"|"middle", pressed: bool, double_click: bool)\n- mouse_motion: move cursor (x, y: number, relative_x, relative_y: number)\n- click_element: click a UI element by node path or node name (element: string, button, double_click)\n- action: fire a Godot input action (action: string, pressed: bool, strength: 0–1)\n- wait: pause between actions (ms: number)',
    inputSchema: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          description: 'Array of input actions to execute sequentially. Each object must have a "type" field.',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['key', 'mouse_button', 'mouse_motion', 'click_element', 'action', 'wait'],
                description: 'The type of input action',
              },
              key: { type: 'string', description: '[key] Key name (e.g. "W", "Space", "Escape", "Up")' },
              pressed: { type: 'boolean', description: '[key, mouse_button, action] Whether the input is pressed (true) or released (false)' },
              shift: { type: 'boolean', description: '[key] Shift modifier' },
              ctrl: { type: 'boolean', description: '[key] Ctrl modifier' },
              alt: { type: 'boolean', description: '[key] Alt modifier' },
              button: { type: 'string', enum: ['left', 'right', 'middle'], description: '[mouse_button, click_element] Mouse button (default: left)' },
              x: { type: 'number', description: '[mouse_button, mouse_motion] X position in viewport pixels' },
              y: { type: 'number', description: '[mouse_button, mouse_motion] Y position in viewport pixels' },
              relative_x: { type: 'number', description: '[mouse_motion] Relative X movement in pixels' },
              relative_y: { type: 'number', description: '[mouse_motion] Relative Y movement in pixels' },
              double_click: { type: 'boolean', description: '[mouse_button, click_element] Double click' },
              element: { type: 'string', description: '[click_element] Identifies the UI element to click. Accepts: absolute node path (e.g. "/root/HUD/Button"), relative node path, or node name (BFS matched). Use get_ui_elements to discover valid names and paths.' },
              action: { type: 'string', description: '[action] Godot input action name (as defined in Project Settings > Input Map)' },
              strength: { type: 'number', description: '[action] Action strength (0–1, default 1.0)' },
              ms: { type: 'number', description: '[wait] Duration in milliseconds to pause before the next action' },
            },
            required: ['type'],
          },
        },
      },
      required: ['actions'],
    },
  },
  {
    name: 'get_ui_elements',
    description: 'Get Control nodes from a running Godot project with their positions, sizes, types, and text. Requires run_project first; wait 2–3 seconds after starting. Call this before simulate_input with click_element to discover valid element names and paths. Returns: { elements: [{ name, path, type, rect: {x,y,width,height}, visible, text? (Button/Label/LineEdit/TextEdit), disabled? (buttons), tooltip? }] }',
    inputSchema: {
      type: 'object',
      properties: {
        visibleOnly: {
          type: 'boolean',
          description: 'Only return nodes where Control.visible is true (default: true). Set false to include hidden elements.',
        },
        filter: {
          type: 'string',
          description: 'Filter by Control node type (e.g. "Button", "Label", "LineEdit")',
        },
      },
      required: [],
    },
  },
  {
    name: 'run_script',
    description: 'Execute a custom GDScript in the live running project with full scene tree access. Requires run_project first. Script must extend RefCounted and define func execute(scene_tree: SceneTree) -> Variant. Return values are JSON-serialized (primitives, Vector2/3, Color, Dictionary, Array, and Node path strings are supported). Use print() for debug output — it appears in get_debug_output, not in the script result.',
    inputSchema: {
      type: 'object',
      properties: {
        script: {
          type: 'string',
          description: 'GDScript source code. Must contain "extends RefCounted" and "func execute(scene_tree: SceneTree) -> Variant".',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in ms (default: 30000). Increase for long-running scripts.',
        },
      },
      required: ['script'],
    },
  },
  {
    name: 'manage_project',
    description: `Manage Godot project settings and autoloads by directly editing project.godot. No Godot process required — safe to use even when the project has broken autoloads.

⚠️  AUTOLOAD LIMITATION: Never use headless Godot tools (manage_scene, manage_node, etc.) to add or configure autoloads. Running headless initializes ALL existing autoloads — if any are broken or require a display, the process fails. Always use manage_project for autoload management.

Operations:
- list_autoloads: List all registered autoloads with paths and singleton status
- add_autoload: Register a new autoload (required: autoloadName, autoloadPath; optional: singleton, default true)
- remove_autoload: Unregister an autoload by name (required: autoloadName)
- update_autoload: Modify an existing autoload's path or singleton flag (required: autoloadName; optional: autoloadPath, singleton)`,
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['list_autoloads', 'add_autoload', 'remove_autoload', 'update_autoload'],
          description: 'The project operation to perform',
        },
        projectPath: {
          type: 'string',
          description: 'Path to the Godot project directory',
        },
        autoloadName: {
          type: 'string',
          description: '[add/remove/update_autoload] Name of the autoload node (e.g. "MyManager")',
        },
        autoloadPath: {
          type: 'string',
          description: '[add/update_autoload] Path to the script or scene (e.g. "res://autoload/my_manager.gd" or "autoload/my_manager.gd")',
        },
        singleton: {
          type: 'boolean',
          description: '[add/update_autoload] Register as a globally accessible singleton by name (default: true)',
        },
      },
      required: ['operation', 'projectPath'],
    },
  },
];

function findGodotProjects(directory: string, recursive: boolean): Array<{ path: string; name: string }> {
  const projects: Array<{ path: string; name: string }> = [];

  try {
    const projectFile = join(directory, 'project.godot');
    if (existsSync(projectFile)) {
      projects.push({
        path: directory,
        name: basename(directory),
      });
    }

    if (!recursive) {
      const entries = readdirSync(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (entry.name.startsWith('.')) continue;
          const subdir = join(directory, entry.name);
          const subProjectFile = join(subdir, 'project.godot');
          if (existsSync(subProjectFile)) {
            projects.push({
              path: subdir,
              name: entry.name,
            });
          }
        }
      }
    } else {
      const entries = readdirSync(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const subdir = join(directory, entry.name);
          if (entry.name.startsWith('.')) {
            continue;
          }
          const subProjectFile = join(subdir, 'project.godot');
          if (existsSync(subProjectFile)) {
            projects.push({
              path: subdir,
              name: entry.name,
            });
          } else {
            const subProjects = findGodotProjects(subdir, true);
            projects.push(...subProjects);
          }
        }
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
          const ext = entry.name.split('.').pop()?.toLowerCase();

          if (ext === 'tscn') {
            structure.scenes++;
          } else if (ext === 'gd' || ext === 'gdscript' || ext === 'cs') {
            structure.scripts++;
          } else if (['png', 'jpg', 'jpeg', 'webp', 'svg', 'ttf', 'wav', 'mp3', 'ogg'].includes(ext || '')) {
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

export async function handleLaunchEditor(runner: GodotRunner, args: OperationParams) {
  args = normalizeParameters(args);

  if (!args.projectPath) {
    return createErrorResponse(
      'Project path is required',
      ['Provide a valid path to a Godot project directory']
    );
  }

  if (!validatePath(args.projectPath as string)) {
    return createErrorResponse(
      'Invalid project path',
      ['Provide a valid path without ".." or other potentially unsafe characters']
    );
  }

  try {
    const godotPath = runner.getGodotPath();
    if (!godotPath) {
      await runner.detectGodotPath();
      if (!runner.getGodotPath()) {
        return createErrorResponse(
          'Could not find a valid Godot executable path',
          ['Ensure Godot is installed correctly', 'Set GODOT_PATH environment variable']
        );
      }
    }

    const projectFile = join(args.projectPath as string, 'project.godot');
    if (!existsSync(projectFile)) {
      return createErrorResponse(
        `Not a valid Godot project: ${args.projectPath}`,
        ['Ensure the path points to a directory containing a project.godot file', 'Use list_projects to find valid Godot projects']
      );
    }

    logDebug(`Launching Godot editor for project: ${args.projectPath}`);
    const process = runner.launchEditor(args.projectPath as string);

    process.on('error', (err: Error) => {
      console.error('Failed to start Godot editor:', err);
    });

    return {
      content: [{ type: 'text', text: `Godot editor launched successfully for project at ${args.projectPath}.\nNote: the editor is a GUI application and cannot be controlled programmatically. Use manage_scene and manage_node to modify the project headlessly without the editor.` }],
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(
      `Failed to launch Godot editor: ${errorMessage}`,
      ['Ensure Godot is installed correctly', 'Check if the GODOT_PATH environment variable is set correctly']
    );
  }
}

export async function handleRunProject(runner: GodotRunner, args: OperationParams) {
  args = normalizeParameters(args);

  if (!args.projectPath) {
    return createErrorResponse(
      'Project path is required',
      ['Provide a valid path to a Godot project directory']
    );
  }

  if (!validatePath(args.projectPath as string)) {
    return createErrorResponse(
      'Invalid project path',
      ['Provide a valid path without ".." or other potentially unsafe characters']
    );
  }

  try {
    const projectFile = join(args.projectPath as string, 'project.godot');
    if (!existsSync(projectFile)) {
      return createErrorResponse(
        `Not a valid Godot project: ${args.projectPath}`,
        ['Ensure the path points to a directory containing a project.godot file', 'Use list_projects to find valid Godot projects']
      );
    }

    runner.runProject(args.projectPath as string, args.scene as string | undefined);

    return {
      content: [{ type: 'text', text: [
        'Godot project started in debug mode.',
        '- Use get_debug_output to check runtime output and errors',
        '- Wait 2–3 seconds before calling take_screenshot, simulate_input, get_ui_elements, or run_script (bridge needs time to initialize)',
        '- Always call stop_project when done — it terminates the process and cleans up the MCP bridge',
      ].join('\n') }],
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(
      `Failed to run Godot project: ${errorMessage}`,
      ['Ensure Godot is installed correctly', 'Check if the GODOT_PATH environment variable is set correctly']
    );
  }
}

export function handleGetDebugOutput(runner: GodotRunner, args: OperationParams = {}) {
  args = normalizeParameters(args);

  if (!runner.activeProcess) {
    return createErrorResponse(
      'No active Godot process.',
      ['Use run_project to start a Godot project first', 'Check if the Godot process crashed unexpectedly']
    );
  }

  const limit = typeof args.limit === 'number' ? args.limit : 200;
  const proc = runner.activeProcess;
  const response: {
    output: string[];
    errors: string[];
    running: boolean;
    exitCode?: number | null;
  } = {
    output: proc.output.slice(-limit),
    errors: proc.errors.slice(-limit),
    running: !proc.hasExited,
  };

  if (proc.hasExited) {
    response.exitCode = proc.exitCode;
    (response as typeof response & { tip: string }).tip =
      'Process has exited. Call stop_project to clean up the process slot before starting a new one.';
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(response),
    }],
  };
}

export function handleStopProject(runner: GodotRunner) {
  const result = runner.stopProject();

  if (!result) {
    return createErrorResponse(
      'No active Godot process to stop.',
      ['Use run_project to start a Godot project first', 'The process may have already terminated']
    );
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        message: 'Godot project stopped',
        finalOutput: result.output.slice(-200),
        finalErrors: result.errors.slice(-200),
      }),
    }],
  };
}

export async function handleListProjects(args: OperationParams) {
  args = normalizeParameters(args);

  if (!args.directory) {
    return createErrorResponse(
      'Directory is required',
      ['Provide a valid directory path to search for Godot projects']
    );
  }

  if (!validatePath(args.directory as string)) {
    return createErrorResponse(
      'Invalid directory path',
      ['Provide a valid path without ".." or other potentially unsafe characters']
    );
  }

  try {
    if (!existsSync(args.directory as string)) {
      return createErrorResponse(
        `Directory does not exist: ${args.directory}`,
        ['Provide a valid directory path that exists on the system']
      );
    }

    const recursive = args.recursive === true;
    const projects = findGodotProjects(args.directory as string, recursive);

    return {
      content: [{ type: 'text', text: JSON.stringify(projects) }],
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(
      `Failed to list projects: ${errorMessage}`,
      ['Ensure the directory exists and is accessible', 'Check if you have permission to read the directory']
    );
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

    if (!validatePath(args.projectPath as string)) {
      return createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    const projectFile = join(args.projectPath as string, 'project.godot');
    if (!existsSync(projectFile)) {
      return createErrorResponse(
        `Not a valid Godot project: ${args.projectPath}`,
        ['Ensure the path points to a directory containing a project.godot file', 'Use list_projects to find valid Godot projects']
      );
    }

    const projectStructure = getProjectStructure(args.projectPath as string);

    let projectName = basename(args.projectPath as string);
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
      content: [{
        type: 'text',
        text: JSON.stringify({
          name: projectName,
          path: args.projectPath,
          godotVersion: version,
          structure: projectStructure,
        }),
      }],
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(
      `Failed to get project info: ${errorMessage}`,
      ['Ensure Godot is installed correctly', 'Check if the GODOT_PATH environment variable is set correctly']
    );
  }
}

export async function handleTakeScreenshot(runner: GodotRunner, args: OperationParams) {
  args = normalizeParameters(args);

  if (!runner.activeProcess || runner.activeProcess.hasExited) {
    return createErrorResponse(
      'No active Godot process. A project must be running to take a screenshot.',
      ['Use run_project to start a Godot project first', 'Wait a few seconds after starting for the game to initialize']
    );
  }

  const timeout = typeof args.timeout === 'number' ? args.timeout : 10000;

  try {
    const responseStr = await runner.sendCommand('screenshot', {}, timeout);

    let parsed: { path?: string; error?: string };
    try {
      parsed = JSON.parse(responseStr);
    } catch {
      return createErrorResponse(
        `Invalid response from screenshot server: ${responseStr}`,
        ['The game may not have fully initialized yet', 'Try again after a few seconds']
      );
    }

    if (parsed.error) {
      return createErrorResponse(
        `Screenshot server error: ${parsed.error}`,
        ['Ensure the game viewport is active', 'Try again after a moment']
      );
    }

    if (!parsed.path) {
      return createErrorResponse(
        'Screenshot server returned no file path',
        ['Try again after a few seconds']
      );
    }

    // Normalize path for the local filesystem (forward slashes from GDScript)
    const screenshotPath = parsed.path.replace(/\//g, join('/', '').charAt(0) === '\\' ? '\\' : '/');

    if (!existsSync(screenshotPath)) {
      return createErrorResponse(
        `Screenshot file not found at: ${screenshotPath}`,
        ['The screenshot may have failed to save', 'Check disk space and permissions']
      );
    }

    const imageBuffer = readFileSync(screenshotPath);
    const base64Data = imageBuffer.toString('base64');

    return {
      content: [
        {
          type: 'image',
          data: base64Data,
          mimeType: 'image/png',
        },
        {
          type: 'text',
          text: `Screenshot saved to: ${parsed.path}`,
        },
      ],
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(
      `Failed to take screenshot: ${errorMessage}`,
      [
        'Ensure the project is running (use run_project first)',
        'Wait 2-3 seconds after starting for the screenshot server to initialize',
        'Check that UDP port 9900 is not blocked',
      ]
    );
  }
}

export async function handleSimulateInput(runner: GodotRunner, args: OperationParams) {
  args = normalizeParameters(args);

  if (!runner.activeProcess || runner.activeProcess.hasExited) {
    return createErrorResponse(
      'No active Godot process. A project must be running to simulate input.',
      ['Use run_project to start a Godot project first', 'Wait a few seconds after starting for the game to initialize']
    );
  }

  const actions = args.actions;
  if (!Array.isArray(actions) || actions.length === 0) {
    return createErrorResponse(
      'actions must be a non-empty array of input actions',
      ['Provide at least one action object with a "type" field']
    );
  }

  // Calculate timeout: sum of all wait durations + 10s buffer
  let totalWaitMs = 0;
  for (const action of actions) {
    if (typeof action === 'object' && action !== null && action.type === 'wait' && typeof action.ms === 'number') {
      totalWaitMs += action.ms;
    }
  }
  const timeoutMs = totalWaitMs + 10000;

  try {
    const responseStr = await runner.sendCommand('input', { actions }, timeoutMs);

    let parsed: { success?: boolean; error?: string; actions_processed?: number };
    try {
      parsed = JSON.parse(responseStr);
    } catch {
      return createErrorResponse(
        `Invalid response from bridge: ${responseStr}`,
        ['The game may not have fully initialized yet', 'Try again after a few seconds']
      );
    }

    if (parsed.error) {
      return createErrorResponse(
        `Input simulation error: ${parsed.error}`,
        ['Check action types and parameters', 'Ensure key names are valid Godot key names']
      );
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          actions_processed: parsed.actions_processed,
          tip: 'Call take_screenshot to verify the input had the intended visual effect.',
        }),
      }],
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(
      `Failed to simulate input: ${errorMessage}`,
      [
        'Ensure the project is running (use run_project first)',
        'Wait 2-3 seconds after starting for the bridge to initialize',
        'Check that UDP port 9900 is not blocked',
      ]
    );
  }
}

export async function handleGetUiElements(runner: GodotRunner, args: OperationParams) {
  args = normalizeParameters(args);

  if (!runner.activeProcess || runner.activeProcess.hasExited) {
    return createErrorResponse(
      'No active Godot process. A project must be running to query UI elements.',
      ['Use run_project to start a Godot project first', 'Wait a few seconds after starting for the game to initialize']
    );
  }

  const visibleOnly = args.visibleOnly !== false;

  try {
    const cmdParams: Record<string, unknown> = { visible_only: visibleOnly };
    if (args.filter) cmdParams.type_filter = args.filter;
    const responseStr = await runner.sendCommand('get_ui_elements', cmdParams);

    let parsed: { elements?: unknown[]; error?: string };
    try {
      parsed = JSON.parse(responseStr);
    } catch {
      return createErrorResponse(
        `Invalid response from bridge: ${responseStr}`,
        ['The game may not have fully initialized yet', 'Try again after a few seconds']
      );
    }

    if (parsed.error) {
      return createErrorResponse(
        `UI element query error: ${parsed.error}`,
        ['Ensure the game has a UI with Control nodes']
      );
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ...parsed,
          tip: "Use simulate_input with type 'click_element' and a node_path or text value from this list to interact with these elements.",
        }),
      }],
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(
      `Failed to get UI elements: ${errorMessage}`,
      [
        'Ensure the project is running (use run_project first)',
        'Wait 2-3 seconds after starting for the bridge to initialize',
        'Check that UDP port 9900 is not blocked',
      ]
    );
  }
}

export async function handleRunScript(runner: GodotRunner, args: OperationParams) {
  args = normalizeParameters(args);

  if (!runner.activeProcess || runner.activeProcess.hasExited) {
    return createErrorResponse(
      'No active Godot process. A project must be running to execute scripts.',
      ['Use run_project to start a Godot project first', 'Wait a few seconds after starting for the game to initialize']
    );
  }

  const script = args.script;
  if (typeof script !== 'string' || script.trim() === '') {
    return createErrorResponse(
      'script is required and must be a non-empty string',
      ['Provide GDScript source code with extends RefCounted and func execute(scene_tree: SceneTree) -> Variant']
    );
  }

  if (!script.includes('func execute')) {
    return createErrorResponse(
      'Script must define func execute(scene_tree: SceneTree) -> Variant',
      ['Add a func execute(scene_tree: SceneTree) -> Variant method to your script']
    );
  }

  // Write script to .mcp/scripts/ for audit trail
  try {
    const projectPath = runner.activeProjectPath;
    if (projectPath) {
      const scriptsDir = join(projectPath, '.mcp', 'scripts');
      mkdirSync(scriptsDir, { recursive: true });
      const timestamp = Date.now();
      const scriptFile = join(scriptsDir, `${timestamp}.gd`);
      writeFileSync(scriptFile, script, 'utf8');
      logDebug(`Saved script to ${scriptFile}`);
    }
  } catch (error) {
    logDebug(`Failed to save script for audit: ${error}`);
  }

  const timeout = typeof args.timeout === 'number' ? args.timeout : 30000;

  try {
    const responseStr = await runner.sendCommand('run_script', { source: script }, timeout);

    let parsed: { success?: boolean; result?: unknown; error?: string };
    try {
      parsed = JSON.parse(responseStr);
    } catch {
      return createErrorResponse(
        `Invalid response from bridge: ${responseStr}`,
        ['The script may have produced non-JSON output', 'Check get_debug_output for print() statements']
      );
    }

    if (parsed.error) {
      return createErrorResponse(
        `Script execution error: ${parsed.error}`,
        ['Check your GDScript syntax', 'Ensure the script extends RefCounted', 'Check get_debug_output for details']
      );
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          result: parsed.result,
          tip: 'Call take_screenshot to verify any visual changes, or get_debug_output to review print() output from your script.',
        }),
      }],
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(
      `Failed to execute script: ${errorMessage}`,
      [
        'Ensure the project is running (use run_project first)',
        'Wait 2-3 seconds after starting for the bridge to initialize',
        'Check that UDP port 9900 is not blocked',
        'For long-running scripts, increase the timeout parameter',
      ]
    );
  }
}

export async function handleManageProject(args: OperationParams) {
  args = normalizeParameters(args);

  const operation = args.operation as string;
  if (!operation) {
    return createErrorResponse('operation is required', ['Provide one of: list_autoloads, add_autoload, remove_autoload, update_autoload']);
  }

  if (!args.projectPath) {
    return createErrorResponse('projectPath is required', ['Provide a valid path to a Godot project directory']);
  }

  if (!validatePath(args.projectPath as string)) {
    return createErrorResponse('Invalid project path', ['Provide a valid path without ".."']);
  }

  const projectFile = join(args.projectPath as string, 'project.godot');
  if (!existsSync(projectFile)) {
    return createErrorResponse(
      `Not a valid Godot project: ${args.projectPath}`,
      ['Ensure the path points to a directory containing a project.godot file']
    );
  }

  try {
    switch (operation) {
      case 'list_autoloads': {
        const autoloads = parseAutoloads(projectFile);
        return { content: [{ type: 'text', text: JSON.stringify({ autoloads }) }] };
      }

      case 'add_autoload': {
        if (!args.autoloadName || !args.autoloadPath) {
          return createErrorResponse(
            'autoloadName and autoloadPath are required for add_autoload',
            ['Provide the autoload node name and the path to the script or scene']
          );
        }
        if (!validatePath(args.autoloadPath as string)) {
          return createErrorResponse('Invalid autoload path', ['Provide a valid path without ".."']);
        }
        const existing = parseAutoloads(projectFile);
        if (existing.some(a => a.name === (args.autoloadName as string))) {
          return createErrorResponse(
            `Autoload '${args.autoloadName}' already exists`,
            ['Use update_autoload to modify an existing autoload', 'Use list_autoloads to see current autoloads']
          );
        }
        const isSingleton = args.singleton !== false;
        addAutoloadEntry(projectFile, args.autoloadName as string, args.autoloadPath as string, isSingleton);
        return {
          content: [{ type: 'text', text: `Autoload '${args.autoloadName}' registered at '${args.autoloadPath}' (singleton: ${isSingleton}).\nWarning: autoloads initialize in headless mode too. If this script has errors or missing dependencies, all manage_scene and manage_node operations will fail with a cryptic crash. Verify by running a simple manage_node get_tree operation — if it fails, use manage_project remove_autoload to remove it.` }],
        };
      }

      case 'remove_autoload': {
        if (!args.autoloadName) {
          return createErrorResponse('autoloadName is required for remove_autoload', ['Provide the name of the autoload to remove']);
        }
        const removed = removeAutoloadEntry(projectFile, args.autoloadName as string);
        if (!removed) {
          return createErrorResponse(
            `Autoload '${args.autoloadName}' not found`,
            ['Use list_autoloads to see existing autoloads']
          );
        }
        return { content: [{ type: 'text', text: `Autoload '${args.autoloadName}' removed successfully.` }] };
      }

      case 'update_autoload': {
        if (!args.autoloadName) {
          return createErrorResponse('autoloadName is required for update_autoload', ['Provide the name of the autoload to update']);
        }
        if (args.autoloadPath && !validatePath(args.autoloadPath as string)) {
          return createErrorResponse('Invalid autoload path', ['Provide a valid path without ".."']);
        }
        const updated = updateAutoloadEntry(
          projectFile,
          args.autoloadName as string,
          args.autoloadPath as string | undefined,
          args.singleton as boolean | undefined
        );
        if (!updated) {
          return createErrorResponse(
            `Autoload '${args.autoloadName}' not found`,
            ['Use list_autoloads to see existing autoloads', 'Use add_autoload to register a new autoload']
          );
        }
        return { content: [{ type: 'text', text: `Autoload '${args.autoloadName}' updated successfully.` }] };
      }

      default:
        return createErrorResponse(
          `Unknown operation: ${operation}`,
          ['Use one of: list_autoloads, add_autoload, remove_autoload, update_autoload']
        );
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(
      `Failed to ${operation}: ${errorMessage}`,
      ['Check if project.godot is accessible and not corrupted']
    );
  }
}

