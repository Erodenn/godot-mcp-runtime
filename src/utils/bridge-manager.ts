import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, rmdirSync } from 'fs';
import { logDebug } from './logger.js';
import {
  addAutoloadEntry,
  normalizeAutoloadPath,
  parseAutoloads,
  removeAutoloadEntry,
  updateAutoloadEntry,
} from './autoload-ini.js';
import {
  BRIDGE_SCRIPT_RES_PATH,
  LEGACY_BRIDGE_SCRIPT_FILENAME,
  bridgeDir,
  bridgeScriptAbsPath,
  isServerOwnedBridgePath,
  mcpDir,
} from './artifact-paths.js';

const BRIDGE_AUTOLOAD_NAME = 'McpBridge' as const;
const MCP_GITIGNORE_ENTRY = '.mcp/' as const;

// Matches the baked-port marker line inserted in src/scripts/mcp_bridge.gd —
// `const PORT := <int>` — so inject() can rewrite the integer per project.
const BAKED_PORT_REGEX = /const PORT := \d+/;

// Matches the baked-session-token marker line — `const SESSION_TOKEN_BAKED :=
// "..."` — so inject() can rewrite it per project for attach-mode sessions.
// Spawned sessions deliver the token via MCP_SESSION_TOKEN instead and leave
// this at its shipped `""` default.
const BAKED_TOKEN_REGEX = /const SESSION_TOKEN_BAKED := "[^"]*"/;

