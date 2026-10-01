/**
 * Coordinators for one search or one replace. A job hands the worker pool its next unit of work on
 * demand, collects what the workers send back, and decides when it is finished. Search jobs walk
 * the workspace folder by folder (breadth first, so shallow matches stream first) and search files
 * in small batches; replace jobs split the requested files into batches.
 */
import { performance } from 'node:perf_hooks';
import type { FileMatches, ReplaceResult, SearchSkipped, SearchStats } from '@shared/api/search';
import type { PoolJob, TaskResult, WorkerPool } from './pool';
import {
  CONTROL_CANCELLED,
  type DirTask,
  type FileOutcome,
  type FilesTask,
  type IgnoreSource,
  type JobSpec,
  type ReplaceTask,
  type WorkerReply,
  type WorkerTask,
} from './protocol';

/** Files searched per worker task. Small enough to keep results flowing and cancellation prompt. */
const FILES_PER_TASK = 48;
const REPLACE_FILES_PER_TASK = 16;
const FLUSH_INTERVAL_MS = 50;

type PoolHandle = Pick<WorkerPool, 'attach' | 'detach'>;

export interface SearchSink {
  results(files: FileMatches[]): void;
  done(stats: SearchStats): void;
}

export interface SearchJobOptions {
  maxResults: number;
}

function joinRel(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
}

/** One text search. Create it, call `start()`, and `cancel()` to stop early. */
export class SearchJob implements PoolJob {
  readonly control = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  private readonly flag = new Int32Array(this.control);
  private readonly dirTasks: DirTask[] = [];
  private readonly fileTasks: FilesTask[] = [];
  private readonly streamed = new Set<string>();
  private readonly skipped: SearchSkipped = { binary: 0, large: 0, unreadable: 0, timedOut: 0 };
  private pending: FileMatches[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private inFlight = 0;
  private nextSourceId = 1;
  private searched = 0;
  private matched = 0;
  private matchCount = 0;
  private limitHit = false;
  private userCancelled = false;
  private error: string | undefined;
  private finished = false;
  private readonly startedAt = performance.now();
  cancelledAt: number | null = null;

  constructor(
    readonly id: number,
    readonly spec: JobSpec,
    private readonly pool: PoolHandle,
    private readonly sink: SearchSink,
    private readonly options: SearchJobOptions,
  ) {}

  start(): void {
    if (this.finished || this.cancelledAt !== null) return;
    const root: DirTask = { kind: 'dir', dir: '', chain: [] };
    if (this.spec.filters.followSymlinks) {
      root.real = this.spec.realRoot;
      root.ancestors = [this.spec.realRoot];
    }
    this.dirTasks.push(root);
    this.pool.attach(this);
  }

  /** Stop as soon as possible. The job still reports what it found so far. */
  cancel(): void {
    this.userCancelled = true;
    this.halt();
  }

  nextTask(): WorkerTask | undefined {
    if (this.finished || this.cancelledAt !== null) return undefined;
    const task = this.fileTasks.shift() ?? this.dirTasks.shift();
    if (task) this.inFlight++;
    return task;
  }

  onProgress(reply: Extract<WorkerReply, { type: 'matches' | 'outcomes' }>): void {
    if (reply.type !== 'matches' || this.finished) return;
    for (const entry of reply.files) {
      if (this.streamed.has(entry.relativePath)) continue;
      const remaining = this.options.maxResults - this.matchCount;
      if (remaining <= 0) {
        this.limitHit = true;
        break;
      }
      let accepted = entry;
      if (entry.matches.length > remaining) {
        this.limitHit = true;
        accepted = { ...entry, matches: entry.matches.slice(0, remaining), truncated: true };
      }
      this.streamed.add(entry.relativePath);
      this.matched++;
      this.matchCount += accepted.matches.length;
      this.pending.push(accepted);
    }
    this.scheduleFlush();
    if (this.limitHit) this.halt();
  }

  onTaskDone(task: WorkerTask, result: TaskResult): void {
    this.inFlight--;
    if (this.finished) return;
    if (!result.ok) {
      this.onTaskLost(task, result);
    } else if (result.reply.type === 'dir-done' && task.kind === 'dir') {
      this.onDirDone(task, result.reply);
    } else if (result.reply.type === 'files-done') {
      this.searched += result.reply.searched;
      this.skipped.binary += result.reply.binary;
      this.skipped.large += result.reply.large;
      this.skipped.unreadable += result.reply.unreadable;
    } else if (result.reply.type === 'task-failed') {
      this.skipped.unreadable++;
    }
    this.maybeFinish();
  }

  onPoolFailure(message: string): void {
    this.error = message;
    this.queuesClear();
    this.inFlight = 0;
    this.finish();
  }

  // --- internals --------------------------------------------------------------------------

  private onDirDone(task: DirTask, reply: Extract<WorkerReply, { type: 'dir-done' }>): void {
    if (this.cancelledAt !== null) return;
    this.skipped.unreadable += reply.unreadable;
    let chain = task.chain;
    if (reply.ownSource !== null) {
      const source: IgnoreSource = {
        id: this.nextSourceId++,
        base: task.dir,
        text: reply.ownSource,
      };
      chain = [...task.chain, source];
    }
    for (const sub of reply.subdirs) {
      const child: DirTask = { kind: 'dir', dir: joinRel(task.dir, sub.name), chain };
      if (this.spec.filters.followSymlinks && sub.real !== undefined) {
        child.real = sub.real;
        child.ancestors = [...(task.ancestors ?? []), sub.real];
      }
      this.dirTasks.push(child);
    }
    for (let i = 0; i < reply.files.length; i += FILES_PER_TASK) {
      const files = reply.files.slice(i, i + FILES_PER_TASK).map((name) => joinRel(task.dir, name));
      this.fileTasks.push({ kind: 'files', files });
    }
  }

  /** A worker was terminated or died mid-task: keep the work that did not cause the failure. */
  private onTaskLost(task: WorkerTask, result: Extract<TaskResult, { ok: false }>): void {
    if (result.reason === 'cancelled' || this.cancelledAt !== null) return;
    if (task.kind === 'files') {
      const culprit = Math.min(result.item, task.files.length - 1);
      if (result.reason === 'timeout') this.skipped.timedOut++;
      else this.skipped.unreadable++;
      const retry = task.files.filter(
        (file, index) => index !== culprit && !this.streamed.has(file),
      );
      if (retry.length > 0) this.fileTasks.unshift({ kind: 'files', files: retry });
    } else if (task.kind === 'dir') {
      this.skipped.unreadable++;
    }
  }

  private maybeFinish(): void {
    if (this.finished) return;
    const idle = this.inFlight <= 0;
    if (this.cancelledAt !== null) {
      if (idle) this.finish();
      return;
    }
    if (idle && this.dirTasks.length === 0 && this.fileTasks.length === 0) this.finish();
  }

  /** Stop scheduling and tell workers to stop, then finish once nothing is running. */
  private halt(): void {
    if (this.finished || this.cancelledAt !== null) return;
    this.cancelledAt = performance.now();
    Atomics.store(this.flag, CONTROL_CANCELLED, 1);
    this.queuesClear();
    this.maybeFinish();
  }

  private queuesClear(): void {
    this.dirTasks.length = 0;
    this.fileTasks.length = 0;
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.pending.length === 0) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, FLUSH_INTERVAL_MS);
  }

  private flush(): void {
    if (this.pending.length === 0) return;
    const files = this.pending;
    this.pending = [];
    this.sink.results(files);
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.flush();
    this.pool.detach(this);
    const stats: SearchStats = {
      filesSearched: this.searched,
      filesMatched: this.matched,
      matchCount: this.matchCount,
      limitHit: this.limitHit,
      cancelled: this.userCancelled && !this.limitHit,
      durationMs: Math.round(performance.now() - this.startedAt),
    };
    if (this.error) stats.error = this.error;
    const s = this.skipped;
    if (s.binary + s.large + s.unreadable + s.timedOut > 0) stats.filesSkipped = { ...s };
    this.sink.done(stats);
  }
}

