/**
 * Language detection tables and extra language registrations.
 *
 * Everything here is pure data and pure functions (no Monaco value imports) so it can be unit
 * tested in Node. `registerExtraLanguages` receives Monaco's `languages` namespace as an argument.
 *
 * Detection order, applied first to the extra associations below (they win over Monaco's own
 * definitions) and then to the languages Monaco ships:
 *   1. exact file name        (Dockerfile, .gitignore)
 *   2. file name pattern      (tsconfig*.json, Dockerfile.*)
 *   3. extension, longest first (.d.ts before .ts)
 *   4. first line             (shebang)
 */
import type * as Monaco from 'monaco-editor';

/** The subset of Monaco's language extension point that detection needs. */
export interface KnownLanguage {
  id: string;
  aliases?: readonly string[];
  extensions?: readonly string[];
  filenames?: readonly string[];
  filenamePatterns?: readonly string[];
  /** Regular expression source matched against the first line. */
  firstLine?: string;
}

export interface LanguageAssociation extends KnownLanguage {
  /** Display name used in the status bar and the language picker. */
  name: string;
}

export const PLAIN_TEXT = 'plaintext';

/**
 * Associations that add to or override the languages Monaco ships. Ids that Monaco does not
 * know (jsonc, makefile, toml) are registered by `registerExtraLanguages`.
 */
export const EXTRA_LANGUAGES: readonly LanguageAssociation[] = [
  {
    id: 'jsonc',
    name: 'JSON with Comments',
    aliases: ['JSON with Comments', 'jsonc'],
    extensions: ['.jsonc', '.code-workspace', '.code-snippets', '.babelrc', '.jshintrc', '.swcrc'],
    filenames: ['.eslintrc', '.eslintrc.json', '.babelrc', '.jshintrc', '.swcrc', 'devcontainer.json'],
    filenamePatterns: ['tsconfig*.json', 'jsconfig*.json'],
  },
  {
    id: 'dockerfile',
    name: 'Dockerfile',
    aliases: ['Dockerfile'],
    extensions: ['.dockerfile'],
    filenames: ['dockerfile', 'containerfile'],
    filenamePatterns: ['dockerfile.*', 'containerfile.*', '*.dockerfile'],
  },
  {
    id: 'makefile',
    name: 'Makefile',
    aliases: ['Makefile', 'make'],
    extensions: ['.mk', '.mak'],
    filenames: ['makefile', 'gnumakefile'],
    filenamePatterns: ['makefile.*'],
    firstLine: '^#!.*\\bmake\\b',
  },
  {
    id: 'shell',
    name: 'Shell script',
    aliases: ['Shell script', 'shell', 'sh', 'bash', 'zsh'],
    extensions: ['.sh', '.bash', '.zsh', '.ksh', '.dash'],
    filenames: [
      '.bashrc',
      '.bash_profile',
      '.bash_aliases',
      '.bash_logout',
      '.zshrc',
      '.zprofile',
      '.zshenv',
      '.zlogin',
      '.profile',
      '.kshrc',
      'pkgbuild',
    ],
    firstLine: '^#!.*\\b(bash|zsh|sh|ksh|dash|ash)\\b',
  },
  {
    id: 'ini',
    name: 'INI',
    aliases: ['INI', 'ini', 'properties'],
    extensions: ['.ini', '.properties', '.cfg', '.conf', '.env'],
    filenames: ['.env', '.gitmodules', '.npmrc', '.yarnrc', '.editorconfig', '.pylintrc'],
    filenamePatterns: ['.env.*', '*.env'],
  },
  {
    id: 'toml',
    name: 'TOML',
    aliases: ['TOML', 'toml'],
    extensions: ['.toml'],
    filenames: ['cargo.lock', 'pipfile', 'poetry.lock', 'pdm.lock'],
  },
  {
    id: 'javascript',
    name: 'JavaScript',
    firstLine: '^#!.*\\b(node|nodejs|bun)\\b',
  },
  {
    id: 'typescript',
    name: 'TypeScript',
    firstLine: '^#!.*\\b(ts-node|tsx|deno)\\b',
  },
  {
    id: PLAIN_TEXT,
    name: 'Plain text',
    aliases: ['Plain text', 'text'],
    extensions: ['.txt', '.text', '.log'],
    filenames: [
      '.gitignore',
      '.gitkeep',
      '.dockerignore',
      '.npmignore',
      '.prettierignore',
      '.eslintignore',
      '.gcloudignore',
      '.slugignore',
      '.nvmrc',
      '.node-version',
      '.python-version',
      '.ruby-version',
      '.tool-versions',
      'license',
      'licence',
      'notice',
      'authors',
      'contributors',
      'codeowners',
    ],
  },
];

