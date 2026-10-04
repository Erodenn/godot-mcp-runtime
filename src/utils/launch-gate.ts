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
import { resolveLaunchScene } from './launch-scene.js';

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
  // text scene that exists and could not be read, or a scan step that threw.
  // Each entry is also in scanWarnings. Strict mode refuses on these. Items the
  // scan does not read by kind (a C# script, a binary scene, a resource file)
  // are never added here: refusing on those would block whole classes of
  // project, and whether strict mode should is left open (docs/security.md).
  const scanReadFailures: string[] = [];
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
        scanWarnings.push(`Skipped scene script: "${filePath}" escapes project root.`);
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
      if (item.readFailed && item.scenePath.toLowerCase().endsWith(SCENE_EXTENSION)) {
        scanReadFailures.push(notice);
      }
    }
  };

  try {
    const projectGodot = projectGodotPath(absProjectPath);
    if (existsSync(projectGodot)) {
      const { entries: autoloads, unparsed } = parseAutoloadSection(projectGodot);
      for (const line of unparsed) {
        scanWarnings.push(`Autoload line could not be parsed and was not scanned: ${line}`);
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
        const lowered = entry.path.toLowerCase();
        const isScript = lowered.endsWith(GDSCRIPT_EXTENSION);
        const isScene = lowered.endsWith(SCENE_EXTENSION);
        if (!isScript && !isScene) {
          scanWarnings.push(
            `Autoload ${entry.name} (${entry.path}) was not scanned: only ${GDSCRIPT_EXTENSION} scripts and ${SCENE_EXTENSION} scenes are scanned`,
          );
          continue;
        }
        const autoloadFile = resolveProjectPath(absProjectPath, entry.path);
        if (!autoloadFile) {
          scanWarnings.push(
            `Skipped autoload ${entry.name}: path "${entry.path}" escapes project root.`,
          );
          continue;
        }
        if (isScript) scanScriptPath(autoloadFile.absPath);
        else scanScene(autoloadFile.absPath);
      }
    }
    const launchScene = request.scene ? request.scene.absPath : resolveLaunchScene(absProjectPath);
    if (launchScene === null) {
      scanWarnings.push(
        'No launchable scene found (no `run/main_scene` and no explicit scene arg); scene-script scan skipped.',
      );
    } else if (!existsSync(launchScene)) {
      scanWarnings.push(
        `Configured launch scene not found at ${launchScene}; scene-script scan skipped.`,
      );
    } else {
      scanScene(launchScene);
    }
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
        [
          'Remove or refactor the flagged primitives',
          'Unset GODOT_MCP_STRICT to launch with warnings (Tier 1 findings will surface in `warnings`)',
        ],
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
          `Strict mode: refusing to launch project because the pre-flight scan could not read scripts or scenes it scans, so they were not checked${more}.`,
          ...shown.map((s) => `- ${s}`),
        ].join('\n'),
        [
          'Fix what stops the file from being read (permissions, a directory where the file should be), then retry',
          'Unset GODOT_MCP_STRICT to launch with these reported in `warnings` instead',
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
              [
                'Unset GODOT_MCP_STRICT to launch without confirmation',
                'Use an MCP client that supports elicitation',
              ],
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
        // elicitation without ever displaying it, so distinguish it from an
        // explicit `decline` and point the user at the opt-out.
        const cancelled = elicitResult.action === 'cancel';
        return err(
          createErrorResponse(
            cancelled
              ? `${request.toolName} confirmation was cancelled without an explicit choice. Some MCP clients (e.g. Claude Desktop) auto-cancel elicitation prompts instead of displaying them.`
              : `User declined ${request.toolName}. The project was not launched.`,
            [
              `Retry ${request.toolName} once you intend to launch the project`,
              'If your client cannot display confirmation prompts, set GODOT_MCP_DISABLE_ELICITATION=true to skip them',
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
