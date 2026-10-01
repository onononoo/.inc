/**
 * The complete, typed settings schema for .inc.
 *
 * Layering (lowest to highest precedence): defaults < user settings < workspace settings
 * (`<workspace>/.inc/settings.json`) < enterprise policy. Record-typed settings (`record<...>`)
 * are merged key-by-key across layers; everything else is replaced by the highest layer.
 *
 * Settings marked `restricted` are ignored when they come from a workspace that is not trusted,
 * because they can cause code execution or data exposure (shell paths, environment, git path).
 */
import type { TextEncoding } from './encodings';

export type ThemeSetting = 'system' | 'light' | 'dark' | 'hc-light' | 'hc-dark';

export interface SettingValues {
  // Appearance
  'appearance.theme': ThemeSetting;
  'appearance.zoomLevel': number;

  // Workbench
  'workbench.startupEditor': 'welcome' | 'none';
  'workbench.previewEditors': boolean;
  'workbench.restoreSession': boolean;

  // Editor
  'editor.fontFamily': string;
  'editor.fontSize': number;
  'editor.lineHeight': number;
  'editor.fontLigatures': boolean;
  'editor.tabSize': number;
  'editor.insertSpaces': boolean;
  'editor.detectIndentation': boolean;
  'editor.wordWrap': 'off' | 'on' | 'bounded';
  'editor.minimap': boolean;
  'editor.lineNumbers': 'on' | 'off' | 'relative';
  'editor.renderWhitespace': 'none' | 'boundary' | 'selection' | 'trailing' | 'all';
  'editor.rulers': number[];
  'editor.cursorStyle': 'line' | 'block' | 'underline';
  'editor.cursorBlinking': 'blink' | 'smooth' | 'phase' | 'expand' | 'solid';
  'editor.smoothScrolling': boolean;
  'editor.bracketPairColorization': boolean;
  'editor.indentGuides': boolean;
  'editor.stickyScroll': boolean;
  'editor.folding': boolean;
  'editor.scrollBeyondLastLine': boolean;
  'editor.formatOnSave': boolean;
  'editor.formatOnPaste': boolean;
  'editor.largeFileThresholdMB': number;
  'editor.maxFileSizeMB': number;

  // Files
  'files.autoSave': 'off' | 'afterDelay' | 'onFocusChange' | 'onWindowChange';
  'files.autoSaveDelay': number;
  'files.eol': 'auto' | 'lf' | 'crlf';
  'files.encoding': TextEncoding;
  'files.trimTrailingWhitespace': boolean;
  'files.insertFinalNewline': boolean;
  'files.useEditorConfig': boolean;
  'files.exclude': Record<string, boolean>;
  'files.watcherExclude': Record<string, boolean>;
  'files.confirmDelete': boolean;

  // Search
  'search.exclude': Record<string, boolean>;
  'search.useIgnoreFiles': boolean;
  'search.followSymlinks': boolean;
  'search.maxResults': number;

  // Terminal
  'terminal.shell': string;
  'terminal.shellArgs': string[];
  'terminal.fontFamily': string;
  'terminal.fontSize': number;
  'terminal.cursorStyle': 'block' | 'underline' | 'bar';
  'terminal.scrollback': number;
  'terminal.copyOnSelect': boolean;
  'terminal.env': Record<string, string>;

  // Git
  'git.enabled': boolean;
  'git.path': string;
  'git.autoRefresh': boolean;
  'git.autoFetch': boolean;
  'git.decorations': boolean;
  'git.gutterIndicators': boolean;

  // Security
  'security.workspaceTrust': boolean;
}

export type SettingKey = keyof SettingValues;

export type SettingType =
  | 'boolean'
  | 'number'
  | 'string'
  | 'enum'
  | 'string[]'
  | 'number[]'
  | 'record<boolean>'
  | 'record<string>';

export type SettingCategory =
  'Appearance' | 'Workbench' | 'Editor' | 'Files' | 'Search' | 'Terminal' | 'Git' | 'Security';

export const SETTING_CATEGORIES: readonly SettingCategory[] = [
  'Appearance',
  'Workbench',
  'Editor',
  'Files',
  'Search',
  'Terminal',
  'Git',
  'Security',
];