const DISPLAY_NAMES: Readonly<Record<string, string>> = {
  plaintext: 'Plain text',
  jsonc: 'JSON with Comments',
  json: 'JSON',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  html: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  less: 'Less',
  markdown: 'Markdown',
  yaml: 'YAML',
  xml: 'XML',
  sql: 'SQL',
  shell: 'Shell script',
  bat: 'Batch',
  powershell: 'PowerShell',
  python: 'Python',
  java: 'Java',
  kotlin: 'Kotlin',
  csharp: 'C#',
  cpp: 'C++',
  c: 'C',
  go: 'Go',
  rust: 'Rust',
  ruby: 'Ruby',
  php: 'PHP',
  swift: 'Swift',
  dockerfile: 'Dockerfile',
  makefile: 'Makefile',
  ini: 'INI',
  toml: 'TOML',
  graphql: 'GraphQL',
  protobuf: 'Protocol Buffers',
  objective: 'Objective-C',
  'objective-c': 'Objective-C',
  fsharp: 'F#',
  vb: 'Visual Basic',
  hcl: 'HCL',
  lua: 'Lua',
  r: 'R',
  scala: 'Scala',
  dart: 'Dart',
  perl: 'Perl',
  razor: 'Razor',
  handlebars: 'Handlebars',
  pug: 'Pug',
  restructuredtext: 'reStructuredText',
};

/** Human-readable name for a language id. */
export function languageDisplayName(id: string, known: readonly KnownLanguage[] = []): string {
  const fixed = DISPLAY_NAMES[id];
  if (fixed) return fixed;
  const alias = known.find((k) => k.id === id)?.aliases?.[0];
  if (alias) return alias;
  return id.length === 0 ? 'Plain text' : id.charAt(0).toUpperCase() + id.slice(1);
}

function lastSegment(fileName: string): string {
  const i = Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\'));
  return i === -1 ? fileName : fileName.slice(i + 1);
}

/** Every suffix of a base name that starts at a dot, longest first: "a.d.ts" -> [".d.ts", ".ts"]. */
export function extensionCandidates(baseName: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < baseName.length; i++) {
    if (baseName[i] === '.') out.push(baseName.slice(i));
  }
  return out;
}

const globCache = new Map<string, RegExp>();

/** Convert a file name glob (`*` and `?` only) to a case-insensitive expression. */
export function globToRegExp(glob: string): RegExp {
  let re = globCache.get(glob);
  if (!re) {
    const source = glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]');
    re = new RegExp(`^${source}$`, 'i');
    globCache.set(glob, re);
  }
  return re;
}

const firstLineCache = new Map<string, RegExp | null>();

function firstLineExpression(source: string): RegExp | null {
  let re = firstLineCache.get(source);
  if (re === undefined) {
    try {
      re = new RegExp(source);
    } catch {
      re = null;
    }
    firstLineCache.set(source, re);
  }
  return re;
}

/** Match a shebang or other first line against the language tables. Returns undefined when none match. */
export function detectFromFirstLine(
  firstLine: string,
  known: readonly KnownLanguage[] = [],
): string | undefined {
  const line = firstLine.trim();
  if (!line) return undefined;
  for (const tier of [EXTRA_LANGUAGES, known]) {
    for (const lang of tier) {
      if (!lang.firstLine) continue;
      const re = firstLineExpression(lang.firstLine);
      if (re?.test(line)) return lang.id;
    }
  }
  return undefined;
}

/**
 * Language id for a file. `known` is Monaco's registered language list
 * (`monaco.languages.getLanguages()`); pass an empty list to use only the extra table.
 */
