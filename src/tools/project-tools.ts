import { join, basename, sep } from 'path';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import {
  GodotRunner,
  normalizeParameters,
  validatePath,
  validateProjectArgs,
  createErrorResponse,
  logDebug,
  OperationParams,
  ToolDefinition,
} from '../utils/godot-runner.js';

const MAX_RUNTIME_ERROR_CONTEXT_LINES = 30;

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
    description: 'Open the Godot editor GUI for a project. The editor is a display application — it cannot be controlled programmatically and returns immediately. For headless project modification, use the scene and node editing tools (add_node, set_node_property, etc.) instead.',
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
    description: 'Run a Godot project in debug mode. Preferred path for runtime tools. Required before calling take_screenshot, simulate_input, get_ui_elements, run_script, or get_debug_output unless you intentionally use attach_project for a manually launched game. Verifies MCP bridge readiness before returning success. Call stop_project when done.',
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
        background: {
          type: 'boolean',
          description: 'If true, hides the Godot window off-screen and blocks all physical keyboard and mouse input, while keeping programmatic input (simulate_input, run_script) and screenshots fully active. Useful for automated agent-driven testing where the window should not be visible or interactive.',
        },
      },
      required: ['projectPath'],
    },
  },
  {
    name: 'attach_project',
    description: 'Attach runtime MCP tools to a project without spawning Godot. This injects the McpBridge autoload and marks the project as the active runtime session so you can launch the game manually from your own shell, then use take_screenshot, simulate_input, get_ui_elements, and run_script against that running game. Set waitForBridge to true after launching Godot to block until the bridge is confirmed ready. Use detach_project or stop_project when done. get_debug_output is not available in attached mode because stdout/stderr are not captured.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Path to the Godot project directory',
        },
        waitForBridge: {
          type: 'boolean',
          description: 'If true, poll the bridge until it responds (up to 15 seconds). Use this after Godot is already running to confirm runtime tools are ready. Defaults to false.',
        },
      },
      required: ['projectPath'],
    },
  },
  {
    name: 'detach_project',
    description: 'Clear attached-mode runtime state and remove the injected McpBridge autoload without claiming that the manually launched Godot process was stopped.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_debug_output',
    description: 'Get stdout/stderr output from the running Godot project. Requires run_project first. Returns the last N lines of output and errors, a running flag, and an exit code if the process has ended. In attached mode, this reports that stdout/stderr capture is unavailable because Godot was launched outside MCP.',
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
    description: 'Capture a PNG screenshot of the running Godot viewport. Requires an active runtime session (run_project or attach_project). Returns the image inline. Screenshots are also saved to .mcp/screenshots/ in the project directory.',
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
    description: 'Simulate batched sequential input in a running Godot project. Requires an active runtime session (run_project or attach_project). Use get_ui_elements first to discover element names and paths for click_element actions.\n\nEach action object requires a "type" field. Valid types and their specific fields:\n- key: keyboard event (key: string, pressed: bool, shift/ctrl/alt: bool)\n- mouse_button: click at coordinates (x, y: number, button: "left"|"right"|"middle", pressed: bool, double_click: bool)\n- mouse_motion: move cursor (x, y: number, relative_x, relative_y: number)\n- click_element: click a UI element by node path or node name (element: string, button, double_click)\n- action: fire a Godot input action (action: string, pressed: bool, strength: 0–1)\n- wait: pause between actions (ms: number)\n\nExamples:\n1. Press and release Space: [{type:"key",key:"Space",pressed:true},{type:"wait",ms:100},{type:"key",key:"Space",pressed:false}]\n2. Click a UI button (discover path with get_ui_elements first): [{type:"click_element",element:"StartButton"}]\n3. Left-click at viewport coordinates: [{type:"mouse_button",x:400,y:300,button:"left",pressed:true},{type:"mouse_button",x:400,y:300,button:"left",pressed:false}]\n4. Fire a Godot action: [{type:"action",action:"jump",pressed:true},{type:"wait",ms:200},{type:"action",action:"jump",pressed:false}]\n5. Type "hello": [{type:"key",key:"H",pressed:true},{type:"key",key:"H",pressed:false},{type:"key",key:"E",pressed:true},{type:"key",key:"E",pressed:false},{type:"key",key:"L",pressed:true},{type:"key",key:"L",pressed:false},{type:"key",key:"L",pressed:true},{type:"key",key:"L",pressed:false},{type:"key",key:"O",pressed:true},{type:"key",key:"O",pressed:false}]',
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
    description: 'Get Control nodes from a running Godot project with their positions, sizes, types, and text. Requires an active runtime session (run_project or attach_project). Call this before simulate_input with click_element to discover valid element names and paths. Returns: { elements: [{ name, path, type, rect: {x,y,width,height}, visible, text? (Button/Label/LineEdit/TextEdit), disabled? (buttons), tooltip? }] }',
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
    description: 'Execute a custom GDScript in the live running project with full scene tree access. Requires run_project first. Script must extend RefCounted and define func execute(scene_tree: SceneTree) -> Variant. Return values are JSON-serialized (primitives, Vector2/3, Color, Dictionary, Array, and Node path strings are supported). Use print() for debug output — it appears in get_debug_output, not in the script result. In spawned mode, runtime errors emitted to stderr are detected and either escalated (when the script returns null) or surfaced as warnings. In attached mode a null result includes a caveat since stderr is not captured.',
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
    name: 'list_autoloads',
    description: 'List all registered autoloads in a Godot project with paths and singleton status. No Godot process required — reads project.godot directly.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
      },
      required: ['projectPath'],
    },
  },
  {
    name: 'add_autoload',
    description: 'Register a new autoload in a Godot project. No Godot process required. Warning: autoloads initialize in headless mode — if the script has errors, all headless operations will fail.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
        autoloadName: { type: 'string', description: 'Name of the autoload node (e.g. "MyManager")' },
        autoloadPath: { type: 'string', description: 'Path to the script or scene (e.g. "res://autoload/my_manager.gd" or "autoload/my_manager.gd")' },
        singleton: { type: 'boolean', description: 'Register as a globally accessible singleton by name (default: true)' },
      },
      required: ['projectPath', 'autoloadName', 'autoloadPath'],
    },
  },
  {
    name: 'remove_autoload',
    description: 'Unregister an autoload from a Godot project by name. No Godot process required.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
        autoloadName: { type: 'string', description: 'Name of the autoload to remove' },
      },
      required: ['projectPath', 'autoloadName'],
    },
  },
  {
    name: 'update_autoload',
    description: 'Modify an existing autoload\'s path or singleton flag. No Godot process required.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
        autoloadName: { type: 'string', description: 'Name of the autoload to update' },
        autoloadPath: { type: 'string', description: 'New path to the script or scene' },
        singleton: { type: 'boolean', description: 'New singleton flag' },
      },
      required: ['projectPath', 'autoloadName'],
    },
  },
  {
    name: 'get_project_files',
    description: 'Return a recursive file tree of a Godot project. Skips hidden (dot-prefixed) entries and the .mcp directory. Returns nested { name, type, path, extension?, children? } objects.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
        maxDepth: { type: 'number', description: 'Maximum recursion depth. -1 means unlimited (default: -1)' },
        extensions: { type: 'array', items: { type: 'string' }, description: 'Filter to only these file extensions (e.g. ["gd", "tscn"]). Omit to include all.' },
      },
      required: ['projectPath'],
    },
  },
  {
    name: 'search_project',
    description: 'Plain-text search across project files. Returns { matches: [{ file, lineNumber, line }], truncated }. Skips hidden entries and the .mcp directory.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
        pattern: { type: 'string', description: 'Plain-text string to search for' },
        fileTypes: { type: 'array', items: { type: 'string' }, description: 'File extensions to search (default: ["gd", "tscn", "cs", "gdshader"])' },
        caseSensitive: { type: 'boolean', description: 'Case-sensitive search (default: false)' },
        maxResults: { type: 'number', description: 'Maximum matches to return (default: 100)' },
      },
      required: ['projectPath', 'pattern'],
    },
  },
  {
    name: 'get_scene_dependencies',
    description: 'Parse a .tscn file for ext_resource references (scripts, textures, subscenes). Returns { scene, dependencies: [{ path, type, uid? }] }.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
        scenePath: { type: 'string', description: 'Path to the .tscn file relative to the project root (e.g. "scenes/main.tscn")' },
      },
      required: ['projectPath', 'scenePath'],
    },
  },
  {
    name: 'get_project_settings',
    description: 'Parse project.godot into structured JSON. Returns { settings: { [section]: { [key]: value } } }. Complex Godot types are returned as raw strings. Keys not under any section appear under __global__.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to the Godot project directory' },
        section: { type: 'string', description: 'Filter to a specific INI section (e.g. "display", "application"). Omit for all sections.' },
      },
      required: ['projectPath'],
    },
  },
];

