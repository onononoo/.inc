export interface SearchQuery {
  pattern: string;
  isRegex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  /**
   * Glob patterns relative to the workspace root; empty means everything. A pattern that names a
   * folder ("src") includes everything below it, and a pattern without a slash that contains
   * wildcards ("*.ts") matches at any depth.
   */
  include: string[];
  /** Extra glob excludes, added to `search.exclude`. Same pattern rules as `include`. */
  exclude: string[];
  /** Overrides `search.maxResults`. */
  maxResults?: number;
}

export interface SearchMatch {
  /** 1-based. */
  line: number;
  /** 1-based column of the match start within the original line, in UTF-16 code units. */
  column: number;
  /** Match length in UTF-16 code units. */
  length: number;
  /** The line text, trimmed to a window around the match. */
  preview: string;
  /** Offsets of the match within `preview`. */
  previewMatchStart: number;
  previewMatchEnd: number;
}

export interface FileMatches {
  path: string;
  relativePath: string;
  matches: SearchMatch[];
  /** True when the file has more matches than are listed (the per-file cap was reached). */
  truncated?: boolean;
}

/** Files that were found but could not be searched, by reason. */
export interface SearchSkipped {
  /** Binary files (a NUL byte in the first 8 KB). */
  binary: number;
  /** Files larger than the 10 MB search limit. */
  large: number;
  /** Files or folders that could not be read (permissions, in use, removed while searching). */
  unreadable: number;
  /** Files abandoned because matching them took too long (a pathological regular expression). */
  timedOut: number;
}

export interface SearchStats {
  filesSearched: number;
  filesMatched: number;
  matchCount: number;
  limitHit: boolean;
  cancelled: boolean;
  durationMs: number;
  /** Plain-language reason the search ended early or incompletely. */
  error?: string;
  filesSkipped?: SearchSkipped;
}

export interface ReplaceRequest {
  query: SearchQuery;
  /** With isRegex, `$1`-style capture references are supported, plus `$&` and `$$`. */
  replacement: string;
  /** Files to change; a file whose mtime differs from `expectedMtimeMs` is skipped. */
  files: { path: string; expectedMtimeMs?: number }[];
}

export interface ReplaceResult {
  filesChanged: number;
  replacements: number;
  skipped: { path: string; reason: string }[];
}

export interface SearchInvoke {
  /** Returns at once; matches stream as `search:results` and the end is `search:done`. */
  'search:start': (query: SearchQuery) => { searchId: number };
  'search:cancel': (searchId: number) => void;
  'search:replace': (request: ReplaceRequest) => ReplaceResult;
}

export interface SearchEvents {
  'search:results': { searchId: number; files: FileMatches[] };
  'search:done': { searchId: number; stats: SearchStats };
}
