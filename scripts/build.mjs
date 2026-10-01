// Builds main, preload, renderer and worker bundles with esbuild.
//
//   node scripts/build.mjs                 build into ./dist
//   node scripts/build.mjs --out .tmp/foo  build into an isolated directory (parallel-safe)
//   node scripts/build.mjs --watch         rebuild on change
//   node scripts/build.mjs --production    minify, no source maps
//
// The output directory is a complete Electron app root: `electron <out>` runs it.
import { build, context } from 'esbuild';
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
};

export const outDir = path.resolve(root, option('out') ?? 'dist');
const watch = flag('watch');
const production = flag('production') || process.env.NODE_ENV === 'production';

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

// Modules with native binaries stay external and are resolved from node_modules at runtime.
const nativeExternals = ['electron', 'node-pty', '@parcel/watcher'];

const common = {
  bundle: true,
  sourcemap: production ? false : 'linked',
  minify: production,
  legalComments: 'none',
  logLevel: 'warning',
  absWorkingDir: root,
};

async function walk(dir, pred, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, pred, acc);
    else if (pred(full)) acc.push(full);
  }
  return acc;
}

/** Worker-thread entry points in the main process: any src/main/**\/*.worker.ts */
const mainWorkers = await walk(path.join(root, 'src/main'), (f) => f.endsWith('.worker.ts'));

// Monaco's package "exports" map hides these files, so point at them on disk.
const monacoEsm = path.join(root, 'node_modules/monaco-editor/esm/vs');
const monacoWorkers = {
  'editor.worker': path.join(monacoEsm, 'editor/editor.worker.js'),
  'json.worker': path.join(monacoEsm, 'language/json/json.worker.js'),
  'css.worker': path.join(monacoEsm, 'language/css/css.worker.js'),
  'html.worker': path.join(monacoEsm, 'language/html/html.worker.js'),
  'ts.worker': path.join(monacoEsm, 'language/typescript/ts.worker.js'),
};

const configs = [
  {
    ...common,
    entryPoints: { 'main/index': 'src/main/index.ts' },
    outdir: outDir,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: nativeExternals,
    tsconfig: 'tsconfig.main.json',
  },
  ...(mainWorkers.length
    ? [
        {
          ...common,
          entryPoints: Object.fromEntries(
            mainWorkers.map((f) => [`main/workers/${path.basename(f, '.worker.ts')}`, f]),
          ),
          outdir: outDir,
          platform: 'node',
          format: 'cjs',
          target: 'node24',
          external: nativeExternals,
          tsconfig: 'tsconfig.main.json',
        },
      ]
    : []),
  {
    ...common,
    entryPoints: { 'preload/index': 'src/preload/index.ts' },
    outdir: outDir,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron'],
    tsconfig: 'tsconfig.main.json',
  },
  {
    ...common,
    entryPoints: { 'renderer/main': 'src/renderer/main.tsx' },
    outdir: outDir,
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
    define: { 'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development') },
  },
  {
    ...common,
    entryPoints: Object.fromEntries(
      Object.entries(monacoWorkers).map(([name, file]) => [`renderer/workers/${name}`, file]),
    ),
    outdir: outDir,
    platform: 'browser',
    format: 'iife',
    target: 'chrome140',
  },
];

async function prepare() {
  await mkdir(outDir, { recursive: true });
  await mkdir(path.join(outDir, 'renderer'), { recursive: true });
  await copyFile(
    path.join(root, 'src/renderer/index.html'),
    path.join(outDir, 'renderer/index.html'),
  );
  // A runnable app root: `electron <outDir>` reads this manifest.
  await writeFile(
    path.join(outDir, 'package.json'),
    JSON.stringify(
      {
        name: pkg.name,
        productName: pkg.productName,
        version: pkg.version,
        description: pkg.description,
        license: pkg.license,
        main: 'main/index.js',
      },
      null,
      2,
    ),
  );
}

if (!watch && existsSync(outDir) && path.basename(outDir) !== 'dist') {
  await rm(outDir, { recursive: true, force: true });
}
await prepare();

if (watch) {
  const contexts = await Promise.all(configs.map((c) => context(c)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log(`Watching. Output: ${outDir}`);
} else {
  const started = Date.now();
  await Promise.all(configs.map((c) => build(c)));
  console.log(`Built ${path.relative(root, outDir) || '.'} in ${Date.now() - started} ms`);
}
