// Production build and packaging.
//
//   node scripts/package.mjs                          package for this platform and architecture
//   node scripts/package.mjs --platform linux --arch x64
//
// Options:
//   --platform <win32|darwin|linux>   target platform (default: this machine)
//   --arch <x64|arm64>                target architecture (default: this machine)
//   --out <dir>                       output directory (default: release)
//   --skip-build                      reuse <out>/app from a previous run
//   --no-smoke                        do not launch the packaged app (smoke tests only run for the host platform)
//   --smoke-no-sandbox                launch the smoke test with --no-sandbox (Linux CI containers without setuid sandbox)
//   --zip                             also create inc-<version>-<platform>-<arch>.zip and a .sha256 file
//   --electron-zip-dir <dir>          use Electron archives from this directory instead of downloading
//   --bundle-id <id>                  macOS bundle identifier (default: inc.editor; set your own for releases)
//
// Steps: build the app with esbuild, stage only the production runtime dependencies (the native
// modules and what they load), package with @electron/packager, verify the layout, smoke-test the
// produced executable, report the size.
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveRuntimePackages } from './licenses.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Executable and bundle name. The product name (.inc) starts with a dot, see docs/PACKAGING.md. */
export const EXECUTABLE_NAME = 'inc';
export const PLATFORMS = ['win32', 'darwin', 'linux'];
export const ARCHITECTURES = ['x64', 'arm64'];

export function parseArgs(argv, host = { platform: process.platform, arch: process.arch }) {
  const options = {
    platform: host.platform,
    arch: host.arch,
    out: 'release',
    skipBuild: false,
    smoke: true,
    smokeNoSandbox: false,
    zip: false,
    electronZipDir: undefined,
    bundleId: 'inc.editor',
  };
  const value = (i, name) => {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`${name} needs a value`);
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--platform') options.platform = value(i++, arg);
    else if (arg === '--arch') options.arch = value(i++, arg);
    else if (arg === '--out') options.out = value(i++, arg);
    else if (arg === '--electron-zip-dir') options.electronZipDir = value(i++, arg);
    else if (arg === '--bundle-id') options.bundleId = value(i++, arg);
    else if (arg === '--skip-build') options.skipBuild = true;
    else if (arg === '--no-smoke') options.smoke = false;
    else if (arg === '--smoke-no-sandbox') options.smokeNoSandbox = true;
    else if (arg === '--zip') options.zip = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!PLATFORMS.includes(options.platform)) {
    throw new Error(`Unsupported platform "${options.platform}". Use one of: ${PLATFORMS.join(', ')}`);
  }
  if (!ARCHITECTURES.includes(options.arch)) {
    throw new Error(`Unsupported architecture "${options.arch}". Use one of: ${ARCHITECTURES.join(', ')}`);
  }
  return options;
}

/** Files that never belong in a shipped dependency, whichever package they come from. */
const GENERIC_FILE_DENY =
  /(\.(map|pdb|ilk|exp|lib|obj|o|a|tsbuildinfo|flow|ts|mts|cts|md|markdown|gyp|gypi)|\.test\.[cm]?js)$/i;
const KEEP_DOCUMENTS = /^(licen[cs]e|notice|copying)/i;
const GENERIC_DIR_DENY = new Set(['test', 'tests', '__tests__', 'docs', 'example', 'examples', '.github']);

/**
 * Decide whether a file or directory inside an installed package is copied into the app.
 * @param {string} packageName
 * @param {string} rel path relative to the package root, with forward slashes ('' is the root)
 * @param {boolean} isDirectory
 * @param {{ platform: string, arch: string }} target
 */
export function shouldShip(packageName, rel, isDirectory, target) {
  if (rel === '') return true;
  const parts = rel.split('/');
  const name = parts[parts.length - 1];

  if (isDirectory) {
    if (parts.length === 1 && GENERIC_DIR_DENY.has(name)) return false;
  } else if (GENERIC_FILE_DENY.test(name) && !KEEP_DOCUMENTS.test(name)) {
    return false;
  }

  if (packageName === 'node-pty') {
    const top = parts[0];
    if (['src', 'deps', 'third_party', 'scripts', 'typings'].includes(top)) return false;
    if (top === 'prebuilds') {
      if (parts.length === 1) return true;
      return parts[1] === `${target.platform}-${target.arch}`;
    }
    if (top === 'build') {
      if (isDirectory) return ['build', 'build/Release', 'build/Release/conpty'].includes(rel);
      return /\.(node|dll|exe)$/i.test(name) || name === 'spawn-helper';
    }
  }
  if (packageName === '@parcel/watcher') {
    if (['src', 'scripts'].includes(parts[0])) return false;
  }
  return true;
}

