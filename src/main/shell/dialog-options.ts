/**
 * Sanitising dialog options that arrive over IPC before they reach the native dialog APIs.
 * Pure functions; the handlers in `dialogs.ts` add the Electron calls.
 */
import { IncError } from '@shared/errors';
import type { FileFilter, MessageBoxOptions } from '@shared/api/dialog';

const MAX_TITLE = 200;
const MAX_MESSAGE = 1_000;
const MAX_DETAIL = 4_000;
const MAX_BUTTONS = 8;
const MAX_BUTTON_LABEL = 64;
const MAX_FILTERS = 20;
const MAX_EXTENSIONS = 50;
const MAX_FILTER_NAME = 64;

/** Removes control characters (keeping line breaks when asked) and caps the length. */
export function cleanText(value: unknown, maxLength: number, keepNewlines = false): string {
  if (typeof value !== 'string') return '';
  const pattern = keepNewlines
    ? // eslint-disable-next-line no-control-regex
      /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/g
    : // eslint-disable-next-line no-control-regex
      /[\u0000-\u001f\u007f-\u009f]/g;
  const text = value.replace(pattern, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

export function cleanTitle(value: unknown): string | undefined {
  const text = cleanText(value, MAX_TITLE);
  return text.length > 0 ? text : undefined;
}

/** Keep letters, digits and a few safe punctuation marks; "*" alone means any file. */
function cleanExtension(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const stripped = value.trim().replace(/^\*?\./, '');
  if (stripped === '*') return '*';
  return /^[A-Za-z0-9_+-]{1,16}$/.test(stripped) ? stripped : null;
}

export interface NativeFilter {
  name: string;
  extensions: string[];
}

export function cleanFilters(value: unknown): NativeFilter[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new IncError('E_INVALID', 'filters must be a list.');
  const result: NativeFilter[] = [];
  for (const entry of value.slice(0, MAX_FILTERS) as Partial<FileFilter>[]) {
    if (typeof entry !== 'object' || entry === null || !Array.isArray(entry.extensions)) continue;
    const extensions = entry.extensions
      .slice(0, MAX_EXTENSIONS)
      .map(cleanExtension)
      .filter((e): e is string => e !== null);
    if (extensions.length === 0) continue;
    const name = cleanText(entry.name, MAX_FILTER_NAME) || extensions.join(', ');
    result.push({ name, extensions });
  }
  return result.length > 0 ? result : undefined;
}

export interface NativeMessageBox {
  type: 'none' | 'info' | 'warning' | 'error' | 'question';
  title?: string;
  message: string;
  detail?: string;
  buttons: string[];
  defaultId?: number;
  cancelId?: number;
  checkboxLabel?: string;
}

const MESSAGE_TYPES = ['none', 'info', 'warning', 'error', 'question'] as const;

function indexOrUndefined(value: unknown, count: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < count
    ? value
    : undefined;
}

export function cleanMessageBox(options: unknown): NativeMessageBox {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new IncError('E_INVALID', 'Dialog options must be an object.');
  }
  const o = options as Partial<MessageBoxOptions>;
  const message = cleanText(o.message, MAX_MESSAGE, true);
  if (message.length === 0) throw new IncError('E_INVALID', 'A dialog needs a message.');
  if (!Array.isArray(o.buttons) || o.buttons.length === 0) {
    throw new IncError('E_INVALID', 'A dialog needs at least one button.');
  }
  const buttons = o.buttons
    .slice(0, MAX_BUTTONS)
    .map((b) => cleanText(b, MAX_BUTTON_LABEL))
    .filter((b) => b.length > 0);
  if (buttons.length === 0) throw new IncError('E_INVALID', 'Dialog buttons need labels.');

  const type = (MESSAGE_TYPES as readonly unknown[]).includes(o.type) ? o.type! : 'none';
  const title = cleanTitle(o.title);
  const detail = cleanText(o.detail, MAX_DETAIL, true);
  const checkboxLabel = cleanText(o.checkboxLabel, MAX_BUTTON_LABEL);
  const defaultId = indexOrUndefined(o.defaultId, buttons.length);
  const cancelId = indexOrUndefined(o.cancelId, buttons.length);
  return {
    type,
    message,
    buttons,
    ...(title ? { title } : {}),
    ...(detail ? { detail } : {}),
    ...(checkboxLabel ? { checkboxLabel } : {}),
    ...(defaultId !== undefined ? { defaultId } : {}),
    ...(cancelId !== undefined ? { cancelId } : {}),
  };
}