export interface SettingDef<T = unknown> {
  key: string;
  type: SettingType;
  default: T;
  category: SettingCategory;
  /** Short label for the settings editor, sentence case. */
  title: string;
  /** One or two plain sentences. */
  description: string;
  enum?: readonly string[];
  enumLabels?: readonly string[];
  minimum?: number;
  maximum?: number;
  /** "workspace" means `<workspace>/.inc/settings.json` may override the user value. */
  scope: 'user' | 'workspace';
  /** Ignored from workspace settings until the workspace is trusted. */
  restricted?: boolean;
  /** Extra search keywords for the settings editor. */
  tags?: readonly string[];
}

type Schema = { [K in SettingKey]: SettingDef<SettingValues[K]> };

const MONO_STACK =
  '"Cascadia Code", "SF Mono", Consolas, Menlo, "DejaVu Sans Mono", "Liberation Mono", monospace';

export const SETTINGS: Schema = {
  'appearance.theme': {
    key: 'appearance.theme',
    type: 'enum',
    default: 'system',
    enum: ['system', 'light', 'dark', 'hc-light', 'hc-dark'],
    enumLabels: ['Match system', 'Light', 'Dark', 'High contrast light', 'High contrast dark'],
    category: 'Appearance',
    title: 'Color theme',
    description: 'The color theme for the window and editor.',
    scope: 'user',
    tags: ['dark', 'light', 'contrast'],
  },
  'appearance.zoomLevel': {
    key: 'appearance.zoomLevel',
    type: 'number',
    default: 0,
    minimum: -3,
    maximum: 5,
    category: 'Appearance',
    title: 'Zoom level',
    description: 'Zoom for the whole window. 0 is 100%; each step is about 20%.',
    scope: 'user',
  },

  'workbench.startupEditor': {
    key: 'workbench.startupEditor',
    type: 'enum',
    default: 'welcome',
    enum: ['welcome', 'none'],
    enumLabels: ['Welcome page', 'Nothing'],
    category: 'Workbench',
    title: 'Startup editor',
    description: 'What to show when the window opens with no files.',
    scope: 'user',
  },
  'workbench.previewEditors': {
    key: 'workbench.previewEditors',
    type: 'boolean',
    default: true,
    category: 'Workbench',
    title: 'Preview tabs',
    description: 'Open files from the explorer or search in a reusable preview tab until edited.',
    scope: 'user',
  },
  'workbench.restoreSession': {
    key: 'workbench.restoreSession',
    type: 'boolean',
    default: true,
    category: 'Workbench',
    title: 'Restore previous session',
    description: 'Reopen the last folder and its open files when starting.',
    scope: 'user',
  },

  'editor.fontFamily': {
    key: 'editor.fontFamily',
    type: 'string',
    default: MONO_STACK,
    category: 'Editor',
    title: 'Font family',
    description: 'Font family for the editor, as a CSS font-family list.',
    scope: 'user',
    tags: ['typeface'],
  },
  'editor.fontSize': {
    key: 'editor.fontSize',
    type: 'number',
    default: 13,
    minimum: 8,
    maximum: 32,
    category: 'Editor',
    title: 'Font size',
    description: 'Editor font size in pixels.',
    scope: 'user',
  },
  'editor.lineHeight': {
    key: 'editor.lineHeight',
    type: 'number',
    default: 0,
    minimum: 0,
    maximum: 60,
    category: 'Editor',
    title: 'Line height',
    description: 'Line height in pixels. 0 chooses a height from the font size.',
    scope: 'user',
  },
  'editor.fontLigatures': {
    key: 'editor.fontLigatures',
    type: 'boolean',
    default: false,
    category: 'Editor',
    title: 'Font ligatures',
    description: 'Render ligatures for fonts that provide them.',
    scope: 'user',
  },
  'editor.tabSize': {
    key: 'editor.tabSize',
    type: 'number',
    default: 2,
    minimum: 1,
    maximum: 16,
    category: 'Editor',
    title: 'Tab size',
    description: 'Number of spaces a tab is equal to.',
    scope: 'workspace',
    tags: ['indent', 'indentation'],
  },
  'editor.insertSpaces': {
    key: 'editor.insertSpaces',
    type: 'boolean',
    default: true,
    category: 'Editor',
    title: 'Insert spaces',
    description: 'Insert spaces when pressing Tab.',
    scope: 'workspace',
    tags: ['indent', 'indentation'],
  },
  'editor.detectIndentation': {
    key: 'editor.detectIndentation',
    type: 'boolean',
    default: true,
    category: 'Editor',
    title: 'Detect indentation',
    description: 'Detect tab size and spaces or tabs from the file contents when it is opened.',
    scope: 'workspace',
    tags: ['indent', 'indentation'],
  },
  'editor.wordWrap': {
    key: 'editor.wordWrap',
    type: 'enum',
    default: 'off',
    enum: ['off', 'on', 'bounded'],
    enumLabels: ['Off', 'On', 'At viewport width or 80 columns'],
    category: 'Editor',
    title: 'Word wrap',
    description: 'Wrap long lines.',
    scope: 'workspace',
  },
  'editor.minimap': {
    key: 'editor.minimap',
    type: 'boolean',
    default: true,
    category: 'Editor',
    title: 'Minimap',
    description: 'Show a miniature overview of the file at the right edge.',
    scope: 'user',
  },
  'editor.lineNumbers': {
    key: 'editor.lineNumbers',
    type: 'enum',
    default: 'on',
    enum: ['on', 'off', 'relative'],
    enumLabels: ['On', 'Off', 'Relative'],
    category: 'Editor',
    title: 'Line numbers',
    description: 'Control how line numbers are shown.',
    scope: 'user',
  },
  'editor.renderWhitespace': {
    key: 'editor.renderWhitespace',
    type: 'enum',
    default: 'selection',
    enum: ['none', 'boundary', 'selection', 'trailing', 'all'],
    enumLabels: ['None', 'Boundary', 'Selection', 'Trailing', 'All'],
    category: 'Editor',
    title: 'Render whitespace',
    description: 'Control how whitespace characters are shown.',
    scope: 'user',
  },
  'editor.rulers': {
    key: 'editor.rulers',
    type: 'number[]',
    default: [],
    category: 'Editor',
    title: 'Rulers',
    description: 'Columns at which to show vertical rulers, for example [80, 100].',
    scope: 'workspace',
  },
  'editor.cursorStyle': {
    key: 'editor.cursorStyle',
    type: 'enum',
    default: 'line',
    enum: ['line', 'block', 'underline'],
    enumLabels: ['Line', 'Block', 'Underline'],
    category: 'Editor',
    title: 'Cursor style',
    description: 'The shape of the text cursor.',
    scope: 'user',
  },
  'editor.cursorBlinking': {
    key: 'editor.cursorBlinking',
    type: 'enum',
    default: 'solid',
    enum: ['blink', 'smooth', 'phase', 'expand', 'solid'],
    enumLabels: ['Blink', 'Smooth', 'Phase', 'Expand', 'Solid'],
    category: 'Editor',
    title: 'Cursor blinking',
    description: 'The animation used for the text cursor.',
    scope: 'user',
  },
  'editor.smoothScrolling': {
    key: 'editor.smoothScrolling',
    type: 'boolean',
    default: false,
    category: 'Editor',
    title: 'Smooth scrolling',
    description: 'Animate scrolling.',
    scope: 'user',
  },
  'editor.bracketPairColorization': {
    key: 'editor.bracketPairColorization',
    type: 'boolean',
    default: true,
    category: 'Editor',
    title: 'Bracket pair colorization',
    description: 'Color matching bracket pairs by nesting level.',
    scope: 'user',
  },
  'editor.indentGuides': {
    key: 'editor.indentGuides',
    type: 'boolean',
    default: true,
    category: 'Editor',
    title: 'Indent guides',
    description: 'Show vertical guides at each indentation level.',
    scope: 'user',
  },
  'editor.stickyScroll': {
    key: 'editor.stickyScroll',
    type: 'boolean',
    default: true,
    category: 'Editor',
    title: 'Sticky scroll',
    description: 'Keep the enclosing scopes visible at the top while scrolling.',
    scope: 'user',
  },
  'editor.folding': {
    key: 'editor.folding',
    type: 'boolean',
    default: true,
    category: 'Editor',
    title: 'Code folding',
    description: 'Allow collapsing blocks of code.',
    scope: 'user',
  },
  'editor.scrollBeyondLastLine': {
    key: 'editor.scrollBeyondLastLine',
    type: 'boolean',
    default: false,
    category: 'Editor',
    title: 'Scroll beyond last line',
    description: 'Allow scrolling past the end of the file.',
    scope: 'user',
  },
  'editor.formatOnSave': {
    key: 'editor.formatOnSave',
    type: 'boolean',
    default: false,
    category: 'Editor',
    title: 'Format on save',
    description: 'Format the file when saving, using the language formatter when one is available.',
    scope: 'workspace',
  },
  'editor.formatOnPaste': {
    key: 'editor.formatOnPaste',
    type: 'boolean',
    default: false,
    category: 'Editor',
    title: 'Format on paste',
    description: 'Format pasted content, using the language formatter when one is available.',
    scope: 'workspace',
  },
  'editor.largeFileThresholdMB': {
    key: 'editor.largeFileThresholdMB',
    type: 'number',
    default: 2,
    minimum: 1,
    maximum: 200,
    category: 'Editor',
    title: 'Large file threshold (MB)',
    description:
      'Files larger than this open with the minimap, folding, bracket colorization and syntax highlighting turned off to keep the editor responsive.',
    scope: 'user',
    tags: ['performance'],
  },
  'editor.maxFileSizeMB': {
    key: 'editor.maxFileSizeMB',
    type: 'number',
    default: 100,
    minimum: 1,
    maximum: 1024,
    category: 'Editor',
    title: 'Maximum file size (MB)',
    description: 'Files larger than this are not loaded into the editor.',
    scope: 'user',
    tags: ['performance'],
  },

  'files.autoSave': {
    key: 'files.autoSave',
    type: 'enum',
    default: 'off',
    enum: ['off', 'afterDelay', 'onFocusChange', 'onWindowChange'],
    enumLabels: [
      'Off',
      'After a delay',
      'When the editor loses focus',
      'When the window loses focus',
    ],
    category: 'Files',
    title: 'Auto save',
    description: 'Save modified files automatically.',
    scope: 'user',
  },
  'files.autoSaveDelay': {
    key: 'files.autoSaveDelay',
    type: 'number',
    default: 1000,
    minimum: 100,
    maximum: 60000,
    category: 'Files',
    title: 'Auto save delay (ms)',
    description: 'Delay before saving when auto save is set to "After a delay".',
    scope: 'user',
  },
  'files.eol': {
    key: 'files.eol',
    type: 'enum',
    default: 'auto',
    enum: ['auto', 'lf', 'crlf'],
    enumLabels: ['Keep each file as it is', 'LF', 'CRLF'],
    category: 'Files',
    title: 'End of line',
    description: 'Line ending for new files. Existing files keep their own line endings.',
    scope: 'workspace',
    tags: ['newline', 'line ending'],
  },
  'files.encoding': {
    key: 'files.encoding',
    type: 'enum',
    default: 'utf8',
    enum: [
      'utf8',
      'utf8bom',
      'utf16le',
      'utf16be',
      'windows1252',
      'iso88591',
      'windows1251',
      'koi8r',
      'shiftjis',
      'eucjp',
      'gbk',
      'big5',
      'euckr',
    ],
    category: 'Files',
    title: 'Default encoding',
    description: 'Encoding for new files. Existing files keep the encoding they were read with.',
    scope: 'workspace',
    tags: ['charset'],
  },
  'files.trimTrailingWhitespace': {
    key: 'files.trimTrailingWhitespace',
    type: 'boolean',
    default: false,
    category: 'Files',
    title: 'Trim trailing whitespace',
    description: 'Remove trailing whitespace when saving.',
    scope: 'workspace',
  },
  'files.insertFinalNewline': {
    key: 'files.insertFinalNewline',
    type: 'boolean',
    default: false,
    category: 'Files',
    title: 'Insert final newline',
    description: 'End files with a newline when saving.',
    scope: 'workspace',
  },
  'files.useEditorConfig': {
    key: 'files.useEditorConfig',
    type: 'boolean',
    default: true,
    category: 'Files',
    title: 'Use EditorConfig',
    description:
      'Apply indentation, line endings, encoding and whitespace rules from .editorconfig files. EditorConfig takes precedence over the settings above.',
    scope: 'workspace',
    tags: ['editorconfig', 'style'],
  },
  'files.exclude': {
    key: 'files.exclude',
    type: 'record<boolean>',
    default: {
      '**/.git': true,
      '**/.hg': true,
      '**/.svn': true,
      '**/.DS_Store': true,
      '**/Thumbs.db': true,
    },
    category: 'Files',
    title: 'Hide from explorer',
    description: 'Glob patterns for files and folders to hide in the explorer and quick open.',
    scope: 'workspace',
  },
  'files.watcherExclude': {
    key: 'files.watcherExclude',
    type: 'record<boolean>',
    default: {
      '**/.git/objects/**': true,
      '**/.git/subtree-cache/**': true,
      '**/node_modules/**': true,
      '**/.hg/store/**': true,
    },
    category: 'Files',
    title: 'File watcher exclusions',
    description:
      'Glob patterns to leave out of file watching. Excluding large folders keeps startup and memory low in very large repositories.',
    scope: 'workspace',
    tags: ['performance', 'monorepo'],
  },
  'files.confirmDelete': {
    key: 'files.confirmDelete',
    type: 'boolean',
    default: true,
    category: 'Files',
    title: 'Confirm before deleting',
    description: 'Ask for confirmation before moving files to the trash.',
    scope: 'user',
  },

  'search.exclude': {
    key: 'search.exclude',
    type: 'record<boolean>',
    default: {
      '**/node_modules': true,
      '**/bower_components': true,
      '**/.git': true,
    },
    category: 'Search',
    title: 'Exclude from search',
    description: 'Glob patterns for files and folders to skip when searching.',
    scope: 'workspace',
  },
  'search.useIgnoreFiles': {
    key: 'search.useIgnoreFiles',
    type: 'boolean',
    default: true,
    category: 'Search',
    title: 'Use ignore files',
    description: 'Skip files matched by .gitignore and .ignore files.',
    scope: 'workspace',
  },
  'search.followSymlinks': {
    key: 'search.followSymlinks',
    type: 'boolean',
    default: false,
    category: 'Search',
    title: 'Follow symbolic links',
    description: 'Follow symbolic links while searching.',
    scope: 'workspace',
    restricted: true,
  },
  'search.maxResults': {
    key: 'search.maxResults',
    type: 'number',
    default: 20000,
    minimum: 100,
    maximum: 1000000,
    category: 'Search',
    title: 'Maximum results',
    description: 'Stop searching after this many matches.',
    scope: 'user',
    tags: ['performance'],
  },

  'terminal.shell': {
    key: 'terminal.shell',
    type: 'string',
    default: '',
    category: 'Terminal',
    title: 'Shell',
    description: 'Path to the shell executable. Empty uses the system default.',
    scope: 'user',
    restricted: true,
  },
  'terminal.shellArgs': {
    key: 'terminal.shellArgs',
    type: 'string[]',
    default: [],
    category: 'Terminal',
    title: 'Shell arguments',
    description: 'Arguments passed to the shell.',
    scope: 'user',
    restricted: true,
  },
  'terminal.fontFamily': {
    key: 'terminal.fontFamily',
    type: 'string',
    default: '',
    category: 'Terminal',
    title: 'Font family',
    description: 'Terminal font family. Empty uses the editor font.',
    scope: 'user',
  },
  'terminal.fontSize': {
    key: 'terminal.fontSize',
    type: 'number',
    default: 0,
    minimum: 0,
    maximum: 32,
    category: 'Terminal',
    title: 'Font size',
    description: 'Terminal font size in pixels. 0 uses the editor font size.',
    scope: 'user',
  },
  'terminal.cursorStyle': {
    key: 'terminal.cursorStyle',
    type: 'enum',
    default: 'block',
    enum: ['block', 'underline', 'bar'],
    enumLabels: ['Block', 'Underline', 'Bar'],
    category: 'Terminal',
    title: 'Cursor style',
    description: 'The shape of the terminal cursor.',
    scope: 'user',
  },
  'terminal.scrollback': {
    key: 'terminal.scrollback',
    type: 'number',
    default: 5000,
    minimum: 100,
    maximum: 100000,
    category: 'Terminal',
    title: 'Scrollback lines',
    description: 'Number of lines kept in each terminal.',
    scope: 'user',
    tags: ['performance'],
  },
  'terminal.copyOnSelect': {
    key: 'terminal.copyOnSelect',
    type: 'boolean',
    default: false,
    category: 'Terminal',
    title: 'Copy on select',
    description: 'Copy the selection to the clipboard as soon as it is made.',
    scope: 'user',
  },
  'terminal.env': {
    key: 'terminal.env',
    type: 'record<string>',
    default: {},
    category: 'Terminal',
    title: 'Environment variables',
    description: 'Extra environment variables for new terminals.',
    scope: 'user',
    restricted: true,
  },

  'git.enabled': {
    key: 'git.enabled',
    type: 'boolean',
    default: true,
    category: 'Git',
    title: 'Enable Git',
    description: 'Turn Git integration on or off.',
    scope: 'workspace',
  },
  'git.path': {
    key: 'git.path',
    type: 'string',
    default: '',
    category: 'Git',
    title: 'Git executable path',
    description: 'Path to the Git executable. Empty finds Git on the system PATH.',
    scope: 'user',
    restricted: true,
  },
  'git.autoRefresh': {
    key: 'git.autoRefresh',
    type: 'boolean',
    default: true,
    category: 'Git',
    title: 'Refresh automatically',
    description: 'Refresh Git status when files change. Turn off for very large repositories.',
    scope: 'workspace',
    tags: ['performance', 'monorepo'],
  },
  'git.autoFetch': {
    key: 'git.autoFetch',
    type: 'boolean',
    default: false,
    category: 'Git',
    title: 'Fetch automatically',
    description: 'Periodically fetch from the remote. This makes network requests.',
    scope: 'user',
  },
  'git.decorations': {
    key: 'git.decorations',
    type: 'boolean',
    default: true,
    category: 'Git',
    title: 'File decorations',
    description: 'Color and badge files in the explorer by Git status.',
    scope: 'user',
  },
  'git.gutterIndicators': {
    key: 'git.gutterIndicators',
    type: 'boolean',
    default: true,
    category: 'Git',
    title: 'Gutter indicators',
    description: 'Show added, modified and removed lines in the editor gutter.',
    scope: 'user',
  },

  'security.workspaceTrust': {
    key: 'security.workspaceTrust',
    type: 'boolean',
    default: true,
    category: 'Security',
    title: 'Workspace trust',
    description:
      'Open folders in Restricted Mode until you trust them. Restricted Mode blocks the terminal, tasks and settings that can run code.',
    scope: 'user',
    tags: ['trust', 'restricted mode'],
  },
};