export function detectLanguage(
  fileName: string,
  firstLine: string | undefined,
  known: readonly KnownLanguage[] = [],
): string {
  const base = lastSegment(fileName).toLowerCase();
  const tiers: readonly (readonly KnownLanguage[])[] = [EXTRA_LANGUAGES, known];

  for (const tier of tiers) {
    for (const lang of tier) {
      if (lang.filenames?.some((n) => n.toLowerCase() === base)) return lang.id;
    }
  }
  for (const tier of tiers) {
    for (const lang of tier) {
      if (lang.filenamePatterns?.some((p) => globToRegExp(p).test(base))) return lang.id;
    }
  }
  const candidates = extensionCandidates(base);
  for (const ext of candidates) {
    for (const tier of tiers) {
      for (const lang of tier) {
        if (lang.extensions?.some((e) => e.toLowerCase() === ext)) return lang.id;
      }
    }
  }
  if (firstLine) {
    const byLine = detectFromFirstLine(firstLine, known);
    if (byLine) return byLine;
  }
  return PLAIN_TEXT;
}

/** Monaco worker script for a language label. Files are built into `renderer/workers/`. */
export function workerFileFor(label: string): string {
  switch (label) {
    case 'json':
    case 'jsonc':
      return 'json.worker.js';
    case 'css':
    case 'scss':
    case 'less':
      return 'css.worker.js';
    case 'html':
    case 'handlebars':
    case 'razor':
      return 'html.worker.js';
    case 'typescript':
    case 'javascript':
      return 'ts.worker.js';
    default:
      return 'editor.worker.js';
  }
}

// --- Tokenizers for languages Monaco does not ship ---------------------------------------------

