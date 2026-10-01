/**
 * Turns a user query into a regular expression, and expands replacement templates.
 *
 * Matching is line by line, so `^` and `$` mean the start and end of a line and a pattern can
 * never contain a line break.
 */
import type { SearchQuery } from '@shared/api/search';
import { IncError } from '@shared/errors';
import type { MatcherSpec } from './protocol';

export const MAX_PATTERN_LENGTH = 10_000;

const NO_LINE_BREAKS = 'Search patterns cannot span lines. Search for one line at a time.';

/** Characters that count as part of a word for "match whole word". */
const WORD_UNICODE = '[\\p{L}\\p{N}\\p{M}_]';
const WORD_ASCII = '\\w';

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}_]/u;

function startsWithWordChar(text: string): boolean {
  const first = String.fromCodePoint(text.codePointAt(0) ?? 0);
  return WORD_CHAR.test(first);
}

function endsWithWordChar(text: string): boolean {
  const last = text.length >= 2 ? text.slice(-2) : text;
  const chars = Array.from(last);
  return WORD_CHAR.test(chars[chars.length - 1] ?? '');
}

/**
 * True when a regular expression source can only match across lines: a line break written
 * literally or as `\n` / `\r` outside a character class. `[^\n]*` is fine.
 */
export function regexNeedsLineBreak(source: string): boolean {
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '\\') {
      const next = source[i + 1];
      if (!inClass && (next === 'n' || next === 'r')) return true;
      i++;
    } else if (c === '[') {
      inClass = true;
    } else if (c === ']') {
      inClass = false;
    } else if (!inClass && (c === '\n' || c === '\r')) {
      return true;
    }
  }
  return false;
}

function describeRegexError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const detail = raw.replace(/^Invalid regular expression: \/[\s\S]*\/[a-z]*: /, '');
  return `Invalid regular expression: ${detail.replace(/\.$/, '')}.`;
}

function wrapWholeWord(source: string, unicode: boolean, left: boolean, right: boolean): string {
  const word = unicode ? WORD_UNICODE : WORD_ASCII;
  return `${left ? `(?<!${word})` : ''}(?:${source})${right ? `(?!${word})` : ''}`;
}

/**
 * Build the matcher for a query. Throws E_INVALID with a readable message for an empty pattern,
 * a pattern that spans lines, or a regular expression that does not compile.
 */
export function compileQuery(query: SearchQuery): MatcherSpec {
  const pattern = query.pattern;
  if (pattern.length === 0) throw new IncError('E_INVALID', 'Enter something to search for.');
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new IncError('E_INVALID', 'The search pattern is too long.');
  }
  const caseFlag = query.caseSensitive ? '' : 'i';

  if (!query.isRegex) {
    if (/[\r\n]/.test(pattern)) throw new IncError('E_INVALID', NO_LINE_BREAKS);
    const source = query.wholeWord
      ? wrapWholeWord(
          escapeRegExp(pattern),
          true,
          startsWithWordChar(pattern),
          endsWithWordChar(pattern),
        )
      : escapeRegExp(pattern);
    return {
      source,
      flags: `g${caseFlag}u`,
      prefilter: query.caseSensitive ? pattern : null,
      isRegex: false,
    };
  }

  if (regexNeedsLineBreak(pattern)) throw new IncError('E_INVALID', NO_LINE_BREAKS);

  // Unicode mode gives correct results for astral characters and `\p{...}`, but rejects some
  // escapes that older engines tolerate (such as `\-`), so fall back to the legacy syntax.
  const unicodeSource = query.wholeWord ? wrapWholeWord(pattern, true, true, true) : pattern;
  const unicodeFlags = `g${caseFlag}u`;
  try {
    new RegExp(unicodeSource, unicodeFlags);
    return { source: unicodeSource, flags: unicodeFlags, prefilter: null, isRegex: true };
  } catch {
    /* try the legacy syntax below */
  }
  const legacySource = query.wholeWord ? wrapWholeWord(pattern, false, true, true) : pattern;
  const legacyFlags = `g${caseFlag}`;
  try {
    new RegExp(legacySource, legacyFlags);
  } catch (error) {
    throw new IncError('E_INVALID', describeRegexError(error));
  }
  return { source: legacySource, flags: legacyFlags, prefilter: null, isRegex: true };
}

export function buildRegExp(spec: MatcherSpec): RegExp {
  return new RegExp(spec.source, spec.flags);
}

type ReplacementPart =
  | string
  | { kind: 'whole' }
  | { kind: 'digits'; digits: string }
  | { kind: 'named'; name: string; raw: string };

function parseTemplate(template: string): ReplacementPart[] {
  const parts: ReplacementPart[] = [];
  let literal = '';
  const flush = () => {
    if (literal) parts.push(literal);
    literal = '';
  };
  for (let i = 0; i < template.length; i++) {
    const c = template[i] as string;
    if (c !== '$') {
      literal += c;
      continue;
    }
    const next = template[i + 1];
    if (next === '$') {
      literal += '$';
      i++;
    } else if (next === '&') {
      flush();
      parts.push({ kind: 'whole' });
      i++;
    } else if (next !== undefined && next >= '0' && next <= '9') {
      const second = template[i + 2];
      const digits = second !== undefined && second >= '0' && second <= '9' ? next + second : next;
      flush();
      parts.push({ kind: 'digits', digits });
      i += digits.length;
    } else if (next === '<') {
      const close = template.indexOf('>', i + 2);
      if (close === -1) {
        literal += '$<';
        i++;
      } else {
        flush();
        parts.push({
          kind: 'named',
          name: template.slice(i + 2, close),
          raw: template.slice(i, close + 1),
        });
        i = close;
      }
    } else {
      literal += '$';
    }
  }
  flush();
  return parts;
}

function expandDigits(digits: string, match: RegExpExecArray): string {
  const groups = match.length - 1;
  if (digits.length === 2) {
    const two = Number(digits);
    if (two >= 1 && two <= groups) return match[two] ?? '';
  }
  const one = Number(digits[0]);
  if (one >= 1 && one <= groups) return (match[one] ?? '') + digits.slice(1);
  return '$' + digits;
}

/**
 * Compile a replacement template. In regular-expression mode `$1`..`$99`, `$&`, `$$` and
 * `$<name>` are expanded; otherwise the text is used exactly as typed. Line breaks in the
 * template are converted to the file's own line ending.
 */
export function compileReplacement(
  template: string,
  isRegex: boolean,
  eol: '\n' | '\r\n',
): (match: RegExpExecArray) => string {
  const text = template.replace(/\r\n|\r|\n/g, eol);
  if (!isRegex || !text.includes('$')) return () => text;
  const parts = parseTemplate(text);
  return (match) => {
    let out = '';
    for (const part of parts) {
      if (typeof part === 'string') out += part;
      else if (part.kind === 'whole') out += match[0];
      else if (part.kind === 'digits') out += expandDigits(part.digits, match);
      else out += match.groups ? (match.groups[part.name] ?? '') : part.raw;
    }
    return out;
  };
}
