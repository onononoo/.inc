// Third-party license inventory for the software that ships inside the app.
//
//   node scripts/licenses.mjs           write THIRD_PARTY_NOTICES.md and print the allowlist report
//   node scripts/licenses.mjs --check   fail if THIRD_PARTY_NOTICES.md is stale (does not write)
//
// The shipped dependency graph is:
//   1. everything esbuild bundles into the app (found through the bundler's metafile, so packages
//      that are fully tree-shaken away are not listed);
//   2. the runtime dependencies that stay external because they contain native code (node-pty and
//      @parcel/watcher) together with the packages they require at run time;
//   3. Electron, whose own notices (including the Chromium notices) ship next to the executable.
//
// The script exits non-zero when a package has no declared license, no license text, a license that
// is not on the allowlist, or a copyleft license that cannot be combined with MIT distribution.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Permissive licenses that may be redistributed inside an MIT-licensed product. */
export const ALLOWED_LICENSES = [
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'CC-BY-4.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'Python-2.0',
  'Unlicense',
  'Zlib',
];

/** Licenses whose terms cannot be combined with MIT distribution of the whole product. */
const COPYLEFT = /^(A?GPL|SSPL|EUPL|OSL|CC-BY-(NC|SA)|CPAL)/i;

/**
 * Packages that are declared as dependencies but only provide build-time headers. They are never
 * loaded at run time (verified by searching the shipped code for a require of them).
 */
export const BUILD_TIME_ONLY = new Set(['node-addon-api']);

const BUNDLED = 'Bundled into the application';
const RUNTIME = 'Loaded at run time (native module or its dependency)';
const BOTH = 'Bundled into the application and loaded at run time';

const RANK = { allowed: 0, unknown: 1, copyleft: 2, missing: 3 };

/** Tokenise an SPDX license expression. */
function tokenize(expression) {
  return expression.match(/\(|\)|[^\s()]+/g) ?? [];
}

/**
 * Classify an SPDX license expression against the allowlist.
 * OR picks the most permissive alternative, AND requires every operand to be acceptable.
 * @returns {{ status: 'allowed' | 'copyleft' | 'unknown' | 'missing', ids: string[] }}
 */
export function classifyLicense(expression) {
  if (typeof expression !== 'string' || expression.trim() === '') {
    return { status: 'missing', ids: [] };
  }
  const tokens = tokenize(expression);
  let at = 0;
  const ids = [];

  const worst = (a, b) => (RANK[a] >= RANK[b] ? a : b);
  const best = (a, b) => (RANK[a] <= RANK[b] ? a : b);

  function parseOr() {
    let status = parseAnd();
    while (tokens[at]?.toUpperCase() === 'OR') {
      at++;
      status = best(status, parseAnd());
    }
    return status;
  }
  function parseAnd() {
    let status = parseAtom();
    while (tokens[at]?.toUpperCase() === 'AND') {
      at++;
      status = worst(status, parseAtom());
    }
    return status;
  }
  function parseAtom() {
    const token = tokens[at++];
    if (token === undefined) return 'unknown';
    if (token === '(') {
      const inner = parseOr();
      if (tokens[at] === ')') at++;
      return inner;
    }
    const id = token.replace(/\+$/, '');
    ids.push(id);
    // "GPL-2.0 WITH Classpath-exception-2.0" is still GPL for our purposes.
    if (tokens[at]?.toUpperCase() === 'WITH') at += 2;
    if (COPYLEFT.test(id)) return 'copyleft';
    return ALLOWED_LICENSES.some((a) => a.toLowerCase() === id.toLowerCase())
      ? 'allowed'
      : 'unknown';
  }

  const status = parseOr();
  return { status: at < tokens.length ? worst(status, 'unknown') : status, ids: [...new Set(ids)] };
}

/** Read the declared license of a package.json as an SPDX-style expression. */
export function declaredLicense(manifest) {
  const single = (value) => (typeof value === 'string' ? value : value?.type);
  if (manifest.license !== undefined) return single(manifest.license);
  if (Array.isArray(manifest.licenses) && manifest.licenses.length > 0) {
    return `(${manifest.licenses.map(single).filter(Boolean).join(' OR ')})`;
  }
  return undefined;
}

