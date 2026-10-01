import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AppInfo } from '@shared/api/app';
import type { GitBlob, GitBranch, GitStatus } from '@shared/api/git';
import type { InvokeChannel } from '@shared/ipc';
import { EMPTY_POLICY, type PolicyState } from '@shared/policy';
import { defaultSettings } from '@shared/settings';
import { Emitter, type Handler, type Kernel } from '../../../src/main/kernel';
import { register } from '../../../src/main/git';

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const created: string[] = [];
const disposers: (() => void)[] = [];

function temp(prefix = 'inc-git-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

let isolatedConfig = '';
beforeAll(() => {
  isolatedConfig = path.join(mkdtempSync(path.join(os.tmpdir(), 'inc-git-config-')), 'gitconfig');
  writeFileSync(isolatedConfig, '');
  process.env.GIT_CONFIG_GLOBAL = isolatedConfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_AUTHOR_NAME = 'Test Author';
  process.env.GIT_AUTHOR_EMAIL = 'author@example.test';
  process.env.GIT_COMMITTER_NAME = 'Test Author';
  process.env.GIT_COMMITTER_EMAIL = 'author@example.test';
});

afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  for (const dir of created.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  }
});

/** Run git directly (the test's own view of the repository). */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function repo(files: Record<string, string> = {}, commit = true): string {
  const dir = temp();
  git(dir, 'init', '-q', '-b', 'main');
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  if (commit) {
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'initial');
  }
  return dir;
}

function write(root: string, rel: string, content: string | Buffer): void {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function harness(root: string | null, options: { trusted?: boolean } = {}) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const sent: { channel: string; payload: unknown }[] = [];
  const trustChanges = new Emitter<{ windowId: number; trusted: boolean }>();
  const rootChanges = new Emitter<{ windowId: number; root: string | null }>();
  const fsChanges = new Emitter<{
    windowId: number;
    changes: { type: 'create' | 'update' | 'delete'; path: string }[];
  }>();
  const settingChanges = new Emitter<{ windowId: number | null; keys: string[] }>();
  const values: Record<string, unknown> = { ...defaultSettings() };
  let trusted = options.trusted ?? true;
  let currentRoot = root;
  let policy: PolicyState = EMPTY_POLICY;

  const kernel = {
    info: { platform: process.platform, userDataDir: temp('inc-git-ud-') } as AppInfo,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    settings: {
      get: (_id: number | null, key: string) => values[key],
      snapshot: () => null,
      onDidChange: (cb: (e: { windowId: number | null; keys: string[] }) => void) =>
        settingChanges.on(cb),
    },
    get policy() {
      return { state: policy, onDidChange: () => () => undefined };
    },
    workspaces: {
      getRoot: () => currentRoot,
      getLastOpened: () => null,
      setRoot: () => undefined,
      isTrusted: () => trusted,
      setTrusted: () => undefined,
      onDidChangeRoot: (cb: (e: { windowId: number; root: string | null }) => void) =>
        rootChanges.on(cb),
      onDidChangeTrust: (cb: (e: { windowId: number; trusted: boolean }) => void) =>
        trustChanges.on(cb),
    },
    fsChanges,
    handle<K extends InvokeChannel>(channel: K, handler: Handler<K>) {
      handlers.set(channel, (...args: unknown[]) =>
        (handler as (...a: unknown[]) => unknown)({ windowId: 1 }, ...args),
      );
    },
    send: ((_id: number, channel: string, payload: unknown) =>
      void sent.push({ channel, payload })) as Kernel['send'],
    broadcast: () => undefined,
    getWindow: () => undefined,
    getWindowIds: () => [],
    onWindowCreated: () => () => undefined,
    onWindowClosed: () => () => undefined,
  } as unknown as Kernel;

  disposers.push(register(kernel));
  return {
    sent,
    call: async <T = unknown>(channel: string, ...args: unknown[]): Promise<T> =>
      handlers.get(channel)!(...args) as T,
    status: async () => await (handlers.get('git:refresh')!() as Promise<GitStatus | null>),
    setTrusted(next: boolean) {
      trusted = next;
      trustChanges.emit({ windowId: 1, trusted: next });
    },
    setPolicy(next: PolicyState) {
      policy = next;
    },
    setSetting(key: string, value: unknown) {
      values[key] = value;
      settingChanges.emit({ windowId: 1, keys: [key] });
    },
    emitFsChange(file: string) {
      fsChanges.emit({ windowId: 1, changes: [{ type: 'update', path: file }] });
    },
    openRoot(next: string | null) {
      currentRoot = next;
      rootChanges.emit({ windowId: 1, root: next });
    },
  };
}

