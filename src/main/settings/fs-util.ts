/**
 * Small file helpers for configuration files: capped synchronous reads that refuse anything that
 * is not a regular file, and atomic writes (temp file + rename).
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

/** Configuration files are tiny; anything bigger is a mistake or an attack. */
export const MAX_CONFIG_BYTES = 1024 * 1024;

export type ReadResult =
  | { kind: 'missing' }
  | { kind: 'ok'; text: string; bom: boolean }
  | { kind: 'error'; message: string };

/**
 * Read a configuration file synchronously. Sizes are capped and only regular files are read, so a
 * FIFO or device placed at the path by a hostile repository cannot block the main process.
 */
export function readConfigText(file: string): ReadResult {
  let info: fs.Stats;
  try {
    info = fs.statSync(file);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
    return { kind: 'error', message: errorText(e) };
  }
  if (!info.isFile()) return { kind: 'error', message: 'It is not a regular file.' };
  if (info.size > MAX_CONFIG_BYTES) {
    return { kind: 'error', message: 'It is larger than 1 MB.' };
  }
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const bom = raw.charCodeAt(0) === 0xfeff;
    return { kind: 'ok', text: bom ? raw.slice(1) : raw, bom };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'error', message: errorText(e) };
  }
}

function errorText(e: unknown): string {
  const err = e as NodeJS.ErrnoException;
  switch (err.code) {
    case 'EACCES':
    case 'EPERM':
      return 'Permission denied.';
    default:
      return err.message || String(e);
  }
}

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      // Windows refuses to replace a file another process (an editor, a virus scanner) has open
      // for a moment. Retry briefly before giving up.
      if (attempt >= 6 || !RETRYABLE.has(code)) throw e;
      await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt));
    }
  }
}

/** Write a file so readers see either the old or the new content, never a partial file. */
export async function atomicWriteFile(target: string, content: string): Promise<void> {
  const dir = path.dirname(target);
  await mkdir(dir, { recursive: true });
  const temp = path.join(
    dir,
    `.${path.basename(target)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temp, 'wx');
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      const existing = await stat(target);
      await fs.promises.chmod(temp, existing.mode & 0o777);
    } catch {
      /* new file, or the mode cannot be copied: keep the default */
    }
    await renameWithRetry(temp, target);
  } catch (e) {
    await handle?.close().catch(() => undefined);
    await rm(temp, { force: true }).catch(() => undefined);
    throw e;
  }
}

/** Create a file only when it does not exist. Returns whether it was created. */
export async function createIfMissing(target: string, content: string): Promise<boolean> {
  await mkdir(path.dirname(target), { recursive: true });
  try {
    const handle = await open(target, 'wx');
    try {
      await handle.writeFile(content, 'utf8');
    } finally {
      await handle.close();
    }
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
}

/** Path to write for a user-level file: follows a symbolic link so dotfile setups keep working. */
export function resolveWriteTarget(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}
