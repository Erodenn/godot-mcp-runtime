import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, copyFileSync, unlinkSync, mkdirSync } from 'fs';
import { logDebug } from './logger.js';
import { addAutoloadEntry, parseAutoloads, removeAutoloadEntry } from './autoload-ini.js';

const BRIDGE_AUTOLOAD_NAME = 'McpBridge';
const BRIDGE_SCRIPT_FILENAME = 'mcp_bridge.gd';
const MCP_GITIGNORE_ENTRY = '.mcp/';

/**
 * Owns the McpBridge autoload artifact: the script copy in the target project,
 * the `[autoload]` entry in project.godot, the `.mcp/.gdignore` marker, and the
 * `.gitignore` augmentation. GodotRunner delegates to this for inject/cleanup
 * during run_project / attach_project / stop_project flows.
 *
 * Idempotent within a session via `injectedProjects`: a second `inject()` call
 * for the same path short-circuits without rewriting project.godot.
 */
export class BridgeManager {
  private injectedProjects: Set<string> = new Set();

  constructor(private bridgeScriptPath: string) {}

  inject(projectPath: string): void {
    if (this.injectedProjects.has(projectPath)) {
      logDebug('Bridge already injected for this project, skipping');
      return;
    }

    this.ensureMcpGdignore(projectPath);
    this.ensureGitignored(projectPath);

    const destScript = join(projectPath, BRIDGE_SCRIPT_FILENAME);
    if (!existsSync(destScript)) {
      copyFileSync(this.bridgeScriptPath, destScript);
      logDebug(`Copied bridge autoload to ${destScript}`);
    }

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
  }

  /**
   * If project.godot still has an `McpBridge=` line but the script file is
   * missing, the autoload would crash every subsequent headless op. Detect and
   * clean the orphan before running an operation.
   */
  repairOrphaned(projectPath: string): void {
    const projectFile = join(projectPath, 'project.godot');
    const bridgeScript = join(projectPath, BRIDGE_SCRIPT_FILENAME);
    if (!existsSync(projectFile)) return;
    if (existsSync(bridgeScript)) return;
    try {
      const content = readFileSync(projectFile, 'utf8');
      if (content.includes(`${BRIDGE_AUTOLOAD_NAME}=`)) {
        this.removeBridgeArtifacts(projectPath);
        logDebug('Cleaned up orphaned McpBridge autoload entry');
      }
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
    if (!existsSync(mcpDir)) {
      mkdirSync(mcpDir, { recursive: true });
    }
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
