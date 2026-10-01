import type { Dirent } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FileEntry } from '@shared/api/fs';
import { errnoOf, fsError } from './errors';
import { mapLimit } from './util';

/** Files stat'ed at the same time while listing one folder. */
const STAT_CONCURRENCY = 48;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Natural, case-insensitive name order; identical-looking names fall back to code unit order. */
export function compareEntryNames(a: string, b: string): number {
  const natural = collator.compare(a, b);
  if (natural !== 0) return natural;
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface ReadDirectoryOptions {
  /** Return true to hide an entry. Called once per entry before anything is stat'ed. */
  exclude?: (name: string, isDirectory: boolean) => boolean;
}

/** Errors that mean "this entry vanished while we were looking at it". */
const VANISHED = new Set(['ENOENT', 'ENOTDIR']);

async function describeFile(full: string, name: string): Promise<FileEntry | null> {
  try {
    const info = await fsp.stat(full);
    return {
      name,
      path: full,
      kind: 'file',
      isSymlink: false,
      size: info.size,
      mtimeMs: info.mtimeMs,
    };
  } catch (error) {
    const code = errnoOf(error);
    if (code && VANISHED.has(code)) return null;
    // Unreadable metadata (for example a permission problem): still list the file.
    return { name, path: full, kind: 'file', isSymlink: false, size: 0, mtimeMs: 0 };
  }
}

async function describeSymlink(full: string, name: string): Promise<FileEntry | null> {
  try {
    const info = await fsp.stat(full);
    if (info.isDirectory()) {
      return { name, path: full, kind: 'directory', isSymlink: true, size: 0, mtimeMs: 0 };
    }
    if (info.isFile()) {
      return {
        name,
        path: full,
        kind: 'file',
        isSymlink: true,
        size: info.size,
        mtimeMs: info.mtimeMs,
      };
    }
    return null; // a link to a socket, pipe or device cannot be opened in an editor
  } catch (error) {
    const code = errnoOf(error);
    if (code === 'ELOOP' || code === 'ENOENT') {
      // A dangling or circular link: show the link itself so it can be renamed or deleted.
      try {
        const link = await fsp.lstat(full);
        return { name, path: full, kind: 'file', isSymlink: true, size: 0, mtimeMs: link.mtimeMs };
      } catch {
        return null;
      }
    }
    if (code && VANISHED.has(code)) return null;
    return { name, path: full, kind: 'file', isSymlink: true, size: 0, mtimeMs: 0 };
  }
}

/**
 * List one folder: folders first, then files, each in natural name order. Symbolic links report
 * the kind of their target. Folders are not stat'ed (only files, with bounded concurrency), and an
 * entry that disappears while the listing is in progress is left out instead of failing the call.
 */
export async function readDirectory(
  dir: string,
  options: ReadDirectoryOptions = {},
): Promise<FileEntry[]> {
  let dirents: Dirent[];
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    throw fsError(error, 'open the folder', dir);
  }

  const exclude = options.exclude;
  const kept: Dirent[] = [];
  for (const dirent of dirents) {
    if (exclude && exclude(dirent.name, dirent.isDirectory())) continue;
    kept.push(dirent);
  }

  const resolved = await mapLimit(kept, STAT_CONCURRENCY, async (dirent) => {
    const full = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      return {
        name: dirent.name,
        path: full,
        kind: 'directory',
        isSymlink: false,
        size: 0,
        mtimeMs: 0,
      } satisfies FileEntry;
    }
    if (dirent.isFile()) return describeFile(full, dirent.name);
    if (dirent.isSymbolicLink()) return describeSymlink(full, dirent.name);
    return null;
  });

  const entries = resolved.filter((entry): entry is FileEntry => entry !== null);
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return compareEntryNames(a.name, b.name);
  });
  return entries;
}