function ensureRuntimeSession(runner: GodotRunner, actionDescription: string) {
  if (!runner.activeSessionMode || !runner.activeProjectPath) {
    return createErrorResponse(
      `No active runtime session. A project must be running or attached to ${actionDescription}.`,
      ['Use run_project to start a Godot project first', 'Or use attach_project before launching Godot manually']
    );
  }

  if (runner.activeSessionMode === 'spawned' && (!runner.activeProcess || runner.activeProcess.hasExited)) {
    return createErrorResponse(
      `The spawned Godot process has exited and cannot ${actionDescription}.`,
      ['Use get_debug_output to inspect the last captured logs', 'Call stop_project to clean up, then run_project again']
    );
  }

  return null;
}

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
    if (!runner.getGodotPath()) {
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
      content: [{ type: 'text', text: `Godot editor launched successfully for project at ${args.projectPath}.\nNote: the editor is a GUI application and cannot be controlled programmatically. Use the scene and node editing tools (add_node, set_node_property, etc.) to modify the project headlessly without the editor.` }],
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

    const background = args.background === true;
    runner.runProject(args.projectPath as string, args.scene as string | undefined, background);

    const bridgeResult = await runner.waitForBridge();

    if (!bridgeResult.ready) {
      if (runner.activeProcess && runner.activeProcess.hasExited) {
        return createErrorResponse(
          `Godot process exited before the MCP bridge could initialize.\n${bridgeResult.error || ''}`,
          [
            'Check get_debug_output for runtime errors',
            'Verify a display server is available (Wayland/X11)',
            'Check for broken autoloads with list_autoloads',
            'Call stop_project to clean up, then try again',
          ]
        );
      }

      const lines = [
        'Godot process started, but the MCP bridge did not respond within 8 seconds.',
        '- The process is running — bridge may still be initializing',
        '- Use get_debug_output to investigate',
        '- Runtime tools may work if you retry after a moment',
        '- Call stop_project when done',
      ];
      if (background) {
        lines.push('- Background mode: window hidden, physical input blocked');
      }
      return createErrorResponse(
        lines.join('\n'),
        [
          'Use get_debug_output to inspect the last captured logs',
          'Check that UDP port 9900 is not occupied by another Godot process',
          'Call stop_project to clean up, then run_project again',
        ]
      );
    }

    const lines = [
      'Godot project started and MCP bridge is ready.',
      '- Runtime tools (take_screenshot, simulate_input, get_ui_elements, run_script) are available now',
      '- Use get_debug_output to check runtime output and errors',
      '- Call stop_project when done',
    ];
    if (background) {
      lines.push('- Background mode: window hidden, physical input blocked');
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(
      `Failed to run Godot project: ${errorMessage}`,
      ['Ensure Godot is installed correctly', 'Check if the GODOT_PATH environment variable is set correctly']
    );
  }
}

