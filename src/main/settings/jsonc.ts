/**
 * JSONC helpers shared by settings, policy and keybindings: tolerant parsing with readable
 * error messages, and targeted text edits that keep the user's comments and formatting.
 */
import {
  applyEdits,
  modify,
  parseTree,
  printParseErrorCode,
  type Node,
  type ParseError,
} from 'jsonc-parser';

export interface SyntaxProblem {
  message: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
}

export interface JsoncDocument {
  /** Root of the syntax tree, or undefined for an empty document (only whitespace and comments). */
  root: Node | undefined;
  problems: SyntaxProblem[];
}

const PARSE_MESSAGES: Record<string, string> = {
  InvalidSymbol: 'Unexpected symbol.',
  InvalidNumberFormat: 'Invalid number.',
  PropertyNameExpected: 'A property name in double quotes is expected.',
  ValueExpected: 'A value is expected.',
  ColonExpected: 'A colon is expected after the property name.',
  CommaExpected: 'A comma is expected between entries.',
  CloseBraceExpected: 'A closing brace is expected.',
  CloseBracketExpected: 'A closing bracket is expected.',
  EndOfFileExpected: 'Unexpected content after the end of the document.',
  InvalidCommentToken: 'Invalid comment.',
  UnexpectedEndOfComment: 'The comment is not closed.',
  UnexpectedEndOfString: 'The text value is not closed.',
  UnexpectedEndOfNumber: 'The number is incomplete.',
  InvalidUnicode: 'Invalid unicode escape.',
  InvalidEscapeCharacter: 'Invalid escape character.',
  InvalidCharacter: 'Invalid character.',
};

const MAX_REPORTED_PROBLEMS = 5;

/** Offsets at which each line starts, for offset to line/column conversion. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) starts.push(i + 1);
    else if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) i++;
      starts.push(i + 1);
    }
  }
  return starts;
}

export function positionAt(
  starts: readonly number[],
  offset: number,
): { line: number; column: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] as number) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - (starts[lo] as number) + 1 };
}

/** Parse JSONC (comments and trailing commas allowed). Never throws. */
export function parseDocument(text: string): JsoncDocument {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, {
    allowTrailingComma: true,
    allowEmptyContent: true,
    disallowComments: false,
  });
  if (errors.length === 0) return { root, problems: [] };
  const starts = lineStarts(text);
  const problems = errors.slice(0, MAX_REPORTED_PROBLEMS).map((e): SyntaxProblem => {
    const { line, column } = positionAt(starts, e.offset);
    return {
      message: PARSE_MESSAGES[printParseErrorCode(e.error)] ?? 'Syntax error.',
      line,
      column,
    };
  });
  return { root, problems };
}

/** Line number (1-based) of a node's start. */
export function lineOfNode(starts: readonly number[], node: Node): number {
  return positionAt(starts, node.offset).line;
}

export { lineStarts };

export function describeProblem(problem: SyntaxProblem): string {
  return `Line ${problem.line}, column ${problem.column}: ${problem.message}`;
}

/** Line ending used by a document, so edits keep it. */
export function detectEol(text: string): '\n' | '\r\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** Indentation style of a document, so inserted entries match what is already there. */
function detectIndent(text: string): { insertSpaces: boolean; tabSize: number } {
  const match = /^([ \t]+)\S/m.exec(text);
  const indent = match?.[1] ?? '';
  if (indent.startsWith('\t')) return { insertSpaces: false, tabSize: 2 };
  if (indent.length > 0) return { insertSpaces: true, tabSize: Math.min(indent.length, 8) };
  return { insertSpaces: true, tabSize: 2 };
}

function editOptions(text: string) {
  return { formattingOptions: { ...detectIndent(text), eol: detectEol(text) } };
}

function propertyName(property: Node): unknown {
  return property.children?.[0]?.value;
}

/** Top-level property nodes with this name, in file order. */
function topLevelProperties(text: string, key: string): { root: Node; matches: Node[] } | null {
  const { root } = parseDocument(text);
  if (root?.type !== 'object') return null;
  return { root, matches: (root.children ?? []).filter((p) => propertyName(p) === key) };
}

/** Offset of the comma that follows `from` (skipping blanks and comments), or -1. */
function commaAfter(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === ',') return i;
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') i++;
    else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) return -1;
      i = end + 2;
    } else return -1;
  }
  return -1;
}

/**
 * Delete [start, end) and, when that leaves a line holding only blanks, the whole line, so a
 * removed entry does not leave a gap behind.
 */
function deleteRange(text: string, start: number, end: number): string {
  let from = start;
  let to = end;
  let lineStart = from;
  while (lineStart > 0 && (text[lineStart - 1] === ' ' || text[lineStart - 1] === '\t'))
    lineStart--;
  let lineEnd = to;
  while (lineEnd < text.length && (text[lineEnd] === ' ' || text[lineEnd] === '\t')) lineEnd++;
  const atLineStart = lineStart === 0 || text[lineStart - 1] === '\n';
  const atLineEnd = lineEnd >= text.length || text[lineEnd] === '\n' || text[lineEnd] === '\r';
  if (atLineStart && atLineEnd) {
    from = lineStart;
    to = lineEnd;
    if (text[to] === '\r') to++;
    if (text[to] === '\n') to++;
  } else if (text[from - 1] === ' ' && text[to] === ' ') {
    to++;
  }
  return text.slice(0, from) + text.slice(to);
}

/**
 * Remove one property node. Commas are kept valid whether the entry is first, last, only, or
 * followed by a trailing comma, which the generic edit helper gets wrong.
 */
function removeProperty(text: string, root: Node, property: Node): string {
  const siblings = root.children ?? [];
  const index = siblings.indexOf(property);
  const end = property.offset + property.length;
  const own = commaAfter(text, end);
  const edits: [number, number][] = [];
  if (own !== -1) {
    edits.push([property.offset, own + 1]);
  } else {
    edits.push([property.offset, end]);
    const previous = siblings[index - 1];
    if (previous) {
      const comma = commaAfter(text, previous.offset + previous.length);
      if (comma !== -1) edits.push([comma, comma + 1]);
    }
  }
  // Apply from the end of the text backwards so earlier offsets stay valid.
  let result = text;
  for (const [from, to] of edits.sort((a, b) => b[0] - a[0]))
    result = deleteRange(result, from, to);
  return result;
}

/** Remove every top-level property with this name. Returns the text unchanged when absent. */
export function removeTopLevel(text: string, key: string): string {
  let current = text;
  for (let guard = 0; guard < 1000; guard++) {
    const found = topLevelProperties(current, key);
    const first = found?.matches[0];
    if (!found || !first) break;
    current = removeProperty(current, found.root, first);
  }
  return current;
}

/**
 * Set a top-level property, keeping comments and formatting elsewhere. A document with no object
 * yet (empty, or only comments) gets one after its comments. Duplicate entries for the same key
 * are collapsed first, keeping the last, which is the one that wins when the file is read.
 */
export function setTopLevel(text: string, key: string, value: unknown): string {
  let current = text;
  if (!parseDocument(current).root) {
    const eol = detectEol(current);
    const comments = current.trimEnd();
    current = `${comments === '' ? '' : comments + eol}{${eol}}${eol}`;
  }
  for (let guard = 0; guard < 1000; guard++) {
    const found = topLevelProperties(current, key);
    if (!found || found.matches.length < 2) break;
    current = removeProperty(current, found.root, found.matches[0] as Node);
  }
  return applyEdits(current, modify(current, [key], value, editOptions(current)));
}
