import fs from 'node:fs';
import path from 'node:path';
import {
  GIT_BLOB_LIMIT_BYTES,
  GIT_STATUS_FILE_LIMIT,
  type GitAvailability,
  type GitBlob,
  type GitBranch,
  type GitCommitInfo,
  type GitStatus,
} from '@shared/api/git';
import { IncError } from '@shared/errors';
import type { Platform } from '@shared/paths';
import type { Kernel } from '../kernel';
import { decodeBlobText, isBinaryContent } from './blob';
import { Coalescer } from './coalescer';
import { gitFailure } from './failure';
import { GitDirWatcher } from './git-watcher';
import { locateGit } from './locate';
import { chunkPathspecs, toRepoRelative, toRepoRelativeList } from './paths';
import { PorcelainStatusParser } from './porcelain';
import { GitRunner, type RunOptions, type RunResult } from './runner';
import { RefreshScheduler } from './scheduler';
import { buildStatus, statusSignature } from './status-model';

const NETWORK_TIMEOUT_MS = 5 * 60_000;
const AUTO_FETCH_INTERVAL_MS = 5 * 60_000;
const STATUS_TIMEOUT_MS = 120_000;
const LITERAL_PATHSPECS = { GIT_LITERAL_PATHSPECS: '1' };
const FIELD = '\u001f';
const RECORD = '\u001e';

interface RepoLocation {
  root: string;
  gitDir: string;
  commonDir: string;
}

/** Resolves the Git executable per configured path, once, until settings change. */
export class GitLocator {
  private readonly cache = new Map<string, Promise<GitAvailability>>();

  find(configured: string): Promise<GitAvailability> {
    let result = this.cache.get(configured);
    if (!result) {
      result = locateGit(configured);
      this.cache.set(configured, result);
    }
    return result;
  }

  clear(): void {
    this.cache.clear();
  }
}

function requireText(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new IncError('E_INVALID', `Enter ${what}.`);
  }
  return value;
}

function validateRefName(value: unknown, what: string): string {
  const name = requireText(value, what).trim();
  if (name.startsWith('-') || /[\0\r\n]/.test(name) || name.length > 255) {
    throw new IncError('E_INVALID', `"${name.slice(0, 60)}" is not a valid ${what}.`);
  }
  return name;
}

function missing(): IncError {
  return new IncError(
    'E_GIT_MISSING',
    'Git was not found. Install Git or set its path in settings.',
  );
}

/**
 * Git for one window: finds the repository around the workspace folder, keeps a cached, coalesced
 * status that refreshes itself (and backs off on slow repositories), and runs every operation
 * through an argument-array runner. In an untrusted workspace only read operations run, with
 * repository configuration prevented from executing code.
 */
export class GitSession {
  private readonly runner: GitRunner;
  private readonly scheduler: RefreshScheduler;
  private readonly statusJob: Coalescer<GitStatus | null>;
  private readonly platform: Platform;
  private repo: Promise<RepoLocation | null> | null = null;
  private watcher: GitDirWatcher | null = null;
  private lastStatus: GitStatus | null | undefined;
  private lastSignature = '';
  private autoFetchTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(
    private readonly kernel: Kernel,
    private readonly windowId: number,
    private readonly locator: GitLocator,
    private readonly hooksDir: () => string,
  ) {
    this.platform = kernel.info.platform as Platform;
    this.runner = new GitRunner({ hooksDir, logger: kernel.logger });
    this.scheduler = new RefreshScheduler({ run: () => void this.autoRefresh() });
    this.statusJob = new Coalescer((signal) => this.computeStatus(signal));
    this.syncAutoFetch();
  }

  // --- configuration ------------------------------------------------------------------------

  private get enabled(): boolean {
    return this.kernel.settings.get(this.windowId, 'git.enabled') !== false;
  }

  private get hardened(): boolean {
    return !this.kernel.workspaces.isTrusted(this.windowId);
  }

  private get workspaceRoot(): string | null {
    return this.kernel.workspaces.getRoot(this.windowId);
  }

  async detect(): Promise<GitAvailability> {
    if (!this.enabled)
      return { available: false, error: 'Git integration is turned off in settings.' };
    return this.locator.find(this.kernel.settings.get(this.windowId, 'git.path') ?? '');
  }

  private async gitPath(): Promise<string> {
    const found = await this.detect();
    if (!found.available || !found.path) {
      throw new IncError('E_GIT_MISSING', found.error ?? missing().message);
    }
    return found.path;
  }