/**
 * Owns the McpBridge autoload artifact: the script copy under
 * `.mcp/godot-runtime/bridge/` in the target project, the `[autoload]` entry in
 * project.godot, the `.mcp/.gdignore` marker, and the `.gitignore` augmentation.
 * GodotRunner delegates to this for inject/cleanup during run_project /
 * attach_project / stop_project flows. Path composition lives in
 * `utils/artifact-paths.ts`.
 *
 * The injected bridge script is runtime-owned and refreshed on first injection
 * for a manager session so a rebuilt server cannot talk to stale GDScript from
 * an earlier run. Idempotent within a session via `injectedProjects`: a second
 * `inject()` call for the same path short-circuits without rewriting
 * project.godot.
 *
 * `McpBridge` is reserved by this server, but the name is not reserved by
 * Godot. An entry under that name whose registered path is not server-owned
 * (see `isServerOwnedBridgePath`) belongs to the user: inject refuses rather
 * than rewriting it, and cleanup leaves it alone.
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

  /**
   * @param bakedToken Session token to bake into the on-disk script, for
   *   attach-mode sessions where Node cannot set the env var on a Godot
   *   process the user launched themselves. Spawned sessions deliver the
   *   token via `MCP_SESSION_TOKEN` instead and should omit this so the
   *   shipped `""` default is left in place (fail-open only when no token is
   *   configured at all).
   * @throws if an `[autoload]` entry named McpBridge already exists and points
   *   at a path this server does not own (a name collision with user code).
   */
  inject(projectPath: string, port: number, bakedToken?: string): void {
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
    if (!BAKED_TOKEN_REGEX.test(template)) {
      throw new Error(
        `Bridge script template at ${this.bridgeScriptPath} is missing the 'const SESSION_TOKEN_BAKED := "..."' marker`,
      );
    }

    // Collision check runs before any write so a refusal leaves no artifacts
    // behind.
    const projectFile = join(projectPath, 'project.godot');
    const existingEntry = this.findBridgeAutoload(projectFile);
    if (existingEntry !== undefined && !isServerOwnedBridgePath(existingEntry)) {
      throw new Error(
        `project.godot already registers an autoload named ${BRIDGE_AUTOLOAD_NAME} at ` +
          `${existingEntry}, which this server does not own. The ${BRIDGE_AUTOLOAD_NAME} ` +
          `autoload name is reserved by this server; rename the existing autoload and retry.`,
      );
    }

    let baked = template.replace(BAKED_PORT_REGEX, `const PORT := ${port}`);
    if (bakedToken !== undefined) {
      baked = baked.replace(BAKED_TOKEN_REGEX, `const SESSION_TOKEN_BAKED := "${bakedToken}"`);
    }

    // .gdignore must exist before a .gd file lands under .mcp/, and on every
    // inject rather than only the first — the short-circuit below returns
    // early, and a missing marker would let the importer walk the subtree.
    this.ensureMcpGdignore(projectPath);

    const destScript = bridgeScriptAbsPath(projectPath);
    mkdirSync(bridgeDir(projectPath), { recursive: true });
    writeFileSync(destScript, baked, 'utf8');
    this.lastInjectedPort.set(projectPath, port);
    logDebug(`Wrote bridge autoload at ${destScript} (baked port ${port})`);

    if (this.injectedProjects.has(projectPath)) {
      logDebug('Bridge already injected for this project; refreshed script only.');
      return;
    }

    this.ensureGitignored(projectPath);

    if (existingEntry === undefined) {
      addAutoloadEntry(projectFile, BRIDGE_AUTOLOAD_NAME, BRIDGE_SCRIPT_RES_PATH, true);
      logDebug('Injected bridge autoload into project.godot');
    } else if (existingEntry !== normalizeAutoloadPath(BRIDGE_SCRIPT_RES_PATH)) {
      // Path drift: an older server version registered the project-root script,
      // or a previous namespace. Repoint rather than adding a second entry.
      updateAutoloadEntry(projectFile, BRIDGE_AUTOLOAD_NAME, BRIDGE_SCRIPT_RES_PATH, true);
      logDebug(`Migrated bridge autoload from ${existingEntry} to ${BRIDGE_SCRIPT_RES_PATH}`);
    } else {
      logDebug('Bridge autoload already present, skipping injection');
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
    const destScript = bridgeScriptAbsPath(projectPath);
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
   * Clear bridge artifacts stranded by an earlier process. Two cases:
   * project.godot still has an `McpBridge=` line but the script is gone (the
   * autoload would crash every subsequent headless op), or the script is still
   * on disk from a server that was hard-killed before it could clean up
   * (`injectedProjects` is per-process, so "present but not ours" means
   * stranded).
   *
   * Trigger surface, deliberately wide: this runs from `executeOperation`, so
   * the first headless op of any kind against a project — `validate` included,
   * nothing launched — can clear a stray entry or script. What it is allowed to
   * delete is narrowed by `removeBridgeArtifacts`, which never touches an
   * autoload path this server does not own.
   *
   * Cached per project: once a path has been checked clean, skip the file
   * reads on subsequent ops in the same session.
   */
  repairOrphaned(projectPath: string): void {
    if (this.repairedProjects.has(projectPath)) return;
    const projectFile = join(projectPath, 'project.godot');
    if (!existsSync(projectFile)) return;
    try {
      const scriptPresent =
        existsSync(bridgeScriptAbsPath(projectPath)) ||
        existsSync(join(projectPath, LEGACY_BRIDGE_SCRIPT_FILENAME));
      const content = readFileSync(projectFile, 'utf8');
      const entryPresent = content.includes(`${BRIDGE_AUTOLOAD_NAME}=`);
      const stranded = (entryPresent || scriptPresent) && !this.injectedProjects.has(projectPath);
      if (stranded) {
        this.removeBridgeArtifacts(projectPath);
        logDebug('Cleaned up stranded McpBridge artifacts');
      }
      this.repairedProjects.add(projectPath);
    } catch (err) {
      logDebug(`Non-fatal: Failed to check/repair orphaned bridge: ${err}`);
    }
  }

  /**
   * Remove the session-scoped bridge artifacts: the autoload entry, the
   * namespaced script and its `.uid`, the legacy project-root script and its
   * `.uid`, and the `bridge/` directory once empty. Each step is independently
   * try/caught and best-effort.
   *
   * Never touches `screenshots/`, `scripts/`, `validate/`, the
   * `.mcp/godot-runtime/` directory itself, or `.mcp/.gdignore` — handed-out
   * screenshot paths must stay resolvable and the audit trail must survive.
   * Legacy `.mcp/screenshots/` and `.mcp/scripts/` from older versions are left
   * in place, neither migrated nor deleted.
   *
   * When the `McpBridge` entry points somewhere this server does not own, the
   * entry and the project-root script are both left alone: that combination is
   * a user's own autoload sharing a reserved name, not our artifact.
   */
  private removeBridgeArtifacts(projectPath: string): void {
    const projectFile = join(projectPath, 'project.godot');
    let userOwnsEntry = false;
    try {
      const registeredPath = this.findBridgeAutoload(projectFile);
      userOwnsEntry = registeredPath !== undefined && !isServerOwnedBridgePath(registeredPath);
      if (userOwnsEntry) {
        logDebug(
          `Left user-registered ${BRIDGE_AUTOLOAD_NAME} autoload at ${registeredPath} untouched`,
        );
      } else if (
        registeredPath !== undefined &&
        removeAutoloadEntry(projectFile, BRIDGE_AUTOLOAD_NAME)
      ) {
        logDebug(`Removed ${BRIDGE_AUTOLOAD_NAME} autoload from project.godot`);
      }
    } catch (err) {
      logDebug(`Non-fatal: Failed to clean ${BRIDGE_AUTOLOAD_NAME} from project.godot: ${err}`);
    }

    this.unlinkQuietly(bridgeScriptAbsPath(projectPath));
    this.unlinkQuietly(`${bridgeScriptAbsPath(projectPath)}.uid`);

    // Pre-namespace layout. Skipped when a user-owned entry is registered,
    // because a root mcp_bridge.gd under that entry is presumably theirs.
    if (!userOwnsEntry) {
      const legacyScript = join(projectPath, LEGACY_BRIDGE_SCRIPT_FILENAME);
      this.unlinkQuietly(legacyScript);
      this.unlinkQuietly(`${legacyScript}.uid`);
    }

    try {
      if (existsSync(bridgeDir(projectPath))) {
        // rmdirSync, not rmSync: it removes an empty directory and throws
        // ENOTEMPTY otherwise, so an unexpected file in bridge/ is left alone
        // rather than taken with it. (rmSync without `recursive` cannot remove
        // a directory at all -- it throws ERR_FS_EISDIR.)
        rmdirSync(bridgeDir(projectPath));
        logDebug('Removed the bridge/ directory');
      }
    } catch (err) {
      logDebug(`Non-fatal: Failed to remove the bridge/ directory: ${err}`);
    }
  }

  /**
   * Registered path of the `McpBridge` autoload, normalized to `res://` form,
   * or undefined when project.godot is missing, unreadable, or has no such
   * entry.
   */
  private findBridgeAutoload(projectFilePath: string): string | undefined {
    if (!existsSync(projectFilePath)) return undefined;
    try {
      const entry = parseAutoloads(projectFilePath).find((a) => a.name === BRIDGE_AUTOLOAD_NAME);
      return entry ? normalizeAutoloadPath(entry.path) : undefined;
    } catch {
      return undefined;
    }
  }

  private unlinkQuietly(filePath: string): void {
    try {
      if (existsSync(filePath)) {
        unlinkSync(filePath);
        logDebug(`Removed ${filePath}`);
      }
    } catch (err) {
      logDebug(`Non-fatal: Failed to remove ${filePath}: ${err}`);
    }
  }

  private ensureMcpGdignore(projectPath: string): void {
    const dir = mcpDir(projectPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.gdignore'), '', 'utf8');
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
