/**
 * Flow control between a shell and the renderer.
 *
 * The main process counts the characters it has sent to the renderer and the renderer reports how
 * many it has finished processing (`terminal:ack`). When the difference grows past the high
 * watermark the shell's output is paused so a runaway program (`yes`, a huge `cat`) cannot flood
 * the IPC channel or the renderer; it resumes once the renderer has caught up to the low watermark.
 */

/** Pause output when this many characters are unacknowledged. */
export const HIGH_WATERMARK = 100_000;
/** Resume output when the unacknowledged count falls to this value or lower. */
export const LOW_WATERMARK = 5_000;

export type FlowAction = 'pause' | 'resume' | null;

export class FlowControl {
  private pending = 0;
  private isPaused = false;

  constructor(
    private readonly high = HIGH_WATERMARK,
    private readonly low = LOW_WATERMARK,
  ) {
    if (!(low >= 0 && high > low)) throw new RangeError('Invalid watermarks');
  }

  get unacknowledged(): number {
    return this.pending;
  }

  get paused(): boolean {
    return this.isPaused;
  }

  /** Record characters sent to the renderer. Returns 'pause' when output must be paused now. */
  sent(chars: number): FlowAction {
    this.pending += Math.max(0, Math.floor(chars));
    if (!this.isPaused && this.pending > this.high) {
      this.isPaused = true;
      return 'pause';
    }
    return null;
  }

  /** Record characters the renderer has processed. Returns 'resume' when output may continue. */
  acknowledge(chars: number): FlowAction {
    this.pending = Math.max(0, this.pending - Math.max(0, Math.floor(chars)));
    if (this.isPaused && this.pending <= this.low) {
      this.isPaused = false;
      return 'resume';
    }
    return null;
  }
}
