/** Pre-flight security scan and once-per-project confirmation that run before this server starts or injects into a project; free of `GodotRunner` and `src/tools/` so any launcher can call it. */

import { existsSync, readFileSync } from 'fs';
import { relative, resolve } from 'path';
import type { ToolResponse } from '../mcp.types.js';
import { isServerOwnedBridgePath } from './artifact-paths.js';
import { parseAutoloadSection } from './autoload-ini.js';
import { BRIDGE_AUTOLOAD_NAME } from './bridge-manager.js';
import { createErrorResponse, getErrorMessage } from './error-response.js';
import {
  ElicitationUnsupportedError,
  isElicitAccepted,
  normalizeProjectKey,
  type ElicitorResult,
  type McpContext,
} from './mcp-context.js';
import {
  isLaunchScenePath,
  isUnderDir,
  isUnscannedLaunchScenePath,
  LAUNCH_SCENE_EXTENSIONS,
  UNSCANNED_LAUNCH_SCENE_EXTENSIONS,
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
/** Cap on scan warnings, counted apart from findings so a long list of findings never pushes an incomplete-scan notice out. */
export const MAX_SCAN_INCOMPLETE_SHOWN = 10;
const GDSCRIPT_EXTENSION = '.gd';
const SCENE_EXTENSION = '.tscn';
const TEXT_RESOURCE_EXTENSION = '.tres';
/** Why a reference the engine would still try to load was not scanned. */
const UNRESOLVED_PATH_CAUSE = 'the path could not be resolved to a file inside the project';
/** What a `project.godot` with lines Godot did not write means for the scan. */
const NON_CANONICAL_PROJECT_FILE_CAUSE =
  'The autoloads and main scene could not be read reliably, so what the engine loads may not be what was scanned. Rewrite those lines as one key=value statement per line';
/** The one thing to do about a strict-mode refusal the project cannot fix: strict mode bounds an unwatched run, so a refusal is never answered by advising the agent to turn it off. */
const STRICT_MODE_IS_OPERATOR_SETTING =
  'Strict mode (GODOT_MCP_STRICT) is an operator setting: report this refusal to the user rather than changing it';
/** Offered only for a prompt the client dismissed by itself, never for a user's decline. */
const ELICITATION_OPT_OUT_SOLUTION =
  'If your client cannot display confirmation prompts, set GODOT_MCP_DISABLE_ELICITATION=true to skip them';

/** Refuses a `scene` argument the engine would not run as a scene: Godot silently runs the main scene instead, so the gate would scan one file and launch another. Called by every launcher before the gate. */
export function rejectNonSceneLaunchArg(scene: string): ToolResponse | null {
  if (isLaunchScenePath(scene)) return null;
  return createErrorResponse(
    `Invalid scene: "${scene}" does not end in ${[...LAUNCH_SCENE_EXTENSIONS, ...UNSCANNED_LAUNCH_SCENE_EXTENSIONS].join(', ')} (lower case). Godot runs a command-line scene only when it carries a scene or resource file extension; any other argument is ignored and the project's main scene runs instead.`,
    [
      'Pass the scene file with its extension, e.g. "scenes/main.tscn"',
      "Omit scene to launch the project's main scene",
    ],
  );
}

export interface LaunchGateRequest {
  projectPath: string;
  scene?: ResolvedProjectPath | undefined;
  confirm: boolean;
  /** True when this server starts the process, so the scene it runs is the one scanned. In attach mode the user may pick a scene the server never sees, so no main scene is then only a strict-mode warning. */
  launchedByServer: boolean;
  toolName: string;
}

export interface LaunchGateOutcome {
  /** Scan findings first (capped, plus `+N more`), then scan warnings (capped apart), then the confirmation warning, which no cap cuts. */
  warnings: string[];
}

interface ScanFinding {
  label: string;
  match: PolicyMatch;
}

/** Project-relative name when inside the project; out-of-tree paths verbatim, since `..`-prefixed relative paths obscure where the file lives. */
function displayPath(projectPath: string, sourcePath: string): string {
  return isUnderDir(projectPath, sourcePath) ? relative(projectPath, sourcePath) : sourcePath;
}

function formatScanFinding(finding: ScanFinding): string {
  return `${finding.label}:${finding.match.line} ${finding.match.matchedText} - ${finding.match.reason}`;
}

/** Scans a single .gd file. `readFailed` marks a file that exists but could not be read, distinct from a missing one: the scan set out to read it. Tier and strict promotion match `evaluateScript`. */
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

/** Runs the launch gate: warnings for the caller's success payload, or the refusal to return as is. `request.confirm: false` is for a caller that launches nothing: scan and strict refusal run, but no elicitation and no confirmed-project write. */
export async function runLaunchGate(
  request: LaunchGateRequest,
  ctx: McpContext,
): Promise<Result<LaunchGateOutcome, ToolResponse>> {
  // Skipped entirely when GODOT_MCP_DISABLE_SECURITY is set (no-op including Tier 1 and the prompt; see McpContext.disableSecurity).
  if (ctx.disableSecurity) return ok({ warnings: [] });

  // Pre-flight scan: autoloads plus the launch scene's scripts, recursing into instanced scenes and inline GDScript sub-resources.
  // Findings and scan warnings both flow into the response warnings; strict mode + any Tier 1 finding rejects before launch.
  const scanWarnings: string[] = [];
  // What the caller is told about the confirmation step, kept apart from scan warnings so their cap cannot cut it.
  const confirmationWarnings: string[] = [];
  const scanFindings: ScanFinding[] = [];
  // Scan failures on something it reads (unreadable .gd or text scene, unresolvable path or uid, malformed project.godot or autoload line, a step that threw); each is also in scanWarnings and strict mode refuses on them.
  // Kinds it does not read (C#, binary scene, resource file) are never added: refusing on those would block whole classes of project, and whether strict mode should is left open (docs/security.md).
  const scanReadFailures: string[] = [];
  // The launch scene could not be found or resolved, so its scripts were not checked (also in scanWarnings). `noSceneConfigured` is the one case attach mode tolerates; a scene configured or passed and unreachable never is.
  const launchSceneFailures: Array<{ message: string; noSceneConfigured: boolean }> = [];
  const failLaunchScene = (message: string, noSceneConfigured = false): void => {
    scanWarnings.push(message);
    launchSceneFailures.push({ message, noSceneConfigured });
  };
  // A .escn, .tres or .res launch scene is not read, though a .tres or .escn a scene references is.
  // The launch goes ahead with the notice; strict mode refuses it in its own words.
  const unscannedLaunchScenes: string[] = [];
  const failUnscannedLaunchScene = (relPath: string): void => {
    scanWarnings.push(
      `Not scanned: ${relPath}: the pre-flight scan reads a launch scene only when it is a .tscn file; a .tres, .res or .escn launch scene is not read`,
    );
    unscannedLaunchScenes.push(relPath);
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

  // Scan one scene: its script files, inline script sources, and a note for everything the walk could not read.
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
      // A text scene or resource is one the scan reads; another extension that could not be read is at best a binary scene, which it does not.
      const loweredItemPath = item.scenePath.toLowerCase();
      const sceneReadFailed =
        item.readFailed === true &&
        (loweredItemPath.endsWith(SCENE_EXTENSION) ||
          loweredItemPath.endsWith(TEXT_RESOURCE_EXTENSION));
      // An unresolved reference is one the engine would still try to load, so the scan set out to read it and did not; a malformed statement was read in part, so the engine may load something unseen.
      if (sceneReadFailed || item.unresolved === true || item.malformed === true) {
        scanReadFailures.push(notice);
      }
    }
  };

  // An explicit scene takes precedence over the main scene; `resolveLaunchScene` may answer with several files (one uid, several carriers) or none.
  const scanLaunchScene = (): void => {
    const scenes: string[] = [];
    if (request.scene) {
      if (isUnscannedLaunchScenePath(request.scene.relPath)) {
        failUnscannedLaunchScene(request.scene.relPath);
        return;
      }
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
      // A line Godot did not write may make the engine load an autoload or main scene other than the one read, and an autoload line that reads as no entry names a file nothing scanned: settings the scan could not read.
      if (nonCanonical !== null)
        failScanRead(`${nonCanonical}. ${NON_CANONICAL_PROJECT_FILE_CAUSE}`);
      for (const line of unparsed) {
        failScanRead(`Autoload line could not be parsed and was not scanned: ${line}`);
      }
      for (const entry of autoloads) {
        // Skip this server's own injected bridge: it stays registered between launch and cleanup, and scanning it would blame the user's project for its filesystem-write primitives and, in strict mode, reject the launch.
        // An McpBridge entry pointing anywhere this server does not own is a user's autoload and still scans.
        if (entry.name === BRIDGE_AUTOLOAD_NAME && isServerOwnedBridgePath(entry.path)) continue;
        // A uid:// path is resolved by its uid before its extension is read, and may be several files.
        let targets: string[];
        if (isUidReference(entry.path)) {
          const found = findFilesByUid(absProjectPath, entry.path);
          if (found.paths.length === 0) {
            // A search that read every file and found no carrier names a kind the scan does not read, or nothing; one cut short may have missed a script it reads.
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
          else if (lowered.endsWith(SCENE_EXTENSION) || lowered.endsWith(TEXT_RESOURCE_EXTENSION)) {
            // The engine loads an autoload by what the file holds: a `.tres` can be a script or a scene.
            scanScene(target);
          } else {
            scanWarnings.push(
              `Autoload ${entry.name} (${entry.path}) was not scanned: only ${GDSCRIPT_EXTENSION} scripts, ${SCENE_EXTENSION} scenes and ${TEXT_RESOURCE_EXTENSION} resources are scanned`,
            );
          }
        }
      }
    }
    scanLaunchScene();
  } catch (error) {
    // Whatever the loop had not reached was not scanned and nothing names it: a failed scan, not a skipped kind.
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

  // A server-performed launch runs the scene the scan was meant to read, so strict mode does not launch when it is missing, unresolved or unconfigured;
  // in attach mode only a configured scene counts, since the user's own Godot decides otherwise.
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

  if (ctx.strictMode && unscannedLaunchScenes.length > 0) {
    return err(
      createErrorResponse(
        `Strict mode: refusing to launch project because the launch scene ${unscannedLaunchScenes[0]} is not a .tscn scene, and the pre-flight scan does not read a .tres, .res or .escn launch scene, so its scripts were not checked.`,
        ['Launch a .tscn scene instead', STRICT_MODE_IS_OPERATOR_SETTING],
      ),
    );
  }

  // Strict mode is the setting for an unwatched launch, so it does not launch on a scan that failed on files it reads: their Tier 1 findings are exactly what was not found.
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

  // One elicitation per absolute projectPath per server session; skipped for `confirm: false` and for an already confirmed project.
  const projectKey = normalizeProjectKey(absProjectPath);
  if (request.confirm && !ctx.sessionState.runProjectConfirmed.has(projectKey)) {
    if (ctx.disableElicitation) {
      // Elicitation disabled by the operator (GODOT_MCP_DISABLE_ELICITATION): launch with a recorded warning; the tiered scan is the real security boundary, the gate is UX.
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
        if (!(error instanceof ElicitationUnsupportedError)) {
          // The client can prompt and the prompt went unanswered (the request
          // timed out) or failed: nobody confirmed, so nothing launches.
          return err(
            createErrorResponse(
              `${request.toolName} confirmation was not answered (${getErrorMessage(error)}). The project was not launched.`,
              [ELICITATION_OPT_OUT_SOLUTION],
            ),
          );
        }
        const elicitMsg = `Elicitation unavailable (${getErrorMessage(error)})`;
        if (ctx.strictMode) {
          return err(
            createErrorResponse(
              `${elicitMsg}; strict mode refuses to launch without explicit user confirmation.`,
              ['Use an MCP client that supports elicitation', STRICT_MODE_IS_OPERATOR_SETTING],
            ),
          );
        }
        // Elicitation unsupported: fall through with a recorded warning (the tiered scan is the real boundary; the gate is UX).
        confirmationWarnings.push(`${elicitMsg}; launching without explicit user confirmation.`);
        elicitResult = { action: 'accept', content: { confirm: true } };
      }
      if (!isElicitAccepted(elicitResult)) {
        // `cancel` means the client dismissed the prompt without a choice (Claude Desktop auto-cancels without showing it): told apart from an explicit `decline`,
        // and only it points at the opt-out, since a decline is the user's answer and not to be worked around.
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