/** Name of the @parcel/watcher prebuilt package for a target. */
export function watcherBinaryName(target, libc = 'glibc') {
  const base = `@parcel/watcher-${target.platform}-${target.arch}`;
  return target.platform === 'linux' ? `${base}-${libc}` : base;
}

/**
 * C library family of the target. Linux builds of @parcel/watcher exist for glibc and musl; a build
 * for this very machine uses what this machine runs, anything else assumes glibc.
 */
export function targetLibc(target, hostPlatform = process.platform) {
  if (target.platform !== 'linux') return undefined;
  if (hostPlatform !== 'linux' || target.arch !== process.arch) return 'glibc';
  return process.report?.getReport().header.glibcVersionRuntime ? 'glibc' : 'musl';
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', cwd: root, ...options });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${path.basename(command)} ${args[0] ?? ''} exited with ${code}`)),
    );
  });
}

function exec(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, ...options }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${command} failed: ${stderr || error.message}`));
      else resolve(stdout);
    });
  });
}

async function directorySize(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySize(full);
    else if (entry.isFile()) total += (await stat(full)).size;
  }
  return total;
}

const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/** Copy the production runtime dependencies into the built app and declare them in its manifest. */
async function stageRuntimeDependencies(appDir, target, rootDependencies) {
  const libc = targetLibc(target);
  const packages = await resolveRuntimePackages(root, { ...target, libc });
  const wanted = watcherBinaryName(target, libc);
  const missing = packages.filter((p) => p.platformBinary && p.name === wanted && !p.dir);
  if (missing.length > 0) {
    throw new Error(
      `${wanted} is not installed. Install the optional dependencies for the target, for example ` +
        `"npm install --no-save --os=${target.platform} --cpu=${target.arch}", or run this script on that platform.`,
    );
  }

  const modulesDir = path.join(appDir, 'node_modules');
  await rm(modulesDir, { recursive: true, force: true });
  const dependencies = {};
  for (const pkg of packages) {
    if (!pkg.dir) continue;
    const destination = path.join(modulesDir, ...pkg.name.split('/'));
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(pkg.dir, destination, {
      recursive: true,
      dereference: true,
      filter: (source) => {
        const rel = path.relative(pkg.dir, source).split(path.sep).join('/');
        return shouldShip(pkg.name, rel, statSync(source).isDirectory(), target);
      },
    });
    dependencies[pkg.name] = pkg.version;
  }

  const nodePty = path.join(modulesDir, 'node-pty');
  if (existsSync(nodePty)) await verifyNodePtyBinary(nodePty, target);
  // Helper executables lose their mode bit when a checkout or copy goes through some file systems.
  for (const helper of await findFiles(modulesDir, (f) => path.basename(f) === 'spawn-helper')) {
    await chmod(helper, 0o755);
  }

  const manifestPath = path.join(appDir, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.dependencies = Object.fromEntries(
    Object.entries(dependencies).filter(([name]) => Object.keys(rootDependencies).includes(name)),
  );
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return packages.filter((p) => p.dir);
}

async function findFiles(dir, predicate, found = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await findFiles(full, predicate, found);
    else if (predicate(full)) found.push(full);
  }
  return found;
}

async function verifyNodePtyBinary(nodePtyDir, target) {
  const candidates = [
    path.join(nodePtyDir, 'build', 'Release'),
    path.join(nodePtyDir, 'prebuilds', `${target.platform}-${target.arch}`),
  ];
  const withBinary = candidates.filter(
    (dir) => existsSync(path.join(dir, 'pty.node')) || existsSync(path.join(dir, 'conpty.node')),
  );
  if (withBinary.length === 0) {
    throw new Error(
      `node-pty has no native binary for ${target.platform}-${target.arch}. ` +
        'node-pty ships prebuilt binaries for Windows and macOS only; on Linux it is compiled during npm ci, ' +
        'which needs python3, make and a C++ compiler.',
    );
  }
}

/** Zip a packaged folder with the platform's own archiver (no extra dependencies). */
export async function createZip(folder, zipPath, hostPlatform = process.platform) {
  await rm(zipPath, { force: true });
  const parent = path.dirname(folder);
  const name = path.basename(folder);
  if (hostPlatform === 'win32') {
    // bsdtar ships with Windows 10 and later and writes zip archives; Git's GNU tar does not.
    const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    await exec(tar, ['-a', '-c', '-f', zipPath, '-C', parent, name]);
  } else if (hostPlatform === 'darwin') {
    await exec('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', folder, zipPath]);
  } else {
    await exec('zip', ['-q', '-r', '-y', zipPath, name], { cwd: parent });
  }
}

export async function sha256File(file) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    createReadStream(file).on('data', (c) => hash.update(c)).on('end', resolve).on('error', reject);
  });
  return hash.digest('hex');
}

/** Check the packaged layout: what must be present, and what must not. */
export async function verifyLayout({ resourcesDir, target, executable }) {
  const problems = [];
  const asarFile = path.join(resourcesDir, 'app.asar');
  const unpacked = path.join(resourcesDir, 'app.asar.unpacked');
  if (!existsSync(executable)) problems.push(`executable is missing: ${executable}`);
  if (!existsSync(asarFile)) problems.push('resources/app.asar is missing');

  if (existsSync(asarFile)) {
    const asar = await import('@electron/asar');
    const listing = asar.listPackage(asarFile, { isPack: false }).map((f) => f.split('\\').join('/'));
    const has = (f) => listing.includes(f);
    for (const required of ['/package.json', '/main/index.js', '/preload/index.js', '/renderer/index.html']) {
      if (!has(required)) problems.push(`app.asar is missing ${required}`);
    }
    const maps = listing.filter((f) => f.endsWith('.map'));
    if (maps.length > 0) problems.push(`app.asar contains ${maps.length} source maps, for example ${maps[0]}`);
    const tests = listing.filter((f) => /(^|\/)(tests?|__tests__)\//.test(f) || /\.test\.[cm]?js$/.test(f));
    if (tests.length > 0) problems.push(`app.asar contains test files, for example ${tests[0]}`);
    const sources = listing.filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts'));
    if (sources.length > 0) problems.push(`app.asar contains TypeScript sources, for example ${sources[0]}`);
  }

  const natives = await findFiles(unpacked, (f) => f.endsWith('.node')).catch(() => []);
  const rel = (f) => path.relative(unpacked, f).split(path.sep).join('/');
  if (!natives.some((f) => rel(f).startsWith('node_modules/node-pty/') && /(pty|conpty)\.node$/.test(f))) {
    problems.push('the node-pty native module is not unpacked from app.asar');
  }
  if (!natives.some((f) => rel(f).startsWith('node_modules/@parcel/watcher-') && f.endsWith('watcher.node'))) {
    problems.push('the @parcel/watcher native module is not unpacked from app.asar');
  }
  if (target.platform === 'win32') {
    for (const helper of ['winpty-agent.exe', 'winpty.dll']) {
      const found = await findFiles(path.join(unpacked, 'node_modules', 'node-pty'), (f) => f.endsWith(helper)).catch(
        () => [],
      );
      if (found.length === 0) problems.push(`node-pty helper ${helper} is not unpacked`);
    }
  }
  if (target.platform !== 'win32') {
    const helpers = await findFiles(path.join(unpacked, 'node_modules', 'node-pty'), (f) => path.basename(f) === 'spawn-helper').catch(
      () => [],
    );
    if (target.platform === 'darwin' && helpers.length === 0) problems.push('node-pty spawn-helper is not unpacked');
    if (process.platform !== 'win32') {
      for (const helper of helpers) {
        const mode = (await stat(helper)).mode;
        if ((mode & 0o111) === 0) problems.push(`${rel(helper)} is not executable`);
      }
    }
  }
  for (const notice of ['THIRD_PARTY_NOTICES.md', 'LICENSE']) {
    if (!existsSync(path.join(resourcesDir, notice))) problems.push(`resources/${notice} is missing`);
  }
  return problems;
}

/**
 * Launch the packaged executable and check that it works as shipped:
 * the window renders, the bridge answers, a PTY spawns from the unpacked node-pty and the file
 * watcher reports a change.
 */
export async function smokeTest({ executable, noSandbox, screenshotPath }) {
  const { _electron: electron } = await import('@playwright/test');
  const userData = await mkdtemp(path.join(os.tmpdir(), 'inc-smoke-'));
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'inc-smoke-work-'));
  const app = await electron.launch({
    executablePath: executable,
    args: noSandbox ? ['--no-sandbox'] : [],
    env: {
      ...process.env,
      INC_TEST_HIDDEN: '1',
      INC_USER_DATA_DIR: userData,
      INC_POLICY_FILE: path.join(userData, 'no-policy.json'),
      ELECTRON_ENABLE_LOGGING: '0',
    },
    timeout: 60_000,
  });
  const report = {};
  try {
    const page = await app.firstWindow();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('#root > *', { timeout: 30_000 });

    const envelope = await page.evaluate(() => window.inc.invokeRaw('app:getInfo'));
    if (!envelope.ok) throw new Error(`app:getInfo failed: ${envelope.error?.message}`);
    report.info = envelope.value;
    if (report.info.name !== '.inc') throw new Error(`Unexpected product name "${report.info.name}"`);
    if (report.info.isPackaged !== true) throw new Error('The app does not report itself as packaged');
    if (screenshotPath) await page.screenshot({ path: screenshotPath });

    // Native modules load from the packaged app exactly as the main process would load them.
    report.native = await app.evaluate(async ({ app: electronApp }, { workDir: dir }) => {
      const builtin = (name) => process.getBuiltinModule(name);
      const fs = builtin('node:fs');
      const nodePath = builtin('node:path');
      const requireFromApp = builtin('node:module').createRequire(
        nodePath.join(electronApp.getAppPath(), 'package.json'),
      );
      const result = { appPath: electronApp.getAppPath() };

      const pty = requireFromApp('node-pty');
      const marker = `inc-smoke-${Date.now()}`;
      const win = process.platform === 'win32';
      const term = pty.spawn(
        win ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh',
        win ? ['/d', '/c', `echo ${marker}`] : ['-c', `echo ${marker}`],
        { name: 'xterm-256color', cols: 80, rows: 24, cwd: dir, env: process.env },
      );
      let output = '';
      term.onData((data) => {
        output += data;
      });
      const exit = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ exitCode: null, timedOut: true }), 20_000);
        term.onExit((e) => {
          clearTimeout(timer);
          resolve(e);
        });
      });
      result.pty = { marker, seen: output.includes(marker), exitCode: exit.exitCode, timedOut: Boolean(exit.timedOut) };

      const watcher = requireFromApp('@parcel/watcher');
      const watched = fs.mkdtempSync(nodePath.join(dir, 'watch-'));
      let subscription;
      const changed = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no file event within 20 s')), 20_000);
        watcher
          .subscribe(watched, (error, events) => {
            if (error) {
              clearTimeout(timer);
              reject(error);
            } else if (events.some((e) => e.path.endsWith('smoke.txt'))) {
              clearTimeout(timer);
              resolve(events.map((e) => e.type));
            }
          })
          .then((sub) => {
            subscription = sub;
            fs.writeFileSync(nodePath.join(watched, 'smoke.txt'), 'hello');
          }, reject);
      });
      result.watcher = { events: await changed };
      await subscription.unsubscribe();
      return result;
    }, { workDir });

    if (!report.native.pty.seen || report.native.pty.exitCode !== 0) {
      throw new Error(`PTY smoke test failed: ${JSON.stringify(report.native.pty)}`);
    }
    if (report.native.watcher.events.length === 0) throw new Error('The file watcher reported no events');
    if (!report.native.appPath.endsWith('app.asar')) {
      throw new Error(`The app is not running from app.asar: ${report.native.appPath}`);
    }
    if (pageErrors.length > 0) throw new Error(`Uncaught page errors: ${pageErrors.join('; ')}`);
  } finally {
    await app.close().catch(() => undefined);
    await rm(userData, { recursive: true, force: true, maxRetries: 5 });
    await rm(workDir, { recursive: true, force: true, maxRetries: 5 });
  }
  return report;
}

function executablePathFor(packagedDir, platform) {
  if (platform === 'win32') return path.join(packagedDir, `${EXECUTABLE_NAME}.exe`);
  if (platform === 'darwin') return path.join(packagedDir, `${EXECUTABLE_NAME}.app`, 'Contents', 'MacOS', EXECUTABLE_NAME);
  return path.join(packagedDir, EXECUTABLE_NAME);
}

function resourcesPathFor(packagedDir, platform) {
  return platform === 'darwin'
    ? path.join(packagedDir, `${EXECUTABLE_NAME}.app`, 'Contents', 'Resources')
    : path.join(packagedDir, 'resources');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const target = { platform: options.platform, arch: options.arch };
  const outDir = path.resolve(root, options.out);
  const appDir = path.join(outDir, 'app');
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

  if (options.skipBuild) {
    if (!existsSync(path.join(appDir, 'main', 'index.js'))) {
      throw new Error(`--skip-build needs a previous build in ${appDir}`);
    }
  } else {
    await mkdir(outDir, { recursive: true });
    console.log('Building the application...');
    await run(process.execPath, [path.join(root, 'scripts', 'build.mjs'), '--production', '--out', appDir]);
  }

  console.log(`Staging runtime dependencies for ${target.platform}-${target.arch}...`);
  const staged = await stageRuntimeDependencies(appDir, target, manifest.dependencies ?? {});
  console.log(`  ${staged.map((p) => `${p.name}@${p.version}`).join(', ')}`);

  const iconBase = path.join(root, 'resources', 'icons', 'icon');
  if (!existsSync(`${iconBase}.ico`) || !existsSync(`${iconBase}.icns`)) {
    throw new Error('Icons are missing. Run: node scripts/make-icons.mjs');
  }
  const notices = path.join(root, 'THIRD_PARTY_NOTICES.md');
  if (!existsSync(notices)) throw new Error('THIRD_PARTY_NOTICES.md is missing. Run: npm run licenses');

  const { packager } = await import('@electron/packager');
  console.log('Packaging...');
  const outputs = await packager({
    dir: appDir,
    out: outDir,
    name: EXECUTABLE_NAME,
    executableName: EXECUTABLE_NAME,
    platform: target.platform,
    arch: target.arch,
    appVersion: manifest.version,
    appCopyright: 'Copyright (c) .inc contributors',
    appBundleId: options.bundleId,
    icon: iconBase,
    overwrite: true,
    prune: false,
    quiet: true,
    asar: { unpack: '**/node_modules/{node-pty,@parcel}/**' },
    ignore: [/\.map$/],
    extraResource: [notices, path.join(root, 'LICENSE')],
    ...(options.electronZipDir ? { electronZipDir: path.resolve(options.electronZipDir) } : {}),
    win32metadata: {
      CompanyName: '.inc contributors',
      FileDescription: '.inc',
      ProductName: '.inc',
      InternalName: EXECUTABLE_NAME,
      OriginalFilename: `${EXECUTABLE_NAME}.exe`,
    },
    extendInfo: { CFBundleDisplayName: '.inc', CFBundleName: '.inc' },
  });
  const packagedDir = outputs[0];
  const executable = executablePathFor(packagedDir, target.platform);
  const resourcesDir = resourcesPathFor(packagedDir, target.platform);

  const problems = await verifyLayout({ resourcesDir, target, executable });
  if (problems.length > 0) {
    console.error('Package verification failed:');
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log('Package layout verified.');

  const isHost = target.platform === process.platform && target.arch === process.arch;
  if (options.smoke && isHost) {
    console.log('Smoke-testing the packaged app...');
    const report = await smokeTest({
      executable,
      noSandbox: options.smokeNoSandbox,
      screenshotPath: path.join(outDir, 'smoke-window.png'),
    });
    console.log(
      `  window rendered; ${report.info.name} ${report.info.version} (Electron ${report.info.electron}); ` +
        `PTY exit ${report.native.pty.exitCode}; watcher events: ${report.native.watcher.events.join(', ')}`,
    );
  } else if (options.smoke) {
    console.log(`Smoke test skipped: ${target.platform}-${target.arch} cannot run on ${process.platform}-${process.arch}.`);
  }

  const asarSize = await stat(path.join(resourcesDir, 'app.asar')).then((s) => s.size);
  const unpackedDir = path.join(resourcesDir, 'app.asar.unpacked');
  const unpackedSize = existsSync(unpackedDir) ? await directorySize(unpackedDir) : 0;
  console.log(
    `Packaged size: ${mib(await directorySize(packagedDir))} (app.asar ${mib(asarSize)}, unpacked native modules ${mib(unpackedSize)})`,
  );
  console.log(`Output: ${path.relative(root, packagedDir)}`);

  if (options.zip) {
    const zipPath = path.join(outDir, `${EXECUTABLE_NAME}-${manifest.version}-${target.platform}-${target.arch}.zip`);
    await createZip(packagedDir, zipPath);
    const digest = await sha256File(zipPath);
    await writeFile(`${zipPath}.sha256`, `${digest}  ${path.basename(zipPath)}\n`);
    console.log(`Archive: ${path.relative(root, zipPath)} (${mib((await stat(zipPath)).size)}), sha256 ${digest}`);
  }
}

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntry) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
