// Development runner: rebuilds on change and keeps a running app in step with the source.
//
//   node scripts/dev.mjs                       build into .tmp/dev, watch, run the app
//   node scripts/dev.mjs -- C:/path/to/folder  arguments after "--" go to the app (open a folder)
//
// Options:
//   --out <dir>             build directory (default: .tmp/dev)
//   --user-data-dir <dir>   user-data directory for the dev app (default: .tmp/dev-user-data), so a
//                           dev session never touches the settings of an installed copy
//   --debug-port <port>     loopback DevTools port used to reload the window (default: a free port)
//
// What happens when something changes:
//   - main process, preload or worker output changes: Electron is stopped and started again;
//   - renderer output changes: the open windows are reloaded (Page.reload over the DevTools protocol
//     on 127.0.0.1; the port is only opened by this development runner, never by the app itself);
// Closing the window, or pressing Ctrl+C, stops everything. A crash of the app keeps the runner alive
// and the next successful rebuild starts it again.
import { execFile, spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Quiet period after the last output change before the runner reacts (a rebuild writes many files). */
const SETTLE_MS = 200;
/** The bundler's first build writes the large worker bundles last; wait longer before the first start. */
const STARTUP_SETTLE_MS = 1000;

/**
 * Parse the command line.
 * @param {string[]} argv
 * @returns {{ out: string, userDataDir: string, debugPort: number | undefined, appArgs: string[] }}
 */
export function parseDevArgs(argv) {
  const options = {
    out: '.tmp/dev',
    userDataDir: '.tmp/dev-user-data',
    debugPort: undefined,
    appArgs: [],
  };
  const separator = argv.indexOf('--');
  const own = separator === -1 ? argv : argv.slice(0, separator);
  options.appArgs = separator === -1 ? [] : argv.slice(separator + 1);
  const value = (i, name) => {
    const next = own[i + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`${name} needs a value`);
    return next;
  };
  for (let i = 0; i < own.length; i++) {
    const arg = own[i];
    if (arg === '--out') options.out = value(i++, arg);
    else if (arg === '--user-data-dir') options.userDataDir = value(i++, arg);
    else if (arg === '--debug-port') {
      const port = Number(value(i++, arg));
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('--debug-port must be an integer from 1 to 65535');
      }
      options.debugPort = port;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

/**
 * Decide what a set of changed output files means for the running app.
 * Main, preload and worker bundles need a restart; renderer files need a window reload.
 * Source maps are ignored, and a restart always includes a reload.
 * @param {string[]} files paths relative to the output directory
 * @returns {'restart' | 'reload' | 'none'}
 */
export function classifyChange(files) {
  let result = 'none';
  for (const file of files) {
    const normalized = file.split(path.sep).join('/').replace(/^\.\//, '');
    if (normalized.endsWith('.map')) continue;
    if (normalized.startsWith('main/') || normalized.startsWith('preload/')) return 'restart';
    if (normalized.startsWith('renderer/')) result = 'reload';
  }
  return result;
}

/** Kill a process and everything it started. A plain kill leaves helper processes behind on Windows. */
function killTree(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
    if (process.platform === 'win32' && child.pid !== undefined) {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {
        // If taskkill could not find it the process is already gone; the exit event resolves above.
        setTimeout(resolve, 2000).unref();
      });
    } else {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    }
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Send Page.reload to one DevTools target and wait for the answer. */
function reloadTarget(webSocketUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('the window did not answer'));
    }, 5000);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ id: 1, method: 'Page.reload', params: { ignoreCache: true } }));
    });
    socket.addEventListener('message', (event) => {
      if (JSON.parse(String(event.data)).id === 1) {
        clearTimeout(timer);
        socket.close();
        resolve();
      }
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('could not connect to the window'));
    });
  });
}

/** The DevTools endpoint opens a moment after the process starts, so retry while it refuses. */
async function listTargets(port) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      return await response.json();
    } catch (error) {
      if (attempt >= 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

async function reloadWindows(port) {
  const targets = (await listTargets(port)).filter(
    (t) => t.type === 'page' && t.webSocketDebuggerUrl,
  );
  if (targets.length === 0) throw new Error('no window is open');
  await Promise.all(targets.map((t) => reloadTarget(t.webSocketDebuggerUrl)));
}

function pipeWithPrefix(stream, prefix, sink) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) sink.write(`${prefix} ${line}\n`);
  });
  stream.on('end', () => {
    if (pending) sink.write(`${prefix} ${pending}\n`);
  });
}

