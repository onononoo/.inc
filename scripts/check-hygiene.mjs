// Repository hygiene gate. Fails when:
//  - a forbidden term appears in any tracked-style file name, directory name or file content;
//  - a source file imports Node or Electron APIs from the renderer;
//  - a file that looks like a secret or local environment file is present.
//
//   node scripts/check-hygiene.mjs
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Assembled at runtime so this file does not contain the terms it searches for.
const FORBIDDEN = [
  ['cl', 'aude'],
  ['anth', 'ropic'],
].map((parts) => parts.join(''));
const FORBIDDEN_RE = new RegExp(FORBIDDEN.join('|'), 'i');

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'out',
  'release',
  '.tmp',
  '.git',
  'test-results',
  'playwright-report',
  'coverage',
]);
const TEXT_EXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.css',
  '.html',
  '.svg',
  '.yml',
  '.yaml',
  '.txt',
  '.sh',
  '.ps1',
  '.cmd',
  '.bat',
  '.toml',
  '.editorconfig',
  '.gitignore',
  '.prettierrc',
]);
const SECRET_NAMES = [/^\.env(\..*)?$/i, /\.pem$/i, /\.p12$/i, /\.pfx$/i, /^id_rsa/i];

const problems = [];

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (FORBIDDEN_RE.test(entry.name)) problems.push(`forbidden term in directory name: ${rel}`);
      await walk(full);
      continue;
    }
    if (FORBIDDEN_RE.test(entry.name)) problems.push(`forbidden term in file name: ${rel}`);
    if (SECRET_NAMES.some((re) => re.test(entry.name))) problems.push(`secret-like file: ${rel}`);

    const ext = path.extname(entry.name).toLowerCase();
    const isText = TEXT_EXT.has(ext) || entry.name.startsWith('.');
    if (!isText) continue;
    const info = await stat(full);
    if (info.size > 5 * 1024 * 1024) continue;
    const text = await readFile(full, 'utf8').catch(() => '');
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (FORBIDDEN_RE.test(lines[i])) problems.push(`forbidden term: ${rel}:${i + 1}`);
    }
    if (rel.startsWith('src/renderer/') && /\.(ts|tsx)$/.test(entry.name)) {
      lines.forEach((line, i) => {
        if (/from\s+['"](electron|node:[^'"]+|fs|path|os|child_process)['"]/.test(line)) {
          problems.push(`renderer imports a Node/Electron module: ${rel}:${i + 1}`);
        }
      });
    }
  }
}

await walk(root);

if (problems.length) {
  console.error(`Hygiene check failed (${problems.length}):`);
  for (const p of problems.slice(0, 200)) console.error(`  ${p}`);
  process.exit(1);
}
console.log('Hygiene check passed.');
