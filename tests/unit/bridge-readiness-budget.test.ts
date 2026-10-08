/**
 * Relationship tests for the bridge readiness budgets. The behavior these
 * constants govern (how long a cold Godot start is given before a genuine
 * failure is reported) is unobservable without a real cold launch, so these
 * assert the invariants a future edit would break rather than simulate a
 * timeline with fake timers.
 */

import { describe, it, expect } from 'vitest';
import {
  BRIDGE_UNAUTHORIZED_ERROR,
  BRIDGE_WAIT_SPAWNED_TIMEOUT_MS,
} from '../../src/utils/bridge-protocol.js';
import { SESSION_QUEUE_WAIT_TIMEOUT_MS } from '../../src/utils/session-queue.js';
import {
  GodotRunner,
  BRIDGE_PING_TIMEOUT_MS,
  BRIDGE_WAIT_FLOOR_MS,
  CLIENT_REQUEST_TIMEOUT_MS,
  START_RESPONSE_BUDGET_MS,
  SPAWNED_STOP_WORST_CASE_MS,
  ATTACHED_STOP_WORST_CASE_MS,
  startBridgeWaitDeadline,
  BRIDGE_WAIT_ATTACHED_TIMEOUT_MS,
  BRIDGE_WAIT_ATTACHED_CONNECTED_TIMEOUT_MS,
  BRIDGE_WAIT_BACKOFF_AFTER_MS,
  BRIDGE_WAIT_MAX_INTERVAL_MS,
  BRIDGE_WAIT_ATTACHED_INTERVAL_MS,
  BRIDGE_CONNECTED_PING_FAILURE_LIMIT,
  type BridgeWaitResult,
  type RuntimeSession,
} from '../../src/utils/godot-runner.js';
import { installSession } from '../helpers/session-install.js';

/** The MCP SDK's default per-request client timeout. */
const SDK_DEFAULT_CLIENT_TIMEOUT_MS = 60000;
/** Port on the stub record. Nothing is dialed: `sendCommandTo` is replaced. */
const STUB_BRIDGE_PORT = 19990;
const OTHER_PROJECT_PATH = '/session-install/other-project';

interface PollOpts {
  expectedPath: string | null;
  timeoutMs: number;
  intervalMs: number;
  timeoutError: string;
  pingPayload: Record<string, unknown>;
  validatePong: (parsed: { status?: string }) => boolean;
  extendedTimeoutMs?: number;
  deadlineAt?: number | null;
}

/** Longest a test waits for a poll that is expected to end on a short budget. */
const SHORT_POLL_CEILING_MS = 1000;
/** A request deadline this far ahead ends a poll long before either ceiling. */
const NEAR_DEADLINE_MS = 60;

/**
 * Drive `pollBridge` directly with a stubbed `sendCommandTo` and a short
 * extended ceiling. The failure cut-off is a property of the loop, not of the
 * shipped constants, so the test supplies its own budget and lets the real
 * `BRIDGE_CONNECTED_PING_FAILURE_LIMIT` decide when the loop gives up.
 */
