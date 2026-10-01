/**
 * Search worker thread. Receives tasks from the pool and answers each with one terminal reply
 * (plus streamed `matches` / `outcomes` messages while it works):
 *
 *  - `dir`: list one folder, apply the exclude, include and ignore-file filters, and report the
 *    sub-folders and files that remain;
 *  - `files`: search a batch of files;
 *  - `replace`: replace text in a batch of files.
 *
 * Everything here is synchronous; the main thread's watchdog terminates a worker that stops
 * making progress (a pathological regular expression) and the control array carries cancellation.
 */
import { Buffer, isUtf8 } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import type { FileMatches } from '@shared/api/search';
import { GlobSet } from './globs';
import { IGNORE_FILE_NAMES, IgnoreChain, IgnoreRules } from './ignore';
import {
  CONTROL_CANCELLED,
  MAX_IGNORE_FILE_BYTES,
  PROGRESS_HEARTBEAT,
  PROGRESS_ITEM,
  type DirTask,
  type FilesTask,
  type IgnoreSource,
  type JobSpec,
  type MainMessage,
  type ReplaceTask,
  type SubDir,
  type WorkerData,
  type WorkerReply,
  type WorkerTask,
} from './protocol';
import { buildRegExp } from './query';
import { SCRATCH_BYTES, describeFsError, readForSearch, replaceInFile } from './files';
import { scanText } from './scan';
import { decodeText, detectBom, detectEncoding } from './text';

if (!parentPort) throw new Error('search.worker must run inside a worker thread');
const port = parentPort;
const progress = new Int32Array((workerData as WorkerData).progress);
const scratch = Buffer.allocUnsafe(SCRATCH_BYTES);

/** Matches are posted when this many have piled up or this much time has passed. */
const FLUSH_MATCHES = 200;
const FLUSH_MS = 25;
/** Compiled ignore rules kept per job before the cache is emptied (sources are always kept). */
const COMPILED_RULES_LIMIT = 500;

const caseInsensitive = process.platform !== 'linux';

interface JobContext {
  spec: JobSpec;
  control: Int32Array;
  regex: RegExp;
  exclude: GlobSet;
  include: GlobSet;
  prefilter: Buffer | null;
  prefilterIsAscii: boolean;
  sources: Map<number, { base: string; text: string }>;
  compiled: Map<number, IgnoreRules>;
}

const jobs = new Map<number, JobContext>();

function heartbeat(): void {
  Atomics.add(progress, PROGRESS_HEARTBEAT, 1);
}

function isCancelled(ctx: JobContext): boolean {
  return Atomics.load(ctx.control, CONTROL_CANCELLED) !== 0;
}

function post(reply: WorkerReply): void {
  port.postMessage(reply);
}

function createContext(spec: JobSpec, controlBuffer: SharedArrayBuffer): JobContext {
  const prefilter = spec.matcher.prefilter;
  return {
    spec,
    control: new Int32Array(controlBuffer),
    regex: buildRegExp(spec.matcher),
    exclude: new GlobSet(spec.filters.exclude),
    include: new GlobSet(spec.filters.include),
    prefilter: prefilter === null ? null : Buffer.from(prefilter, 'utf8'),
    // eslint-disable-next-line no-control-regex
    prefilterIsAscii: prefilter !== null && /^[\x00-\x7f]*$/.test(prefilter),
    sources: new Map(),
    compiled: new Map(),
  };
}

function absolute(root: string, relative: string): string {
  return relative === '' ? root : path.join(root, ...relative.split('/'));
}

// --- Folder listing -----------------------------------------------------------------------

function rulesFor(ctx: JobContext, source: IgnoreSource): IgnoreRules {
  if (source.text !== undefined)
    ctx.sources.set(source.id, { base: source.base, text: source.text });
  let rules = ctx.compiled.get(source.id);
  if (!rules) {
    const known = ctx.sources.get(source.id);
    if (!known) throw new Error(`Unknown ignore source ${source.id}`);
    if (ctx.compiled.size >= COMPILED_RULES_LIMIT) ctx.compiled.clear();
    rules = new IgnoreRules(known.base, known.text);
    ctx.compiled.set(source.id, rules);
  }
  return rules;
}

