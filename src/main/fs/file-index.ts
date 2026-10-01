import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import type { FileSearchItem, FileSearchResult, FsChange } from '@shared/api/fs';
import { fuzzyMatch, isSubsequence } from '@shared/fuzzy';
import { isWithin, type Platform } from '@shared/paths';
import { ExcludeFilter, compileGlobs, enabledPatterns } from './excludes';

/** Upper bound on indexed files, so a runaway tree cannot exhaust memory. */
const MAX_INDEXED = 2_000_000;
const PROGRESS_INTERVAL_MS = 250;
const GIT_TIMEOUT_MS = 120_000;
const WALK_CONCURRENCY = 16;

export interface FileIndexOptions {
  root: string;
  platform: Platform;
  /** Current `files.exclude` setting. Read when the index is (re)built and when files are added. */
  getExcludes: () => Record<string, boolean>;
  /** Path to the git executable, or null to always walk the tree. */
  gitPath: string | null;
  onProgress: (state: { indexing: boolean; count: number }) => void;
}

interface Scored {
  rel: string;
  score: number;
  positions: number[];
}

/**
 * Flat list of every file in a workspace, for quick open. Built once in the background (from
 * `git ls-files` when the workspace is in a repository, otherwise by walking the tree with
 * .gitignore support), patched from watcher batches, and queried with a bounded top-K selection
 * so a million files never need a full sort.
 */
export class FileIndex {
  private readonly files = new Set<string>();
  private cache: string[] | null = null;
  private building = false;
  private disposed = false;
  private generation = 0;
  private lastProgress = 0;
  private filter: ExcludeFilter;

  constructor(private readonly options: FileIndexOptions) {
    this.filter = this.createFilter();
  }

  get root(): string {
    return this.options.root;
  }

  get indexing(): boolean {
    return this.building;
  }

  get size(): number {
    return this.files.size;
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.files.clear();
    this.cache = null;
  }

  /** Rebuild from scratch. Results stay available (and partial) while this runs. */
  async build(): Promise<void> {
    const generation = ++this.generation;
    this.building = true;
    this.filter = this.createFilter();
    this.files.clear();
    this.cache = null;
    this.progress(true);
    try {
      const usedGit = this.options.gitPath ? await this.buildFromGit(generation) : false;
      if (!usedGit && generation === this.generation) {
        this.files.clear();
        this.cache = null;
        await this.buildFromWalk(generation);
      }
    } finally {
      if (generation === this.generation) {
        this.building = false;
        this.progress(true);
      }
    }
  }

  /** Apply a batch of file system changes. */
  async apply(changes: readonly FsChange[]): Promise<void> {
    if (this.disposed) return;
    if (changes.some((c) => c.resync)) {
      if (!this.building) void this.build();
      return;
    }
    for (const change of changes) {
      const rel = this.relative(change.path);
      if (rel === null || rel === '') continue;
      if (change.type === 'delete') {
        this.remove(rel);
      } else if (change.type === 'create') {
        await this.addPath(change.path, rel);
      }
    }
  }

  search(query: string, limit: number): FileSearchResult {
    const base = { indexing: this.building, indexedCount: this.files.size };
    if (query.trim() === '') return { items: [], total: 0, ...base };
    const cap = Math.max(1, Math.min(limit, 500));
    const needle = query.replace(/\s+/g, '');
    const top: Scored[] = [];
    let total = 0;
    for (const rel of this.list()) {
      if (!isSubsequence(needle, rel)) continue;
      const match = fuzzyMatch(needle, rel, { pathMode: true });
      if (!match) continue;
      total++;
      if (top.length === cap) {
        const worst = top[top.length - 1] as Scored;
        if (
          match.score < worst.score ||
          (match.score === worst.score && rel.length >= worst.rel.length)
        ) {
          continue;
        }
      }
      insertSorted(top, { rel, score: match.score, positions: match.positions }, cap);
    }
    const items: FileSearchItem[] = top.map((entry) => ({
      path: path.join(this.options.root, entry.rel),
      relativePath: entry.rel,
      score: entry.score,
      positions: entry.positions,
    }));
    return { items, total, ...base };
  }

  private createFilter(): ExcludeFilter {
    return new ExcludeFilter(compileGlobs(enabledPatterns(this.options.getExcludes())));
  }

  private list(): string[] {
    if (!this.cache) this.cache = [...this.files];
    return this.cache;
  }

  private relative(absolute: string): string | null {
    if (!isWithin(this.options.root, absolute, this.options.platform)) return null;
    return path.relative(this.options.root, absolute).split(path.sep).join('/');
  }

  private remove(rel: string): void {
    if (this.files.delete(rel)) {
      this.cache = null;
      return;
    }
    // A removed folder: drop everything under it.
    const prefix = rel + '/';
    let removed = false;
    for (const file of this.files) {
      if (file.startsWith(prefix)) {
        this.files.delete(file);
        removed = true;
      }
    }
    if (removed) this.cache = null;
  }

