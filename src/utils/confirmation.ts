/** The two once-per-project confirmation prompts (a launch, and `run_script`) and the launch scene check; free of `GodotRunner` and `src/tools/` so any tool that starts or injects code can call it. */

import { resolve } from 'path';
import type { HandlerResult, ToolResponse } from '../mcp.types.js';
import { createErrorResponse, getErrorMessage } from './error-response.js';
import {
  ElicitationUnsupportedError,
  isElicitAccepted,
  type ElicitorResult,
  type McpContext,
} from './mcp-context.js';
import {
  isLaunchScenePath,
  LAUNCH_SCENE_EXTENSIONS,
  RESOURCE_LAUNCH_SCENE_EXTENSIONS,
} from './path-validation.js';
import { projectPathKey } from './output-parsing.js';
import { ok, err, type Result } from './result.js';

/** Offered only for a prompt the client dismissed by itself, never for a user's decline. */
const ELICITATION_OPT_OUT_SOLUTION =
  'If your client cannot display confirmation prompts, set GODOT_MCP_DISABLE_ELICITATION=true to skip them';

/** Refuses a `scene` argument the engine would not run as a scene: Godot silently runs the main scene instead of any other argument. Called by every launcher before its confirmation. */
export function rejectNonSceneLaunchArg(scene: string): ToolResponse | null {
  if (isLaunchScenePath(scene)) return null;
  return createErrorResponse(
    `Invalid scene: "${scene}" does not end in ${[...LAUNCH_SCENE_EXTENSIONS, ...RESOURCE_LAUNCH_SCENE_EXTENSIONS].join(', ')} (lower case). Godot runs a command-line scene only when it carries a scene or resource file extension; any other argument is ignored and the project's main scene runs instead.`,
    [
      'Pass the scene file with its extension, e.g. "scenes/main.tscn"',
      "Omit scene to launch the project's main scene",
    ],
  );
}

/** `launch`: starting a project (`run_project` spawn, `render_movie`). `script`: `run_script` on a live session, attached ones included. Each has its own confirmed set, so one accept never admits the other. */
export type ConfirmationKind = 'launch' | 'script';

/** Separates the prompt's headline from its detail. Some clients (Claude Code) do not wrap the message, so the headline must read alone in an 80-column terminal. */
const PROMPT_DETAIL_SEPARATOR = '\n\n';

interface ConfirmationWording {
  /** The prompt's first line, after `<tool> wants to `; carries no path so it stays short. */
  headline: string;
  /** The rest of the prompt, after the headline. */
  detail: (projectPath: string) => string;
  /** The form field's description in the prompt. */
  field: string;
  /** What did not happen when the answer is not an accept. */
  notDone: string;
  /** Names the declined act in the advice not to repeat it. */
  declinedAct: string;
  /** Completes "launching ..." in the warning when nobody was asked. */
  proceeding: string;
}

const CONFIRMATION_WORDING: Readonly<Record<ConfirmationKind, ConfirmationWording>> = {
  launch: {
    headline: 'launch a Godot project.',
    detail: (projectPath) =>
      `Project: ${projectPath}${PROMPT_DETAIL_SEPARATOR}The project's autoloads, scenes and scripts run with your user permissions. Proceed?`,
    field: 'Allow the project to launch',
    notDone: 'The project was not launched.',
    declinedAct: 'launch',
    proceeding: 'launching',
  },
  script: {
    headline: 'run agent-written code in your game.',
    detail: (projectPath) =>
      `Project: ${projectPath}${PROMPT_DETAIL_SEPARATOR}The agent's GDScript runs inside the running game with your user permissions and can read and write files, use the network and start programs. Proceed?`,
    field: 'Allow the script to run',
    notDone: 'The script was not run.',
    declinedAct: 'script run',
    proceeding: 'running the script',
  },
};

export interface ConfirmationRequest {
  kind: ConfirmationKind;
  /** The tool name, as the prompt and the refusals say it. */
  toolName: string;
  projectPath: string;
}