function readIgnoreFiles(abs: string, entries: fs.Dirent[]): string | null {
  const texts: string[] = [];
  for (const name of IGNORE_FILE_NAMES) {
    const entry = entries.find((e) => e.name === name);
    if (!entry || entry.isDirectory()) continue;
    try {
      const file = path.join(abs, name);
      if (fs.statSync(file).size > MAX_IGNORE_FILE_BYTES) continue;
      texts.push(fs.readFileSync(file, 'utf8'));
    } catch {
      /* an unreadable ignore file is treated as absent */
    }
  }
  return texts.length > 0 ? texts.join('\n') : null;
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function listDirectory(ctx: JobContext, task: DirTask): WorkerReply {
  const { spec } = ctx;
  const abs = absolute(spec.root, task.dir);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch (error) {
    return { type: 'task-failed', message: describeFsError(error) };
  }

  const rules = task.chain.map((source) => rulesFor(ctx, source));
  let ownSource: string | null = null;
  if (spec.filters.useIgnoreFiles) {
    ownSource = readIgnoreFiles(abs, entries);
    if (ownSource !== null) rules.push(new IgnoreRules(task.dir, ownSource));
  }
  const chain = new IgnoreChain(rules);
  const follow = spec.filters.followSymlinks;
  const filterByInclude = !ctx.include.isEmpty;

  const subdirs: SubDir[] = [];
  const files: { name: string }[] = [];
  let unreadable = 0;

  for (const entry of entries) {
    const name = entry.name;
    const rel = task.dir === '' ? name : `${task.dir}/${name}`;
    let isDir: boolean;
    let isFile: boolean;
    let real: string | undefined;

    if (entry.isSymbolicLink()) {
      if (!follow) continue;
      try {
        const target = path.join(abs, name);
        const stat = fs.statSync(target);
        isDir = stat.isDirectory();
        isFile = stat.isFile();
        if (isDir) real = fs.realpathSync(target);
      } catch (error) {
        // A dangling link is not an error; anything else is reported.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unreadable++;
        continue;
      }
    } else {
      isDir = entry.isDirectory();
      isFile = entry.isFile();
      if (isDir && follow && task.real !== undefined) real = path.join(task.real, name);
    }
    if (!isDir && !isFile) continue;

    if (ctx.exclude.matches(rel)) continue;
    if (isDir) {
      if (filterByInclude && !ctx.include.mayContain(rel)) continue;
      if (chain.length > 0 && chain.isIgnored(rel, true)) continue;
      if (real !== undefined && task.ancestors) {
        const key = caseInsensitive ? real.toLowerCase() : real;
        const cycle = task.ancestors.some((a) => (caseInsensitive ? a.toLowerCase() : a) === key);
        if (cycle) continue;
      }
      subdirs.push(real === undefined ? { name } : { name, real });
    } else {
      if (filterByInclude && !ctx.include.matches(rel)) continue;
      if (chain.length > 0 && chain.isIgnored(rel, false)) continue;
      files.push({ name });
    }
  }

  subdirs.sort(byName);
  files.sort(byName);
  return {
    type: 'dir-done',
    subdirs,
    files: files.map((f) => f.name),
    ownSource,
    unreadable,
  };
}

// --- Searching files ----------------------------------------------------------------------

/** False when the file provably cannot contain a match, judging by its raw bytes. */
function mayMatch(ctx: JobContext, bytes: Buffer): boolean {
  if (ctx.prefilter === null) return true;
  const bom = detectBom(bytes);
  if (bom === 'utf16le' || bom === 'utf16be') return true;
  // Non-ASCII text has different bytes in different encodings; only trust UTF-8 for it.
  if (!ctx.prefilterIsAscii && !isUtf8(bytes)) return true;
  return bytes.includes(ctx.prefilter);
}

function searchFiles(ctx: JobContext, task: FilesTask): WorkerReply {
  const { root } = ctx.spec;
  let searched = 0;
  let binary = 0;
  let large = 0;
  let unreadable = 0;
  let pending: FileMatches[] = [];
  let pendingCount = 0;
  let lastFlush = Date.now();

  const flush = () => {
    if (pending.length > 0) post({ type: 'matches', files: pending, matchCount: pendingCount });
    pending = [];
    pendingCount = 0;
    lastFlush = Date.now();
  };
  const hooks = { heartbeat, shouldStop: () => isCancelled(ctx) };

  for (let i = 0; i < task.files.length; i++) {
    Atomics.store(progress, PROGRESS_ITEM, i);
    heartbeat();
    if (isCancelled(ctx)) break;
    const rel = task.files[i] as string;
    const file = absolute(root, rel);
    const read = readForSearch(file, scratch);
    if (read.kind === 'binary') {
      binary++;
      continue;
    }
    if (read.kind === 'large') {
      large++;
      continue;
    }
    if (read.kind === 'unreadable') {
      unreadable++;
      continue;
    }
    searched++;
    if (!mayMatch(ctx, read.bytes)) continue;
    const text = decodeText(read.bytes, detectEncoding(read.bytes));
    const result = scanText(text, ctx.regex, hooks);
    if (result.matches.length === 0) continue;
    const entry: FileMatches = { path: file, relativePath: rel, matches: result.matches };
    if (result.truncated) entry.truncated = true;
    pending.push(entry);
    pendingCount += result.matches.length;
    if (pendingCount >= FLUSH_MATCHES || Date.now() - lastFlush >= FLUSH_MS) flush();
  }
  flush();
  return { type: 'files-done', searched, binary, large, unreadable };
}

// --- Replacing ----------------------------------------------------------------------------

function replaceFiles(ctx: JobContext, task: ReplaceTask): WorkerReply {
  for (let i = 0; i < task.files.length; i++) {
    Atomics.store(progress, PROGRESS_ITEM, i);
    heartbeat();
    if (isCancelled(ctx)) break;
    const item = task.files[i] as ReplaceTask['files'][number];
    const outcome = replaceInFile(item.path, item.expectedMtimeMs, {
      regex: ctx.regex,
      isRegex: ctx.spec.matcher.isRegex,
      replacement: ctx.spec.replacement,
      realRoot: ctx.spec.realRoot,
      hooks: { heartbeat },
    });
    post({ type: 'outcomes', results: [outcome] });
  }
  return { type: 'replace-done' };
}

function run(ctx: JobContext, task: WorkerTask): WorkerReply {
  switch (task.kind) {
    case 'dir':
      return listDirectory(ctx, task);
    case 'files':
      return searchFiles(ctx, task);
    case 'replace':
      return replaceFiles(ctx, task);
  }
}

port.on('message', (message: MainMessage) => {
  switch (message.type) {
    case 'begin':
      jobs.set(message.jobId, createContext(message.spec, message.control));
      break;
    case 'end':
      jobs.delete(message.jobId);
      break;
    case 'task': {
      const ctx = jobs.get(message.jobId);
      if (!ctx) {
        post({ type: 'task-failed', message: 'The search job is no longer known to the worker.' });
        break;
      }
      let reply: WorkerReply;
      try {
        reply = run(ctx, message.task);
      } catch (error) {
        reply = {
          type: 'task-failed',
          message: error instanceof Error ? error.message : String(error),
        };
      }
      post(reply);
      break;
    }
  }
});
