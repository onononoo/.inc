import { expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFixture, type Fixture } from './fixtures';
import { launchInc, type IncInstance } from './harness';

interface WorkspaceInfo {
  root: string;
  name: string;
  trust: 'trusted' | 'untrusted';
  trustEnabled: boolean;
}

interface RecentWorkspace {
  path: string;
  name: string;
  lastOpened: number;
}

/** Start collecting `workspace:changed` events pushed to the page. */
async function recordChanges(inc: IncInstance): Promise<void> {
  await inc.page.evaluate(() => {
    const w = window as unknown as {
      __wsEvents?: unknown[];
      inc: { on(channel: string, listener: (payload: unknown) => void): () => void };
    };
    w.__wsEvents = [];
    w.inc.on('workspace:changed', (payload) => w.__wsEvents!.push(payload));
  });
}

async function recordedChanges(inc: IncInstance): Promise<(WorkspaceInfo | null)[]> {
  return inc.page.evaluate(
    () => (window as unknown as { __wsEvents: (WorkspaceInfo | null)[] }).__wsEvents,
  );
}

function sameFolder(a: string, b: string): boolean {
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'linux'
    ? norm(a) === norm(b)
    : norm(a).toLowerCase() === norm(b).toLowerCase();
}

test.describe('workspace service', () => {
  test.describe.configure({ mode: 'serial' });

  let inc: IncInstance;
  let fixture: Fixture;
  let other: Fixture;

  test.beforeAll(async () => {
    fixture = createFixture();
    other = createFixture({ git: false });
    inc = await launchInc();
    await recordChanges(inc);
  });

  test.afterAll(async () => {
    await inc?.close();
    fixture?.cleanup();
    other?.cleanup();
  });

  test('opening a folder emits workspace:changed and workspace:get reflects it', async () => {
    const opened = await inc.invoke<WorkspaceInfo>('workspace:open', fixture.root);
    expect(sameFolder(opened.root, fixture.root)).toBe(true);
    expect(opened.name).toBe(path.basename(fixture.root));
    expect(opened.trustEnabled).toBe(true);
    expect(opened.trust).toBe('untrusted');

    const current = await inc.invoke<WorkspaceInfo | null>('workspace:get');
    expect(current).toEqual(opened);

    await expect.poll(async () => (await recordedChanges(inc)).at(-1)?.root).toBe(opened.root);
    const last = (await recordedChanges(inc)).at(-1);
    expect(last).toEqual(opened);
  });

  test('toggling trust persists the decision and notifies the window', async () => {
    const trusted = await inc.invoke<WorkspaceInfo>('workspace:setTrust', true);
    expect(trusted.trust).toBe('trusted');
    expect((await inc.invoke<WorkspaceInfo>('workspace:get')).trust).toBe('trusted');
    await expect.poll(async () => (await recordedChanges(inc)).at(-1)?.trust).toBe('trusted');

    const untrusted = await inc.invoke<WorkspaceInfo>('workspace:setTrust', false);
    expect(untrusted.trust).toBe('untrusted');
    await expect.poll(async () => (await recordedChanges(inc)).at(-1)?.trust).toBe('untrusted');
  });

  test('rejects a non-boolean trust value', async () => {
    await expect(inc.invoke('workspace:setTrust', 'yes')).rejects.toThrow(/E_INVALID/);
  });

  test('opening a missing folder fails with E_NOT_FOUND and keeps the current folder', async () => {
    const missing = path.join(fixture.root, 'does-not-exist');
    await expect(inc.invoke('workspace:open', missing)).rejects.toThrow(/E_NOT_FOUND/);
    const current = await inc.invoke<WorkspaceInfo | null>('workspace:get');
    expect(current && sameFolder(current.root, fixture.root)).toBe(true);
  });

  test('opening a file fails with E_NOT_DIRECTORY and a relative path with E_INVALID', async () => {
    await expect(inc.invoke('workspace:open', fixture.file('README.md'))).rejects.toThrow(
      /E_NOT_DIRECTORY/,
    );
    await expect(inc.invoke('workspace:open', 'relative/folder')).rejects.toThrow(/E_INVALID/);
    await expect(inc.invoke('workspace:open', 42)).rejects.toThrow(/E_INVALID/);
  });

  test('opening another folder replaces the first and recents list both, newest first', async () => {
    const second = await inc.invoke<WorkspaceInfo>('workspace:open', other.root);
    expect(sameFolder(second.root, other.root)).toBe(true);
    expect(second.trust).toBe('untrusted');

    const recent = await inc.invoke<RecentWorkspace[]>('workspace:getRecent');
    expect(recent.length).toBeGreaterThanOrEqual(2);
    expect(sameFolder(recent[0]!.path, other.root)).toBe(true);
    expect(sameFolder(recent[1]!.path, fixture.root)).toBe(true);
    expect(recent[0]!.name).toBe(path.basename(other.root));
  });

  test('removing and clearing recents', async () => {
    const afterRemove = await inc.invoke<RecentWorkspace[]>('workspace:removeRecent', fixture.root);
    expect(afterRemove.some((r) => sameFolder(r.path, fixture.root))).toBe(false);
    expect(afterRemove.some((r) => sameFolder(r.path, other.root))).toBe(true);

    await inc.invoke('workspace:clearRecent');
    expect(await inc.invoke<RecentWorkspace[]>('workspace:getRecent')).toEqual([]);
  });

  test('closing the folder clears workspace state and emits null', async () => {
    await inc.invoke('workspace:close');
    expect(await inc.invoke('workspace:get')).toBeNull();
    await expect.poll(async () => (await recordedChanges(inc)).at(-1)).toBeNull();
  });

  test('setting trust without a folder fails with E_NO_WORKSPACE', async () => {
    await expect(inc.invoke('workspace:setTrust', true)).rejects.toThrow(/E_NO_WORKSPACE/);
  });

  test('sessions are stored per workspace and the empty window has its own', async () => {
    const emptyBlob = { version: 1, data: { note: 'empty window' } };
    await inc.invoke('session:save', emptyBlob);
    expect(await inc.invoke('session:load')).toEqual(emptyBlob);

    await inc.invoke('workspace:open', fixture.root);
    expect(await inc.invoke('session:load')).toBeNull();
    const blob = { version: 3, data: { editors: ['a.ts', 'b.ts'], active: 1 } };
    await inc.invoke('session:save', blob);
    expect(await inc.invoke('session:load')).toEqual(blob);

    await inc.invoke('workspace:close');
    expect(await inc.invoke('session:load')).toEqual(emptyBlob);
  });

  test('rejects malformed and oversized session blobs', async () => {
    await expect(inc.invoke('session:save', 'nope')).rejects.toThrow(/E_INVALID/);
    await expect(inc.invoke('session:save', { version: 0, data: {} })).rejects.toThrow(/E_INVALID/);
    await expect(inc.invoke('session:save', { version: 1 })).rejects.toThrow(/E_INVALID/);
    const huge = { version: 1, data: 'x'.repeat(2 * 1024 * 1024 + 1) };
    await expect(inc.invoke('session:save', huge)).rejects.toThrow(/E_TOO_LARGE/);
  });
});

