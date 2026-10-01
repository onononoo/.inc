import type { GitFileStatus } from '@shared/api/git';

export type GitTone = 'added' | 'modified' | 'deleted' | 'untracked' | 'conflict' | 'ignored';

export interface GitDecoration {
  /** Single letter badge: M, A, D, U, R, C or !. */
  letter: string;
  tone: GitTone;
  tooltip: string;
}

/** The single decoration for a file: conflicts win over working tree changes, which win over staged ones. */
export function decorationOf(
  file: Pick<GitFileStatus, 'index' | 'workingTree' | 'conflicted'>,
): GitDecoration | null {
  if (file.conflicted) return { letter: '!', tone: 'conflict', tooltip: 'Merge conflict' };
  const w = file.workingTree;
  const i = file.index;
  if (w === '?') return { letter: 'U', tone: 'untracked', tooltip: 'Untracked' };
  if (w === '!') return { letter: '!', tone: 'ignored', tooltip: 'Ignored' };
  if (w === 'D') return { letter: 'D', tone: 'deleted', tooltip: 'Deleted' };
  if (w === 'M' || w === 'T') return { letter: 'M', tone: 'modified', tooltip: 'Modified' };
  if (i === 'A') return { letter: 'A', tone: 'added', tooltip: 'Added' };
  if (i === 'D') return { letter: 'D', tone: 'deleted', tooltip: 'Deleted (staged)' };
  if (i === 'R') return { letter: 'R', tone: 'added', tooltip: 'Renamed' };
  if (i === 'C') return { letter: 'C', tone: 'added', tooltip: 'Copied' };
  if (i === 'M' || i === 'T')
    return { letter: 'M', tone: 'modified', tooltip: 'Modified (staged)' };
  return null;
}