/** One replace across a list of files. `run()` resolves when every file has an outcome. */
export class ReplaceJob implements PoolJob {
  readonly control = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  cancelledAt: number | null = null;
  private readonly tasks: ReplaceTask[] = [];
  private readonly outcomes = new Map<string, FileOutcome>();
  private inFlight = 0;
  private finished = false;
  private failure: string | null = null;
  private resolve!: (result: ReplaceResult) => void;

  constructor(
    readonly id: number,
    readonly spec: JobSpec,
    private readonly pool: PoolHandle,
    private readonly files: { path: string; expectedMtimeMs?: number }[],
    private readonly preSkipped: { path: string; reason: string }[],
  ) {
    for (let i = 0; i < files.length; i += REPLACE_FILES_PER_TASK) {
      this.tasks.push({ kind: 'replace', files: files.slice(i, i + REPLACE_FILES_PER_TASK) });
    }
  }

  run(): Promise<ReplaceResult> {
    return new Promise<ReplaceResult>((resolve) => {
      this.resolve = resolve;
      if (this.tasks.length === 0) return this.finish();
      this.pool.attach(this);
    });
  }

  nextTask(): WorkerTask | undefined {
    if (this.finished) return undefined;
    const task = this.tasks.shift();
    if (task) this.inFlight++;
    return task;
  }

  onProgress(reply: Extract<WorkerReply, { type: 'matches' | 'outcomes' }>): void {
    if (reply.type !== 'outcomes') return;
    for (const outcome of reply.results) this.outcomes.set(outcome.path, outcome);
  }

  onTaskDone(task: WorkerTask, result: TaskResult): void {
    this.inFlight--;
    if (this.finished) return;
    if (task.kind === 'replace') {
      if (!result.ok) {
        const reason =
          result.reason === 'timeout' ? 'Replacing took too long.' : 'Replacing failed.';
        const remaining = task.files.filter((f) => !this.outcomes.has(f.path));
        const culprit = remaining[0];
        if (culprit)
          this.outcomes.set(culprit.path, { path: culprit.path, replacements: 0, skipped: reason });
        const rest = remaining.slice(1);
        if (rest.length > 0) this.tasks.unshift({ kind: 'replace', files: rest });
      } else if (result.reply.type === 'task-failed') {
        for (const f of task.files) {
          if (!this.outcomes.has(f.path)) {
            this.outcomes.set(f.path, {
              path: f.path,
              replacements: 0,
              skipped: result.reply.message,
            });
          }
        }
      }
    }
    if (this.inFlight <= 0 && this.tasks.length === 0) this.finish();
  }

  onPoolFailure(message: string): void {
    this.failure = message;
    this.tasks.length = 0;
    this.inFlight = 0;
    this.finish();
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.pool.detach(this);
    const skipped = [...this.preSkipped];
    let filesChanged = 0;
    let replacements = 0;
    for (const file of this.files) {
      const outcome = this.outcomes.get(file.path);
      if (!outcome) {
        skipped.push({ path: file.path, reason: this.failure ?? 'The file was not processed.' });
      } else if (outcome.skipped) {
        skipped.push({ path: file.path, reason: outcome.skipped });
      } else if (outcome.replacements > 0) {
        filesChanged++;
        replacements += outcome.replacements;
      }
    }
    this.resolve({ filesChanged, replacements, skipped });
  }
}
