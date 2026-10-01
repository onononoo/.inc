/**
 * File-level work done inside the search workers: reading a file for searching and replacing text
 * in a file on disk. Synchronous on purpose (workers have nothing else to do) and free of any
 * Electron dependency so it can be tested directly.
 */
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { TextEncoding } from '@shared/encodings';
import { isWithin } from '@shared/paths';
import { compileReplacement } from './query';
import { MAX_FILE_BYTES, type FileOutcome } from './protocol';
import { replaceInText, type ScanHooks } from './scan';
import { decodeText, detectEncoding, dominantEol, encodeText, looksBinary } from './text';

export const SCRATCH_BYTES = 64 * 1024;

export type ReadOutcome =
  /** `bytes` is only valid until the next read that uses the same scratch buffer. */
  | { kind: 'text'; bytes: Buffer }
  | { kind: 'binary' }
  | { kind: 'large' }
  | { kind: 'unreadable' };

function readFully(fd: number, target: Uint8Array, offset: number, position: number): number {
  let total = 0;
  while (offset + total < target.length) {
    const n = fs.readSync(fd, target, offset + total, target.length - offset - total, position + total);
    if (n === 0) break;
    total += n;
  }
  return total;
}

/**
 * Read a file for searching. Small files (the common case) cost one open, one read and one close;
 * the size is only looked up when the file fills the scratch buffer.
 */
export function readForSearch(file: string, scratch: Buffer): ReadOutcome {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return { kind: 'unreadable' };
  }
  try {
    const first = readFully(fd, scratch, 0, 0);
    if (looksBinary(scratch, first)) return { kind: 'binary' };
    if (first < scratch.length) return { kind: 'text', bytes: scratch.subarray(0, first) };

    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { kind: 'unreadable' };
    if (stat.size > MAX_FILE_BYTES) return { kind: 'large' };
    const whole = Buffer.allocUnsafe(Math.max(stat.size, first));
    scratch.copy(whole, 0, 0, first);
    const rest = readFully(fd, whole, first, first);
    return { kind: 'text', bytes: whole.subarray(0, first + rest) };
  } catch {
    return { kind: 'unreadable' };
  } finally {
    fs.closeSync(fd);
  }
}

export function describeFsError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case 'ENOENT':
      return 'The file no longer exists.';
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return 'Permission denied.';
    case 'EBUSY':
      return 'The file is in use by another program.';
    case 'ENOSPC':
      return 'The disk is full.';
    case 'EISDIR':
      return 'This is a folder, not a file.';
    default:
      return error instanceof Error ? error.message : 'The file could not be written.';
  }
}

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_ATTEMPTS = 6;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Replace a file's content crash-safely: write a sibling temporary file, flush it, give it the
 * original permissions and rename it over the target. A reader (or a restart after a crash) sees
 * the old content or the new content, never a torn file. On Windows a rename can fail briefly
 * while an indexer or scanner holds the target open, so it is retried.
 */
export function writeFileAtomic(file: string, data: Uint8Array, mode: number): void {
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  );
  try {
    const fd = fs.openSync(temp, 'wx', mode & 0o777);
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.chmodSync(temp, mode & 0o7777);
    } catch {
      /* permission bits are not meaningful on every file system */
    }
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(temp, file);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt + 1 >= RENAME_ATTEMPTS || !code || !RETRYABLE.has(code)) throw error;
        sleepSync(10 * 2 ** attempt);
      }
    }
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* nothing more can be done about a leftover temporary file */
    }
    throw error;
  }
}

export interface ReplaceContext {
  regex: RegExp;
  isRegex: boolean;
  replacement: string;
  realRoot: string;
  hooks?: ScanHooks;
}

function skipped(file: string, reason: string): FileOutcome {
  return { path: file, replacements: 0, skipped: reason };
}

const LEGACY: ReadonlySet<TextEncoding> = new Set<TextEncoding>([
  'windows1252',
  'iso88591',
  'windows1251',
  'koi8r',
  'shiftjis',
  'eucjp',
  'gbk',
  'big5',
  'euckr',
]);

/**
 * Re-run the query on a fresh read of one file and write the replaced text back, keeping the
 * encoding, byte order mark and line endings. The file is skipped, with a plain-language reason,
 * when it is outside the workspace, changed since the search, binary, too large, read-only or
 * cannot be written back in its own encoding.
 */
export function replaceInFile(
  file: string,
  expectedMtimeMs: number | undefined,
  context: ReplaceContext,
): FileOutcome {
  let real: string;
  let before: fs.Stats;
  try {
    real = fs.realpathSync(file);
    before = fs.statSync(real);
  } catch (error) {
    return skipped(file, describeFsError(error));
  }
  if (!isWithin(context.realRoot, real, process.platform)) {
    return skipped(file, 'The file is outside the workspace folder.');
  }
  if (!before.isFile()) return skipped(file, 'This is not a regular file.');
  if (expectedMtimeMs !== undefined && Math.abs(before.mtimeMs - expectedMtimeMs) >= 1) {
    return skipped(file, 'The file changed after the search. Search again to see its current matches.');
  }
  if (before.size > MAX_FILE_BYTES) return skipped(file, 'The file is larger than 10 MB.');
  try {
    fs.accessSync(real, fs.constants.W_OK);
  } catch {
    return skipped(file, 'The file is read-only.');
  }

  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(real);
  } catch (error) {
    return skipped(file, describeFsError(error));
  }
  if (looksBinary(bytes)) return skipped(file, 'The file is binary.');

  const encoding = detectEncoding(bytes);
  if ((encoding === 'utf16le' || encoding === 'utf16be') && (bytes.length - 2) % 2 !== 0) {
    return skipped(file, 'The file is not valid UTF-16 text.');
  }
  const text = decodeText(bytes, encoding);
  const expand = compileReplacement(context.replacement, context.isRegex, dominantEol(text));
  context.regex.lastIndex = 0;
  const result = replaceInText(text, context.regex, expand, context.hooks);
  if (result.count === 0) {
    return skipped(file, 'No matches were found. The file may have changed after the search.');
  }

  let encoded: Buffer;
  try {
    if (LEGACY.has(encoding) && encodeText(text, encoding).compare(bytes) !== 0) {
      return skipped(file, 'The file cannot be saved safely in its original encoding.');
    }
    encoded = encodeText(result.text, encoding);
  } catch {
    return skipped(file, 'The replacement contains characters the file encoding cannot store.');
  }

  try {
    const now = fs.statSync(real);
    if (now.mtimeMs !== before.mtimeMs || now.size !== before.size) {
      return skipped(file, 'The file changed while it was being replaced.');
    }
    writeFileAtomic(real, encoded, before.mode);
  } catch (error) {
    return skipped(file, describeFsError(error));
  }
  return { path: file, replacements: result.count };
}
