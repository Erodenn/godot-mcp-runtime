import { join } from 'path';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  rmdirSync,
  readdirSync,
} from 'fs';
import { hostname as osHostname } from 'os';
import { randomBytes } from 'crypto';
import { logDebug } from './logger.js';
import { writeFileAtomicSync } from './atomic-write.js';
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
  bridgeOwnersDir,
  bridgeScriptAbsPath,
  isServerOwnedBridgePath,
  mcpDir,
} from './artifact-paths.js';

/**
 * Autoload name this server reserves in a target project's `project.godot`.
 * Exported so `run_project`'s pre-flight scan can recognize its own injected
 * bridge and skip scanning it.
 */
export const BRIDGE_AUTOLOAD_NAME = 'McpBridge' as const;

/**
 * Thrown when project.godot already registers an autoload named `McpBridge`
 * at a path this server does not own. Distinct from the incidental filesystem
 * failures `inject` can raise, because the caller must surface this one to the
 * user: it is the only inject failure they can act on, and proceeding would
 * leave them staring at a bridge timeout instead.
 */
export class BridgeAutoloadCollisionError extends Error {
  constructor(
    message: string,
    readonly registeredPath: string,
  ) {
    super(message);
    this.name = 'BridgeAutoloadCollisionError';
  }
}

/**
 * Thrown when `inject` is called for attach mode (a baked token supplied) and
 * another live attach session already owns this project. At most one attach
 * owner is allowed per project, because attach mode bakes port and token into
 * the one shared script — two attach owners would stomp each other's baked
 * values on every inject.
 */
export class BridgeAttachConflictError extends Error {
  constructor(
    message: string,
    readonly conflictingOwner: BridgeOwnerInfo,
  ) {
    super(message);
    this.name = 'BridgeAttachConflictError';
  }
}

const MCP_GITIGNORE_ENTRY = '.mcp/' as const;

// Matches the baked-port marker line inserted in src/scripts/mcp_bridge.gd —
// `const PORT := <int>` — so inject() can rewrite the integer per project.
const BAKED_PORT_REGEX = /const PORT := \d+/;

// Matches the baked-session-token marker line — `const SESSION_TOKEN_BAKED :=
// "..."` — so inject() can rewrite it per project for attach-mode sessions.
// Spawned sessions deliver the token via MCP_SESSION_TOKEN instead and leave
// this at its shipped `""` default.
const BAKED_TOKEN_REGEX = /const SESSION_TOKEN_BAKED := "[^"]*"/;

/** Random bytes composing an `instanceId`, hex-encoded (16 hex chars). */
const OWNER_INSTANCE_ID_BYTES = 8;

export type BridgeSessionMode = 'spawned' | 'attached';

/**
 * One registry entry: a live session's claim on the shared bridge artifacts
 * for a project. Written to its own file under `bridge/owners/` by `inject`,
 * removed by that same instance's `cleanup`. `token` is present only for
 * `mode: 'attached'`, since attach mode has no env-var channel to re-deliver
 * it and it is already on disk in the rendered script anyway.
 */
export interface BridgeOwnerInfo {
  pid: number;
  instanceId: string;
  hostname: string;
  mode: BridgeSessionMode;
  startedAt: string;
  port: number;
  token?: string;
}

interface OwnerFileEntry {
  fileName: string;
  info: BridgeOwnerInfo;
}

/** Constructor-injectable seams for `BridgeManager`, used by tests to fake a
 * dead process, a foreign hostname, or a specific pid without touching the
 * real OS. Production call sites omit `options` entirely. */
export interface BridgeManagerOptions {
  isProcessAlive?: (pid: number) => boolean;
  hostname?: () => string;
  pid?: () => number;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    // Signal 0 sends nothing; it only probes whether the pid exists and is
    // signalable. ESRCH means no such process (dead); EPERM means it exists
    // but we lack permission to signal it, which is still evidence of life.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isValidOwnerInfo(value: unknown): value is BridgeOwnerInfo {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.pid === 'number' &&
    typeof v.instanceId === 'string' &&
    typeof v.hostname === 'string' &&
    (v.mode === 'spawned' || v.mode === 'attached') &&
    typeof v.startedAt === 'string' &&
    typeof v.port === 'number' &&
    (v.token === undefined || typeof v.token === 'string')
  );
}

