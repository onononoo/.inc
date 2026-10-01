/**
 * Decides when a freshly started shell is ready to receive typed input.
 *
 * A shell has no reliable "ready" signal, so this uses output: the shell is considered ready once
 * it has printed something (its banner or prompt) and then been quiet for `quietMs`. If it prints
 * nothing at all, or never settles, it is treated as ready after `maxWaitMs`. Input written a
 * little early is still safe because the pseudo-terminal queues it.
 */

export const READY_QUIET_MS = 250;
export const READY_MAX_WAIT_MS = 5_000;

export class ReadyDetector {
  private quietTimer: NodeJS.Timeout | null = null;
  private deadline: NodeJS.Timeout | null;
  private done = false;

  constructor(
    private readonly onReady: () => void,
    private readonly quietMs = READY_QUIET_MS,
    maxWaitMs = READY_MAX_WAIT_MS,
  ) {
    this.deadline = setTimeout(() => this.fire(), maxWaitMs);
  }

  /** Call whenever the shell produces output. */
  activity(): void {
    if (this.done) return;
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => this.fire(), this.quietMs);
  }

  /** Stop without firing (the shell exited or the terminal was closed). */
  cancel(): void {
    this.done = true;
    this.clear();
  }

  private fire(): void {
    if (this.done) return;
    this.done = true;
    this.clear();
    this.onReady();
  }

  private clear(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer);
    if (this.deadline) clearTimeout(this.deadline);
    this.quietTimer = null;
    this.deadline = null;
  }
}
