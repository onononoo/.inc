/**
 * Persists window bounds and the last theme colours in userData/window-state.json.
 *
 * Reads are synchronous (needed to place the first window before it is created); writes are
 * debounced and atomic (temporary file, then rename) so a crash never leaves a torn file.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Kernel, Logger } from '../kernel';
import {
  EMPTY_SHELL_STATE,
  parsePersistedState,
  type PersistedShellState,
  type SavedTheme,
  type SavedWindowState,
} from './window-state';

const FILE_NAME = 'window-state.json';
const SAVE_DELAY_MS = 400;

export class ShellStateStore {
  private state: PersistedShellState;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly file: string,
    private readonly logger: Logger,
  ) {
    this.state = this.read();
  }

  get(): PersistedShellState {
    return this.state;
  }

  setWindow(window: SavedWindowState): void {
    this.state = { ...this.state, window };
    this.schedule();
  }

  setTheme(theme: SavedTheme): void {
    const current = this.state.theme;
    if (
      current &&
      current.scheme === theme.scheme &&
      current.background === theme.background &&
      current.foreground === theme.foreground
    ) {
      return;
    }
    this.state = { ...this.state, theme };
    this.schedule();
  }

  /** Write any pending change now. Called when a window closes and when the app quits. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.write();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.write();
    }, SAVE_DELAY_MS);
    this.timer.unref?.();
  }

  private read(): PersistedShellState {
    try {
      return parsePersistedState(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn('Could not read the window state file; using defaults', e);
      }
      return { ...EMPTY_SHELL_STATE };
    }
  }

  private write(): void {
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2) + '\n');
      fs.renameSync(temporary, this.file);
      this.lastError = null;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message !== this.lastError) {
        this.lastError = message;
        this.logger.warn('Could not save the window state', e);
      }
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        /* nothing more to clean up */
      }
    }
  }
}

let instance: ShellStateStore | null = null;

/** The one store for this run, created on first use from the kernel's user data directory. */
export function getShellStateStore(kernel: Pick<Kernel, 'info' | 'logger'>): ShellStateStore {
  instance ??= new ShellStateStore(path.join(kernel.info.userDataDir, FILE_NAME), kernel.logger);
  return instance;
}
