/**
 * Fuzzy subsequence matching used by the command palette, quick open and the workspace file
 * index. The scoring follows the well-known "fzy" model: contiguous runs, word boundaries,
 * path separators and camelCase humps score higher, gaps score lower.
 *
 * Pure and dependency-free so it runs in both the main process and the renderer.
 */

export interface FuzzyMatch {
  /** Higher is better. Only comparable between matches of the same query. */
  score: number;
  /** Indexes into the target string of each matched query character. */
  positions: number[];
}

const SCORE_MIN = -Infinity;
const GAP_LEADING = -0.005;
const GAP_TRAILING = -0.005;
const GAP_INNER = -0.01;
const MATCH_CONSECUTIVE = 1.0;
const MATCH_SLASH = 0.9;
const MATCH_WORD = 0.8;
const MATCH_CAPITAL = 0.7;
const MATCH_DOT = 0.6;
const MAX_TARGET_LENGTH = 1024;
/** Bonus applied when a path query matches inside the file name itself. */
const BASENAME_BONUS = 2;

function isLower(ch: string): boolean {
  return ch >= 'a' && ch <= 'z';
}
function isUpper(ch: string): boolean {
  return ch >= 'A' && ch <= 'Z';
}

function bonusFor(target: string): number[] {
  const bonus = new Array<number>(target.length);
  let last = '/';
  for (let i = 0; i < target.length; i++) {
    const ch = target[i] as string;
    let b = 0;
    if (last === '/' || last === '\\') b = MATCH_SLASH;
    else if (last === '-' || last === '_' || last === ' ') b = MATCH_WORD;
    else if (last === '.') b = MATCH_DOT;
    else if (isLower(last) && isUpper(ch)) b = MATCH_CAPITAL;
    bonus[i] = b;
    last = ch;
  }
  return bonus;
}

/** Cheap pre-filter: is `query` a case-insensitive subsequence of `target`? */
export function isSubsequence(query: string, target: string): boolean {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

function matchCore(query: string, target: string, offset: number): FuzzyMatch | null {
  const n = query.length;
  const m = target.length;
  if (n === 0) return { score: 0, positions: [] };
  if (m === 0 || n > m) return null;

  const needle = query.toLowerCase();
  const hay = target.toLowerCase();
  if (!isSubsequence(needle, hay)) return null;

  if (m > MAX_TARGET_LENGTH) {
    // Degenerate input: fall back to a greedy, in-order match.
    const positions: number[] = [];
    let ti = 0;
    for (let qi = 0; qi < n; qi++) {
      while (ti < m && hay[ti] !== needle[qi]) ti++;
      positions.push(ti + offset);
      ti++;
    }
    return { score: -positions.length, positions };
  }

  const bonus = bonusFor(target);
  const D: Float64Array[] = [];
  const M: Float64Array[] = [];

  for (let i = 0; i < n; i++) {
    const d = new Float64Array(m);
    const mm = new Float64Array(m);
    let prev = SCORE_MIN;
    const gap = i === n - 1 ? GAP_TRAILING : GAP_INNER;
    for (let j = 0; j < m; j++) {
      if (needle[i] === hay[j]) {
        let score = SCORE_MIN;
        if (i === 0) {
          score = j * GAP_LEADING + (bonus[j] as number);
        } else if (j > 0) {
          score = Math.max(
            (M[i - 1] as Float64Array)[j - 1]! + (bonus[j] as number),
            (D[i - 1] as Float64Array)[j - 1]! + MATCH_CONSECUTIVE,
          );
        }
        d[j] = score;
        prev = Math.max(score, prev + gap);
        mm[j] = prev;
      } else {
        d[j] = SCORE_MIN;
        prev = prev + gap;
        mm[j] = prev;
      }
    }
    D.push(d);
    M.push(mm);
  }

  const positions = new Array<number>(n);
  let matchRequired = false;
  let j = m - 1;
  for (let i = n - 1; i >= 0; i--) {
    for (; j >= 0; j--) {
      const d = (D[i] as Float64Array)[j]!;
      const mm = (M[i] as Float64Array)[j]!;
      if (d !== SCORE_MIN && (matchRequired || d === mm)) {
        matchRequired =
          i > 0 && j > 0 && mm === (D[i - 1] as Float64Array)[j - 1]! + MATCH_CONSECUTIVE;
        positions[i] = j + offset;
        j--;
        break;
      }
    }
  }

  return { score: (M[n - 1] as Float64Array)[m - 1]!, positions };
}

/**
 * Match `query` against `target`. Returns null when `query` is not a subsequence.
 *
 * With `pathMode`, a query that also matches within the final path segment is boosted, so that
 * typing "idx" prefers `src/index.ts` over `src/inline/dx/foo.ts`.
 */
export function fuzzyMatch(
  query: string,
  target: string,
  options: { pathMode?: boolean } = {},
): FuzzyMatch | null {
  const full = matchCore(query, target, 0);
  if (!full || !options.pathMode) return full;

  const cut = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\')) + 1;
  if (cut === 0) return full;
  const base = matchCore(query, target.slice(cut), cut);
  if (base && base.score + BASENAME_BONUS > full.score) {
    return { score: base.score + BASENAME_BONUS, positions: base.positions };
  }
  return full;
}

export interface FuzzyResult<T> {
  item: T;
  score: number;
  positions: number[];
}

/** Filter and rank `items`, best first; ties keep the original order. */
export function fuzzyFilter<T>(
  query: string,
  items: readonly T[],
  getText: (item: T) => string,
  options: { limit?: number; pathMode?: boolean } = {},
): FuzzyResult<T>[] {
  const out: FuzzyResult<T>[] = [];
  for (const item of items) {
    const m = fuzzyMatch(query, getText(item), { pathMode: options.pathMode });
    if (m) out.push({ item, score: m.score, positions: m.positions });
  }
  out.sort((a, b) => b.score - a.score);
  return options.limit ? out.slice(0, options.limit) : out;
}

/** Split text into runs marked as matched/unmatched, for highlighting. */
export function highlightRuns(
  text: string,
  positions: readonly number[],
): { text: string; match: boolean }[] {
  const set = new Set(positions);
  const runs: { text: string; match: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const match = set.has(i);
    const last = runs[runs.length - 1];
    if (last && last.match === match) last.text += text[i];
    else runs.push({ text: text[i] as string, match });
  }
  return runs;
}
