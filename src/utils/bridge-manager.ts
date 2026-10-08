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
  readProcessStartIdentity,
  startIdentityPlatform,
  startIdentityQuerySpawns,
} from './process-start-time.js';
import {
  addAutoloadEntry,
  normalizeAutoloadPath,
  parseAutoloads,
  parseAutoloadAssignments,
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

/** Autoload name this server reserves in a target project's `project.godot`; `run_project`'s pre-flight scan uses it to skip the injected bridge. */
export const BRIDGE_AUTOLOAD_NAME = 'McpBridge' as const;

/** `project.godot` already registers `McpBridge` at a path this server does not own: the one inject failure the user can act on, so it is surfaced instead of a bridge timeout. */
export class BridgeAutoloadCollisionError extends Error {
  constructor(
    message: string,
    readonly registeredPath: string,
  ) {
    super(message);
    this.name = 'BridgeAutoloadCollisionError';
  }
}

/** Attach `inject` while another live attach session owns the project: attach bakes port and token into the one shared script, so two owners would overwrite each other. */
export class BridgeAttachConflictError extends Error {
  constructor(
    message: string,
    readonly conflictingOwner: BridgeOwnerInfo,
    /** Set for a foreign-host owner: how to clear it when stale (see `foreignHostOwnerRemedy`). */
    readonly foreignHostSolution?: string,
  ) {
    super(message);
    this.name = 'BridgeAttachConflictError';
  }
}

/** The owner registry exists but could not be read: "unknown", not "no live owner". A guard refuses on it and a cleanup leaves the shared artifacts in place. */
export class BridgeRegistryUnreadableError extends Error {
  constructor(readonly reason: string) {
    super(`The bridge owner registry could not be read: ${reason}`);
    this.name = 'BridgeRegistryUnreadableError';
  }
}

const MCP_GITIGNORE_ENTRY = '.mcp/' as const;

// What to do about an McpBridge entry that cleanup could not remove or confirm; the first headless operation runs `repairOrphaned`.
const BRIDGE_ENTRY_REMEDY =
  'remove the McpBridge= line under [autoload] by hand, or run any headless tool on this project to retry';
// A stranded bridge script is removed by the same retry.
const REMOVAL_RETRY_NOTE = 'the next headless tool call on this project retries the removal';

// Marker line in mcp_bridge.gd that inject() rewrites per project.
const BAKED_PORT_REGEX = /const PORT := \d+/;

// Marker line in mcp_bridge.gd rewritten for attach-mode sessions; spawned sessions leave the shipped "" default.
const BAKED_TOKEN_REGEX = /const SESSION_TOKEN_BAKED := "[^"]*"/;

/** How long an "is this pid still the owner" answer is reused where asking runs a helper program (one per registry read would be felt). Unknown is cached too (a blocked helper fails the same way next read) but not for longer: a pid can be reissued to a newcomer. */
const OWNER_IDENTITY_CACHE_TTL_MS = 30000;

/** This process's own start identity by pid; fixed while it runs, so read once per process. */
const ownStartIdentityByPid = new Map<number, string | null>();

const OWNER_INSTANCE_ID_BYTES = 8;

export type BridgeSessionMode = 'spawned' | 'attached';

/** `'prune'` removes owner files of dead sessions as every ordinary read does; `'read-only'` gives the same answer and unlinks nothing. */
export type OwnerRegistryRead = 'prune' | 'read-only';

/** One registry entry: a live session's claim on a project's shared bridge artifacts, in its own file under `bridge/owners/`. `token` is present for attached mode only (no env channel; it is on disk in the script anyway). */
export interface BridgeOwnerInfo {
  pid: number;
  instanceId: string;
  hostname: string;
  mode: BridgeSessionMode;
  startedAt: string;
  /** Start identity from the OS when the file was written (process-start-time.ts); absent when unreadable or from a build that predates it, then the pid alone decides. */
  processStart?: string;
  port: number;
  token?: string;
}

