import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ReplaceRequest, ReplaceResult, SearchQuery } from '@shared/api/search';
import { IncError } from '@shared/errors';
import { isWithin, type Platform } from '@shared/paths';
import type { Disposable, Kernel } from '../kernel';
import { enabledPatterns, normalizeGlob } from './globs';
import { ReplaceJob, SearchJob } from './jobs';
import { WorkerPool } from './pool';
import type { FilterSpec, JobSpec } from './protocol';
import { compileQuery } from './query';

const MAX_REPLACE_FILES = 50_000;
const MAX_GLOBS = 100;
const DEFAULT_MAX_RESULTS = 20_000;
const HARD_MAX_RESULTS = 200_000;

function normaliseGlobs(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw.slice(0, MAX_GLOBS)) {
    if (typeof entry !== 'string') continue;
    const glob = normalizeGlob(entry);
    if (glob) out.push(glob);
  }
  return out;
}

function assertQuery(value: unknown): SearchQuery {
  if (!value || typeof value !== 'object')
    throw new IncError('E_INVALID', 'The search query is not valid.');
  const q = value as Partial<SearchQuery>;
  if (typeof q.pattern !== 'string')
    throw new IncError('E_INVALID', 'Enter something to search for.');
  return {
    pattern: q.pattern,
    isRegex: q.isRegex === true,
    caseSensitive: q.caseSensitive === true,
    wholeWord: q.wholeWord === true,
    include: Array.isArray(q.include) ? q.include : [],
    exclude: Array.isArray(q.exclude) ? q.exclude : [],
    maxResults: typeof q.maxResults === 'number' ? q.maxResults : undefined,
  };
}

/**
 * Search slice: text search and replace across the workspace. The heavy lifting happens in a small
 * pool of worker threads; this side validates requests, streams results to the window and keeps
 * one running search per window.
 */
export function register(kernel: Kernel, options: { workerPath?: string } = {}): Disposable {
  const platform = kernel.info.platform as Platform;
  const pool = new WorkerPool({
    size: Math.max(1, Math.min(4, os.cpus().length - 1)),
    workerPath: options.workerPath ?? path.join(__dirname, 'workers', 'search.js'),
    watchdogMs: 8000,
    cancelGraceMs: 400,
    idleMs: 60_000,
    logger: kernel.logger,
  });

  let nextJobId = 1;
  const running = new Map<number, { searchId: number; job: SearchJob }>();

  function rootFor(windowId: number): { root: string; realRoot: string } {
    const root = kernel.workspaces.getRoot(windowId);
    if (!root) throw new IncError('E_NO_WORKSPACE', 'Open a folder to search in it.');
    let realRoot: string;
    try {
      realRoot = fs.realpathSync(root);
    } catch {
      throw new IncError('E_NOT_FOUND', 'The workspace folder could not be found.', { path: root });
    }
    return { root, realRoot };
  }

  function specFor(
    windowId: number,
    query: SearchQuery,
    kind: JobSpec['kind'],
    replacement: string,
  ): JobSpec {
    const { root, realRoot } = rootFor(windowId);
    const filters: FilterSpec = {
      exclude: [
        ...enabledPatterns(kernel.settings.get(windowId, 'search.exclude')),
        ...normaliseGlobs(query.exclude),
      ],
      include: normaliseGlobs(query.include),
      useIgnoreFiles: kernel.settings.get(windowId, 'search.useIgnoreFiles'),
      followSymlinks: kernel.settings.get(windowId, 'search.followSymlinks'),
    };
    return { kind, root, realRoot, matcher: compileQuery(query), filters, replacement };
  }

  function stop(windowId: number): void {
    const current = running.get(windowId);
    if (!current) return;
    running.delete(windowId);
    current.job.cancel();
  }

  kernel.handle('search:start', ({ windowId }, rawQuery) => {
    const query = assertQuery(rawQuery);
    const spec = specFor(windowId, query, 'search', '');
    stop(windowId);
    const searchId = ++nextJobId;
    const limit = Math.min(
      Math.max(
        1,
        Math.floor(query.maxResults ?? kernel.settings.get(windowId, 'search.maxResults')),
      ),
      HARD_MAX_RESULTS,
    );
    const job = new SearchJob(
      searchId,
      spec,
      pool,
      {
        results: (files) => kernel.send(windowId, 'search:results', { searchId, files }),
        done: (stats) => {
          if (running.get(windowId)?.searchId === searchId) running.delete(windowId);
          kernel.send(windowId, 'search:done', { searchId, stats });
        },
      },
      { maxResults: Number.isFinite(limit) ? limit : DEFAULT_MAX_RESULTS },
    );
    running.set(windowId, { searchId, job });
    // Start after the id has been returned, so no event can reach the renderer before it knows the id.
    setImmediate(() => job.start());
    return { searchId };
  });

  kernel.handle('search:cancel', ({ windowId }, searchId) => {
    const current = running.get(windowId);
    if (current && current.searchId === searchId) {
      current.job.cancel();
    }
  });

  kernel.handle('search:replace', async ({ windowId }, rawRequest): Promise<ReplaceResult> => {
    const request = rawRequest as ReplaceRequest;
    if (!request || typeof request.replacement !== 'string' || !Array.isArray(request.files)) {
      throw new IncError('E_INVALID', 'The replace request is not valid.');
    }
    if (request.files.length > MAX_REPLACE_FILES) {
      throw new IncError('E_INVALID', 'Too many files to replace in at once.');
    }
    const query = assertQuery(request.query);
    const spec = specFor(windowId, query, 'replace', request.replacement);
    const preSkipped: { path: string; reason: string }[] = [];
    const files: { path: string; expectedMtimeMs?: number }[] = [];
    const seen = new Set<string>();
    for (const item of request.files) {
      const file = item && typeof item.path === 'string' ? item.path : '';
      if (!path.isAbsolute(file) || file.includes('\0')) {
        preSkipped.push({ path: file, reason: 'The path is not valid.' });
      } else if (!isWithin(spec.root, file, platform)) {
        preSkipped.push({ path: file, reason: 'The file is outside the workspace folder.' });
      } else if (!seen.has(file)) {
        seen.add(file);
        files.push({
          path: file,
          expectedMtimeMs:
            typeof item.expectedMtimeMs === 'number' ? item.expectedMtimeMs : undefined,
        });
      }
    }
    const job = new ReplaceJob(++nextJobId, spec, pool, files, preSkipped);
    return job.run();
  });

  const subscriptions = [
    kernel.onWindowClosed((windowId) => stop(windowId)),
    kernel.workspaces.onDidChangeRoot(({ windowId }) => stop(windowId)),
  ];

  return () => {
    for (const off of subscriptions) off();
    for (const windowId of [...running.keys()]) stop(windowId);
    pool.dispose();
  };
}
