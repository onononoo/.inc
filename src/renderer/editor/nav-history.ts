/** One place the person was in: a file and a position. */
export interface NavLocation {
  path: string;
  line: number;
  column: number;
}

const MAX_ENTRIES = 100;
/** A cursor jump shorter than this many lines is not worth a history entry. */
export const MIN_JUMP_LINES = 10;

/**
 * Back and forward navigation across files and large cursor jumps. Pure and synchronous: the
 * editor reports where the person is, and `back` and `forward` return where to go.
 */
export class NavigationHistory {
  private entries: NavLocation[] = [];
  private index = -1;

  /** Record a location. Nearby positions in the same file replace the current entry. */
  record(location: NavLocation): void {
    const current = this.entries[this.index];
    if (current && current.path === location.path) {
      if (Math.abs(current.line - location.line) < MIN_JUMP_LINES) {
        this.entries[this.index] = location;
        return;
      }
    }
    this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push(location);
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
    this.index = this.entries.length - 1;
  }

  canGoBack(): boolean {
    return this.index > 0;
  }

  canGoForward(): boolean {
    return this.index < this.entries.length - 1;
  }

  /** The location before the current one, or undefined at the start. */
  back(): NavLocation | undefined {
    if (!this.canGoBack()) return undefined;
    this.index--;
    return this.entries[this.index];
  }

  forward(): NavLocation | undefined {
    if (!this.canGoForward()) return undefined;
    this.index++;
    return this.entries[this.index];
  }

  /** Forget locations in a file that is gone (closed and deleted). */
  forget(path: string): void {
    const keep: NavLocation[] = [];
    let newIndex = -1;
    this.entries.forEach((entry, i) => {
      if (entry.path === path) return;
      keep.push(entry);
      if (i <= this.index) newIndex = keep.length - 1;
    });
    this.entries = keep;
    this.index = Math.min(newIndex, keep.length - 1);
  }

  /** A file moved: its history entries follow it. */
  rename(from: string, to: string): void {
    this.entries = this.entries.map((e) => (e.path === from ? { ...e, path: to } : e));
  }

  size(): number {
    return this.entries.length;
  }
}
