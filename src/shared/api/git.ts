export interface GitAvailability {
  available: boolean;
  version?: string;
  path?: string;
  error?: string;
}

export interface GitRepoInfo {
  /** Absolute path of the repository top level. */
  root: string;
  /** Current branch, or null when HEAD is detached. */
  branch: string | null;
  detached: boolean;
  /** Short commit id of HEAD ('' when there are no commits). */
  head: string;
  hasCommits: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
}

/** M modified, A added, D deleted, R renamed, C copied, T type changed, ? untracked, ! ignored. */
export type GitChangeCode = 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | '?' | '!';

export interface GitFileStatus {
  /** Absolute path. */
  path: string;
  relativePath: string;
  /** Original path for renames and copies (absolute). */
  origPath?: string;
  /** Change staged in the index, if any. */
  index: GitChangeCode | null;
  /** Change in the working tree, if any. */
  workingTree: GitChangeCode | null;
  conflicted: boolean;
  /**
   * True for an untracked folder that Git reports as a whole (its files are not listed one by
   * one).  and  have no trailing separator.
   */
  isDirectory?: boolean;
}

export interface GitStatus {
  repo: GitRepoInfo;
  files: GitFileStatus[];
  /** True when the file list was capped for performance; `totalChanged` has the real count. */
  truncated: boolean;
  totalChanged: number;
  refreshedAt: number;
  durationMs: number;
}

export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
  upstream?: string;
  sha: string;
}

export interface GitCommitInfo {
  sha: string;
  shortSha: string;
  author: string;
  /** Author date in milliseconds since the Unix epoch. */
  date: number;
  subject: string;
}

export interface GitBlob {
  /** False when the path does not exist at that revision (for example a new file). */
  exists: boolean;
  binary: boolean;
  /** Decoded text with the line endings the working tree would have. Empty for binary or oversized content. */
  content: string;
  /** Size in bytes of the stored content, when . */
  size?: number;
  /** True when the content exceeds  and was not returned. */
  tooLarge?: boolean;
}

export interface GitInvoke {
  'git:detect': () => GitAvailability;
  /** Cached status; null when the workspace is not inside a Git repository. */
  'git:status': () => GitStatus | null;
  /** Force a refresh now. */
  'git:refresh': () => GitStatus | null;
  'git:stage': (paths: string[]) => void;
  'git:unstage': (paths: string[]) => void;
  /** Restore tracked files from HEAD, and remove untracked files. Destructive: callers confirm first. */
  'git:discard': (paths: string[]) => void;
  'git:stageAll': () => void;
  'git:unstageAll': () => void;
  'git:commit': (request: { message: string; amend?: boolean }) => { sha: string };
  /** Content of a file at HEAD or in the index. */
  'git:show': (path: string, ref: 'HEAD' | 'INDEX') => GitBlob;
  'git:branches': () => GitBranch[];
  'git:checkout': (ref: string) => void;
  'git:createBranch': (name: string, checkout?: boolean) => void;
  /** Network operations; blocked by policy `gitRemoteOperations: false`. */
  'git:fetch': () => void;
  'git:pull': () => void;
  'git:push': () => void;
  'git:log': (options?: { path?: string; limit?: number }) => GitCommitInfo[];
  'git:init': () => GitStatus | null;
}

export interface GitEvents {
  'git:statusChanged': GitStatus | null;
}