export interface ConfirmationOutcome {
  /** At most one entry: set when the action went ahead without anyone being asked. */
  warnings: string[];
  /** How long the prompt was open by `ctx.now`, 0 when nobody was prompted; the caller charges it against its budget. */
  promptMs: number;
}

/** Asks once per project per server session. A confirmed project returns at once; an accept, an operator opt-out (`disableElicitation`) and a client that cannot be asked all record the project. Any other answer (decline, cancel, an unanswered prompt) refuses and records nothing. This is the only `ctx.elicitor` call in `src/`. */
export async function confirmFirstUse(
  request: ConfirmationRequest,
  ctx: McpContext,
  platform: NodeJS.Platform = process.platform,
): Promise<Result<ConfirmationOutcome, ToolResponse>> {
  const wording = CONFIRMATION_WORDING[request.kind];
  const absProjectPath = resolve(request.projectPath);
  const confirmed =
    request.kind === 'launch'
      ? ctx.sessionState.runProjectConfirmed
      : ctx.sessionState.runScriptConfirmed;
  const projectKey = projectPathKey(absProjectPath, platform);
  if (confirmed.has(projectKey)) return ok({ warnings: [], promptMs: 0 });

  if (ctx.disableElicitation) {
    confirmed.add(projectKey);
    return ok({
      warnings: [
        `Elicitation disabled (GODOT_MCP_DISABLE_ELICITATION); ${wording.proceeding} without user confirmation.`,
      ],
      promptMs: 0,
    });
  }

  let elicitResult: ElicitorResult;
  let warnings: string[] = [];
  const promptedAt = ctx.now();
  try {
    elicitResult = await ctx.elicitor({
      message: `${request.toolName} wants to ${wording.headline}${PROMPT_DETAIL_SEPARATOR}${wording.detail(absProjectPath)}`,
      requestedSchema: {
        type: 'object',
        properties: { confirm: { type: 'boolean', description: wording.field } },
        required: ['confirm'],
      },
    });
  } catch (error) {
    if (!(error instanceof ElicitationUnsupportedError)) {
      // The client can prompt and the prompt went unanswered (the request timed out) or failed: nobody confirmed.
      return err(
        createErrorResponse(
          `${request.toolName} confirmation was not answered (${getErrorMessage(error)}). ${wording.notDone}`,
          [ELICITATION_OPT_OUT_SOLUTION],
        ),
      );
    }
    warnings = [
      `Elicitation unavailable (${getErrorMessage(error)}); ${wording.proceeding} without explicit user confirmation.`,
    ];
    elicitResult = { action: 'accept', content: { confirm: true } };
  }
  const promptMs = Math.max(0, ctx.now() - promptedAt);

  if (!isElicitAccepted(elicitResult)) {
    // `cancel` means the client dismissed the prompt without a choice (Claude Desktop auto-cancels without showing it): told apart from an explicit `decline`, and only it points at the opt-out, since a decline is the user's answer and not to be worked around.
    const cancelled = elicitResult.action === 'cancel';
    return err(
      createErrorResponse(
        cancelled
          ? `${request.toolName} confirmation was cancelled without an explicit choice. Some MCP clients (e.g. Claude Desktop) auto-cancel elicitation prompts instead of displaying them. ${wording.notDone}`
          : `User declined ${request.toolName}. ${wording.notDone}`,
        cancelled
          ? [ELICITATION_OPT_OUT_SOLUTION]
          : [
              `The user declined this ${wording.declinedAct}: do not call ${request.toolName} on this project again unless the user asks for it`,
            ],
      ),
    );
  }
  confirmed.add(projectKey);
  return ok({ warnings, promptMs });
}

/** Adds a confirmation's warnings to an error result: the project is already recorded, so the first call is the only one that can say later calls go ahead unasked. A success payload carries them itself. */
export function withConfirmationWarnings(
  result: HandlerResult,
  warnings: readonly string[],
): HandlerResult {
  if (result.ok || warnings.length === 0) return result;
  result.error.content.push({ type: 'text', text: `Warnings:\n- ${warnings.join('\n- ')}` });
  return result;
}