export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

export function isSettingKey(key: string): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS, key);
}

export function cloneValue<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

export function defaultSettings(): SettingValues {
  const out: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) out[key] = cloneValue(SETTINGS[key].default);
  return out as unknown as SettingValues;
}

export type ValidationResult<T = unknown> = { ok: true; value: T } | { ok: false; reason: string };

/** Validate (and lightly normalise) an untrusted value against a setting's definition. */
export function validateSetting(key: string, value: unknown): ValidationResult {
  if (!isSettingKey(key)) return { ok: false, reason: `Unknown setting "${key}".` };
  const def = SETTINGS[key] as SettingDef<unknown>;
  const bad = (reason: string): ValidationResult => ({ ok: false, reason });

  switch (def.type) {
    case 'boolean':
      return typeof value === 'boolean' ? { ok: true, value } : bad('Expected true or false.');
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return bad('Expected a number.');
      if (def.minimum !== undefined && value < def.minimum)
        return bad(`Must be at least ${def.minimum}.`);
      if (def.maximum !== undefined && value > def.maximum)
        return bad(`Must be at most ${def.maximum}.`);
      return { ok: true, value };
    }
    case 'string':
      return typeof value === 'string' ? { ok: true, value } : bad('Expected text.');
    case 'enum':
      return typeof value === 'string' && def.enum?.includes(value)
        ? { ok: true, value }
        : bad(`Expected one of: ${def.enum?.join(', ')}.`);
    case 'string[]':
      return Array.isArray(value) && value.every((v) => typeof v === 'string')
        ? { ok: true, value }
        : bad('Expected a list of text values.');
    case 'number[]':
      return Array.isArray(value) && value.every((v) => typeof v === 'number' && Number.isFinite(v))
        ? { ok: true, value }
        : bad('Expected a list of numbers.');
    case 'record<boolean>':
      return isRecord(value) && Object.values(value).every((v) => typeof v === 'boolean')
        ? { ok: true, value }
        : bad('Expected an object whose values are true or false.');
    case 'record<string>':
      return isRecord(value) && Object.values(value).every((v) => typeof v === 'string')
        ? { ok: true, value }
        : bad('Expected an object whose values are text.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True for setting types that merge key-by-key across layers. */
export function isMergedType(type: SettingType): boolean {
  return type === 'record<boolean>' || type === 'record<string>';
}
