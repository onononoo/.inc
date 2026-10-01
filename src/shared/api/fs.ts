import type { EndOfLine, TextEncoding } from '../encodings';

export type FileKind = 'file' | 'directory';

export interface FileEntry {
  name: string;
  /** Absolute path. */
  path: string;
  kind: FileKind;
  isSymlink: boolean;
  size: number;
  mtimeMs: number;
}

export interface FileStat {
  path: string;
  kind: FileKind | 'other';
  isSymlink: boolean;
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
  readonly: boolean;
}

export interface ReadDirOptions {
  /** Apply the `files.exclude` setting. Default true. */
  applyExcludes?: boolean;
}

export type ReadFileKind = 'text' | 'binary' | 'tooLarge';

export interface ReadFileResult {
  path: string;
  kind: ReadFileKind;
  /** Decoded text with line endings exactly as on disk. Empty when kind !== 'text'. */
  content: string;
  encoding: TextEncoding;
  /** Dominant line ending on disk ('lf' when the file has none). */
  eol: EndOfLine;
  mixedEol: boolean;
  size: number;
  mtimeMs: number;
}

export interface ReadFileOptions {
  /** Force a specific encoding instead of detecting one. */
  encoding?: TextEncoding;
  /** Refuse files larger than this many bytes (kind: 'tooLarge'). Defaults to `editor.maxFileSizeMB`. */
  maxBytes?: number;
}

export interface WriteFileOptions {
  encoding?: TextEncoding;
  /** When set and the file on disk has a different mtime, fails with E_MODIFIED_SINCE. Pass null for "must not exist". */
  expectedMtimeMs?: number | null;
  createDirs?: boolean;
}

export interface WriteFileResult {
  mtimeMs: number;
  size: number;
}

export interface FsChange {
  type: 'create' | 'update' | 'delete';
  path: string;
}

export interface FileSearchItem {
  path: string;
  /** Path relative to the workspace root, forward slashes. */
  relativePath: string;
  score: number;
  /** Matched character indexes into `relativePath`. */
  positions: number[];
}

export interface FileSearchResult {
  items: FileSearchItem[];
  /** Number of matches before `limit` was applied. */
  total: number;
  /** True while the workspace file index is still being built (results may be incomplete). */
  indexing: boolean;
  indexedCount: number;
}

export interface EditorConfigProps {
  indentStyle?: 'space' | 'tab';
  indentSize?: number;
  tabWidth?: number;
  endOfLine?: EndOfLine;
  charset?: TextEncoding;
  trimTrailingWhitespace?: boolean;
  insertFinalNewline?: boolean;
  maxLineLength?: number;
}

export interface FsInvoke {
  'fs:readDir': (path: string, options?: ReadDirOptions) => FileEntry[];
  'fs:stat': (path: string) => FileStat;
  'fs:exists': (path: string) => boolean;
  'fs:readFile': (path: string, options?: ReadFileOptions) => ReadFileResult;
  'fs:readBytes': (path: string, maxBytes?: number) => Uint8Array;
  'fs:writeFile': (path: string, content: string, options?: WriteFileOptions) => WriteFileResult;
  'fs:createFile': (path: string) => FileStat;
  'fs:createDir': (path: string) => FileStat;
  /** Rename or move. Fails with E_EXISTS unless `overwrite`. */
  'fs:rename': (from: string, to: string, options?: { overwrite?: boolean }) => void;
  /** Copy a file or folder recursively. Fails with E_EXISTS unless `overwrite`. */
  'fs:copy': (from: string, to: string, options?: { overwrite?: boolean }) => void;
  /** Move to the OS trash (never permanent deletion). */
  'fs:trash': (paths: string[]) => void;
  /** Show in Explorer / Finder / the file manager. */
  'fs:reveal': (path: string) => void;
  /** Watch an extra path (the workspace root is always watched). Returns a handle. */
  'fs:watch': (path: string, recursive: boolean) => number;
  'fs:unwatch': (handle: number) => void;
  /** Fuzzy file-name search over the workspace index (quick open). */
  'files:search': (query: string, limit?: number) => FileSearchResult;
  /** Resolved EditorConfig properties for a file, or null when none apply. */
  'editorconfig:resolve': (path: string) => EditorConfigProps | null;
}

export interface FsEvents {
  /** Batched, de-duplicated file system changes. */
  'fs:changed': FsChange[];
  'files:indexProgress': { indexing: boolean; count: number };
}