const fileOf = (status: GitStatus | null, rel: string) =>
  status?.files.find((f) => f.relativePath === rel);

async function waitFor<T>(probe: () => T | undefined | false, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > end) throw new Error('Timed out waiting for a condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe.skipIf(!gitAvailable())('git slice', () => {
  it('detects git and reports null status outside a repository', async () => {
    const dir = temp();
    const h = harness(dir);
    const detect = await h.call<{ available: boolean; version?: string; path?: string }>(
      'git:detect',
    );
    expect(detect.available).toBe(true);
    expect(detect.version).toMatch(/\d+\.\d+/);
    expect(await h.call('git:status')).toBeNull();
    const none = harness(null);
    expect(await none.call('git:status')).toBeNull();
  });

  it('initialises a repository and lists untracked files, including unicode and spaces', async () => {
    const dir = temp();
    write(dir, 'dir with space/ünï cödé.txt', 'x');
    write(dir, 'plain.txt', 'y');
    const h = harness(dir);
    const status = await h.call<GitStatus | null>('git:init');
    expect(status?.repo.hasCommits).toBe(false);
    expect(status?.repo.branch).toBeTruthy();
    expect(fileOf(status, 'plain.txt')).toMatchObject({
      workingTree: '?',
      index: null,
      conflicted: false,
    });
    const folder = fileOf(status, 'dir with space');
    expect(folder).toMatchObject({ workingTree: '?', isDirectory: true });
    expect(path.isAbsolute(folder!.path)).toBe(true);
    // The status was pushed to the window as well.
    expect(h.sent.some((s) => s.channel === 'git:statusChanged')).toBe(true);
  });

  it('stages, unstages and commits (also before the first commit)', async () => {
    const dir = repo({}, false);
    write(dir, 'a.txt', 'one\n');
    write(dir, 'b.txt', 'two\n');
    const h = harness(dir);
    expect((await h.status())?.files).toHaveLength(2);

    await h.call('git:stage', [path.join(dir, 'a.txt')]);
    let status = await h.status();
    expect(fileOf(status, 'a.txt')).toMatchObject({ index: 'A', workingTree: null });
    expect(fileOf(status, 'b.txt')).toMatchObject({ index: null, workingTree: '?' });

    await h.call('git:unstage', [path.join(dir, 'a.txt')]);
    status = await h.status();
    expect(fileOf(status, 'a.txt')).toMatchObject({ index: null, workingTree: '?' });

    await expect(h.call('git:commit', { message: '   ' })).rejects.toMatchObject({
      code: 'E_INVALID',
    });
    await h.call('git:stageAll');
    const { sha } = await h.call<{ sha: string }>('git:commit', { message: 'first\n\nbody' });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(dir, 'log', '-1', '--format=%B').trim()).toBe('first\n\nbody');
    status = await h.status();
    expect(status?.files).toEqual([]);
    expect(status?.repo.hasCommits).toBe(true);
  });

  it('amends with and without a new message, and reports "nothing to commit"', async () => {
    const dir = repo({ 'a.txt': 'one\n' });
    const h = harness(dir);
    await expect(h.call('git:commit', { message: 'again' })).rejects.toMatchObject({
      code: 'E_GIT',
    });
    write(dir, 'a.txt', 'two\n');
    await h.call('git:stage', [path.join(dir, 'a.txt')]);
    await h.call('git:commit', { message: '', amend: true });
    expect(git(dir, 'log', '-1', '--format=%s').trim()).toBe('initial');
    expect(git(dir, 'rev-list', '--count', 'HEAD').trim()).toBe('1');
    await h.call('git:commit', { message: 'reworded', amend: true });
    expect(git(dir, 'log', '-1', '--format=%s').trim()).toBe('reworded');
  });

  it('handles renames, deletions, discards of every kind', async () => {
    const dir = repo({
      'keep.txt': 'keep\n',
      'old name.txt': 'content that is long enough to detect a rename\n',
      'gone.txt': 'bye\n',
    });
    const h = harness(dir);
    git(dir, 'mv', 'old name.txt', 'new name.txt');
    let status = await h.status();
    const renamed = fileOf(status, 'new name.txt');
    expect(renamed).toMatchObject({ index: 'R' });
    expect(renamed?.origPath).toBe(path.join(dir, 'old name.txt'));

    // Unstaging the new path also unstages the old path, so nothing is left half-renamed.
    await h.call('git:unstage', [path.join(dir, 'new name.txt')]);
    status = await h.status();
    expect(fileOf(status, 'old name.txt')).toMatchObject({ index: null, workingTree: 'D' });
    expect(fileOf(status, 'new name.txt')).toMatchObject({ workingTree: '?' });

    // Discard: restore a deleted tracked file, remove an untracked file, drop a modified one.
    write(dir, 'keep.txt', 'changed\n');
    await h.call('git:discard', [
      path.join(dir, 'old name.txt'),
      path.join(dir, 'new name.txt'),
      path.join(dir, 'keep.txt'),
    ]);
    status = await h.status();
    expect(status?.files).toEqual([]);
    expect(readFileSync(path.join(dir, 'keep.txt'), 'utf8')).toBe('keep\n');
    expect(existsSync(path.join(dir, 'old name.txt'))).toBe(true);
    expect(existsSync(path.join(dir, 'new name.txt'))).toBe(false);

    // A newly added staged file is removed entirely; a deleted file comes back.
    write(dir, 'added.txt', 'new\n');
    git(dir, 'add', 'added.txt');
    git(dir, 'rm', '-q', 'gone.txt');
    await h.status();
    await h.call('git:discard', [path.join(dir, 'added.txt'), path.join(dir, 'gone.txt')]);
    expect((await h.status())?.files).toEqual([]);
    expect(existsSync(path.join(dir, 'added.txt'))).toBe(false);
    expect(existsSync(path.join(dir, 'gone.txt'))).toBe(true);
  });

  it('discards untracked folders', async () => {
    const dir = repo({ 'a.txt': 'a\n' });
    write(dir, 'build/out/x.js', 'x');
    write(dir, 'build/y.js', 'y');
    const h = harness(dir);
    expect(fileOf(await h.status(), 'build')).toMatchObject({ isDirectory: true });
    await h.call('git:discard', [path.join(dir, 'build')]);
    expect(existsSync(path.join(dir, 'build'))).toBe(false);
  });

  it('reports a real merge conflict', async () => {
    const dir = repo({ 'c.txt': 'base\n' });
    git(dir, 'checkout', '-q', '-b', 'feature');
    write(dir, 'c.txt', 'feature\n');
    git(dir, 'commit', '-qam', 'feature change');
    git(dir, 'checkout', '-q', 'main');
    write(dir, 'c.txt', 'main\n');
    git(dir, 'commit', '-qam', 'main change');
    expect(() => git(dir, 'merge', 'feature')).toThrow();
    const h = harness(dir);
    const file = fileOf(await h.status(), 'c.txt');
    expect(file).toMatchObject({ conflicted: true, conflictCode: 'UU' });
  });

  it('works when the workspace is a sub folder of the repository', async () => {
    const dir = repo({ 'pkg/app.ts': 'a\n', 'top.txt': 't\n' });
    write(dir, 'pkg/new.ts', 'n\n');
    const h = harness(path.join(dir, 'pkg'));
    const status = await h.status();
    expect(status?.repo.root).toBe(path.normalize(dir));
    expect(fileOf(status, 'pkg/new.ts')?.path).toBe(path.join(dir, 'pkg', 'new.ts'));
  });

  it('describes a detached HEAD and upstream tracking', async () => {
    const dir = repo({ 'a.txt': '1\n' });
    const h = harness(dir);
    expect((await h.status())?.repo).toMatchObject({
      branch: 'main',
      detached: false,
      upstream: null,
      ahead: 0,
    });
    git(dir, 'checkout', '-q', '--detach');
    expect((await h.status())?.repo).toMatchObject({ branch: null, detached: true });
  });

  it('caps the file list and keeps the real count', async () => {
    const dir = repo({ 'a.txt': 'a\n' });
    for (let i = 0; i < 5100; i++) writeFileSync(path.join(dir, `f${i}.txt`), '');
    const status = await harness(dir).status();
    expect(status?.truncated).toBe(true);
    expect(status?.files.length).toBe(5000);
    expect(status?.totalChanged).toBe(5100);
  }, 60_000);

  it('lists, creates and switches branches (including tracking a remote branch)', async () => {
    const origin = temp('inc-git-origin-');
    git(origin, 'init', '-q', '--bare', '-b', 'main');
    const dir = repo({ 'a.txt': '1\n' });
    git(dir, 'remote', 'add', 'origin', origin);
    git(dir, 'push', '-q', '-u', 'origin', 'main');
    git(dir, 'checkout', '-q', '-b', 'remote-only');
    git(dir, 'push', '-q', 'origin', 'remote-only');
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'branch', '-q', '-D', 'remote-only');
    git(dir, 'fetch', '-q');

    const h = harness(dir);
    const names = (list: GitBranch[]) =>
      list.map((b) => `${b.remote ? 'r:' : ''}${b.name}${b.current ? '*' : ''}`);
    expect(names(await h.call<GitBranch[]>('git:branches'))).toEqual([
      'main*',
      'r:origin/main',
      'r:origin/remote-only',
    ]);

    await h.call('git:createBranch', 'feature/x');
    expect((await h.status())?.repo.branch).toBe('feature/x');
    await h.call('git:createBranch', 'sidecar', false);
    expect((await h.status())?.repo.branch).toBe('feature/x');
    await h.call('git:checkout', 'main');
    expect((await h.status())?.repo.branch).toBe('main');
    await h.call('git:checkout', 'origin/remote-only');
    const after = await h.status();
    expect(after?.repo.branch).toBe('remote-only');
    expect(after?.repo.upstream).toBe('origin/remote-only');

    for (const bad of ['', '-d', 'bad name', 'a..b', 'x\ny']) {
      await expect(h.call('git:createBranch', bad)).rejects.toMatchObject({ code: 'E_INVALID' });
    }
    await expect(h.call('git:checkout', '--orphan')).rejects.toMatchObject({ code: 'E_INVALID' });
  });

  it('refuses a checkout that would overwrite changes with a plain-language error', async () => {
    const dir = repo({ 'a.txt': 'main\n' });
    git(dir, 'checkout', '-q', '-b', 'other');
    write(dir, 'a.txt', 'other\n');
    git(dir, 'commit', '-qam', 'other');
    git(dir, 'checkout', '-q', 'main');
    write(dir, 'a.txt', 'local edit\n');
    const h = harness(dir);
    await expect(h.call('git:checkout', 'other')).rejects.toMatchObject({
      code: 'E_GIT',
      message: expect.stringMatching(/overwritten|local changes/i),
    });
    expect(readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('local edit\n');
  });

  it('shows HEAD and index content, binary files and missing paths', async () => {
    const dir = repo({
      'text.txt': 'head\r\ncontent\r\n',
      'bin.dat': Buffer.from([1, 2, 0, 3]) as unknown as string,
    });
    write(dir, 'text.txt', 'index version\n');
    git(dir, 'add', 'text.txt');
    write(dir, 'text.txt', 'worktree version\n');
    const h = harness(dir);
    const head = await h.call<GitBlob>('git:show', path.join(dir, 'text.txt'), 'HEAD');
    expect(head).toMatchObject({ exists: true, binary: false, content: 'head\r\ncontent\r\n' });
    const index = await h.call<GitBlob>('git:show', path.join(dir, 'text.txt'), 'INDEX');
    expect(index.content).toBe('index version\n');
    expect(await h.call('git:show', path.join(dir, 'bin.dat'), 'HEAD')).toMatchObject({
      exists: true,
      binary: true,
      content: '',
    });
    expect(await h.call('git:show', path.join(dir, 'nope.txt'), 'HEAD')).toMatchObject({
      exists: false,
    });
    await expect(h.call('git:show', 'relative.txt', 'HEAD')).rejects.toMatchObject({
      code: 'E_INVALID',
    });
    await expect(
      h.call('git:show', path.join(dir, '.git', 'config'), 'HEAD'),
    ).rejects.toMatchObject({ code: 'E_INVALID' });
    await expect(
      h.call('git:show', path.join(os.tmpdir(), 'elsewhere.txt'), 'HEAD'),
    ).rejects.toMatchObject({ code: 'E_INVALID' });
  });

  it('returns the log for the repository and for a path, and an empty log before the first commit', async () => {
    const dir = repo({ 'a.txt': '1\n' });
    write(dir, 'b.txt', '2\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'second: with "quotes"');
    const h = harness(dir);
    const all =
      await h.call<
        { subject: string; author: string; sha: string; shortSha: string; date: number }[]
      >('git:log');
    expect(all.map((c) => c.subject)).toEqual(['second: with "quotes"', 'initial']);
    expect(all[0]).toMatchObject({ author: 'Test Author' });
    expect(all[0]?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(all[0]!.date).toBeGreaterThan(1_600_000_000_000);
    const forFile = await h.call<{ subject: string }[]>('git:log', {
      path: path.join(dir, 'a.txt'),
      limit: 5,
    });
    expect(forFile.map((c) => c.subject)).toEqual(['initial']);
    const empty = harness(repo({}, false));
    expect(await empty.call('git:log')).toEqual([]);
  });

  it('pushes, fetches and pulls against a local remote, and policy can switch that off', async () => {
    const origin = temp('inc-git-origin-');
    git(origin, 'init', '-q', '--bare', '-b', 'main');
    const dir = repo({ 'a.txt': '1\n' });
    git(dir, 'remote', 'add', 'origin', origin);
    git(dir, 'push', '-q', '-u', 'origin', 'main');
    const other = temp('inc-git-other-');
    git(other, 'clone', '-q', origin, 'clone');
    const clone = path.join(other, 'clone');
    write(clone, 'from-clone.txt', 'x\n');
    git(clone, 'add', '-A');
    git(clone, 'commit', '-q', '-m', 'from clone');
    git(clone, 'push', '-q');

    const h = harness(dir);
    await h.call('git:fetch');
    expect((await h.status())?.repo).toMatchObject({ behind: 1, ahead: 0 });
    await h.call('git:pull');
    expect(existsSync(path.join(dir, 'from-clone.txt'))).toBe(true);
    write(dir, 'mine.txt', 'm\n');
    await h.call('git:stageAll');
    await h.call('git:commit', { message: 'mine' });
    expect((await h.status())?.repo.ahead).toBe(1);
    await h.call('git:push');
    expect((await h.status())?.repo.ahead).toBe(0);
    expect(git(origin, 'log', '-1', '--format=%s', 'main').trim()).toBe('mine');

    h.setPolicy({
      ...EMPTY_POLICY,
      active: true,
      features: { ...EMPTY_POLICY.features, gitRemoteOperations: false },
    });
    for (const op of ['git:fetch', 'git:pull', 'git:push']) {
      await expect(h.call(op)).rejects.toMatchObject({ code: 'E_POLICY' });
    }
    // Local operations still work.
    write(dir, 'local.txt', 'l\n');
    await h.call('git:stageAll');
  });

  it('turns remote failures into readable messages without credentials', async () => {
    const dir = repo({ 'a.txt': '1\n' });
    git(dir, 'remote', 'add', 'origin', 'https://user:secret@127.0.0.1:1/none.git');
    const h = harness(dir);
    const error = await h.call('git:fetch').catch((e: Error) => e);
    expect(error).toMatchObject({ code: 'E_GIT' });
    expect(String((error as Error).message)).not.toContain('secret');
    expect(JSON.stringify((error as { details?: unknown }).details ?? {})).not.toContain('secret');
  }, 30_000);

  it('blocks every write in an untrusted workspace but still reads', async () => {
    const dir = repo({ 'a.txt': '1\n' });
    write(dir, 'b.txt', 'new\n');
    const h = harness(dir, { trusted: false });
    expect(fileOf(await h.call<GitStatus>('git:status'), 'b.txt')).toBeTruthy();
    expect(await h.call<GitBranch[]>('git:branches')).toHaveLength(1);
    expect((await h.call<GitBlob>('git:show', path.join(dir, 'a.txt'), 'HEAD')).exists).toBe(true);
    expect(await h.call<unknown[]>('git:log')).toHaveLength(1);
    const writes: [string, ...unknown[]][] = [
      ['git:stage', [path.join(dir, 'b.txt')]],
      ['git:unstage', [path.join(dir, 'b.txt')]],
      ['git:discard', [path.join(dir, 'b.txt')]],
      ['git:stageAll'],
      ['git:unstageAll'],
      ['git:commit', { message: 'x' }],
      ['git:checkout', 'main'],
      ['git:createBranch', 'x'],
      ['git:fetch'],
      ['git:pull'],
      ['git:push'],
      ['git:init'],
    ];
    for (const [channel, ...args] of writes) {
      await expect(h.call(channel, ...args), channel).rejects.toMatchObject({
        code: 'E_UNTRUSTED',
      });
    }
    expect(existsSync(path.join(dir, 'b.txt'))).toBe(true);

    // Trusting the folder takes effect immediately.
    h.setTrusted(true);
    await h.call('git:stage', [path.join(dir, 'b.txt')]);
    expect(fileOf(await h.status(), 'b.txt')?.index).toBe('A');
  });

  it('does not run repository-configured code (fsmonitor) in an untrusted workspace', async () => {
    const dir = repo({ 'a.txt': '1\n' });
    const marker = path.join(temp('inc-git-marker-'), 'ran');
    const script = path.join(path.dirname(marker), 'hook.js');
    writeFileSync(
      script,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); console.log('');`,
    );
    git(dir, 'config', 'core.fsmonitor', `node "${script.replace(/\\/g, '/')}"`);
    git(dir, 'config', 'core.untrackedCache', 'true');

    // Control: Git really runs the configured command when nothing hardens it.
    git(dir, 'status', '--porcelain');
    expect(
      existsSync(marker),
      'the control run should execute the configured fsmonitor command',
    ).toBe(true);
    await rm(marker);

    await harness(dir, { trusted: false }).call('git:status');
    expect(existsSync(marker)).toBe(false);
  });

  it('pushes a status event when files change on disk, and not when nothing changed', async () => {
    const dir = repo({ 'a.txt': '1\n' });
    const h = harness(dir);
    await h.call('git:status');
    const count = () => h.sent.filter((s) => s.channel === 'git:statusChanged').length;
    const before = count();
    write(dir, 'a.txt', 'changed\n');
    h.emitFsChange(path.join(dir, 'a.txt'));
    await waitFor(() => count() > before);
    const last = h.sent.filter((s) => s.channel === 'git:statusChanged').at(-1)
      ?.payload as GitStatus;
    expect(fileOf(last, 'a.txt')).toMatchObject({ workingTree: 'M' });

    const settled = count();
    h.emitFsChange(path.join(dir, 'a.txt')); // same state again
    await new Promise((r) => setTimeout(r, 900));
    expect(count()).toBe(settled);
  });

  it('notices commits made outside the editor through the Git directory watcher', async () => {
    const dir = repo({ 'a.txt': '1\n' });
    const h = harness(dir);
    await h.call('git:status');
    write(dir, 'a.txt', '2\n');
    git(dir, 'commit', '-qam', 'outside');
    await waitFor(() => {
      const last = h.sent.filter((s) => s.channel === 'git:statusChanged').at(-1)?.payload as
        GitStatus | undefined;
      return last && last.files.length === 0 && last.repo.head !== '' && last;
    });
  });

  it('follows workspace changes and the git.enabled setting', async () => {
    const first = repo({ 'a.txt': '1\n' });
    const second = temp();
    const h = harness(first);
    expect((await h.call<GitStatus>('git:status')).repo.root).toBe(path.normalize(first));
    h.openRoot(second);
    expect(await h.call('git:status')).toBeNull();
    h.openRoot(first);
    expect((await h.call<GitStatus>('git:status')).repo.root).toBe(path.normalize(first));

    h.setSetting('git.enabled', false);
    expect(await h.call('git:status')).toBeNull();
    expect(await h.call('git:detect')).toMatchObject({ available: false });
    await expect(h.call('git:stageAll')).rejects.toMatchObject({ code: 'E_GIT' });
  });

  it('reports a missing Git executable clearly', async () => {
    const dir = repo({ 'a.txt': '1\n' });
    const h = harness(dir);
    h.setSetting('git.path', path.join(dir, 'definitely-not-git.exe'));
    const detect = await h.call<{ available: boolean; error?: string }>('git:detect');
    expect(detect.available).toBe(false);
    expect(detect.error).toMatch(/git\.path|Git/);
    await expect(h.call('git:refresh')).rejects.toMatchObject({ code: 'E_GIT_MISSING' });
  });
});