export async function handleAttachProject(runner: GodotRunner, args: OperationParams) {
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

    runner.attachProject(args.projectPath as string);

    if (args.waitForBridge === true) {
      const bridgeResult = await runner.waitForBridgeAttached();

      if (!bridgeResult.ready) {
        return {
          content: [{
            type: 'text',
            text: [
              'Project attached but the MCP bridge did not respond within 15 seconds.',
              '- Verify Godot is running with this project',
              '- The McpBridge autoload must be initialized and listening on UDP port 9900',
              '- Runtime tools may work if you retry after a moment',
              '- get_debug_output is unavailable in attached mode',
              '- Use detach_project or stop_project when done',
            ].join('\n'),
          }],
        };
      }

      return {
        content: [{
          type: 'text',
          text: [
            'Project attached and MCP bridge is ready.',
            '- Runtime tools (take_screenshot, simulate_input, get_ui_elements, run_script) are available now',
            '- get_debug_output is unavailable in attached mode because MCP did not spawn the process',
            '- Use detach_project or stop_project when done to clean up the injected bridge state',
          ].join('\n'),
        }],
      };
    }

    return {
      content: [{
        type: 'text',
        text: [
          'Project attached for manual runtime use.',
          '- Launch Godot yourself, then call attach_project again with waitForBridge: true to confirm readiness',
          '- Or use runtime tools directly — they will fail with a clear error if the bridge is not yet listening',
          '- get_debug_output is unavailable in attached mode because MCP did not spawn the process',
          '- Use detach_project or stop_project when done to clean up the injected bridge state',
        ].join('\n'),
      }],
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(
      `Failed to attach project: ${errorMessage}`,
      ['Check if project.godot is accessible', 'Ensure MCP can write the bridge autoload into the project']
    );
  }
}

