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
import { join, relative, resolve } from 'path';
import type { ToolResponse } from '../mcp.types.js';
import { isServerOwnedBridgePath } from './artifact-paths.js';
import { parseAutoloads } from './autoload-ini.js';
import { BRIDGE_AUTOLOAD_NAME } from './bridge-manager.js';
import { createErrorResponse, getErrorMessage } from './error-response.js';
import {
  isElicitAccepted,
  normalizeProjectKey,
  type ElicitorResult,
  type McpContext,
} from './mcp-context.js';
import {
  isUnderDir,
  projectGodotPath,
  stripResPrefix,
  validateSubPath,
} from './path-validation.js';
import { ok, err, type Result } from './result.js';
import { evaluateScript, type PolicyMatch } from './run-script-policy.js';
import { collectSceneScriptsRecursive, resolveLaunchScene } from './scene-parsing.js';

const MAX_STRICT_REJECT_LINES_SHOWN = 5;
/** Cap on the `warnings` entries a gate outcome carries before the `+N more` tail. */
export const MAX_SCAN_WARNINGS_SHOWN = 10;

export interface LaunchGateRequest {
  /** Validated project directory; resolved to an absolute path inside. */
  projectPath: string;
  /** Validated project-relative scene. Undefined scans `run/main_scene`. */
  scene?: string | undefined;
  /** Run the once-per-project session confirmation. */
  confirm: boolean;
  /** Names the caller in the prompt, the refusals and the warnings. */
  toolName: string;
}

export interface LaunchGateOutcome {
  /**
   * Scan findings first, then scan and confirmation warnings. Capped at
   * `MAX_SCAN_WARNINGS_SHOWN` entries plus a final `+N more` entry.
   */
  warnings: string[];
}

/**
 * Build a one-line summary of a project-scan finding so a launch response can
 * carry a `warnings` array without flooding it. Out-of-tree paths
 * are surfaced verbatim (path.relative would emit `..`-prefixed strings that
 * obscure where the file actually lives).
 */
function formatScanFinding(sourcePath: string, projectPath: string, match: PolicyMatch): string {
  const rel = isUnderDir(projectPath, sourcePath) ? relative(projectPath, sourcePath) : sourcePath;
  return `${rel}:${match.line} ${match.matchedText} - ${match.reason}`;
}

/**
 * Scan a single .gd file. Missing/unreadable files are reported as a single
 * warning string (the second tuple element); the caller decides whether to
 * surface them. Tier and strict promotion semantics match `evaluateScript`.
 */
function scanScriptFile(
  filePath: string,
  strict: boolean,
): { findings: PolicyMatch[]; warning: string | null } {
  let source: string;
  try {
    source = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { findings: [], warning: `Could not scan ${filePath} (file not found)` };
    }
    return {
      findings: [],
      warning: `Could not scan ${filePath}: ${getErrorMessage(error)}`,
    };
  }
  const decision = evaluateScript(source, strict);
  return { findings: decision.matches, warning: null };
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
  // recursion — see collectSceneScriptsRecursive). Result is a list of
  // findings + a list of scan warnings (file-not-found, read errors,
  // "no launchable scene"); both flow into the response warnings array.
  // Strict mode + any Tier 1 finding → hard reject before launch.
  const scanWarnings: string[] = [];
  const scanFindings: Array<{ sourcePath: string; match: PolicyMatch }> = [];
  const absProjectPath = resolve(request.projectPath);
  try {
    const projectGodot = projectGodotPath(absProjectPath);
    if (existsSync(projectGodot)) {
      const autoloads = parseAutoloads(projectGodot);
      for (const entry of autoloads) {
        // Skip this server's own injected bridge. It is left registered
        // between a launch and its cleanup, so a second run_project against
        // the same project would otherwise scan it — and it legitimately
        // calls the filesystem-write primitives the table flags, which would
        // surface as warnings blaming the user's project and, under strict
        // mode, hard-reject the launch. An McpBridge entry pointing anywhere
        // this server does not own is a user's own autoload and still scans.
        if (entry.name === BRIDGE_AUTOLOAD_NAME && isServerOwnedBridgePath(entry.path)) continue;
        const stripped = stripResPrefix(entry.path);
        if (!stripped.endsWith('.gd')) continue;
        if (!validateSubPath(absProjectPath, stripped)) {
          scanWarnings.push(
            `Skipped autoload ${entry.name}: path "${entry.path}" escapes project root.`,
          );
          continue;
        }
        const filePath = join(absProjectPath, stripped);
        const { findings, warning } = scanScriptFile(filePath, ctx.strictMode);
        if (warning) scanWarnings.push(warning);
        for (const m of findings) {
          scanFindings.push({ sourcePath: filePath, match: m });
        }
      }
    }
    const launchScene = resolveLaunchScene(absProjectPath, request.scene);
    if (launchScene === null) {
      scanWarnings.push(
        'No launchable scene found (no `run/main_scene` and no explicit scene arg); scene-script scan skipped.',
      );
    } else if (!existsSync(launchScene)) {
      scanWarnings.push(
        `Configured launch scene not found at ${launchScene}; scene-script scan skipped.`,
      );
    } else {
      const scripts = collectSceneScriptsRecursive(launchScene, absProjectPath);
      for (const filePath of scripts) {
        if (!isUnderDir(absProjectPath, filePath)) {
          scanWarnings.push(`Skipped scene script: "${filePath}" escapes project root.`);
          continue;
        }
        const { findings, warning } = scanScriptFile(filePath, ctx.strictMode);
        if (warning) scanWarnings.push(warning);
        for (const m of findings) {
          scanFindings.push({ sourcePath: filePath, match: m });
        }
      }
    }
  } catch (error) {
    scanWarnings.push(`${request.toolName} pre-flight scan failed: ${getErrorMessage(error)}`);
  }

  const hasTier1 = scanFindings.some((f) => f.match.tier === 1);
  if (ctx.strictMode && hasTier1) {
    const top = scanFindings
      .filter((f) => f.match.tier === 1)
      .slice(0, MAX_STRICT_REJECT_LINES_SHOWN);
    const summary = top.map((f) => formatScanFinding(f.sourcePath, absProjectPath, f.match));
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

  // Session-confirmation gate: one elicitation per absolute projectPath per
  // server session. Skipped when the caller launches nothing itself
  // (`confirm: false`), and when this project was already confirmed.
  const projectKey = normalizeProjectKey(absProjectPath);
  if (request.confirm && !ctx.sessionState.runProjectConfirmed.has(projectKey)) {
    if (ctx.disableElicitation) {
      // Elicitation disabled by the operator (GODOT_MCP_DISABLE_ELICITATION). Skip the
      // blanket confirmation gate and launch with a recorded warning. The
      // tiered scan above is the real security boundary; the gate is UX.
      scanWarnings.push(
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
        scanWarnings.push(`${elicitMsg}; launching without explicit user confirmation.`);
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

  const allWarnings = [
    ...scanFindings.map((f) => formatScanFinding(f.sourcePath, absProjectPath, f.match)),
    ...scanWarnings,
  ];
  const warnings = allWarnings.slice(0, MAX_SCAN_WARNINGS_SHOWN);
  if (allWarnings.length > MAX_SCAN_WARNINGS_SHOWN) {
    warnings.push(`+${allWarnings.length - MAX_SCAN_WARNINGS_SHOWN} more`);
  }
  return ok({ warnings });
}
