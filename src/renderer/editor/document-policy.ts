/**
 * How a document is configured when it opens and what is applied when it is saved: indentation,
 * line endings, encoding, whitespace rules and the large-file switches. Pure functions over the
 * settings and the resolved EditorConfig properties, so the rules are unit tested in Node.
 *
 * Precedence, highest first: an explicit choice made in this session (status bar pickers),
 * EditorConfig (when `files.useEditorConfig`), the settings, the platform default.
 */
import type { EditorConfigProps } from '@shared/api/fs';
import type { EndOfLine, TextEncoding } from '@shared/encodings';
import type { Platform } from '@shared/paths';
import type { SettingValues } from '@shared/settings';
import { LARGE_FILE_OVERRIDES, type EditorOptionOverrides } from './editor-options';

export const DOCUMENT_SETTING_KEYS = [
  'editor.tabSize',
  'editor.insertSpaces',
  'editor.detectIndentation',
  'editor.formatOnSave',
  'editor.largeFileThresholdMB',
  'editor.maxFileSizeMB',
  'files.autoSave',
  'files.autoSaveDelay',
  'files.eol',
  'files.encoding',
  'files.trimTrailingWhitespace',
  'files.insertFinalNewline',
  'files.useEditorConfig',
] as const satisfies readonly (keyof SettingValues)[];

export type DocumentSettingKey = (typeof DOCUMENT_SETTING_KEYS)[number];
export type DocumentSettings = Pick<SettingValues, DocumentSettingKey>;

export function readDocumentSettings(
  get: <K extends DocumentSettingKey>(key: K) => SettingValues[K],
): DocumentSettings {
  const out: Record<string, unknown> = {};
  for (const key of DOCUMENT_SETTING_KEYS) out[key] = get(key);
  return out as unknown as DocumentSettings;
}

export interface DocumentPolicy {
  indent: {
    insertSpaces: boolean;
    tabSize: number;
    /** True when the file contents should be inspected to choose the indentation. */
    detect: boolean;
    /** True when EditorConfig decided the indentation. */
    fromEditorConfig: boolean;
  };
  /** Line ending EditorConfig asks for, if any. */
  eol: EndOfLine | null;
  /** Encoding for new files. */
  newFileEncoding: TextEncoding;
  /** Line ending for new files. */
  newFileEol: EndOfLine;
  trimTrailingWhitespace: boolean;
  insertFinalNewline: boolean;
  /** Column for a vertical ruler from EditorConfig `max_line_length`. */
  maxLineLength: number | null;
}

export function platformEol(platform: Platform): EndOfLine {
  return platform === 'win32' ? 'crlf' : 'lf';
}

function validSize(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value >= 1 && value <= 16 ? value : undefined;
}

export function resolveDocumentPolicy(
  settings: DocumentSettings,
  editorConfig: EditorConfigProps | null,
  platform: Platform,
): DocumentPolicy {
  const config = settings['files.useEditorConfig'] ? editorConfig : null;

  let insertSpaces = settings['editor.insertSpaces'];
  let tabSize = settings['editor.tabSize'];
  let fromEditorConfig = false;
  if (config) {
    const size = validSize(config.indentSize) ?? validSize(config.tabWidth);
    if (config.indentStyle) {
      insertSpaces = config.indentStyle === 'space';
      fromEditorConfig = true;
      if (config.indentStyle === 'tab') tabSize = validSize(config.tabWidth) ?? size ?? tabSize;
      else tabSize = size ?? tabSize;
    } else if (size !== undefined) {
      tabSize = size;
      fromEditorConfig = true;
    }
  }

  const configuredEol = config?.endOfLine ?? null;
  const newFileEol =
    configuredEol ?? (settings['files.eol'] === 'auto' ? platformEol(platform) : settings['files.eol']);

  return {
    indent: {
      insertSpaces,
      tabSize,
      detect: !fromEditorConfig && settings['editor.detectIndentation'],
      fromEditorConfig,
    },
    eol: configuredEol,
    newFileEncoding: config?.charset ?? settings['files.encoding'],
    newFileEol,
    trimTrailingWhitespace: config?.trimTrailingWhitespace ?? settings['files.trimTrailingWhitespace'],
    insertFinalNewline: config?.insertFinalNewline ?? settings['files.insertFinalNewline'],
    maxLineLength:
      config?.maxLineLength !== undefined && Number.isInteger(config.maxLineLength) && config.maxLineLength > 0
        ? config.maxLineLength
        : null,
  };
}

const MB = 1024 * 1024;

/** True when a file of `sizeBytes` should open with the expensive editor features turned off. */
export function isLargeFile(sizeBytes: number, thresholdMB: number): boolean {
  return sizeBytes > thresholdMB * MB;
}

/** True when a file of `sizeBytes` is above the maximum that is loaded into the editor at all. */
export function exceedsMaxFileSize(sizeBytes: number, maxMB: number): boolean {
  return sizeBytes > maxMB * MB;
}

/** Editor option overrides for one document. */
export function documentEditorOverrides(input: {
  large: boolean;
  maxLineLength: number | null;
  baseRulers: readonly number[];
  readOnly: boolean;
}): EditorOptionOverrides {
  const overrides: EditorOptionOverrides = input.large ? { ...LARGE_FILE_OVERRIDES } : {};
  if (input.maxLineLength !== null && input.baseRulers.length === 0) {
    overrides.rulers = [input.maxLineLength];
  }
  if (input.readOnly) overrides.readOnly = true;
  return overrides;
}

/** Human-readable size, for the large-file notice: "2.4 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}
