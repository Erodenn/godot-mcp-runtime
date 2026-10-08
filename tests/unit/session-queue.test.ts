/**
 * The session queue: one operation at a time, a bounded wait whose error
 * names what the caller waited behind, and nested calls from inside the
 * running operation that do not wait on themselves.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { CLIENT_REQUEST_TIMEOUT_MS, type GodotRunner } from '../../src/utils/godot-runner.js';
import { QUEUE_CHARGED_COMMAND_FLOOR_MS, chargeQueueWait } from '../../src/utils/session-report.js';
import { hasError } from '../helpers/assertions.js';
import {
  SESSION_QUEUE_WAIT_TIMEOUT_MS,
  SessionQueue,
  SessionQueueTimeoutError,
} from '../../src/utils/session-queue.js';

/** The MCP SDK's default per-request client timeout. */
const SDK_DEFAULT_CLIENT_TIMEOUT_MS = 60000;
/** A wait short enough for a real-time test of the timeout. */
const SHORT_WAIT_MS = 40;

/** A promise and the function that resolves it, for holding an operation open. */
function gate(): { opened: Promise<void>; open: () => void } {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

describe('SessionQueue', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs a lone operation at once and hands back its result', async () => {
    const queue = new SessionQueue();
    await expect(queue.run('take_screenshot', async () => 'done')).resolves.toBe('done');
    expect(queue.running).toBeNull();
  });

  it('holds a second operation until the first has finished, in arrival order', async () => {
    const queue = new SessionQueue();
    const first = gate();
    const order: string[] = [];

    const a = queue.run('run_project', async () => {
      order.push('a starts');
      await first.opened;
      order.push('a ends');
    });
    const b = queue.run('take_screenshot', async () => {
      order.push('b runs');
    });
    const c = queue.run('get_ui_elements', async () => {
      order.push('c runs');
    });

    await Promise.resolve();
    expect(queue.running).toBe('run_project');
    expect(order).toEqual(['a starts']);

    first.open();
    await Promise.all([a, b, c]);

    expect(order).toEqual(['a starts', 'a ends', 'b runs', 'c runs']);
    expect(queue.running).toBeNull();
  });

  it('releases the queue when an operation throws, and passes the error on', async () => {
    const queue = new SessionQueue();
    await expect(
      queue.run('run_script', async () => {
        throw new Error('bridge gone');
      }),
    ).rejects.toThrow('bridge gone');
    await expect(queue.run('stop_project', async () => 'stopped')).resolves.toBe('stopped');
  });

  it('gives up a wait past the timeout with an error naming the call it was behind, and never starts the operation', async () => {
    const queue = new SessionQueue(SHORT_WAIT_MS);
    const holding = gate();
    const held = queue.run('simulate_input', () => holding.opened);
    const waiter = vi.fn(async () => 'ran');

    const error = await queue.run('take_screenshot', waiter).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SessionQueueTimeoutError);
    const timeout = error as SessionQueueTimeoutError;
    expect(timeout.waiting).toBe('take_screenshot');
    expect(timeout.behind).toBe('simulate_input');
    expect(timeout.message).toContain('take_screenshot waited');
    expect(timeout.message).toContain('for simulate_input to finish');
    expect(waiter).not.toHaveBeenCalled();

    holding.open();
    await held;
  });

  it('skips a waiter that gave up: the next one in line gets the turn', async () => {
    const queue = new SessionQueue(SHORT_WAIT_MS);
    const holding = gate();
    const held = queue.run('run_project', () => holding.opened);
    const gaveUp = queue.run('take_screenshot', async () => 'never').catch(() => 'gave up');

    expect(await gaveUp).toBe('gave up');
    const later = queue.run('get_ui_elements', async () => 'ran');
    holding.open();

    await held;
    await expect(later).resolves.toBe('ran');
    expect(queue.running).toBeNull();
  });

  it('does not interrupt an operation that has started, however long it runs', async () => {
    vi.useFakeTimers();
    const queue = new SessionQueue(SHORT_WAIT_MS);
    const holding = gate();
    let finished = false;
    const long = queue.run('simulate_input', async () => {
      await holding.opened;
      finished = true;
      return 'complete';
    });

    await vi.advanceTimersByTimeAsync(SHORT_WAIT_MS * 10);
    expect(finished).toBe(false);
    holding.open();

    await expect(long).resolves.toBe('complete');
  });

  it('runs a nested call from inside the running operation at once', async () => {
    const queue = new SessionQueue(SHORT_WAIT_MS);
    const order: string[] = [];

    await queue.run('run_project', async () => {
      order.push('outer');
      // The start, the wait and the teardown of a tool call are nested like
      // this. Waiting here would be waiting on itself.
      await queue.run('bridge command ping', async () => {
        order.push('inner');
      });
      order.push('outer again');
    });

    expect(order).toEqual(['outer', 'inner', 'outer again']);
  });

  it('makes a call queue like anyone else when the operation it was started from has ended', async () => {
    const queue = new SessionQueue();
    const order: string[] = [];
    let late: Promise<void> = Promise.resolve();
    const next = gate();

    await queue.run('run_project', async () => {
      // A callback registered inside the operation and fired after it ended:
      // it carries the operation's context but no longer holds the queue.
      setTimeout(() => {
        late = queue.run('late callback', async () => {
          order.push('late');
        });
      }, SHORT_WAIT_MS);
    });
    const holder = queue.run('take_screenshot', async () => {
      order.push('holder starts');
      await next.opened;
      order.push('holder ends');
    });

    await new Promise((resolve) => setTimeout(resolve, SHORT_WAIT_MS * 2));
    expect(order).toEqual(['holder starts']);
    next.open();
    await holder;
    await late;

    expect(order).toEqual(['holder starts', 'holder ends', 'late']);
  });

  it('reports the queue as free, or held by the caller, only when that is so', async () => {
    const queue = new SessionQueue();
    expect(queue.freeOrHeldByCaller()).toBe(true);

    const holding = gate();
    let insideAnswer = false;
    const held = queue.run('switch_project', async () => {
      insideAnswer = queue.freeOrHeldByCaller();
      await holding.opened;
    });
    await Promise.resolve();

    expect(insideAnswer).toBe(true);
    expect(queue.freeOrHeldByCaller()).toBe(false);
    holding.open();
    await held;
    expect(queue.freeOrHeldByCaller()).toBe(true);
  });

  it('keeps the wait under the default client timeout, so the queue error can still be delivered', () => {
    expect(SESSION_QUEUE_WAIT_TIMEOUT_MS).toBeLessThan(SDK_DEFAULT_CLIENT_TIMEOUT_MS);
  });
});

