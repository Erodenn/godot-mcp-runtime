/**
 * Launch gate: the pre-flight security scan and the once-per-project session
 * confirmation that run before this server starts, or injects into, a Godot
 * project.
 *
 * Kept free of `GodotRunner` and of everything under `src/tools/`, so any
 * handler that launches a project can call it without pulling in the spawn or
 * attach paths. The scan itself still routes through `evaluateScript` in
 * `run-script-policy.ts`; this module only decides which files to feed it and
 * what to do with the findings.
 */

import { existsSync, readFileSync } from 'fs';
import { relative, resolve } from 'path';
import type { ToolResponse } from '../mcp.types.js';
import { isServerOwnedBridgePath } from './artifact-paths.js';
import { parseAutoloadSection } from './autoload-ini.js';
import { BRIDGE_AUTOLOAD_NAME } from './bridge-manager.js';
import { createErrorResponse, getErrorMessage } from './error-response.js';
import {
  isElicitAccepted,
  normalizeProjectKey,
  type ElicitorResult,
  type McpContext,
} from './mcp-context.js';
import {
  isLaunchScenePath,
  isUnderDir,
  LAUNCH_SCENE_EXTENSIONS,
  projectGodotPath,
  resolveProjectPath,
  type ResolvedProjectPath,
} from './path-validation.js';
import { ok, err, type Result } from './result.js';
import { evaluateScript, type PolicyMatch } from './run-script-policy.js';
import { collectSceneScripts } from './scene-parsing.js';
import {
  findFilesByUid,
  isUidReference,
  resolveLaunchScene,
  UID_SEARCH_CUT_SHORT_CAUSE,
} from './launch-scene.js';

const MAX_STRICT_REJECT_LINES_SHOWN = 5;
/** Cap on the findings a gate outcome carries before the `+N more` tail. */
export const MAX_SCAN_WARNINGS_SHOWN = 10;
/**
 * Cap on the scan warnings (what could not be scanned, what was skipped) a gate
 * outcome carries, counted apart from the findings so a long list of findings
 * never pushes an incomplete-scan notice out of the answer.
 */
export const MAX_SCAN_INCOMPLETE_SHOWN = 10;
const GDSCRIPT_EXTENSION = '.gd';
const SCENE_EXTENSION = '.tscn';
/** Why a reference the engine would still try to load was not scanned. */
const UNRESOLVED_PATH_CAUSE = 'the path could not be resolved to a file inside the project';
/** What a `project.godot` with lines Godot did not write means for the scan. */
const NON_CANONICAL_PROJECT_FILE_CAUSE =
  'The autoloads and main scene could not be read reliably, so what the engine loads may not be what was scanned. Rewrite those lines as one key=value statement per line';
/**
 * The one thing to do about a strict-mode refusal that the project itself
 * cannot fix. Strict mode is how an operator bounds a run nobody is watching,
 * so a refusal is never answered by advising the agent to turn it off.
 */
const STRICT_MODE_IS_OPERATOR_SETTING =
  'Strict mode (GODOT_MCP_STRICT) is an operator setting: report this refusal to the user rather than changing it';
/** Offered only for a prompt the client dismissed by itself, never for a user's decline. */
const ELICITATION_OPT_OUT_SOLUTION =
  'If your client cannot display confirmation prompts, set GODOT_MCP_DISABLE_ELICITATION=true to skip them';

/**
 * Refuse a `scene` argument the engine would not run as a scene, or null when
 * the argument is one. Called by every launcher before the gate: the gate
 * scans the scene it is given, and Godot silently runs the project's main
 * scene instead when the argument has no scene extension, so letting such a
 * value through would scan one file and launch another.
 */
