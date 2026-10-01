/**
 * Safe-close handshake for one window.
 *
 * Closing a window never discards unsaved work on its own. The window's `close` event is
 * cancelled and the renderer is asked (`window:beforeClose`); when it has checked for unsaved
 * changes it answers with `window:confirmClose` and the close goes through. Not answering means
 * the user chose to keep the window open.
 *
 * The one exception is a renderer that cannot answer: if it has crashed or hangs for the whole
 * escape period after a close request, the window is closed anyway so that a broken page can
 * never trap the user (or block quitting the app).
 */

export interface CloseTarget {
  /** The renderer has loaded far enough to listen for `window:beforeClose`. */
  isReady(): boolean;
  /** The renderer process exists (it has not crashed and the page is not destroyed). */
  isAlive(): boolean;
  /** The renderer is answering the browser process. */
  isResponsive(): boolean;
  /** Send `window:beforeClose`. */
  askRenderer(): void;
  /** Close the window for real. The coordinator lets the resulting `close` event through. */
  closeNow(): void;
}

export interface Scheduler {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const CLOSE_ESCAPE_MS = 10_000;

const realScheduler: Scheduler = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class CloseCoordinator {
  private allowed = false;
  private timer: unknown = null;

  constructor(
    private readonly target: CloseTarget,
    private readonly scheduler: Scheduler = realScheduler,
    private readonly escapeMs: number = CLOSE_ESCAPE_MS,
  ) {}

  /**
   * Call from the window's `close` event. Returns true when the close may proceed; otherwise the
   * caller must `preventDefault()` and the renderer has been asked to confirm.
   */
  onCloseEvent(): boolean {
    if (this.allowed) return true;
    if (!this.target.isReady() || !this.target.isAlive()) {
      this.allowed = true;
      return true;
    }
    this.target.askRenderer();
    this.armEscape();
    return false;
  }

  /** The renderer answered `window:confirmClose`. */
  confirm(): void {
    this.disarm();
    this.allowed = true;
    this.target.closeNow();
  }

  /** The renderer is gone for good (the window was destroyed). */
  dispose(): void {
    this.disarm();
  }

  private armEscape(): void {
    if (this.timer !== null) return;
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = null;
      if (!this.target.isAlive() || !this.target.isResponsive()) {
        this.allowed = true;
        this.target.closeNow();
      }
    }, this.escapeMs);
  }

  private disarm(): void {
    if (this.timer !== null) {
      this.scheduler.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
