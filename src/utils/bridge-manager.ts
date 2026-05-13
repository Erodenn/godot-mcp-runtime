import { join } from 'path';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  unlinkSync,
  mkdirSync,
  statSync,
} from 'fs';
import { logDebug } from './logger.js';
import { addAutoloadEntry, parseAutoloads, removeAutoloadEntry } from './autoload-ini.js';

const BRIDGE_AUTOLOAD_NAME = 'McpBridge';
const BRIDGE_SCRIPT_FILENAME = 'mcp_bridge.gd';
const MCP_GITIGNORE_ENTRY = '.mcp/';

/**
 * Cheap equality check by size + mtime — sufficient for the bridge artifact
 * since the manager is the only writer. Avoids reading and hashing both files
 * on every inject call.
 */
function isSameFile(a: string, b: string): boolean {
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    return sa.size === sb.size && sa.mtimeMs === sb.mtimeMs;
  } catch {
    return false;
  }
}

/**
 * Owns the McpBridge autoload artifact: the script copy in the target project,
 * the `[autoload]` entry in project.godot, the `.mcp/.gdignore` marker, and the
 * `.gitignore` augmentation. GodotRunner delegates to this for inject/cleanup
 * during run_project / attach_project / stop_project flows.
 *
 * The project-root bridge script is runtime-owned and refreshed on first
 * injection for a manager session so a rebuilt server cannot talk to stale
 * GDScript from an earlier run. Idempotent within a session via
 * `injectedProjects`: a second `inject()` call for the same path short-circuits
 * without rewriting project.godot.
 */
export class BridgeManager {
  private injectedProjects: Set<string> = new Set();
  private repairedProjects: Set<string> = new Set();

  constructor(private bridgeScriptPath: string) {}

  inject(projectPath: string): void {
    // Always refresh the bridge script — a server rebuild updates the source
    // GDScript, and a same-session re-inject must propagate that to the
    // project copy or the running game would talk to stale code. Short-circuit
    // the copy when the destination already matches source size + mtime.
    const destScript = join(projectPath, BRIDGE_SCRIPT_FILENAME);
    if (!isSameFile(this.bridgeScriptPath, destScript)) {
      copyFileSync(this.bridgeScriptPath, destScript);
      logDebug(`Refreshed bridge autoload at ${destScript}`);
    }

    if (this.injectedProjects.has(projectPath)) {
      logDebug('Bridge already injected for this project; refreshed script only.');
      return;
    }

    this.ensureMcpGdignore(projectPath);
    this.ensureGitignored(projectPath);

    const projectFile = join(projectPath, 'project.godot');
    const existing = parseAutoloads(projectFile);
    const alreadyRegistered = existing.some((a) => a.name === BRIDGE_AUTOLOAD_NAME);

    if (alreadyRegistered) {
      logDebug('Bridge autoload already present, skipping injection');
    } else {
      addAutoloadEntry(projectFile, BRIDGE_AUTOLOAD_NAME, BRIDGE_SCRIPT_FILENAME, true);
      logDebug('Injected bridge autoload into project.godot');
    }
    this.injectedProjects.add(projectPath);
  }

  cleanup(projectPath: string): void {
    this.removeBridgeArtifacts(projectPath);
    this.injectedProjects.delete(projectPath);
    this.repairedProjects.delete(projectPath);
  }

  /**
   * If project.godot still has an `McpBridge=` line but the script file is
   * missing, the autoload would crash every subsequent headless op. Detect and
   * clean the orphan before running an operation.
   *
   * Cached per project: once a path has been checked clean, skip the file
   * reads on subsequent ops in the same session.
   */
  repairOrphaned(projectPath: string): void {
    if (this.repairedProjects.has(projectPath)) return;
    const projectFile = join(projectPath, 'project.godot');
    const bridgeScript = join(projectPath, BRIDGE_SCRIPT_FILENAME);
    if (!existsSync(projectFile)) return;
    if (existsSync(bridgeScript)) {
      this.repairedProjects.add(projectPath);
      return;
    }
    try {
      const content = readFileSync(projectFile, 'utf8');
      if (content.includes(`${BRIDGE_AUTOLOAD_NAME}=`)) {
        this.removeBridgeArtifacts(projectPath);
        logDebug('Cleaned up orphaned McpBridge autoload entry');
      }
      this.repairedProjects.add(projectPath);
    } catch (err) {
      logDebug(`Non-fatal: Failed to check/repair orphaned bridge: ${err}`);
    }
  }

  private removeBridgeArtifacts(projectPath: string): void {
    try {
      const projectFile = join(projectPath, 'project.godot');
      if (existsSync(projectFile)) {
        const removed = removeAutoloadEntry(projectFile, BRIDGE_AUTOLOAD_NAME);
        if (removed) {
          logDebug(`Removed ${BRIDGE_AUTOLOAD_NAME} autoload from project.godot`);
        }
      }
    } catch (err) {
      logDebug(`Non-fatal: Failed to clean ${BRIDGE_AUTOLOAD_NAME} from project.godot: ${err}`);
    }

    try {
      const scriptFile = join(projectPath, BRIDGE_SCRIPT_FILENAME);
      if (existsSync(scriptFile)) {
        unlinkSync(scriptFile);
        logDebug(`Removed ${BRIDGE_SCRIPT_FILENAME} from project`);
      }
    } catch (err) {
      logDebug(`Non-fatal: Failed to remove ${BRIDGE_SCRIPT_FILENAME}: ${err}`);
    }

    try {
      const uidFile = join(projectPath, `${BRIDGE_SCRIPT_FILENAME}.uid`);
      if (existsSync(uidFile)) {
        unlinkSync(uidFile);
        logDebug(`Removed ${BRIDGE_SCRIPT_FILENAME}.uid from project`);
      }
    } catch (err) {
      logDebug(`Non-fatal: Failed to remove ${BRIDGE_SCRIPT_FILENAME}.uid: ${err}`);
    }
  }

  private ensureMcpGdignore(projectPath: string): void {
    const mcpDir = join(projectPath, '.mcp');
    mkdirSync(mcpDir, { recursive: true });
    writeFileSync(join(mcpDir, '.gdignore'), '', 'utf8');
    logDebug('Created .mcp/.gdignore');
  }

  private ensureGitignored(projectPath: string): void {
    const gitignorePath = join(projectPath, '.gitignore');
    if (existsSync(gitignorePath)) {
      const gitignoreContent = readFileSync(gitignorePath, 'utf8');
      if (!gitignoreContent.includes(MCP_GITIGNORE_ENTRY)) {
        const newline = gitignoreContent.endsWith('\n') ? '' : '\n';
        writeFileSync(
          gitignorePath,
          gitignoreContent + newline + MCP_GITIGNORE_ENTRY + '\n',
          'utf8',
        );
        logDebug('Added .mcp/ to existing .gitignore');
      }
    } else {
      writeFileSync(gitignorePath, MCP_GITIGNORE_ENTRY + '\n', 'utf8');
      logDebug('Created .gitignore with .mcp/ entry');
    }
  }
}
