import { create } from 'zustand';
import type { GitStatus } from '@shared/api/git';

/**
 * Public surface of the source control slice that other slices (explorer, editor, status bar) use.
 * The scm slice implements the loading; keep these export names and shapes stable.
 */
export type GitTone = 'added' | 'modified' | 'deleted' | 'untracked' | 'conflict' | 'ignored';

export interface GitDecoration {
  /** Single letter badge: M, A, D, U, R, C or !. */
  letter: string;
  tone: GitTone;
  tooltip: string;
}

interface GitState {
  /** null = not a repository (or Git disabled); undefined = still loading. */
  status: GitStatus | null | undefined;
  available: boolean | null;
  /** Bumped on every status change so consumers can memoize lookups. */
  version: number;
}

export const useGitStore = create<GitState>(() => ({
  status: undefined,
  available: null,
  version: 0,
}));

/** Decoration for a file, or null. Folders get a decoration when any descendant changed. */
export function decorationFor(path: string): GitDecoration | null {
  void path;
  return null;
}

export function folderHasChanges(path: string): boolean {
  void path;
  return false;
}
