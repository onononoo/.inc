import fs from 'node:fs';
import path from 'node:path';
import type { RecentWorkspace } from '@shared/api/workspace';
import { basename, pathKey, type Platform } from '@shared/paths';
import { readJsonFileSync, writeFileAtomicSync } from './atomic-file';

export const MAX_RECENT = 20;
const FORMAT = 1;
/** A slow or disconnected network share must not stall the recent list. */
const STAT_TIMEOUT_MS = 1500;

interface RecentEntry {
  path: string;
  lastOpened: number;
}

interface RecentFile {
  version: number;
  /** Folder that was open when the app last ran, or null when it was closed on purpose. */
  lastOpened: string | null;
  entries: RecentEntry[];
}

export function folderName(folder: string): string {
  return basename(folder) || folder;
}

type Existence = 'exists' | 'missing';

/** Only a definite "not found" counts as missing; slow, denied or odd errors keep the entry. */
async function checkFolder(folder: string): Promise<Existence> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Existence>((resolve) => {
    timer = setTimeout(() => resolve('exists'), STAT_TIMEOUT_MS);
  });
  const probe = fs.promises.stat(folder).then(
    (stat): Existence => (stat.isDirectory() ? 'exists' : 'missing'),
    (e: NodeJS.ErrnoException): Existence =>
      e.code === 'ENOENT' || e.code === 'ENOTDIR' ? 'missing' : 'exists',
  );
  try {
    return await Promise.race([probe, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Recently opened folders (newest first, at most {@link MAX_RECENT}, one entry per path key)
 * plus the folder to restore at the next start, persisted in `recent.json`.
 */
export class RecentStore {
  private readonly file: string;
  private entries: RecentEntry[] = [];
  private lastOpened: string | null = null;

  constructor(
    userDataDir: string,
    private readonly platform: Platform,
    private readonly warn: (message: string) => void,
  ) {
    this.file = path.join(userDataDir, 'recent.json');
    this.load();
  }

  getLastOpened(): string | null {
    return this.lastOpened;
  }

  /** Move (or insert) the folder to the top and remember it as the folder to restore. */
  add(folder: string, now = Date.now()): void {
    const key = pathKey(folder, this.platform);
    const rest = this.entries.filter((e) => pathKey(e.path, this.platform) !== key);
    this.commit([{ path: folder, lastOpened: now }, ...rest].slice(0, MAX_RECENT), folder);
  }

  remove(folder: string): void {
    const key = pathKey(folder, this.platform);
    const entries = this.entries.filter((e) => pathKey(e.path, this.platform) !== key);
    const last =
      this.lastOpened !== null && pathKey(this.lastOpened, this.platform) === key
        ? null
        : this.lastOpened;
    this.commit(entries, last);
  }

  clear(): void {
    this.commit([], null);
  }

  /** Forget the restore-at-start folder without touching the list (folder closed on purpose). */
  clearLastOpened(ifEquals?: string): void {
    if (this.lastOpened === null) return;
    if (
      ifEquals !== undefined &&
      pathKey(ifEquals, this.platform) !== pathKey(this.lastOpened, this.platform)
    ) {
      return;
    }
    this.commit(this.entries, null);
  }

  /** The list, with folders that no longer exist dropped (and the drop persisted). */
  async list(): Promise<RecentWorkspace[]> {
    const snapshot = this.entries;
    const states = await Promise.all(snapshot.map((e) => checkFolder(e.path)));
    const missing = new Set(
      snapshot.filter((_, i) => states[i] === 'missing').map((e) => pathKey(e.path, this.platform)),
    );
    if (missing.size > 0) {
      // Entries added or removed while we were checking are kept as they are now.
      const entries = this.entries.filter((e) => !missing.has(pathKey(e.path, this.platform)));
      const last =
        this.lastOpened !== null && missing.has(pathKey(this.lastOpened, this.platform))
          ? null
          : this.lastOpened;
      this.commit(entries, last);
    }
    return this.entries.map((e) => ({
      path: e.path,
      name: folderName(e.path),
      lastOpened: e.lastOpened,
    }));
  }

  private commit(entries: RecentEntry[], lastOpened: string | null): void {
    const body: RecentFile = { version: FORMAT, lastOpened, entries };
    writeFileAtomicSync(this.file, JSON.stringify(body, null, 2) + '\n');
    this.entries = entries;
    this.lastOpened = lastOpened;
  }

  private load(): void {
    const raw = readJsonFileSync(this.file, this.warn);
    if (!raw || typeof raw !== 'object') return;
    const file = raw as Partial<RecentFile>;
    if (file.version !== FORMAT || !Array.isArray(file.entries)) {
      this.warn('recent.json has an unsupported format and was ignored');
      return;
    }
    const seen = new Set<string>();
    const entries: RecentEntry[] = [];
    for (const item of file.entries) {
      if (!item || typeof item !== 'object') continue;
      const { path: folder, lastOpened } = item as Partial<RecentEntry>;
      if (typeof folder !== 'string' || !path.isAbsolute(folder)) continue;
      const key = pathKey(folder, this.platform);
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ path: folder, lastOpened: Number.isFinite(lastOpened) ? lastOpened! : 0 });
    }
    entries.sort((a, b) => b.lastOpened - a.lastOpened);
    this.entries = entries.slice(0, MAX_RECENT);
    if (typeof file.lastOpened === 'string' && path.isAbsolute(file.lastOpened)) {
      this.lastOpened = file.lastOpened;
    }
  }
}
