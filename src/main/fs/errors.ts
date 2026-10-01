import path from 'node:path';
import { IncError, toIncError, type ErrorCode } from '@shared/errors';

interface Reason {
  code: ErrorCode;
  text: string;
}

const REASONS: Record<string, Reason> = {
  ENOENT: { code: 'E_NOT_FOUND', text: 'it does not exist' },
  EEXIST: { code: 'E_EXISTS', text: 'it already exists' },
  ENOTEMPTY: { code: 'E_EXISTS', text: 'the folder is not empty' },
  EACCES: { code: 'E_PERMISSION', text: 'permission denied' },
  EPERM: { code: 'E_PERMISSION', text: 'permission denied' },
  EROFS: { code: 'E_PERMISSION', text: 'the location is read-only' },
  EISDIR: { code: 'E_IS_DIRECTORY', text: 'it is a folder' },
  ENOTDIR: { code: 'E_NOT_DIRECTORY', text: 'a path component is not a folder' },
  EINVAL: { code: 'E_INVALID', text: 'the name or path is not valid on this file system' },
  ENAMETOOLONG: { code: 'E_INVALID', text: 'the path is too long' },
  ELOOP: { code: 'E_IO', text: 'too many levels of symbolic links' },
  EBUSY: { code: 'E_IO', text: 'the file is in use by another program' },
  EMFILE: { code: 'E_IO', text: 'too many files are open' },
  ENFILE: { code: 'E_IO', text: 'too many files are open' },
  ENOSPC: { code: 'E_IO', text: 'the disk is full' },
  EDQUOT: { code: 'E_IO', text: 'the disk quota is exceeded' },
  EXDEV: { code: 'E_IO', text: 'the destination is on a different drive' },
  EIO: { code: 'E_IO', text: 'the operation failed at the disk level' },
  ETIMEDOUT: { code: 'E_IO', text: 'the operation timed out' },
};

const CP_REASONS: Record<string, Reason> = {
  ERR_FS_CP_EINVAL: { code: 'E_INVALID', text: 'a folder cannot be copied into itself' },
  ERR_FS_CP_DIR_TO_NON_DIR: { code: 'E_EXISTS', text: 'a file with that name already exists' },
  ERR_FS_CP_NON_DIR_TO_DIR: { code: 'E_EXISTS', text: 'a folder with that name already exists' },
  ERR_FS_CP_EEXIST: { code: 'E_EXISTS', text: 'it already exists' },
  ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY: {
    code: 'E_INVALID',
    text: 'a link would point into the folder being copied',
  },
  ERR_FS_CP_SOCKET: { code: 'E_INVALID', text: 'sockets cannot be copied' },
  ERR_FS_CP_FIFO_PIPE: { code: 'E_INVALID', text: 'pipes cannot be copied' },
  ERR_FS_CP_UNKNOWN: { code: 'E_INVALID', text: 'this kind of file cannot be copied' },
};

export function errnoOf(value: unknown): string | undefined {
  if (value && typeof value === 'object') {
    const code = (value as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/**
 * Turn a Node error into an IncError with a specific code and a plain-language message that
 * names the file and says why the operation failed.
 */
export function fsError(value: unknown, action: string, target?: string): IncError {
  if (value instanceof IncError) return value;
  const errno = errnoOf(value);
  const reason = errno ? (REASONS[errno] ?? CP_REASONS[errno]) : undefined;
  const subject = target ? ` "${path.basename(target) || target}"` : '';
  if (reason) {
    return new IncError(reason.code, `Could not ${action}${subject}: ${reason.text}.`, {
      errno,
      path: target,
    });
  }
  const fallback = toIncError(value);
  return new IncError(fallback.code, `Could not ${action}${subject}: ${fallback.message}`, {
    errno,
    path: target,
  });
}

/** Validate an absolute path argument coming over IPC. */
export function requireAbsolute(value: unknown, name = 'path'): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new IncError('E_INVALID', `The ${name} must be a non-empty string.`);
  }
  if (value.includes('\0')) {
    throw new IncError('E_INVALID', `The ${name} contains an invalid character.`);
  }
  if (!path.isAbsolute(value)) {
    throw new IncError('E_INVALID', `The ${name} must be an absolute path.`, { path: value });
  }
  return path.normalize(value);
}

/** True for a file system root such as "/" or "C:\". */
export function isFilesystemRoot(p: string): boolean {
  const resolved = path.resolve(p);
  return path.parse(resolved).root === resolved;
}