  /** Called when settings, trust or the workspace change in a way that affects Git. */
  reset(): void {
    this.repo = null;
    this.watcher?.close();
    this.watcher = null;
    this.lastStatus = undefined;
    this.lastSignature = '';
    this.syncAutoFetch();
  }

  // --- running git --------------------------------------------------------------------------

  private async run(
    cwd: string,
    args: readonly string[],
    options: Partial<RunOptions> & { write?: boolean; allowFailure?: boolean } = {},
  ): Promise<RunResult> {
    const gitPath = await this.gitPath();
    const { write, allowFailure, ...rest } = options;
    const result = await this.runner.run({
      gitPath,
      cwd,
      args,
      mode: write ? 'write' : 'read',
      hardened: this.hardened,
      ...rest,
    });
    if (result.code !== 0 && !allowFailure) {
      throw gitFailure({
        code: result.code,
        stdout: result.stdout.toString('utf8'),
        stderr: result.stderr,
      });
    }
    return result;
  }

  private assertWritable(): void {
    if (!this.enabled) throw new IncError('E_GIT', 'Git integration is turned off in settings.');
    if (this.hardened) {
      throw new IncError(
        'E_UNTRUSTED',
        'This folder is in Restricted Mode, so Git changes are blocked. Trust the folder to stage, commit or switch branches.',
      );
    }
  }

  private assertRemoteAllowed(): void {
    this.assertWritable();
    if (this.kernel.policy.state.features.gitRemoteOperations === false) {
      throw new IncError(
        'E_POLICY',
        'Fetching, pulling and pushing are turned off by your organization.',
      );
    }
  }

  // --- repository ---------------------------------------------------------------------------

  private locate(): Promise<RepoLocation | null> {
    if (!this.repo) {
      this.repo = this.discover().catch((error) => {
        this.repo = null;
        throw error;
      });
    }
    return this.repo;
  }

  private async discover(): Promise<RepoLocation | null> {
    const cwd = this.workspaceRoot;
    if (!cwd || !this.enabled) return null;
    const result = await this.run(
      cwd,
      ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'],
      { allowFailure: true },
    );
    if (result.code !== 0) {
      if (/not a git repository/i.test(result.stderr)) return null;
      throw gitFailure({ code: result.code, stdout: '', stderr: result.stderr });
    }
    const lines = result.stdout.toString('utf8').split(/\r?\n/).filter(Boolean);
    const [top, gitDir, common] = lines;
    if (!top || !gitDir) return null;
    const location: RepoLocation = {
      root: path.normalize(top),
      gitDir: path.normalize(gitDir),
      commonDir: path.resolve(cwd, common ?? gitDir),
    };
    this.watcher?.close();
    this.watcher = new GitDirWatcher(
      location.gitDir,
      location.commonDir,
      () => this.scheduler.trigger(),
      this.kernel.logger,
    );
    return location;
  }

  private async requireRepo(): Promise<RepoLocation> {
    const repo = await this.locate();
    if (!repo) throw new IncError('E_GIT', 'This folder is not a Git repository.');
    return repo;
  }

  // --- status -------------------------------------------------------------------------------

  private async computeStatus(signal: AbortSignal): Promise<GitStatus | null> {
    const repo = await this.locate();
    if (!repo) return null;
    const parser = new PorcelainStatusParser(GIT_STATUS_FILE_LIMIT);
    const started = Date.now();
    await this.run(
      repo.root,
      ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=normal'],
      { signal, timeoutMs: STATUS_TIMEOUT_MS, onStdout: (chunk) => parser.push(chunk) },
    );
    const durationMs = Date.now() - started;
    this.scheduler.recordDuration(durationMs);
    return buildStatus(parser.finish(), repo.root, { refreshedAt: Date.now(), durationMs });
  }

  private publish(status: GitStatus | null): GitStatus | null {
    this.lastStatus = status;
    const signature = statusSignature(status);
    if (signature !== this.lastSignature) {
      this.lastSignature = signature;
      if (!this.disposed) this.kernel.send(this.windowId, 'git:statusChanged', status);
    }
    return status;
  }

  /** The cached status, computing it the first time. */
  async status(): Promise<GitStatus | null> {
    if (!this.enabled) return null;
    if (this.lastStatus !== undefined) return this.lastStatus;
    return this.publish(await this.statusJob.request());
  }

  /** Recompute now, superseding any refresh already running. */
  async refresh(): Promise<GitStatus | null> {
    if (!this.enabled) return this.publish(null);
    if (this.lastStatus === null) this.repo = null; // a repository may have been created meanwhile
    return this.publish(await this.statusJob.request({ supersede: true }));
  }

