import path from 'node:path';
import type { KeybindingsSnapshot } from '@shared/api/settings';
import { Emitter, type Logger, type Unsubscribe } from '../kernel';
import { ConfigFile } from './config-file';
import { createIfMissing, resolveWriteTarget } from './fs-util';
import { KEYBINDINGS_TEMPLATE } from './templates';
import { parseKeybindings, type ParsedKeybindings } from './keybindings';
import { watchFile, type FileWatcher } from './watcher';

export const KEYBINDINGS_FILE_NAME = 'keybindings.json';

export interface KeybindingsServiceOptions {
  userDataDir: string;
  logger: Logger;
  watch?: boolean;
  debounceMs?: number;
}

/** Owns userData/keybindings.json: loads it, validates it and reports live changes. */
export class KeybindingsService {
  private readonly config: ConfigFile<ParsedKeybindings>;
  private readonly emitter = new Emitter<KeybindingsSnapshot>();
  private watcher: FileWatcher | null = null;
  private signature: string;

  constructor(private readonly options: KeybindingsServiceOptions) {
    const file = path.join(options.userDataDir, KEYBINDINGS_FILE_NAME);
    this.config = new ConfigFile(file, parseKeybindings);
    this.config.load();
    this.signature = JSON.stringify(this.snapshot());
    for (const issue of this.snapshot().issues) {
      options.logger.warn(`Keybindings: ${issue.message}`);
    }
    if (options.watch !== false) {
      this.watcher = watchFile(file, () => this.reload(), {
        debounceMs: options.debounceMs,
        logger: options.logger,
      });
    }
  }

  get file(): string {
    return this.config.file;
  }

  snapshot(): KeybindingsSnapshot {
    const { entries, issues } = this.config.value;
    return { entries, issues, file: this.config.file };
  }

  onDidChange(cb: (snapshot: KeybindingsSnapshot) => void): Unsubscribe {
    return this.emitter.on(cb);
  }

  /** Re-read the file. Returns whether the shortcuts or issues changed. */
  reload(): boolean {
    this.config.load();
    const snapshot = this.snapshot();
    const signature = JSON.stringify(snapshot);
    if (signature === this.signature) return false;
    this.signature = signature;
    for (const issue of snapshot.issues) this.options.logger.warn(`Keybindings: ${issue.message}`);
    this.emitter.emit(snapshot);
    return true;
  }

  /** Create the file with a short explanation when it is missing; returns its path. */
  async ensureFile(): Promise<string> {
    const target = resolveWriteTarget(this.config.file);
    await createIfMissing(target, KEYBINDINGS_TEMPLATE);
    this.reload();
    return this.config.file;
  }

  dispose(): void {
    this.watcher?.dispose();
    this.watcher = null;
  }
}
