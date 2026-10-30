// One-at-a-time execution for everything touching session state or the bridge socket. A wait is bounded: progress-token clients get heartbeats and would never cut a parked caller off, so past `waitTimeoutMs` it errors naming what it was behind. A started operation is never interrupted; it keeps its own timeout.

import { AsyncLocalStorage } from 'async_hooks';

/** How long a caller waits for its turn: half the SDK's 60 s request timeout, so the queue's own error still arrives and a late turn has half left. */
export const SESSION_QUEUE_WAIT_TIMEOUT_MS = 30000;

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

/** What the holding operation knows about how it got its turn; a start charges the wait against its budget. */
export interface QueueTurn {
  readonly requestedAt: number;
  readonly waitedMs: number;
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
  // Carries the holder through the operation's awaits so a nested call runs at once; compared with the live holder, so a context that outlived its operation queues like anyone else.
  private readonly context = new AsyncLocalStorage<Holder>();

  constructor(private readonly waitTimeoutMs: number = SESSION_QUEUE_WAIT_TIMEOUT_MS) {}

  get running(): string | null {
    return this.holder?.label ?? null;
  }

  freeOrHeldByCaller(): boolean {
    return this.holder === null || this.context.getStore() === this.holder;
  }

  /** The turn of the operation the caller is inside (the outermost, i.e. the request's own wait), or null. */
  turn(): QueueTurn | null {
    const active = this.context.getStore();
    if (active === undefined || active !== this.holder) return null;
    return { requestedAt: active.requestedAt, waitedMs: active.waitedMs, behind: active.behind };
  }

  /** Run `operation` when the queue is free, or directly when called from inside the running operation. @throws {SessionQueueTimeoutError} when the turn did not come in time; `operation` was not started. */
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