export function handleDetachProject(runner: GodotRunner) {
  if (runner.activeSessionMode !== 'attached') {
    return createErrorResponse(
      'No attached project to detach.',
      ['Use attach_project first for manual-launch workflows', 'If MCP launched the game, use stop_project instead']
    );
  }

  const result = runner.stopProject()!;

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        message: 'Detached attached project and cleaned MCP bridge state',
        externalProcessPreserved: result.externalProcessPreserved === true,
      }),
    }],
  };
}

export function handleGetDebugOutput(runner: GodotRunner, args: OperationParams = {}) {
  args = normalizeParameters(args);

  if (!runner.activeSessionMode) {
    return createErrorResponse(
      'No active runtime session.',
      ['Use run_project to start a Godot project first', 'Or use attach_project before launching Godot manually']
    );
  }

  if (runner.activeSessionMode === 'attached') {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          output: [],
          errors: [],
          running: null,
          attached: true,
          tip: 'Attached mode does not capture stdout/stderr because Godot was launched outside MCP.',
        }),
      }],
    };
  }

  const proc = runner.activeProcess;
  if (!proc) {
    return createErrorResponse(
      'No active spawned process is available for debug output.',
      ['Use run_project to start a Godot project first', 'Or use attach_project only when stdout/stderr capture is not needed']
    );
  }

  const limit = typeof args.limit === 'number' ? args.limit : 200;
  const response: {
    output: string[];
    errors: string[];
    running: boolean;
    exitCode?: number | null;
    tip?: string;
  } = {
    output: proc.output.slice(-limit),
    errors: proc.errors.slice(-limit),
    running: !proc.hasExited,
  };

  if (proc.hasExited) {
    response.exitCode = proc.exitCode;
    response.tip = 'Process has exited. Call stop_project to clean up the process slot before starting a new one.';
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
        message: result.mode === 'attached'
          ? 'Attached project detached and MCP bridge state cleaned up'
          : 'Godot project stopped',
        mode: result.mode,
        externalProcessPreserved: result.externalProcessPreserved === true,
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

  const sessionError = ensureRuntimeSession(runner, 'take a screenshot');
  if (sessionError) {
    return sessionError;
  }

  const timeout = typeof args.timeout === 'number' ? args.timeout : 10000;

  try {
    const { response: responseStr, runtimeErrors } = await runner.sendCommandWithErrors('screenshot', {}, timeout);

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
    const screenshotPath = sep === '\\' ? parsed.path.replace(/\//g, '\\') : parsed.path;

    if (!existsSync(screenshotPath)) {
      return createErrorResponse(
        `Screenshot file not found at: ${screenshotPath}`,
        ['The screenshot may have failed to save', 'Check disk space and permissions']
      );
    }

    const imageBuffer = readFileSync(screenshotPath);
    const base64Data = imageBuffer.toString('base64');

    const content: Array<{ type: string; [key: string]: unknown }> = [
      {
        type: 'image',
        data: base64Data,
        mimeType: 'image/png',
      },
      {
        type: 'text',
        text: `Screenshot saved to: ${parsed.path}`,
      },
    ];

    if (runtimeErrors.length > 0) {
      content.push({
        type: 'text',
        text: JSON.stringify({
          warnings: runtimeErrors.slice(0, MAX_RUNTIME_ERROR_CONTEXT_LINES),
        }),
      });
    }

    return { content };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(
      `Failed to take screenshot: ${errorMessage}`,
      [
        'Ensure the project is running (use run_project first)',
        'The bridge may not be ready yet — use get_debug_output to investigate',
        'Check that UDP port 9900 is not blocked',
      ]
    );
  }
}

export async function handleSimulateInput(runner: GodotRunner, args: OperationParams) {
  args = normalizeParameters(args);

  const sessionError = ensureRuntimeSession(runner, 'simulate input');
  if (sessionError) {
    return sessionError;
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
    const { response: responseStr, runtimeErrors } = await runner.sendCommandWithErrors('input', { actions }, timeoutMs);

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

    const payload: Record<string, unknown> = {
      success: true,
      actions_processed: parsed.actions_processed,
      tip: 'Call take_screenshot to verify the input had the intended visual effect.',
    };
    if (runtimeErrors.length > 0) {
      payload.warnings = runtimeErrors.slice(0, MAX_RUNTIME_ERROR_CONTEXT_LINES);
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(payload),
      }],
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(
      `Failed to simulate input: ${errorMessage}`,
      [
        'Ensure the project is running (use run_project first)',
        'The bridge may not be ready yet — use get_debug_output to investigate',
        'Check that UDP port 9900 is not blocked',
      ]
    );
  }
}

