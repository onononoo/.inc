/**
 * Pure text operations used by the save pipeline and the status-bar commands. Nothing here
 * touches Monaco or the DOM, so every function is unit tested in Node.
 *
 * Edits use Monaco's 1-based line and column numbers and are shaped like
 * `IIdentifiedSingleEditOperation`, so they can be passed to `model.pushEditOperations` as is.
 */
import type { EndOfLine } from '@shared/encodings';

export interface TextRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export interface TextEdit {
  range: TextRange;
  text: string;
}

/** Random access to the lines of a document (1-based), without materialising all of them. */
export interface LineSource {
  readonly lineCount: number;
  line(lineNumber: number): string;
}

export function linesOf(lines: readonly string[]): LineSource {
  return { lineCount: lines.length, line: (n) => lines[n - 1] ?? '' };
}

export function eolSequence(eol: EndOfLine): string {
  return eol === 'crlf' ? '\r\n' : '\n';
}

/** Dominant line ending of a text (LF when it has none). Ties go to LF. */
export function detectEol(text: string): { eol: EndOfLine; mixed: boolean } {
  let crlf = 0;
  let lf = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++;
    else lf++;
  }
  return { eol: crlf > lf ? 'crlf' : 'lf', mixed: crlf > 0 && lf > 0 };
}

/** Convert every line ending (CRLF, lone CR, LF) to `eol`. */
export function normalizeEol(text: string, eol: EndOfLine): string {
  return text.replace(/\r\n|\r|\n/g, eolSequence(eol));
}

/** First line of a text without its terminator, capped so huge single-line files stay cheap. */
export function firstLineOf(text: string, maxLength = 512): string {
  const end = text.search(/[\r\n]/);
  return text.slice(0, end === -1 ? Math.min(text.length, maxLength) : Math.min(end, maxLength));
}

/** Edits that remove spaces and tabs at the end of every line. */
export function trailingWhitespaceEdits(source: LineSource): TextEdit[] {
  const edits: TextEdit[] = [];
  for (let n = 1; n <= source.lineCount; n++) {
    const text = source.line(n);
    let end = text.length;
    while (end > 0 && (text.charCodeAt(end - 1) === 32 || text.charCodeAt(end - 1) === 9)) end--;
    if (end !== text.length) {
      edits.push({
        range: {
          startLineNumber: n,
          startColumn: end + 1,
          endLineNumber: n,
          endColumn: text.length + 1,
        },
        text: '',
      });
    }
  }
  return edits;
}

/**
 * The edit that makes a document end with a line terminator, or null when it already does or is
 * empty (an empty file stays empty).
 */
export function finalNewlineEdit(source: LineSource, eol: EndOfLine): TextEdit | null {
  const last = source.lineCount;
  const text = source.line(last);
  if (text.length === 0) return null;
  const column = text.length + 1;
  return {
    range: { startLineNumber: last, startColumn: column, endLineNumber: last, endColumn: column },
    text: eolSequence(eol),
  };
}

/** Width in columns of the leading whitespace of a line, and the index where it ends. */
function leadingWidth(text: string, tabSize: number): { width: number; end: number } {
  let width = 0;
  let i = 0;
  for (; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32) width++;
    else if (c === 9) width += tabSize - (width % tabSize);
    else break;
  }
  return { width, end: i };
}

function replaceLeading(lineNumber: number, end: number, text: string): TextEdit {
  return {
    range: {
      startLineNumber: lineNumber,
      startColumn: 1,
      endLineNumber: lineNumber,
      endColumn: end + 1,
    },
    text,
  };
}

/**
 * Convert the leading whitespace of every line to spaces or to tabs, keeping the visual width at
 * `tabSize`. Lines that already use the requested style are left alone.
 */
export function convertIndentationEdits(
  source: LineSource,
  to: 'spaces' | 'tabs',
  tabSize: number,
): TextEdit[] {
  const size = Math.max(1, Math.floor(tabSize));
  const edits: TextEdit[] = [];
  for (let n = 1; n <= source.lineCount; n++) {
    const text = source.line(n);
    const { width, end } = leadingWidth(text, size);
    if (end === 0) continue;
    const replacement =
      to === 'spaces'
        ? ' '.repeat(width)
        : '\t'.repeat(Math.floor(width / size)) + ' '.repeat(width % size);
    if (replacement !== text.slice(0, end)) edits.push(replaceLeading(n, end, replacement));
  }
  return edits;
}

/**
 * Re-express indentation written in units of `fromSize` columns as units of `toSize` columns
 * (for example a file indented by 4 that should be indented by 2). Whitespace that is not a whole
 * number of units keeps its remainder as spaces.
 */
export function reindentEdits(
  source: LineSource,
  options: { fromSize: number; toSize: number; insertSpaces: boolean; tabSize: number },
): TextEdit[] {
  const from = Math.max(1, Math.floor(options.fromSize));
  const to = Math.max(1, Math.floor(options.toSize));
  const unit = options.insertSpaces ? ' '.repeat(to) : '\t';
  const edits: TextEdit[] = [];
  for (let n = 1; n <= source.lineCount; n++) {
    const text = source.line(n);
    const { width, end } = leadingWidth(text, options.tabSize);
    if (end === 0) continue;
    const levels = Math.floor(width / from);
    const replacement = unit.repeat(levels) + ' '.repeat(width % from);
    if (replacement !== text.slice(0, end)) edits.push(replaceLeading(n, end, replacement));
  }
  return edits;
}

