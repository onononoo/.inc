import { describe, expect, it } from 'vitest';
import { fuzzyFilter, fuzzyMatch, highlightRuns, isSubsequence } from '@shared/fuzzy';

describe('fuzzyMatch', () => {
  it('returns null when the query is not a subsequence', () => {
    expect(fuzzyMatch('xyz', 'src/index.ts')).toBeNull();
    expect(isSubsequence('idx', 'index')).toBe(true);
  });

  it('matches case-insensitively and reports positions', () => {
    const m = fuzzyMatch('IDX', 'index');
    expect(m).not.toBeNull();
    expect(m?.positions).toEqual([0, 2, 4]);
  });

  it('prefers word-boundary and consecutive matches', () => {
    const boundary = fuzzyMatch('fb', 'foo-bar');
    const scattered = fuzzyMatch('fb', 'fxxxxbxx');
    expect(boundary!.score).toBeGreaterThan(scattered!.score);
    const consecutive = fuzzyMatch('bar', 'foobar');
    const gapped = fuzzyMatch('bar', 'bxaxrx');
    expect(consecutive!.score).toBeGreaterThan(gapped!.score);
  });

  it('boosts matches inside the file name in path mode', () => {
    const inName = fuzzyMatch('idx', 'src/lib/idx.ts', { pathMode: true })!;
    const inDirs = fuzzyMatch('idx', 'i/d/x/other.ts', { pathMode: true })!;
    expect(inName.score).toBeGreaterThan(inDirs.score);
  });

  it('handles an empty query and very long targets', () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, positions: [] });
    const long = 'a'.repeat(5000) + 'b';
    expect(fuzzyMatch('ab', long)).not.toBeNull();
  });
});

describe('fuzzyFilter', () => {
  it('ranks best matches first and honours the limit', () => {
    const items = ['src/app.ts', 'src/index.ts', 'docs/index.md', 'README.md'];
    const out = fuzzyFilter('index', items, (s) => s, { pathMode: true, limit: 2 });
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.item)).toEqual(
      expect.arrayContaining(['src/index.ts', 'docs/index.md']),
    );
  });
});

describe('highlightRuns', () => {
  it('splits text into matched and unmatched runs', () => {
    expect(highlightRuns('index', [0, 1])).toEqual([
      { text: 'in', match: true },
      { text: 'dex', match: false },
    ]);
  });
});