export const TOML_TOKENIZER: Monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.toml',
  escapes: /\\(?:[btnfr"\\]|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,
  tokenizer: {
    root: [
      [/#.*$/, 'comment'],
      [/^\s*\[\[[^\]]*\]\]/, 'type'],
      [/^\s*\[[^\]]*\]/, 'type'],
      [/"(?:[^"\\]|\\.)*"(?=\s*=)/, 'attribute.name'],
      [/[A-Za-z0-9_.-]+(?=\s*=)/, 'attribute.name'],
      [/=/, 'delimiter'],
      { include: '@values' },
    ],
    values: [
      [/"""/, { token: 'string', next: '@multilineBasic' }],
      [/'''/, { token: 'string', next: '@multilineLiteral' }],
      [/"/, { token: 'string', next: '@basic' }],
      [/'[^']*'/, 'string'],
      [
        /\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?/,
        'number',
      ],
      [/\d{2}:\d{2}:\d{2}(?:\.\d+)?/, 'number'],
      [/[+-]?(?:inf|nan)\b/, 'number'],
      [/[+-]?0x[0-9A-Fa-f_]+/, 'number.hex'],
      [/[+-]?0o[0-7_]+/, 'number.octal'],
      [/[+-]?0b[01_]+/, 'number.binary'],
      [/[+-]?\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?/, 'number'],
      [/\b(?:true|false)\b/, 'keyword'],
      [/[[\]{},]/, 'delimiter'],
    ],
    basic: [
      [/[^\\"]+/, 'string'],
      [/@escapes/, 'string.escape'],
      [/\\./, 'string.escape.invalid'],
      [/"/, { token: 'string', next: '@pop' }],
    ],
    multilineBasic: [
      [/[^\\"]+/, 'string'],
      [/@escapes/, 'string.escape'],
      [/\\$/, 'string.escape'],
      [/\\./, 'string.escape.invalid'],
      [/"""/, { token: 'string', next: '@pop' }],
      [/"/, 'string'],
    ],
    multilineLiteral: [
      [/[^']+/, 'string'],
      [/'''/, { token: 'string', next: '@pop' }],
      [/'/, 'string'],
    ],
  },
};

export const MAKEFILE_TOKENIZER: Monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.makefile',
  directives: [
    'include',
    '-include',
    'sinclude',
    'ifeq',
    'ifneq',
    'ifdef',
    'ifndef',
    'else',
    'endif',
    'define',
    'endef',
    'export',
    'unexport',
    'override',
    'vpath',
    'private',
    'undefine',
  ],
  tokenizer: {
    root: [
      [/^\t[@+-]*/, 'operator'],
      [/#.*$/, 'comment'],
      [/^[ ]*(?:-include|[a-z]+)\b/, { cases: { '@directives': 'keyword', '@default': '' } }],
      [/^[A-Za-z_][\w.-]*(?=\s*(?:[:+?!]|::)?=)/, 'variable'],
      [/^[^\s:=#$][^:=#]*(?=::?(?!=))/, 'type'],
      [/:?:?[+?!]?=/, 'operator'],
      [/\$[({][^)}]*[)}]/, 'variable'],
      [/\$[@<^?*%+|$]/, 'variable.predefined'],
      [/"(?:[^"\\]|\\.)*"/, 'string'],
      [/'[^']*'/, 'string'],
      [/[:|;]/, 'delimiter'],
    ],
  },
};

/**
 * JSON with comments. Token names carry the `.json` postfix so the themes' JSON rules
 * (`string.key.json`, `string.value.json`, ...) colour it exactly like strict JSON.
 */
export const JSONC_TOKENIZER: Monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.json',
  escapes: /\\(?:["\\/bfnrt]|u[0-9A-Fa-f]{4})/,
  tokenizer: {
    root: [
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'string.key'],
      [/"/, { token: 'string.value', next: '@string' }],
      [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
      [/\b(?:true|false|null)\b/, 'keyword'],
      [/\/\/.*$/, 'comment'],
      [/\/\*/, { token: 'comment', next: '@comment' }],
      [/[{}]/, 'delimiter.bracket'],
      [/[[\]]/, 'delimiter.array'],
      [/:/, 'delimiter.colon'],
      [/,/, 'delimiter.comma'],
    ],
    string: [
      [/[^\\"]+/, 'string.value'],
      [/@escapes/, 'string.escape'],
      [/\\./, 'string.escape.invalid'],
      [/"/, { token: 'string.value', next: '@pop' }],
    ],
    comment: [
      [/[^/*]+/, 'comment'],
      [/\*\//, { token: 'comment', next: '@pop' }],
      [/[/*]/, 'comment'],
    ],
  },
};

const JSONC_CONFIGURATION: Monaco.languages.LanguageConfiguration = {
  comments: { lineComment: '//', blockComment: ['/*', '*/'] },
  brackets: [
    ['{', '}'],
    ['[', ']'],
  ],
  autoClosingPairs: [
    { open: '{', close: '}', notIn: ['string'] },
    { open: '[', close: ']', notIn: ['string'] },
    { open: '"', close: '"', notIn: ['string'] },
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '"', close: '"' },
  ],
  folding: { offSide: false },
};

const HASH_COMMENT_CONFIGURATION: Monaco.languages.LanguageConfiguration = {
  comments: { lineComment: '#' },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')'],
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"', notIn: ['string'] },
    { open: "'", close: "'", notIn: ['string'] },
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
};

/**
 * Register the language ids Monaco does not ship, with their tokenizers and editing
 * configuration. `jsonc` has no language service; its syntax errors are reported by
 * `editor/jsonc-markers.ts`.
 */
export function registerExtraLanguages(api: typeof Monaco.languages): void {
  const registered = new Set(api.getLanguages().map((l) => l.id));
  const missing = ['jsonc', 'makefile', 'toml'].filter((id) => !registered.has(id));
  for (const id of missing) {
    const assoc = EXTRA_LANGUAGES.find((l) => l.id === id);
    if (!assoc) continue;
    api.register({
      id,
      aliases: assoc.aliases ? [...assoc.aliases] : [assoc.name],
      extensions: assoc.extensions ? [...assoc.extensions] : [],
      filenames: assoc.filenames ? [...assoc.filenames] : [],
      filenamePatterns: assoc.filenamePatterns ? [...assoc.filenamePatterns] : [],
      ...(assoc.firstLine ? { firstLine: assoc.firstLine } : {}),
    });
  }
  if (missing.includes('jsonc')) {
    api.setMonarchTokensProvider('jsonc', JSONC_TOKENIZER);
    api.setLanguageConfiguration('jsonc', JSONC_CONFIGURATION);
  }
  if (missing.includes('toml')) {
    api.setMonarchTokensProvider('toml', TOML_TOKENIZER);
    api.setLanguageConfiguration('toml', HASH_COMMENT_CONFIGURATION);
  }
  if (missing.includes('makefile')) {
    api.setMonarchTokensProvider('makefile', MAKEFILE_TOKENIZER);
    api.setLanguageConfiguration('makefile', HASH_COMMENT_CONFIGURATION);
  }
}
