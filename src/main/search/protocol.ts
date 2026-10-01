/**
 * Messages between the search coordinator (main thread) and the search workers, plus the limits
 * both sides share. Everything here is plain structured-cloneable data.
 */
import type { FileMatches } from '@shared/api/search';

/** A compiled query in transferable form; workers rebuild the RegExp from it. */
export interface MatcherSpec {
  source: string;
  flags: string;
  /** Text that every matching UTF-8 file must contain byte for byte (case-sensitive literals only). */
  prefilter: string | null;
  /** True when the query is a regular expression (replacement then expands `$1`, `$&`, `$$`). */
  isRegex: boolean;
}

export interface FilterSpec {
  /** Glob patterns (see globs.ts) for files and folders to leave out. */
  exclude: string[];
  /** Glob patterns a file must match; empty means every file. */
  include: string[];
  useIgnoreFiles: boolean;
  followSymlinks: boolean;
}

export interface JobSpec {
  kind: 'search' | 'replace';
  /** Absolute workspace root. */
  root: string;
  /** Real path of the root, used to keep replacements inside the workspace. */
  realRoot: string;
  matcher: MatcherSpec;
  filters: FilterSpec;
  /** Replacement text (replace jobs). */
  replacement: string;
}

/** One ignore file. `base` is the folder that holds it, relative to the root ("" = root). */
export interface IgnoreSource {
  id: number;
  base: string;
  /** Omitted when the receiving worker already has this source. */
  text?: string;
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
  /** Paths relative to the root, "/"-separated. */
  files: string[];
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
  /** Real path of the folder; set only when following symlinks. */
  real?: string;
}

export interface FileOutcome {
  /** Absolute path as given in the request. */
  path: string;
  /** Number of replacements made; 0 when the file was skipped. */
  replacements: number;
  skipped?: string;
}

export interface WorkerData {
  /** Per-worker progress array the watchdog reads. */
  progress: SharedArrayBuffer;
}

export type TerminalReply =
  | {
      type: 'dir-done';
      subdirs: SubDir[];
      /** Names of the files in the folder that pass every filter. */
      files: string[];
      /** Combined text of the folder's ignore files, when it has any. */
      ownSource: string | null;
      /** Entries that could not be read (for example a folder that vanished). */
      unreadable: number;
    }
  | {
      type: 'files-done';
      searched: number;
      binary: number;
      large: number;
      unreadable: number;
    }
  | { type: 'replace-done' }
  | { type: 'task-failed'; message: string };

export type WorkerReply =
  /** Partial results of the running task; sent as soon as files have matches. */
  | { type: 'matches'; files: FileMatches[]; matchCount: number }
  /** Replacement outcomes of the running task, sent per file so a lost task loses nothing. */
  | { type: 'outcomes'; results: FileOutcome[] }
  | TerminalReply;

/** Layout of the per-worker progress array the watchdog reads. */
export const PROGRESS_HEARTBEAT = 0;
export const PROGRESS_ITEM = 1;
export const PROGRESS_SLOTS = 2;

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
