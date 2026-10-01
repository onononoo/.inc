import path from 'node:path';
import type { GitFileStatus, GitStatus } from '@shared/api/git';
import { toChangeCode, type ParsedEntry, type ParsedStatus } from './porcelain';

function absolute(repoRoot: string, relative: string): string {
  return path.join(repoRoot, ...relative.split('/'));
}

/** Convert one parsed entry to the shape the renderer receives. */
export function toFileStatus(entry: ParsedEntry, repoRoot: string): GitFileStatus {
  const file: GitFileStatus = {
    path: absolute(repoRoot, entry.path),
    relativePath: entry.path,
    index: null,
    workingTree: null,
    conflicted: false,
  };
  if (entry.kind === 'untracked' || entry.kind === 'ignored') {
    file.workingTree = entry.kind === 'untracked' ? '?' : '!';
    if (entry.isDirectory) file.isDirectory = true;
    return file;
  }
  file.index = toChangeCode(entry.xy[0]);
  file.workingTree = toChangeCode(entry.xy[1]);
  if (entry.kind === 'unmerged') {
    file.conflicted = true;
    file.conflictCode = entry.xy;
  }
  if (entry.origPath !== undefined) file.origPath = absolute(repoRoot, entry.origPath);
  return file;
}

/** Combine a parsed `git status` with the repository location into the public status object. */
export function buildStatus(
  parsed: ParsedStatus,
  repoRoot: string,
  timing: { refreshedAt: number; durationMs: number },
): GitStatus {
  const { branch } = parsed;
  return {
    repo: {
      root: repoRoot,
      branch: branch.head,
      detached: branch.detached,
      head: branch.oid ? branch.oid.slice(0, 7) : '',
      hasCommits: branch.oid !== null,
      upstream: branch.upstream,
      ahead: branch.ahead,
      behind: branch.behind,
    },
    files: parsed.entries
      .filter((entry) => entry.kind !== 'ignored')
      .map((entry) => toFileStatus(entry, repoRoot)),
    truncated: parsed.truncated,
    totalChanged: parsed.totalChanged,
    refreshedAt: timing.refreshedAt,
    durationMs: timing.durationMs,
  };
}

/**
 * Stable text for comparing two statuses: everything except the timestamps. Used so a refresh
 * that found nothing new does not wake the renderer.
 */
export function statusSignature(status: GitStatus | null): string {
  if (status === null) return 'none';
  return JSON.stringify([status.repo, status.files, status.truncated, status.totalChanged]);
}
