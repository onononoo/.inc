import picomatch from 'picomatch';

export type GlobTest = (relativePath: string) => boolean;

const caseInsensitive = process.platform !== 'linux';
const cache = new Map<string, GlobTest>();
const CACHE_LIMIT = 16;

function normalisePattern(pattern: string): string {
  let p = pattern.trim().replace(/\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/** Names of the enabled patterns in a `files.exclude` style record. */
export function enabledPatterns(record: Record<string, boolean> | undefined): string[] {
  if (!record) return [];
  const out: string[] = [];
  for (const [pattern, on] of Object.entries(record)) {
    if (on === true) {
      const p = normalisePattern(pattern);
      if (p) out.push(p);
    }
  }
  return out;
}

/**
 * Compile glob patterns (relative to the workspace root, forward slashes) into a predicate.
 * Invalid patterns are skipped. Compiled matchers are memoised because settings rarely change.
 */
export function compileGlobs(patterns: readonly string[]): GlobTest {
  const key = patterns.join('\n');
  const hit = cache.get(key);
  if (hit) return hit;

  const tests: picomatch.Matcher[] = [];
  for (const pattern of patterns) {
    try {
      tests.push(picomatch(pattern, { dot: true, nocase: caseInsensitive }));
    } catch {
      /* an invalid pattern must not disable the others */
    }
  }
  const test: GlobTest =
    tests.length === 0
      ? () => false
      : (rel) => {
          for (const t of tests) if (t(rel)) return true;
          return false;
        };
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, test);
  return test;
}

const MEMO_LIMIT = 200_000;

/**
 * Applies exclude globs to files in a tree. A path is excluded when it, or any folder above it,
 * matches. Folder decisions are memoised, so a sorted stream of a million paths costs one glob
 * test per file plus one per distinct folder.
 */
export class ExcludeFilter {
  private readonly dirs = new Map<string, boolean>();

  constructor(private readonly test: GlobTest) {}

  isDirExcluded(dirRel: string): boolean {
    if (dirRel === '') return false;
    const known = this.dirs.get(dirRel);
    if (known !== undefined) return known;
    const slash = dirRel.lastIndexOf('/');
    const parent = slash === -1 ? '' : dirRel.slice(0, slash);
    const excluded = this.isDirExcluded(parent) || this.test(dirRel) || this.test(dirRel + '/');
    if (this.dirs.size >= MEMO_LIMIT) this.dirs.clear();
    this.dirs.set(dirRel, excluded);
    return excluded;
  }

  isFileExcluded(rel: string): boolean {
    const slash = rel.lastIndexOf('/');
    if (slash !== -1 && this.isDirExcluded(rel.slice(0, slash))) return true;
    return this.test(rel);
  }
}
