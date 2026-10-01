import { buildSync } from 'esbuild';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AppInfo } from '@shared/api/app';
import type { FileMatches, ReplaceResult, SearchQuery, SearchStats } from '@shared/api/search';
import type { InvokeChannel } from '@shared/ipc';
import { defaultSettings } from '@shared/settings';
import {
  Emitter,
  createDefaultPolicyHost,
  type Handler,
  type Kernel,
} from '../../../src/main/kernel';
import { register } from '../../../src/main/search';

const created: string[] = [];
let workerDir = '';

beforeAll(() => {
  workerDir = mkdtempSync(path.join(os.tmpdir(), 'inc-search-worker-'));
  buildSync({
    entryPoints: ['src/main/search/search.worker.ts'],
    outfile: path.join(workerDir, 'search.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    mainFields: ['module', 'main'],
    tsconfig: 'tsconfig.main.json',
    logLevel: 'error',
  });
});

afterAll(() => rmSync(workerDir, { recursive: true, force: true }));

const disposers: (() => void)[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  for (const dir of created.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  }
});

function workspace(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'inc-search-'));
  created.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

interface Run {
  files: FileMatches[];
  stats: SearchStats;
  searchId: number;
}

function harness(root: string | null, overrides: Record<string, unknown> = {}) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const results: { searchId: number; files: FileMatches[] }[] = [];
  const done: { searchId: number; stats: SearchStats }[] = [];
  const values: Record<string, unknown> = { ...defaultSettings(), ...overrides };
  const rootChanges = new Emitter<{ windowId: number; root: string | null }>();
  const closed = new Emitter<number>();

  const kernel = {
    info: { platform: process.platform } as AppInfo,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    settings: {
      get: (_id: number | null, key: string) => values[key],
      snapshot: () => null,
      onDidChange: () => () => undefined,
    },
    policy: createDefaultPolicyHost(),
    workspaces: {
      getRoot: () => root,
      getLastOpened: () => null,
      setRoot: () => undefined,
      isTrusted: () => true,
      setTrusted: () => undefined,
      onDidChangeRoot: (cb: (e: { windowId: number; root: string | null }) => void) =>
        rootChanges.on(cb),
      onDidChangeTrust: () => () => undefined,
    },
    fsChanges: new Emitter(),
    handle<K extends InvokeChannel>(channel: K, handler: Handler<K>) {
      handlers.set(channel, (...args: unknown[]) =>
        (handler as (...a: unknown[]) => unknown)({ windowId: 1 }, ...args),
      );
    },
    send: ((_id: number, channel: string, payload: never) => {
      if (channel === 'search:results') results.push(payload);
      if (channel === 'search:done') done.push(payload);
    }) as Kernel['send'],
    broadcast: () => undefined,
    getWindow: () => undefined,
    getWindowIds: () => [1],
    onWindowCreated: () => () => undefined,
    onWindowClosed: (cb: (id: number) => void) => closed.on(cb),
  } as unknown as Kernel;

  const dispose = register(kernel, { workerPath: path.join(workerDir, 'search.js') });
  disposers.push(dispose);
  const call = async (channel: string, ...args: unknown[]) => handlers.get(channel)!(...args);

  const query = (pattern: string, extra: Partial<SearchQuery> = {}): SearchQuery => ({
    pattern,
    isRegex: false,
    caseSensitive: false,
    wholeWord: false,
    include: [],
    exclude: [],
    ...extra,
  });

  async function search(pattern: string, extra: Partial<SearchQuery> = {}): Promise<Run> {
    const { searchId } = (await call('search:start', query(pattern, extra))) as {
      searchId: number;
    };
    const finished = await waitDone(searchId);
    const files = results.filter((r) => r.searchId === searchId).flatMap((r) => r.files);
    return { files, stats: finished.stats, searchId };
  }

  async function waitDone(searchId: number) {
    const end = Date.now() + 20_000;
    for (;;) {
      const hit = done.find((d) => d.searchId === searchId);
      if (hit) return hit;
      if (Date.now() > end) throw new Error('search did not finish');
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  return { call, search, query, results, done, rootChanges, closed, waitDone };
}

const names = (run: Run) => run.files.map((f) => f.relativePath).sort();

describe('search:start', () => {
  it('finds literal, case-insensitive matches with correct positions', async () => {
    const root = workspace({
      'a.txt': 'Hello World\nsay hello again\n',
      'sub/b.txt': 'nothing here',
    });
    const h = harness(root);
    const run = await h.search('hello');
    expect(names(run)).toEqual(['a.txt']);
    expect(run.files[0]?.matches.map((m) => [m.line, m.column, m.length])).toEqual([
      [1, 1, 5],
      [2, 5, 5],
    ]);
    expect(run.stats).toMatchObject({
      matchCount: 2,
      filesMatched: 1,
      cancelled: false,
      limitHit: false,
    });
    expect(run.stats.filesSearched).toBe(2);
    expect(run.files[0]?.matches[0]).toMatchObject({
      preview: 'Hello World',
      previewMatchStart: 0,
      previewMatchEnd: 5,
    });
  });

  it('honours case sensitivity, whole word and regular expressions', async () => {
    const root = workspace({ 'a.ts': 'Foo foo FOOD food_bar\nfoobar\n' });
    const h = harness(root);
    const sensitive = await h.search('foo', { caseSensitive: true });
    expect(sensitive.files[0]?.matches).toHaveLength(3); // foo, food_bar, foobar
    const word = await h.search('foo', { wholeWord: true });
    expect(word.files[0]?.matches.map((m) => m.column)).toEqual([1, 5]);
    const regex = await h.search('fo+(?=bar)', { isRegex: true });
    expect(regex.files[0]?.matches.map((m) => [m.line, m.column])).toEqual([[2, 1]]);
    const anchored = await h.search('^foobar$', { isRegex: true });
    expect(anchored.stats.matchCount).toBe(1);
  });

  it('rejects an invalid regular expression and a multi-line pattern with a readable message', async () => {
    const h = harness(workspace({ 'a.txt': 'x' }));
    await expect(h.call('search:start', h.query('(', { isRegex: true }))).rejects.toMatchObject({
      code: 'E_INVALID',
      message: expect.stringContaining('Invalid regular expression'),
    });
    await expect(h.call('search:start', h.query('a\nb'))).rejects.toMatchObject({
      code: 'E_INVALID',
    });
    await expect(h.call('search:start', h.query(''))).rejects.toMatchObject({ code: 'E_INVALID' });
    const none = harness(null);
    await expect(none.call('search:start', none.query('x'))).rejects.toMatchObject({
      code: 'E_NO_WORKSPACE',
    });
  });

  it('applies include and exclude globs and the search.exclude setting', async () => {
    const root = workspace({
      'src/app.ts': 'needle',
      'src/app.test.ts': 'needle',
      'src/deep/util.ts': 'needle',
      'docs/guide.md': 'needle',
      'node_modules/pkg/index.js': 'needle',
    });
    const h = harness(root, { 'search.exclude': { '**/node_modules': true } });
    expect(names(await h.search('needle'))).toEqual([
      'docs/guide.md',
      'src/app.test.ts',
      'src/app.ts',
      'src/deep/util.ts',
    ]);
    expect(names(await h.search('needle', { include: ['src'] }))).toEqual([
      'src/app.test.ts',
      'src/app.ts',
      'src/deep/util.ts',
    ]);
    expect(names(await h.search('needle', { include: ['*.md'] }))).toEqual(['docs/guide.md']);
    expect(
      names(await h.search('needle', { include: ['src'], exclude: ['*.test.ts', 'src/deep'] })),
    ).toEqual(['src/app.ts']);
  });

  it('follows nested .gitignore files including negations, and can ignore them', async () => {
    const files = {
      '.gitignore': 'build/\n*.log\n',
      'build/out.js': 'needle',
      'x.log': 'needle',
      'keep.txt': 'needle',
      'pkg/.gitignore': 'secret.txt\n!important.log\n',
      'pkg/secret.txt': 'needle',
      'pkg/important.log': 'needle',
      'pkg/ok.txt': 'needle',
    };
    const h = harness(workspace(files));
    expect(names(await h.search('needle'))).toEqual([
      'keep.txt',
      'pkg/important.log',
      'pkg/ok.txt',
    ]);
    const all = harness(workspace(files), { 'search.useIgnoreFiles': false });
    expect(names(await all.search('needle'))).toEqual([
      'build/out.js',
      'keep.txt',
      'pkg/important.log',
      'pkg/ok.txt',
      'pkg/secret.txt',
      'x.log',
    ]);
  });

  it('skips binary and oversized files and reports it', async () => {
    const root = workspace({
      'text.txt': 'needle',
      'bin.dat': Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0x01, 0x02]),
      'huge.txt': Buffer.alloc(11 * 1024 * 1024, 'needle '),
    });
    const run = await harness(root).search('needle');
    expect(names(run)).toEqual(['text.txt']);
    expect(run.stats.filesSkipped).toMatchObject({ binary: 1, large: 1 });
  });

  it('reports UTF-16 columns for tabs, CRLF files and astral characters', async () => {
    const root = workspace({
      'crlf.txt': 'one\r\ntwo needle\r\n\tthree needle\r\n',
      'astral.txt': 'a\u{1F600}b needle',
      'utf16.txt': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('x needle', 'utf16le')]),
    });
    const run = await harness(root).search('needle');
    const by = (name: string) =>
      run.files.find((f) => f.relativePath === name)?.matches.map((m) => [m.line, m.column]);
    expect(by('crlf.txt')).toEqual([
      [2, 5],
      [3, 8],
    ]);
    expect(by('astral.txt')).toEqual([[1, 6]]); // the emoji is two UTF-16 code units
    expect(by('utf16.txt')).toEqual([[1, 3]]);
  });

  it('trims long lines to a window around the match and caps matches per line', async () => {
    const root = workspace({
      'long.txt': `${'x'.repeat(500)}needle${'y'.repeat(500)}\n`,
      'many.txt': 'a'.repeat(1000) + '\n',
    });
    const h = harness(root);
    const long = (await h.search('needle')).files[0]?.matches[0];
    expect(long?.preview.length).toBeLessThan(400);
    expect(long?.preview.slice(long.previewMatchStart, long.previewMatchEnd)).toBe('needle');
    const many = (await h.search('a')).files[0]?.matches;
    expect(many?.length).toBeLessThanOrEqual(100);
  });

  it('stops at the result limit and says so', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 30; i++) files[`f${i}.txt`] = 'hit\nhit\nhit\n';
    const h = harness(workspace(files));
    const run = await h.search('hit', { maxResults: 25 });
    expect(run.stats.limitHit).toBe(true);
    expect(run.stats.cancelled).toBe(false);
    expect(run.stats.matchCount).toBe(25);
    expect(run.files.reduce((n, f) => n + f.matches.length, 0)).toBe(25);
  });

  it('a new search cancels the previous one, and cancel ends promptly', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 3000; i++) files[`d${i % 50}/f${i}.txt`] = `line ${i}\nneedle ${i}\n`;
    const h = harness(workspace(files));
    const first = (await h.call('search:start', h.query('needle'))) as { searchId: number };
    const second = (await h.call('search:start', h.query('line'))) as { searchId: number };
    const firstDone = await h.waitDone(first.searchId);
    expect(firstDone.stats.cancelled).toBe(true);
    const secondDone = await h.waitDone(second.searchId);
    expect(secondDone.stats.cancelled).toBe(false);
    expect(secondDone.stats.matchCount).toBe(3000);

    const third = (await h.call('search:start', h.query('needle'))) as { searchId: number };
    const started = Date.now();
    await h.call('search:cancel', third.searchId);
    const thirdDone = await h.waitDone(third.searchId);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(thirdDone.stats.cancelled).toBe(true);
  });

  it('is cancelled when the workspace changes', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 2000; i++) files[`d${i % 40}/f${i}.txt`] = 'needle';
    const h = harness(workspace(files));
    const { searchId } = (await h.call('search:start', h.query('needle'))) as { searchId: number };
    h.rootChanges.emit({ windowId: 1, root: null });
    expect((await h.waitDone(searchId)).stats.cancelled).toBe(true);
  });

  it('streams first results early on a large tree and finishes within seconds', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 8000; i++)
      files[`pkg${i % 80}/m${i % 20}/file${i}.ts`] = `export const v${i} = ${i};\n`;
    files['pkg0/m0/target.ts'] = 'const rare_marker = 1;\n';
    const h = harness(workspace(files));
    const started = Date.now();
    const run = await h.search('rare_marker');
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(names(run)).toEqual(['pkg0/m0/target.ts']);
    expect(run.stats.filesSearched).toBe(8001);
  }, 60_000);
});

