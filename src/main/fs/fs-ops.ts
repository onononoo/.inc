import { constants, type BigIntStats } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FileStat } from '@shared/api/fs';
import { IncError } from '@shared/errors';
import { isWithin, samePath, type Platform } from '@shared/paths';
import { errnoOf, fsError, isFilesystemRoot } from './errors';
import { statPath } from './stat';
import { renameWithRetry } from './util';

const platform = process.platform as Platform;

function nameOf(target: string): string {
  return path.basename(target) || target;
}

async function lstatIfExists(target: string): Promise<BigIntStats | null> {
  try {
    return await fsp.lstat(target, { bigint: true });
  } catch (error) {
    const code = errnoOf(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

function sameFileSystemObject(a: BigIntStats, b: BigIntStats): boolean {
  return a.ino !== 0n && a.ino === b.ino && a.dev === b.dev;
}

async function requireParentFolder(target: string, action: string): Promise<void> {
  const parent = path.dirname(target);
  let info: BigIntStats | null;
  try {
    info = await lstatIfExists(parent);
    if (info?.isSymbolicLink()) info = await fsp.stat(parent, { bigint: true });
  } catch (error) {
    throw fsError(error, action, target);
  }
  if (!info) {
    throw new IncError(
      'E_NOT_FOUND',
      `Could not ${action} "${nameOf(target)}": the destination folder does not exist.`,
      { path: target },
    );
  }
  if (!info.isDirectory()) {
    throw new IncError(
      'E_NOT_DIRECTORY',
      `Could not ${action} "${nameOf(target)}": the destination is not a folder.`,
      { path: target },
    );
  }
}

/** The path with symbolic links resolved in every existing part, so that aliases compare equal. */
async function canonical(target: string): Promise<string> {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    try {
      const real = await fsp.realpath(current);
      return missing.length ? path.join(real, ...missing.reverse()) : real;
    } catch (error) {
      const code = errnoOf(error);
      const parent = path.dirname(current);
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || parent === current) return target;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

async function assertNotInside(from: string, to: string, action: string): Promise<void> {
  const [realFrom, realTo] = await Promise.all([canonical(from), canonical(to)]);
  if (isWithin(from, to, platform) || isWithin(realFrom, realTo, platform)) {
    throw new IncError(
      'E_INVALID',
      `Could not ${action} "${nameOf(from)}": a folder cannot be placed inside itself.`,
      { from, to },
    );
  }
}

// --- create ---------------------------------------------------------------------------------

/** Create an empty file; fails with E_EXISTS when anything is already there. Creates missing parent folders. */
export async function createEmptyFile(file: string): Promise<FileStat> {
  const create = async () => {
    const handle = await fsp.open(file, 'wx', 0o666);
    await handle.close();
  };
  try {
    await create();
  } catch (error) {
    if (errnoOf(error) !== 'ENOENT') throw fsError(error, 'create', file);
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await create();
    } catch (retry) {
      throw fsError(retry, 'create', file);
    }
  }
  return statPath(file);
}

/** Create a folder (and any missing parents); fails with E_EXISTS when the folder itself exists. */
export async function createFolder(folder: string): Promise<FileStat> {
  try {
    await fsp.mkdir(folder);
  } catch (error) {
    if (errnoOf(error) !== 'ENOENT') throw fsError(error, 'create', folder);
    try {
      await fsp.mkdir(path.dirname(folder), { recursive: true });
      await fsp.mkdir(folder);
    } catch (retry) {
      throw fsError(retry, 'create', folder);
    }
  }
  return statPath(folder);
}

// --- copy -----------------------------------------------------------------------------------

/** Copy a file or a folder (recursively). Existing destinations need `overwrite`; folders merge. */
export async function copyPath(
  from: string,
  to: string,
  options: { overwrite?: boolean } = {},
): Promise<void> {
  const overwrite = options.overwrite === true;
  let source: BigIntStats;
  try {
    source = await fsp.stat(from, { bigint: true });
  } catch (error) {
    throw fsError(error, 'copy', from);
  }
  if (!source.isFile() && !source.isDirectory()) {
    throw new IncError('E_INVALID', `Could not copy "${nameOf(from)}": it is not a file or folder.`, {
      path: from,
    });
  }
  await requireParentFolder(to, 'copy');
  let dest: BigIntStats | null;
  try {
    dest = await lstatIfExists(to);
  } catch (error) {
    throw fsError(error, 'copy', to);
  }
  if (dest) {
    if (sameFileSystemObject(source, dest)) {
      throw new IncError('E_INVALID', `Could not copy "${nameOf(from)}" onto itself.`, { from, to });
    }
    if (!overwrite) {
      throw new IncError('E_EXISTS', `Could not copy "${nameOf(from)}": "${nameOf(to)}" already exists.`, {
        path: to,
      });
    }
    if (source.isDirectory() !== dest.isDirectory()) {
      throw new IncError(
        'E_EXISTS',
        `Could not copy "${nameOf(from)}": "${nameOf(to)}" is a ${dest.isDirectory() ? 'folder' : 'file'}.`,
        { path: to },
      );
    }
  }
  if (source.isDirectory()) await assertNotInside(from, to, 'copy');

  try {
    if (source.isDirectory()) {
      await fsp.cp(from, to, {
        recursive: true,
        force: overwrite,
        errorOnExist: !overwrite,
        verbatimSymlinks: true,
      });
    } else {
      await fsp.copyFile(from, to, overwrite ? 0 : constants.COPYFILE_EXCL);
    }
  } catch (error) {
    throw fsError(error, 'copy', from);
  }
}

// --- rename / move --------------------------------------------------------------------------

/**
 * Rename or move a file or folder. A destination that already exists is only replaced with
 * `overwrite`, and only when both sides are files: a folder is never replaced or merged by a move.
 * Case-only renames work on case-insensitive file systems. Moves across drives fall back to
 * copy and remove.
 */
export async function movePath(
  from: string,
  to: string,
  options: { overwrite?: boolean } = {},
): Promise<void> {
  const overwrite = options.overwrite === true;
  let source: BigIntStats;
  try {
    source = await fsp.lstat(from, { bigint: true });
  } catch (error) {
    throw fsError(error, 'move', from);
  }
  if (path.resolve(from) === path.resolve(to)) return;

  if (source.isDirectory()) await assertNotInside(from, to, 'move');
  await requireParentFolder(to, 'move');

  let dest: BigIntStats | null;
  try {
    dest = await lstatIfExists(to);
  } catch (error) {
    throw fsError(error, 'move', to);
  }
  if (dest && !sameFileSystemObject(source, dest)) {
    if (!overwrite) {
      throw new IncError('E_EXISTS', `Could not move "${nameOf(from)}": "${nameOf(to)}" already exists.`, {
        path: to,
      });
    }
    if (dest.isDirectory() || source.isDirectory()) {
      throw new IncError(
        'E_EXISTS',
        `Could not move "${nameOf(from)}": "${nameOf(to)}" is a folder and cannot be replaced.`,
        { path: to },
      );
    }
  }

  try {
    await renameWithRetry(from, to);
  } catch (error) {
    if (errnoOf(error) !== 'EXDEV') throw fsError(error, 'move', from);
    await copyPath(from, to, { overwrite });
    try {
      await fsp.rm(from, { recursive: true, force: false });
    } catch (removal) {
      throw fsError(removal, 'remove the original of', from);
    }
  }
}

// --- trash ----------------------------------------------------------------------------------

export interface TrashDeps {
  trashItem(target: string): Promise<void>;
  /** Folders that must never be trashed (the open workspace). */
  protectedPaths?: readonly string[];
}

/**
 * Move items to the operating system trash. Nothing is ever deleted permanently: when the trash is
 * not available for a location the item is left untouched and an error says so. Every item is
 * attempted; failures are reported together.
 */
export async function trashPaths(targets: readonly string[], deps: TrashDeps): Promise<void> {
  const guarded = deps.protectedPaths ?? [];
  const failures: IncError[] = [];
  for (const target of targets) {
    try {
      await trashOne(target, guarded, deps);
    } catch (error) {
      failures.push(error instanceof IncError ? error : fsError(error, 'move to the trash', target));
    }
  }
  const [first] = failures;
  if (!first) return;
  if (failures.length === 1) throw first;
  throw new IncError('E_IO', `${first.message} (${failures.length - 1} more failed.)`, {
    failures: failures.map((f) => f.toJSON()),
  });
}

async function trashOne(target: string, guarded: readonly string[], deps: TrashDeps): Promise<void> {
  if (isFilesystemRoot(target)) {
    throw new IncError('E_INVALID', 'A drive or file system root cannot be moved to the trash.');
  }
  if (guarded.some((p) => samePath(p, target, platform))) {
    throw new IncError(
      'E_INVALID',
      `"${nameOf(target)}" is the open workspace folder. Close the folder before moving it to the trash.`,
    );
  }
  try {
    await fsp.lstat(target);
  } catch (error) {
    throw fsError(error, 'move to the trash', target);
  }
  try {
    await deps.trashItem(path.normalize(target));
  } catch (error) {
    throw new IncError(
      'E_IO',
      `Could not move "${nameOf(target)}" to the trash. This location may not support it. Nothing was deleted.`,
      { path: target, cause: error instanceof Error ? error.message : String(error) },
    );
  }
}
