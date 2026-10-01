/**
 * Watches one file for changes made by any program.
 *
 * The containing directory is watched (not the file) so that atomic-replace saves, which swap the
 * inode, and deletion followed by re-creation keep working. When the directory does not exist yet
 * the nearest existing ancestor is watched until it appears. Events are debounced and filtered to
 * the file's own name, so a busy directory such as the user-data folder does not cause work.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../kernel';

export interface FileWatcher {
  dispose(): void;
}

export interface WatchOptions {
  debounceMs?: number;
  logger?: Pick<Logger, 'debug' | 'warn'>;
}

const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
const same = (a: string, b: string): boolean =>
  caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;

interface Armed {
  dir: string;
  identity: string;
  handle: fs.FSWatcher;
}

function identityOf(dir: string): string | null {
  try {
    const info = fs.statSync(dir, { bigint: true });
    return info.isDirectory() ? `${info.dev}:${info.ino}` : null;
  } catch {
    return null;
  }
}

function nearestExistingDir(dir: string): string | null {
  let current = dir;
  for (;;) {
    if (identityOf(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Call `onChange` (debounced) whenever `file` may have been created, changed or deleted. */
export function watchFile(
  file: string,
  onChange: () => void,
  options: WatchOptions = {},
): FileWatcher {
  const debounceMs = options.debounceMs ?? 75;
  const parentDir = path.dirname(file);
  const name = path.basename(file);
  let armed: Armed | null = null;
  let timer: NodeJS.Timeout | null = null;
  let retry: NodeJS.Timeout | null = null;
  let disposed = false;

  const disarm = (): void => {
    armed?.handle.close();
    armed = null;
  };

  const relevant = (filename: string | Buffer | null): boolean => {
    if (!armed || filename === null) return true;
    const changed = filename.toString();
    if (same(armed.dir, parentDir)) return same(changed, name);
    // Watching an ancestor while the real folder is missing: only its next path segment matters.
    const next = path.relative(armed.dir, file).split(path.sep)[0] ?? '';
    return same(changed, next);
  };

  const arm = (): void => {
    disarm();
    if (disposed) return;
    const dir = nearestExistingDir(parentDir);
    const identity = dir ? identityOf(dir) : null;
    if (!dir || !identity) {
      scheduleRetry();
      return;
    }
    try {
      const handle = fs.watch(dir, { persistent: false }, (_event, filename) => {
        if (relevant(filename)) schedule();
      });
      handle.on('error', (error) => {
        options.logger?.debug(`File watcher error for ${file}: ${String(error)}`);
        schedule();
      });
      armed = { dir, identity, handle };
    } catch (e) {
      options.logger?.warn(`Cannot watch ${dir}: ${String(e)}`);
      scheduleRetry();
    }
  };

  const scheduleRetry = (): void => {
    if (disposed || retry) return;
    retry = setTimeout(() => {
      retry = null;
      arm();
      onChange();
    }, 1000);
    retry.unref();
  };

  /** Re-arm when the directory being watched was replaced, or the real folder appeared. */
  const verify = (): void => {
    if (!armed) return;
    const target = nearestExistingDir(parentDir);
    if (target !== armed.dir || identityOf(armed.dir) !== armed.identity) arm();
  };

  const schedule = (): void => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (disposed) return;
      verify();
      onChange();
    }, debounceMs);
    timer.unref();
  };

  arm();

  return {
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      if (retry) clearTimeout(retry);
      timer = null;
      retry = null;
      disarm();
    },
  };
}
