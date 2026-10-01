/** Argument validation for terminal calls. Every value from the renderer is checked here. */
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { IncError, toIncError } from '@shared/errors';

export const MIN_COLS = 2;
export const MAX_COLS = 1000;
export const MIN_ROWS = 1;
export const MAX_ROWS = 500;
export const MAX_NAME_LENGTH = 128;
export const MAX_COMMAND_LENGTH = 8192;
/** The largest single write; bigger pastes are split by the renderer. */
export const MAX_WRITE_LENGTH = 1_048_576;

export interface TerminalSize {
  cols: number;
  rows: number;
}

/** Strict check for `terminal:create`: out-of-range sizes are rejected. */
export function validateSize(cols: unknown, rows: unknown): TerminalSize {
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) {
    throw new IncError('E_INVALID', 'The terminal size must be whole numbers of columns and rows.');
  }
  const c = cols as number;
  const r = rows as number;
  if (c < MIN_COLS || c > MAX_COLS || r < MIN_ROWS || r > MAX_ROWS) {
    throw new IncError(
      'E_INVALID',
      `The terminal size must be ${MIN_COLS} to ${MAX_COLS} columns and ${MIN_ROWS} to ${MAX_ROWS} rows.`,
    );
  }
  return { cols: c, rows: r };
}

/** Lenient check for `terminal:resize`: the window can be dragged to any size, so values are clamped. */
export function clampSize(cols: unknown, rows: unknown): TerminalSize {
  if (
    typeof cols !== 'number' ||
    typeof rows !== 'number' ||
    !Number.isFinite(cols) ||
    !Number.isFinite(rows)
  ) {
    throw new IncError('E_INVALID', 'The terminal size must be numbers.');
  }
  const clamp = (value: number, min: number, max: number) =>
    Math.min(max, Math.max(min, Math.round(value)));
  return { cols: clamp(cols, MIN_COLS, MAX_COLS), rows: clamp(rows, MIN_ROWS, MAX_ROWS) };
}

export function validateTerminalId(id: unknown): number {
  if (!Number.isInteger(id) || (id as number) < 1) {
    throw new IncError('E_INVALID', 'The terminal id must be a positive whole number.');
  }
  return id as number;
}

export function validateWriteData(data: unknown): string {
  if (typeof data !== 'string') throw new IncError('E_INVALID', 'Terminal input must be text.');
  if (data.length > MAX_WRITE_LENGTH) {
    throw new IncError('E_INVALID', 'That input is too large to send to the terminal at once.');
  }
  return data;
}

export function validateAckCount(count: unknown): number {
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) {
    throw new IncError('E_INVALID', 'The acknowledged character count must be zero or more.');
  }
  return Math.floor(count);
}

export function validateName(name: unknown): string | undefined {
  if (name === undefined) return undefined;
  if (typeof name !== 'string') throw new IncError('E_INVALID', 'The terminal name must be text.');
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  if (cleaned.length > MAX_NAME_LENGTH) {
    throw new IncError(
      'E_INVALID',
      `The terminal name can be at most ${MAX_NAME_LENGTH} characters.`,
    );
  }
  return cleaned.length > 0 ? cleaned : undefined;
}

export function validateInitialCommand(command: unknown): string | undefined {
  if (command === undefined) return undefined;
  if (typeof command !== 'string') {
    throw new IncError('E_INVALID', 'The initial command must be text.');
  }
  if (command.length > MAX_COMMAND_LENGTH || command.includes('\0')) {
    throw new IncError(
      'E_INVALID',
      'The initial command is too long or contains invalid characters.',
    );
  }
  // Enter is appended when the command is written, so trailing line breaks are dropped.
  return command.replace(/[\r\n]+$/, '');
}

/**
 * Resolve the working directory for a new terminal: it must be absolute (or default to
 * `fallback`), exist and be a directory.
 */
export async function resolveCwd(requested: unknown, fallback: string): Promise<string> {
  let cwd: string;
  if (requested === undefined || requested === '') {
    cwd = fallback;
  } else if (typeof requested !== 'string' || requested.includes('\0')) {
    throw new IncError('E_INVALID', 'The working folder must be a path.');
  } else {
    cwd = requested;
  }
  if (!path.isAbsolute(cwd)) {
    throw new IncError('E_INVALID', `The working folder must be an absolute path: ${cwd}`);
  }
  try {
    const info = await stat(cwd);
    if (!info.isDirectory()) {
      throw new IncError('E_NOT_DIRECTORY', `The working folder is not a folder: ${cwd}`);
    }
  } catch (e) {
    if (e instanceof IncError) throw e;
    const err = toIncError(e);
    if (err.code === 'E_NOT_FOUND') {
      throw new IncError('E_NOT_FOUND', `The working folder does not exist: ${cwd}`);
    }
    throw err;
  }
  return path.normalize(cwd);
}
