export interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface SchedulerOptions {
  /** Called when a burst of triggers has settled. */
  run: () => void;
  /** Debounce delay when Git is fast. */
  baseDelayMs?: number;
  /** Longest debounce delay after backing off. */
  maxDelayMs?: number;
  /** A status slower than this doubles the delay. */
  slowThresholdMs?: number;
  timers?: Timers;
}

export const DEFAULT_BASE_DELAY_MS = 300;
export const DEFAULT_MAX_DELAY_MS = 30_000;
export const DEFAULT_SLOW_THRESHOLD_MS = 3000;

/**
 * Debounces refresh requests and adapts to repository size.
 *
 * Triggers inside the delay window collapse into one run. A run that is not preceded by a quiet
 * period still happens within five delays, so continuous file activity cannot postpone a refresh
 * forever. When a status takes longer than the slow threshold the delay doubles (up to the
 * maximum), and when it is comfortably fast again it halves back toward the base, so huge
 * repositories stay responsive and small ones stay prompt.
 */
export class RefreshScheduler {
  private readonly base: number;
  private readonly max: number;
  private readonly slow: number;
  private readonly timers: Timers;
  private delay: number;
  private handle: unknown = null;
  private firstTriggerAt = 0;
  private disposed = false;

  constructor(private readonly options: SchedulerOptions) {
    this.base = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.max = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.slow = options.slowThresholdMs ?? DEFAULT_SLOW_THRESHOLD_MS;
    this.timers = options.timers ?? realTimers;
    this.delay = this.base;
  }

  /** Current debounce delay in milliseconds. */
  get delayMs(): number {
    return this.delay;
  }

  get pending(): boolean {
    return this.handle !== null;
  }

  trigger(now: number = Date.now()): void {
    if (this.disposed) return;
    if (this.handle === null) this.firstTriggerAt = now;
    else this.timers.clear(this.handle);
    const sinceFirst = now - this.firstTriggerAt;
    const remainingMaxWait = Math.max(0, this.delay * 5 - sinceFirst);
    this.handle = this.timers.set(() => this.fire(), Math.min(this.delay, remainingMaxWait));
  }

  /** Record how long the last status took and adjust the delay. */
  recordDuration(durationMs: number): void {
    if (durationMs > this.slow) {
      this.delay = Math.min(this.max, this.delay * 2);
    } else if (durationMs < this.slow / 2) {
      this.delay = Math.max(this.base, Math.floor(this.delay / 2));
    }
  }

  cancel(): void {
    if (this.handle !== null) this.timers.clear(this.handle);
    this.handle = null;
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  private fire(): void {
    this.handle = null;
    if (this.disposed) return;
    this.options.run();
  }
}
