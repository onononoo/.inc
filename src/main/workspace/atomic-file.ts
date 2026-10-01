import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Crash-safe file replacement: the data is written to a sibling temporary file, flushed to disk
 * and renamed over the target, so a reader (or a later start after a crash or power loss) sees
 * either the old content or the new content, never a torn file.
 *
 * On Windows a rename onto an existing file can fail transiently while an anti-virus scanner or
 * indexer holds the target open; those errors are retried briefly.
 */

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
const MAX_ATTEMPTS = 6;

function tempName(file: string): string {
  return `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
}

function isRetryable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && RETRYABLE.has(code);
}

function backoffMs(attempt: number): number {
  return 10 * 2 ** attempt;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function writeFileAtomicSync(file: string, data: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = tempName(file);
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, file);
        return;
      } catch (e) {
        if (attempt + 1 >= MAX_ATTEMPTS || !isRetryable(e)) throw e;
        sleepSync(backoffMs(attempt));
      }
    }
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = tempName(file);
  try {
    const handle = await fs.promises.open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.promises.rename(tmp, file);
        return;
      } catch (e) {
        if (attempt + 1 >= MAX_ATTEMPTS || !isRetryable(e)) throw e;
        await new Promise((resolve) => setTimeout(resolve, backoffMs(attempt)));
      }
    }
  } catch (e) {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

/**
 * Read and parse a small JSON state file. A missing file yields `undefined`; a file that cannot be
 * read or parsed is moved aside (so support can inspect it and the next write starts clean) and
 * also yields `undefined`. `onProblem` receives a description of what went wrong.
 */
export function readJsonFileSync(
  file: string,
  onProblem: (message: string) => void,
): unknown | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      onProblem(`Could not read ${path.basename(file)}: ${(e as Error).message}`);
    }
    return undefined;
  }
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    onProblem(`${path.basename(file)} is not valid JSON and was set aside`);
    try {
      fs.renameSync(file, `${file}.corrupt`);
    } catch {
      /* the next successful write replaces it anyway */
    }
    return undefined;
  }
}
