/**
 * One-at-a-time execution for everything that touches runtime session state or
 * the bridge socket.
 *
 * The bridge socket carries one command at a time, and a session transition
 * (start, stop, switch) reads and writes the session map across several
 * awaits. An MCP client may issue tool calls in parallel, so both are run
 * through this queue: a second caller waits its turn instead of being
 * rejected or interleaving with the first.
 *
 * A wait is bounded. The server answers progress-token clients with
 * heartbeats, so a caller parked here would never be cut off by its client;
 * past `waitTimeoutMs` it gets an error naming the operation it was behind.
 * An operation that has started is never interrupted by the queue: it keeps
 * its own timeout.
 */

import { AsyncLocalStorage } from 'async_hooks';

/**
 * How long a caller waits for its turn. Held at half the MCP SDK's 60 s
 * default per-request timeout, so a client that gets no heartbeats still
 * receives this queue's own error, and a caller that does get its turn late
 * has the other half left for its own command.
 */
export const SESSION_QUEUE_WAIT_TIMEOUT_MS = 30000;

/** A caller gave up waiting for its turn. Names what held the queue. */
export class SessionQueueTimeoutError extends Error {
  constructor(
    readonly waiting: string,
    readonly behind: string,
    readonly waitedMs: number,
  ) {
    super(
      `${waiting} waited ${waitedMs} ms for ${behind} to finish and gave up; nothing was sent for it. ` +
        `Runtime sessions run one operation at a time: retry once ${behind} has returned.`,
    );
    this.name = 'SessionQueueTimeoutError';
  }
}

/**
 * What the operation holding the queue knows about how it got there. A start
 * reads it to charge the time it spent waiting against its own budget.
 */
export interface QueueTurn {
  /** `Date.now()` when the caller asked for its turn. */
  readonly requestedAt: number;
  /** Milliseconds between asking and getting the turn; 0 when the queue was free. */
  readonly waitedMs: number;
  /** Label of the operation that released the queue to this one, or null when it was free. */
  readonly behind: string | null;
}

interface Holder {
  readonly label: string;
  readonly requestedAt: number;
  waitedMs: number;
  behind: string | null;
}

interface Waiter {
  readonly holder: Holder;
  readonly grant: () => void;
}

export class SessionQueue {
  private holder: Holder | null = null;
  private readonly waiters: Waiter[] = [];
  /**
   * Carries the holder through the awaits of the operation it runs, so a
   * nested call from inside that operation is recognized and runs at once
   * instead of waiting on itself. The stored value is compared with the live
   * holder: a context that outlived its operation (a listener registered
   * inside it and fired later) matches nothing and queues like anyone else.
   */
  private readonly context = new AsyncLocalStorage<Holder>();

  constructor(private readonly waitTimeoutMs: number = SESSION_QUEUE_WAIT_TIMEOUT_MS) {}

  /** Label of the operation holding the queue, or null when it is free. */
  get running(): string | null {
    return this.holder?.label ?? null;
  }

  /** True when no operation holds the queue, or the caller is inside the one that does. */
  freeOrHeldByCaller(): boolean {
    return this.holder === null || this.context.getStore() === this.holder;
  }

  /**
   * The turn of the operation the caller is inside, or null when the caller
   * is not inside the operation holding the queue. A nested call sees the
   * turn of the outermost one, which is the request's own wait.
   */
  turn(): QueueTurn | null {
    const active = this.context.getStore();
    if (active === undefined || active !== this.holder) return null;
    return { requestedAt: active.requestedAt, waitedMs: active.waitedMs, behind: active.behind };
  }

  /**
   * Run `operation` when the queue is free. Called from inside an operation
   * the queue is already running, it runs `operation` directly.
   *
   * @throws {SessionQueueTimeoutError} when the turn did not come within the
   *   wait timeout. `operation` was not started.
   */
  async run<T>(label: string, operation: () => Promise<T>): Promise<T> {
    const active = this.context.getStore();
    if (active !== undefined && active === this.holder) return operation();

    const holder: Holder = { label, requestedAt: Date.now(), waitedMs: 0, behind: null };
    await this.acquire(holder);
    try {
      return await this.context.run(holder, operation);
    } finally {
      this.release(holder);
    }
  }

  private acquire(holder: Holder): Promise<void> {
    if (this.holder === null) {
      this.holder = holder;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const startedAt = holder.requestedAt;
      const waiter: Waiter = {
        holder,
        grant: () => {
          clearTimeout(timer);
          resolve();
        },
      };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(
          new SessionQueueTimeoutError(
            holder.label,
            this.holder?.label ?? 'another operation',
            Date.now() - startedAt,
          ),
        );
      }, this.waitTimeoutMs);
      this.waiters.push(waiter);
    });
  }

  private release(holder: Holder): void {
    if (this.holder !== holder) return;
    const next = this.waiters.shift();
    this.holder = next?.holder ?? null;
    if (next === undefined) return;
    next.holder.waitedMs = Date.now() - next.holder.requestedAt;
    next.holder.behind = holder.label;
    next.grant();
  }
}
