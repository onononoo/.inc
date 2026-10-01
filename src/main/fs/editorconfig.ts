import { parse, type Props } from 'editorconfig';
import type { EditorConfigProps } from '@shared/api/fs';
import type { EndOfLine, TextEncoding } from '@shared/encodings';

const CHARSETS: Record<string, TextEncoding> = {
  'utf-8': 'utf8',
  'utf-8-bom': 'utf8bom',
  'utf-16le': 'utf16le',
  'utf-16be': 'utf16be',
  latin1: 'iso88591',
};

const END_OF_LINE: Record<string, EndOfLine> = { lf: 'lf', crlf: 'crlf' };

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 1000
    ? value
    : undefined;
}

/** Translate raw EditorConfig properties into .inc's vocabulary. Unset and unknown values are dropped. */
export function mapEditorConfig(raw: Props): EditorConfigProps | null {
  const out: EditorConfigProps = {};
  if (raw.indent_style === 'space') out.indentStyle = 'space';
  else if (raw.indent_style === 'tab') out.indentStyle = 'tab';
  const indentSize = positiveInt(raw.indent_size);
  if (indentSize !== undefined) out.indentSize = indentSize;
  const tabWidth = positiveInt(raw.tab_width);
  if (tabWidth !== undefined) out.tabWidth = tabWidth;
  if (typeof raw.end_of_line === 'string' && raw.end_of_line in END_OF_LINE) {
    out.endOfLine = END_OF_LINE[raw.end_of_line];
  }
  if (typeof raw.charset === 'string' && raw.charset in CHARSETS)
    out.charset = CHARSETS[raw.charset];
  if (typeof raw.trim_trailing_whitespace === 'boolean') {
    out.trimTrailingWhitespace = raw.trim_trailing_whitespace;
  }
  if (typeof raw.insert_final_newline === 'boolean')
    out.insertFinalNewline = raw.insert_final_newline;
  const maxLine = positiveInt(raw.max_line_length);
  if (maxLine !== undefined) out.maxLineLength = maxLine;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Resolves EditorConfig properties for files. Results are cached per file and dropped whenever any
 * .editorconfig file changes. The library only reads .editorconfig files in the file's own ancestor
 * folders, never anything else.
 */
export class EditorConfigResolver {
  private cache = new Map<string, EditorConfigProps | null>();

  async resolve(file: string): Promise<EditorConfigProps | null> {
    if (this.cache.has(file)) return this.cache.get(file) ?? null;
    // An unreadable or malformed .editorconfig must never block opening a file.
    const result = await parse(file).then(mapEditorConfig, () => null);
    if (this.cache.size > 5000) this.cache.clear();
    this.cache.set(file, result);
    return result;
  }

  /** Call with each batch of changed paths; clears the cache when an .editorconfig was touched. */
  noteChanges(paths: readonly string[]): void {
    for (const p of paths) {
      if (/(^|[\\/])\.editorconfig$/.test(p)) {
        this.cache.clear();
        return;
      }
    }
  }

  clear(): void {
    this.cache.clear();
  }
}