/** Normalise license text so identical licenses group together regardless of line endings. */
export function normalizeText(text) {
  return text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Group entries that share identical license text.
 * @param {{ name: string, version: string, text: string }[]} entries
 * @returns {{ text: string, members: { name: string, version: string }[] }[]} sorted by first member
 */
export function groupByText(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const text = normalizeText(entry.text);
    const key = createHash('sha256').update(text.replace(/\s+/g, ' ')).digest('hex');
    const group = groups.get(key) ?? { text, members: [] };
    group.members.push({ name: entry.name, version: entry.version });
    groups.set(key, group);
  }
  const compare = (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version);
  const list = [...groups.values()];
  for (const g of list) g.members.sort(compare);
  return list.sort((a, b) => compare(a.members[0], b.members[0]));
}

const LICENSE_FILE = /^(licen[cs]e|copying|unlicen[cs]e)([-._].*)?(\.(md|txt|markdown))?$/i;
const NOTICE_FILE = /^(notice|third[-_ ]?party[-_ ]?notices?)(\.(md|txt))?$/i;

async function readTextFiles(dir, pattern) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const names = entries
    .filter((e) => e.isFile() && pattern.test(e.name))
    .map((e) => e.name)
    .sort();
  const parts = [];
  for (const name of names) {
    parts.push({ name, text: normalizeText(await readFile(path.join(dir, name), 'utf8')) });
  }
  return parts;
}

/** Longest `node_modules/<name>` prefix of a path, as `{ name, dir }`. */
export function packageOfPath(file) {
  const parts = file.split(/[\\/]/);
  const at = parts.lastIndexOf('node_modules');
  if (at === -1 || at === parts.length - 1) return undefined;
  const length = at + (parts[at + 1].startsWith('@') ? 3 : 2);
  if (parts.length < length) return undefined;
  return {
    name: parts.slice(at + 1, length).join('/'),
    dir: parts.slice(0, length).join(path.sep),
  };
}

function resolvePackageDir(fromDir, name) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name);
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function matchesTarget(constraints, target) {
  const allows = (list, value) =>
    !Array.isArray(list) || list.length === 0 || (value !== undefined && list.includes(value));
  const denies = (list, value) => Array.isArray(list) && list.includes(`!${value}`);
  return (
    allows(constraints.os, target.platform) &&
    allows(constraints.cpu, target.arch) &&
    allows(constraints.libc, target.libc) &&
    !denies(constraints.os, target.platform) &&
    !denies(constraints.cpu, target.arch)
  );
}

/**
 * Resolve the packages required at run time by the external (native) dependencies.
 *
 * Optional packages that are restricted to an operating system or CPU (native prebuilt binaries)
 * come back with `dir` set only when they match `target`; their identity always comes from the
 * lock file so the result does not depend on which platform ran the script.
 *
 * @param {string} appRoot repository root (holds package.json and package-lock.json)
 * @param {{ platform: string, arch: string, libc?: string }} [target] only needed to select binaries
 * @returns {Promise<{ name: string, version: string, dir?: string, license?: string, platformBinary: boolean, parent?: string }[]>}
 */
