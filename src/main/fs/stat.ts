import { constants } from 'node:fs';
import fsp from 'node:fs/promises';
import type { FileStat } from '@shared/api/fs';
import { errnoOf, fsError } from './errors';

/** Metadata of `target`, following symbolic links; a dangling link reports kind "other". */
export async function statPath(target: string): Promise<FileStat> {
  let link;
  try {
    link = await fsp.lstat(target);
  } catch (error) {
    throw fsError(error, 'read information about', target);
  }
  const isSymlink = link.isSymbolicLink();
  let info = link;
  if (isSymlink) {
    try {
      info = await fsp.stat(target);
    } catch (error) {
      const code = errnoOf(error);
      if (code === 'ENOENT' || code === 'ELOOP') {
        return {
          path: target,
          kind: 'other',
          isSymlink,
          size: 0,
          mtimeMs: link.mtimeMs,
          birthtimeMs: link.birthtimeMs,
          readonly: false,
        };
      }
      throw fsError(error, 'read information about', target);
    }
  }
  const kind = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other';
  let readonly = false;
  if (kind === 'file') {
    try {
      await fsp.access(target, constants.W_OK);
    } catch {
      readonly = true;
    }
  }
  return {
    path: target,
    kind,
    isSymlink,
    size: kind === 'file' ? info.size : 0,
    mtimeMs: info.mtimeMs,
    birthtimeMs: info.birthtimeMs,
    readonly,
  };
}

/** True when something (including a dangling link) exists at `target`. */
export async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.lstat(target);
    return true;
  } catch (error) {
    const code = errnoOf(error);
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EINVAL' || code === 'ENAMETOOLONG') {
      return false;
    }
    if (code === 'EACCES' || code === 'EPERM') return true;
    throw fsError(error, 'check', target);
  }
}