/**
 * Owns the McpBridge autoload artifact: the script copy under
 * `.mcp/godot-runtime/bridge/` in the target project, the owner registry
 * under `.mcp/godot-runtime/bridge/owners/`, the `[autoload]` entry in
 * project.godot, the `.mcp/.gdignore` marker, and the `.gitignore`
 * augmentation. GodotRunner delegates to this for inject/cleanup during
 * run_project / attach_project / stop_project flows. Path composition lives
 * in `utils/artifact-paths.ts`.
 *
 * Designed for N concurrent server processes sharing one project. Every entry
 * point reads disk state rather than trusting in-memory bookkeeping, because
 * a sibling process's inject/cleanup can change that state at any time. The
 * shared script and autoload entry are created on the first live session's
 * inject and removed only by the last live session's cleanup, tracked via one
 * owner file per live session (see `BridgeOwnerInfo`). An owner is "live"
 * when its hostname doesn't match this host (unknowable, so treated
 * conservatively as live) or its pid answers a liveness probe; dead owner
 * files are pruned opportunistically on every registry read.
 *
 * Accepted gap on `project.godot`: two servers doing read-modify-write on it
 * in the same instant can still lose one edit — there is no file lock.
 * Writing the owner file before touching project.godot (see `inject`) makes
 * that window tiny, and the next `inject` from either side restores the
 * entry if it was lost.
 *
 * Accepted gap on cross-version coexistence: an older server version running
 * concurrently on the same project writes no owner file, so this instance
 * cannot see it and treats the project as unowned once its own owner count
 * hits zero.
 *
 * `McpBridge` is reserved by this server, but the name is not reserved by
 * Godot. An entry under that name whose registered path is not server-owned
 * (see `isServerOwnedBridgePath`) belongs to the user: inject refuses rather
 * than rewriting it, and cleanup leaves it alone.
 */
export class BridgeManager {
  private repairedProjects: Set<string> = new Set();
  private readonly instanceId: string;
  private readonly pid: number;
  private readonly hostnameFn: () => string;
  private readonly isProcessAliveFn: (pid: number) => boolean;

  constructor(
    private bridgeScriptPath: string,
    options: BridgeManagerOptions = {},
  ) {
    this.instanceId = randomBytes(OWNER_INSTANCE_ID_BYTES).toString('hex');
    this.pid = options.pid ? options.pid() : process.pid;
    this.hostnameFn = options.hostname ?? (() => osHostname());
    this.isProcessAliveFn = options.isProcessAlive ?? defaultIsProcessAlive;
  }

  /**
   * @param bakedToken Session token to bake into the on-disk script, for
   *   attach-mode sessions where Node cannot set the env var on a Godot
   *   process the user launched themselves. Spawned sessions deliver the
   *   token via `MCP_SESSION_TOKEN` instead and should omit this so the
   *   rendered script carries no baked attach owner (fail-open only when no
   *   token is configured at all).
   * @throws {BridgeAutoloadCollisionError} if an `[autoload]` entry named
   *   McpBridge already exists and points at a path this server does not own
   *   (a name collision with user code). Callers must not swallow this one.
   * @throws {BridgeAttachConflictError} if `bakedToken` is supplied and
   *   another live attach session already owns this project. Thrown before
   *   any write.
   */
  inject(projectPath: string, port: number, bakedToken?: string): void {
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
      throw new BridgeAutoloadCollisionError(
        `project.godot already registers an autoload named ${BRIDGE_AUTOLOAD_NAME} at ` +
          `${existingEntry}, which this server does not own. The ${BRIDGE_AUTOLOAD_NAME} ` +
          `autoload name is reserved by this server; rename the existing autoload and retry.`,
        existingEntry,
      );
    }

    if (bakedToken !== undefined) {
      const conflicting = this.liveAttachOwner(projectPath, true);
      if (conflicting) {
        throw new BridgeAttachConflictError(
          `Another MCP session (server pid ${conflicting.pid}, attached mode) is already ` +
            `attached to this project. Only one attach session per project is supported, ` +
            `because attach mode bakes its port and token into the one shared bridge ` +
            `script. Detach that session first, then retry attach_project.`,
          conflicting,
        );
      }
    }

    // .gdignore must exist before a .gd file lands under .mcp/, and on every
    // inject rather than only once — a project can be missing it if a git
    // checkout or a sibling process's cleanup removed the whole .mcp/ subtree
    // between sessions.
    this.ensureMcpGdignore(projectPath);
    mkdirSync(bridgeOwnersDir(projectPath), { recursive: true });

