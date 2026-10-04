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
import { projectPathKey } from './output-parsing.js';
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
    /**
     * Set when the conflicting owner was registered from another host: how to
     * clear it when it is known to be stale (see `foreignHostOwnerRemedy`).
     */
    readonly foreignHostSolution?: string,
  ) {
    super(message);
    this.name = 'BridgeAttachConflictError';
  }
}

/**
 * Thrown when the owner registry under `bridge/owners/` exists but could not
 * be read: the directory could not be listed, or an owner file could not be
 * opened. That is "unknown", which is not the same answer as "no live owner".
 * A caller deciding whether another session is running a project's game must
 * treat it as a refusal, and a caller about to remove the shared artifacts
 * must leave them in place.
 */
export class BridgeRegistryUnreadableError extends Error {
  constructor(readonly reason: string) {
    super(`The bridge owner registry could not be read: ${reason}`);
    this.name = 'BridgeRegistryUnreadableError';
  }
}

const MCP_GITIGNORE_ENTRY = '.mcp/' as const;

// What a caller can do about an McpBridge entry that cleanup could not remove
// or could not confirm removed. The retry is real: the first headless
// operation on a project with a stranded entry runs `repairOrphaned`.
const BRIDGE_ENTRY_REMEDY =
  'remove the McpBridge= line under [autoload] by hand, or run any headless tool on this project to retry';
// A bridge script left on disk with no live owner is stranded in the same
// sense, and is removed by the same retry.
const REMOVAL_RETRY_NOTE = 'the next headless tool call on this project retries the removal';

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

/** File name of a session's owner file under `bridge/owners/`. */
export function bridgeOwnerFileName(info: Pick<BridgeOwnerInfo, 'pid' | 'instanceId'>): string {
  return `${info.pid}-${info.instanceId}.json`;
}

/**
 * What to tell a caller blocked by an owner registered from another host, or
 * null when the owner is on this host. A foreign-host owner cannot be probed,
 * so it counts as live for as long as its file exists (see `isOwnerLive`): a
 * file left behind by a project copied or synced from another machine, or by
 * a host that was renamed, blocks forever, and deleting that file is the only
 * way out. The refusal therefore has to name the host and the file.
 * `thisHostname` is a parameter so a test can stand in for the host.
 */
