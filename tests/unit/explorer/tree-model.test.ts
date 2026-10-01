import { describe, expect, it } from 'vitest';
import type { FileEntry } from '@shared/api/fs';
import {
  EMPTY_TREE,
  baseNameRange,
  checkDrop,
  compareEntries,
  flatten,
  forgetSubtree,
  indexOfPath,
  topmostPaths,
  uniqueCopyName,
  validateName,
  type TreeState,
} from '../../../src/renderer/explorer/tree-model';

const entry = (path: string, kind: 'file' | 'directory' = 'file'): FileEntry => ({
  name: path.split('/').pop() as string,
  path,
  kind,
  isSymlink: false,
  size: 0,
  mtimeMs: 0,
});

function tree(overrides: Partial<TreeState> = {}): TreeState {
  return {
    ...EMPTY_TREE,
    root: '/ws',
    listings: {
      '/ws': [
        entry('/ws/src', 'directory'),
        entry('/ws/docs', 'directory'),
        entry('/ws/a.ts'),
        entry('/ws/b.ts'),
      ],
      '/ws/src': [entry('/ws/src/deep', 'directory'), entry('/ws/src/index.ts')],
      '/ws/src/deep': [entry('/ws/src/deep/x.ts')],
    },
    ...overrides,
  };
}

const names = (state: TreeState, edit = null as Parameters<typeof flatten>[1]) =>
  flatten(state, edit).map((r) =>
    r.type === 'node' ? `${'  '.repeat(r.depth)}${r.name}` : `${r.type}:${r.depth}`,
  );

describe('flatten', () => {
  it('shows only the root listing until folders are expanded', () => {
    expect(names(tree())).toEqual(['src', 'docs', 'a.ts', 'b.ts']);
  });

  it('shows children of expanded folders at the right depth', () => {
    const state = tree({ expanded: new Set(['/ws/src', '/ws/src/deep']) });
    expect(names(state)).toEqual([
      'src',
      '  deep',
      '    x.ts',
      '  index.ts',
      'docs',
      'a.ts',
      'b.ts',
    ]);
  });

  it('does not list children of an expanded folder that has not been read', () => {
    const state = tree({ expanded: new Set(['/ws/docs']), loading: new Set(['/ws/docs']) });
    const rows = flatten(state);
    const docs = rows.find((r) => r.type === 'node' && r.name === 'docs');
    expect(docs).toMatchObject({ expanded: true, loading: true });
    expect(rows).toHaveLength(4);
  });

  it('places an inline create row first in its folder', () => {
    const state = tree({ expanded: new Set(['/ws/src']) });
    expect(names(state, { type: 'create', kind: 'file', parent: '/ws/src' })).toEqual([
      'src',
      'create:1',
      '  deep',
      '  index.ts',
      'docs',
      'a.ts',
      'b.ts',
    ]);
    expect(names(tree(), { type: 'create', kind: 'directory', parent: '/ws' })[0]).toBe('create:0');
  });

  it('shows an error row instead of the contents of a folder that could not be read', () => {
    const state = tree({
      expanded: new Set(['/ws/src']),
      errors: { '/ws/src': 'permission denied' },
    });
    const rows = flatten(state);
    expect(rows[1]).toEqual({
      type: 'error',
      path: '/ws/src',
      message: 'permission denied',
      depth: 1,
    });
  });

  it('is empty without a root', () => {
    expect(flatten(EMPTY_TREE)).toEqual([]);
  });

  it('finds the row of a path, ignoring case on case-insensitive platforms', () => {
    const rows = flatten(tree());
    expect(indexOfPath(rows, '/ws/a.ts', 'linux')).toBe(2);
    expect(indexOfPath(rows, '/WS/A.TS', 'linux')).toBe(-1);
    expect(indexOfPath(rows, '/WS/A.TS', 'darwin')).toBe(2);
  });
});

describe('forgetSubtree', () => {
  it('drops listings, errors, expansion and loading state at and below a folder', () => {
    const state = tree({
      expanded: new Set(['/ws/src', '/ws/src/deep', '/ws/docs']),
      loading: new Set(['/ws/src/deep']),
      errors: { '/ws/src/deep': 'x' },
    });
    const next = forgetSubtree(state, '/ws/src', 'linux');
    expect(Object.keys(next.listings)).toEqual(['/ws']);
    expect([...next.expanded]).toEqual(['/ws/docs']);
    expect(next.loading.size).toBe(0);
    expect(next.errors).toEqual({});
  });

  it('does not touch a sibling whose name starts the same', () => {
    const state = tree({ listings: { '/ws': [], '/ws/src': [], '/ws/src2': [] } });
    expect(Object.keys(forgetSubtree(state, '/ws/src', 'linux').listings).sort()).toEqual([
      '/ws',
      '/ws/src2',
    ]);
  });
});

describe('ordering', () => {
  it('puts folders first and sorts names naturally', () => {
    const list = [
      entry('/a/file10.ts'),
      entry('/a/zeta', 'directory'),
      entry('/a/file2.ts'),
      entry('/a/Alpha', 'directory'),
    ];
    expect(list.sort(compareEntries).map((e) => e.name)).toEqual([
      'Alpha',
      'zeta',
      'file2.ts',
      'file10.ts',
    ]);
  });
});

