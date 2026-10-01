/**
 * Pure helpers for replacing text found by a search: expanding a replacement template and
 * replacing one match in a text. The on-disk bulk replace runs in the main process; these serve
 * single replacements and open (possibly unsaved) editors.
 */

/** Expand `$1`, `$&` and `$$` in a replacement for a regular expression match. */
export function expandReplacement(
  template: string,
  groups: readonly (string | undefined)[],
): string {
  let out = '';
  for (let i = 0; i < template.length; i++) {
    const c = template[i];
    if (c !== '$' || i === template.length - 1) {
      out += c;
      continue;
    }
    const next = template[i + 1] as string;
    if (next === '$') {
      out += '$';
      i++;
    } else if (next === '&') {
      out += groups[0] ?? '';
      i++;
    } else if (next >= '0' && next <= '9') {
      // One or two digits: "$12" is group 12 when it exists, otherwise group 1 followed by "2".
      const two = template.slice(i + 1, i + 3);
      const useTwo = /^\d\d$/.test(two) && Number(two) < groups.length && Number(two) > 0;
      const digits = useTwo ? two : next;
      const index = Number(digits);
      if (index > 0 && index < groups.length) {
        out += groups[index] ?? '';
        i += digits.length;
      } else {
        out += c;
      }
    } else {
      out += c;
    }
  }
  return out;
}

export interface MatchTarget {
  /** 1-based. */
  line: number;
  /** 1-based, in UTF-16 code units. */
  column: number;
  /** Length of the match in UTF-16 code units. */
  length: number;
}

export interface ReplaceOneOptions {
  /** The text the query matched at the position, to be sure the file has not changed meanwhile. */
  matchedText?: string;
  replacement: string;
  /** With a regular expression the replacement may use groups; this re-matches the target text. */
  regex?: RegExp | null;
}

/** Split text into lines, keeping each terminator so the text can be rebuilt exactly. */
function lineSpans(text: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) {
      spans.push({ start, end: i });
      start = i + 1;
    } else if (c === 13) {
      spans.push({ start, end: i });
      if (text.charCodeAt(i + 1) === 10) i++;
      start = i + 1;
    }
  }
  spans.push({ start, end: text.length });
  return spans;
}

/**
 * Replace the match at a line and column. Returns the new text, or null when the text at that
 * position is no longer what was found (the file changed since the search).
 */
export function replaceOne(
  text: string,
  target: MatchTarget,
  options: ReplaceOneOptions,
): string | null {
  const spans = lineSpans(text);
  const span = spans[target.line - 1];
  if (!span) return null;
  const from = span.start + target.column - 1;
  const to = from + target.length;
  if (from < span.start || to > span.end) return null;
  const found = text.slice(from, to);
  if (options.matchedText !== undefined && found !== options.matchedText) return null;
  let replacement = options.replacement;
  if (options.regex) {
    const re = new RegExp(options.regex.source, options.regex.flags.replace(/[gy]/g, ''));
    const m = re.exec(found);
    if (!m) return null;
    replacement = expandReplacement(options.replacement, m);
  }
  return text.slice(0, from) + replacement + text.slice(to);
}

/** Text of the match for display: the preview slice between the reported offsets. */
export function matchText(preview: string, start: number, end: number): string {
  return preview.slice(start, end);
}
