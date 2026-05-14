import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { logDebug } from './logger.js';
import { addAutoloadEntry, parseAutoloads, removeAutoloadEntry } from './autoload-ini.js';

const BRIDGE_AUTOLOAD_NAME = 'McpBridge';
const BRIDGE_SCRIPT_FILENAME = 'mcp_bridge.gd';
const MCP_GITIGNORE_ENTRY = '.mcp/';

// Matches the baked-port marker line inserted in src/scripts/mcp_bridge.gd —
// `const PORT := <int>` — so inject() can rewrite the integer per project.
const BAKED_PORT_REGEX = /const PORT := \d+/;

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
  /**
   * Last port baked into the on-disk script per project. Used by the
   * race-detection helper in runtime-tools to spot a concurrent re-inject
   * after a bridge-wait timeout.
   */
  private lastInjectedPort: Map<string, number> = new Map();

  constructor(private bridgeScriptPath: string) {}

  inject(projectPath: string, port: number): void {
    // Always rewrite the destination — the per-project bridge script may
    // differ from the template by exactly the baked integer, so a size/mtime
    // shortcut no longer maps to "up-to-date." Bake the resolved port into
    // the const PORT line so the running game listens on the exact port the
    // Node side will connect to.
    const template = readFileSync(this.bridgeScriptPath, 'utf8');
    if (!BAKED_PORT_REGEX.test(template)) {
      throw new Error(
        `Bridge script template at ${this.bridgeScriptPath} is missing the 'const PORT := <int>' marker`,
      );
    }
    const baked = template.replace(BAKED_PORT_REGEX, `const PORT := ${port}`);
    const destScript = join(projectPath, BRIDGE_SCRIPT_FILENAME);
    writeFileSync(destScript, baked, 'utf8');
    this.lastInjectedPort.set(projectPath, port);
    logDebug(`Wrote bridge autoload at ${destScript} (baked port ${port})`);

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
    this.lastInjectedPort.delete(projectPath);
  }

  /**
   * Read the port currently baked into the project's bridge script. Returns
   * the integer on success, or null if the file is missing, unreadable, or
   * lacks the marker. Used to detect concurrent re-inject after a bridge-
   * wait timeout (another MCP client may have rewritten the port).
   */
  readBakedPort(projectPath: string): number | null {
    const destScript = join(projectPath, BRIDGE_SCRIPT_FILENAME);
    if (!existsSync(destScript)) return null;
    try {
      const content = readFileSync(destScript, 'utf8');
      const match = content.match(BAKED_PORT_REGEX);
      if (!match) return null;
      const parsed = Number.parseInt(match[0].replace(/^const PORT := /, ''), 10);
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) return null;
      return parsed;
    } catch {
      return null;
    }
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