describe('validateName', () => {
  const base = { platform: 'linux' as const, siblings: ['a.ts', 'Docs'], allowSeparators: false };

  it('accepts ordinary names and rejects empty or dotted ones', () => {
    expect(validateName('new.ts', base).ok).toBe(true);
    expect(validateName('  ', base)).toMatchObject({ ok: false, message: 'A name is required.' });
    expect(validateName('..', base).ok).toBe(false);
    expect(validateName('.', base).ok).toBe(false);
  });

  it('rejects slashes unless a path is allowed, and checks each segment', () => {
    expect(validateName('a/b', base).ok).toBe(false);
    expect(validateName('src/utils/a.ts', { ...base, allowSeparators: true }).ok).toBe(true);
    expect(validateName('src//a.ts', { ...base, allowSeparators: true }).ok).toBe(false);
    expect(validateName('src/../a.ts', { ...base, allowSeparators: true }).ok).toBe(false);
  });

  it('detects a clash with a sibling, case-sensitively only on Linux', () => {
    expect(validateName('a.ts', base).message).toContain('already exists');
    expect(validateName('A.ts', base).ok).toBe(true);
    expect(validateName('A.ts', { ...base, platform: 'darwin' }).ok).toBe(false);
    // A path into an existing folder is fine.
    expect(validateName('Docs/new.md', { ...base, allowSeparators: true }).ok).toBe(true);
  });

  it('lets a rename keep or re-case its own name', () => {
    expect(validateName('a.ts', { ...base, current: 'a.ts' }).ok).toBe(true);
    expect(validateName('A.TS', { ...base, platform: 'win32', current: 'a.ts' }).ok).toBe(true);
    expect(validateName('docs', { ...base, platform: 'win32', current: 'a.ts' }).ok).toBe(false);
  });

  it('applies the Windows rules only on Windows', () => {
    const win = { ...base, platform: 'win32' as const };
    expect(validateName('a:b', win).ok).toBe(false);
    expect(validateName('what?', win).ok).toBe(false);
    expect(validateName('trailing.', win).ok).toBe(false);
    expect(validateName('con.txt', win).ok).toBe(false);
    expect(validateName('COM1', win).ok).toBe(false);
    expect(validateName('a:b', base).ok).toBe(true);
    expect(validateName('a\u0001b', base).ok).toBe(false);
    expect(validateName('x'.repeat(256), base).ok).toBe(false);
  });
});

describe('uniqueCopyName', () => {
  it('keeps a free name and numbers copies', () => {
    expect(uniqueCopyName('a.ts', ['b.ts'], 'linux')).toBe('a.ts');
    expect(uniqueCopyName('a.ts', ['a.ts'], 'linux')).toBe('a copy.ts');
    expect(uniqueCopyName('a.ts', ['a.ts', 'a copy.ts'], 'linux')).toBe('a copy 2.ts');
    expect(uniqueCopyName('Makefile', ['Makefile'], 'linux')).toBe('Makefile copy');
    expect(uniqueCopyName('.env', ['.env'], 'linux')).toBe('.env copy');
    expect(uniqueCopyName('A.TS', ['a.ts'], 'win32')).toBe('A copy.TS');
  });
});

describe('rename selection', () => {
  it('selects the base name of files but the whole name of folders and dot files', () => {
    expect(baseNameRange('index.test.ts', true)).toEqual([0, 10]);
    expect(baseNameRange('src', false)).toEqual([0, 3]);
    expect(baseNameRange('.gitignore', true)).toEqual([0, 10]);
    expect(baseNameRange('Makefile', true)).toEqual([0, 8]);
  });
});

describe('checkDrop', () => {
  it('drops into a folder, or into the folder of a file', () => {
    expect(checkDrop(['/ws/a.ts'], '/ws/src', true, 'linux')).toEqual({
      ok: true,
      target: '/ws/src',
    });
    expect(checkDrop(['/ws/a.ts'], '/ws/src/index.ts', false, 'linux')).toEqual({
      ok: true,
      target: '/ws/src',
    });
  });

  it('refuses to move a folder into itself or its own descendant', () => {
    expect(checkDrop(['/ws/src'], '/ws/src', true, 'linux').ok).toBe(false);
    expect(checkDrop(['/ws/src'], '/ws/src/deep', true, 'linux').ok).toBe(false);
    expect(checkDrop(['/ws/src', '/ws/a.ts'], '/ws/src/deep', true, 'linux').ok).toBe(false);
  });

  it('refuses a drop where everything already lives', () => {
    expect(checkDrop(['/ws/a.ts', '/ws/b.ts'], '/ws', true, 'linux')).toMatchObject({ ok: false });
    expect(checkDrop(['/ws/a.ts', '/ws/src/x.ts'], '/ws', true, 'linux').ok).toBe(true);
  });
});

describe('topmostPaths', () => {
  it('keeps a folder and drops what is inside it', () => {
    expect(topmostPaths(['/ws/src', '/ws/src/a.ts', '/ws/b.ts', '/ws/src2/c.ts'], 'linux')).toEqual(
      ['/ws/src', '/ws/b.ts', '/ws/src2/c.ts'],
    );
  });
});
