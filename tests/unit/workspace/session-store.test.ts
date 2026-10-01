import { createHash } from 'node:crypto';
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_SESSION_BYTES,
  SESSION_RETENTION_MS,
  SessionStore,
} from '../../../src/main/workspace/session-store';
import { hostPlatform, recordingLogger, tempDir } from './helpers';

function store(userData = tempDir(), platform = hostPlatform) {
  const logger = recordingLogger();
  return { userData, logger, store: new SessionStore(userData, platform, (m) => logger.warn(m)) };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

describe('SessionStore', () => {
  it('round-trips a blob for a workspace', async () => {
    const { store: s } = store();
    const root = path.join(tempDir(), 'repo');
    const blob = { version: 1, data: { editor: { tabs: ['a.ts', 'b.ts'], active: 1 }, n: [1, 2] } };
    await s.save(root, blob);
    expect(await s.load(root)).toEqual(blob);
  });

  it('round-trips the empty-window session separately from workspaces', async () => {
    const { store: s, userData } = store();
    const root = path.join(tempDir(), 'repo');
    await s.save(null, { version: 1, data: 'empty' });
    await s.save(root, { version: 1, data: 'repo' });
    expect((await s.load(null))?.data).toBe('empty');
    expect((await s.load(root))?.data).toBe('repo');
    expect(existsSync(path.join(userData, 'sessions', 'empty.json'))).toBe(true);
  });

  it('names files by the sha1 of the normalised root', () => {
    const { store: s, userData } = store(undefined, 'linux');
    const root = '/work/repo';
    const expected = createHash('sha1').update('/work/repo').digest('hex');
    expect(s.fileFor(root)).toBe(path.join(userData, 'sessions', `${expected}.json`));
    expect(s.fileFor('/work/repo/')).toBe(s.fileFor(root));
  });

  it('shares a session between spellings of the same folder on case-insensitive platforms', () => {
    const win = store(undefined, 'win32').store;
    expect(win.fileFor('C:\\Work\\Repo')).toBe(win.fileFor('c:/work/repo/'));
    const linux = store(undefined, 'linux').store;
    expect(linux.fileFor('/Work/Repo')).not.toBe(linux.fileFor('/work/repo'));
  });

  it('returns null when nothing was saved', async () => {
    expect(await store().store.load(path.join(tempDir(), 'repo'))).toBeNull();
  });

  it('keeps the latest of several rapid saves', async () => {
    const { store: s } = store();
    const root = path.join(tempDir(), 'repo');
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => s.save(root, { version: 1, data: { i } })),
    );
    expect((await s.load(root))?.data).toEqual({ i: 11 });
  });

  it('returns null for a corrupt file and can overwrite it', async () => {
    const { store: s, logger } = store();
    const root = path.join(tempDir(), 'repo');
    await s.save(root, { version: 1, data: 1 });
    writeFileSync(s.fileFor(root), '{"format":1,"key":');
    expect(await s.load(root)).toBeNull();
    expect(logger.warnings).toHaveLength(1);
    await s.save(root, { version: 1, data: 2 });
    expect((await s.load(root))?.data).toBe(2);
  });

  it.each([
    ['another format', { format: 2, key: null, savedAt: 1, blob: { version: 1, data: 1 } }],
    ['no blob', { format: 1, key: null, savedAt: 1 }],
    ['a bad version', { format: 1, key: null, savedAt: 1, blob: { version: 'x', data: 1 } }],
    ['a zero version', { format: 1, key: null, savedAt: 1, blob: { version: 0, data: 1 } }],
    ['no data', { format: 1, key: null, savedAt: 1, blob: { version: 1 } }],
    ['an array', [1, 2, 3]],
  ])('returns null for a file with %s', async (_name, content) => {
    const { store: s } = store();
    await s.save(null, { version: 1, data: 1 });
    writeFileSync(s.fileFor(null), JSON.stringify(content));
    expect(await s.load(null)).toBeNull();
  });

  it('returns null for a file written for a different workspace', async () => {
    const { store: s } = store();
    const a = path.join(tempDir(), 'a');
    const b = path.join(tempDir(), 'b');
    await s.save(a, { version: 1, data: 'a' });
    // Simulate a hash collision or a copied file.
    writeFileSync(s.fileFor(b), readFileSync(s.fileFor(a)));
    expect(await s.load(b)).toBeNull();
  });

  it('refuses blobs above the size cap with E_TOO_LARGE and keeps the old session', async () => {
    const { store: s } = store();
    await s.save(null, { version: 1, data: 'small' });
    const big = { version: 1, data: 'x'.repeat(MAX_SESSION_BYTES + 1) };
    expect(await codeOf(s.save(null, big))).toBe('E_TOO_LARGE');
    expect((await s.load(null))?.data).toBe('small');
  });

  it('accepts a blob just under the cap', async () => {
    const { store: s } = store();
    const overhead = Buffer.byteLength(JSON.stringify({ version: 1, data: '' }));
    const data = 'y'.repeat(MAX_SESSION_BYTES - overhead);
    await s.save(null, { version: 1, data });
    expect((await s.load(null))?.data).toBe(data);
  });

  it('counts bytes, not characters', async () => {
    const { store: s } = store();
    const data = '\u20ac'.repeat(Math.ceil(MAX_SESSION_BYTES / 3) + 10);
    expect(data.length).toBeLessThan(MAX_SESSION_BYTES);
    expect(await codeOf(s.save(null, { version: 1, data }))).toBe('E_TOO_LARGE');
  });

  it('ignores an oversized file on disk', async () => {
    const { store: s } = store();
    await s.save(null, { version: 1, data: 1 });
    writeFileSync(s.fileFor(null), 'z'.repeat(MAX_SESSION_BYTES + 100_000));
    expect(await s.load(null)).toBeNull();
  });

  it.each([
    ['null', null],
    ['a string', 'x'],
    ['an array', []],
    ['no version', { data: 1 }],
    ['a fractional version', { version: 1.5, data: 1 }],
    ['a negative version', { version: -1, data: 1 }],
    ['no data', { version: 1 }],
  ])('rejects %s with E_INVALID', async (_name, blob) => {
    expect(await codeOf(store().store.save(null, blob))).toBe('E_INVALID');
  });

  it('rejects data that cannot be serialised', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(await codeOf(store().store.save(null, { version: 1, data: cyclic }))).toBe('E_INVALID');
    expect(await codeOf(store().store.save(null, { version: 1, data: 10n }))).toBe('E_INVALID');
  });

  it('leaves no temporary files behind', async () => {
    const { store: s, userData } = store();
    await s.save(null, { version: 1, data: 1 });
    await s.save(null, { version: 1, data: 2 });
    expect(readdirSync(path.join(userData, 'sessions'))).toEqual(['empty.json']);
  });

  describe('pruneStale', () => {
    it('removes only old session files', async () => {
      const { store: s, userData } = store();
      const oldRoot = path.join(tempDir(), 'old');
      const freshRoot = path.join(tempDir(), 'fresh');
      await s.save(oldRoot, { version: 1, data: 1 });
      await s.save(freshRoot, { version: 1, data: 1 });
      const stray = path.join(userData, 'sessions', 'notes.txt');
      writeFileSync(stray, 'keep');
      const past = new Date(Date.now() - SESSION_RETENTION_MS - 86_400_000);
      utimesSync(s.fileFor(oldRoot), past, past);
      utimesSync(stray, past, past);

      expect(await s.pruneStale()).toBe(1);
      expect(existsSync(s.fileFor(oldRoot))).toBe(false);
      expect(statSync(s.fileFor(freshRoot)).isFile()).toBe(true);
      expect(existsSync(stray)).toBe(true);
    });

    it('is a no-op without a sessions folder', async () => {
      expect(await store().store.pruneStale()).toBe(0);
    });
  });
});