export function bridgeOwnerFileName(info: Pick<BridgeOwnerInfo, 'pid' | 'instanceId'>): string {
  return `${info.pid}-${info.instanceId}.json`;
}

/** True when an owner recorded its start identity on another platform: its pid means nothing here even with this hostname (WSL shares the Windows computer name). */
export function ownerPlatformDiffers(
  info: Pick<BridgeOwnerInfo, 'processStart'>,
  thisPlatform: NodeJS.Platform = process.platform,
): boolean {
  const recorded = startIdentityPlatform(info.processStart);
  return recorded !== null && recorded !== thisPlatform;
}

/** The note and solution for a caller blocked by a foreign-host owner (or a same-hostname owner of another platform), else null. Such an owner cannot be probed and counts as live while its file exists, so the refusal must name the host and the file. */
export function foreignHostOwnerRemedy(
  info: BridgeOwnerInfo,
  projectPath: string,
  thisHostname: string = osHostname(),
  thisPlatform: NodeJS.Platform = process.platform,
): { note: string; solution: string } | null {
  const ownerFile = join(bridgeOwnersDir(projectPath), bridgeOwnerFileName(info));
  if (info.hostname === thisHostname) {
    if (!ownerPlatformDiffers(info, thisPlatform)) return null;
    return {
      note: ` That session was registered on this hostname from another operating-system environment ("${startIdentityPlatform(info.processStart)}"; this server runs on "${thisPlatform}"), such as WSL or a container sharing the project directory, so this server cannot check whether it is still running and treats it as live.`,
      solution: `If that session is known to be gone, delete its owner file ${ownerFile} and retry`,
    };
  }
  return {
    note: ` That session was registered from another host ("${info.hostname}"; this host is "${thisHostname}"), so this server cannot check whether it is still running and treats it as live.`,
    solution: `If that session is known to be gone (the project was copied or synced from another machine, or this host was renamed), delete its owner file ${ownerFile} and retry`,
  };
}

type RemoveAutoloadEntryFn = (
  projectFile: string,
  name: string,
  shouldRemove?: (entryPath: string) => boolean,
) => boolean;

interface OwnerFileEntry {
  fileName: string;
  info: BridgeOwnerInfo;
}

/** Test seams; production omits `options`. */
export interface BridgeManagerOptions {
  isProcessAlive?: (pid: number) => boolean;
  hostname?: () => string;
  pid?: () => number;
  removeAutoloadEntry?: RemoveAutoloadEntryFn;
  /** Start identity of the process holding a pid, or null. Default: the platform reader. */
  processStartIdentity?: (pid: number) => string | null;
  cacheProcessStartIdentity?: boolean;
  now?: () => number;
  unlink?: (filePath: string) => void;
  platform?: NodeJS.Platform;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    // Signal 0 only probes. ESRCH: dead. EPERM: exists but not signalable, still evidence of life.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

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
    (v.processStart === undefined || typeof v.processStart === 'string') &&
    typeof v.port === 'number' &&
    (v.token === undefined || typeof v.token === 'string')
  );
}

/** Owns the McpBridge autoload artifacts: the script copy and owner registry under `.mcp/godot-runtime/bridge/`, the `[autoload]` entry, the `.mcp/.gdignore` marker and the `.gitignore` entry. Designed for N server processes sharing a project, so every entry point reads disk, never in-memory state. Gap: two servers doing read-modify-write on `project.godot` at once can lose an edit (no file lock); the owner file written first and the next inject narrow it. An older server writes no owner file and is invisible here. An `McpBridge` entry at a path that is not server-owned (`isServerOwnedBridgePath`) is the user's: inject refuses and cleanup leaves it. */
export class BridgeManager {
  private repairedProjects: Set<string> = new Set();
  private readonly instanceId: string;
  private readonly pid: number;
  private readonly hostnameFn: () => string;
  private readonly isProcessAliveFn: (pid: number) => boolean;
  private readonly removeAutoloadEntryFn: RemoveAutoloadEntryFn;
  private readonly processStartIdentityFn: (pid: number) => string | null;
  private readonly usesDefaultIdentityReader: boolean;
  private readonly cacheProcessStartIdentity: boolean;
  private readonly nowFn: () => number;
  private readonly unlinkFn: (filePath: string) => void;
  private readonly platform: NodeJS.Platform;
  /** "Does this pid still belong to the owner that recorded this identity", keyed by both so a reissued pid is asked afresh, with when each lapses. */
  private readonly ownerVerdicts = new Map<string, { belongs: boolean; until: number }>();
  private ownStartIdentity: string | null | undefined;
  /** False during an exit-handler cleanup: a helper program there blocks the exit, so only answers in hand are used. */
  private helperProgramsAllowed = true;

