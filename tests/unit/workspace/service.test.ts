import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkspaceService } from '../../../src/main/workspace/service';
import { fakeEnv, tempDir, tempFolders, type FakeEnv } from './helpers';

function setup(existingUserData?: string) {
  const userData = existingUserData ?? tempDir();
  const env = fakeEnv(userData);
  const service = new WorkspaceService(env);
  const rootEvents: { windowId: number; root: string | null }[] = [];
  const trustEvents: { windowId: number; trusted: boolean }[] = [];
  service.onDidChangeRoot((e) => rootEvents.push(e));
  service.onDidChangeTrust((e) => trustEvents.push(e));
  return { userData, env, service, rootEvents, trustEvents };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

function syncCodeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

function lastInfo(env: FakeEnv) {
  return env.notifications.at(-1)?.info;
}

describe('opening and closing', () => {
  it('opens a folder: state, event, notification, recents', async () => {
    const { dirs } = tempFolders('acme');
    const { service, env, rootEvents } = setup();
    const info = await service.open(1, dirs[0]);
    expect(info).toEqual({ root: dirs[0], name: 'acme', trust: 'untrusted', trustEnabled: true });
    expect(service.getRoot(1)).toBe(dirs[0]);
    expect(service.getInfo(1)).toEqual(info);
    expect(rootEvents).toEqual([{ windowId: 1, root: dirs[0] }]);
    expect(env.notifications).toEqual([{ windowId: 1, info }]);
    expect((await service.getRecent()).map((r) => r.path)).toEqual([dirs[0]]);
    expect(env.osRecentAdds).toEqual([dirs[0]]);
    expect(service.getLastOpened()).toBe(dirs[0]);
  });

  it('keeps each window independent', async () => {
    const { dirs } = tempFolders('a', 'b');
    const { service } = setup();
    await service.open(1, dirs[0]);
    await service.open(2, dirs[1]);
    expect(service.getRoot(1)).toBe(dirs[0]);
    expect(service.getRoot(2)).toBe(dirs[1]);
    expect(service.getRoot(3)).toBeNull();
    expect(service.getInfo(3)).toBeNull();
  });

  it('normalises the path it stores', async () => {
    const { dirs } = tempFolders('acme');
    const { service } = setup();
    const messy = dirs[0] + path.sep + 'x' + path.sep + '..' + path.sep;
    // "x" does not exist, but the resolved path does.
    expect((await service.open(1, messy)).root).toBe(dirs[0]);
  });

  it('rejects invalid, missing and non-folder paths without changing state', async () => {
    const { base, dirs } = tempFolders('acme');
    const file = path.join(base, 'file.txt');
    writeFileSync(file, 'x');
    const { service, rootEvents, env } = setup();
    await service.open(1, dirs[0]);
    rootEvents.length = 0;
    env.notifications.length = 0;

    expect(await codeOf(service.open(1, 'relative/path'))).toBe('E_INVALID');
    expect(await codeOf(service.open(1, 42))).toBe('E_INVALID');
    expect(await codeOf(service.open(1, path.join(base, 'missing')))).toBe('E_NOT_FOUND');
    expect(await codeOf(service.open(1, file))).toBe('E_NOT_DIRECTORY');
    expect(service.getRoot(1)).toBe(dirs[0]);
    expect(rootEvents).toEqual([]);
    expect(env.notifications).toEqual([]);
    expect((await service.getRecent()).map((r) => r.path)).toEqual([dirs[0]]);
  });

  it('replaces the current folder when another is opened', async () => {
    const { dirs } = tempFolders('a', 'b');
    const { service, rootEvents } = setup();
    await service.open(1, dirs[0]);
    await service.open(1, dirs[1]);
    expect(service.getRoot(1)).toBe(dirs[1]);
    expect(rootEvents.map((e) => e.root)).toEqual([dirs[0], dirs[1]]);
  });

  it('does not emit again for the same folder but still refreshes recents', async () => {
    const { dirs } = tempFolders('a', 'b');
    const { service, rootEvents, env } = setup();
    await service.open(1, dirs[0]);
    await service.open(2, dirs[1]);
    await service.open(1, dirs[0] + path.sep);
    expect(rootEvents).toHaveLength(2);
    expect(env.notifications).toHaveLength(2);
    expect((await service.getRecent()).map((r) => r.path)).toEqual([dirs[0], dirs[1]]);
  });

  it('closes a folder: event, null notification, nothing to restore', async () => {
    const { dirs } = tempFolders('acme');
    const { service, env, rootEvents } = setup();
    await service.open(1, dirs[0]);
    service.close(1);
    expect(service.getRoot(1)).toBeNull();
    expect(service.getInfo(1)).toBeNull();
    expect(rootEvents.at(-1)).toEqual({ windowId: 1, root: null });
    expect(lastInfo(env)).toBeNull();
    expect(service.getLastOpened()).toBeNull();
    expect((await service.getRecent()).map((r) => r.path)).toEqual([dirs[0]]);
  });

  it('close is a no-op when nothing is open', () => {
    const { service, env, rootEvents } = setup();
    service.close(1);
    expect(rootEvents).toEqual([]);
    expect(env.notifications).toEqual([]);
  });

  it('keeps the folder to restore when a window is destroyed', async () => {
    const { dirs } = tempFolders('acme');
    const { service } = setup();
    await service.open(1, dirs[0]);
    service.releaseWindow(1);
    expect(service.getRoot(1)).toBeNull();
    expect(service.getLastOpened()).toBe(dirs[0]);
  });

  it('does not restore a folder that has since disappeared', async () => {
    const { dirs } = tempFolders('acme');
    const { service, userData } = setup();
    await service.open(1, dirs[0]);
    rmSync(dirs[0]!, { recursive: true });
    expect(setup(userData).service.getLastOpened()).toBeNull();
  });

  it('fails when the window closed while the folder was being checked', async () => {
    const { dirs } = tempFolders('acme');
    const { service, env } = setup();
    env.openWindows.delete(1);
    expect(await codeOf(service.open(1, dirs[0]))).toBe('E_CANCELLED');
    expect(service.getRoot(1)).toBeNull();
  });

  it('validates synchronously through the kernel host interface', () => {
    const { dirs } = tempFolders('acme');
    const { service, rootEvents } = setup();
    service.setRoot(5, dirs[0]!);
    expect(service.getRoot(5)).toBe(dirs[0]);
    expect(syncCodeOf(() => service.setRoot(5, path.join(dirs[0]!, 'nope')))).toBe('E_NOT_FOUND');
    expect(syncCodeOf(() => service.setRoot(5, 'relative'))).toBe('E_INVALID');
    expect(service.getRoot(5)).toBe(dirs[0]);
    service.setRoot(5, null);
    expect(service.getRoot(5)).toBeNull();
    expect(rootEvents.map((e) => e.root)).toEqual([dirs[0], null]);
  });
});

describe('trust', () => {
  it('starts untrusted and persists a trust decision across restarts', async () => {
    const { dirs } = tempFolders('acme');
    const first = setup();
    await first.service.open(1, dirs[0]);
    expect(first.service.isTrusted(1)).toBe(false);

    const info = first.service.setTrust(1, true);
    expect(info.trust).toBe('trusted');
    expect(first.service.isTrusted(1)).toBe(true);

    const second = setup(first.userData);
    const reopened = await second.service.open(1, dirs[0]);
    expect(reopened.trust).toBe('trusted');
    expect(second.service.isTrusted(1)).toBe(true);
  });

  it('emits trust and workspace events only when trust really changes', async () => {
    const { dirs } = tempFolders('acme');
    const { service, env, trustEvents } = setup();
    await service.open(1, dirs[0]);
    env.notifications.length = 0;
    trustEvents.length = 0;

    service.setTrust(1, true);
    expect(trustEvents).toEqual([{ windowId: 1, trusted: true }]);
    expect(lastInfo(env)?.trust).toBe('trusted');

    service.setTrust(1, true);
    expect(trustEvents).toHaveLength(1);
    expect(env.notifications).toHaveLength(1);

    service.setTrust(1, false);
    expect(trustEvents.at(-1)).toEqual({ windowId: 1, trusted: false });
    expect(lastInfo(env)?.trust).toBe('untrusted');
  });

  it('applies a decision to every window showing the same folder', async () => {
    const { dirs } = tempFolders('acme', 'other');
    const { service } = setup();
    await service.open(1, dirs[0]);
    await service.open(2, dirs[0]);
    await service.open(3, dirs[1]);
    service.setTrust(1, true);
    expect(service.isTrusted(1)).toBe(true);
    expect(service.isTrusted(2)).toBe(true);
    expect(service.isTrusted(3)).toBe(false);
  });

  it('does not trust a folder because its parent is trusted', async () => {
    const { dirs } = tempFolders('parent', path.join('parent', 'child'));
    const { service } = setup();
    await service.open(1, dirs[0]);
    service.setTrust(1, true);
    const child = await service.open(2, dirs[1]);
    expect(child.trust).toBe('untrusted');
  });

  it('emits a trust change when switching between a trusted and an untrusted folder', async () => {
    const { dirs } = tempFolders('trusted', 'unknown');
    const { service, trustEvents } = setup();
    await service.open(1, dirs[0]);
    service.setTrust(1, true);
    trustEvents.length = 0;
    await service.open(1, dirs[1]);
    expect(trustEvents).toEqual([{ windowId: 1, trusted: false }]);
    service.close(1);
    expect(trustEvents.at(-1)).toEqual({ windowId: 1, trusted: true });
  });

  it('announces the trust state of a folder as it opens', async () => {
    const { dirs } = tempFolders('acme');
    const { service, trustEvents } = setup();
    await service.open(1, dirs[0]);
    expect(trustEvents).toEqual([{ windowId: 1, trusted: false }]);
  });

  it('reports a window without a folder as trusted', () => {
    expect(setup().service.isTrusted(1)).toBe(true);
  });

  it('requires an open folder and a boolean', async () => {
    const { dirs } = tempFolders('acme');
    const { service } = setup();
    expect(syncCodeOf(() => service.setTrust(1, true))).toBe('E_NO_WORKSPACE');
    await service.open(1, dirs[0]);
    expect(syncCodeOf(() => service.setTrust(1, 'yes'))).toBe('E_INVALID');
    expect(syncCodeOf(() => service.setTrust(1, undefined))).toBe('E_INVALID');
    expect(service.isTrusted(1)).toBe(false);
  });

  it('treats every workspace as trusted when workspace trust is disabled', async () => {
    const { dirs } = tempFolders('acme');
    const { service, env } = setup();
    env.trustEnabled = false;
    const info = await service.open(1, dirs[0]);
    expect(info).toMatchObject({ trust: 'trusted', trustEnabled: false });
    expect(service.isTrusted(1)).toBe(true);
    // A revoke request cannot make the folder restricted while trust is off.
    expect(service.setTrust(1, false)).toMatchObject({ trust: 'trusted', trustEnabled: false });
    expect(service.isTrusted(1)).toBe(true);
  });

  it('re-evaluates open windows when the trust mode changes', async () => {
    const { dirs } = tempFolders('acme');
    const { service, env, trustEvents } = setup();
    await service.open(1, dirs[0]);
    env.notifications.length = 0;
    trustEvents.length = 0;

    env.trustEnabled = false;
    service.refreshTrustMode();
    expect(service.isTrusted(1)).toBe(true);
    expect(trustEvents).toEqual([{ windowId: 1, trusted: true }]);
    expect(lastInfo(env)).toMatchObject({ trust: 'trusted', trustEnabled: false });

    env.trustEnabled = true;
    service.refreshTrustMode();
    expect(service.isTrusted(1)).toBe(false);
    expect(lastInfo(env)).toMatchObject({ trust: 'untrusted', trustEnabled: true });

    const count = env.notifications.length;
    service.refreshTrustMode();
    expect(env.notifications).toHaveLength(count);
  });

  it('remembers an explicit grant made while trust is disabled', async () => {
    const { dirs } = tempFolders('acme');
    const { service, env } = setup();
    env.trustEnabled = false;
    await service.open(1, dirs[0]);
    service.setTrust(1, true);
    env.trustEnabled = true;
    service.refreshTrustMode();
    expect(service.isTrusted(1)).toBe(true);
  });

  it('surfaces a write failure as E_IO and leaves trust unchanged', async () => {
    const { dirs, base } = tempFolders('acme');
    const blocker = path.join(base, 'blocker');
    writeFileSync(blocker, 'x');
    const env = fakeEnv(blocker);
    const service = new WorkspaceService(env);
    await service.open(1, dirs[0]);
    expect(syncCodeOf(() => service.setTrust(1, true))).toBe('E_IO');
    expect(service.isTrusted(1)).toBe(false);
  });

  it('routes the host setTrusted through the same path', async () => {
    const { dirs } = tempFolders('acme');
    const { service, trustEvents } = setup();
    await service.open(1, dirs[0]);
    trustEvents.length = 0;
    service.setTrusted(1, true);
    expect(service.isTrusted(1)).toBe(true);
    expect(trustEvents).toHaveLength(1);
  });
});

describe('recents', () => {
  it('removes and clears recents, including the operating system list', async () => {
    const { dirs } = tempFolders('a', 'b');
    const { service, env } = setup();
    await service.open(1, dirs[0]);
    await service.open(2, dirs[1]);
    expect((await service.removeRecent(dirs[0])).map((r) => r.path)).toEqual([dirs[1]]);
    service.clearRecent();
    expect(await service.getRecent()).toEqual([]);
    expect(env.osRecentClears).toBe(1);
    expect(service.getLastOpened()).toBeNull();
  });

  it('validates the path given to removeRecent', async () => {
    expect(await codeOf(setup().service.removeRecent('relative'))).toBe('E_INVALID');
    expect(await codeOf(setup().service.removeRecent(7))).toBe('E_INVALID');
  });

  it('still opens the folder when the recent list cannot be saved', async () => {
    const { dirs, base } = tempFolders('acme');
    const blocker = path.join(base, 'blocker');
    writeFileSync(blocker, 'x');
    const env = fakeEnv(blocker);
    const service = new WorkspaceService(env);
    await service.open(1, dirs[0]);
    expect(service.getRoot(1)).toBe(dirs[0]);
    expect(env.logger.warnings.length).toBeGreaterThan(0);
  });

  it('survives an operating system recent list that throws', async () => {
    const { dirs } = tempFolders('acme');
    const { service, env } = setup();
    env.osRecents = {
      add: () => {
        throw new Error('shell unavailable');
      },
      clear: () => {
        throw new Error('shell unavailable');
      },
    };
    await service.open(1, dirs[0]);
    expect(() => service.clearRecent()).not.toThrow();
  });
});

describe('sessions', () => {
  it('saves and loads per window root, and the empty session without one', async () => {
    const { dirs } = tempFolders('a', 'b');
    const { service } = setup();
    await service.saveSession(1, { version: 1, data: 'empty window' });
    await service.open(1, dirs[0]);
    expect(await service.loadSession(1)).toBeNull();
    await service.saveSession(1, { version: 1, data: 'a' });
    await service.open(2, dirs[1]);
    await service.saveSession(2, { version: 1, data: 'b' });
    expect((await service.loadSession(1))?.data).toBe('a');
    expect((await service.loadSession(2))?.data).toBe('b');
    service.close(1);
    expect((await service.loadSession(1))?.data).toBe('empty window');
  });

  it('survives a restart of the service', async () => {
    const { dirs } = tempFolders('a');
    const first = setup();
    await first.service.open(1, dirs[0]);
    await first.service.saveSession(1, { version: 3, data: { tabs: [1, 2] } });
    const second = setup(first.userData);
    await second.service.open(1, dirs[0]);
    expect(await second.service.loadSession(1)).toEqual({ version: 3, data: { tabs: [1, 2] } });
  });

  it('rejects oversized and malformed blobs', async () => {
    const { service } = setup();
    expect(
      await codeOf(service.saveSession(1, { version: 1, data: 'x'.repeat(2 * 1024 * 1024) })),
    ).toBe('E_TOO_LARGE');
    expect(await codeOf(service.saveSession(1, 'nope'))).toBe('E_INVALID');
  });
});
