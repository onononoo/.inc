/**
 * How the source control list is built from a Git status: three groups (merge conflicts, staged
 * changes, changes), each file with the letter and tone for its group, and the flat row list the
 * virtualised view renders. Pure, so the grouping rules are unit tested.
 */
import type { GitChangeCode, GitFileStatus } from '@shared/api/git';
import type { GitTone } from './decorations';

export type ScmGroupId = 'conflicts' | 'staged' | 'changes';

export interface ScmItem {
  group: ScmGroupId;
  file: GitFileStatus;
  /** Stable identity: the group and the path (a file can be in two groups). */
  key: string;
  letter: string;
  tone: GitTone;
  label: string;
}

export interface ScmGroup {
  id: ScmGroupId;
  title: string;
  items: ScmItem[];
}

export type ScmRow =
  { type: 'group'; group: ScmGroup; collapsed: boolean } | { type: 'item'; item: ScmItem };

const TITLES: Record<ScmGroupId, string> = {
  conflicts: 'Merge conflicts',
  staged: 'Staged changes',
  changes: 'Changes',
};

interface Presentation {
  letter: string;
  tone: GitTone;
  label: string;
}

function present(code: GitChangeCode | null, conflicted: boolean): Presentation {
  if (conflicted) return { letter: '!', tone: 'conflict', label: 'Merge conflict' };
  switch (code) {
    case 'A':
      return { letter: 'A', tone: 'added', label: 'Added' };
    case 'D':
      return { letter: 'D', tone: 'deleted', label: 'Deleted' };
    case 'R':
      return { letter: 'R', tone: 'added', label: 'Renamed' };
    case 'C':
      return { letter: 'C', tone: 'added', label: 'Copied' };
    case '?':
      return { letter: 'U', tone: 'untracked', label: 'Untracked' };
    case 'M':
    case 'T':
    default:
      return { letter: 'M', tone: 'modified', label: 'Modified' };
  }
}

function item(group: ScmGroupId, file: GitFileStatus, code: GitChangeCode | null): ScmItem {
  const shown = present(code, group === 'conflicts');
  return { group, file, key: `${group}:${file.path}`, ...shown };
}

/** Split a status into its groups. Files with both staged and unstaged changes appear in both. */
export function buildGroups(files: readonly GitFileStatus[]): ScmGroup[] {
  const conflicts: ScmItem[] = [];
  const staged: ScmItem[] = [];
  const changes: ScmItem[] = [];
  for (const file of files) {
    if (file.conflicted) {
      conflicts.push(item('conflicts', file, null));
      continue;
    }
    if (file.index !== null && file.index !== '?' && file.index !== '!')
      staged.push(item('staged', file, file.index));
    if (file.workingTree !== null && file.workingTree !== '!')
      changes.push(item('changes', file, file.workingTree));
  }
  const byPath = (a: ScmItem, b: ScmItem) => a.file.relativePath.localeCompare(b.file.relativePath);
  const groups: ScmGroup[] = [
    { id: 'conflicts', title: TITLES.conflicts, items: conflicts.sort(byPath) },
    { id: 'staged', title: TITLES.staged, items: staged.sort(byPath) },
    { id: 'changes', title: TITLES.changes, items: changes.sort(byPath) },
  ];
  return groups.filter((g) => g.items.length > 0);
}

/** The rows to render: a header per group, then its files unless the group is collapsed. */
export function flattenGroups(
  groups: readonly ScmGroup[],
  collapsed: ReadonlySet<ScmGroupId>,
): ScmRow[] {
  const rows: ScmRow[] = [];
  for (const group of groups) {
    const isCollapsed = collapsed.has(group.id);
    rows.push({ type: 'group', group, collapsed: isCollapsed });
    if (!isCollapsed) for (const entry of group.items) rows.push({ type: 'item', item: entry });
  }
  return rows;
}

/** Counts shown next to the source control button and in the group headers. */
export function totalChanges(groups: readonly ScmGroup[]): number {
  const seen = new Set<string>();
  for (const group of groups) for (const entry of group.items) seen.add(entry.file.path);
  return seen.size;
}

/** The text of a short, safe commit message prompt: the first line of the message. */
export function firstLine(message: string): string {
  const end = message.search(/[\r\n]/);
  return (end === -1 ? message : message.slice(0, end)).trim();
}

/** A git branch name the person typed, checked before Git is asked (Git still has the last word). */
export function validateBranchName(name: string): string | undefined {
  const value = name.trim();
  if (value === '') return 'A branch name is required.';
  if (/\s/.test(value)) return 'A branch name cannot contain spaces.';
  if (value.startsWith('-')) return 'A branch name cannot start with a dash.';
  if (value.startsWith('/') || value.endsWith('/') || value.includes('//'))
    return 'A branch name cannot start or end with a slash, or contain two in a row.';
  if (value.endsWith('.') || value.endsWith('.lock'))
    return 'A branch name cannot end with a dot or ".lock".';
  if (value.includes('..') || value.includes('@{'))
    return 'A branch name cannot contain ".." or "@{".';
  // eslint-disable-next-line no-control-regex
  if (/[~^:?*[\\\u0000-\u001f\u007f]/.test(value))
    return 'A branch name cannot contain ~ ^ : ? * [ \\ or control characters.';
  if (value === '@') return '"@" is not a valid branch name.';
  return undefined;
}
