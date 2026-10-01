import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapEditorConfig } from '../../../src/main/fs/editorconfig';
import { FileIndex } from '../../../src/main/fs/file-index';
import { hostPlatform, tempDir, waitFor, writeTree } from './helpers';

function makeIndex(root: string, opts: { git?: boolean; excludes?: Record<string, boolean> } = {}) {
  const progress: { indexing: boolean; count: number }[] = [];
  const index = new FileIndex({
    root,
    platform: hostPlatform,
    getExcludes: () => opts.excludes ?? { '**/node_modules': true },
    gitPath: opts.git ? 'git' : null,
    onProgress: (p) => void progress.push(p),
  });
  return { index, progress };
}

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const TREE = {
  'src/index.ts': '',
  'src/app/main.ts': '',
  'src/app/main.test.ts': '',
  'src/inline/dx/foo.ts': '',
  'docs/readme.md': '',
  'node_modules/dep/index.js': '',
  'dist/out.js': '',
  '.gitignore': 'dist/\n*.log\n',
  'logs/app.log': '',
};

describe('FileIndex (directory walk)', () => {
  it('honours .gitignore and files.exclude and reports progress', async () => {
    const root = tempDir();
    writeTree(root, TREE);
    const { index, progress } = makeIndex(root);
    await index.build();
    expect(index.indexing).toBe(false);
    const all = index.search('s', 100).items.map((i) => i.relativePath);
    expect(all).toContain('src/index.ts');
    expect(all.some((p) => p.startsWith('node_modules/'))).toBe(false);
    expect(all.some((p) => p.startsWith('dist/'))).toBe(false);
    expect(all).not.toContain('logs/app.log');
    expect(progress.at(-1)).toEqual({ indexing: false, count: index.size });
    expect(progress[0]).toEqual({ indexing: true, count: 0 });
  });

  it('ranks a file-name match above a scattered path match and returns match positions', async () => {
    const root = tempDir();
    writeTree(root, TREE);
    const { index } = makeIndex(root);
    await index.build();
    const result = index.search('idx', 10);
    expect(result.items[0]?.relativePath).toBe('src/index.ts');
    expect(result.items[0]?.positions.length).toBe(3);
    expect(result.items[0]?.path).toBe(path.join(root, 'src/index.ts'));
    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result.indexedCount).toBe(index.size);
  });

  it('returns nothing for an empty query and caps the limit', async () => {
    const root = tempDir();
    writeTree(root, TREE);
    const { index } = makeIndex(root);
    await index.build();
    expect(index.search('   ', 10).items).toEqual([]);
    const limited = index.search('s', 2);
    expect(limited.items).toHaveLength(2);
    expect(limited.total).toBeGreaterThan(2);
  });

  it('applies create and delete batches incrementally, including whole folders', async () => {
    const root = tempDir();
    writeTree(root, TREE);
    const { index } = makeIndex(root);
    await index.build();

    writeFileSync(path.join(root, 'src/added.ts'), '');
    await index.apply([{ type: 'create', path: path.join(root, 'src/added.ts') }]);
    expect(index.search('added', 5).items[0]?.relativePath).toBe('src/added.ts');

    mkdirSync(path.join(root, 'pkg/inner'), { recursive: true });
    writeFileSync(path.join(root, 'pkg/inner/deep.ts'), '');
    await index.apply([{ type: 'create', path: path.join(root, 'pkg') }]);
    expect(index.search('deep', 5).items[0]?.relativePath).toBe('pkg/inner/deep.ts');

    await index.apply([{ type: 'delete', path: path.join(root, 'src/app') }]);
    const left = index.search('main', 10).items.map((i) => i.relativePath);
    expect(left).toEqual([]);

    // Excluded and out-of-root paths are ignored.
    writeTree(root, { 'node_modules/x/y.js': '' });
    await index.apply([{ type: 'create', path: path.join(root, 'node_modules/x/y.js') }]);
    expect(index.search('y.js', 5).items).toEqual([]);
    await index.apply([{ type: 'create', path: path.join(path.dirname(root), 'elsewhere.ts') }]);
  });

  it('rebuilds on a resync change', async () => {
    const root = tempDir();
    writeTree(root, { 'a.ts': '' });
    const { index } = makeIndex(root);
    await index.build();
    writeTree(root, { 'b.ts': '' });
    rmSync(path.join(root, 'a.ts'));
    await index.apply([{ type: 'update', path: root, resync: true }]);
    await waitFor(() => !index.indexing && index.search('b.ts', 5).items.length > 0);
    expect(index.search('a.ts', 5).items.map((i) => i.relativePath)).not.toContain('a.ts');
  });

  it('searches a large generated index quickly', async () => {
    const root = tempDir();
    const files: Record<string, string> = {};
    for (let d = 0; d < 40; d++) {
      for (let f = 0; f < 100; f++) files[`pkg${d}/module${f}/component${f}.ts`] = '';
    }
    writeTree(root, files);
    const { index } = makeIndex(root);
    await index.build();
    expect(index.size).toBe(4000);
    index.search('warmup', 10);
    const started = performance.now();
    const result = index.search('p3m9c', 50);
    const elapsed = performance.now() - started;
    expect(result.items.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(150);
  });
});

