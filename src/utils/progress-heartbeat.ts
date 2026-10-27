import type { CallToolRequest, ServerContext } from '@modelcontextprotocol/server';

import { logDebug } from './logger.js';

/** Interval between progress heartbeats: clients with `resetTimeoutOnProgress` reset their per-request timeout (SDK default 60 s) only when the server sends progress, and long tools exceed 60 s. 20 s gives three beats per window; clients that did not opt in ignore them. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;

/** The progress token a client attached to a tools/call (the SDK sends `_meta.progressToken` only with an `onprogress` handler). */
function progressTokenFrom(request: CallToolRequest): string | number | undefined {
  const token = (request.params as { _meta?: { progressToken?: string | number } })._meta
    ?.progressToken;
  return token;
}

/** Starts progress heartbeats for an in-flight tools/call; the returned stop function MUST be called when the handler settles, is idempotent, and is a no-op without a token. */
export function startProgressHeartbeat(
  ctx: { mcpReq: Pick<ServerContext['mcpReq'], 'notify'> },
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
    ctx.mcpReq
      .notify({
        method: 'notifications/progress',
        params: {
          progressToken: token,
          progress,
        },
      })
      .catch((err: unknown) => {
        // A failed heartbeat must never fail the tool call; the opted-in client surfaces its own timeout if beats stop.
        logDebug(`Progress heartbeat failed (continuing): ${String(err)}`);
      });
  };

  // Fire immediately, then on the interval, so a tool finishing inside one interval still notifies once.
  beat();
  timer = setInterval(beat, intervalMs);

  return () => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) clearInterval(timer);
  };
}
