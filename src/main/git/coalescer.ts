import { IncError } from '@shared/errors';

interface Waiter<T> {
  resolve(value: T): void;
  reject(error: unknown): void;
}

/**
 * Runs one asynchronous job at a time and merges overlapping requests.
 *
 *  - A request while idle starts the job.
 *  - A request while the job runs does not start a second one: it joins a single follow-up job
 *    that starts when the current one ends. Any number of requests share that follow-up.
 *  - A `supersede` request also aborts the running job, because its result is already stale; the
 *    callers who were waiting on it receive the follow-up's result instead.
 *
 * Plain (non-superseding) requests never cancel work, so a stream of file change notifications
 * cannot starve a slow job on a huge repository.
 */
export class Coalescer<T> {
  private controller: AbortController | null = null;
  private running = false;
  private current: Waiter<T>[] = [];
  private next: Waiter<T>[] | null = null;
  private disposed = false;

  constructor(private readonly job: (signal: AbortSignal) => Promise<T>) {}

  get isRunning(): boolean {
    return this.running;
  }

  request(options: { supersede?: boolean } = {}): Promise<T> {
    if (this.disposed) return Promise.reject(cancelled());
    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter<T> = { resolve, reject };
      if (!this.running) {
        this.current = [waiter];
        void this.loop();
        return;
      }
      if (this.next) this.next.push(waiter);
      else this.next = [waiter];
      if (options.supersede) this.controller?.abort();
    });
  }

  /** Abort the running job and reject everyone waiting. */
  dispose(): void {
    this.disposed = true;
    this.controller?.abort();
    const waiters = [...this.current, ...(this.next ?? [])];
    this.current = [];
    this.next = null;
    for (const waiter of waiters) waiter.reject(cancelled());
  }

  private async loop(): Promise<void> {
    this.running = true;
    try {
      while (this.current.length > 0) {
        const controller = new AbortController();
        this.controller = controller;
        let outcome: { ok: true; value: T } | { ok: false; error: unknown };
        try {
          outcome = { ok: true, value: await this.job(controller.signal) };
        } catch (error) {
          outcome = { ok: false, error };
        }
        this.controller = null;
        if (this.disposed) return;

        if (controller.signal.aborted && this.next) {
          // Superseded: the follow-up answers everyone, including those who waited on this job.
          this.current = [...this.current, ...this.next];
          this.next = null;
          continue;
        }
        const waiters = this.current;
        this.current = this.next ?? [];
        this.next = null;
        for (const waiter of waiters) {
          if (outcome.ok) waiter.resolve(outcome.value);
          else waiter.reject(outcome.error);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

function cancelled(): IncError {
  return new IncError('E_CANCELLED', 'The Git operation was cancelled.');
}
