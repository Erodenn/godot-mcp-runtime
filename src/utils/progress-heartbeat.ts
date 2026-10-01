import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CallToolRequest, Notification } from '@modelcontextprotocol/sdk/types.js';

import { logDebug } from './logger.js';

/**
 * Interval between progress heartbeat notifications. The MCP spec lets
 * clients impose a per-request timeout (the SDK default is 60s) and reset it
 * when `resetTimeoutOnProgress` is set, but ONLY when the server sends
 * progress notifications. Long-running tools (run_script simulations,
 * playtests) routinely exceed 60s, so the server heartbeats to keep the
 * request alive for clients that opted in. Clients that did not opt in
 * ignore the notifications (their timeout behavior is unchanged).
 *
 * 20s gives 3 heartbeats per SDK-default 60s client timeout window.
 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * Extract the progress token a client attached to a tools/call request
 * (present only when the client registered an `onprogress` handler — the
 * SDK sends `_meta.progressToken` only then).
 */
function progressTokenFrom(request: CallToolRequest): string | number | undefined {
  const token = (request.params as { _meta?: { progressToken?: string | number } })._meta
    ?.progressToken;
  return token;
}

/**
 * Start sending progress heartbeats for an in-flight tools/call request.
 *
 * Returns a stop function that MUST be called when the handler settles
 * (success or error); it is safe to call more than once and safe to call on
 * a heartbeat that never started (no token → no-op stopper).
 */
export function startProgressHeartbeat(
  extra: RequestHandlerExtra<never, Notification>,
  request: CallToolRequest,
  intervalMs: number = DEFAULT_HEARTBEAT_INTERVAL_MS,
): () => void {
  const token = progressTokenFrom(request);
  if (token === undefined) {
    return () => {};
  }

  let progress = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const beat = (): void => {
    if (stopped) return;
    progress += 1;
    extra
      .sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken: token,
          progress,
        },
      })
      .catch((err: unknown) => {
        // A failed heartbeat (transport hiccup, unsupported notification)
        // must never fail the tool call itself. The client that opted in will
        // surface its own timeout if heartbeats stop arriving.
        logDebug(`Progress heartbeat failed (continuing): ${String(err)}`);
      });
  };

  // Fire immediately, then on the interval — a tool finishing inside one
  // interval still notifies at least once so clients see liveness from the
  // first moment.
  beat();
  timer = setInterval(beat, intervalMs);

  return () => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) clearInterval(timer);
  };
}
