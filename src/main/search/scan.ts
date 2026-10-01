/** Finding matches in decoded text and building the preview shown for each one. */
import type { SearchMatch } from '@shared/api/search';
import { forEachLine } from './text';
import {
  MAX_MATCHES_PER_FILE,
  MAX_MATCHES_PER_LINE,
  PREVIEW_CONTEXT_BEFORE,
  PREVIEW_MAX_CHARS,
} from './protocol';

export interface ScanHooks {
  /** Called for every line; the watchdog uses it to see that the scan is making progress. */
  heartbeat?: () => void;
  /** Polled every few hundred lines; return true to abandon the scan. */
  shouldStop?: () => boolean;
}

export interface ScanResult {
  matches: SearchMatch[];
  /** More matches exist than are listed. */
  truncated: boolean;
}

const STOP_CHECK_INTERVAL = 256;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Preview text for a match: the whole line when it is short, otherwise a window that starts a
 * little before the match. The window never splits a surrogate pair and always starts at or
 * before the match; a match longer than the window is clipped at the window's end.
 */
export function buildPreview(
  line: string,
  matchStart: number,
  matchEnd: number,
): Pick<SearchMatch, 'preview' | 'previewMatchStart' | 'previewMatchEnd'> {
  if (line.length <= PREVIEW_MAX_CHARS) {
    return { preview: line, previewMatchStart: matchStart, previewMatchEnd: matchEnd };
  }
  let from = Math.max(0, matchStart - PREVIEW_CONTEXT_BEFORE);
  let to = Math.min(line.length, from + PREVIEW_MAX_CHARS);
  if (from > 0 && isLowSurrogate(line.charCodeAt(from)) && isHighSurrogate(line.charCodeAt(from - 1))) {
    from--;
  }
  if (to < line.length && isHighSurrogate(line.charCodeAt(to - 1)) && isLowSurrogate(line.charCodeAt(to))) {
    to--;
  }
  return {
    preview: line.slice(from, to),
    previewMatchStart: matchStart - from,
    previewMatchEnd: Math.min(matchEnd, to) - from,
  };
}

/** Index to continue from after an empty match, stepping over a whole surrogate pair. */
function stepPastEmpty(line: string, index: number, unicode: boolean): number {
  if (unicode && isHighSurrogate(line.charCodeAt(index)) && isLowSurrogate(line.charCodeAt(index + 1))) {
    return index + 2;
  }
  return index + 1;
}

/**
 * Scan `text` line by line. `regex` must have the global flag. Positions are 1-based lines and
 * columns counted in UTF-16 code units from the start of the line (a "\r\n" is not part of it).
 * Empty matches are ignored. At most 100 matches are kept per line and 5000 per file.
 */
export function scanText(text: string, regex: RegExp, hooks: ScanHooks = {}): ScanResult {
  const matches: SearchMatch[] = [];
  const unicode = regex.unicode;
  let truncated = false;
  let sinceCheck = 0;

  forEachLine(text, (start, end, lineNumber) => {
    hooks.heartbeat?.();
    if (++sinceCheck >= STOP_CHECK_INTERVAL) {
      sinceCheck = 0;
      if (hooks.shouldStop?.()) return false;
    }
    if (end === start) return;
    const line = text.slice(start, end);
    regex.lastIndex = 0;
    let onLine = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(line)) !== null) {
      const length = m[0].length;
      if (length === 0) {
        regex.lastIndex = stepPastEmpty(line, m.index, unicode);
        if (regex.lastIndex > line.length) break;
        continue;
      }
      if (matches.length >= MAX_MATCHES_PER_FILE || onLine >= MAX_MATCHES_PER_LINE) {
        truncated = true;
        break;
      }
      matches.push({
        line: lineNumber,
        column: m.index + 1,
        length,
        ...buildPreview(line, m.index, m.index + length),
      });
      onLine++;
    }
    return matches.length < MAX_MATCHES_PER_FILE || !truncated;
  });
  return { matches, truncated };
}

/**
 * Apply a replacement to every match in `text`, line by line, keeping every line terminator as
 * it is. Returns the new text and the number of replacements; the text is returned unchanged
 * when nothing matched.
 */
export function replaceInText(
  text: string,
  regex: RegExp,
  expand: (match: RegExpExecArray) => string,
  hooks: ScanHooks = {},
): { text: string; count: number } {
  const unicode = regex.unicode;
  const parts: string[] = [];
  let copied = 0;
  let count = 0;
  let sinceCheck = 0;

  forEachLine(text, (start, end) => {
    hooks.heartbeat?.();
    if (++sinceCheck >= STOP_CHECK_INTERVAL) {
      sinceCheck = 0;
      if (hooks.shouldStop?.()) return false;
    }
    if (end === start) return;
    const line = text.slice(start, end);
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(line)) !== null) {
      const length = m[0].length;
      if (length === 0) {
        regex.lastIndex = stepPastEmpty(line, m.index, unicode);
        if (regex.lastIndex > line.length) break;
        continue;
      }
      parts.push(text.slice(copied, start + m.index), expand(m));
      copied = start + m.index + length;
      count++;
    }
  });
  if (count === 0) return { text, count: 0 };
  parts.push(text.slice(copied));
  return { text: parts.join(''), count };
}
