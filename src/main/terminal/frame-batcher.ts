/**
 * Coalesces small chunks of shell output into one message per animation frame.
 *
 * A busy program can produce thousands of tiny writes per second. Sending each one over IPC
 * would saturate the channel, so output is collected for about one frame (16 ms) and sent as a
 * single string. A large backlog is sent immediately rather than waiting for the timer.
 */

export const FRAME_MS = 16;
/** Flush at once when this many characters are waiting. */
export const MAX_FRAME_CHARS = 65_536;

export class FrameBatcher {
  private chunks: string[] = [];
  private size = 0;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private readonly emit: (data: string) => void,
    private readonly frameMs = FRAME_MS,
    private readonly maxChars = MAX_FRAME_CHARS,
  ) {}

  push(data: string): void {
    if (this.closed || data.length === 0) return;
    this.chunks.push(data);
    this.size += data.length;
    if (this.size >= this.maxChars) {
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.frameMs);
    }
  }

  /** Send everything that is waiting. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.size === 0) return;
    const data = this.chunks.length === 1 ? this.chunks[0]! : this.chunks.join('');
    this.chunks = [];
    this.size = 0;
    this.emit(data);
  }

  /** Discard anything waiting and ignore further input. */
  dispose(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.chunks = [];
    this.size = 0;
  }
}
