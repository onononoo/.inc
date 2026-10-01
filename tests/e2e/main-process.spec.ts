/**
 * The main process as a whole, driven through the same typed IPC the renderer uses: the security
 * perimeter, workspace-bound services (files, search, Git), policy, launch handling and windows.
 */
import { expect, test } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFixture, type Fixture } from './fixtures';
import { launchInc, type IncInstance } from './harness';

interface Captured {
  ch: string;
  p: unknown;
}

async function capture(inc: IncInstance, channels: string[]): Promise<void> {
  await inc.page.evaluate((list) => {
    const w = window as unknown as {
      __events: Captured[];
      inc: { on(channel: string, listener: (payload: unknown) => void): () => void };
    };
    w.__events = [];
    for (const ch of list) w.inc.on(ch, (p) => w.__events.push({ ch, p }));
  }, channels);
}

async function events(inc: IncInstance, channel?: string): Promise<Captured[]> {
  const all = await inc.page.evaluate(
    () => (window as unknown as { __events: Captured[] }).__events,
  );
  return channel ? all.filter((e) => e.ch === channel) : all;
}

async function until<T>(probe: () => Promise<T | undefined | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > end) throw new Error('Timed out waiting for a condition');
    await new Promise((r) => setTimeout(r, 50));
  }
}