export async function handleGetUiElements(runner: GodotRunner, args: OperationParams) {
  args = normalizeParameters(args);

  const sessionError = ensureRuntimeSession(runner, 'query UI elements');
  if (sessionError) {
    return sessionError;
  }

  const visibleOnly = args.visibleOnly !== false;

  try {
    const cmdParams: Record<string, unknown> = { visible_only: visibleOnly };
    if (args.filter) cmdParams.type_filter = args.filter;
    const { response: responseStr, runtimeErrors } = await runner.sendCommandWithErrors('get_ui_elements', cmdParams);

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

    const payload: Record<string, unknown> = {
      ...parsed,
      tip: "Use simulate_input with type 'click_element' and a node_path or text value from this list to interact with these elements.",
    };
    if (runtimeErrors.length > 0) {
      payload.warnings = runtimeErrors.slice(0, MAX_RUNTIME_ERROR_CONTEXT_LINES);
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(payload),
      }],
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(
      `Failed to get UI elements: ${errorMessage}`,
      [
        'Ensure the project is running (use run_project first)',
        'The bridge may not be ready yet — use get_debug_output to investigate',
        'Check that UDP port 9900 is not blocked',
      ]
    );
  }
}

export async function handleRunScript(runner: GodotRunner, args: OperationParams) {
  args = normalizeParameters(args);

  const sessionError = ensureRuntimeSession(runner, 'execute scripts');
  if (sessionError) {
    return sessionError;
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
    const { response: responseStr, runtimeErrors } = await runner.sendCommandWithErrors('run_script', { source: script }, timeout);

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

    // Detect false-positive success: GDScript has no try-catch, so runtime errors
    // return null and the real error only appears in stderr.
    if (parsed.success && parsed.result === null && runner.activeSessionMode === 'spawned') {
      if (runtimeErrors.length > 0) {
        const errorContext = runtimeErrors.slice(0, MAX_RUNTIME_ERROR_CONTEXT_LINES).join('\n');
        return createErrorResponse(
          `Script runtime error detected:\n${errorContext}`,
          [
            'Fix the GDScript error in your script and retry',
            'Use get_debug_output for full process output',
          ]
        );
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            result: null,
            warning: 'Script returned null. If unexpected, check get_debug_output for runtime errors — GDScript does not propagate exceptions.',
            tip: 'Call take_screenshot to verify any visual changes, or get_debug_output to review print() output from your script.',
          }),
        }],
      };
    }

    const payload: Record<string, unknown> = {
      success: true,
      result: parsed.result,
      tip: 'Call take_screenshot to verify any visual changes, or get_debug_output to review print() output from your script.',
    };
    if (runtimeErrors.length > 0) {
      payload.warnings = runtimeErrors.slice(0, MAX_RUNTIME_ERROR_CONTEXT_LINES);
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(payload),
      }],
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(
      `Failed to execute script: ${errorMessage}`,
      [
        'Ensure the project is running (use run_project first)',
        'The bridge may not be ready yet — wait 2-3 seconds after starting, then check get_debug_output if the issue persists',
        'Check that UDP port 9900 is not blocked',
        'For long-running scripts, increase the timeout parameter',
      ]
    );
  }
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
  extensions: string[] | null
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
        children.push(buildFilesystemTree(
          join(currentPath, entry.name),
          childRelPath,
          maxDepth,
          currentDepth + 1,
          extensions
        ));
      } else if (entry.isFile()) {
        const ext = entry.name.includes('.') ? entry.name.split('.').pop()!.toLowerCase() : '';
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
  maxResults: number
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
        const ext = entry.name.includes('.') ? entry.name.split('.').pop()!.toLowerCase() : '';
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

function parseProjectSettings(projectFilePath: string): Record<string, Record<string, SettingsValue>> {
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

export async function handleListAutoloads(args: OperationParams) {
  args = normalizeParameters(args);
  const v = validateProjectArgs(args);
  if ('isError' in v) return v;

  try {
    const projectFile = join(v.projectPath, 'project.godot');
    const autoloads = parseAutoloads(projectFile);
    return { content: [{ type: 'text', text: JSON.stringify({ autoloads }) }] };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Failed to list autoloads: ${errorMessage}`, ['Check if project.godot is accessible']);
  }
}

export async function handleAddAutoload(args: OperationParams) {
  args = normalizeParameters(args);
  const v = validateProjectArgs(args);
  if ('isError' in v) return v;

  if (!args.autoloadName || !args.autoloadPath) {
    return createErrorResponse('autoloadName and autoloadPath are required', ['Provide the autoload node name and script/scene path']);
  }
  if (!validatePath(args.autoloadPath as string)) {
    return createErrorResponse('Invalid autoload path', ['Provide a valid path without ".."']);
  }

  try {
    const projectFile = join(v.projectPath, 'project.godot');
    const existing = parseAutoloads(projectFile);
    if (existing.some(a => a.name === (args.autoloadName as string))) {
      return createErrorResponse(
        `Autoload '${args.autoloadName}' already exists`,
        ['Use update_autoload to modify it', 'Use list_autoloads to see current autoloads']
      );
    }
    const isSingleton = args.singleton !== false;
    addAutoloadEntry(projectFile, args.autoloadName as string, args.autoloadPath as string, isSingleton);
    return {
      content: [{ type: 'text', text: `Autoload '${args.autoloadName}' registered at '${args.autoloadPath}' (singleton: ${isSingleton}).\nWarning: autoloads initialize in headless mode too. If this script has errors, all headless operations will fail. Verify by running get_scene_tree — if it fails, use remove_autoload to remove it.` }],
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Failed to add autoload: ${errorMessage}`, ['Check if project.godot is accessible']);
  }
}

export async function handleRemoveAutoload(args: OperationParams) {
  args = normalizeParameters(args);
  const v = validateProjectArgs(args);
  if ('isError' in v) return v;

  if (!args.autoloadName) {
    return createErrorResponse('autoloadName is required', ['Provide the name of the autoload to remove']);
  }

  try {
    const projectFile = join(v.projectPath, 'project.godot');
    const removed = removeAutoloadEntry(projectFile, args.autoloadName as string);
    if (!removed) {
      return createErrorResponse(`Autoload '${args.autoloadName}' not found`, ['Use list_autoloads to see existing autoloads']);
    }
    return { content: [{ type: 'text', text: `Autoload '${args.autoloadName}' removed successfully.` }] };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Failed to remove autoload: ${errorMessage}`, ['Check if project.godot is accessible']);
  }
}

export async function handleUpdateAutoload(args: OperationParams) {
  args = normalizeParameters(args);
  const v = validateProjectArgs(args);
  if ('isError' in v) return v;

  if (!args.autoloadName) {
    return createErrorResponse('autoloadName is required', ['Provide the name of the autoload to update']);
  }
  if (args.autoloadPath && !validatePath(args.autoloadPath as string)) {
    return createErrorResponse('Invalid autoload path', ['Provide a valid path without ".."']);
  }

  try {
    const projectFile = join(v.projectPath, 'project.godot');
    const updated = updateAutoloadEntry(
      projectFile,
      args.autoloadName as string,
      args.autoloadPath as string | undefined,
      args.singleton as boolean | undefined
    );
    if (!updated) {
      return createErrorResponse(
        `Autoload '${args.autoloadName}' not found`,
        ['Use list_autoloads to see existing autoloads', 'Use add_autoload to register a new one']
      );
    }
    return { content: [{ type: 'text', text: `Autoload '${args.autoloadName}' updated successfully.` }] };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Failed to update autoload: ${errorMessage}`, ['Check if project.godot is accessible']);
  }
}

