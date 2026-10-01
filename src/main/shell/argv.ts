/**
 * Command-line parsing for `inc [--new-window] [--user-data-dir=<dir>] [paths...]`.
 *
 * Pure: the file system is reached through the injected `stat`, and path semantics through the
 * injected `pathApi`, so Windows and POSIX behaviour are both testable on any machine.
 */
import path from 'node:path';

export type PathKind = 'file' | 'directory';

export interface PathApi {
  resolve(...segments: string[]): string;
  isAbsolute(p: string): boolean;
  readonly sep: string;
}

export interface OpenTarget {
  path: string;
  line?: number;
  column?: number;
}

export interface LaunchRequest {
  /** Always open in a new window, even if the folder is already open elsewhere. */
  newWindow: boolean;
  /** `--user-data-dir`, resolved against the working directory. */
  userDataDir?: string;
  /** Existing folders, absolute, in the order given. */
  folders: string[];
  /** Existing files, absolute, with an optional `:line[:column]` position. */
  files: OpenTarget[];
  /** Arguments that named nothing on disk. Reported to the log, never opened. */
  missing: string[];
}

export interface ParseOptions {
  /** Working directory that relative paths are resolved against. */
  cwd: string;
  /** The Electron app directory. It appears as an argument in development and test runs and is skipped. */
  appPath?: string;
  /** Answers whether a path is an existing file, an existing directory, or neither. */
  stat: (absolutePath: string) => PathKind | null;
  pathApi?: PathApi;
  /** Case-insensitive path comparison for the app-directory check. Defaults to true on win32. */
  caseInsensitive?: boolean;
}

const MAX_ARGS = 64;
const MAX_POSITION = 1_000_000_000;
const URL_LIKE = /^[a-z][a-z0-9+.-]+:\/\//i;
const POSITION_SUFFIX = /^(.+?):(\d+)(?::(\d+))?$/;

function samePathText(a: string, b: string, caseInsensitive: boolean): boolean {
  const trim = (p: string) => p.replace(/[\\/]+$/, '');
  const x = trim(a);
  const y = trim(b);
  return caseInsensitive ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function readPosition(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_POSITION ? value : undefined;
}

/**
 * Resolve one positional argument. A path that exists exactly as written wins over reading a
 * `:line:column` suffix, so "notes:2024" still opens a file with that name.
 */
function classify(
  arg: string,
  options: Required<Pick<ParseOptions, 'cwd' | 'stat'>> & { pathApi: PathApi },
): { kind: PathKind; target: OpenTarget } | null {
  const { cwd, stat, pathApi } = options;
  const literal = pathApi.resolve(cwd, arg);
  const literalKind = stat(literal);
  if (literalKind) return { kind: literalKind, target: { path: literal } };

  const match = POSITION_SUFFIX.exec(arg);
  if (!match) return null;
  const prefix = match[1] ?? '';
  const line = readPosition(match[2]);
  const column = readPosition(match[3]);
  // "C:12" is a drive letter followed by digits, not a file "C" at line 12.
  if (prefix.length < 2 || line === undefined) return null;
  if (match[3] !== undefined && column === undefined) return null;
  const resolved = pathApi.resolve(cwd, prefix);
  const kind = stat(resolved);
  if (!kind) return null;
  if (kind === 'directory') return { kind, target: { path: resolved } };
  return {
    kind,
    target: { path: resolved, line, ...(column !== undefined ? { column } : {}) },
  };
}

/**
 * Parse `process.argv` (or a second instance's command line). The first element is the
 * executable. Unknown `-`/`--` arguments are Chromium or Electron internals and are ignored.
 */
export function parseLaunchArgs(argv: readonly string[], options: ParseOptions): LaunchRequest {
  const pathApi = options.pathApi ?? path;
  const caseInsensitive = options.caseInsensitive ?? process.platform === 'win32';
  const request: LaunchRequest = { newWindow: false, folders: [], files: [], missing: [] };
  const seen = new Set<string>();
  const key = (p: string) => (caseInsensitive ? p.toLowerCase() : p);

  let positionalOnly = false;
  for (let i = 1; i < argv.length && i <= MAX_ARGS; i++) {
    const arg = argv[i];
    if (typeof arg !== 'string' || arg.length === 0 || arg.includes('\0')) continue;

    if (!positionalOnly && arg.startsWith('-')) {
      if (arg === '--') {
        positionalOnly = true;
      } else if (arg === '--new-window' || arg === '-n') {
        request.newWindow = true;
      } else if (arg.startsWith('--user-data-dir=')) {
        const value = arg.slice('--user-data-dir='.length);
        if (value) request.userDataDir = pathApi.resolve(options.cwd, value);
      } else if (arg === '--user-data-dir') {
        const value = argv[i + 1];
        if (typeof value === 'string' && value && !value.startsWith('-')) {
          request.userDataDir = pathApi.resolve(options.cwd, value);
          i++;
        }
      }
      continue;
    }

    if (URL_LIKE.test(arg)) continue;
    if (
      options.appPath &&
      samePathText(pathApi.resolve(options.cwd, arg), options.appPath, caseInsensitive)
    ) {
      continue;
    }

    const found = classify(arg, { cwd: options.cwd, stat: options.stat, pathApi });
    if (!found) {
      request.missing.push(arg);
      continue;
    }
    const dedupe = key(found.target.path) + '|' + (found.target.line ?? '') + '|' + (found.target.column ?? '');
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    if (found.kind === 'directory') request.folders.push(found.target.path);
    else request.files.push(found.target);
  }
  return request;
}

/** True when nothing on the command line asks for a specific folder or file. */
export function isEmptyLaunch(request: LaunchRequest): boolean {
  return request.folders.length === 0 && request.files.length === 0;
}