    // Owner file lands BEFORE project.godot is touched, so a concurrent
    // cleanup from a sibling session sees this session and does not tear the
    // shared artifacts down underneath it.
    const ownerInfo: BridgeOwnerInfo = {
      pid: this.pid,
      instanceId: this.instanceId,
      hostname: this.hostnameFn(),
      mode: bakedToken !== undefined ? 'attached' : 'spawned',
      startedAt: new Date().toISOString(),
      port,
      ...(bakedToken !== undefined ? { token: bakedToken } : {}),
    };
    writeFileAtomicSync(this.ownerFilePath(projectPath), JSON.stringify(ownerInfo, null, 2));
    logDebug(`Wrote bridge owner file for pid ${this.pid} (${ownerInfo.mode})`);

    // Render from the live attach owner now on record (self included, since
    // the write above just registered it if this call is the attach one).
    const attachOwner = this.liveAttachOwner(projectPath, false);
    this.writeRenderedScriptIfChanged(projectPath, template, attachOwner);

    this.ensureGitignored(projectPath);

    // Re-read rather than reuse the collision-check read above: a sibling
    // session may have added or migrated the entry since, and acting on the
    // stale value would add a duplicate McpBridge line.
    const currentEntry = this.findBridgeAutoload(projectFile);
    if (currentEntry !== undefined && !isServerOwnedBridgePath(currentEntry)) {
      // Withdraw the owner file written above, or it would hold sibling
      // servers' edit guards closed for a session that never started.
      this.unlinkQuietly(this.ownerFilePath(projectPath));
      throw new BridgeAutoloadCollisionError(
        `project.godot registers an autoload named ${BRIDGE_AUTOLOAD_NAME} at ` +
          `${currentEntry}, which this server does not own. The ${BRIDGE_AUTOLOAD_NAME} ` +
          `autoload name is reserved by this server; rename the existing autoload and retry.`,
        currentEntry,
      );
    }
    if (currentEntry === undefined) {
      addAutoloadEntry(projectFile, BRIDGE_AUTOLOAD_NAME, BRIDGE_SCRIPT_RES_PATH, true);
      logDebug('Injected bridge autoload into project.godot');
    } else if (currentEntry !== normalizeAutoloadPath(BRIDGE_SCRIPT_RES_PATH)) {
      // Path drift: an older server version registered the project-root script,
      // or a previous namespace. Repoint rather than adding a second entry.
      updateAutoloadEntry(projectFile, BRIDGE_AUTOLOAD_NAME, BRIDGE_SCRIPT_RES_PATH, true);
      logDebug(`Migrated bridge autoload from ${currentEntry} to ${BRIDGE_SCRIPT_RES_PATH}`);
    } else {
      logDebug('Bridge autoload already present, skipping injection');
    }

