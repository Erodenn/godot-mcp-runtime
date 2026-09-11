/**
 * Request-scoped context threaded through tool dispatch.
 *
 * Carries the elicitor (used by `run_script` / `run_project` to pause for
 * user confirmation on Tier 2 findings), the global strict-mode flag, the
 * disable-elicitation flag, the disable-security flag, and per-session state
 * (currently the once-per-project gate for `run_project`).
 *
 * The strict-mode, no-elicit, and no-security flags are captured when the
 * context is built (see `createContextFromServer` in `src/index.ts`).
 * Toggling `GODOT_MCP_STRICT`, `GODOT_MCP_DISABLE_ELICITATION`, or
 * `GODOT_MCP_DISABLE_SECURITY` after the server starts has no effect.
 */

/**
 * Result of an elicitation prompt. Mirrors the SDK's `ElicitResult` shape
 * without importing it, so the utils layer stays decoupled from the MCP SDK.
 */
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

/**
 * Async function that prompts the user via the MCP elicitation channel.
 * Throws when the client does not support elicitation; callers should treat
 * a thrown error as a denial.
 */
export type Elicitor = (request: ElicitorRequest) => Promise<ElicitorResult>;

export interface SessionState {
  /**
   * Set of absolute project paths for which the user has already approved
   * `run_project` in this server session. First call against each path
   * elicits; later calls skip.
   */
  runProjectConfirmed: Set<string>;
}

export interface McpContext {
  elicitor: Elicitor;
  strictMode: boolean;
  /**
   * When true, the interactive confirmation prompts are skipped and treated as
   * accepted (fail-open): `run_project` launches without its blanket gate, and
   * Tier 2 `run_script` findings proceed with a warning instead of eliciting.
   * Set from `GODOT_MCP_DISABLE_ELICITATION=true` for clients that cannot surface
   * elicitation prompts (e.g. Claude Desktop, which auto-cancels them). This is
   * resolved to `false` when strict mode is on (see `createContextFromServer`):
   * strict mandates explicit confirmation, so it takes precedence. Tier 1
   * hard-block primitives are unaffected — they never elicit and always block.
   */
  disableElicitation: boolean;
  /**
   * When true, the entire `run_script` / `run_project` security gate is a
   * no-op: no static-analysis scan, no Tier 1/2/3 decision, no elicitation,
   * no `warnings`, no `.policy.json` audit sidecar — for both handlers,
   * Tier 1 hard blocks included. `run_project`'s pre-flight autoload/scene
   * scan and its session-confirmation elicitation are both skipped too (see
   * CLAUDE.md `run-script-policy.ts` invariant section).
   *
   * Set from `GODOT_MCP_DISABLE_SECURITY=true`. Overrides `GODOT_MCP_STRICT`:
   * when both are set, security is off and a startup log records that strict
   * mode was ignored. This is the opposite precedence from
   * `disableElicitation` (where strict wins) — deliberate, not an
   * inconsistency to "fix": the whole point of this flag is that it is the
   * weakest setting a human can opt into, so it has to win when it's set.
   * Enabling it is a human decision; an agent asked to set it on a user's
   * behalf should decline (see README.md / docs/security.md).
   */
  disableSecurity: boolean;
  sessionState: SessionState;
}

/**
 * Result of resolving `GODOT_MCP_DISABLE_SECURITY` against the already-resolved
 * `strictMode` flag. Pure so it can be unit-tested without constructing a real
 * SDK `Server` — `createContextFromServer` (`src/index.ts`) is the only caller
 * and reads `process.env.GODOT_MCP_DISABLE_SECURITY` exactly once, here.
 */
export interface DisableSecurityResolution {
  /** The resolved `McpContext.disableSecurity` value. */
  disableSecurity: boolean;
  /**
   * True only when both `GODOT_MCP_DISABLE_SECURITY` and `strictMode` are set
   * — disable-security wins, and the caller uses this to print the "strict
   * mode ignored" startup line exactly in that case.
   */
  strictIgnored: boolean;
}

/**
 * Resolve `GODOT_MCP_DISABLE_SECURITY` against `strictMode`. Unlike
 * `disableElicitation` (which resolves to `false` when strict is on),
 * disable-security is independent of strict mode's value: it is read as-is,
 * and always wins when both are set — the gate is skipped either way, so
 * `strictMode` is never consulted downstream. `strictIgnored` exists purely
 * for the startup log, not for behavior.
 */
export function resolveDisableSecurity(
  rawValue: string | undefined,
  strictMode: boolean,
): DisableSecurityResolution {
  const disableSecurity = rawValue === 'true';
  return { disableSecurity, strictIgnored: disableSecurity && strictMode };
}

/**
 * Normalize an absolute project path for use as a key in `runProjectConfirmed`.
 * Windows paths are case-insensitive at the filesystem level, so two calls with
 * `D:\proj` and `d:\proj` would otherwise be treated as distinct projects and
 * each trigger their own elicitation. Lowercasing on win32 collapses them.
 */
export function normalizeProjectKey(absPath: string): string {
  return process.platform === 'win32' ? absPath.toLowerCase() : absPath;
}

/**
 * Build a no-op context for test call sites. The elicitor always declines —
 * tests that need an accept path should construct their own context with a
 * scripted elicitor instead.
 */
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
