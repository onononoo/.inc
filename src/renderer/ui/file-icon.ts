const CODE = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'c',
  'cc',
  'cpp',
  'h',
  'hpp',
  'cs',
  'rb',
  'php',
  'sh',
  'bash',
  'zsh',
  'ps1',
  'sql',
  'css',
  'scss',
  'less',
  'html',
  'vue',
  'svelte',
]);
const TEXT = new Set(['md', 'txt', 'log', 'rst', 'adoc']);
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp']);
const DATA = new Set(['json', 'jsonc', 'json5']);

/** One quiet glyph per kind of file; the product never uses coloured file-type icon packs. */
export function fileIconName(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  const ext = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : '';
  if (DATA.has(ext)) return 'file-json';
  if (IMAGE.has(ext)) return 'image';
  if (CODE.has(ext)) return 'file-code';
  if (TEXT.has(ext)) return 'file-text';
  return 'file';
}