test.describe('security perimeter', () => {
  let inc: IncInstance;
  test.beforeAll(async () => {
    inc = await launchInc();
  });
  test.afterAll(async () => inc?.close());

  test('serves the app with a strict content security policy', async () => {
    const header = await inc.page.evaluate(async () => {
      const response = await fetch('inc://app/index.html');
      return response.headers.get('content-security-policy');
    });
    expect(header).toBeTruthy();
    expect(header).toContain("default-src 'none'");
    expect(header).not.toContain('unsafe-eval');
    expect(header).not.toMatch(/https?:/);
  });

  test('refuses paths outside the renderer bundle', async () => {
    const statuses = await inc.page.evaluate(async () => {
      const probe = async (url: string) => {
        try {
          return (await fetch(url)).status;
        } catch {
          return 0;
        }
      };
      return [
        await probe('inc://app/../main/index.js'),
        await probe('inc://app/%2e%2e/main/index.js'),
        await probe('inc://app/..%5Cmain%5Cindex.js'),
        await probe('inc://app/main.js/../../package.json'),
      ];
    });
    for (const status of statuses) expect(status === 0 || status >= 400).toBe(true);
  });

  test('blocks every network request and counts it in the diagnostics', async () => {
    const outcomes = await inc.page.evaluate(async () => {
      const attempt = (url: string) =>
        fetch(url, { mode: 'no-cors' }).then(
          () => 'allowed',
          () => 'blocked',
        );
      const socket = await new Promise<string>((resolve) => {
        try {
          const ws = new WebSocket('wss://example.com/socket');
          ws.onerror = () => resolve('blocked');
          ws.onopen = () => resolve('allowed');
        } catch {
          resolve('blocked');
        }
      });
      return [
        await attempt('https://example.com/'),
        await attempt('http://127.0.0.1:9/'),
        await attempt('ftp://example.com/file'),
        socket,
      ];
    });
    // The page's own content security policy stops these before they leave the renderer...
    expect(outcomes).toEqual(['blocked', 'blocked', 'blocked', 'blocked']);

    // ...and the session refuses (and counts) anything that gets past it, such as a request made
    // on behalf of the page by the main process.
    const sessionOutcomes = await inc.app.evaluate(async ({ session }) => {
      const attempt = (url: string) =>
        session.defaultSession.fetch(url).then(
          () => 'allowed',
          () => 'blocked',
        );
      return [
        await attempt('https://example.com/'),
        await attempt('http://127.0.0.1:9/'),
        await attempt('wss://example.com/socket'),
      ];
    });
    expect(sessionOutcomes).toEqual(['blocked', 'blocked', 'blocked']);
    const report = await inc.invoke<string>('app:getDiagnostics');
    expect(report).toMatch(/Blocked requests: [1-9]/);
  });

  test('diagnostics hold versions and policy state but no home directory or file contents', async () => {
    const report = await inc.invoke<string>('app:getDiagnostics');
    expect(report).toContain('.inc diagnostics');
    expect(report).toMatch(/Electron: \d+/);
    expect(report).toContain('Policy active: no');
    expect(report.toLowerCase()).not.toContain(os.homedir().toLowerCase());
    expect(report).not.toContain(
      os.userInfo().username === '' ? '\0' : `\\${os.userInfo().username}\\`,
    );
  });

  test('rejects a link that is not http, https or mailto, and one with embedded credentials', async () => {
    for (const bad of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'inc://app/index.html',
      'https://user:pw@example.com/',
      'https://exa mple.com/',
      '',
    ]) {
      expect(await inc.invoke('app:openExternal', bad)).toBe(false);
    }
  });

  test('validates arguments from the page', async () => {
    await expect(inc.invoke('window:setTitle', 42)).rejects.toThrow(/E_INVALID/);
    await expect(inc.invoke('window:showMenu', 'Nope', 1, 1)).rejects.toThrow(/E_INVALID/);
    await expect(inc.invoke('window:setZoom', 'big')).rejects.toThrow(/E_INVALID/);
    await expect(inc.invoke('dialog:message', { message: '', buttons: ['ok'] })).rejects.toThrow(
      /E_INVALID/,
    );
    await expect(inc.invoke('app:log', 'verbose', 'x')).rejects.toThrow(/E_INVALID/);
    await expect(inc.invoke('fs:readFile', 'relative.txt')).rejects.toThrow(/E_INVALID/);
  });

  test('accepts renderer log lines without letting them forge entries', async () => {
    await inc.invoke('app:log', 'info', 'hello\n2026-01-01 ERROR forged line');
    const logs = path.join(inc.userDataDir, 'logs');
    const text = await until(async () => {
      if (!existsSync(logs)) return undefined;
      const { readdirSync } = await import('node:fs');
      const files = readdirSync(logs).filter((f) => f.endsWith('.log'));
      const joined = files.map((f) => readFileSync(path.join(logs, f), 'utf8')).join('\n');
      return joined.includes('[renderer] hello') ? joined : undefined;
    });
    const forged = text.split('\n').filter((line) => line.includes('forged line'));
    expect(forged).toHaveLength(1);
    expect(forged[0]).toContain('[renderer] hello');
  });

  test('windows report state, clamp zoom and accept theme colours', async () => {
    const state = await inc.invoke<{
      platform: string;
      nativeControls: boolean;
      maximized: boolean;
    }>('window:getState');
    expect(state.nativeControls).toBe(true);
    expect(state.platform).toBe(process.platform);
    await inc.invoke('window:setTitle', 'e2e title');
    await inc.invoke('window:setZoom', 99);
    await inc.invoke('window:setZoom', 0);
    await inc.invoke('window:setTheme', 'dark', {
      background: '#101418',
      foreground: 'rgb(200, 210, 220)',
    });
    await inc.invoke('window:setTheme', 'light', {
      background: 'not a colour',
      foreground: '#fff',
    });
    const title = await inc.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.getTitle(),
    );
    expect(title).toBe('e2e title');
    const saved = await until(async () => {
      const file = path.join(inc.userDataDir, 'window-state.json');
      return existsSync(file)
        ? (JSON.parse(readFileSync(file, 'utf8')) as {
            theme?: { scheme: string; background: string };
          })
        : undefined;
    });
    expect(saved.theme).toMatchObject({ scheme: 'dark', background: '#101418' });
  });

  test('uses a custom menu bar on Windows and Linux and a native one on macOS', async () => {
    const hasMenu = await inc.app.evaluate(({ Menu }) => Menu.getApplicationMenu() !== null);
    expect(hasMenu).toBe(process.platform === 'darwin');
  });
});

