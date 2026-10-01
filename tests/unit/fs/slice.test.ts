import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AppInfo } from '@shared/api/app';
import type { FsChange } from '@shared/api/fs';
import { defaultSettings } from '@shared/settings';
import type { InvokeChannel } from '@shared/ipc';
import {
  Emitter,
  createDefaultPolicyHost,
  type Handler,
  type Kernel,
  type SettingsHost,
} from '../../../src/main/kernel';
import { register } from '../../../src/main/fs';
import { hostPlatform, tempDir, waitFor, writeTree } from './helpers';

const trashed: string[] = [];
vi.mock('electron', () => ({
  shell: {
    trashItem: async (target: string) => void trashed.push(target),
    showItemInFolder: vi.fn(),
  },
}));

function harness(root: string | null) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const sent: { channel: string; payload: unknown }[] = [];
  const values = { ...defaultSettings() } as Record<string, unknown>;
  const settingChanges = new Emitter<{ windowId: number | null; keys: string[] }>();
  const rootChanges = new Emitter<{ windowId: number; root: string | null }>();
  const fsChanges = new Emitter<{ windowId: number; changes: FsChange[] }>();
  const batches: FsChange[][] = [];
  fsChanges.on((e) => void batches.push(e.changes));
  let currentRoot = root;

  const settings: SettingsHost = {
    get: ((_id: number | null, key: string) => values[key]) as SettingsHost['get'],
    snapshot: () => null,
    onDidChange: (cb) => settingChanges.on(cb as never),
  };
  const kernel = {
    info: { platform: hostPlatform } as AppInfo,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    settings,
    policy: createDefaultPolicyHost(),
    workspaces: {
      getRoot: () => currentRoot,
      getLastOpened: () => null,
      setRoot: () => undefined,
      isTrusted: () => true,
      setTrusted: () => undefined,
      onDidChangeRoot: (cb: (e: { windowId: number; root: string | null }) => void) =>
        rootChanges.on(cb),
      onDidChangeTrust: () => () => undefined,
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
    getWindowIds: () => [1],
    onWindowCreated: () => () => undefined,
    onWindowClosed: () => () => undefined,
  } as unknown as Kernel;

  const dispose = register(kernel);
  return {
    sent,
    batches,
    dispose,
    call: async (channel: string, ...args: unknown[]) => handlers.get(channel)!(...args),
    setSetting(key: string, value: unknown) {
      values[key] = value;
      settingChanges.emit({ windowId: null, keys: [key] });
    },
    openRoot(next: string | null) {
      currentRoot = next;
      rootChanges.emit({ windowId: 1, root: next });
    },
  };
}

