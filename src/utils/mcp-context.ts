/** Request-scoped context threaded through tool dispatch: the elicitor, the no-elicit flag (captured when the context is built, so toggling the env var after start has no effect), and per-session state. */

/** Result of an elicitation prompt; mirrors the SDK's `ElicitResult` without importing it, so the utils layer stays decoupled from the MCP SDK. */
export interface ElicitorResult {
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, unknown>;
}

export interface ElicitorRequest {
  message: string;
  requestedSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: readonly string[];
  };
}

/** Thrown by an elicitor when the client did not declare elicitation, the only error the confirmation reads as 'the client cannot be asked'; any other throw means a prompt may have been shown and nobody confirmed. */
export class ElicitationUnsupportedError extends Error {
  constructor(message = 'the client does not support elicitation') {
    super(message);
    this.name = 'ElicitationUnsupportedError';
  }
}

/** True when the client declared form elicitation; an empty `elicitation` object is its older spelling, `url` alone is not it. */
export function clientSupportsFormElicitation(
  capabilities: { elicitation?: Record<string, unknown> | undefined } | undefined,
): boolean {
  const elicitation = capabilities?.elicitation;
  if (elicitation === undefined || elicitation === null) return false;
  return Object.keys(elicitation).length === 0 || elicitation.form !== undefined;
}

/** Prompts the user via MCP elicitation; throws `ElicitationUnsupportedError` for a client without the capability, any other throw is an unanswered prompt. Neither counts as confirmation. */
export type Elicitor = (request: ElicitorRequest) => Promise<ElicitorResult>;

/** How long a confirmation prompt waits. Held under the client's 60 s tool-call timeout so the refusal still arrives. */
export const ELICITATION_PROMPT_TIMEOUT_MS = 45000;

/** The part of the MCP server an elicitor needs; structural, so the SDK stays out of this module. */
export interface ElicitationClient {
  getClientCapabilities(): { elicitation?: Record<string, unknown> | undefined } | undefined;
  elicitInput(
    params: ElicitorRequest,
    options: { timeout: number },
  ): Promise<{ action: ElicitorResult['action']; content?: Record<string, unknown> | undefined }>;
}

/** The elicitor both confirmation prompts share: typed refusal for a client that cannot be asked, bounded wait otherwise. */
export function createElicitor(client: ElicitationClient): Elicitor {
  return async (request) => {
    if (!clientSupportsFormElicitation(client.getClientCapabilities())) {
      throw new ElicitationUnsupportedError();
    }
    const result = await client.elicitInput(
      { message: request.message, requestedSchema: request.requestedSchema },
      { timeout: ELICITATION_PROMPT_TIMEOUT_MS },
    );
    return result.content
      ? { action: result.action, content: result.content }
      : { action: result.action };
  };
}

/** True only for an explicit accept; an `accept` whose `confirm` is anything but `true` is a denial. */
export function isElicitAccepted(result: ElicitorResult): boolean {
  return (
    result.action === 'accept' && (result.content === undefined || result.content.confirm === true)
  );
}

export interface SessionState {
  /** `projectPathKey` keys of projects already confirmed for `run_project` (spawn) or `render_movie` in this session; the first launch per key elicits. */
  runProjectConfirmed: Set<string>;
  /** `projectPathKey` keys of projects already confirmed for `run_script` in this session; apart from `runProjectConfirmed`, so a launch accept never admits a script and an attached session still asks. */
  runScriptConfirmed: Set<string>;
}

export interface McpContext {
  elicitor: Elicitor;
  /** Skips the confirmation prompts, treated as accepted (fail-open), for clients that cannot surface elicitation (Claude Desktop auto-cancels them). */
  disableElicitation: boolean;
  sessionState: SessionState;
}

/** The flags that turn on only for the exact string `true`, and what each being off means. */
const BOOLEAN_FLAG_OFF_EFFECTS: ReadonlyArray<readonly [name: string, effect: string]> = [
  ['GODOT_MCP_DISABLE_ELICITATION', 'confirmation prompts stay ON'],
];

const HEX_RADIX = 16;
const UNICODE_ESCAPE_DIGITS = 4;

/** JSON-quotes a value for a stderr line with anything outside printable ASCII as `\uXXXX`: the value comes from the environment and a non-UTF-8 console would print noise. */
function quoteAsAscii(value: string): string {
  return JSON.stringify(value).replace(
    /[^\x20-\x7e]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(HEX_RADIX).padStart(UNICODE_ESCAPE_DIGITS, '0')}`,
  );
}

/** One startup line per flag set to something other than `true` or `false`: a flag is read as the exact string `true`, so `1` or `TRUE` leaves it off with no other sign. Unset and empty are not reported. */
export function describeIgnoredFlagValues(env: Record<string, string | undefined>): string[] {
  const lines: string[] = [];
  for (const [name, effect] of BOOLEAN_FLAG_OFF_EFFECTS) {
    const value = env[name];
    if (value === undefined || value === '' || value === 'true' || value === 'false') continue;
    lines.push(`[SERVER] ${name}=${quoteAsAscii(value)} is not "true" and was ignored: ${effect}`);
  }
  return lines;
}

/** A no-op context for tests; the elicitor always declines, so accept paths need a scripted elicitor. */
export function createNullContext(overrides?: Partial<McpContext>): McpContext {
  return {
    elicitor: async () => ({ action: 'decline' }),
    disableElicitation: false,
    sessionState: {
      runProjectConfirmed: new Set<string>(),
      runScriptConfirmed: new Set<string>(),
    },
    ...overrides,
  };
}
