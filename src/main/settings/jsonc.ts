/**
 * JSONC helpers shared by settings, policy and keybindings: tolerant parsing with readable
 * error messages, and targeted text edits that keep the user's comments and formatting.
 */
import {
  applyEdits,
  findNodeAtLocation,
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

export function positionAt(starts: readonly number[], offset: number): { line: number; column: number } {
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

function editOptions(text: string) {
  return {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: detectEol(text) },
  };
}

/** Number of top-level properties with this name. */
function countTopLevel(text: string, key: string): number {
  const { root } = parseDocument(text);
  if (root?.type !== 'object') return 0;
  return (root.children ?? []).filter((p) => p.children?.[0]?.value === key).length;
}

/**
 * Set a top-level property, keeping comments and formatting elsewhere. Duplicate entries for the
 * same key are collapsed first so the value that wins in the file is the one written.
 */
export function setTopLevel(text: string, key: string, value: unknown): string {
  let current = text;
  while (countTopLevel(current, key) > 1) {
    current = applyEdits(current, modify(current, [key], undefined, editOptions(current)));
  }
  return applyEdits(current, modify(current, [key], value, editOptions(current)));
}

/** Remove every top-level property with this name. Returns the text unchanged when absent. */
export function removeTopLevel(text: string, key: string): string {
  let current = text;
  for (let guard = 0; guard < 100; guard++) {
    const { root } = parseDocument(current);
    if (root?.type !== 'object' || !findNodeAtLocation(root, [key])) break;
    current = applyEdits(current, modify(current, [key], undefined, editOptions(current)));
  }
  return current;
}
