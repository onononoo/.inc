import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import type { Platform } from '@shared/paths';

const created: string[] = [];

export const hostPlatform = process.platform as Platform;

/** A fresh temporary directory (real path), removed after the current test. */
export function tempDir(prefix = 'inc-fs-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/** Write files (relative path -> content) under `root`, creating folders as needed. */
export function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

// A native watcher may still be releasing its handle on the folder, so retry (asynchronously) on Windows.
afterEach(async () => {
  for (const dir of created.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  }
});

export async function waitFor<T>(
  probe: () => T | undefined | false,
  timeoutMs = 8000,
  intervalMs = 25,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > end) throw new Error('Timed out waiting for a condition');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
