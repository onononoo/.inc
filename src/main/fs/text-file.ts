import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import fsp, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { ReadFileResult, WriteFileOptions, WriteFileResult } from '@shared/api/fs';
import type { TextEncoding } from '@shared/encodings';
import { IncError } from '@shared/errors';
import {
  BINARY_SNIFF_BYTES,
  decodeBuffer,
  detectBom,
  detectEncoding,
  detectEol,
  encodeText,
  looksBinary,
} from './encoding';
import { errnoOf, fsError } from './errors';
import { renameWithRetry, TEMP_SUFFIX } from './util';

const isWindows = process.platform === 'win32';

/** Two modification times closer than this are the same instant (file systems round differently). */
const MTIME_TOLERANCE_MS = 1;

function displayName(file: string): string {
  return path.basename(file) || file;
}

// --- reading --------------------------------------------------------------------------------

export interface ReadTextOptions {
  /** Force an encoding instead of detecting one. */
  encoding?: TextEncoding;
  /** Files larger than this are reported as "tooLarge" without being read. */
  maxBytes: number;
}

function placeholder(
  file: string,
  kind: 'binary' | 'tooLarge',
  info: Pick<Stats, 'size' | 'mtimeMs'>,
  encoding: TextEncoding | undefined,
): ReadFileResult {
  return {
    path: file,
    kind,
    content: '',
    encoding: encoding ?? 'utf8',
    eol: 'lf',
    mixedEol: false,
    size: info.size,
    mtimeMs: info.mtimeMs,
  };
}

/**
 * Read a text file, detecting its encoding and line endings. Binary files (a NUL byte in the first
 * 8 KB, unless the file starts with a UTF-16 byte order mark) and files above `maxBytes` are
 * classified from metadata and the first block only: the rest of the file is never read.
 */
