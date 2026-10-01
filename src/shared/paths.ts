/**
 * Platform-agnostic path helpers that work on plain strings.
 *
 * The renderer has no Node `path` module, and paths cross the IPC boundary as native strings
 * (`C:\repo\src\a.ts` on Windows, `/repo/src/a.ts` elsewhere). These helpers accept both
 * separators and never touch the file system.
 */

export type Platform = 'win32' | 'darwin' | 'linux';

const WIN_DRIVE = /^[a-zA-Z]:([\\/]|$)/;

export function isWindowsPath(p: string): boolean {
  return WIN_DRIVE.test(p) || p.startsWith('\\\\');
}

export function separatorOf(p: string): '/' | '\\' {
  return isWindowsPath(p) ? '\\' : '/';
}

/** Trailing separators removed (but never the root itself: "/" and "C:\"). */
export function trimTrailingSeparators(p: string): string {
  let end = p.length;
  while (end > 1 && (p[end - 1] === '/' || p[end - 1] === '\\')) {
    if (end === 3 && WIN_DRIVE.test(p)) break; // "C:\"
    end--;
  }
  return p.slice(0, end);
}

export function basename(p: string): string {
  const t = trimTrailingSeparators(p);
  const i = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'));
  return i === -1 ? t : t.slice(i + 1);
}

export function dirname(p: string): string {
  const t = trimTrailingSeparators(p);
  const i = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'));
  if (i === -1) return '';
  if (i === 0) return t[0] ?? '/';
  const head = t.slice(0, i);
  // "C:" -> "C:\"
  return /^[a-zA-Z]:$/.test(head) ? head + t[i] : head;
}

/** File extension including the dot, lower-cased ("" when there is none; ".gitignore" has none). */
export function extname(p: string): string {
  const name = basename(p);
  const i = name.lastIndexOf('.');
  return i <= 0 ? '' : name.slice(i).toLowerCase();
}

export function join(base: string, ...parts: string[]): string {
  const sep = separatorOf(base);
  let out = trimTrailingSeparators(base);
  for (const part of parts) {
    const clean = part.replace(/^[\\/]+|[\\/]+$/g, '');
    if (!clean) continue;
    out = out.endsWith('/') || out.endsWith('\\') ? out + clean : out + sep + clean;
  }
  return sep === '\\' ? out.replace(/\//g, '\\') : out;
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Comparison key for a path: separators unified, trailing separators dropped, and lower-cased on
 * case-insensitive platforms. Use it for Map/Set keys and equality checks.
 */
export function pathKey(p: string, platform: Platform): string {
  const t = toPosix(trimTrailingSeparators(p));
  return platform === 'linux' ? t : t.toLowerCase();
}

export function samePath(a: string, b: string, platform: Platform): boolean {
  return pathKey(a, platform) === pathKey(b, platform);
}

/** True when `child` is `parent` or lives underneath it. */
export function isWithin(parent: string, child: string, platform: Platform): boolean {
  const p = pathKey(parent, platform);
  const c = pathKey(child, platform);
  if (c === p) return true;
  return c.startsWith(p.endsWith('/') ? p : p + '/');
}

/** Path of `child` relative to `root` using forward slashes, or null when it is outside. */
export function relativeTo(root: string, child: string, platform: Platform): string | null {
  if (!isWithin(root, child, platform)) return null;
  const r = trimTrailingSeparators(toPosix(root));
  const c = toPosix(child);
  if (c.length <= r.length) return '';
  return c.slice(r.endsWith('/') ? r.length : r.length + 1);
}

/** Split into segments, dropping empties: "a/b\c" -> ["a","b","c"]. */
export function segments(p: string): string[] {
  return p.split(/[\\/]+/).filter(Boolean);
}

/** Convert an absolute native path to a `file:` URI string. */
export function toFileUri(p: string): string {
  const posix = toPosix(p);
  const prefix = /^[a-zA-Z]:/.test(posix) ? '/' : posix.startsWith('//') ? '' : '';
  return 'file://' + encodeURI(prefix + posix).replace(/[?#]/g, encodeURIComponent);
}

/** Split a file name into parts for natural, case-insensitive sorting in the explorer. */
export function compareNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}