async function main() {
  const options = parseDevArgs(process.argv.slice(2));
  const outDir = path.resolve(root, options.out);
  const userDataDir = path.resolve(root, options.userDataDir);
  const debugPort = options.debugPort ?? (await freePort());
  const electronPath = createRequire(import.meta.url)('electron');
  await mkdir(userDataDir, { recursive: true });

  const log = (message) => process.stdout.write(`[dev] ${message}\n`);
  let stopping = false;
  let started = false;
  let electron;
  let builder;
  let watcher;
  let timer;
  const pending = new Set();

  async function shutdown(code, reason) {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    watcher?.close();
    if (reason) log(reason);
    await Promise.all([builder && killTree(builder), electron && killTree(electron)]);
    process.exit(code);
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    process.on(signal, () => void shutdown(0, 'Stopping.'));
  }

  // 1. The bundler in watch mode. It prints "Watching." once the first build has finished.
  builder = spawn(
    process.execPath,
    [path.join(root, 'scripts', 'build.mjs'), '--watch', '--out', outDir],
    {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  pipeWithPrefix(builder.stderr, '[build]', process.stderr);
  const firstBuild = new Promise((resolve, reject) => {
    pipeWithPrefix(builder.stdout, '[build]', process.stdout);
    builder.stdout.on('data', (chunk) => {
      if (String(chunk).includes('Watching.')) resolve();
    });
    builder.once('error', reject);
    builder.once('exit', (code) =>
      reject(new Error(`the build exited with code ${code} before the first build finished`)),
    );
  });
  builder.once('exit', (code) => {
    // Ctrl+C reaches the builder and this process at the same time; let the signal handler win.
    setTimeout(() => {
      if (!stopping)
        void shutdown(1, `The build process stopped unexpectedly (exit code ${code}).`);
    }, 300);
  });
  await firstBuild;

  // 2. The app.
  function startElectron() {
    const child = spawn(
      electronPath,
      [`--remote-debugging-port=${debugPort}`, outDir, ...options.appArgs],
      {
        cwd: root,
        stdio: 'inherit',
        env: (() => {
          const env = {
            ...process.env,
            INC_USER_DATA_DIR: process.env.INC_USER_DATA_DIR ?? userDataDir,
            INC_LOG_STDOUT: '1',
          };
          delete env.ELECTRON_RUN_AS_NODE;
          return env;
        })(),
      },
    );
    child.once('error', (error) => void shutdown(1, `Could not start Electron: ${error.message}`));
    child.once('exit', (code, signal) => {
      if (stopping || child !== electron) return;
      electron = undefined;
      if (code === 0 && signal === null) void shutdown(0, 'The window was closed.');
      else log(`The app exited (${signal ?? `code ${code}`}). Waiting for the next change.`);
    });
    electron = child;
  }

  async function restartElectron() {
    const previous = electron;
    electron = undefined;
    if (previous) await killTree(previous);
    if (!stopping) startElectron();
  }

  async function react() {
    started = true;
    const files = [...pending];
    pending.clear();
    const action = classifyChange(files);
    if (action === 'none' || stopping) return;
    if (action === 'restart' || !electron) {
      log(electron ? 'Main or preload changed: restarting.' : 'Build is ready: starting the app.');
      await restartElectron();
      return;
    }
    try {
      await reloadWindows(debugPort);
      log('Renderer changed: window reloaded.');
    } catch (error) {
      log(
        `Renderer changed but the window could not be reloaded (${error.message}). Restart with Ctrl+C.`,
      );
    }
  }

  watcher = watch(outDir, { recursive: true }, (_event, file) => {
    if (!file) return;
    pending.add(file.toString());
    clearTimeout(timer);
    timer = setTimeout(() => void react(), started ? SETTLE_MS : STARTUP_SETTLE_MS);
  });
  watcher.on('error', (error) => void shutdown(1, `Watching ${outDir} failed: ${error.message}`));

  log(`Running ${path.relative(root, outDir) || '.'}. Press Ctrl+C to stop.`);
  // The bundler keeps writing for a moment after it announces itself, so the first start goes through
  // the same settle timer as every later change: the app starts once the output has been quiet.
  pending.add('main/index.js');
  timer = setTimeout(() => void react(), STARTUP_SETTLE_MS);
}

const isEntry =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntry) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