  private async addPath(absolute: string, rel: string): Promise<void> {
    if (rel === '.git' || rel.startsWith('.git/')) return;
    let info;
    try {
      info = await fsp.stat(absolute);
    } catch {
      return;
    }
    if (info.isFile()) {
      this.addFile(rel);
    } else if (info.isDirectory() && !this.filter.isDirExcluded(rel)) {
      await this.walk(absolute, rel, [], this.generation);
      this.progress(false);
    }
  }

  private addFile(rel: string): void {
    if (this.files.size >= MAX_INDEXED || this.files.has(rel)) return;
    if (this.filter.isFileExcluded(rel)) return;
    this.files.add(rel);
    this.cache = null;
  }

  private progress(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.lastProgress < PROGRESS_INTERVAL_MS) return;
    this.lastProgress = now;
    this.options.onProgress({ indexing: this.building, count: this.files.size });
  }

  /** Stream `git ls-files`. Returns false when git cannot be used (not a repository, failure). */
  private buildFromGit(generation: number): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(
        this.options.gitPath as string,
        [
          '-c',
          'core.quotepath=false',
          '-c',
          'core.fsmonitor=false',
          'ls-files',
          '-z',
          '--cached',
          '--others',
          '--exclude-standard',
        ],
        {
          cwd: this.options.root,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
          env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
        },
      );
      let carry = '';
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(false);
      }, GIT_TIMEOUT_MS);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (generation !== this.generation) {
          child.kill();
          return;
        }
        const parts = (carry + chunk).split('\0');
        carry = parts.pop() ?? '';
        for (const part of parts) if (part) this.addFile(part);
        this.progress(false);
      });
      child.on('error', () => finish(false));
      child.on('close', (code) => {
        if (generation !== this.generation) return finish(true);
        if (code !== 0) return finish(false);
        if (carry) this.addFile(carry);
        finish(true);
      });
    });
  }

  private async buildFromWalk(generation: number): Promise<void> {
    await this.walk(this.options.root, '', [], generation);
  }

  /** Breadth-first walk with bounded concurrency, honouring nested .gitignore files. */
  private async walk(
    startDir: string,
    startRel: string,
    startIgnores: IgnoreScope[],
    generation: number,
  ): Promise<void> {
    const queue: { dir: string; rel: string; scopes: IgnoreScope[] }[] = [
      { dir: startDir, rel: startRel, scopes: startIgnores },
    ];
    const worker = async () => {
      for (;;) {
        if (generation !== this.generation || this.disposed) return;
        const item = queue.pop();
        if (!item) return;
        await this.walkOne(item, queue);
        this.progress(false);
      }
    };
    // Workers exit when the queue is momentarily empty, so loop until a full pass finds no work.
    do {
      await Promise.all(Array.from({ length: WALK_CONCURRENCY }, worker));
    } while (queue.length > 0 && generation === this.generation && !this.disposed);
  }

  private async walkOne(
    item: { dir: string; rel: string; scopes: IgnoreScope[] },
    queue: { dir: string; rel: string; scopes: IgnoreScope[] }[],
  ): Promise<void> {
    let entries;
    try {
      entries = await fsp.readdir(item.dir, { withFileTypes: true });
    } catch {
      return;
    }
    let scopes = item.scopes;
    if (entries.some((e) => e.name === '.gitignore' && e.isFile())) {
      try {
        const text = await fsp.readFile(path.join(item.dir, '.gitignore'), 'utf8');
        scopes = [...scopes, { base: item.rel, matcher: ignore().add(text) }];
      } catch {
        /* an unreadable ignore file is treated as absent */
      }
    }
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const rel = item.rel ? `${item.rel}/${entry.name}` : entry.name;
      const isDir = entry.isDirectory();
      if (!isDir && !entry.isFile() && !entry.isSymbolicLink()) continue;
      if (isDir ? this.filter.isDirExcluded(rel) : this.filter.isFileExcluded(rel)) continue;
      if (isIgnored(scopes, rel, isDir)) continue;
      if (isDir) {
        queue.push({ dir: path.join(item.dir, entry.name), rel, scopes });
      } else if (entry.isFile() || (await isFileLink(path.join(item.dir, entry.name)))) {
        this.addFile(rel);
      }
    }
  }
}

interface IgnoreScope {
  base: string;
  matcher: Ignore;
}

function isIgnored(scopes: readonly IgnoreScope[], rel: string, isDir: boolean): boolean {
  for (const scope of scopes) {
    const local = scope.base ? rel.slice(scope.base.length + 1) : rel;
    if (scope.matcher.ignores(isDir ? local + '/' : local)) return true;
  }
  return false;
}

async function isFileLink(full: string): Promise<boolean> {
  try {
    return (await fsp.stat(full)).isFile();
  } catch {
    return false;
  }
}

/** Insert into a descending list, keeping at most `cap` entries. Ties favour shorter paths. */
function insertSorted(list: Scored[], entry: Scored, cap: number): void {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const other = list[mid] as Scored;
    const better =
      entry.score > other.score ||
      (entry.score === other.score && entry.rel.length < other.rel.length);
    if (better) hi = mid;
    else lo = mid + 1;
  }
  list.splice(lo, 0, entry);
  if (list.length > cap) list.pop();
}