export function rejectNonSceneLaunchArg(scene: string): ToolResponse | null {
  if (isLaunchScenePath(scene)) return null;
  return createErrorResponse(
    `Invalid scene: "${scene}" does not end in ${LAUNCH_SCENE_EXTENSIONS.join(' or ')} (lower case). Godot runs a command-line scene only when it carries a scene file extension; anything else is ignored and the project's main scene runs instead.`,
    [
      'Pass the scene file with its extension, e.g. "scenes/main.tscn"',
      "Omit scene to launch the project's main scene",
    ],
  );
}

export interface LaunchGateRequest {
  /** Validated project directory; resolved to an absolute path inside. */
  projectPath: string;
  /** Resolved launch scene. Undefined scans `run/main_scene`. */
  scene?: ResolvedProjectPath | undefined;
  /** Run the once-per-project session confirmation. */
  confirm: boolean;
  /**
   * True when this server starts the process (`run_project` in spawn mode,
   * `render_movie`), so the scene it runs is the one the gate scanned. False
   * for attach mode, where the user launches Godot and may pick a scene the
   * server never sees: a project with no main scene is then only a warning in
   * strict mode, because the missing scene says nothing about what runs.
   */
  launchedByServer: boolean;
  /** Names the caller in the prompt, the refusals and the warnings. */
  toolName: string;
}

export interface LaunchGateOutcome {
  /**
   * Scan findings first, capped at `MAX_SCAN_WARNINGS_SHOWN` entries plus a
   * `+N more` entry; then the scan warnings, capped at
   * `MAX_SCAN_INCOMPLETE_SHOWN` entries plus a `+N more files were not scanned`
   * entry; then the confirmation warning, when there is one, which no cap cuts.
   */
  warnings: string[];
}

/** A finding and the name to show for the source it came from. */
interface ScanFinding {
  label: string;
  match: PolicyMatch;
}

/**
 * The name to show for a file: project-relative when it is inside the project.
 * Out-of-tree paths are surfaced verbatim (path.relative would emit
 * `..`-prefixed strings that obscure where the file actually lives).
 */
function displayPath(projectPath: string, sourcePath: string): string {
  return isUnderDir(projectPath, sourcePath) ? relative(projectPath, sourcePath) : sourcePath;
}

/**
 * Build a one-line summary of a project-scan finding so a launch response can
 * carry a `warnings` array without flooding it.
 */
function formatScanFinding(finding: ScanFinding): string {
  return `${finding.label}:${finding.match.line} ${finding.match.matchedText} - ${finding.match.reason}`;
}

/**
 * Scan a single .gd file. Missing/unreadable files are reported as a single
 * warning string; the caller decides whether to surface them. `readFailed` is
 * true when the file exists and the read failed, which is not the same thing
 * as a file that is not there: the scan set out to read it and could not.
 * Tier and strict promotion semantics match `evaluateScript`.
 */
function scanScriptFile(
  filePath: string,
  strict: boolean,
): { findings: PolicyMatch[]; warning: string | null; readFailed: boolean } {
  let source: string;
  try {
    source = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        findings: [],
        warning: `Could not scan ${filePath} (file not found)`,
        readFailed: false,
      };
    }
    return {
      findings: [],
      warning: `Could not scan ${filePath}: ${getErrorMessage(error)}`,
      readFailed: true,
    };
  }
  const decision = evaluateScript(source, strict);
  return { findings: decision.matches, warning: null, readFailed: false };
}

/**
 * Run the launch gate for one project. Returns the warnings to attach to the
 * caller's success payload, or the refusal response to return as is.
 *
 * `request.confirm: false` is for a caller that launches nothing itself: the
 * scan and its strict-mode refusal still run, the elicitor is never called and
 * the confirmed-project set is never written.
 */
