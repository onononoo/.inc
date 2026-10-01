import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../kernel';

/** Files inside the Git directory whose changes alter what `git status` reports. */
const STATE_FILES = new Set([
  'HEAD',
  'index',
  'packed-refs',
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'REBASE_HEAD',
  'BISECT_LOG',
]);

export function isStateFile(fileName: string | null): boolean {
  if (fileName === null || fileName === '') return true; // the platform did not say: assume relevant
  const first = fileName.split(/[\\/]/)[0] ?? '';
  return STATE_FILES.has(first) || first === 'rebase-merge' || first === 'rebase-apply';
}

/**
 * Watches the parts of a repository's Git directory that signal a commit, checkout, stage,
 * branch change or merge state, so changes made outside the editor (in a terminal, by another
 * tool) show up without watching every object file.
 *
 * With linked worktrees the per-worktree files (HEAD, index) live in `gitDir` and the shared
 * references in `commonDir`.
 */
export class GitDirWatcher {
  private readonly watchers: fs.FSWatcher[] = [];
  private closed = false;

  constructor(
    private readonly gitDir: string,
    private readonly commonDir: string,
    private readonly onChange: () => void,
    private readonly logger: Logger,
  ) {
    this.watch(gitDir, false, (name) => isStateFile(name));
    this.watch(path.join(commonDir, 'refs'), true, () => true);
    if (path.resolve(commonDir) !== path.resolve(gitDir)) {
      this.watch(commonDir, false, (name) => name === 'packed-refs');
    }
  }

  /** The Git directory this watcher was created for. */
  get directory(): string {
    return this.gitDir;
  }

  private watch(target: string, recursive: boolean, relevant: (name: string | null) => boolean) {
    try {
      const watcher = fs.watch(target, { recursive, persistent: false }, (_event, name) => {
        if (this.closed) return;
        const fileName = typeof name === 'string' ? name : null;
        if (relevant(fileName)) this.onChange();
      });
      watcher.on('error', (error) => {
        this.logger.warn(`Git watcher stopped for ${target}: ${error.message}`);
        watcher.close();
      });
      this.watchers.push(watcher);
    } catch (error) {
      this.logger.warn(`Git watcher could not start for ${target}: ${(error as Error).message}`);
    }
  }

  close(): void {
    this.closed = true;
    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch {
        /* already closed */
      }
    }
    this.watchers.length = 0;
  }
}