describe.skipIf(!gitAvailable())('FileIndex (git ls-files)', () => {
  it('lists tracked and untracked files, skips ignored ones, and works from a sub folder', async () => {
    const root = tempDir();
    writeTree(root, {
      ...TREE,
      'packages/web/app.ts': '',
      'packages/web/.gitignore': 'secret.ts\n',
    });
    writeTree(root, { 'packages/web/secret.ts': '' });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git('init', '-q');
    git('add', 'src/index.ts');

    const whole = makeIndex(root, { git: true }).index;
    await whole.build();
    const names = whole.search('s', 100).items.map((i) => i.relativePath);
    expect(names).toContain('src/index.ts'); // tracked
    expect(names).toContain('docs/readme.md'); // untracked but not ignored
    expect(names).not.toContain('dist/out.js'); // ignored by .gitignore
    expect(names).not.toContain('packages/web/secret.ts'); // ignored by a nested .gitignore

    const sub = makeIndex(path.join(root, 'packages/web'), { git: true }).index;
    await sub.build();
    expect(sub.search('app', 10).items[0]?.relativePath).toBe('app.ts');
    expect(sub.search('index', 10).items).toEqual([]);
  });

  it('falls back to walking the tree outside a repository', async () => {
    const root = tempDir();
    writeTree(root, { 'one.ts': '', 'sub/two.ts': '' });
    const { index } = makeIndex(root, { git: true });
    await index.build();
    expect(index.search('two', 5).items[0]?.relativePath).toBe('sub/two.ts');
  });
});

describe('mapEditorConfig', () => {
  it('maps supported properties and drops unset and invalid values', () => {
    expect(
      mapEditorConfig({
        indent_style: 'space',
        indent_size: 4,
        tab_width: 8,
        end_of_line: 'crlf',
        charset: 'utf-8-bom',
        trim_trailing_whitespace: true,
        insert_final_newline: false,
        max_line_length: 100,
      }),
    ).toEqual({
      indentStyle: 'space',
      indentSize: 4,
      tabWidth: 8,
      endOfLine: 'crlf',
      charset: 'utf8bom',
      trimTrailingWhitespace: true,
      insertFinalNewline: false,
      maxLineLength: 100,
    });
    expect(
      mapEditorConfig({
        indent_style: 'unset',
        indent_size: 'tab',
        end_of_line: 'cr',
        charset: 'latin1',
      }),
    ).toEqual({ charset: 'iso88591' });
    expect(mapEditorConfig({})).toBeNull();
  });
});