test.describe('persistence across restarts', () => {
  let userDataDir: string;
  let fixture: Fixture;

  test.beforeAll(() => {
    userDataDir = mkdtempSync(path.join(os.tmpdir(), 'inc-e2e-ws-'));
    fixture = createFixture({ git: false });
  });

  test.afterAll(() => {
    rmSync(userDataDir, { recursive: true, force: true });
    fixture.cleanup();
  });

  test('session, trust and recents survive an app restart', async () => {
    const blob = {
      version: 2,
      data: { editors: [{ path: 'src/index.ts', line: 12 }], sidebar: 'explorer' },
    };

    const first = await launchInc({ userDataDir });
    try {
      await first.invoke('workspace:open', fixture.root);
      await first.invoke('workspace:setTrust', true);
      await first.invoke('session:save', blob);
    } finally {
      await first.close();
    }

    const second = await launchInc({ userDataDir });
    try {
      const reopened = await second.invoke<WorkspaceInfo>('workspace:open', fixture.root);
      expect(reopened.trust).toBe('trusted');
      expect(await second.invoke('session:load')).toEqual(blob);

      const recent = await second.invoke<RecentWorkspace[]>('workspace:getRecent');
      expect(recent.some((r) => sameFolder(r.path, fixture.root))).toBe(true);
    } finally {
      await second.close();
    }
  });

  test('a corrupt trust file fails safe and a corrupt session reads as empty', async () => {
    writeFileSync(path.join(userDataDir, 'trust.json'), '{ not json');
    const blobFile = path.join(userDataDir, 'sessions');
    mkdirSync(blobFile, { recursive: true });
    writeFileSync(path.join(blobFile, 'empty.json'), '\u0000\u0000garbage');

    const inc = await launchInc({ userDataDir });
    try {
      const info = await inc.invoke<WorkspaceInfo>('workspace:open', fixture.root);
      expect(info.trust).toBe('untrusted');
      await inc.invoke('workspace:close');
      expect(await inc.invoke('session:load')).toBeNull();
    } finally {
      await inc.close();
    }
  });
});