describe('search:replace', () => {
  const request = (h: ReturnType<typeof harness>, root: string, extra: object) => ({
    query: h.query('needle'),
    replacement: 'pin',
    files: [] as { path: string; expectedMtimeMs?: number }[],
    ...extra,
    root,
  });

  it('replaces literally and keeps CRLF line endings, UTF-8 BOM and UTF-16', async () => {
    const root = workspace({
      'crlf.txt': 'needle\r\nsecond needle\r\n',
      'bom.txt': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('needle ünï\n')]),
      'utf16.txt': Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from('a needle\r\n', 'utf16le'),
      ]),
      'untouched.txt': 'nothing\n',
    });
    const h = harness(root);
    const files = ['crlf.txt', 'bom.txt', 'utf16.txt', 'untouched.txt'].map((f) => ({
      path: path.join(root, f),
    }));
    const result = (await h.call('search:replace', request(h, root, { files }))) as ReplaceResult;
    expect(result.filesChanged).toBe(3);
    expect(result.replacements).toBe(4);
    // A file with no matches is reported rather than silently ignored.
    expect(result.skipped.map((x) => [path.basename(x.path), x.reason])).toEqual([
      ['untouched.txt', expect.stringMatching(/No matches/)],
    ]);
    expect(readFileSync(path.join(root, 'crlf.txt'), 'utf8')).toBe('pin\r\nsecond pin\r\n');
    const bom = readFileSync(path.join(root, 'bom.txt'));
    expect([...bom.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bom.subarray(3).toString('utf8')).toBe('pin ünï\n');
    const u16 = readFileSync(path.join(root, 'utf16.txt'));
    expect([...u16.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(u16.subarray(2).toString('utf16le')).toBe('a pin\r\n');
    expect(readFileSync(path.join(root, 'untouched.txt'), 'utf8')).toBe('nothing\n');
  });

  it('expands capture groups, $& and $$ for regular expressions', async () => {
    const root = workspace({ 'a.txt': 'name: Ada, name: Bob\n' });
    const h = harness(root);
    const result = (await h.call('search:replace', {
      query: h.query('name: (\\w+)', { isRegex: true }),
      replacement: '$1 ($&) costs $$5',
      files: [{ path: path.join(root, 'a.txt') }],
    })) as ReplaceResult;
    expect(result.replacements).toBe(2);
    expect(readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe(
      'Ada (name: Ada) costs $5, Bob (name: Bob) costs $5\n',
    );
  });

  it('treats the replacement literally for non-regex queries', async () => {
    const root = workspace({ 'a.txt': 'needle\n' });
    const h = harness(root);
    await h.call('search:replace', {
      query: h.query('needle'),
      replacement: '$1 $& $$',
      files: [{ path: path.join(root, 'a.txt') }],
    });
    expect(readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('$1 $& $$\n');
  });

  it('skips files that changed since they were searched, and files outside the workspace', async () => {
    const root = workspace({ 'a.txt': 'needle\n', 'b.txt': 'needle\n' });
    const outside = workspace({ 'o.txt': 'needle\n' });
    const h = harness(root);
    const a = path.join(root, 'a.txt');
    const stale = statSync(a).mtimeMs;
    const later = new Date(Date.now() + 60_000);
    utimesSync(a, later, later);
    const result = (await h.call('search:replace', {
      query: h.query('needle'),
      replacement: 'pin',
      files: [
        { path: a, expectedMtimeMs: stale },
        {
          path: path.join(root, 'b.txt'),
          expectedMtimeMs: statSync(path.join(root, 'b.txt')).mtimeMs,
        },
        { path: path.join(outside, 'o.txt') },
        { path: 'relative.txt' },
      ],
    })) as ReplaceResult;
    expect(result.filesChanged).toBe(1);
    expect(result.skipped.map((s) => path.basename(s.path)).sort()).toEqual([
      'a.txt',
      'o.txt',
      'relative.txt',
    ]);
    expect(result.skipped.find((s) => s.path === a)?.reason).toMatch(/changed/i);
    expect(readFileSync(a, 'utf8')).toBe('needle\n');
    expect(readFileSync(path.join(outside, 'o.txt'), 'utf8')).toBe('needle\n');
    expect(readFileSync(path.join(root, 'b.txt'), 'utf8')).toBe('pin\n');
  });

  it('rejects malformed requests', async () => {
    const h = harness(workspace({ 'a.txt': 'x' }));
    await expect(h.call('search:replace', null)).rejects.toMatchObject({ code: 'E_INVALID' });
    await expect(
      h.call('search:replace', { query: h.query('x'), replacement: 1, files: [] }),
    ).rejects.toMatchObject({ code: 'E_INVALID' });
    const empty = (await h.call('search:replace', {
      query: h.query('x'),
      replacement: 'y',
      files: [],
    })) as ReplaceResult;
    expect(empty).toEqual({ filesChanged: 0, replacements: 0, skipped: [] });
  });
});