export function foreignHostOwnerRemedy(
  info: BridgeOwnerInfo,
  projectPath: string,
  thisHostname: string = osHostname(),
): { note: string; solution: string } | null {
  if (info.hostname === thisHostname) return null;
  const ownerFile = join(bridgeOwnersDir(projectPath), bridgeOwnerFileName(info));
  return {
    note: ` That session was registered from another host ("${info.hostname}"; this host is "${thisHostname}"), so this server cannot check whether it is still running and treats it as live.`,
    solution: `If that session is known to be gone (the project was copied or synced from another machine, or this host was renamed), delete its owner file ${ownerFile} and retry`,
  };
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
  /** Stands in for `removeAutoloadEntry`, so a test can make that one step fail. */
  removeAutoloadEntry?: (projectFile: string, name: string) => boolean;
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

/** Text of a caught filesystem failure, for a problem a caller will read. */
function describeFailure(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function failureCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
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
 * run_project (spawned and attach mode) / stop_project flows. Path composition lives
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
  private readonly removeAutoloadEntryFn: (projectFile: string, name: string) => boolean;

  constructor(
    private bridgeScriptPath: string,
    options: BridgeManagerOptions = {},
  ) {
    this.instanceId = randomBytes(OWNER_INSTANCE_ID_BYTES).toString('hex');
    this.pid = options.pid ? options.pid() : process.pid;
    this.hostnameFn = options.hostname ?? (() => osHostname());
    this.isProcessAliveFn = options.isProcessAlive ?? defaultIsProcessAlive;
    this.removeAutoloadEntryFn = options.removeAutoloadEntry ?? removeAutoloadEntry;
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
   * @throws {BridgeRegistryUnreadableError} if the owner registry exists and
   *   cannot be read, because which attach owner to render for is then
   *   unknown.
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
        const foreign = foreignHostOwnerRemedy(conflicting, projectPath, this.hostnameFn());
        throw new BridgeAttachConflictError(
          `Another MCP session (server pid ${conflicting.pid}, attached mode) is already ` +
            `attached to this project. Only one attach session per project is supported, ` +
            `because attach mode bakes its port and token into the one shared bridge ` +
            `script. Stop that session first (stop_project there), then retry run_project ` +
            `with attach: true.${foreign?.note ?? ''}`,
          conflicting,
          foreign?.solution,
        );
      }
    }

    // .gdignore must exist before a .gd file lands under .mcp/, and on every
    // inject rather than only once — a project can be missing it if a git
    // checkout or a sibling process's cleanup removed the whole .mcp/ subtree
    // between sessions.
    BridgeManager.ensureMcpGdignore(projectPath);
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
    let attachOwner: BridgeOwnerInfo | undefined;
    try {
      attachOwner = this.liveAttachOwner(projectPath, false);
    } catch (err) {
      // The registry became unreadable after the owner file went in. Nothing
      // else has been written yet, so withdraw the claim before failing, or it
      // would hold sibling servers' edit guards closed for a bridge that was
      // never injected.
      this.unlinkQuietly(this.ownerFilePath(projectPath));
      throw err;
    }
    this.writeRenderedScriptIfChanged(projectPath, template, attachOwner);

    BridgeManager.ensureGitignored(projectPath);

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
    this.repairedProjects.delete(projectPathKey(projectPath));
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
   *
   * Returns the steps that were attempted and not confirmed, as sentences a
   * caller can show: empty when everything this session owed the project was
   * removed. A caller with someone to tell (`stop_project`) reports them; the
   * exit-time callers have nobody to tell and ignore the return value.
   */
  cleanup(projectPath: string): string[] {
    const problems: string[] = [];
    const ownerFileFailure = this.unlinkQuietly(this.ownerFilePath(projectPath));
    if (ownerFileFailure !== null) {
      problems.push(
        `this session's bridge owner file could not be removed (${ownerFileFailure}), so the project still lists this session as running until this server process exits`,
      );
    }
    this.repairedProjects.delete(projectPathKey(projectPath));

    let liveOwners: OwnerFileEntry[];
    try {
      liveOwners = this.readLiveOwners(projectPath);
    } catch (err) {
      // Unknown is not empty: another session may still be relying on the
      // shared script and autoload entry, so they stay where they are.
      logDebug(`Non-fatal: Failed to read bridge owner registry during cleanup: ${err}`);
      const reason =
        err instanceof BridgeRegistryUnreadableError ? err.reason : describeFailure(err);
      problems.push(
        `the bridge owner registry could not be read (${reason}), so the shared bridge script and the ${BRIDGE_AUTOLOAD_NAME} autoload entry were left in place; ${REMOVAL_RETRY_NOTE}`,
      );
      return problems;
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
      return problems;
    }

    problems.push(...this.removeBridgeArtifacts(projectPath));
    return problems;
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
    // Keyed by the folded path, not the argument: headless tools pass the
    // path as the caller spelled it (forward slashes on Windows) while inject
    // and cleanup are called with the resolved one. Keyed by the raw string,
    // their invalidation would miss the spelling that was cached, and the
    // retry `cleanup` promises would never run.
    const cacheKey = projectPathKey(projectPath);
    if (this.repairedProjects.has(cacheKey)) return;
    const projectFile = join(projectPath, 'project.godot');
    if (!existsSync(projectFile)) return;
    try {
      const liveOwners = this.readLiveOwners(projectPath);
      if (liveOwners.length > 0) {
        this.repairedProjects.add(cacheKey);
        return;
      }

      const scriptPresent =
        existsSync(bridgeScriptAbsPath(projectPath)) ||
        existsSync(join(projectPath, LEGACY_BRIDGE_SCRIPT_FILENAME));
      // Read with the project.godot grammar, the same reader the removal
      // uses: a hand-edited `McpBridge = "..."` is an entry too, and a
      // substring test for `McpBridge=` would miss it.
      const entryPresent = this.readBridgeAutoload(projectFile) !== undefined;
      const stranded = entryPresent || scriptPresent;
      if (stranded) {
        const problems = this.removeBridgeArtifacts(projectPath);
        if (problems.length > 0) {
          // Not cached as clean: the next headless operation tries again,
          // which is the retry `cleanup` promises a caller it reported to.
          logDebug(`Stranded McpBridge artifacts were not fully removed: ${problems.join('; ')}`);
          return;
        }
        logDebug('Cleaned up stranded McpBridge artifacts');
      }
      this.repairedProjects.add(cacheKey);
    } catch (err) {
      logDebug(`Non-fatal: Failed to check/repair orphaned bridge: ${err}`);
    }
  }

  /**
   * Live owners of this project other than this instance, pruning dead ones
   * as a side effect (via the registry read below). Used by
   * `GodotRunner.otherLiveSessionsOnProject` to power the cross-server edit
   * guard.
   *
   * @throws {BridgeRegistryUnreadableError} if the registry exists and cannot
   *   be read. The guard must refuse on that, not read it as "nobody".
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
    return bridgeOwnerFileName({ pid: this.pid, instanceId: this.instanceId });
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
   *
   * Only an absent registry is an empty one. A directory that exists and
   * cannot be listed, or an owner file that exists and cannot be opened, is a
   * registry whose contents are unknown, and answering "no live owners" for
   * it would let a headless edit race another session's game and let cleanup
   * tear the shared artifacts down under it. Both throw instead. A file is
   * pruned only when it was read and turned out invalid or dead: a file that
   * could not be read may be a live owner's, caught mid-write by a sibling.
   *
   * @throws {BridgeRegistryUnreadableError} when the registry exists and
   *   could not be read. Nothing is pruned for the unreadable part.
   */
  private readLiveOwners(projectPath: string): OwnerFileEntry[] {
    const dir = bridgeOwnersDir(projectPath);
    let fileNames: string[];
    try {
      fileNames = readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch (err) {
      if (failureCode(err) === 'ENOENT') return [];
      throw new BridgeRegistryUnreadableError(`cannot list ${dir}: ${describeFailure(err)}`);
    }

    const live: OwnerFileEntry[] = [];
    for (const fileName of fileNames) {
      const filePath = join(dir, fileName);
      let raw: string;
      try {
        raw = readFileSync(filePath, 'utf8');
      } catch (err) {
        // Gone between the listing and this read: its owner just left.
        if (failureCode(err) === 'ENOENT') continue;
        throw new BridgeRegistryUnreadableError(`cannot read ${filePath}: ${describeFailure(err)}`);
      }
      let info: BridgeOwnerInfo | null = null;
      try {
        const parsed: unknown = JSON.parse(raw);
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
   *
   * Returns what was attempted and not confirmed. The two that matter are the
   * autoload entry and the scripts: an entry left behind while its script is
   * deleted breaks the user's own launches and lands in their repository if
   * committed. A `.uid` sidecar or an empty directory left behind is harmless
   * and is only logged.
   */
  private removeBridgeArtifacts(projectPath: string): string[] {
    const problems: string[] = [];
    const projectFile = join(projectPath, 'project.godot');
    let userOwnsEntry = false;
    try {
      const registeredPath = this.readBridgeAutoload(projectFile);
      userOwnsEntry = registeredPath !== undefined && !isServerOwnedBridgePath(registeredPath);
      if (userOwnsEntry) {
        logDebug(
          `Left user-registered ${BRIDGE_AUTOLOAD_NAME} autoload at ${registeredPath} untouched`,
        );
      } else if (registeredPath !== undefined) {
        const entryProblem = this.removeBridgeEntry(projectFile);
        if (entryProblem !== null) problems.push(entryProblem);
      }
    } catch (err) {
      logDebug(`Non-fatal: Failed to read ${BRIDGE_AUTOLOAD_NAME} from project.godot: ${err}`);
      problems.push(
        `project.godot could not be read (${describeFailure(err)}), so it is not known whether its ${BRIDGE_AUTOLOAD_NAME} autoload entry is still registered: ${BRIDGE_ENTRY_REMEDY}`,
      );
    }

    const scriptFailure = this.unlinkQuietly(bridgeScriptAbsPath(projectPath));
    if (scriptFailure !== null) {
      problems.push(
        `the bridge script could not be removed (${scriptFailure}); ${REMOVAL_RETRY_NOTE}`,
      );
    }
    this.unlinkQuietly(`${bridgeScriptAbsPath(projectPath)}.uid`);

    // Pre-namespace layout. Skipped when a user-owned entry is registered,
    // because a root mcp_bridge.gd under that entry is presumably theirs.
    if (!userOwnsEntry) {
      const legacyScript = join(projectPath, LEGACY_BRIDGE_SCRIPT_FILENAME);
      const legacyFailure = this.unlinkQuietly(legacyScript);
      if (legacyFailure !== null) {
        problems.push(
          `the project-root bridge script could not be removed (${legacyFailure}); ${REMOVAL_RETRY_NOTE}`,
        );
      }
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
    return problems;
  }

  /**
   * Remove the server-owned `McpBridge` entry from project.godot and read the
   * file back to confirm it is gone. The removal call returning is not the
   * entry being removed, so the answer comes from the second read. Returns
   * null when the entry is confirmed gone, otherwise the problem as a
   * sentence. Never throws.
   */
  private removeBridgeEntry(projectFile: string): string | null {
    try {
      this.removeAutoloadEntryFn(projectFile, BRIDGE_AUTOLOAD_NAME);
    } catch (err) {
      logDebug(`Non-fatal: Failed to clean ${BRIDGE_AUTOLOAD_NAME} from project.godot: ${err}`);
      return `the ${BRIDGE_AUTOLOAD_NAME} autoload entry could not be removed from project.godot (${describeFailure(err)}): ${BRIDGE_ENTRY_REMEDY}`;
    }
    try {
      const remaining = this.readBridgeAutoload(projectFile);
      if (remaining !== undefined && isServerOwnedBridgePath(remaining)) {
        return `the ${BRIDGE_AUTOLOAD_NAME} autoload entry is still registered in project.godot after the removal: ${BRIDGE_ENTRY_REMEDY}`;
      }
    } catch (err) {
      return `project.godot could not be read back (${describeFailure(err)}), so the removal of its ${BRIDGE_AUTOLOAD_NAME} autoload entry is not confirmed: ${BRIDGE_ENTRY_REMEDY}`;
    }
    logDebug(`Removed ${BRIDGE_AUTOLOAD_NAME} autoload from project.godot`);
    return null;
  }

  /**
   * Registered path of the `McpBridge` autoload, normalized to `res://` form,
   * or undefined when project.godot is missing or has no such entry. A
   * project.godot that exists and cannot be read throws: for a caller that is
   * about to report whether the entry was removed, that is not "no entry".
   */
  private readBridgeAutoload(projectFilePath: string): string | undefined {
    if (!existsSync(projectFilePath)) return undefined;
    const entry = parseAutoloads(projectFilePath).find((a) => a.name === BRIDGE_AUTOLOAD_NAME);
    return entry ? normalizeAutoloadPath(entry.path) : undefined;
  }

  /**
   * As `readBridgeAutoload`, with an unreadable project.godot treated as
   * having no entry. For the callers that only decide what to write next.
   */
  private findBridgeAutoload(projectFilePath: string): string | undefined {
    try {
      return this.readBridgeAutoload(projectFilePath);
    } catch {
      return undefined;
    }
  }

  /**
   * Remove one file if it exists. Never throws. Returns null when the file is
   * gone afterwards (removed, or never there), otherwise why it is not.
   */
  private unlinkQuietly(filePath: string): string | null {
    try {
      if (existsSync(filePath)) {
        unlinkSync(filePath);
        logDebug(`Removed ${filePath}`);
      }
      return null;
    } catch (err) {
      logDebug(`Non-fatal: Failed to remove ${filePath}: ${err}`);
      return describeFailure(err);
    }
  }

  /**
   * Guarantee `.mcp/.gdignore` and the `.mcp/` .gitignore entry before a
   * non-bridge writer puts files under `.mcp/`. The one entry point for any
   * writer under `.mcp/` that is not the bridge itself.
   */
  static ensureArtifactRoot(projectPath: string): void {
    BridgeManager.ensureMcpGdignore(projectPath);
    BridgeManager.ensureGitignored(projectPath);
  }

  private static ensureMcpGdignore(projectPath: string): void {
    const dir = mcpDir(projectPath);
    mkdirSync(dir, { recursive: true });
    const gdignorePath = join(dir, '.gdignore');
    if (existsSync(gdignorePath)) {
      return;
    }
    writeFileSync(gdignorePath, '', 'utf8');
    logDebug('Created .mcp/.gdignore');
  }

  private static ensureGitignored(projectPath: string): void {
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
