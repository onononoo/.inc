import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_RECENT, RecentStore } from '../../../src/main/workspace/recent-store';
import { hostPlatform, tempDir, tempFolders } from './helpers';

const noop = () => undefined;

function folders(count: number): { base: string; dirs: string[] } {
  return tempFolders(...Array.from({ length: count }, (_, i) => `repo-${i}`));
}

describe('RecentStore', () => {
  it('lists the most recently opened folder first', async () => {
    const { dirs } = folders(3);
    const store = new RecentStore(tempDir(), hostPlatform, noop);
    store.add(dirs[0]!, 100);
    store.add(dirs[1]!, 200);
    store.add(dirs[2]!, 300);
    const list = await store.list();
    expect(list.map((r) => r.name)).toEqual(['repo-2', 'repo-1', 'repo-0']);
    expect(list[0]).toEqual({ path: dirs[2], name: 'repo-2', lastOpened: 300 });
  });

  it('moves a re-opened folder to the top without duplicating it', async () => {
    const { dirs } = folders(2);
    const store = new RecentStore(tempDir(), hostPlatform, noop);
    store.add(dirs[0]!, 1);
    store.add(dirs[1]!, 2);
    store.add(dirs[0]!, 3);
    const list = await store.list();
    expect(list.map((r) => r.path)).toEqual([dirs[0], dirs[1]]);
    expect(list[0]!.lastOpened).toBe(3);
  });

  it('dedupes by path key: trailing separators and, on Windows and macOS, case', async () => {
    const { dirs } = folders(1);
    const dir = dirs[0]!;
    const store = new RecentStore(tempDir(), 'win32', noop);
    store.add(dir, 1);
    store.add(dir + path.sep, 2);
    store.add(dir.toUpperCase(), 3);
    expect(await store.list()).toHaveLength(1);
  });

  it('treats different case as different folders on Linux', () => {
    const { dirs } = folders(1);
    const userData = tempDir();
    const store = new RecentStore(userData, 'linux', noop);
    store.add(dirs[0]!, 1);
    store.add(dirs[0]!.toUpperCase(), 2);
    const saved = JSON.parse(readFileSync(path.join(userData, 'recent.json'), 'utf8'));
    expect(saved.entries).toHaveLength(2);
  });

  it(`keeps at most ${MAX_RECENT} entries and drops the oldest`, async () => {
    const { dirs } = folders(MAX_RECENT + 5);
    const store = new RecentStore(tempDir(), hostPlatform, noop);
    dirs.forEach((dir, i) => store.add(dir, i + 1));
    const list = await store.list();
    expect(list).toHaveLength(MAX_RECENT);
    expect(list[0]!.path).toBe(dirs[dirs.length - 1]);
    expect(list.at(-1)!.path).toBe(dirs[5]);
  });

  it('prunes folders that no longer exist and persists the pruning', async () => {
    const { dirs } = folders(3);
    const userData = tempDir();
    const store = new RecentStore(userData, hostPlatform, noop);
    dirs.forEach((dir, i) => store.add(dir, i + 1));
    rmSync(dirs[1]!, { recursive: true });
    expect((await store.list()).map((r) => r.name)).toEqual(['repo-2', 'repo-0']);
    const reloaded = new RecentStore(userData, hostPlatform, noop);
    expect((await reloaded.list()).map((r) => r.name)).toEqual(['repo-2', 'repo-0']);
  });

  it('prunes an entry that is now a file rather than a folder', async () => {
    const { dirs } = folders(1);
    const store = new RecentStore(tempDir(), hostPlatform, noop);
    store.add(dirs[0]!);
    rmSync(dirs[0]!, { recursive: true });
    writeFileSync(dirs[0]!, 'now a file');
    expect(await store.list()).toEqual([]);
  });

  it('forgets the restore folder when its entry is pruned', async () => {
    const { dirs } = folders(1);
    const store = new RecentStore(tempDir(), hostPlatform, noop);
    store.add(dirs[0]!);
    expect(store.getLastOpened()).toBe(dirs[0]);
    rmSync(dirs[0]!, { recursive: true });
    await store.list();
    expect(store.getLastOpened()).toBeNull();
  });

  it('removes one entry and clears all', async () => {
    const { dirs } = folders(3);
    const store = new RecentStore(tempDir(), hostPlatform, noop);
    dirs.forEach((dir, i) => store.add(dir, i + 1));
    store.remove(dirs[1]!);
    expect((await store.list()).map((r) => r.name)).toEqual(['repo-2', 'repo-0']);
    store.remove(path.join(tempDir(), 'never-added'));
    expect(await store.list()).toHaveLength(2);
    store.clear();
    expect(await store.list()).toEqual([]);
    expect(store.getLastOpened()).toBeNull();
  });

  it('tracks the folder to restore and lets it be cleared conditionally', () => {
    const { dirs } = folders(2);
    const store = new RecentStore(tempDir(), hostPlatform, noop);
    store.add(dirs[0]!);
    store.add(dirs[1]!);
    expect(store.getLastOpened()).toBe(dirs[1]);
    store.clearLastOpened(dirs[0]!);
    expect(store.getLastOpened()).toBe(dirs[1]);
    store.clearLastOpened(dirs[1]!);
    expect(store.getLastOpened()).toBeNull();
  });

  it('persists across instances', async () => {
    const { dirs } = folders(2);
    const userData = tempDir();
    const first = new RecentStore(userData, hostPlatform, noop);
    first.add(dirs[0]!, 1);
    first.add(dirs[1]!, 2);
    const second = new RecentStore(userData, hostPlatform, noop);
    expect((await second.list()).map((r) => r.path)).toEqual([dirs[1], dirs[0]]);
    expect(second.getLastOpened()).toBe(dirs[1]);
  });

  it('starts empty and reports a warning when the file is corrupt', async () => {
    const userData = tempDir();
    writeFileSync(path.join(userData, 'recent.json'), 'not json at all');
    const warnings: string[] = [];
    const store = new RecentStore(userData, hostPlatform, (m) => warnings.push(m));
    expect(await store.list()).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(existsSync(path.join(userData, 'recent.json.corrupt'))).toBe(true);
  });

  it('skips malformed entries and relative paths when loading', async () => {
    const { dirs } = folders(1);
    const userData = tempDir();
    writeFileSync(
      path.join(userData, 'recent.json'),
      JSON.stringify({
        version: 1,
        lastOpened: 'relative',
        entries: [null, 7, { path: 5 }, { path: 'relative/dir', lastOpened: 1 }, { path: dirs[0] }],
      }),
    );
    const store = new RecentStore(userData, hostPlatform, noop);
    expect((await store.list()).map((r) => r.path)).toEqual([dirs[0]]);
    expect(store.getLastOpened()).toBeNull();
  });

  it('names a file system root by its path', async () => {
    const root = path.parse(tempDir()).root;
    const store = new RecentStore(tempDir(), hostPlatform, noop);
    store.add(root);
    expect((await store.list())[0]!.name).toBe(root);
  });

  it('leaves memory unchanged and throws when the file cannot be written', () => {
    const base = tempDir();
    const blocker = path.join(base, 'blocker');
    writeFileSync(blocker, 'x');
    const store = new RecentStore(blocker, hostPlatform, noop);
    const dir = path.join(base, 'repo');
    mkdirSync(dir);
    expect(() => store.add(dir)).toThrow();
    expect(store.getLastOpened()).toBeNull();
  });
});
