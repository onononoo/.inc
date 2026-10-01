/**
 * Messages between the search coordinator (main thread) and the search workers.
 * Everything here is plain structured-cloneable data.
 */
import type { FileMatches } from '@shared/api/search';

/** A compiled query in transferable form; workers rebuild the RegExp from it. */
export interface MatcherSpec {
  source: string;
  flags: string;
  /** Text that every matching file must contain byte-for-byte (case-sensitive literals only). */
  prefilter: string | null;
  /** True when the query is a regular expression (replacement then expands `$1`, `$&`, `$$`). */
  isRegex: boolean;
}

/** One ignore file. `base` is the folder that holds it, relative to the workspace root ("" = root). */
export interface IgnoreSource {
  base: string;
  text: string;
}

export interface FilterSpec {
  /** Normalised glob patterns (see globs.ts). */
  exclude: string[];
  include: string[];
  useIgnoreFiles: boolean;
  followSymlinks: boolean;
}

export interface JobSpec {
  kind: 'search' | 'replace';
  /** Absolute workspace root. */
  root: string;
  matcher: MatcherSpec;
  filters: FilterSpec;
  /** Replacement text (replace jobs). */
  replacement: string;
}

export interface DirTask {
  kind: 'dir';
  /** Folder relative to the root, "/"-separated; "" is the root. */
  dir: string;
  /** Ignore files of the ancestors, shallowest first. */
  chain: IgnoreSource[];
  /** Real path of this folder and of its logical ancestors; set only when following symlinks. */
  real?: string;
  ancestors?: string[];
}

export interface FilesTask {
  kind: 'files';
  dir: string;
  names: string[];
}

export interface ReplaceTask {
  kind: 'replace';
  files: { path: string; expectedMtimeMs?: number }[];
}

export type WorkerTask = DirTask | FilesTask | ReplaceTask;

export type MainMessage =
  | { type: 'begin'; jobId: number; spec: JobSpec; control: SharedArrayBuffer }
  | { type: 'end'; jobId: number }
  | { type: 'task'; jobId: number; task: WorkerTask };

export interface SubDir {
  name: string;
  /** Real path, when the folder is reached through a symbolic link or links are followed. */
  real?: string;
}

export interface FileOutcome {
  path: string;
  /** Number of replacements made; 0 when the file was skipped. */
  replacements: number;
  skipped?: string;
}

export type WorkerReply =
  | { type: 'ready' }
  /** Partial results of the running task; sent as soon as a file has matches. */
  | { type: 'matches'; files: FileMatches[]; matchCount: number }
  | {
      type: 'dir-done';
      subdirs: SubDir[];
      files: string[];
      ownSources: IgnoreSource[];
      issues: string[];
      unreadable: number;
    }
  | {
      type: 'files-done';
      searched: number;
      binary: number;
      large: number;
      unreadable: number;
      issues: string[];
    }
  | { type: 'replace-done'; results: FileOutcome[] }
  | { type: 'task-failed'; message: string };

export type TerminalReply = Exclude<WorkerReply, { type: 'ready' } | { type: 'matches' }>;

/** Layout of the per-worker progress array the watchdog reads. */
export const PROGRESS_HEARTBEAT = 0;
export const PROGRESS_ITEM = 1;
export const PROGRESS_SLOTS = 4;

/** Index of the cancellation flag in a job's control array. */
export const CONTROL_CANCELLED = 0;

/** Limits shared by the scanner and the tests. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const BINARY_SNIFF_BYTES = 8192;
export const MAX_MATCHES_PER_LINE = 100;
export const MAX_MATCHES_PER_FILE = 5000;
export const PREVIEW_MAX_CHARS = 240;
export const PREVIEW_CONTEXT_BEFORE = 80;
export const MAX_IGNORE_FILE_BYTES = 1024 * 1024;