    // Disk state just changed under us; the next repairOrphaned check for
    // this project must re-read it rather than trust the cached verdict.
    this.repairedProjects.delete(projectPath);
  }

  /**
   * Leave this instance's session. Deletes only this instance's owner file,
   * then re-reads the registry: if other live owners remain, the shared
   * script and autoload entry are left in place (the script is re-rendered,
   * which resets baked attach values to the template defaults when the
   * leaving session was the attach owner and no other attach owner exists).
   * Only when no live owners remain at all does the shared script and
   * autoload entry get removed.
   *
   * Must stay fully synchronous and never throw: `GodotRunner
   * .cleanupBridgeArtifactsSync` calls this from a `process.on('exit')`
   * handler, where there is no event loop left and nowhere to report a
   * failure to. Every step is independently try/caught and best-effort, as
   * the prior single-owner implementation was.
   */
  cleanup(projectPath: string): void {
    try {
      this.unlinkQuietly(this.ownerFilePath(projectPath));
    } catch (err) {
      logDebug(`Non-fatal: Failed to remove own bridge owner file: ${err}`);
    }
    this.repairedProjects.delete(projectPath);

    let liveOwners: OwnerFileEntry[] = [];
    try {
      liveOwners = this.readLiveOwners(projectPath);
    } catch (err) {
      logDebug(`Non-fatal: Failed to read bridge owner registry during cleanup: ${err}`);
    }

    if (liveOwners.length > 0) {
      try {
        const template = readFileSync(this.bridgeScriptPath, 'utf8');
        const attachOwner = liveOwners.find((e) => e.info.mode === 'attached')?.info;
        this.writeRenderedScriptIfChanged(projectPath, template, attachOwner);
      } catch (err) {
        logDebug(`Non-fatal: Failed to re-render bridge script for remaining owners: ${err}`);
      }
      logDebug(
        `${liveOwners.length} other live session(s) remain on this project; leaving shared bridge artifacts in place`,
      );
      return;
    }

    this.removeBridgeArtifacts(projectPath);
  }

  /**
   * Clear bridge artifacts stranded by an earlier process. Two cases:
   * project.godot still has an `McpBridge=` line but the script is gone (the
   * autoload would crash every subsequent headless op), or the script is still
   * on disk from a server that was hard-killed before it could clean up.
   * "Stranded" means these artifacts are present with no live registered
   * owner (see `BridgeOwnerInfo`) — not merely "not injected by this process",
   * since another live session on this project is a legitimate reason for the
   * artifacts to exist.
   *
   * Trigger surface, deliberately wide: this runs from `executeOperation`, so
   * the first headless op of any kind against a project — `validate` included,
   * nothing launched — can clear a stray entry or script. What it is allowed to
   * delete is narrowed by `removeBridgeArtifacts`, which never touches an
   * autoload path this server does not own.
   *
   * Cached per project: once a path has been checked clean, skip the file
   * reads on subsequent ops in the same session. `inject`/`cleanup` clear the
   * cache for a project they touch, so a later check re-reads the disk.
   *
   * Accepted gap: an older server version running concurrently on this
   * project writes no owner file, so it is invisible here and its artifacts
   * can be misclassified as stranded.
   */
  repairOrphaned(projectPath: string): void {
    if (this.repairedProjects.has(projectPath)) return;
    const projectFile = join(projectPath, 'project.godot');
    if (!existsSync(projectFile)) return;
    try {
      const liveOwners = this.readLiveOwners(projectPath);
      if (liveOwners.length > 0) {
        this.repairedProjects.add(projectPath);
        return;
      }

      const scriptPresent =
        existsSync(bridgeScriptAbsPath(projectPath)) ||
        existsSync(join(projectPath, LEGACY_BRIDGE_SCRIPT_FILENAME));
      const content = readFileSync(projectFile, 'utf8');
      const entryPresent = content.includes(`${BRIDGE_AUTOLOAD_NAME}=`);
      const stranded = entryPresent || scriptPresent;
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
   * Live owners of this project other than this instance, pruning dead ones
   * as a side effect (via the registry read below). Used by
   * `GodotRunner.otherLiveSessionsOnProject` to power the cross-server edit
   * guard.
   */
  listOtherLiveOwners(projectPath: string): BridgeOwnerInfo[] {
    return this.readLiveOwners(projectPath)
      .filter((e) => !this.isSelfOwnerFile(e.fileName))
      .map((e) => e.info);
  }

  /**
   * True when `project.godot` currently registers the `McpBridge` autoload
   * pointing at this server's script path. Used by the bridge-not-ready
   * timeout diagnostic to distinguish "the game started with no bridge at
   * all" from "the bridge autoload is present but never became ready".
   */
  isBridgeAutoloadRegistered(projectPath: string): boolean {
    const projectFile = join(projectPath, 'project.godot');
    const entry = this.findBridgeAutoload(projectFile);
    return entry !== undefined && entry === normalizeAutoloadPath(BRIDGE_SCRIPT_RES_PATH);
  }

  /**
   * Render the bridge script template with the given attach owner's port and
   * token baked in, or return the template unchanged when there is none.
   * Spawned sessions never bake — they deliver their port via the
   * `MCP_BRIDGE_PORT` env var — so the rendered script is identical for every
   * spawned session regardless of who wrote it, which is what makes the
   * "write only when different" check in `writeRenderedScriptIfChanged`
   * meaningful across sibling processes.
   */
  private renderScript(template: string, attachOwner: BridgeOwnerInfo | undefined): string {
    if (!attachOwner) return template;
    let rendered = template.replace(BAKED_PORT_REGEX, `const PORT := ${attachOwner.port}`);
    if (attachOwner.token !== undefined) {
      rendered = rendered.replace(
        BAKED_TOKEN_REGEX,
        `const SESSION_TOKEN_BAKED := "${attachOwner.token}"`,
      );
    }
    return rendered;
  }

  private writeRenderedScriptIfChanged(
    projectPath: string,
    template: string,
    attachOwner: BridgeOwnerInfo | undefined,
  ): void {
    const rendered = this.renderScript(template, attachOwner);
    const destScript = bridgeScriptAbsPath(projectPath);
    mkdirSync(bridgeDir(projectPath), { recursive: true });
    const current = existsSync(destScript) ? readFileSync(destScript, 'utf8') : null;
    if (current === rendered) return;
    writeFileAtomicSync(destScript, rendered);
    logDebug(
      attachOwner
        ? `Wrote bridge script at ${destScript} (baked port ${attachOwner.port} for attach owner pid ${attachOwner.pid})`
        : `Wrote bridge script at ${destScript} (template defaults, no live attach owner)`,
    );
  }

  /** This instance's owner file for `projectPath`. Stable across calls within
   * one `BridgeManager` instance's lifetime, so a restart-and-reinject
   * overwrites its own previous file rather than orphaning it. */
  private ownerFilePath(projectPath: string): string {
    return join(bridgeOwnersDir(projectPath), this.ownerFileName());
  }

  private ownerFileName(): string {
    return `${this.pid}-${this.instanceId}.json`;
  }

  private isSelfOwnerFile(fileName: string): boolean {
    return fileName === this.ownerFileName();
  }

  private isOwnerLive(info: BridgeOwnerInfo): boolean {
    // A foreign host can't be probed at all, so it is conservatively treated
    // as live rather than pruned.
    if (info.hostname !== this.hostnameFn()) return true;
    return this.isProcessAliveFn(info.pid);
  }

  /**
   * Read every owner file in the registry, pruning (best-effort unlink) any
   * that is unparseable or dead. Returns only the live entries. This is the
   * single point that mutates the on-disk registry by pruning, so every
   * public method that needs "who is live" goes through it.
   */
  private readLiveOwners(projectPath: string): OwnerFileEntry[] {
    const dir = bridgeOwnersDir(projectPath);
    let fileNames: string[];
    try {
      fileNames = readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }

    const live: OwnerFileEntry[] = [];
    for (const fileName of fileNames) {
      const filePath = join(dir, fileName);
      let info: BridgeOwnerInfo | null = null;
      try {
        const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
        if (isValidOwnerInfo(parsed)) info = parsed;
      } catch {
        info = null;
      }

      if (info === null) {
        this.unlinkQuietly(filePath);
        continue;
      }
      if (!this.isOwnerLive(info)) {
        this.unlinkQuietly(filePath);
        continue;
      }
      live.push({ fileName, info });
    }
    return live;
  }

  /**
   * The live attach-mode owner on this project, or undefined. `excludeSelf`
   * is true for the conflict check in `inject` (self has not written its own
   * file yet at that point, but excluding is still correct if it somehow
   * had), and false when rendering the script, since after `inject` writes
   * its own owner file self may legitimately be the attach owner to bake.
   */
  private liveAttachOwner(projectPath: string, excludeSelf: boolean): BridgeOwnerInfo | undefined {
    return this.readLiveOwners(projectPath)
      .filter((e) => !excludeSelf || !this.isSelfOwnerFile(e.fileName))
      .find((e) => e.info.mode === 'attached')?.info;
  }

  /**
   * Remove the shared bridge artifacts: the autoload entry, the namespaced
   * script and its `.uid`, the legacy project-root script and its `.uid`, the
   * `owners/` directory once empty, and the `bridge/` directory once empty.
   * Each step is independently try/caught and best-effort.
   *
   * Callers (`cleanup`, `repairOrphaned`) are responsible for confirming no
   * live owner remains before calling this — it does not check the registry
   * itself, so it must never be called while another session might still be
   * relying on these artifacts.
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
   *
   * Accepted gap: with no `McpBridge` entry at all there is nothing to test
   * ownership against, so a project-root file named exactly `mcp_bridge.gd`
   * (plus its `.uid`) is removed on the assumption it is ours. The blast
   * radius is that one filename at the project root and nothing else.
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
      if (existsSync(bridgeOwnersDir(projectPath))) {
        // rmdirSync, not rmSync: it removes an empty directory and throws
        // ENOTEMPTY otherwise, so a file that raced in after the registry
        // read above is left alone rather than taken with it.
        rmdirSync(bridgeOwnersDir(projectPath));
        logDebug('Removed the bridge/owners/ directory');
      }
    } catch (err) {
      logDebug(`Non-fatal: Failed to remove the bridge/owners/ directory: ${err}`);
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
    const gdignorePath = join(dir, '.gdignore');
    if (existsSync(gdignorePath)) {
      return;
    }
    writeFileSync(gdignorePath, '', 'utf8');
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