function pollWithStub(
  ping: () => Promise<string>,
  opts: Partial<PollOpts> = {},
): {
  runner: GodotRunner;
  session: RuntimeSession;
  poll: () => Promise<BridgeWaitResult>;
  pings: number;
  pingedSessions: RuntimeSession[];
} {
  const runner = new GodotRunner();
  const pingedSessions: RuntimeSession[] = [];
  const internals = runner as unknown as {
    sendCommandTo: (target: RuntimeSession) => Promise<string>;
    pollBridge: (session: RuntimeSession, o: PollOpts) => Promise<BridgeWaitResult>;
  };
  // The wait is on one record, which is registered like a started session's.
  const session = installSession(runner, { mode: 'attached', bridgePort: STUB_BRIDGE_PORT });
  // A TCP connect has been observed, which is what puts the extended ceiling
  // and the failure counter in force.
  session.bridgeConnectObserved = true;
  internals.sendCommandTo = (target) => {
    pingedSessions.push(target);
    return ping();
  };
  return {
    runner,
    session,
    pingedSessions,
    poll: () =>
      internals.pollBridge(session, {
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
      return pingedSessions.length;
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

    expect(result).toEqual({
      ready: false,
      error: 'budget expired',
      waitedMs: expect.any(Number),
    });
    expect(harness.pings).toBeGreaterThan(BRIDGE_CONNECTED_PING_FAILURE_LIMIT);
  });

  it('ends the wait on the first ping a bridge refuses for its token, naming the port', async () => {
    // A Godot left from an earlier session: it answers every ping, so the
    // failure count never starts, and it will never accept this token. Red
    // when the refusal is treated like any other answered ping: the loop then
    // runs to 'budget expired' with many pings.
    const harness = pollWithStub(() =>
      Promise.resolve(JSON.stringify({ error: BRIDGE_UNAUTHORIZED_ERROR })),
    );
    const started = Date.now();

    const result = await harness.poll();

    expect(harness.pings).toBe(1);
    expect(result.ready).toBe(false);
    expect(result.error).toBe(
      `A bridge with a different session token is listening on port ${STUB_BRIDGE_PORT}: a Godot left from an earlier session. Close it, then retry.`,
    );
    expect(Date.now() - started).toBeLessThan(SHORT_POLL_CEILING_MS);
  });

  it('keeps waiting on a bridge that answers with some other error', async () => {
    // Only the token refusal is final. Any other error reply is a bridge that
    // is up and not ready, which the wait exists for.
    let calls = 0;
    const harness = pollWithStub(() => {
      calls += 1;
      return Promise.resolve(
        JSON.stringify(calls === 1 ? { error: 'Scene tree not ready' } : { status: 'pong' }),
      );
    });

    expect(await harness.poll()).toEqual({ ready: true, waitedMs: expect.any(Number) });
    expect(harness.pings).toBe(2);
  });

  it('does not count refusals from before the port accepted a connection', async () => {
    // The normal attach flow: run_project is called, Godot is launched a few
    // seconds later. Every ping before the listener exists is refused, then a
    // connect succeeds and the first ping times out while the engine finishes
    // starting, then the pong arrives.
    const refusalsBeforeListening = BRIDGE_CONNECTED_PING_FAILURE_LIMIT + 2;
    let calls = 0;
    const harness = pollWithStub(() => {
      calls += 1;
      if (calls <= refusalsBeforeListening) {
        return Promise.reject(new Error('connect ECONNREFUSED'));
      }
      harness.session.bridgeConnectObserved = true;
      if (calls === refusalsBeforeListening + 1) {
        return Promise.reject(new Error("Command 'ping' timed out"));
      }
      return Promise.resolve(JSON.stringify({ status: 'pong' }));
    });
    harness.session.bridgeConnectObserved = false;

    expect(await harness.poll()).toEqual({ ready: true, waitedMs: expect.any(Number) });
    expect(harness.pings).toBe(refusalsBeforeListening + 2);
  });

  it('still reports readiness on the first valid pong', async () => {
    const harness = pollWithStub(() => Promise.resolve(JSON.stringify({ status: 'pong' })));
    expect(await harness.poll()).toEqual({ ready: true, waitedMs: expect.any(Number) });
    expect(harness.pings).toBe(1);
  });

  // The path the session was started with and the one Godot reports for
  // res:// can differ in drive-letter or directory case and in the trailing
  // slash. That is the same project, under the same folding the session map
  // uses.
  it('accepts a pong whose project path differs from the expected one only in case and trailing slash', async () => {
    const harness = pollWithStub(
      () =>
        Promise.resolve(JSON.stringify({ status: 'pong', project_path: 'D:/Games/My Project/' })),
      { expectedPath: 'd:/games/my project' },
    );
    expect(await harness.poll()).toEqual({ ready: true, waitedMs: expect.any(Number) });
  });

  it('still refuses a pong from a bridge that reports another project', async () => {
    const harness = pollWithStub(
      () => Promise.resolve(JSON.stringify({ status: 'pong', project_path: 'D:/Games/Other/' })),
      { expectedPath: 'd:/games/my project' },
    );
    const result = await harness.poll();
    expect(result.ready).toBe(false);
    expect(result.error).toBe(
      'Bridge reports project D:/Games/Other, expected d:/games/my project',
    );
  });

  it('pings the session it was given, not whichever session is current by then', async () => {
    let calls = 0;
    const harness = pollWithStub(() => {
      calls += 1;
      if (calls === 1) {
        // Another project's session takes the current pointer mid-wait.
        installSession(harness.runner, { projectPath: OTHER_PROJECT_PATH, mode: 'attached' });
        return Promise.resolve(JSON.stringify({ status: 'booting' }));
      }
      return Promise.resolve(JSON.stringify({ status: 'pong' }));
    });

    expect(await harness.poll()).toEqual({ ready: true, waitedMs: expect.any(Number) });
    expect(harness.pingedSessions).toEqual([harness.session, harness.session]);
  });

  it('ends the wait when the session it waits on is replaced', async () => {
    const harness = pollWithStub(() => {
      const sessions = (harness.runner as unknown as { sessions: Map<string, RuntimeSession> })
        .sessions;
      sessions.delete(harness.session.key);
      return Promise.resolve(JSON.stringify({ status: 'booting' }));
    });

    const result = await harness.poll();
    expect(result.ready).toBe(false);
    expect(result.stopped).toBeUndefined();
    expect(result.error).toMatch(/replaced while it was starting/);
    expect(harness.pings).toBe(1);
  });

  // A stop does not wait for the start that holds the queue, so the wait has
  // to notice it: `stopped` is what tells run_project the session was ended on
  // purpose and is not a bridge that failed to come up.
  it('ends the wait as stopped when the session it waits on is stopped', async () => {
    const harness = pollWithStub(() => {
      harness.session.stopped = true;
      return Promise.resolve(JSON.stringify({ status: 'booting' }));
    });

    const result = await harness.poll();
    expect(result).toMatchObject({ ready: false, stopped: true });
    expect(result.error).toMatch(/stopped while it was starting/);
    expect(harness.pings).toBe(1);
  });

  it("ends the wait at the request's deadline, whichever ceiling would still allow more", async () => {
    const harness = pollWithStub(() => Promise.resolve(JSON.stringify({ status: 'booting' })), {
      deadlineAt: Date.now() + NEAR_DEADLINE_MS,
    });

    const result = await harness.poll();

    expect(result).toMatchObject({ ready: false, error: 'budget expired' });
    expect(harness.pings).toBeGreaterThan(1);
    expect(result.waitedMs).toBeLessThan(SHORT_POLL_CEILING_MS);
  });

  it.each(['spawned', 'attached'] as const)(
    'puts the %s bridge deadline where the wait, one ping in flight and the teardown fit the response budget',
    (mode) => {
      const requestedAt = 1_000_000;
      const teardown =
        mode === 'spawned' ? SPAWNED_STOP_WORST_CASE_MS : ATTACHED_STOP_WORST_CASE_MS;
      const deadline = startBridgeWaitDeadline(mode, requestedAt);

      expect(deadline + BRIDGE_PING_TIMEOUT_MS + teardown).toBe(
        requestedAt + START_RESPONSE_BUDGET_MS,
      );
      expect(START_RESPONSE_BUDGET_MS).toBeLessThan(CLIENT_REQUEST_TIMEOUT_MS);
      expect(CLIENT_REQUEST_TIMEOUT_MS).toBe(SDK_DEFAULT_CLIENT_TIMEOUT_MS);
    },
  );

  it.each(['spawned', 'attached'] as const)(
    'leaves a %s start that waited the whole queue timeout and replaced a spawned session more than the floor',
    (mode) => {
      const requestedAt = 1_000_000;
      const turnAt = requestedAt + SESSION_QUEUE_WAIT_TIMEOUT_MS;
      const left = startBridgeWaitDeadline(mode, requestedAt) - turnAt - SPAWNED_STOP_WORST_CASE_MS;

      expect(left).toBeGreaterThanOrEqual(BRIDGE_WAIT_FLOOR_MS);
    },
  );

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