export async function readTextFile(file: string, options: ReadTextOptions): Promise<ReadFileResult> {
  let before: Stats;
  try {
    before = await fsp.stat(file);
  } catch (error) {
    throw fsError(error, 'open', file);
  }
  if (before.isDirectory()) {
    throw new IncError('E_IS_DIRECTORY', `Could not open "${displayName(file)}": it is a folder.`, {
      path: file,
    });
  }
  if (!before.isFile()) {
    throw new IncError(
      'E_INVALID',
      `Could not open "${displayName(file)}": it is not a regular file.`,
      { path: file },
    );
  }
  if (before.size > options.maxBytes) return placeholder(file, 'tooLarge', before, options.encoding);

  let handle: FileHandle;
  try {
    handle = await fsp.open(file, 'r');
  } catch (error) {
    throw fsError(error, 'open', file);
  }
  try {
    // Metadata taken from the open handle describes exactly the bytes read below. A later write
    // that checks this mtime therefore detects every change made after these bytes were read.
    const info = await handle.stat();
    if (info.size > options.maxBytes) return placeholder(file, 'tooLarge', info, options.encoding);

    const bytes = Buffer.allocUnsafeSlow(info.size);
    let filled = 0;
    let checkedHead = false;
    while (filled < bytes.length) {
      const { bytesRead } = await handle.read(bytes, filled, bytes.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
      if (!checkedHead && (filled >= BINARY_SNIFF_BYTES || filled === bytes.length)) {
        checkedHead = true;
        const forcedUtf16 = options.encoding === 'utf16le' || options.encoding === 'utf16be';
        if (!forcedUtf16 && looksBinary(bytes.subarray(0, Math.min(filled, BINARY_SNIFF_BYTES)))) {
          return placeholder(file, 'binary', info, options.encoding);
        }
      }
    }
    const data = filled === bytes.length ? bytes : bytes.subarray(0, filled);

    const encoding = options.encoding ?? detectEncoding(data);
    let content: string;
    try {
      content = decodeBuffer(data, encoding);
    } catch (error) {
      if (error instanceof RangeError) return placeholder(file, 'tooLarge', info, encoding);
      throw error;
    }
    const { eol, mixed } = detectEol(content);
    return {
      path: file,
      kind: 'text',
      content,
      encoding,
      eol,
      mixedEol: mixed,
      size: info.size,
      mtimeMs: info.mtimeMs,
    };
  } catch (error) {
    throw fsError(error, 'read', file);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Raw bytes of a file; refuses files bigger than `maxBytes` without reading them. */
export async function readFileBytes(file: string, maxBytes: number): Promise<Uint8Array> {
  let handle: FileHandle;
  try {
    handle = await fsp.open(file, 'r');
  } catch (error) {
    throw fsError(error, 'open', file);
  }
  try {
    const info = await handle.stat();
    if (info.isDirectory()) {
      throw new IncError('E_IS_DIRECTORY', `Could not open "${displayName(file)}": it is a folder.`, {
        path: file,
      });
    }
    if (info.size > maxBytes) {
      throw new IncError(
        'E_TOO_LARGE',
        `"${displayName(file)}" is larger than the ${Math.round(maxBytes / (1024 * 1024))} MB preview limit.`,
        { path: file, size: info.size, maxBytes },
      );
    }
    const bytes = Buffer.allocUnsafeSlow(info.size);
    let filled = 0;
    while (filled < bytes.length) {
      const { bytesRead } = await handle.read(bytes, filled, bytes.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return new Uint8Array(bytes.buffer, bytes.byteOffset, filled);
  } catch (error) {
    throw fsError(error, 'read', file);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

// --- writing --------------------------------------------------------------------------------

export interface WriteDeps {
  /** Replaces `rename`; tests use it to simulate a failing rename. */
  rename?: (from: string, to: string) => Promise<void>;
}

/**
 * Where a write to `file` really lands: symbolic links (also dangling ones) are followed so the
 * link keeps pointing at the file instead of being replaced by a regular file.
 */
export async function resolveWriteTarget(file: string): Promise<string> {
  let current = file;
  for (let hops = 0; hops < 40; hops++) {
    let info: Stats;
    try {
      info = await fsp.lstat(current);
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') return current;
      throw fsError(error, 'save', file);
    }
    if (!info.isSymbolicLink()) return current;
    const link = await fsp.readlink(current);
    current = path.resolve(path.dirname(current), link);
  }
  throw new IncError('E_IO', `Could not save "${displayName(file)}": too many levels of symbolic links.`, {
    path: file,
  });
}

async function statIfExists(target: string): Promise<Stats | null> {
  try {
    return await fsp.stat(target);
  } catch (error) {
    const code = errnoOf(error);
    if (code === 'ENOENT') return null;
    throw fsError(error, 'save', target);
  }
}

function sameInstant(a: number, b: number): boolean {
  return Math.abs(a - b) < MTIME_TOLERANCE_MS;
}

function assertUnchanged(target: string, current: Stats | null, expected: number | null): void {
  if (expected === null) {
    if (current) {
      throw new IncError(
        'E_MODIFIED_SINCE',
        `"${displayName(target)}" was created by another program after it was opened here.`,
        { path: target, reason: 'created' },
      );
    }
    return;
  }
  if (!current) {
    throw new IncError(
      'E_MODIFIED_SINCE',
      `"${displayName(target)}" was deleted by another program after it was opened here.`,
      { path: target, reason: 'deleted', expectedMtimeMs: expected },
    );
  }
  if (!sameInstant(current.mtimeMs, expected)) {
    throw new IncError(
      'E_MODIFIED_SINCE',
      `"${displayName(target)}" was changed by another program after it was opened here.`,
      { path: target, reason: 'modified', expectedMtimeMs: expected, actualMtimeMs: current.mtimeMs },
    );
  }
}

/** Encoding of an existing file when the caller did not choose one: keep its byte order mark. */
async function sniffExistingEncoding(target: string): Promise<TextEncoding> {
  let handle: FileHandle | null = null;
  try {
    handle = await fsp.open(target, 'r');
    const head = Buffer.alloc(3);
    const { bytesRead } = await handle.read(head, 0, 3, 0);
    return detectBom(head.subarray(0, bytesRead)) ?? 'utf8';
  } catch {
    return 'utf8';
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function syncQuietly(handle: FileHandle): Promise<void> {
  try {
    await handle.sync();
  } catch (error) {
    const code = errnoOf(error);
    // Some file systems cannot flush; any other failure means the data may not be on disk.
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'ENOSYS') throw error;
  }
}

async function writeInPlace(target: string, data: Buffer): Promise<void> {
  const handle = await fsp.open(target, 'r+');
  try {
    await handle.truncate(0);
    await handle.writeFile(data);
    await syncQuietly(handle);
  } finally {
    await handle.close();
  }
}

function tempNameFor(target: string): string {
  const base = displayName(target).slice(0, 64);
  return path.join(path.dirname(target), `.${base}.${randomBytes(6).toString('hex')}${TEMP_SUFFIX}`);
}

function isRenameLock(code: string | undefined): boolean {
  return isWindows && (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES');
}

/**
 * Save `content` to `file` atomically: the bytes go to a temporary file in the same folder, are
 * flushed to disk, and replace the target with a rename, so a crash or a full disk never leaves a
 * half-written file. Writes through symbolic links, keeps the file mode, refuses when the file
 * changed since `expectedMtimeMs`, and falls back to an in-place write for hard-linked files and
 * folders that do not allow new files.
 */
export async function writeTextFile(
  file: string,
  content: string,
  options: WriteFileOptions = {},
  deps: WriteDeps = {},
): Promise<WriteFileResult> {
  const rename = deps.rename ?? renameWithRetry;
  const target = await resolveWriteTarget(file);
  const existing = await statIfExists(target);
  if (existing?.isDirectory()) {
    throw new IncError('E_IS_DIRECTORY', `Could not save "${displayName(file)}": it is a folder.`, {
      path: file,
    });
  }
  if (existing && !existing.isFile()) {
    throw new IncError(
      'E_INVALID',
      `Could not save "${displayName(file)}": it is not a regular file.`,
      { path: file },
    );
  }
  if (options.expectedMtimeMs !== undefined) {
    assertUnchanged(target, existing, options.expectedMtimeMs);
  }

  const encoding = options.encoding ?? (existing ? await sniffExistingEncoding(target) : 'utf8');
  const data = encodeText(content, encoding);

  if (existing) {
    try {
      await fsp.access(target, constants.W_OK);
    } catch (error) {
      throw fsError(error, 'save', file);
    }
  } else if (options.createDirs) {
    try {
      await fsp.mkdir(path.dirname(target), { recursive: true });
    } catch (error) {
      throw fsError(error, 'create the folder for', file);
    }
  }

  if (existing && existing.nlink > 1) {
    // Replacing the file would detach it from its other hard links.
    try {
      await writeInPlace(target, data);
    } catch (error) {
      throw fsError(error, 'save', file);
    }
  } else {
    await writeAtomically(file, target, data, existing, options, rename);
  }

  try {
    const after = await fsp.stat(target);
    return { mtimeMs: after.mtimeMs, size: after.size };
  } catch (error) {
    throw fsError(error, 'save', file);
  }
}

async function writeTempFile(temp: string, data: Buffer, mode: number): Promise<void> {
  const handle = await fsp.open(temp, 'wx', mode);
  try {
    await handle.writeFile(data);
    await syncQuietly(handle);
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function writeAtomically(
  file: string,
  target: string,
  data: Buffer,
  existing: Stats | null,
  options: WriteFileOptions,
  rename: (from: string, to: string) => Promise<void>,
): Promise<void> {
  const temp = tempNameFor(target);
  try {
    try {
      await writeTempFile(temp, data, existing ? existing.mode & 0o777 : 0o666);
    } catch (error) {
      const code = errnoOf(error);
      if (existing && (code === 'EACCES' || code === 'EPERM' || code === 'EROFS')) {
        // The folder does not accept new files but the file itself is writable.
        await writeInPlace(target, data);
        return;
      }
      throw error;
    }

    if (existing && !isWindows) {
      await fsp.chmod(temp, existing.mode & 0o7777);
      if (typeof process.getuid === 'function' && existing.uid !== process.getuid()) {
        await fsp.chown(temp, existing.uid, existing.gid).catch(() => undefined);
      }
    }

    // Narrow the window for a lost update: check once more right before the swap.
    if (options.expectedMtimeMs !== undefined) {
      assertUnchanged(target, await statIfExists(target), options.expectedMtimeMs);
    }
    await rename(temp, target);
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => undefined);
    if (error instanceof IncError) throw error;
    if (isRenameLock(errnoOf(error))) {
      throw new IncError(
        'E_IO',
        `Could not save "${displayName(file)}": the file is in use by another program. Close it there and try again.`,
        { path: file, errno: errnoOf(error) },
      );
    }
    throw fsError(error, 'save', file);
  }
}
