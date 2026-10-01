/**
 * Public entry point of the Monaco layer.
 *
 *   import { monaco, setupMonaco, createEditorOptions } from '../monaco';
 *
 * `setupMonaco()` is called once by the editor slice at startup. Pure helpers (language
 * detection, editor options) are also importable from `./languages` and `../editor/editor-options`
 * without loading Monaco, which is how the unit tests use them.
 */
export {
  applyMonacoTheme,
  createEditorOptions,
  createEditorUpdateOptions,
  currentAppTheme,
  EDITOR_SETTING_KEYS,
  knownLanguages,
  languageChoices,
  LARGE_FILE_OVERRIDES,
  monaco,
  readEditorSettings,
  setupMonaco,
  themeFromEvent,
  type EditorOptionOverrides,
  type EditorSettingKey,
  type EditorSettings,
  type LanguageChoice,
} from './setup';
export {
  detectFromFirstLine,
  detectLanguage,
  EXTRA_LANGUAGES,
  languageDisplayName,
  PLAIN_TEXT,
  workerFileFor,
  type KnownLanguage,
  type LanguageAssociation,
} from './languages';
export { incThemes, monacoThemeFor, type IncThemeName } from './themes';