describe('fs slice', () => {
  it('reads, writes, copies, renames and stats files through the handlers', async () => {
    const root = tempDir();
    const h = harness(root);
    const file = path.join(root, 'notes', 'a.txt');

    await expect(h.call('fs:writeFile', file, 'x')).rejects.toBeTruthy(); // the folder does not exist yet
    const written = (await h.call('fs:writeFile', file, 'one\r\ntwo\r\n', {
      createDirs: true,
    })) as { size: number };
    expect(written.size).toBe(10);

    const read = (await h.call('fs:readFile', file)) as {
      content: string;
      eol: string;
      kind: string;
    };
    expect(read).toMatchObject({ kind: 'text', content: 'one\r\ntwo\r\n', eol: 'crlf' });

    await h.call('fs:copy', file, path.join(root, 'b.txt'));
    await h.call('fs:rename', path.join(root, 'b.txt'), path.join(root, 'c.txt'));
    expect(readFileSync(path.join(root, 'c.txt'), 'utf8')).toBe('one\r\ntwo\r\n');
    await expect(h.call('fs:exists', path.join(root, 'b.txt'))).resolves.toBe(false);
    expect(((await h.call('fs:stat', file)) as { kind: string }).kind).toBe('file');

    const bytes = (await h.call('fs:readBytes', file)) as Uint8Array;
    expect(bytes.length).toBe(10);
    h.dispose();
  });

  it('rejects relative paths and conflicting writes', async () => {
    const root = tempDir();
    writeTree(root, { 'a.txt': 'x' });
    const h = harness(root);
    await expect(h.call('fs:readFile', 'a.txt')).rejects.toMatchObject({ code: 'E_INVALID' });
    await expect(h.call('fs:readDir', '../x')).rejects.toMatchObject({ code: 'E_INVALID' });
    const file = path.join(root, 'a.txt');
    const before = statSync(file).mtimeMs;
    await expect(
      h.call('fs:writeFile', file, 'y', { expectedMtimeMs: before - 5000 }),
    ).rejects.toMatchObject({
      code: 'E_MODIFIED_SINCE',
    });
    expect(readFileSync(file, 'utf8')).toBe('x');
    h.dispose();
  });

  it('lists folders first and applies files.exclude only inside the workspace', async () => {
    const root = tempDir();
    writeTree(root, {
      'z.txt': '',
      'a/inner.txt': '',
      'node_modules/p/i.js': '',
      '.git/config': '',
    });
    const h = harness(root);
    h.setSetting('files.exclude', { '**/node_modules': true, '**/.git': true });
    const names = ((await h.call('fs:readDir', root)) as { name: string }[]).map((e) => e.name);
    expect(names).toEqual(['a', 'z.txt']);
    const all = (
      (await h.call('fs:readDir', root, { applyExcludes: false })) as { name: string }[]
    ).map((e) => e.name);
    expect(all).toContain('node_modules');
    h.dispose();
  });

  it('refuses to trash the workspace folder and trashes other paths', async () => {
    const root = tempDir();
    writeTree(root, { 'a.txt': '' });
    const h = harness(root);
    await expect(h.call('fs:trash', [root])).rejects.toBeTruthy();
    await h.call('fs:trash', [path.join(root, 'a.txt')]);
    expect(trashed).toContain(path.join(root, 'a.txt'));
    h.dispose();
  });

  it('serves quick-open searches from the index and follows root changes', async () => {
    const first = tempDir();
    const second = tempDir();
    writeTree(first, { 'src/alpha.ts': '' });
    writeTree(second, { 'lib/beta.ts': '' });
    const h = harness(first);
    type Search = { items: { relativePath: string }[]; indexing: boolean };
    await waitFor(() => h.sent.some((s) => s.channel === 'files:indexProgress'));
    const alpha = await vi.waitFor(async () => {
      const result = (await h.call('files:search', 'alpha')) as Search;
      expect(result.items[0]?.relativePath).toBe('src/alpha.ts');
      return result;
    });
    expect(alpha.items).toHaveLength(1);

    h.openRoot(second);
    await vi.waitFor(async () => {
      expect(((await h.call('files:search', 'beta')) as Search).items[0]?.relativePath).toBe(
        'lib/beta.ts',
      );
      expect(((await h.call('files:search', 'alpha')) as Search).items).toEqual([]);
    });
    h.openRoot(null);
    expect(((await h.call('files:search', 'beta')) as Search).items).toEqual([]);
    h.dispose();
  });

  it('delivers file changes to the window, the kernel and the index', async () => {
    const root = tempDir();
    writeTree(root, { 'existing.txt': '' });
    const h = harness(root);
    await vi.waitFor(async () => {
      expect(
        ((await h.call('files:search', 'existing')) as { items: unknown[] }).items,
      ).toHaveLength(1);
    });
    // Let the native watcher finish subscribing before changing files.
    await new Promise((r) => setTimeout(r, 400));
    writeFileSync(path.join(root, 'fresh.txt'), 'hello');

    await waitFor(() =>
      h.sent.some(
        (s) =>
          s.channel === 'fs:changed' &&
          (s.payload as FsChange[]).some((c) => c.path.endsWith('fresh.txt')),
      ),
    );
    expect(h.batches.flat().some((c) => c.path.endsWith('fresh.txt'))).toBe(true);
    await vi.waitFor(async () => {
      expect(((await h.call('files:search', 'fresh')) as { items: unknown[] }).items).toHaveLength(
        1,
      );
    });
    h.dispose();
  });

  it('resolves EditorConfig only when the setting is on and picks up edits', async () => {
    const root = tempDir();
    writeTree(root, {
      '.editorconfig':
        'root = true\n[*.ts]\nindent_style = space\nindent_size = 2\nend_of_line = crlf\n',
      'a.ts': '',
    });
    const h = harness(root);
    const file = path.join(root, 'a.ts');
    expect(await h.call('editorconfig:resolve', file)).toMatchObject({
      indentStyle: 'space',
      indentSize: 2,
      endOfLine: 'crlf',
    });
    expect(await h.call('editorconfig:resolve', path.join(root, 'a.md'))).toBeNull();
    h.setSetting('files.useEditorConfig', false);
    expect(await h.call('editorconfig:resolve', file)).toBeNull();
    h.dispose();
  });

  it('watches extra paths and enforces absolute paths', async () => {
    const root = tempDir();
    const other = tempDir();
    writeTree(root, { 'a.txt': '' });
    const h = harness(root);
    await expect(h.call('fs:watch', 'relative', true)).rejects.toMatchObject({ code: 'E_INVALID' });
    const handle = (await h.call('fs:watch', other, true)) as number;
    expect(handle).toBeGreaterThan(0);
    await h.call('fs:unwatch', handle);
    await expect(h.call('fs:watch', path.join(other, 'missing'), true)).rejects.toMatchObject({
      code: 'E_NOT_FOUND',
    });
    h.dispose();
  });
});