/** What `detectIndentation` found in a text. */
export interface DetectedIndentation {
  insertSpaces: boolean;
  tabSize: number;
}

/**
 * Guess the indentation style from the first lines of a file: tabs when most indented lines start
 * with a tab, otherwise the most common positive difference between consecutive indentation
 * widths (the same idea Monaco uses). Returns null when the text has no indentation to learn from.
 */
export function detectIndentation(
  source: LineSource,
  fallbackTabSize: number,
  maxLines = 10_000,
): DetectedIndentation | null {
  let tabLines = 0;
  let spaceLines = 0;
  const diffs = new Map<number, number>();
  let previous = 0;
  const limit = Math.min(source.lineCount, maxLines);
  for (let n = 1; n <= limit; n++) {
    const text = source.line(n);
    if (text.trim().length === 0) continue;
    const first = text.charCodeAt(0);
    let width = 0;
    if (first === 9) {
      tabLines++;
      width = leadingWidth(text, fallbackTabSize).width;
    } else if (first === 32) {
      const spaces = leadingWidth(text, fallbackTabSize);
      width = spaces.width;
      if (spaces.width > 1) spaceLines++;
    }
    const diff = Math.abs(width - previous);
    if (diff > 1 && first !== 9) diffs.set(diff, (diffs.get(diff) ?? 0) + 1);
    previous = width;
  }
  if (tabLines === 0 && spaceLines === 0) return null;
  if (tabLines > spaceLines) return { insertSpaces: false, tabSize: fallbackTabSize };
  let best = 0;
  let bestCount = 0;
  for (const size of [2, 4, 8, 3, 6, 5, 7]) {
    const count = diffs.get(size) ?? 0;
    if (count > bestCount) {
      best = size;
      bestCount = count;
    }
  }
  return { insertSpaces: true, tabSize: best || fallbackTabSize };
}

/**
 * Smallest line-based change that turns `oldLines` into `newLines`: the common leading and
 * trailing lines are kept. Applying this instead of replacing the whole document keeps cursors,
 * selections, folding and scroll position outside the changed region exactly where they were.
 */
export interface LineReplacement {
  /** First old line that changes (1-based). */
  startLine: number;
  /** Number of old lines replaced (0 for a pure insertion). */
  removeCount: number;
  /** Replacement lines. */
  lines: string[];
}

export function minimalLineReplacement(
  oldLines: readonly string[],
  newLines: readonly string[],
): LineReplacement | null {
  let prefix = 0;
  const shortest = Math.min(oldLines.length, newLines.length);
  while (prefix < shortest && oldLines[prefix] === newLines[prefix]) prefix++;
  if (prefix === oldLines.length && prefix === newLines.length) return null;
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }
  return {
    startLine: prefix + 1,
    removeCount: oldLines.length - prefix - suffix,
    lines: newLines.slice(prefix, newLines.length - suffix),
  };
}

/** Split text into lines on any line terminator. */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/**
 * Turn a line replacement into the single edit that performs it on a document that currently has
 * `lineCount` lines. `maxColumn(line)` returns the column just past the last character of a line.
 */
export function replacementToEdit(
  replacement: LineReplacement,
  lineCount: number,
  maxColumn: (lineNumber: number) => number,
  eol: EndOfLine,
): TextEdit {
  const sequence = eolSequence(eol);
  const text = replacement.lines.join(sequence);
  const { startLine, removeCount } = replacement;

  if (removeCount === 0) {
    if (startLine <= lineCount) {
      return {
        range: {
          startLineNumber: startLine,
          startColumn: 1,
          endLineNumber: startLine,
          endColumn: 1,
        },
        text: text + sequence,
      };
    }
    const column = maxColumn(lineCount);
    return {
      range: {
        startLineNumber: lineCount,
        startColumn: column,
        endLineNumber: lineCount,
        endColumn: column,
      },
      text: sequence + text,
    };
  }

  const endLine = startLine + removeCount - 1;
  if (replacement.lines.length > 0) {
    return {
      range: {
        startLineNumber: startLine,
        startColumn: 1,
        endLineNumber: endLine,
        endColumn: maxColumn(endLine),
      },
      text,
    };
  }
  if (endLine < lineCount) {
    return {
      range: {
        startLineNumber: startLine,
        startColumn: 1,
        endLineNumber: endLine + 1,
        endColumn: 1,
      },
      text: '',
    };
  }
  if (startLine > 1) {
    return {
      range: {
        startLineNumber: startLine - 1,
        startColumn: maxColumn(startLine - 1),
        endLineNumber: endLine,
        endColumn: maxColumn(endLine),
      },
      text: '',
    };
  }
  return {
    range: {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: endLine,
      endColumn: maxColumn(endLine),
    },
    text: '',
  };
}