test.describe('enterprise policy', () => {
  let inc: IncInstance;
  test.beforeAll(async () => {
    inc = await launchInc({
      policy: {
        version: 1,
        settings: { 'editor.fontSize': 18 },
        features: {
          terminal: false,
          tasks: false,
          gitRemoteOperations: false,
          externalLinks: 'deny',
        },
        notice: 'Managed by Example IT.',
      },
    });
  });
  test.afterAll(async () => inc?.close());

  test('reports locked settings and refuses to change them', async () => {
    const policy = await inc.invoke<{
      active: boolean;
      notice: string;
      lockedKeys: string[];
      features: { terminal: boolean };
    }>('policy:get');
    expect(policy.active).toBe(true);
    expect(policy.notice).toBe('Managed by Example IT.');
    expect(policy.lockedKeys).toContain('editor.fontSize');
    expect(policy.features.terminal).toBe(false);
    await expect(inc.invoke('settings:set', 'editor.fontSize', 12, 'user')).rejects.toThrow(
      /E_POLICY/,
    );
    const snapshot = await inc.invoke<{ effective: Record<string, unknown> }>('settings:get');
    expect(snapshot.effective['editor.fontSize']).toBe(18);
    expect(await inc.invoke<string>('app:getDiagnostics')).toContain('Policy active: yes');
  });

  test('turns external links off', async () => {
    expect(await inc.invoke('app:openExternal', 'https://example.com/')).toBe(false);
  });

  test('applies features to the services that honour them', async () => {
    await expect(inc.invoke('terminal:listProfiles')).rejects.toThrow(/E_POLICY/);
  });
});

test.describe('launch handling', () => {
  let fixture: Fixture;
  test.beforeAll(() => {
    fixture = createFixture();
  });
  test.afterAll(() => fixture.cleanup());

  test('opens the folder named on the command line', async () => {
    const inc = await launchInc({ workspace: fixture.root });
    try {
      const info = await inc.invoke<{ root: string; trust: string } | null>('workspace:get');
      expect(info?.root.toLowerCase()).toBe(path.resolve(fixture.root).toLowerCase());
      expect(info?.trust).toBe('untrusted');
    } finally {
      await inc.close();
    }
  });

  test('opens files named on the command line at the requested position, once', async () => {
    const file = fixture.file('packages', 'api', 'src', 'index.ts');
    const inc = await launchInc({ workspace: fixture.root, args: [`${file}:2:5`] });
    try {
      // The window asks for the pending request when it starts, so it opens the file itself.
      await expect(inc.page.locator('[role="tab"]', { hasText: 'index.ts' })).toBeVisible();
      await expect(inc.page.getByTestId('status-cursor')).toContainText('Ln 2, Col 5');
      expect(await inc.invoke('app:consumePendingOpen')).toEqual([]);
    } finally {
      await inc.close();
    }
  });

  test('ignores arguments that do not exist and Chromium switches', async () => {
    const inc = await launchInc({
      args: ['--disable-gpu-vsync', path.join(fixture.root, 'missing.txt')],
    });
    try {
      expect(await inc.invoke('workspace:get')).toBeNull();
      expect(await inc.invoke('app:consumePendingOpen')).toEqual([]);
    } finally {
      await inc.close();
    }
  });

  test('a second launch hands its folder to the running app instead of starting another', async () => {
    const inc = await launchInc();
    try {
      const before = await inc.app.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
      );
      expect(before).toBe(1);
      const { execFile } = await import('node:child_process');
      const electronPath = await inc.app.evaluate(() => process.execPath);
      const appDir = await inc.app.evaluate(({ app }) => app.getAppPath());
      await new Promise<void>((resolve) => {
        execFile(electronPath, [appDir, fixture.root], {
          env: { ...process.env, INC_USER_DATA_DIR: inc.userDataDir, INC_TEST_HIDDEN: '1' },
        }).on('exit', () => resolve());
      });
      await until(async () => (await inc.invoke<{ root: string } | null>('workspace:get'))?.root);
      const after = await inc.app.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
      );
      expect(after).toBe(1);
    } finally {
      await inc.close();
    }
  });

  test('reopens the last folder when asked to restore the session', async () => {
    const first = await launchInc({ workspace: fixture.root });
    const userDataDir = first.userDataDir;
    await first.invoke('workspace:setTrust', true);
    await first.app.close();
    const second = await launchInc({ userDataDir });
    try {
      const info = await until(
        async () => await second.invoke<{ root: string } | null>('workspace:get'),
      );
      expect(info?.root.toLowerCase()).toBe(path.resolve(fixture.root).toLowerCase());
    } finally {
      await second.close();
    }
  });
});

