/**
 * Translates the `editor.*` settings into Monaco editor options.
 *
 * This module only imports Monaco *types*, so it runs in Node unit tests. It is re-exported from
 * `monaco/setup.ts` and `monaco/index.ts`, which is where the editor UI imports it from.
 *
 * Layout is never automatic: the editor UI drives `editor.layout()` from a ResizeObserver so that
 * hidden or collapsed panes never pay for layout work.
 */
import type { editor as MonacoEditor } from 'monaco-editor';
import type { SettingValues } from '@shared/settings';

export const EDITOR_SETTING_KEYS = [
  'editor.fontFamily',
  'editor.fontSize',
  'editor.lineHeight',
  'editor.fontLigatures',
  'editor.wordWrap',
  'editor.minimap',
  'editor.lineNumbers',
  'editor.renderWhitespace',
  'editor.rulers',
  'editor.cursorStyle',
  'editor.cursorBlinking',
  'editor.smoothScrolling',
  'editor.bracketPairColorization',
  'editor.indentGuides',
  'editor.stickyScroll',
  'editor.folding',
  'editor.scrollBeyondLastLine',
  'editor.formatOnPaste',
] as const satisfies readonly (keyof SettingValues)[];

export type EditorSettingKey = (typeof EDITOR_SETTING_KEYS)[number];

/** The subset of settings that decide how an editor looks and behaves. */
export type EditorSettings = Pick<SettingValues, EditorSettingKey>;

/** Read every editor setting through `get` (for example `getSetting` from the settings store). */
export function readEditorSettings(
  get: <K extends EditorSettingKey>(key: K) => SettingValues[K],
): EditorSettings {
  const out: Record<string, unknown> = {};
  for (const key of EDITOR_SETTING_KEYS) out[key] = get(key);
  return out as unknown as EditorSettings;
}

/** Options applied on top of the settings for one document, for example for very large files. */
export type EditorOptionOverrides = MonacoEditor.IEditorOptions & MonacoEditor.IGlobalEditorOptions;

/**
 * Features that scan or decorate the whole document are switched off for large files so typing,
 * scrolling and opening stay fast. Syntax highlighting is handled by the document (its language
 * falls back to plain text), because tokenization is a model concern in Monaco.
 */
const largeFileOverrides: EditorOptionOverrides = {
  minimap: { enabled: false },
  folding: false,
  bracketPairColorization: { enabled: false },
  guides: { indentation: false, bracketPairs: false, bracketPairsHorizontal: false },
  stickyScroll: { enabled: false },
  occurrencesHighlight: 'off',
  selectionHighlight: false,
  matchBrackets: 'never',
  wordBasedSuggestions: 'off',
  quickSuggestions: false,
  suggestOnTriggerCharacters: false,
  parameterHints: { enabled: false },
  hover: { enabled: 'off' },
  codeLens: false,
  colorDecorators: false,
  lightbulb: { enabled: 'off' as MonacoEditor.ShowLightbulbIconMode },
  renderWhitespace: 'none',
  wordWrap: 'off',
  smoothScrolling: false,
  renderLineHighlight: 'none',
  unicodeHighlight: {
    nonBasicASCII: false,
    ambiguousCharacters: false,
    invisibleCharacters: false,
  },
};

export const LARGE_FILE_OVERRIDES: Readonly<EditorOptionOverrides> =
  Object.freeze(largeFileOverrides);

function sanitizeRulers(rulers: readonly number[]): number[] {
  return rulers.filter((n) => Number.isInteger(n) && n > 0 && n <= 1000);
}

/**
 * Complete construction options for a Monaco code editor.
 *
 * `overrides` win over the settings; pass `LARGE_FILE_OVERRIDES` (or the document's own
 * overrides) for files above the large-file threshold.
 */
export function createEditorOptions(
  settings: EditorSettings,
  overrides: EditorOptionOverrides = {},
): MonacoEditor.IStandaloneEditorConstructionOptions {
  const guides = settings['editor.indentGuides'];
  const base: MonacoEditor.IStandaloneEditorConstructionOptions = {
    automaticLayout: false,
    accessibilitySupport: 'auto',
    fontFamily: settings['editor.fontFamily'],
    fontSize: settings['editor.fontSize'],
    lineHeight: settings['editor.lineHeight'],
    fontLigatures: settings['editor.fontLigatures'],
    wordWrap: settings['editor.wordWrap'],
    wordWrapColumn: 80,
    minimap: { enabled: settings['editor.minimap'] },
    lineNumbers: settings['editor.lineNumbers'],
    renderWhitespace: settings['editor.renderWhitespace'],
    rulers: sanitizeRulers(settings['editor.rulers']),
    cursorStyle: settings['editor.cursorStyle'],
    cursorBlinking: settings['editor.cursorBlinking'],
    cursorSmoothCaretAnimation: 'off',
    smoothScrolling: settings['editor.smoothScrolling'],
    bracketPairColorization: { enabled: settings['editor.bracketPairColorization'] },
    guides: {
      indentation: guides,
      bracketPairs: guides ? 'active' : false,
      highlightActiveIndentation: guides,
    },
    stickyScroll: { enabled: settings['editor.stickyScroll'] },
    folding: settings['editor.folding'],
    scrollBeyondLastLine: settings['editor.scrollBeyondLastLine'],
    formatOnPaste: settings['editor.formatOnPaste'],

    // Behaviour that is constant across the product.
    fixedOverflowWidgets: true,
    links: false,
    glyphMargin: false,
    lineNumbersMinChars: 4,
    renderLineHighlight: 'line',
    overviewRulerBorder: false,
    padding: { top: 8, bottom: 8 },
    scrollbar: { useShadows: false, verticalScrollbarSize: 12, horizontalScrollbarSize: 12 },
    multiCursorModifier: 'alt',
    mouseWheelZoom: false,
    dragAndDrop: true,
    renderValidationDecorations: 'on',
    ariaLabel: 'Editor',
  };
  return { ...base, ...overrides };
}

/** Option patch for a setting change, without constructor-only fields. */
export function createEditorUpdateOptions(
  settings: EditorSettings,
  overrides: EditorOptionOverrides = {},
): EditorOptionOverrides {
  const options: MonacoEditor.IStandaloneEditorConstructionOptions = createEditorOptions(
    settings,
    overrides,
  );
  const { ariaLabel: _ariaLabel, ...patch } = options;
  return patch;
}
