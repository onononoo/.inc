/**
 * One-time Monaco configuration. Importing this module loads Monaco; call `setupMonaco()` once
 * (the editor slice does it at startup) before creating models or editors.
 *
 * What it does:
 *  - tells Monaco where its web workers live (bundled into `workers/` next to the page);
 *  - registers the four .inc themes and follows the app theme (`inc:theme-changed`);
 *  - configures the TypeScript and JavaScript services for single-file editing, with semantic
 *    validation off so that imports never produce false "cannot find module" errors;
 *  - turns schema-less JSON, CSS, SCSS and Less validation on and keeps every language service
 *    offline (no schema or data fetching);
 *  - registers the extra language ids and associations from `languages.ts`.
 */
import * as monaco from 'monaco-editor';
import { type KnownLanguage, languageDisplayName, registerExtraLanguages, workerFileFor } from './languages';
import { incThemes, monacoThemeFor, type IncThemeName } from './themes';

export { monaco };
export {
  createEditorOptions,
  createEditorUpdateOptions,
  EDITOR_SETTING_KEYS,
  LARGE_FILE_OVERRIDES,
  readEditorSettings,
  type EditorOptionOverrides,
  type EditorSettingKey,
  type EditorSettings,
} from '../editor/editor-options';

type AppTheme = 'light' | 'dark' | 'hc-light' | 'hc-dark';

const APP_THEMES: readonly AppTheme[] = ['light', 'dark', 'hc-light', 'hc-dark'];

function isAppTheme(value: unknown): value is AppTheme {
  return typeof value === 'string' && (APP_THEMES as readonly string[]).includes(value);
}

/** The theme the document is currently showing, from `html[data-theme]`. */
export function currentAppTheme(): AppTheme {
  const attr = document.documentElement.getAttribute('data-theme');
  return isAppTheme(attr) ? attr : 'dark';
}

/** Apply the Monaco theme that matches an app theme id. */
export function applyMonacoTheme(theme: AppTheme): IncThemeName {
  const name = monacoThemeFor(theme);
  monaco.editor.setTheme(name);
  return name;
}

/**
 * Pull the theme id out of an `inc:theme-changed` event. The event may carry the id as its
 * detail, as `{ theme }`, or nothing at all (then the document attribute is the source of truth).
 */
export function themeFromEvent(event: Event): AppTheme {
  const detail = (event as CustomEvent<unknown>).detail;
  if (isAppTheme(detail)) return detail;
  if (detail && typeof detail === 'object') {
    const nested = (detail as { theme?: unknown; resolved?: unknown }).resolved ?? (detail as { theme?: unknown }).theme;
    if (isAppTheme(nested)) return nested;
  }
  return currentAppTheme();
}

function installWorkers(): void {
  const environment: monaco.Environment = {
    getWorker(_workerId: string, label: string): Worker {
      const url = new URL(`./workers/${workerFileFor(label)}`, document.baseURI).toString();
      return new Worker(url, { name: label });
    },
  };
  (self as unknown as { MonacoEnvironment?: monaco.Environment }).MonacoEnvironment = environment;
}

function installThemes(): void {
  for (const name of Object.keys(incThemes) as IncThemeName[]) {
    monaco.editor.defineTheme(name, incThemes[name]);
  }
  applyMonacoTheme(currentAppTheme());
  window.addEventListener('inc:theme-changed', (event) => {
    applyMonacoTheme(themeFromEvent(event));
  });
}

function configureTypeScript(): void {
  const ts = monaco.typescript;
  const compilerOptions: monaco.typescript.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    jsx: ts.JsxEmit.Preserve,
    allowNonTsExtensions: true,
    allowJs: true,
    checkJs: false,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    resolveJsonModule: true,
    skipLibCheck: true,
    noEmit: true,
  };
  // Single-file editing has no project context, so semantic diagnostics would flag every import.
  // Syntax validation and in-file IntelliSense stay on.
  const diagnostics: monaco.typescript.DiagnosticsOptions = {
    noSemanticValidation: true,
    noSyntaxValidation: false,
    noSuggestionDiagnostics: true,
  };
  for (const defaults of [ts.typescriptDefaults, ts.javascriptDefaults]) {
    defaults.setCompilerOptions(compilerOptions);
    defaults.setDiagnosticsOptions(diagnostics);
    defaults.setEagerModelSync(true);
  }
}

function configureWebLanguages(): void {
  monaco.json.jsonDefaults.setDiagnosticsOptions({
    validate: true,
    allowComments: false,
    comments: 'error',
    trailingCommas: 'error',
    schemaValidation: 'warning',
    schemaRequest: 'ignore',
    enableSchemaRequest: false,
    schemas: [],
  });
  for (const defaults of [monaco.css.cssDefaults, monaco.css.scssDefaults, monaco.css.lessDefaults]) {
    defaults.setOptions({ validate: true });
  }
  monaco.html.htmlDefaults.setOptions({ suggest: { html5: true } });
}

let ready = false;

/** Configure Monaco. Safe to call more than once; later calls do nothing. Returns the namespace. */
export function setupMonaco(): typeof monaco {
  if (ready) return monaco;
  ready = true;
  installWorkers();
  registerExtraLanguages(monaco.languages);
  installThemes();
  configureTypeScript();
  configureWebLanguages();
  return monaco;
}

/** Monaco's registered languages in the shape the detection tables use. */
export function knownLanguages(): KnownLanguage[] {
  return monaco.languages.getLanguages().map((l) => ({
    id: l.id,
    ...(l.aliases ? { aliases: l.aliases } : {}),
    ...(l.extensions ? { extensions: l.extensions } : {}),
    ...(l.filenames ? { filenames: l.filenames } : {}),
    ...(l.filenamePatterns ? { filenamePatterns: l.filenamePatterns } : {}),
    ...(l.firstLine ? { firstLine: l.firstLine } : {}),
  }));
}

export interface LanguageChoice {
  id: string;
  name: string;
}

/** Every selectable language, plain text first and then alphabetical by display name. */
export function languageChoices(): LanguageChoice[] {
  const known = knownLanguages();
  const choices = known.map((l) => ({ id: l.id, name: languageDisplayName(l.id, known) }));
  choices.sort((a, b) => {
    if (a.id === 'plaintext') return -1;
    if (b.id === 'plaintext') return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  return choices;
}
