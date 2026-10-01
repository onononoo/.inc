import fs from 'node:fs';
import path from 'node:path';
import { IncError } from '@shared/errors';
import { trimTrailingSeparators } from '@shared/paths';

const MAX_PATH_LENGTH = 32_768;

/**
 * Check the shape of a folder path received over IPC and return it normalised (`.` and `..`
 * resolved, duplicate and trailing separators removed). Does not touch the file system.
 */
export function normaliseRootInput(input: unknown): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new IncError('E_INVALID', 'Choose a folder to open.');
  }
  if (input.length > MAX_PATH_LENGTH || input.includes('\0')) {
    throw new IncError('E_INVALID', 'That is not a valid folder path.');
  }
  // "\dir" is absolute on Windows but depends on the current drive, so it is not stable.
  const driveRelative = process.platform === 'win32' && /^[\\/](?![\\/])/.test(input);
  if (!path.isAbsolute(input) || driveRelative) {
    throw new IncError('E_INVALID', 'The folder path must be absolute.', { path: input });
  }
  return trimTrailingSeparators(path.resolve(input));
}

function notFound(root: string): IncError {
  return new IncError(
    'E_NOT_FOUND',
    `The folder ${root} does not exist. Check the path and try again.`,
    {
      path: root,
    },
  );
}

function notDirectory(root: string): IncError {
  return new IncError(
    'E_NOT_DIRECTORY',
    `${root} is a file, not a folder. Open its parent folder instead.`,
    {
      path: root,
    },
  );
}

function fromStatError(e: unknown, root: string): IncError {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return notFound(root);
  if (code === 'ENOTDIR') return notDirectory(root);
  if (code === 'EACCES' || code === 'EPERM') {
    return new IncError('E_PERMISSION', `You do not have permission to open ${root}.`, {
      path: root,
    });
  }
  return new IncError('E_IO', `The folder ${root} could not be read: ${(e as Error).message}`, {
    path: root,
  });
}

/** Asynchronous check that `root` exists, is a directory and can be listed. */
export async function assertOpenableFolder(root: string): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(root);
    if (!stat.isDirectory()) throw notDirectory(root);
    await fs.promises.access(root, fs.constants.R_OK);
  } catch (e) {
    throw e instanceof IncError ? e : fromStatError(e, root);
  }
}

/** Synchronous variant for the kernel host interface, whose `setRoot` cannot be asynchronous. */
export function assertOpenableFolderSync(root: string): void {
  try {
    if (!fs.statSync(root).isDirectory()) throw notDirectory(root);
    fs.accessSync(root, fs.constants.R_OK);
  } catch (e) {
    throw e instanceof IncError ? e : fromStatError(e, root);
  }
}

/** True when `root` currently exists and is a directory (never throws). */
export function isExistingFolderSync(root: string): boolean {
  try {
    return fs.statSync(root).isDirectory();
  } catch {
    return false;
  }
}
