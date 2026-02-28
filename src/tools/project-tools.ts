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

export const projectToolDefinitions: ToolDefinition[] = [
  {
    name: 'launch_editor',
    description: 'Launch Godot editor for a specific project',
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
    description: 'Run the Godot project and capture output',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Path to the Godot project directory',
        },
        scene: {
          type: 'string',
          description: 'Optional: Specific scene to run',
        },
      },
      required: ['projectPath'],
    },
  },
  {
    name: 'get_debug_output',
    description: 'Get the current debug output and errors',
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
    description: 'Stop the currently running Godot project',
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
    description: 'Capture a PNG screenshot of the running Godot project viewport. Requires run_project first.',
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
    description: 'Simulate input in a running Godot project. Supports batched sequential actions with delays. Requires run_project first.\n\nTypes: key, mouse_button, mouse_motion, click_element, action, wait',
    inputSchema: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          description: 'Array of input actions to execute sequentially',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['key', 'mouse_button', 'mouse_motion', 'click_element', 'action', 'wait'],
                description: 'The type of input action',
              },
              key: { type: 'string', description: '[key] Key name (e.g. "W", "Space", "Escape", "Up")' },
              pressed: { type: 'boolean', description: 'Whether the input is pressed (true) or released (false)' },
              shift: { type: 'boolean', description: '[key] Shift modifier' },
              ctrl: { type: 'boolean', description: '[key] Ctrl modifier' },
              alt: { type: 'boolean', description: '[key] Alt modifier' },
              button: { type: 'string', enum: ['left', 'right', 'middle'], description: '[mouse_button, click_element] Mouse button (default: left)' },
              x: { type: 'number', description: '[mouse_button, mouse_motion] X position' },
              y: { type: 'number', description: '[mouse_button, mouse_motion] Y position' },
              relative_x: { type: 'number', description: '[mouse_motion] Relative X movement' },
              relative_y: { type: 'number', description: '[mouse_motion] Relative Y movement' },
              double_click: { type: 'boolean', description: '[mouse_button, click_element] Double click' },
              element: { type: 'string', description: '[click_element] Node name or node path of the UI element to click. Use get_ui_elements to discover node names.' },
              action: { type: 'string', description: '[action] Godot input action name' },
              strength: { type: 'number', description: '[action] Action strength (0-1, default 1.0)' },
              ms: { type: 'number', description: '[wait] Duration in milliseconds' },
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
    description: 'Get visible Control UI elements from a running project with positions, types, and text. Use before click_element. Requires run_project first.',
    inputSchema: {
      type: 'object',
      properties: {
        visibleOnly: {
          type: 'boolean',
          description: 'Only return visible elements (default: true)',
        },
        filter: {
          type: 'string',
          description: 'Filter by Control type (e.g. "Button", "Label")',
        },
      },
      required: [],
    },
  },
  {
    name: 'run_script',
    description: 'Execute a custom GDScript in the running Godot project. Script must define: extends RefCounted and func execute(scene_tree: SceneTree) -> Variant. Has full access to the live scene tree. Requires run_project first.',
    inputSchema: {
      type: 'object',
      properties: {
        script: {
          type: 'string',
          description: 'GDScript source code. Must extend RefCounted and have execute(scene_tree: SceneTree) -> Variant.',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in ms (default: 30000)',
        },
      },
      required: ['script'],
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
      content: [{ type: 'text', text: `Godot editor launched successfully for project at ${args.projectPath}.` }],
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
      content: [{ type: 'text', text: 'Godot project started in debug mode. Use get_debug_output to see output.' }],
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
        text: JSON.stringify(parsed),
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
        text: JSON.stringify({ success: true, result: parsed.result }),
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