describe('chargeQueueWait', () => {
  const BUDGET_MS = 30000;
  const WAITED_MS = 20000;
  const BEHIND = 'simulate_input';

  /** A runner whose caller got its turn after `waitedMs` behind `BEHIND`. */
  function runnerWaited(waitedMs: number | null): GodotRunner {
    const turn =
      waitedMs === null ? null : { requestedAt: 0, waitedMs, behind: waitedMs > 0 ? BEHIND : null };
    return { queueTurn: () => turn } as unknown as GodotRunner;
  }

  it('hands a call that did not wait its whole budget', () => {
    const charged = chargeQueueWait(runnerWaited(0), 'run_script', {
      kind: 'shorten',
      budgetMs: BUDGET_MS,
    });
    expect(charged).toEqual({ ok: true, value: BUDGET_MS });
  });

  it('takes the wait off a shortened budget', () => {
    const charged = chargeQueueWait(runnerWaited(WAITED_MS), 'run_script', {
      kind: 'shorten',
      budgetMs: BUDGET_MS,
    });
    expect(charged).toEqual({ ok: true, value: BUDGET_MS - WAITED_MS });
  });

  it('refuses a shortened budget left under the floor', () => {
    const waited = BUDGET_MS - QUEUE_CHARGED_COMMAND_FLOOR_MS + 1;
    expect(
      hasError(
        chargeQueueWait(runnerWaited(waited), 'run_script', {
          kind: 'shorten',
          budgetMs: BUDGET_MS,
        }),
      ),
    ).toBe(true);
    const atFloor = BUDGET_MS - QUEUE_CHARGED_COMMAND_FLOOR_MS;
    expect(
      chargeQueueWait(runnerWaited(atFloor), 'run_script', {
        kind: 'shorten',
        budgetMs: BUDGET_MS,
      }),
    ).toEqual({ ok: true, value: QUEUE_CHARGED_COMMAND_FLOOR_MS });
  });

  it('refuses a fixed worst case that fit the request timeout alone and no longer does', () => {
    const worstCaseMs = CLIENT_REQUEST_TIMEOUT_MS - WAITED_MS;
    expect(
      chargeQueueWait(runnerWaited(WAITED_MS), 'profile_project', { kind: 'fixed', worstCaseMs }),
    ).toEqual({ ok: true, value: worstCaseMs });
    expect(
      hasError(
        chargeQueueWait(runnerWaited(WAITED_MS + 1), 'profile_project', {
          kind: 'fixed',
          worstCaseMs,
        }),
      ),
    ).toBe(true);
  });

  it('never refuses a fixed worst case already over the request timeout, or a call outside a turn', () => {
    const over = CLIENT_REQUEST_TIMEOUT_MS + 1;
    expect(
      chargeQueueWait(runnerWaited(WAITED_MS), 'simulate_input', {
        kind: 'fixed',
        worstCaseMs: over,
      }),
    ).toEqual({ ok: true, value: over });
    expect(
      chargeQueueWait(runnerWaited(null), 'simulate_input', { kind: 'fixed', worstCaseMs: over }),
    ).toEqual({ ok: true, value: over });
  });
});

describe('SessionQueue.turn as the runner exposes it', () => {
  it('reports the wait and the holder a call got its turn behind', async () => {
    const queue = new SessionQueue();
    const first = gate();
    const held = queue.run('first', () => first.opened);
    let seen: ReturnType<SessionQueue['turn']> = null;
    const second = queue.run('second', async () => {
      seen = queue.turn();
    });
    first.open();
    await Promise.all([held, second]);
    expect(seen).toMatchObject({ behind: 'first' });
    expect(seen!.waitedMs).toBeGreaterThanOrEqual(0);
    expect(queue.turn()).toBeNull();
  });
});