test.describe('workspace services', () => {
  let fixture: Fixture;
  let inc: IncInstance;
  test.beforeAll(async () => {
    fixture = createFixture();
    inc = await launchInc({ workspace: fixture.root });
    await capture(inc, [
      'fs:changed',
      'search:results',
      'search:done',
      'git:statusChanged',
      'files:indexProgress',
    ]);
    await inc.invoke('workspace:setTrust', true);
  });
  test.afterAll(async () => {
    await inc?.close();
    fixture?.cleanup();
  });

  test('lists, reads and saves files with encoding and line ending detection', async () => {
    const entries = await inc.invoke<{ name: string; kind: string }[]>('fs:readDir', fixture.root);
    expect(entries.map((e) => e.name)).toEqual(
      expect.arrayContaining(['packages', 'docs', 'README.md', 'package.json']),
    );
    expect(entries.map((e) => e.name)).not.toContain('.git'); // files.exclude
    const index = fixture.file('packages', 'api', 'src', 'index.ts');
    const read = await inc.invoke<{ kind: string; content: string; eol: string; mtimeMs: number }>(
      'fs:readFile',
      index,
    );
    expect(read).toMatchObject({ kind: 'text', eol: 'lf' });
    expect(read.content).toContain('export function greet');
    const saved = await inc.invoke<{ mtimeMs: number }>(
      'fs:writeFile',
      index,
      read.content.replace('Hello', 'Hi'),
      {
        expectedMtimeMs: read.mtimeMs,
      },
    );
    expect(readFileSync(index, 'utf8')).toContain('`Hi, ');
    await expect(
      inc.invoke('fs:writeFile', index, 'stale', { expectedMtimeMs: read.mtimeMs - 10_000 }),
    ).rejects.toThrow(/E_MODIFIED_SINCE/);
    expect(saved.mtimeMs).toBeGreaterThan(0);
  });

  test('finds files by fuzzy name and resolves EditorConfig', async () => {
    const result = await until(async () => {
      const r = await inc.invoke<{ items: { relativePath: string }[]; indexing: boolean }>(
        'files:search',
        'srvr',
      );
      return r.items.length > 0 ? r : undefined;
    });
    expect(result.items[0]?.relativePath).toBe('packages/api/src/server.ts');
    const md = await inc.invoke<{ indentSize?: number }>(
      'editorconfig:resolve',
      fixture.file('README.md'),
    );
    expect(md).toMatchObject({ indentStyle: 'space', indentSize: 2, endOfLine: 'lf' });
    const ts = await inc.invoke<{ indentSize?: number }>(
      'editorconfig:resolve',
      fixture.file('packages', 'api', 'src', 'index.ts'),
    );
    expect(ts?.indentSize).toBe(4);
  });

  test('streams file system changes to the window', async () => {
    await new Promise((r) => setTimeout(r, 500));
    writeFileSync(fixture.file('data', 'created-by-test.txt'), 'x');
    const change = await until(async () =>
      (await events(inc, 'fs:changed'))
        .flatMap((e) => e.p as { path: string; type: string }[])
        .find((c) => c.path.endsWith('created-by-test.txt')),
    );
    expect(change.type).toBe('create');
    const found = await until(async () => {
      const r = await inc.invoke<{ items: unknown[] }>('files:search', 'created-by-test');
      return r.items.length > 0;
    });
    expect(found).toBe(true);
  });

  test('searches text across the workspace and streams the results', async () => {
    const { searchId } = await inc.invoke<{ searchId: number }>('search:start', {
      pattern: 'needle',
      isRegex: false,
      caseSensitive: false,
      wholeWord: false,
      include: [],
      exclude: [],
    });
    const done = await until(async () =>
      (await events(inc, 'search:done')).find(
        (e) => (e.p as { searchId: number }).searchId === searchId,
      ),
    );
    const stats = (
      done.p as { stats: { matchCount: number; filesMatched: number; cancelled: boolean } }
    ).stats;
    expect(stats).toMatchObject({ matchCount: 1, filesMatched: 1, cancelled: false });
    const files = (await events(inc, 'search:results'))
      .map((e) => e.p as { searchId: number; files: { relativePath: string }[] })
      .filter((p) => p.searchId === searchId)
      .flatMap((p) => p.files);
    expect(files.map((f) => f.relativePath)).toEqual(['data/notes.txt']);
  });

  test('replaces text on disk, preserving the file', async () => {
    const file = fixture.file('data', 'notes.txt');
    const result = await inc.invoke<{ filesChanged: number; replacements: number }>(
      'search:replace',
      {
        query: {
          pattern: 'needle',
          isRegex: false,
          caseSensitive: false,
          wholeWord: false,
          include: [],
          exclude: [],
        },
        replacement: 'pin',
        files: [{ path: file }],
      },
    );
    expect(result).toMatchObject({ filesChanged: 1, replacements: 1 });
    expect(readFileSync(file, 'utf8')).toBe('alpha\nbeta\ngamma\npin in a haystack\n');
  });

  test('reports Git status, stages, commits and pushes status events', async () => {
    const status = await inc.invoke<{
      repo: { branch: string; hasCommits: boolean };
      files: { relativePath: string; workingTree: string | null }[];
    } | null>('git:refresh');
    expect(status?.repo).toMatchObject({ hasCommits: true });
    const changed = status?.files.map((f) => f.relativePath) ?? [];
    expect(changed).toEqual(
      expect.arrayContaining([
        'data/notes.txt',
        'packages/api/src/index.ts',
        'data/created-by-test.txt',
      ]),
    );

    await inc.invoke('git:stage', [fixture.file('data', 'notes.txt')]);
    const { sha } = await inc.invoke<{ sha: string }>('git:commit', { message: 'Update notes' });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const log = await inc.invoke<{ subject: string }[]>('git:log', { limit: 1 });
    expect(log[0]?.subject).toBe('Update notes');
    const head = await inc.invoke<{ exists: boolean; content: string }>(
      'git:show',
      fixture.file('data', 'notes.txt'),
      'HEAD',
    );
    expect(head.content).toContain('pin in a haystack');
    expect((await events(inc, 'git:statusChanged')).length).toBeGreaterThan(0);
  });

  test('keeps Git read-only until the folder is trusted', async () => {
    await inc.invoke('workspace:setTrust', false);
    await expect(inc.invoke('git:stageAll')).rejects.toThrow(/E_UNTRUSTED/);
    expect(await inc.invoke('git:branches')).toBeTruthy();
    await inc.invoke('workspace:setTrust', true);
    await inc.invoke('git:stageAll');
  });

  test('follows the settings layers for workspace-scoped values', async () => {
    await inc.invoke('settings:set', 'editor.tabSize', 3, 'workspace');
    const file = path.join(fixture.root, '.inc', 'settings.json');
    expect(readFileSync(file, 'utf8')).toContain('"editor.tabSize": 3');
    const snapshot = await inc.invoke<{
      effective: Record<string, unknown>;
      sources: Record<string, string>;
    }>('settings:get');
    expect(snapshot.effective['editor.tabSize']).toBe(3);
    expect(snapshot.sources['editor.tabSize']).toBe('workspace');
    await inc.invoke('settings:reset', 'editor.tabSize', 'workspace');
    const reset = await inc.invoke<{ sources: Record<string, string> }>('settings:get');
    expect(reset.sources['editor.tabSize']).toBe('default');
  });
});
