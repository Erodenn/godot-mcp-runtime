import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, copyFileSync, unlinkSync, mkdirSync } from 'fs';
import { logDebug } from './godot-runner.js';
import { removeAutoloadEntry } from './autoload-ini.js';

const BRIDGE_AUTOLOAD_NAME = 'McpBridge';
const BRIDGE_SCRIPT_FILENAME = 'mcp_bridge.gd';
const LEGACY_AUTOLOAD_NAME = 'McpScreenshotServer';
const LEGACY_SCRIPT_FILENAME = 'mcp_screenshot_server.gd';
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

    // Clean up legacy screenshot server if present.
    this.removeAutoloadArtifact(projectPath, LEGACY_AUTOLOAD_NAME, LEGACY_SCRIPT_FILENAME);

    const destScript = join(projectPath, BRIDGE_SCRIPT_FILENAME);
    copyFileSync(this.bridgeScriptPath, destScript);
    logDebug(`Copied bridge autoload to ${destScript}`);

    const projectFile = join(projectPath, 'project.godot');
    let content = readFileSync(projectFile, 'utf8');

    const autoloadEntry = `${BRIDGE_AUTOLOAD_NAME}="*res://${BRIDGE_SCRIPT_FILENAME}"`;

    if (content.includes(autoloadEntry)) {
      logDebug('Bridge autoload already present, skipping injection');
      if (!existsSync(destScript)) {
        copyFileSync(this.bridgeScriptPath, destScript);
        logDebug('Re-copied missing bridge script');
      }
      this.injectedProjects.add(projectPath);
      return;
    }

    const autoloadSectionRegex = /^\[autoload\]\s*$/m;
    if (autoloadSectionRegex.test(content)) {
      content = content.replace(autoloadSectionRegex, `[autoload]\n${autoloadEntry}`);
    } else {
      content = content.trimEnd() + `\n\n[autoload]\n${autoloadEntry}\n`;
    }

    writeFileSync(projectFile, content, 'utf8');
    logDebug('Injected bridge autoload into project.godot');
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
    this.removeAutoloadArtifact(projectPath, BRIDGE_AUTOLOAD_NAME, BRIDGE_SCRIPT_FILENAME);
  }

  private removeAutoloadArtifact(
    projectPath: string,
    entryName: string,
    scriptFilename: string,
  ): void {
    try {
      const projectFile = join(projectPath, 'project.godot');
      if (existsSync(projectFile)) {
        const removed = removeAutoloadEntry(projectFile, entryName);
        if (removed) {
          logDebug(`Removed ${entryName} autoload from project.godot`);
        }
      }
    } catch (err) {
      logDebug(`Non-fatal: Failed to clean ${entryName} from project.godot: ${err}`);
    }

    try {
      const scriptFile = join(projectPath, scriptFilename);
      if (existsSync(scriptFile)) {
        unlinkSync(scriptFile);
        logDebug(`Removed ${scriptFilename} from project`);
      }
    } catch (err) {
      logDebug(`Non-fatal: Failed to remove ${scriptFilename}: ${err}`);
    }

    try {
      const uidFile = join(projectPath, `${scriptFilename}.uid`);
      if (existsSync(uidFile)) {
        unlinkSync(uidFile);
        logDebug(`Removed ${scriptFilename}.uid from project`);
      }
    } catch (err) {
      logDebug(`Non-fatal: Failed to remove ${scriptFilename}.uid: ${err}`);
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