export async function handleGetProjectFiles(args: OperationParams) {
  args = normalizeParameters(args);
  const v = validateProjectArgs(args);
  if ('isError' in v) return v;

  try {
    const maxDepth = typeof args.maxDepth === 'number' ? args.maxDepth : -1;
    const extensions = Array.isArray(args.extensions)
      ? (args.extensions as string[]).map(e => e.toLowerCase().replace(/^\./, ''))
      : null;
    const tree = buildFilesystemTree(v.projectPath, '', maxDepth, 0, extensions);
    return { content: [{ type: 'text', text: JSON.stringify(tree) }] };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Failed to get project files: ${errorMessage}`, ['Check if the project directory is accessible']);
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
      ? (args.fileTypes as string[]).map(e => e.toLowerCase().replace(/^\./, ''))
      : ['gd', 'tscn', 'cs', 'gdshader'];
    const caseSensitive = args.caseSensitive === true;
    const maxResults = typeof args.maxResults === 'number' ? args.maxResults : 100;
    const result = searchInFiles(v.projectPath, args.pattern as string, fileTypes, caseSensitive, maxResults);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Failed to search project: ${errorMessage}`, ['Check if the project directory is accessible']);
  }
}

export async function handleGetSceneDependencies(args: OperationParams) {
  args = normalizeParameters(args);
  const v = validateProjectArgs(args);
  if ('isError' in v) return v;

  if (!args.scenePath || typeof args.scenePath !== 'string') {
    return createErrorResponse('scenePath is required', ['Provide a path relative to the project root, e.g. "scenes/main.tscn"']);
  }
  if (!validatePath(args.scenePath as string)) {
    return createErrorResponse('Invalid scenePath', ['Provide a valid path without ".."']);
  }

  try {
    const sceneFullPath = join(v.projectPath, args.scenePath as string);
    if (!existsSync(sceneFullPath)) {
      return createErrorResponse(
        `Scene file not found: ${args.scenePath}`,
        ['Verify the path is relative to the project root', 'Use get_project_files to list available .tscn files']
      );
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
    return { content: [{ type: 'text', text: JSON.stringify({ scene: args.scenePath, dependencies }) }] };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Failed to get scene dependencies: ${errorMessage}`, ['Check if the scene file is accessible']);
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
    return createErrorResponse(`Failed to get project settings: ${errorMessage}`, ['Check if project.godot is accessible']);
  }
}
