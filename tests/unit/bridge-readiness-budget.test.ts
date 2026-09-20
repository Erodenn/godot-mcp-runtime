/**
 * Relationship tests for the bridge readiness budgets. The behavior these
 * constants govern (how long a cold Godot start is given before a genuine
 * failure is reported) is unobservable without a real cold launch, so these
 * assert the invariants a future edit would break rather than simulate a
 * timeline with fake timers.
 */

import { describe, it, expect } from 'vitest';
import { BRIDGE_WAIT_SPAWNED_TIMEOUT_MS } from '../../src/utils/bridge-protocol.js';
import {
  GodotRunner,
  BRIDGE_WAIT_ATTACHED_TIMEOUT_MS,
  BRIDGE_WAIT_ATTACHED_CONNECTED_TIMEOUT_MS,
  BRIDGE_WAIT_BACKOFF_AFTER_MS,
  BRIDGE_WAIT_MAX_INTERVAL_MS,
  BRIDGE_WAIT_ATTACHED_INTERVAL_MS,
  BRIDGE_CONNECTED_PING_FAILURE_LIMIT,
} from '../../src/utils/godot-runner.js';

/** The MCP SDK's default per-request client timeout. */
const SDK_DEFAULT_CLIENT_TIMEOUT_MS = 60000;

interface PollOpts {
  expectedPath: string | null;
  timeoutMs: number;
  intervalMs: number;
  timeoutError: string;
  pingPayload: Record<string, unknown>;
  validatePong: (parsed: { status?: string }) => boolean;
  extendedTimeoutMs?: number;
}

/**
 * Drive `pollBridge` directly with a stubbed `sendCommand` and a short
 * extended ceiling. The failure cut-off is a property of the loop, not of the
 * shipped constants, so the test supplies its own budget and lets the real
 * `BRIDGE_CONNECTED_PING_FAILURE_LIMIT` decide when the loop gives up.
 */
function pollWithStub(
  ping: () => Promise<string>,
  opts: Partial<PollOpts> = {},
): { runner: GodotRunner; poll: () => Promise<{ ready: boolean; error?: string }>; pings: number } {
  const runner = new GodotRunner();
  const state = { pings: 0 };
  const internals = runner as unknown as {
    bridgeConnectObserved: boolean;
    sendCommand: () => Promise<string>;
    pollBridge: (o: PollOpts) => Promise<{ ready: boolean; error?: string }>;
  };
  // A TCP connect has been observed, which is what puts the extended ceiling
  // and the failure counter in force.
  internals.bridgeConnectObserved = true;
  internals.sendCommand = () => {
    state.pings += 1;
    return ping();
  };
  return {
    runner,
    poll: () =>
      internals.pollBridge({
        expectedPath: null,
        timeoutMs: 20000,
        intervalMs: 1,
        timeoutError: 'budget expired',
        pingPayload: {},
        validatePong: (parsed) => parsed.status === 'pong',
        extendedTimeoutMs: 1000,
        ...opts,
      }),
    get pings() {
      return state.pings;
    },
  };
}

describe('bridge readiness budget', () => {
  it('reports the spawned bridge timeout in seconds from the shared constant', () => {
    expect(BRIDGE_WAIT_SPAWNED_TIMEOUT_MS).toBeGreaterThanOrEqual(20000);
    expect(BRIDGE_WAIT_SPAWNED_TIMEOUT_MS % 1000).toBe(0);
  });

  it('gives a connected-but-silent bridge a longer ceiling than an absent one', () => {
    expect(BRIDGE_WAIT_ATTACHED_CONNECTED_TIMEOUT_MS).toBeGreaterThan(
      BRIDGE_WAIT_ATTACHED_TIMEOUT_MS,
    );
  });

  it('backs off the poll interval below the longest attached ceiling', () => {
    expect(BRIDGE_WAIT_BACKOFF_AFTER_MS).toBeLessThan(BRIDGE_WAIT_ATTACHED_TIMEOUT_MS);
    expect(BRIDGE_WAIT_MAX_INTERVAL_MS).toBeGreaterThan(BRIDGE_WAIT_ATTACHED_INTERVAL_MS);
  });

  it('keeps the connected ceiling under the default client timeout with teardown headroom', () => {
    // A client with no progressToken gets no heartbeats, so a wait past its own
    // ceiling is aborted before the server's structured error can be delivered.
    expect(BRIDGE_WAIT_ATTACHED_CONNECTED_TIMEOUT_MS).toBeLessThan(SDK_DEFAULT_CLIENT_TIMEOUT_MS);
    expect(
      SDK_DEFAULT_CLIENT_TIMEOUT_MS - BRIDGE_WAIT_ATTACHED_CONNECTED_TIMEOUT_MS,
    ).toBeGreaterThanOrEqual(10000);
  });

  it('gives up on a listener that answers no ping, well before the ceiling', async () => {
    const harness = pollWithStub(() => Promise.reject(new Error('connection refused')));
    const started = Date.now();
    const result = await harness.poll();

    expect(result.ready).toBe(false);
    expect(result.error).toContain(String(BRIDGE_CONNECTED_PING_FAILURE_LIMIT));
    expect(result.error).not.toBe('budget expired');
    expect(harness.pings).toBe(BRIDGE_CONNECTED_PING_FAILURE_LIMIT);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('resets the failure count on any answered ping, so a bridge mid-startup is never cut off', async () => {
    // Answers every ping, but never with a valid pong: an engine that is
    // listening and still booting. The loop must spend its whole budget.
    const harness = pollWithStub(() => Promise.resolve(JSON.stringify({ status: 'booting' })), {
      extendedTimeoutMs: 200,
    });
    const result = await harness.poll();

    expect(result).toEqual({ ready: false, error: 'budget expired' });
    expect(harness.pings).toBeGreaterThan(BRIDGE_CONNECTED_PING_FAILURE_LIMIT);
  });

  it('still reports readiness on the first valid pong', async () => {
    const harness = pollWithStub(() => Promise.resolve(JSON.stringify({ status: 'pong' })));
    expect(await harness.poll()).toEqual({ ready: true });
    expect(harness.pings).toBe(1);
  });

  it('returns a timeout error without an active spawned process instead of waiting', async () => {
    const runner = new GodotRunner();
    const started = Date.now();
    const result = await runner.waitForBridge();
    expect(result).toEqual({
      ready: false,
      error: 'No active spawned Godot process to verify',
    });
    expect(Date.now() - started).toBeLessThan(100);
  });
});
