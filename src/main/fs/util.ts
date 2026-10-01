import fsp from 'node:fs/promises';
import { errnoOf } from './errors';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` over `items` with at most `limit` calls in flight. Results keep the order of `items`.
 * The first rejection stops scheduling new work and is re-thrown once running calls finish.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: { error: unknown } | null = null;
  const worker = async () => {
    while (!failure) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i] as T, i);
      } catch (error) {
        failure = { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw (failure as { error: unknown }).error;
  return results;
}

/** Windows briefly locks files that a scanner, indexer or the watcher has open. */
const RENAME_RETRY_DELAYS_MS = process.platform === 'win32' ? [10, 20, 40, 80, 160, 320] : [];
const RETRYABLE = new Set(['EBUSY', 'EPERM', 'EACCES']);

/** fs.rename that retries transient sharing violations on Windows before giving up. */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (error) {
      const code = errnoOf(error);
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !code || !RETRYABLE.has(code)) throw error;
      await sleep(delay);
    }
  }
}

/** Suffix of the temporary files created by atomic writes. Watchers ignore them. */
export const TEMP_SUFFIX = '.inc-tmp';

export function isTempFileName(name: string): boolean {
  return name.endsWith(TEMP_SUFFIX) && name.startsWith('.');
}
