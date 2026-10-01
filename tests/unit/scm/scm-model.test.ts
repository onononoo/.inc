import { describe, expect, it } from 'vitest';
import type { GitFileStatus } from '@shared/api/git';
import { decorationOf } from '../../../src/renderer/scm/decorations';
import {
  buildGroups,
  firstLine,
  flattenGroups,
  totalChanges,
  validateBranchName,
  type ScmGroupId,
} from '../../../src/renderer/scm/scm-model';

const file = (
  rel: string,
  index: GitFileStatus['index'],
  workingTree: GitFileStatus['workingTree'],
  extra: Partial<GitFileStatus> = {},
): GitFileStatus => ({
  path: `/repo/${rel}`,
  relativePath: rel,
  index,
  workingTree,
  conflicted: false,
  ...extra,
});

describe('buildGroups', () => {
  it('splits files into conflicts, staged changes and changes, each sorted by path', () => {
    const groups = buildGroups([
      file('b.ts', null, 'M'),
      file('a.ts', 'A', null),
      file('c.ts', null, '?'),
      file('d.ts', 'M', 'M'),
      file('e.ts', 'U' as never, 'U' as never, { conflicted: true, conflictCode: 'UU' }),
    ]);
    expect(groups.map((g) => [g.id, g.items.map((i) => i.file.relativePath)])).toEqual([
      ['conflicts', ['e.ts']],
      ['staged', ['a.ts', 'd.ts']],
      ['changes', ['b.ts', 'c.ts', 'd.ts']],
    ]);
  });

  it('shows a file with staged and unstaged edits in both groups with the right letters', () => {
    const groups = buildGroups([file('x.ts', 'A', 'M')]);
    const staged = groups.find((g) => g.id === 'staged')?.items[0];
    const changes = groups.find((g) => g.id === 'changes')?.items[0];
    expect([staged?.letter, staged?.tone]).toEqual(['A', 'added']);
    expect([changes?.letter, changes?.tone]).toEqual(['M', 'modified']);
    expect(staged?.key).not.toBe(changes?.key);
  });

  it('presents every status letter', () => {
    const letters = (files: GitFileStatus[]) =>
      buildGroups(files).flatMap((g) => g.items.map((i) => i.letter));
    expect(letters([file('a', null, 'D')])).toEqual(['D']);
    expect(letters([file('a', null, '?')])).toEqual(['U']);
    expect(letters([file('a', 'R', null)])).toEqual(['R']);
    expect(letters([file('a', 'T', null)])).toEqual(['M']);
    expect(letters([file('a', 'D', null)])).toEqual(['D']);
  });

  it('leaves out ignored files and empty groups', () => {
    expect(buildGroups([file('a', null, '!')])).toEqual([]);
    expect(buildGroups([])).toEqual([]);
  });

  it('counts a file once however many groups it is in', () => {
    expect(totalChanges(buildGroups([file('a', 'M', 'M'), file('b', null, '?')]))).toBe(2);
  });
});

describe('flattenGroups', () => {
  it('lists a header per group and hides the files of collapsed groups', () => {
    const groups = buildGroups([file('a', 'A', null), file('b', null, 'M'), file('c', null, 'M')]);
    const kinds = (collapsed: ScmGroupId[]) =>
      flattenGroups(groups, new Set(collapsed)).map((r) =>
        r.type === 'group' ? `#${r.group.id}` : r.item.file.relativePath,
      );
    expect(kinds([])).toEqual(['#staged', 'a', '#changes', 'b', 'c']);
    expect(kinds(['changes'])).toEqual(['#staged', 'a', '#changes']);
  });
});

describe('decorationOf', () => {
  it('lets conflicts win over working tree changes, and working tree over staged', () => {
    expect(decorationOf({ index: 'M', workingTree: 'M', conflicted: true })?.tone).toBe('conflict');
    expect(decorationOf({ index: 'A', workingTree: 'M', conflicted: false })?.letter).toBe('M');
    expect(decorationOf({ index: 'A', workingTree: null, conflicted: false })).toMatchObject({
      letter: 'A',
      tone: 'added',
    });
    expect(decorationOf({ index: null, workingTree: '?', conflicted: false })).toMatchObject({
      letter: 'U',
      tone: 'untracked',
    });
    expect(decorationOf({ index: null, workingTree: 'D', conflicted: false })).toMatchObject({
      letter: 'D',
      tone: 'deleted',
    });
    expect(decorationOf({ index: null, workingTree: null, conflicted: false })).toBeNull();
  });
});

describe('commit message and branch names', () => {
  it('takes the first line of a message', () => {
    expect(firstLine('Fix bug\n\nLonger explanation')).toBe('Fix bug');
    expect(firstLine('  one line  ')).toBe('one line');
  });

  it('accepts ordinary branch names and explains the rejects', () => {
    for (const ok of ['main', 'feature/login', 'release-1.2', 'user/jane/fix_42']) {
      expect(validateBranchName(ok), ok).toBeUndefined();
    }
    for (const bad of [
      '',
      'two words',
      '-flag',
      '/lead',
      'trail/',
      'a//b',
      'x.',
      'x.lock',
      'a..b',
      'a@{b',
      'a~1',
      'a^b',
      'a:b',
      'a?b',
      'a*b',
      'a[b',
      'a\\b',
      '@',
    ]) {
      expect(validateBranchName(bad), bad).toBeTypeOf('string');
    }
  });
});
