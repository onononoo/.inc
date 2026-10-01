/**
 * Glob handling for the include and exclude filters.
 *
 * Patterns are relative to the workspace root and always matched against forward-slash paths:
 *  - a pattern that names a folder ("src", "packages/api") includes everything below it;
 *  - a pattern without a slash that contains wildcards ("*.ts") matches at any depth;
 *  - anything else is anchored at the root ("src/**\/*.ts", "**\/node_modules").
 */
import picomatch from 'picomatch';

const caseInsensitive = process.platform !== 'linux';

/** Trim, use forward slashes, drop "./" and leading or trailing slashes. Null when nothing is left. */
export function normalizeGlob(raw: string): string | null {
  let p = raw.trim().replace(/\\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  p = p.replace(/^\/+/, '').replace(/\/+$/, '');
  return p === '' || p === '.' ? null : p;
}

/** Normalised patterns from a `search.exclude` style record (only the enabled ones). */
export function enabledPatterns(record: Record<string, boolean> | undefined): string[] {
  if (!record) return [];
  const out: string[] = [];
  for (const [pattern, on] of Object.entries(record)) {
    if (on !== true) continue;
    const p = normalizeGlob(pattern);
    if (p) out.push(p);
  }
  return out;
}

function hasWildcards(pattern: string): boolean {
  return /[*?[\]{}()!]/.test(pattern);
}

/** The picomatch patterns a user pattern stands for. */
function expand(pattern: string): string[] {
  const anywhere = !pattern.includes('/') && hasWildcards(pattern);
  const base = anywhere ? `**/${pattern}` : pattern;
  return base.endsWith('/**') ? [base] : [base, `${base}/**`];
}

/** Leading path segments of a pattern that contain no wildcards. */
function staticPrefix(pattern: string): string[] {
  if (!pattern.includes('/') && hasWildcards(pattern)) return [];
  const scan = picomatch.scan(pattern);
  const base = scan.isGlob ? scan.base : pattern;
  const segments = base.split('/').filter(Boolean);
  const key = caseInsensitive ? (s: string) => s.toLowerCase() : (s: string) => s;
  return segments.map(key);
}

export class GlobSet {
  private readonly tests: picomatch.Matcher[] = [];
  private readonly prefixes: string[][] = [];

  /** Patterns that do not compile are ignored, so one typo cannot disable the others. */
  constructor(patterns: readonly string[]) {
    for (const raw of patterns) {
      const pattern = normalizeGlob(raw);
      if (!pattern) continue;
      try {
        for (const p of expand(pattern)) {
          this.tests.push(picomatch(p, { dot: true, nocase: caseInsensitive, windows: false }));
        }
        this.prefixes.push(staticPrefix(pattern));
      } catch {
        /* ignore the invalid pattern */
      }
    }
  }

  get isEmpty(): boolean {
    return this.tests.length === 0;
  }

  /** True when the path (file or folder) matches any pattern. */
  matches(relativePath: string): boolean {
    for (const test of this.tests) if (test(relativePath)) return true;
    return false;
  }

  /**
   * For include patterns: false when no file below this folder can possibly match, so the walk
   * can skip it. Always true for patterns that match at any depth.
   */
  mayContain(dirRelativePath: string): boolean {
    if (this.prefixes.length === 0) return true;
    const dir = (caseInsensitive ? dirRelativePath.toLowerCase() : dirRelativePath).split('/');
    return this.prefixes.some((prefix) => {
      const n = Math.min(prefix.length, dir.length);
      for (let i = 0; i < n; i++) if (prefix[i] !== dir[i]) return false;
      return true;
    });
  }
}
