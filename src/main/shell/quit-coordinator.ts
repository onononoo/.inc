/**
 * Quitting the app closes every window through the same safe-close handshake, one window at a
 * time so the user answers one "save changes?" prompt at a time.
 *
 * Quit is abandoned as soon as the user closes a window themselves: that means they looked at a
 * prompt, decided to keep working, and later closed something unrelated.
 */

export interface QuitHost {
  windowIds(): number[];
  /** Ask a window to close (runs the handshake). */
  requestClose(windowId: number): void;
  /** Quit for real; the host must not intercept the resulting `before-quit`. */
  quitNow(): void;
}

export class QuitCoordinator {
  private pending = false;

  constructor(private readonly host: QuitHost) {}

  get isPending(): boolean {
    return this.pending;
  }

  /** The user (or the OS) asked to quit. Safe to call repeatedly: it restarts the sequence. */
  begin(): void {
    this.pending = true;
    this.closeNext();
  }

  /** A window finished closing. */
  onWindowClosed(): void {
    if (this.pending) this.closeNext();
  }

  /** The user closed a window on their own while a quit was waiting on a prompt. */
  onUserInitiatedClose(): void {
    this.pending = false;
  }

  /** The renderer crashed or the user abandoned the prompt some other way. */
  cancel(): void {
    this.pending = false;
  }

  private closeNext(): void {
    const next = this.host.windowIds()[0];
    if (next === undefined) {
      this.pending = false;
      this.host.quitNow();
      return;
    }
    this.host.requestClose(next);
  }
}