export async function resolveRuntimePackages(appRoot, target) {
  const manifest = await readJson(path.join(appRoot, 'package.json'));
  const lock = await readJson(path.join(appRoot, 'package-lock.json'));
  const lockEntry = (name) => lock.packages?.[`node_modules/${name}`];
  const seen = new Map();
  const queue = Object.keys(manifest.dependencies ?? {}).map((name) => ({ name, from: appRoot }));

  while (queue.length > 0) {
    const { name, from, optional, parent } = queue.shift();
    if (BUILD_TIME_ONLY.has(name)) continue;

    const entry = lockEntry(name);
    const isBinary = Boolean(optional && (entry?.os || entry?.cpu));
    if (isBinary) {
      const key = `${name}@${entry?.version ?? '?'}`;
      if (seen.has(key)) continue;
      const wanted = target !== undefined && matchesTarget(entry, target);
      const dir = wanted ? resolvePackageDir(from, name) : undefined;
      seen.set(key, {
        name,
        version: entry.version,
        license: entry.license,
        dir,
        platformBinary: true,
        parent,
        selected: wanted,
      });
      continue;
    }

    const dir = resolvePackageDir(from, name);
    if (!dir) {
      if (optional) continue;
      throw new Error(`Dependency "${name}" is not installed. Run npm ci first.`);
    }
    const pkg = await readJson(path.join(dir, 'package.json'));
    const key = `${pkg.name}@${pkg.version}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      name: pkg.name,
      version: pkg.version,
      license: declaredLicense(pkg),
      dir,
      platformBinary: false,
      parent,
    });
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      queue.push({ name: dep, from: dir, parent: pkg.name });
    }
    for (const dep of Object.keys(pkg.optionalDependencies ?? {})) {
      queue.push({ name: dep, from: dir, optional: true, parent: pkg.name });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Packages esbuild puts into the app bundles. Keep the entry points in sync with scripts/build.mjs. */
async function bundledPackages(appRoot) {
  const monacoEsm = 'node_modules/monaco-editor/esm/vs';
  const common = {
    bundle: true,
    write: false,
    metafile: true,
    logLevel: 'error',
    absWorkingDir: appRoot,
    outdir: '.tmp/licenses-probe',
    legalComments: 'none',
  };
  const workerEntries = await findWorkerEntries(path.join(appRoot, 'src/main'));
  const results = await Promise.all([
    build({
      ...common,
      entryPoints: { 'main/index': 'src/main/index.ts' },
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      external: ['electron', 'node-pty', '@parcel/watcher'],
      tsconfig: 'tsconfig.main.json',
    }),
    build({
      ...common,
      entryPoints: { 'preload/index': 'src/preload/index.ts' },
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      external: ['electron'],
      tsconfig: 'tsconfig.main.json',
    }),
    build({
      ...common,
      entryPoints: { 'renderer/main': 'src/renderer/main.tsx' },
      platform: 'browser',
      format: 'iife',
      target: 'chrome140',
      jsx: 'automatic',
      tsconfig: 'tsconfig.renderer.json',
      loader: {
        '.ttf': 'file',
        '.woff': 'file',
        '.woff2': 'file',
        '.svg': 'dataurl',
        '.png': 'dataurl',
      },
      assetNames: 'renderer/assets/[name]-[hash]',
      define: { 'process.env.NODE_ENV': '"production"' },
    }),
    build({
      ...common,
      entryPoints: {
        'editor.worker': `${monacoEsm}/editor/editor.worker.js`,
        'json.worker': `${monacoEsm}/language/json/json.worker.js`,
        'css.worker': `${monacoEsm}/language/css/css.worker.js`,
        'html.worker': `${monacoEsm}/language/html/html.worker.js`,
        'ts.worker': `${monacoEsm}/language/typescript/ts.worker.js`,
      },
      platform: 'browser',
      format: 'iife',
      target: 'chrome140',
    }),
    ...(workerEntries.length > 0
      ? [
          build({
            ...common,
            entryPoints: Object.fromEntries(
              workerEntries.map((f) => [path.basename(f, '.worker.ts'), f]),
            ),
            platform: 'node',
            format: 'cjs',
            target: 'node24',
            external: ['electron', 'node-pty', '@parcel/watcher'],
            tsconfig: 'tsconfig.main.json',
          }),
        ]
      : []),
  ]);

  const found = new Map();
  for (const result of results) {
    for (const output of Object.values(result.metafile.outputs)) {
      for (const [input, detail] of Object.entries(output.inputs)) {
        if (detail.bytesInOutput <= 0) continue;
        const owner = packageOfPath(input);
        if (owner) found.set(owner.name, path.resolve(appRoot, owner.dir));
      }
    }
  }
  return [...found.entries()].map(([name, dir]) => ({ name, dir }));
}

async function findWorkerEntries(dir) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await findWorkerEntries(full)));
    else if (entry.name.endsWith('.worker.ts')) out.push(path.relative(root, full));
  }
  return out.sort();
}

/**
 * Gather every shipped package with its declared license and license text.
 * @returns {Promise<{ entries: object[], problems: string[] }>}
 */
export async function collectInventory(appRoot = root) {
  const problems = [];
  const byKey = new Map();

  const add = async ({ dir, distribution }) => {
    const manifest = await readJson(path.join(dir, 'package.json'));
    const key = `${manifest.name}@${manifest.version}`;
    const existing = byKey.get(key);
    if (existing) {
      if (existing.distribution !== distribution) existing.distribution = BOTH;
      return;
    }
    const license = declaredLicense(manifest);
    const files = await readTextFiles(dir, LICENSE_FILE);
    const notices = await readTextFiles(dir, NOTICE_FILE);
    byKey.set(key, {
      name: manifest.name,
      version: manifest.version,
      license,
      distribution,
      licenseFiles: files,
      noticeFiles: notices,
    });
  };

  for (const { dir } of await bundledPackages(appRoot)) {
    await add({ dir, distribution: BUNDLED });
  }
  const runtime = await resolveRuntimePackages(appRoot, undefined);
  for (const pkg of runtime) {
    if (pkg.platformBinary) continue;
    await add({ dir: pkg.dir, distribution: RUNTIME });
  }
  // Prebuilt binary packages: identity from the lock file, text from the package that requires them.
  for (const pkg of runtime.filter((p) => p.platformBinary)) {
    const parent = [...byKey.values()].find((e) => e.name === pkg.parent);
    const key = `${pkg.name}@${pkg.version}`;
    if (!parent) {
      problems.push(`${key}: its parent package ${pkg.parent} is not part of the inventory`);
      continue;
    }
    if (pkg.license !== parent.license) {
      problems.push(
        `${key}: license ${pkg.license ?? '(none)'} differs from ${parent.name} (${parent.license}); add its text by hand`,
      );
      continue;
    }
    byKey.set(key, {
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      distribution: 'Prebuilt native binary for one platform (same license text as its parent)',
      licenseFiles: parent.licenseFiles,
      noticeFiles: parent.noticeFiles,
    });
  }

  const electronDir = path.join(appRoot, 'node_modules', 'electron');
  const electronManifest = await readJson(path.join(electronDir, 'package.json'));
  const electronLicenseFile = ['dist/LICENSE', 'LICENSE']
    .map((f) => path.join(electronDir, f))
    .find((f) => existsSync(f));
  byKey.set(`electron@${electronManifest.version}`, {
    name: 'electron',
    version: electronManifest.version,
    license: declaredLicense(electronManifest),
    distribution: 'Application runtime (Electron and Chromium)',
    licenseFiles: electronLicenseFile
      ? [{ name: 'LICENSE', text: normalizeText(await readFile(electronLicenseFile, 'utf8')) }]
      : [],
    noticeFiles: [],
  });

  const entries = [...byKey.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
  for (const entry of entries) {
    const label = `${entry.name}@${entry.version}`;
    const result = classifyLicense(entry.license);
    entry.status = result.status;
    entry.ids = result.ids;
    if (result.status === 'missing')
      problems.push(`${label}: no license is declared in package.json`);
    else if (result.status === 'copyleft') {
      problems.push(
        `${label}: ${entry.license} is copyleft and cannot ship in an MIT-licensed product`,
      );
    } else if (result.status === 'unknown') {
      problems.push(`${label}: license "${entry.license}" is not on the allowlist`);
    }
    if (entry.licenseFiles.length === 0)
      problems.push(`${label}: no license file found in the package`);
    entry.text = [
      ...entry.licenseFiles.map((f) => f.text),
      ...entry.noticeFiles.filter((f) => !/^third/i.test(f.name)).map((f) => f.text),
    ].join('\n\n');
    entry.thirdPartyNotices = entry.noticeFiles
      .filter((f) => /^third/i.test(f.name))
      .map((f) => f.text);
  }
  return { entries, problems };
}

function fenceFor(text) {
  let fence = '```';
  while (text.includes(fence)) fence += '`';
  return fence;
}

/** Render THIRD_PARTY_NOTICES.md. Output depends only on the inventory, never on time or platform. */
export function renderNotices(entries) {
  const lines = [];
  lines.push('# Third-party notices');
  lines.push('');
  lines.push(
    '.inc is released under the MIT License (see LICENSE). The application includes the third-party software listed below. Each package is distributed under its own license, reproduced in full in this file.',
  );
  lines.push('');
  lines.push(
    'This file is generated by `node scripts/licenses.mjs` from the dependency graph that ships in the application. Do not edit it by hand; regenerate it after changing dependencies.',
  );
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  const counts = new Map();
  for (const entry of entries) {
    counts.set(entry.license ?? 'unknown', (counts.get(entry.license ?? 'unknown') ?? 0) + 1);
  }
  lines.push('| License | Packages |');
  lines.push('| --- | ---: |');
  for (const [license, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`| ${license} | ${count} |`);
  }
  lines.push('');
  lines.push(`Total: ${entries.length} packages.`);
  lines.push('');
  lines.push('## Packages');
  lines.push('');
  lines.push('| Package | Version | License | How it ships |');
  lines.push('| --- | --- | --- | --- |');
  for (const entry of entries) {
    lines.push(`| ${entry.name} | ${entry.version} | ${entry.license} | ${entry.distribution} |`);
  }
  lines.push('');
  lines.push('## Chromium and other components of the Electron runtime');
  lines.push('');
  lines.push(
    'Every packaged build contains `LICENSE` (Electron) and `LICENSES.chromium.html` (the notices for Chromium and the components it embeds) beside the executable. Redistribute both files with the application.',
  );
  lines.push('');
  lines.push('## License texts');
  lines.push('');
  const groups = groupByText(entries);
  groups.forEach((group, index) => {
    lines.push(`### Text ${index + 1} of ${groups.length}`);
    lines.push('');
    lines.push(`Applies to: ${group.members.map((m) => `${m.name} ${m.version}`).join(', ')}`);
    lines.push('');
    const fence = fenceFor(group.text);
    lines.push(`${fence}text`);
    lines.push(group.text);
    lines.push(fence);
    lines.push('');
  });

  const extras = entries.filter((e) => e.thirdPartyNotices.length > 0);
  if (extras.length > 0) {
    lines.push('## Notices bundled with dependencies');
    lines.push('');
    for (const entry of extras) {
      lines.push(`### ${entry.name} ${entry.version}`);
      lines.push('');
      for (const text of entry.thirdPartyNotices) {
        const fence = fenceFor(text);
        lines.push(`${fence}text`);
        lines.push(text);
        lines.push(fence);
        lines.push('');
      }
    }
  }
  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}

function printReport(entries, problems) {
  const byStatus = (status) => entries.filter((e) => e.status === status);
  console.log(`Allowlist: ${ALLOWED_LICENSES.join(', ')}`);
  console.log(`Denied as copyleft: GPL, AGPL, SSPL (and similar strong copyleft licenses)`);
  console.log('');
  const counts = new Map();
  for (const entry of entries)
    counts.set(entry.license ?? '(none)', (counts.get(entry.license ?? '(none)') ?? 0) + 1);
  for (const [license, count] of [...counts.entries()].sort()) {
    console.log(`  ${String(count).padStart(4)}  ${license}`);
  }
  console.log('');
  console.log(
    `${entries.length} packages: ${byStatus('allowed').length} allowed, ${byStatus('unknown').length} unknown, ${byStatus('copyleft').length} copyleft, ${byStatus('missing').length} missing a license`,
  );
  if (problems.length > 0) {
    console.error('');
    console.error(`License check failed (${problems.length}):`);
    for (const problem of problems) console.error(`  ${problem}`);
  }
}

async function main() {
  const check = process.argv.includes('--check');
  const { entries, problems } = await collectInventory(root);
  printReport(entries, problems);
  if (problems.length > 0) process.exit(1);

  const target = path.join(root, 'THIRD_PARTY_NOTICES.md');
  const generated = renderNotices(entries);
  if (check) {
    const current = existsSync(target) ? normalizeText(await readFile(target, 'utf8')) : '';
    if (current !== normalizeText(generated)) {
      console.error('THIRD_PARTY_NOTICES.md is out of date. Run: npm run licenses');
      process.exit(1);
    }
    console.log('THIRD_PARTY_NOTICES.md is up to date.');
    return;
  }
  await writeFile(target, generated);
  console.log('Wrote THIRD_PARTY_NOTICES.md');
}

const isEntry =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntry) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
