/**
 * Finds file references in terminal output, such as `src/app.ts:12:5`, `./util.ts(7,3)` or
 * `C:\work\app\main.py:40`. Pure text analysis: whether the file exists is decided by the caller.
 */
export interface PathLink {
  /** Index in the line where the link text starts. */
  start: number;
  /** Index just past the end of the link text. */
  end: number;
  /** The path as written (relative or absolute). */
  path: string;
  line: number;
  column?: number;
}

// A path made of word characters, dots, dashes and separators, ending in a file extension,
// followed by ":line", ":line:col" or "(line,col)". The leading boundary stops it starting
// in the middle of a word or URL.
const SEGMENT = String.raw`(?:@[\w~.+-]+|[\w~.+-]+)`;
const PATH_PART = String.raw`(?:[A-Za-z]:[\\/]|[\\/])?(?:${SEGMENT}[\\/])*[\w~.+-]+\.(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{1,8}`;
const PATTERN = new RegExp(
  String.raw`(?<![\w/\\:.@-])(${PATH_PART})(?::(\d{1,7})(?::(\d{1,5}))?|\((\d{1,7})(?:,\s*(\d{1,5}))?\))`,
  'g',
);

const MAX_LINE_LENGTH = 4000;

export function findPathLinks(text: string): PathLink[] {
  if (text.length === 0 || text.length > MAX_LINE_LENGTH) return [];
  const links: PathLink[] = [];
  for (const match of text.matchAll(PATTERN)) {
    const path = match[1] as string;
    // "http://host:80/x.js:3" is a URL, not a file: the boundary rule already skips most, this is the rest.
    if (
      /^[A-Za-z][\w+.-]*:\/\//.test(
        text.slice(Math.max(0, (match.index ?? 0) - 12), (match.index ?? 0) + path.length),
      )
    ) {
      continue;
    }
    const line = Number(match[2] ?? match[4]);
    const columnText = match[3] ?? match[5];
    if (!Number.isSafeInteger(line) || line < 1) continue;
    links.push({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      path,
      line,
      ...(columnText !== undefined ? { column: Number(columnText) } : {}),
    });
  }
  return links;
}

/** Resolve a path found in output against the terminal's working folder. */
export function resolveLinkPath(path: string, cwd: string, isWindows: boolean): string {
  const absolute = isWindows
    ? /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
    : path.startsWith('/');
  if (absolute) return path;
  const separator = isWindows ? '\\' : '/';
  const parts = path.split(/[\\/]/).filter((part) => part !== '' && part !== '.');
  const base = cwd.replace(/[\\/]+$/, '').split(/[\\/]/);
  for (const part of parts) {
    if (part === '..') {
      if (base.length > 1) base.pop();
    } else {
      base.push(part);
    }
  }
  return base.join(separator);
}