  constructor(
    private bridgeScriptPath: string,
    options: BridgeManagerOptions = {},
  ) {
    this.instanceId = randomBytes(OWNER_INSTANCE_ID_BYTES).toString('hex');
    this.pid = options.pid ? options.pid() : process.pid;
    this.hostnameFn = options.hostname ?? (() => osHostname());
    this.isProcessAliveFn = options.isProcessAlive ?? defaultIsProcessAlive;
    this.removeAutoloadEntryFn = options.removeAutoloadEntry ?? removeAutoloadEntry;
    this.usesDefaultIdentityReader = options.processStartIdentity === undefined;
    this.processStartIdentityFn =
      options.processStartIdentity ?? ((pid) => readProcessStartIdentity(pid));
    this.cacheProcessStartIdentity =
      options.cacheProcessStartIdentity ?? startIdentityQuerySpawns(process.platform);
    this.nowFn = options.now ?? (() => Date.now());
    this.unlinkFn = options.unlink ?? unlinkSync;
    this.platform = options.platform ?? process.platform;
  }

  /** Everything about an inject that can refuse, checked without changing the project (the registry read prunes dead owners, nothing else is written), so a start that runs it first costs the project nothing on refusal. Whether `project.godot` can be written is not probed: the atomic write is a rename the directory decides, and a failed write fails the inject. @param attach only an attach-mode start is subject to the one-attach-owner rule. @returns the template text. @throws {BridgeAutoloadCollisionError} @throws {BridgeAttachConflictError} @throws {BridgeRegistryUnreadableError} */
  precheckInject(projectPath: string, attach: boolean): string {
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

    const liveOwners = this.readLiveOwners(projectPath);
    if (attach) {
      const conflicting = liveOwners
        .filter((e) => !this.isSelfOwnerFile(e.fileName))
        .find((e) => e.info.mode === 'attached')?.info;
      if (conflicting) {
        const foreign = foreignHostOwnerRemedy(
          conflicting,
          projectPath,
          this.hostnameFn(),
          this.platform,
        );
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
    return template;
  }

  /** Precheck, then commit; repeated by every caller that ran the precheck and then awaited. `bakedToken` is for attach mode only (Node cannot set the env var on the user's Godot); spawned sessions omit it. A failed commit may leave the owner file and script: the caller runs `cleanup` (`GodotRunner.discardFailedStart`). */
  inject(projectPath: string, port: number, bakedToken?: string): void {
    const template = this.precheckInject(projectPath, bakedToken !== undefined);
    this.commitInject(projectPath, port, bakedToken, template);
  }

  private commitInject(
    projectPath: string,
    port: number,
    bakedToken: string | undefined,
    template: string,
  ): void {
    const projectFile = join(projectPath, 'project.godot');

    // .gdignore must exist before a .gd file lands under .mcp/, on every inject: a checkout or sibling cleanup may have removed .mcp/.
    BridgeManager.ensureMcpGdignore(projectPath);
    mkdirSync(bridgeOwnersDir(projectPath), { recursive: true });

    // Owner file lands BEFORE the shared script and project.godot are looked at: a concurrent sibling cleanup either sees it and leaves the artifacts, or has removed them and the checks below rewrite them (other half: `removeUnclaimedArtifacts`).
    const processStart = this.readOwnStartIdentity();
    const ownerInfo: BridgeOwnerInfo = {
      pid: this.pid,
      instanceId: this.instanceId,
      hostname: this.hostnameFn(),
      mode: bakedToken !== undefined ? 'attached' : 'spawned',
      startedAt: new Date().toISOString(),
      ...(processStart !== null ? { processStart } : {}),
      port,
      ...(bakedToken !== undefined ? { token: bakedToken } : {}),
    };
    writeFileAtomicSync(this.ownerFilePath(projectPath), JSON.stringify(ownerInfo, null, 2));
    logDebug(`Wrote bridge owner file for pid ${this.pid} (${ownerInfo.mode})`);

    // Render from the live attach owner on record (self included).
    let attachOwner: BridgeOwnerInfo | undefined;
    try {
      attachOwner = this.liveAttachOwner(projectPath);
    } catch (err) {
      // The registry became unreadable after the owner file went in; withdraw the claim or it holds sibling servers' edit guards closed for a bridge never injected.
      this.unlinkQuietly(this.ownerFilePath(projectPath));
      throw err;
    }
    this.writeRenderedScriptIfChanged(projectPath, template, attachOwner);

    BridgeManager.ensureGitignored(projectPath);
    this.ensureBridgeEntry(projectFile, () => {
      // Withdraw the owner file: it would hold sibling edit guards closed for a session that never started.
      this.unlinkQuietly(this.ownerFilePath(projectPath));
    });

    // Disk changed; the next repairOrphaned check must re-read it.
    this.repairedProjects.delete(projectPathKey(projectPath));
  }

  /** Make project.godot register `McpBridge` at this server's script: add it, repoint an older location, or leave it. Re-reads the file: a sibling may have added or migrated the entry, and a stale value would add a duplicate. @throws {BridgeAutoloadCollisionError} for a user's own entry, after calling `beforeCollisionThrow`. */
  private ensureBridgeEntry(projectFile: string, beforeCollisionThrow: () => void): void {
    const currentEntry = this.findBridgeAutoload(projectFile);
    if (currentEntry !== undefined && !isServerOwnedBridgePath(currentEntry)) {
      beforeCollisionThrow();
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
      // Path drift from an older version or namespace: repoint rather than add a second entry.
      updateAutoloadEntry(projectFile, BRIDGE_AUTOLOAD_NAME, BRIDGE_SCRIPT_RES_PATH, true);
      logDebug(`Migrated bridge autoload from ${currentEntry} to ${BRIDGE_SCRIPT_RES_PATH}`);
    } else {
      logDebug('Bridge autoload already present, skipping injection');
    }
  }

  /** Leave this instance's session: delete its owner file and re-read the registry. If other live owners remain, the shared script and entry stay (the script is re-rendered, resetting baked attach values when the leaving session was the attach owner); otherwise they are removed. Synchronous and never throwing, because `cleanupAtExit` runs it from a `process.on('exit')` handler with nowhere to report; each step is try/caught. Returns the steps attempted and not confirmed, as sentences (empty when complete); exit-time callers ignore it. */
  cleanup(projectPath: string): string[] {
    const problems: string[] = [];
    const ownerFile = this.ownerFilePath(projectPath);
    const ownerFileFailure = this.unlinkQuietly(ownerFile);
    if (ownerFileFailure !== null) {
      problems.push(
        `this session's bridge owner file ${ownerFile} could not be removed (${ownerFileFailure}), so the project still lists this session as running until this server process exits or the file is deleted`,
      );
    }
    this.repairedProjects.delete(projectPathKey(projectPath));

    let liveOwners: OwnerFileEntry[];
    try {
      // This session is leaving: its own file, if it could not be removed, is not a claim.
      liveOwners = this.readOtherLiveOwners(projectPath);
    } catch (err) {
      // Unknown is not empty: another session may rely on the shared artifacts, so they stay.
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

    problems.push(...this.removeUnclaimedArtifacts(projectPath, 'self-is-leaving'));
    return problems;
  }

  /** `cleanup` for the exit handler: no helper program runs to check pid reuse, so an owner without an answer in hand counts as live; if it was dead, the next headless operation removes the artifacts (`repairOrphaned`). */
  cleanupAtExit(projectPath: string): string[] {
    this.helperProgramsAllowed = false;
    try {
      return this.cleanup(projectPath);
    } finally {
      this.helperProgramsAllowed = true;
    }
  }

  /** Clear bridge artifacts stranded by a hard-killed server: an `McpBridge=` line without its script, or a script, with no live registered owner. Runs from `executeOperation`, so the first headless op of any kind (`validate` included) can clear them; `removeBridgeArtifacts` bounds what it may delete to server-owned paths. Only the clean verdict is cached per project; a project with a live owner is re-read every time, and `inject`/`cleanup` clear the cache. An older server writes no owner file, so its artifacts can be misclassified as stranded. */
  repairOrphaned(projectPath: string): void {
    // Keyed by the folded path: headless tools pass the caller's spelling while inject and cleanup use the resolved one, and a raw key would miss the invalidation and skip the promised retry.
    const cacheKey = projectPathKey(projectPath);
    if (this.repairedProjects.has(cacheKey)) return;
    const projectFile = join(projectPath, 'project.godot');
    if (!existsSync(projectFile)) return;
    try {
      // Not cached: a live owner can die and strand the bridge at any time.
      if (this.readLiveOwners(projectPath).length > 0) return;

      const scriptPresent =
        existsSync(bridgeScriptAbsPath(projectPath)) ||
        existsSync(join(projectPath, LEGACY_BRIDGE_SCRIPT_FILENAME));
      // Read with the project.godot grammar: a hand-edited `McpBridge = "..."` is an entry too and a substring test would miss it.
      const entryPresent = this.readBridgeAssignments(projectFile).length > 0;
      const stranded = entryPresent || scriptPresent;
      if (stranded) {
        const problems = this.removeUnclaimedArtifacts(projectPath, 'any-owner');
        if (problems.length > 0) {
          // Not cached as clean: the next headless operation retries, as `cleanup` promised.
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

  /** Live owners other than this instance, pruning dead ones; powers the cross-server edit guard. @throws {BridgeRegistryUnreadableError} the guard must refuse on that, not read "nobody". */
  listOtherLiveOwners(projectPath: string): BridgeOwnerInfo[] {
    return this.readLiveOwners(projectPath)
      .filter((e) => !this.isSelfOwnerFile(e.fileName))
      .map((e) => e.info);
  }

  /** `listOtherLiveOwners` without pruning, for a caller that has promised to write nothing yet (`render_movie` ahead of its launch gate). @throws {BridgeRegistryUnreadableError} */
  peekOtherLiveOwners(projectPath: string): BridgeOwnerInfo[] {
    return this.readLiveOwners(projectPath, false)
      .filter((e) => !this.isSelfOwnerFile(e.fileName))
      .map((e) => e.info);
  }

  /** Whether `project.godot` registers the `McpBridge` autoload at this server's script; tells "no bridge at all" from "never became ready". */
  isBridgeAutoloadRegistered(projectPath: string): boolean {
    const projectFile = join(projectPath, 'project.godot');
    const entry = this.findBridgeAutoload(projectFile);
    return entry !== undefined && entry === normalizeAutoloadPath(BRIDGE_SCRIPT_RES_PATH);
  }

  /** Render the template with the attach owner's port and token baked in, or unchanged when there is none. Spawned sessions never bake, so the script is identical across them, which makes the "write only when different" check meaningful across sibling processes. */
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

  /** This instance's owner file; stable across its lifetime so a re-inject overwrites its own file. */
  private ownerFilePath(projectPath: string): string {
    return join(bridgeOwnersDir(projectPath), this.ownerFileName());
  }

  private ownerFileName(): string {
    return bridgeOwnerFileName({ pid: this.pid, instanceId: this.instanceId });
  }

  private isSelfOwnerFile(fileName: string): boolean {
    return fileName === this.ownerFileName();
  }

  private isOwnerLive(info: BridgeOwnerInfo, isSelf: boolean): boolean {
    // A foreign host cannot be probed, so it is treated as live rather than pruned.
    if (info.hostname !== this.hostnameFn()) return true;
    // Same hostname, another pid table (WSL beside Windows): equally unprobeable.
    if (!isSelf && ownerPlatformDiffers(info, this.platform)) return true;
    if (!this.isProcessAliveFn(info.pid)) return false;
    // This instance's own file was written by the running code.
    if (isSelf) return true;
    return this.pidStillBelongsToOwner(info);
  }

  /** False when the process holding the owner's pid is known to be a different one (the owner died and the OS reissued the pid); otherwise a hard-killed server would count as live for good and the stranded bridge never be repaired. Decided by equality of two start-identity readings, never the wall clock. True when either side is missing (unknown keeps the pid-only answer). */
  private pidStillBelongsToOwner(info: BridgeOwnerInfo): boolean {
    const recorded = info.processStart;
    if (recorded === undefined) return true;
    // Another BridgeManager in this process, or an earlier process with this pid: own identity is read at most once.
    if (info.pid === this.pid) {
      const own = this.readOwnStartIdentity();
      return own === null || own === recorded;
    }
    const cacheKey = `${info.pid}:${recorded}`;
    const now = this.nowFn();
    if (this.cacheProcessStartIdentity) {
      const cached = this.ownerVerdicts.get(cacheKey);
      if (cached !== undefined && now < cached.until) return cached.belongs;
      this.ownerVerdicts.delete(cacheKey);
      if (!this.helperProgramsAllowed) return true;
    }
    const current = this.processStartIdentityFn(info.pid);
    const belongs = current === null || current === recorded;
    if (this.cacheProcessStartIdentity) {
      this.ownerVerdicts.set(cacheKey, { belongs, until: now + OWNER_IDENTITY_CACHE_TTL_MS });
    }
    return belongs;
  }

  /** This process's own start identity or null; read once. Null without reading when that would run a helper program and none may be run. */
  private readOwnStartIdentity(): string | null {
    if (this.ownStartIdentity !== undefined) return this.ownStartIdentity;
    const shared = this.usesDefaultIdentityReader ? ownStartIdentityByPid.get(this.pid) : undefined;
    if (shared !== undefined) {
      this.ownStartIdentity = shared;
      return shared;
    }
    if (this.cacheProcessStartIdentity && !this.helperProgramsAllowed) return null;
    const identity = this.processStartIdentityFn(this.pid);
    this.ownStartIdentity = identity;
    if (this.usesDefaultIdentityReader) ownStartIdentityByPid.set(this.pid, identity);
    return identity;
  }

  /** Read every owner file, pruning (best-effort unlink) the unparseable or dead; the single point that prunes the registry. With `prune` false nothing is unlinked. Only an absent registry is empty: an unlistable directory or unopenable file throws, since "no live owners" there would let a headless edit race another session's game or cleanup tear down shared artifacts. A file is pruned only when read and found invalid or dead; an unreadable one may be a live owner's, mid-write. @throws {BridgeRegistryUnreadableError} */
  private readLiveOwners(projectPath: string, prune: boolean = true): OwnerFileEntry[] {
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
        // Gone between listing and read: its owner just left.
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

      if (info === null || !this.isOwnerLive(info, this.isSelfOwnerFile(fileName))) {
        if (prune) this.unlinkQuietly(filePath);
        continue;
      }
      live.push({ fileName, info });
    }
    return live;
  }

  /** `readLiveOwners` without this instance's own owner file. */
  private readOtherLiveOwners(projectPath: string): OwnerFileEntry[] {
    return this.readLiveOwners(projectPath).filter((e) => !this.isSelfOwnerFile(e.fileName));
  }

  /** The live attach-mode owner on this project, this instance included, or undefined. */
  private liveAttachOwner(projectPath: string): BridgeOwnerInfo | undefined {
    return this.readLiveOwners(projectPath).find((e) => e.info.mode === 'attached')?.info;
  }

  /** Remove the shared artifacts of a project no live session owns, without taking them from a session claiming it meanwhile. No lock: an inject writes its owner file before looking at the script and entry, and this re-reads the registry after removing, so one side always sees the other (the inject rewrites what is gone, or this restores it). `'self-is-leaving'` ignores this instance's own owner file, still there only because it could not be removed. Synchronous and non-throwing. */
  private removeUnclaimedArtifacts(
    projectPath: string,
    claimants: 'any-owner' | 'self-is-leaving',
  ): string[] {
    const problems = this.removeBridgeArtifacts(projectPath);
    let claimedBy: OwnerFileEntry[];
    try {
      claimedBy =
        claimants === 'self-is-leaving'
          ? this.readOtherLiveOwners(projectPath)
          : this.readLiveOwners(projectPath);
    } catch (err) {
      logDebug(`Non-fatal: could not re-read the owner registry after removal: ${err}`);
      return problems;
    }
    if (claimedBy.length === 0) return problems;
    // A session registered during removal: the artifacts are its now, so they are restored and nothing is reported as a problem.
    try {
      const template = readFileSync(this.bridgeScriptPath, 'utf8');
      const attachOwner = claimedBy.find((e) => e.info.mode === 'attached')?.info;
      this.writeRenderedScriptIfChanged(projectPath, template, attachOwner);
      this.ensureBridgeEntry(join(projectPath, 'project.godot'), () => {});
      logDebug('Restored the shared bridge artifacts for a session that registered during removal');
    } catch (err) {
      logDebug(`Non-fatal: could not restore the shared bridge artifacts: ${err}`);
    }
    return [];
  }

  /** Remove the shared artifacts: the autoload entry, the namespaced and legacy root scripts with their `.uid`, then `owners/` and `bridge/` once empty. Each step is try/caught. Callers confirm no live owner first; this does not check. Never touches `screenshots/`, `scripts/`, `validate/`, `.mcp/godot-runtime/` or `.mcp/.gdignore` (handed-out paths stay resolvable); legacy `.mcp/screenshots/` and `.mcp/scripts/` are left. */
  // A user-owned `McpBridge` assignment, and the project-root script while one exists, are left alone. With no entry at all, a root file named exactly `mcp_bridge.gd` is removed as ours. Returns unconfirmed steps; a left entry or script matters (it breaks the user's launches), a `.uid` or empty directory is only logged.
  private removeBridgeArtifacts(projectPath: string): string[] {
    const problems: string[] = [];
    const projectFile = join(projectPath, 'project.godot');
    let userOwnsEntry = false;
    try {
      // Every assignment, not only the one the engine keeps: a server-owned line overridden by a user's is still ours to remove, and the reverse must stay.
      const assignedPaths = this.readBridgeAssignments(projectFile);
      const userPath = assignedPaths.find((path) => !isServerOwnedBridgePath(path));
      userOwnsEntry = userPath !== undefined;
      if (userPath !== undefined) {
        logDebug(`Left user-registered ${BRIDGE_AUTOLOAD_NAME} autoload at ${userPath} untouched`);
      }
      if (assignedPaths.some(isServerOwnedBridgePath)) {
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

    // Pre-namespace layout; skipped when the user registers their own McpBridge, next to which a root mcp_bridge.gd is presumably theirs.
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
        // rmdirSync, not rmSync: it throws ENOTEMPTY, so a file that raced in is left alone.
        rmdirSync(bridgeOwnersDir(projectPath));
        logDebug('Removed the bridge/owners/ directory');
      }
    } catch (err) {
      logDebug(`Non-fatal: Failed to remove the bridge/owners/ directory: ${err}`);
    }

    try {
      if (existsSync(bridgeDir(projectPath))) {
        // rmdirSync, not rmSync: it throws ENOTEMPTY on a non-empty directory, and rmSync without `recursive` cannot remove a directory (ERR_FS_EISDIR).
        rmdirSync(bridgeDir(projectPath));
        logDebug('Removed the bridge/ directory');
      }
    } catch (err) {
      logDebug(`Non-fatal: Failed to remove the bridge/ directory: ${err}`);
    }
    return problems;
  }

  /** Remove every server-owned `McpBridge` assignment and read the file back to confirm: the call returning is not the entry being removed. A user's line is never removed, even when it overrides or is overridden by ours. Returns null when none remains, else the problem as a sentence. Never throws. */
  private removeBridgeEntry(projectFile: string): string | null {
    try {
      this.removeAutoloadEntryFn(projectFile, BRIDGE_AUTOLOAD_NAME, isServerOwnedBridgePath);
    } catch (err) {
      logDebug(`Non-fatal: Failed to clean ${BRIDGE_AUTOLOAD_NAME} from project.godot: ${err}`);
      return `the ${BRIDGE_AUTOLOAD_NAME} autoload entry could not be removed from project.godot (${describeFailure(err)}): ${BRIDGE_ENTRY_REMEDY}`;
    }
    try {
      if (this.readBridgeAssignments(projectFile).some(isServerOwnedBridgePath)) {
        return `the ${BRIDGE_AUTOLOAD_NAME} autoload entry is still registered in project.godot after the removal: ${BRIDGE_ENTRY_REMEDY}`;
      }
    } catch (err) {
      return `project.godot could not be read back (${describeFailure(err)}), so the removal of its ${BRIDGE_AUTOLOAD_NAME} autoload entry is not confirmed: ${BRIDGE_ENTRY_REMEDY}`;
    }
    logDebug(`Removed ${BRIDGE_AUTOLOAD_NAME} autoload from project.godot`);
    return null;
  }

  /** Registered path of the `McpBridge` autoload in `res://` form, or undefined. An unreadable project.godot throws: for a caller reporting removal that is not "no entry". */
  private readBridgeAutoload(projectFilePath: string): string | undefined {
    if (!existsSync(projectFilePath)) return undefined;
    const entry = parseAutoloads(projectFilePath).find((a) => a.name === BRIDGE_AUTOLOAD_NAME);
    return entry ? normalizeAutoloadPath(entry.path) : undefined;
  }

  /** Every `McpBridge` assignment's path, overridden ones included, in file order. Throws as `readBridgeAutoload` does. */
  private readBridgeAssignments(projectFilePath: string): string[] {
    if (!existsSync(projectFilePath)) return [];
    return parseAutoloadAssignments(projectFilePath, BRIDGE_AUTOLOAD_NAME).map((entry) =>
      normalizeAutoloadPath(entry.path),
    );
  }

  /** As `readBridgeAutoload`, an unreadable project.godot counting as no entry; for callers deciding what to write next. */
  private findBridgeAutoload(projectFilePath: string): string | undefined {
    try {
      return this.readBridgeAutoload(projectFilePath);
    } catch {
      return undefined;
    }
  }

  /** Remove one file if present, never throwing; null when it is gone afterwards, else why not. */
  private unlinkQuietly(filePath: string): string | null {
    try {
      if (existsSync(filePath)) {
        this.unlinkFn(filePath);
        logDebug(`Removed ${filePath}`);
      }
      return null;
    } catch (err) {
      logDebug(`Non-fatal: Failed to remove ${filePath}: ${err}`);
      return describeFailure(err);
    }
  }

  /** Create `.mcp/.gdignore` and the `.mcp/` .gitignore entry before a non-bridge writer puts files under `.mcp/`. */
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