  private async autoRefresh(): Promise<void> {
    if (this.disposed) return;
    try {
      this.publish(await this.statusJob.request());
    } catch (error) {
      if (error instanceof IncError && error.code === 'E_CANCELLED') return;
      this.kernel.logger.warn('Git status refresh failed', error);
    }
  }

  /** Called with file system changes from the workspace watcher. */
  onFilesChanged(changes: readonly { path: string; type: string }[]): void {
    if (this.disposed || !this.enabled) return;
    if (this.kernel.settings.get(this.windowId, 'git.autoRefresh') === false) return;
    // Changes inside .git are covered by the Git directory watcher; the folder itself appearing
    // or disappearing means a repository was created or removed.
    for (const change of changes) {
      const parts = change.path.split(/[\\/]/);
      const gitAt = parts.lastIndexOf('.git');
      if (gitAt === -1) {
        this.scheduler.trigger();
        return;
      }
      if (gitAt === parts.length - 1 && change.type !== 'update') {
        this.repo = null;
        this.scheduler.trigger();
        return;
      }
    }
  }

  // --- reading ------------------------------------------------------------------------------

  async show(file: string, ref: 'HEAD' | 'INDEX'): Promise<GitBlob> {
    const repo = await this.requireRepo();
    const rel = toRepoRelative(file, { repoRoot: repo.root, platform: this.platform });
    const spec = ref === 'HEAD' ? `HEAD:${rel}` : `:0:${rel}`;
    const size = await this.run(repo.root, ['cat-file', '-s', spec], { allowFailure: true });
    if (size.code !== 0) return { exists: false, binary: false, content: '' };
    const bytes = Number.parseInt(size.stdout.toString('utf8').trim(), 10);
    if (Number.isFinite(bytes) && bytes > GIT_BLOB_LIMIT_BYTES) {
      return { exists: true, binary: false, content: '', size: bytes, tooLarge: true };
    }
    const blob = await this.run(repo.root, ['cat-file', 'blob', spec], {
      maxOutputBytes: GIT_BLOB_LIMIT_BYTES + 1024,
    });
    if (isBinaryContent(blob.stdout)) {
      return { exists: true, binary: true, content: '', size: blob.stdout.length };
    }
    return {
      exists: true,
      binary: false,
      content: decodeBlobText(blob.stdout),
      size: blob.stdout.length,
    };
  }

