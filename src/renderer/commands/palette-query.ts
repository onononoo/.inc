/** Parsing of what is typed into the palette. Pure, so every rule is unit tested. */

export type PaletteMode = 'files' | 'commands' | 'line';

export interface RoutedInput {
  mode: PaletteMode;
  /** The text after the mode prefix. */
  text: string;
}

/** One input field serves three modes: ">" runs commands, ":" goes to a line, anything else finds a file. */
export function routePaletteInput(value: string): RoutedInput {
  if (value.startsWith('>')) return { mode: 'commands', text: value.slice(1).trim() };
  if (value.startsWith(':')) return { mode: 'line', text: value.slice(1) };
  return { mode: 'files', text: value };
}

export interface FileQuery {
  /** What to match against file paths: forward slashes, no leading "./". */
  query: string;
  /** 1-based position to open at, from a "path:line[:column]" suffix. */
  line?: number;
  column?: number;
}

const POSITION_SUFFIX = /^(.*?)(?::(\d+))?(?::(\d+))?$/;

function positiveInt(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const n = Number(text);
  return Number.isSafeInteger(n) && n >= 1 ? n : undefined;
}

/**
 * "src/app.ts:42:7" -> { query: "src/app.ts", line: 42, column: 7 }.
 * A drive letter ("C:\\src\\app.ts") is not mistaken for a position, and trailing colons typed on
 * the way to a position are ignored.
 */
export function parseFileQuery(input: string): FileQuery {
  const trimmed = input.trim().replace(/:+$/, '');
  const match = POSITION_SUFFIX.exec(trimmed);
  const path = match?.[1] ?? trimmed;
  const hasPosition = match?.[2] !== undefined;
  const line = positiveInt(match?.[2]);
  const column = line === undefined ? undefined : positiveInt(match?.[3]);
  const base = hasPosition ? path : trimmed;
  return {
    query: base.replace(/\\/g, '/').replace(/^(\.\/)+/, ''),
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
  };
}

/** True for "/usr/src/a.ts", "C:\\src\\a.ts" and "\\\\server\\share\\a.ts". */
export function isAbsolutePathText(text: string): boolean {
  return /^([a-zA-Z]:[\/]|\\|\/)/.test(text);
}

export type LineInput =
  | { kind: 'empty' }
  | { kind: 'ok'; line: number; column?: number }
  | { kind: 'invalid'; reason: 'format' | 'zero' };

/** The text after ":" in go to line mode: "42", "42:8" or "42,8". */
export function parseLineInput(text: string): LineInput {
  const trimmed = text.trim();
  if (trimmed === '') return { kind: 'empty' };
  const match = /^(\d+)(?:\s*[:,]\s*(\d+))?$/.exec(trimmed);
  if (!match) return { kind: 'invalid', reason: 'format' };
  const line = Number(match[1]);
  if (!Number.isSafeInteger(line)) return { kind: 'invalid', reason: 'format' };
  if (line < 1) return { kind: 'invalid', reason: 'zero' };
  const column = positiveInt(match[2]);
  return { kind: 'ok', line, ...(column !== undefined ? { column } : {}) };
}
