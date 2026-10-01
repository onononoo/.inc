import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import type { WorkspaceInfo } from '@shared/api/workspace';
import type { Platform } from '@shared/paths';
import type { Logger } from '../../../src/main/kernel';
import type { WorkspaceEnv } from '../../../src/main/workspace/service';

const created: string[] = [];

/** A fresh temporary directory, removed after the current test. */
export function tempDir(prefix = 'inc-ws-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/** A temporary directory containing the named sub folders. */
export function tempFolders(...names: string[]): { base: string; dirs: string[] } {
  const base = tempDir();
  const dirs = names.map((n) => {
    const dir = path.join(base, n);
    mkdirSync(dir, { recursive: true });
    return dir;
  });
  return { base, dirs };
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export const hostPlatform = process.platform as Platform;

export function recordingLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    debug: () => undefined,
    info: () => undefined,
    warn: (message) => void warnings.push(message),
    error: (message) => void warnings.push(message),
  };
}

export interface FakeEnv extends WorkspaceEnv {
  trustEnabled: boolean;
  notifications: { windowId: number; info: WorkspaceInfo | null }[];
  openWindows: Set<number>;
  osRecentAdds: string[];
  osRecentClears: number;
  logger: ReturnType<typeof recordingLogger>;
}

export function fakeEnv(userDataDir: string, platform: Platform = hostPlatform): FakeEnv {
  const env: FakeEnv = {
    userDataDir,
    platform,
    logger: recordingLogger(),
    trustEnabled: true,
    notifications: [],
    openWindows: new Set([1, 2, 3]),
    osRecentAdds: [],
    osRecentClears: 0,
    isTrustEnabled: () => env.trustEnabled,
    notify: (windowId, info) => void env.notifications.push({ windowId, info }),
    hasWindow: (id) => env.openWindows.has(id),
    osRecents: {
      add: (folder) => void env.osRecentAdds.push(folder),
      clear: () => void env.osRecentClears++,
    },
  };
  return env;
}