  async branches(): Promise<GitBranch[]> {
    const repo = await this.requireRepo();
    const format = ['%(refname)', '%(HEAD)', '%(upstream:short)', '%(objectname)'].join('%1f');
    const result = await this.run(repo.root, [
      'for-each-ref',
      `--format=${format}%1e`,
      'refs/heads',
      'refs/remotes',
    ]);
    const branches: GitBranch[] = [];
    for (const record of result.stdout.toString('utf8').split(RECORD)) {
      const [refname, head, upstream, sha] = record.replace(/^\r?\n/, '').split(FIELD);
      if (!refname) continue;
      const remote = refname.startsWith('refs/remotes/');
      const name = refname.replace(/^refs\/(heads|remotes)\//, '');
      if (remote && name.endsWith('/HEAD')) continue;
      const branch: GitBranch = { name, current: head === '*', remote, sha: sha ?? '' };
      if (upstream) branch.upstream = upstream;
      branches.push(branch);
    }
    return branches.sort(
      (a, b) =>
        Number(a.remote) - Number(b.remote) ||
        Number(b.current) - Number(a.current) ||
        a.name.localeCompare(b.name),
    );
  }

  async log(options: { path?: string; limit?: number } = {}): Promise<GitCommitInfo[]> {
    const repo = await this.requireRepo();
    const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 50), 1000));
    const args = ['log', `-n${limit}`, '--format=%H%x1f%h%x1f%an%x1f%at%x1f%s%x1e'];
    if (options.path !== undefined) {
      args.push(
        '--follow',
        '--',
        toRepoRelative(options.path, { repoRoot: repo.root, platform: this.platform }),
      );
    }
    const result = await this.run(repo.root, args, { allowFailure: true, env: LITERAL_PATHSPECS });
    if (result.code !== 0) {
      if (
        /does not have any commits yet|unknown revision|bad default revision/i.test(result.stderr)
      )
        return [];
      throw gitFailure({ code: result.code, stdout: '', stderr: result.stderr });
    }
    const commits: GitCommitInfo[] = [];
    for (const record of result.stdout.toString('utf8').split(RECORD)) {
      const [sha, shortSha, author, date, subject] = record.replace(/^\r?\n/, '').split(FIELD);
      if (!sha) continue;
      commits.push({
        sha,
        shortSha: shortSha ?? sha.slice(0, 7),
        author: author ?? '',
        date: Number(date) * 1000,
        subject: subject ?? '',
      });
    }
    return commits;
  }

  // --- changing -----------------------------------------------------------------------------

  private async pathspecs(inputs: unknown, repo: RepoLocation): Promise<string[]> {
    return toRepoRelativeList(inputs, { repoRoot: repo.root, platform: this.platform });
  }

  /** A fresh status for classifying paths: the cache can lag behind the disk. */
  private async freshStatus(): Promise<GitStatus | null> {
    return this.refresh();
  }

  private async mutate(work: (repo: RepoLocation) => Promise<void>): Promise<void> {
    this.assertWritable();
    const repo = await this.requireRepo();
    try {
      await work(repo);
    } finally {
      await this.refresh().catch(() => undefined);
    }
  }

  private async eachChunk(
    repo: RepoLocation,
    prefix: readonly string[],
    specs: readonly string[],
  ): Promise<void> {
    for (const chunk of chunkPathspecs(specs)) {
      await this.run(repo.root, [...prefix, '--', ...chunk], {
        write: true,
        env: LITERAL_PATHSPECS,
      });
    }
  }

  stage(paths: unknown): Promise<void> {
    return this.mutate(async (repo) => {
      const specs = await this.pathspecs(paths, repo);
      if (specs.length > 0) await this.eachChunk(repo, ['add', '--all'], specs);
    });
  }

  unstage(paths: unknown): Promise<void> {
    return this.mutate(async (repo) => {
      const requested = await this.pathspecs(paths, repo);
      if (requested.length === 0) return;
      const status = await this.freshStatus();
      const specs = new Set(requested);
      for (const entry of status?.files ?? []) {
        if (entry.origPath && specs.has(entry.relativePath)) {
          specs.add(path.relative(repo.root, entry.origPath).split(path.sep).join('/'));
        }
      }
      const prefix =
        (status?.repo.hasCommits ?? true)
          ? ['restore', '--staged']
          : ['rm', '--cached', '-r', '-q', '--ignore-unmatch'];
      await this.eachChunk(repo, prefix, [...specs]);
    });
  }

  discard(paths: unknown): Promise<void> {
    return this.mutate(async (repo) => {
      const requested = await this.pathspecs(paths, repo);
      if (requested.length === 0) return;
      const status = await this.freshStatus();
      const entries = new Map((status?.files ?? []).map((e) => [e.relativePath, e]));
      const restore: string[] = [];
      const remove: string[] = [];
      const clean: string[] = [];
      const unknown: string[] = [];
      for (const rel of requested) {
        const entry = entries.get(rel);
        if (!entry) {
          // Beyond the capped list we cannot classify the path: try both ways below.
          if (status?.truncated) unknown.push(rel);
          continue;
        }
        if (entry.workingTree === '?') {
          clean.push(rel);
        } else if (entry.index === 'A' || (entry.index === 'R' && entry.origPath)) {
          remove.push(rel);
          if (entry.origPath)
            restore.push(path.relative(repo.root, entry.origPath).split(path.sep).join('/'));
        } else {
          restore.push(rel);
        }
      }
      if (clean.length > 0) await this.eachChunk(repo, ['clean', '-f', '-d', '-q'], clean);
      if (remove.length > 0)
        await this.eachChunk(repo, ['rm', '-f', '-r', '-q', '--ignore-unmatch'], remove);
      if (restore.length > 0) {
        await this.eachChunk(repo, ['restore', '--source=HEAD', '--staged', '--worktree'], restore);
      }
      for (const rel of unknown) {
        const options = { write: true, allowFailure: true, env: LITERAL_PATHSPECS } as const;
        const restored = await this.run(
          repo.root,
          ['restore', '--source=HEAD', '--staged', '--worktree', '--', rel],
          options,
        );
        if (restored.code !== 0) {
          await this.run(repo.root, ['clean', '-f', '-d', '-q', '--', rel], options);
        }
      }
    });
  }

  stageAll(): Promise<void> {
    return this.mutate(async (repo) => {
      await this.run(repo.root, ['add', '--all'], { write: true });
    });
  }

  unstageAll(): Promise<void> {
    return this.mutate(async (repo) => {
      const status = await this.freshStatus();
      const args =
        (status?.repo.hasCommits ?? true)
          ? ['restore', '--staged', '--', '.']
          : ['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--', '.'];
      await this.run(repo.root, args, { write: true });
    });
  }

  async commit(request: { message: string; amend?: boolean }): Promise<{ sha: string }> {
    this.assertWritable();
    const amend = request?.amend === true;
    const message = typeof request?.message === 'string' ? request.message : '';
    if (!amend && message.trim() === '') {
      throw new IncError('E_INVALID', 'Enter a commit message.');
    }
    const repo = await this.requireRepo();
    try {
      const args = ['commit'];
      if (amend) args.push('--amend');
      if (message.trim() === '') args.push('--no-edit');
      else args.push('-F', '-');
      await this.run(repo.root, args, {
        write: true,
        input: message.trim() === '' ? undefined : message,
        timeoutMs: NETWORK_TIMEOUT_MS,
      });
      const head = await this.run(repo.root, ['rev-parse', 'HEAD']);
      return { sha: head.stdout.toString('utf8').trim() };
    } finally {
      await this.refresh().catch(() => undefined);
    }
  }

  checkout(ref: unknown): Promise<void> {
    const name = validateRefName(ref, 'branch or commit');
    return this.mutate(async (repo) => {
      const branches = await this.branches();
      const remote = branches.find((b) => b.remote && b.name === name);
      const slash = name.indexOf('/');
      const localName = slash === -1 ? name : name.slice(slash + 1);
      if (remote && !branches.some((b) => !b.remote && b.name === localName)) {
        await this.run(repo.root, ['checkout', '--track', name], { write: true });
      } else {
        await this.run(repo.root, ['checkout', name, '--'], { write: true });
      }
    });
  }

  createBranch(name: unknown, checkout = true): Promise<void> {
    const branch = validateRefName(name, 'branch name');
    return this.mutate(async (repo) => {
      const check = await this.run(repo.root, ['check-ref-format', '--branch', branch], {
        allowFailure: true,
      });
      if (check.code !== 0) {
        throw new IncError('E_INVALID', `"${branch}" is not a valid branch name.`);
      }
      const args = checkout ? ['checkout', '-b', branch] : ['branch', branch];
      await this.run(repo.root, args, { write: true });
    });
  }

  private async remote(command: 'fetch' | 'pull' | 'push'): Promise<void> {
    this.assertRemoteAllowed();
    const repo = await this.requireRepo();
    try {
      await this.run(repo.root, [command], { write: true, timeoutMs: NETWORK_TIMEOUT_MS });
    } finally {
      await this.refresh().catch(() => undefined);
    }
  }

  fetch(): Promise<void> {
    return this.remote('fetch');
  }

  pull(): Promise<void> {
    return this.remote('pull');
  }

  push(): Promise<void> {
    return this.remote('push');
  }

  async init(): Promise<GitStatus | null> {
    this.assertWritable();
    const cwd = this.workspaceRoot;
    if (!cwd) throw new IncError('E_NO_WORKSPACE', 'Open a folder first.');
    if (await this.locate()) return this.refresh();
    await this.run(cwd, ['init'], { write: true });
    this.repo = null;
    return this.refresh();
  }

  // --- automatic fetch ----------------------------------------------------------------------

  syncAutoFetch(): void {
    const wanted =
      this.kernel.settings.get(this.windowId, 'git.autoFetch') === true &&
      this.enabled &&
      !this.disposed;
    if (!wanted) {
      if (this.autoFetchTimer) clearInterval(this.autoFetchTimer);
      this.autoFetchTimer = null;
      return;
    }
    if (this.autoFetchTimer) return;
    this.autoFetchTimer = setInterval(() => {
      if (this.hardened || this.kernel.policy.state.features.gitRemoteOperations === false) return;
      if (!this.lastStatus?.repo.upstream) return;
      this.fetch().catch((error) => this.kernel.logger.debug('Automatic fetch failed', error));
    }, AUTO_FETCH_INTERVAL_MS);
    this.autoFetchTimer.unref();
  }

  dispose(): void {
    this.disposed = true;
    if (this.autoFetchTimer) clearInterval(this.autoFetchTimer);
    this.autoFetchTimer = null;
    this.scheduler.dispose();
    this.statusJob.dispose();
    this.watcher?.close();
    this.watcher = null;
    this.runner.dispose();
  }
}

/** A throwaway empty folder used as `core.hooksPath` for untrusted workspaces. */
export function createHooksDirProvider(baseDir: string): () => string {
  let created: string | null = null;
  return () => {
    if (created) return created;
    const dir = path.join(baseDir, 'git-no-hooks');
    fs.mkdirSync(dir, { recursive: true });
    created = dir;
    return dir;
  };
}
