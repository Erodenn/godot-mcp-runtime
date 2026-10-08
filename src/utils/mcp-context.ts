/** Request-scoped context threaded through tool dispatch: the elicitor, the strict, no-elicit and no-security flags (captured when the context is built, so toggling the env vars after start has no effect), and per-session state. */

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

/** Thrown by an elicitor when the client did not declare elicitation, the only error the launch gate reads as 'the client cannot be asked'; any other throw means a prompt may have been shown and nobody confirmed. */
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
  /** Absolute project paths already approved for `run_project` in this session; the first call per path elicits. */
  runProjectConfirmed: Set<string>;
}

export interface McpContext {
  elicitor: Elicitor;
  strictMode: boolean;
  /** Skips interactive confirmation prompts, treated as accepted (fail-open), for clients that cannot surface elicitation (Claude Desktop auto-cancels them). Resolved to `false` under strict mode (`createContextFromServer`), which mandates confirmation; Tier 1 hard blocks never elicit and still block. */
  disableElicitation: boolean;
  /** Makes the whole `run_script` / `run_project` security gate a no-op: no scan, no tier decision, no elicitation, no warnings or `.policy.json` sidecar, Tier 1 included.
   * Overrides `GODOT_MCP_STRICT` (a startup log notes it), the opposite precedence from `disableElicitation`: deliberate, as the weakest setting a human can opt into must win. Enabling it is a human decision; an agent asked to set it should decline (README.md / docs/security.md). */
  disableSecurity: boolean;
  sessionState: SessionState;
}

/** Resolves `GODOT_MCP_DISABLE_SECURITY` against `strictMode`; pure so it is testable without an SDK `Server`, and `createContextFromServer` is the only caller. */
export interface DisableSecurityResolution {
  disableSecurity: boolean;
  /** True only when both flags are set; the caller prints the 'strict mode ignored' startup line exactly then. */
  strictIgnored: boolean;
}

/** Disable-security is independent of strict mode's value and always wins when both are set; `strictIgnored` exists for the startup log, not behavior. */
export function resolveDisableSecurity(
  rawValue: string | undefined,
  strictMode: boolean,
): DisableSecurityResolution {
  const disableSecurity = rawValue === 'true';
  return { disableSecurity, strictIgnored: disableSecurity && strictMode };
}

/** The flags that turn on only for the exact string `true`, and what each being off means. */
const BOOLEAN_FLAG_OFF_EFFECTS: ReadonlyArray<readonly [name: string, effect: string]> = [
  ['GODOT_MCP_STRICT', 'strict mode is OFF'],
  ['GODOT_MCP_DISABLE_ELICITATION', 'confirmation prompts stay ON'],
  ['GODOT_MCP_DISABLE_SECURITY', 'the security gate stays ON'],
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

/** One startup line per security flag set to something other than `true` or `false`: a flag is read as the exact string `true`, so `1` or `TRUE` leaves it off with no other sign. Unset and empty are not reported. */
export function describeIgnoredFlagValues(env: Record<string, string | undefined>): string[] {
  const lines: string[] = [];
  for (const [name, effect] of BOOLEAN_FLAG_OFF_EFFECTS) {
    const value = env[name];
    if (value === undefined || value === '' || value === 'true' || value === 'false') continue;
    lines.push(`[SERVER] ${name}=${quoteAsAscii(value)} is not "true" and was ignored: ${effect}`);
  }
  return lines;
}

/** Normalizes an absolute project path as a `runProjectConfirmed` key: Windows paths are case-insensitive, so `D:\proj` and `d:\proj` would each elicit; lowercasing on win32 collapses them. */
export function normalizeProjectKey(absPath: string): string {
  return process.platform === 'win32' ? absPath.toLowerCase() : absPath;
}

/** A no-op context for tests; the elicitor always declines, so accept paths need a scripted elicitor. */
export function createNullContext(overrides?: Partial<McpContext>): McpContext {
  return {
    elicitor: async () => ({ action: 'decline' }),
    strictMode: false,
    disableElicitation: false,
    disableSecurity: false,
    sessionState: {
      runProjectConfirmed: new Set<string>(),
    },
    ...overrides,
  };
}