export async function runLaunchGate(
  request: LaunchGateRequest,
  ctx: McpContext,
): Promise<Result<LaunchGateOutcome, ToolResponse>> {
  // Skipped entirely when GODOT_MCP_DISABLE_SECURITY is set (complete no-op,
  // Tier 1 included, the confirmation prompt too; see
  // McpContext.disableSecurity).
  if (ctx.disableSecurity) return ok({ warnings: [] });

  // Pre-flight security scan: autoloads + the launched scene's scripts,
  // scanning transitively into every PackedScene it instances (subscene
  // recursion, see collectSceneScripts) and into inline GDScript sub-resources.
  // Result is a list of findings + a list of scan warnings (file-not-found,
  // read errors, every script or scene the scan could not read, "no launchable
  // scene"); both flow into the response warnings array.
  // Strict mode + any Tier 1 finding → hard reject before launch.
  const scanWarnings: string[] = [];
  // What the caller is told about the confirmation step. Kept apart from the
  // scan warnings so their cap can never cut it.
  const confirmationWarnings: string[] = [];
  const scanFindings: ScanFinding[] = [];
  // The part of the scan that failed on something it reads: a GDScript file or
  // text scene that exists and could not be read, a path or uid the engine
  // would still try to load and the scan could not resolve to a file, a
  // project.godot with lines that are not in the form Godot writes, an
  // autoload line that does not read as an entry, or a scan step that threw. Each entry is also in scanWarnings. Strict mode
  // refuses on these. Items the
  // scan does not read by kind (a C# script, a binary scene, a resource file)
  // are never added here: refusing on those would block whole classes of
  // project, and whether strict mode should is left open (docs/security.md).
  const scanReadFailures: string[] = [];
  // The launch scene could not be found or resolved, so its scripts were not
  // checked. Each entry is also in scanWarnings. `noSceneConfigured` marks the
  // one case attach mode tolerates: nothing configured at all. A scene that is
  // configured, or passed, and cannot be reached is never tolerated.
  const launchSceneFailures: Array<{ message: string; noSceneConfigured: boolean }> = [];
  const failLaunchScene = (message: string, noSceneConfigured = false): void => {
    scanWarnings.push(message);
    launchSceneFailures.push({ message, noSceneConfigured });
  };
  const failScanRead = (message: string): void => {
    scanWarnings.push(message);
    scanReadFailures.push(message);
  };
  const absProjectPath = resolve(request.projectPath);

  const scanScriptPath = (filePath: string): void => {
    const { findings, warning, readFailed } = scanScriptFile(filePath, ctx.strictMode);
    if (warning) scanWarnings.push(warning);
    if (warning && readFailed) scanReadFailures.push(warning);
    const label = displayPath(absProjectPath, filePath);
    for (const m of findings) scanFindings.push({ label, match: m });
  };

  // Scan one scene: every script file it reaches, the source of every inline
  // script, and a note for everything the walk met and could not read.
  const scanScene = (scenePath: string): void => {
    const collected = collectSceneScripts(scenePath, absProjectPath);
    for (const filePath of collected.scripts) {
      if (!isUnderDir(absProjectPath, filePath)) {
        failScanRead(`Scene script "${filePath}" was not scanned: ${UNRESOLVED_PATH_CAUSE}`);
        continue;
      }
      scanScriptPath(filePath);
    }
    for (const inline of collected.inlineScripts) {
      const label = `${displayPath(absProjectPath, inline.scenePath)}[GDScript ${inline.id}]`;
      const decision = evaluateScript(inline.source, ctx.strictMode);
      for (const m of decision.matches) scanFindings.push({ label, match: m });
    }
    for (const item of collected.unscanned) {
      const notice = `Not scanned: ${displayPath(absProjectPath, item.scenePath)}: ${item.reason}`;
      scanWarnings.push(notice);
      // A text scene is one the scan reads. A file of another extension that
      // could not be read is a binary scene at best, which it does not.
      const sceneReadFailed =
        item.readFailed === true && item.scenePath.toLowerCase().endsWith(SCENE_EXTENSION);
      // An unresolved reference is one the engine would still try to load, so
      // it is a file the scan set out to read and did not.
      // A malformed statement was read in part: the engine may load from it
      // something the scan did not see.
      if (sceneReadFailed || item.unresolved === true || item.malformed === true) {
        scanReadFailures.push(notice);
      }
    }
  };

  // The scene the launch runs. An explicit scene takes precedence over the
  // main scene; a main scene is resolved by `resolveLaunchScene`, which can
  // answer with several files (one uid, several carriers) or none.
  const scanLaunchScene = (): void => {
    const scenes: string[] = [];
    if (request.scene) {
      scenes.push(request.scene.absPath);
    } else {
      const launch = resolveLaunchScene(absProjectPath);
      if (launch.kind === 'none') {
        failLaunchScene(
          'No launchable scene found (no `run/main_scene` and no explicit scene arg); scene-script scan skipped.',
          true,
        );
        return;
      }
      if (launch.kind === 'unresolved') {
        failLaunchScene(
          `Launch scene ${launch.value} could not be resolved to a file (${launch.reason}); scene-script scan skipped.`,
        );
        return;
      }
      scanWarnings.push(...launch.notes);
      scenes.push(...launch.absPaths);
    }
    for (const scenePath of scenes) {
      if (!existsSync(scenePath)) {
        failLaunchScene(
          `Configured launch scene not found at ${scenePath}; scene-script scan skipped.`,
        );
      } else {
        scanScene(scenePath);
      }
    }
  };

  try {
    const projectGodot = projectGodotPath(absProjectPath);
    if (existsSync(projectGodot)) {
      const { entries: autoloads, unparsed, nonCanonical } = parseAutoloadSection(projectGodot);
      // A line Godot did not write may make the engine load an autoload or a
      // main scene other than the one read here, and a line that registers an
      // autoload without reading as an entry names a file nothing scanned.
      // Both are settings the scan set out to read and could not.
      if (nonCanonical !== null)
        failScanRead(`${nonCanonical}. ${NON_CANONICAL_PROJECT_FILE_CAUSE}`);
      for (const line of unparsed) {
        failScanRead(`Autoload line could not be parsed and was not scanned: ${line}`);
      }
      for (const entry of autoloads) {
        // Skip this server's own injected bridge. It is left registered
        // between a launch and its cleanup, so a second run_project against
        // the same project would otherwise scan it — and it legitimately
        // calls the filesystem-write primitives the table flags, which would
        // surface as warnings blaming the user's project and, under strict
        // mode, hard-reject the launch. An McpBridge entry pointing anywhere
        // this server does not own is a user's own autoload and still scans.
        if (entry.name === BRIDGE_AUTOLOAD_NAME && isServerOwnedBridgePath(entry.path)) continue;
        // A uid:// path is looked up before its extension is read: the file a
        // uid names is found by the uid, and may be several files.
        let targets: string[];
        if (isUidReference(entry.path)) {
          const found = findFilesByUid(absProjectPath, entry.path);
          if (found.paths.length === 0) {
            // A search that read every file and found no carrier names a file
            // of a kind the scan does not read, or nothing. One that was cut
            // short may have missed a script it reads.
            if (found.complete) {
              scanWarnings.push(
                `Autoload ${entry.name} (${entry.path}) was not scanned: no scene or .uid file in the project carries it`,
              );
            } else {
              failScanRead(
                `Autoload ${entry.name} (${entry.path}) was not scanned: the uid search was cut short (${UID_SEARCH_CUT_SHORT_CAUSE}) before a file carrying it was found`,
              );
            }
            continue;
          }
          if (found.paths.length > 1) {
            scanWarnings.push(
              found.complete
                ? `Autoload ${entry.name} (${entry.path}): ${found.paths.length} files carry this uid and all were scanned`
                : `Autoload ${entry.name} (${entry.path}): ${found.paths.length} files carry this uid and were scanned`,
            );
          }
          if (!found.complete) {
            scanWarnings.push(
              `Autoload ${entry.name} (${entry.path}): the uid search was cut short (${UID_SEARCH_CUT_SHORT_CAUSE}), so another file may carry this uid and was not scanned`,
            );
          }
          targets = found.paths;
        } else {
          const autoloadFile = resolveProjectPath(absProjectPath, entry.path, 'read');
          if (!autoloadFile) {
            failScanRead(
              `Autoload ${entry.name} (${entry.path}) was not scanned: ${UNRESOLVED_PATH_CAUSE}`,
            );
            continue;
          }
          targets = [autoloadFile.absPath];
        }
        for (const target of targets) {
          const lowered = target.toLowerCase();
          if (lowered.endsWith(GDSCRIPT_EXTENSION)) scanScriptPath(target);
          else if (lowered.endsWith(SCENE_EXTENSION)) scanScene(target);
          else {
            scanWarnings.push(
              `Autoload ${entry.name} (${entry.path}) was not scanned: only ${GDSCRIPT_EXTENSION} scripts and ${SCENE_EXTENSION} scenes are scanned`,
            );
          }
        }
      }
    }
    scanLaunchScene();
  } catch (error) {
    // Whatever the loop above had not reached was not scanned, and nothing
    // names it. That is a failed scan, not a kind of file the scan skips.
    const failure = `${request.toolName} pre-flight scan failed: ${getErrorMessage(error)}`;
    scanWarnings.push(failure);
    scanReadFailures.push(failure);
  }

  const hasTier1 = scanFindings.some((f) => f.match.tier === 1);
  if (ctx.strictMode && hasTier1) {
    const top = scanFindings
      .filter((f) => f.match.tier === 1)
      .slice(0, MAX_STRICT_REJECT_LINES_SHOWN);
    const summary = top.map(formatScanFinding);
    const more =
      scanFindings.length > top.length ? ` (+${scanFindings.length - top.length} more)` : '';
    return err(
      createErrorResponse(
        [
          `Strict mode: refusing to launch project because autoload or launched-scene scripts contain Tier 1 primitives${more}.`,
          ...summary.map((s) => `- ${s}`),
        ].join('\n'),
        ['Remove or refactor the flagged primitives', STRICT_MODE_IS_OPERATOR_SETTING],
      ),
    );
  }

  // A launch the server performs runs the scene the scan was meant to read, so
  // strict mode does not launch when that scene is missing, unresolved or not
  // configured. In attach mode only a configured scene counts: with none, the
  // user's own Godot decides what runs.
  const refusedLaunchScene = launchSceneFailures.filter(
    (failure) => request.launchedByServer || !failure.noSceneConfigured,
  );
  if (ctx.strictMode && refusedLaunchScene.length > 0) {
    return err(
      createErrorResponse(
        [
          'Strict mode: refusing to launch project because the scene to launch could not be found or resolved, so its scripts were not checked.',
          ...refusedLaunchScene.map((failure) => `- ${failure.message}`),
        ].join('\n'),
        ['Set `run/main_scene` in project.godot or pass `scene`', STRICT_MODE_IS_OPERATOR_SETTING],
      ),
    );
  }

  // Strict mode is the setting for a launch nobody is watching, so it does not
  // launch on a scan that failed on files it reads: their Tier 1 findings, if
  // any, are exactly what was not found.
  if (ctx.strictMode && scanReadFailures.length > 0) {
    const shown = scanReadFailures.slice(0, MAX_STRICT_REJECT_LINES_SHOWN);
    const more =
      scanReadFailures.length > shown.length
        ? ` (+${scanReadFailures.length - shown.length} more)`
        : '';
    return err(
      createErrorResponse(
        [
          `Strict mode: refusing to launch project because the pre-flight scan could not read or resolve scripts or scenes it scans, so they were not checked${more}.`,
          ...shown.map((s) => `- ${s}`),
        ].join('\n'),
        [
          'Fix what stops the file from being read or found (permissions, a directory where the file should be, a path that leaves the project), then retry',
          STRICT_MODE_IS_OPERATOR_SETTING,
        ],
      ),
    );
  }

  // Session-confirmation gate: one elicitation per absolute projectPath per
  // server session. Skipped when the caller launches nothing itself
  // (`confirm: false`), and when this project was already confirmed.
  const projectKey = normalizeProjectKey(absProjectPath);
  if (request.confirm && !ctx.sessionState.runProjectConfirmed.has(projectKey)) {
    if (ctx.disableElicitation) {
      // Elicitation disabled by the operator (GODOT_MCP_DISABLE_ELICITATION). Skip the
      // blanket confirmation gate and launch with a recorded warning. The
      // tiered scan above is the real security boundary; the gate is UX.
      confirmationWarnings.push(
        'Elicitation disabled (GODOT_MCP_DISABLE_ELICITATION); launching without user confirmation.',
      );
      ctx.sessionState.runProjectConfirmed.add(projectKey);
    } else {
      let elicitResult: ElicitorResult;
      try {
        elicitResult = await ctx.elicitor({
          message:
            'Launching a Godot project executes arbitrary code in its autoloads and main scene. Proceed?',
          requestedSchema: {
            type: 'object',
            properties: {
              confirm: {
                type: 'boolean',
                description: `Allow ${request.toolName} to launch the project`,
              },
            },
            required: ['confirm'],
          },
        });
      } catch (error) {
        const elicitMsg = `Elicitation unavailable (${getErrorMessage(error)})`;
        if (ctx.strictMode) {
          return err(
            createErrorResponse(
              `${elicitMsg}; strict mode refuses to launch without explicit user confirmation.`,
              ['Use an MCP client that supports elicitation', STRICT_MODE_IS_OPERATOR_SETTING],
            ),
          );
        }
        // Elicitation unsupported — fall through with a recorded warning. The
        // tiered scan above is the real security boundary; the gate is UX.
        confirmationWarnings.push(`${elicitMsg}; launching without explicit user confirmation.`);
        elicitResult = { action: 'accept', content: { confirm: true } };
      }
      if (!isElicitAccepted(elicitResult)) {
        // A `cancel` action means the client dismissed the prompt without an
        // explicit choice. Some clients (e.g. Claude Desktop) auto-cancel
        // elicitation without ever displaying it, so it is told apart from an
        // explicit `decline`, and only it points at the opt-out: a decline is
        // the user's answer, and nothing about it is to be worked around.
        const cancelled = elicitResult.action === 'cancel';
        return err(
          createErrorResponse(
            cancelled
              ? `${request.toolName} confirmation was cancelled without an explicit choice. Some MCP clients (e.g. Claude Desktop) auto-cancel elicitation prompts instead of displaying them. The project was not launched.`
              : `User declined ${request.toolName}. The project was not launched.`,
            cancelled
              ? [ELICITATION_OPT_OUT_SOLUTION]
              : [
                  `The user declined this launch: do not call ${request.toolName} on this project again unless the user asks for it`,
                ],
          ),
        );
      }
      ctx.sessionState.runProjectConfirmed.add(projectKey);
    }
  }

  const warnings = scanFindings.slice(0, MAX_SCAN_WARNINGS_SHOWN).map(formatScanFinding);
  if (scanFindings.length > MAX_SCAN_WARNINGS_SHOWN) {
    warnings.push(`+${scanFindings.length - MAX_SCAN_WARNINGS_SHOWN} more`);
  }
  // Scan warnings are capped apart from the findings, so a long list of
  // findings cannot push the "this scan was incomplete" notices out.
  warnings.push(...scanWarnings.slice(0, MAX_SCAN_INCOMPLETE_SHOWN));
  if (scanWarnings.length > MAX_SCAN_INCOMPLETE_SHOWN) {
    warnings.push(
      `+${scanWarnings.length - MAX_SCAN_INCOMPLETE_SHOWN} more files were not scanned`,
    );
  }
  // At most one entry, and it says something no other entry does (the launch
  // went ahead unconfirmed), so it is never counted against either cap.
  warnings.push(...confirmationWarnings);
  return ok({ warnings });
}
