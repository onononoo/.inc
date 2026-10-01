/**
 * A pool of worker threads shared by every search and replace job in the app.
 *
 * Scheduling is pull-based: whenever a worker is idle the pool asks the attached jobs, in turn,
 * for their next task, so a huge search in one window cannot starve another window and no job
 * ever queues more work than the workers can take.
 *
 * Safety nets:
 *  - a watchdog terminates a worker whose heartbeat stops (a catastrophic regular expression or
 *    a stalled file system) and tells the job which item it was working on;
 *  - a cancelled job gets a short grace period, after which a worker still busy for it is
 *    terminated, so cancelling is always prompt;
 *  - workers that keep dying without completing a task fail the jobs instead of respawning forever;
 *  - idle workers are released after a while.
 */
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import {
  PROGRESS_HEARTBEAT,
  PROGRESS_ITEM,
  PROGRESS_SLOTS,
  type JobSpec,
  type MainMessage,
  type TerminalReply,
  type WorkerData,
  type WorkerReply,
  type WorkerTask,
} from './protocol';

export type TaskResult =
  | { ok: true; reply: TerminalReply }
  /** The worker was terminated or died while running the task; `item` is the index it had reached. */
  | { ok: false; reason: 'timeout' | 'crash' | 'cancelled'; item: number };

export interface PoolJob {
  readonly id: number;
  readonly spec: JobSpec;
  readonly control: SharedArrayBuffer;
  /** `performance.now()` at the moment the job was cancelled, or null while it runs. */
  readonly cancelledAt: number | null;
  /** The next unit of work, or undefined when nothing is ready right now. */
  nextTask(): WorkerTask | undefined;
  /** Streamed partial results of a running task. */
  onProgress(reply: Extract<WorkerReply, { type: 'matches' | 'outcomes' }>): void;
  onTaskDone(task: WorkerTask, result: TaskResult): void;
  /** The pool cannot run workers at all; the job must end. */
  onPoolFailure(message: string): void;
}

export interface PoolLogger {
  debug(message: string, ...meta: unknown[]): void;
  warn(message: string, ...meta: unknown[]): void;
}

export interface PoolOptions {
  size: number;
  workerPath: string;
  /** A busy worker whose heartbeat has not moved for this long is terminated. */
  watchdogMs: number;
  /** How long a worker may keep running a cancelled job's task before it is terminated. */
  cancelGraceMs: number;
  /** Idle workers are terminated after this long. */
  idleMs: number;
  logger: PoolLogger;
}

interface Running {
  job: PoolJob;
  task: WorkerTask;
  lastBeat: number;
  lastChange: number;
}

interface Slot {
  worker: Worker;
  progress: Int32Array;
  current: Running | null;
  dead: boolean;
  /** Jobs this worker knows, with the ignore sources it already holds for each. */
  announced: Map<number, Set<number>>;
}

/** Consecutive worker deaths, without a completed task in between, after which jobs fail. */
const MAX_CONSECUTIVE_CRASHES = 4;

export class WorkerPool {
  private slots: Slot[] = [];
  private jobs: PoolJob[] = [];
  private cursor = 0;
  private pumping = false;
  private repump = false;
  private watchdog: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private crashes = 0;
  private disposed = false;

  constructor(private readonly options: PoolOptions) {}

  /** Number of live worker threads (for diagnostics and tests). */
  get workerCount(): number {
    return this.slots.length;
  }

  attach(job: PoolJob): void {
    if (this.disposed || this.jobs.includes(job)) return;
    this.jobs.push(job);
    this.clearIdleTimer();
    this.pump();
  }

  /** Remove a finished or cancelled job. Workers drop what they hold for it after their current task. */
  detach(job: PoolJob): void {
    const index = this.jobs.indexOf(job);
    if (index === -1) return;
    this.jobs.splice(index, 1);
    for (const slot of this.slots) {
      if (slot.announced.delete(job.id)) {
        slot.worker.postMessage({ type: 'end', jobId: job.id } satisfies MainMessage);
      }
    }
    this.updateTimers();
  }

  dispose(): void {
    this.disposed = true;
    this.terminateAll();
    this.jobs = [];
    this.stopWatchdog();
    this.clearIdleTimer();
  }

  // --- Scheduling -------------------------------------------------------------------------

  private pump(): void {
    if (this.pumping) {
      this.repump = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.repump = false;
        if (this.disposed) return;
        if (this.jobs.length > 0) {
          while (this.slots.length < this.options.size && !this.disposed) {
            if (!this.spawn()) return;
          }
        }
        for (const slot of this.slots) {
          if (slot.current || slot.dead) continue;
          const next = this.takeTask();
          if (!next) break;
          this.dispatch(slot, next.job, next.task);
        }
      } while (this.repump);
    } finally {
      this.pumping = false;
      this.updateTimers();
    }
  }

  private takeTask(): { job: PoolJob; task: WorkerTask } | undefined {
    const count = this.jobs.length;
    for (let k = 0; k < count; k++) {
      const index = (this.cursor + k) % count;
      const job = this.jobs[index] as PoolJob;
      const task = job.nextTask();
      if (task) {
        this.cursor = (index + 1) % count;
        return { job, task };
      }
    }
    return undefined;
  }

  private dispatch(slot: Slot, job: PoolJob, task: WorkerTask): void {
    let known = slot.announced.get(job.id);
    if (!known) {
      known = new Set();
      slot.announced.set(job.id, known);
      slot.worker.postMessage({
        type: 'begin',
        jobId: job.id,
        spec: job.spec,
        control: job.control,
      } satisfies MainMessage);
    }
    let outgoing = task;
    if (task.kind === 'dir') {
      const seen = known;
      outgoing = {
        ...task,
        chain: task.chain.map((source) => {
          if (seen.has(source.id)) return { id: source.id, base: source.base };
          seen.add(source.id);
          return source;
        }),
      };
    }
    Atomics.store(slot.progress, PROGRESS_ITEM, 0);
    const now = performance.now();
    slot.current = {
      job,
      task,
      lastBeat: Atomics.load(slot.progress, PROGRESS_HEARTBEAT),
      lastChange: now,
    };
    slot.worker.postMessage({ type: 'task', jobId: job.id, task: outgoing } satisfies MainMessage);
  }

  // --- Workers ----------------------------------------------------------------------------

  private spawn(): boolean {
    const progress = new SharedArrayBuffer(PROGRESS_SLOTS * Int32Array.BYTES_PER_ELEMENT);
    let worker: Worker;
    try {
      worker = new Worker(this.options.workerPath, {
        workerData: { progress } satisfies WorkerData,
      });
    } catch (error) {
      this.failAll(`The search workers could not be started: ${describe(error)}`);
      return false;
    }
    const slot: Slot = {
      worker,
      progress: new Int32Array(progress),
      current: null,
      dead: false,
      announced: new Map(),
    };
    worker.on('message', (reply: WorkerReply) => this.onMessage(slot, reply));
    worker.on('error', (error) => this.onDeath(slot, describe(error)));
    worker.on('exit', (code) => this.onDeath(slot, `The worker exited with code ${code}.`));
    this.slots.push(slot);
    return true;
  }

  private onMessage(slot: Slot, reply: WorkerReply): void {
    const running = slot.current;
    if (slot.dead || !running) return;
    if (reply.type === 'matches' || reply.type === 'outcomes') {
      running.job.onProgress(reply);
      return;
    }
    slot.current = null;
    this.crashes = 0;
    running.job.onTaskDone(running.task, { ok: true, reply });
    this.pump();
  }

  private onDeath(slot: Slot, message: string): void {
    if (slot.dead) return;
    slot.dead = true;
    this.slots = this.slots.filter((s) => s !== slot);
    if (this.disposed) return;
    const running = slot.current;
    slot.current = null;
    this.crashes++;
    this.options.logger.warn(`Search worker died: ${message}`);
    if (this.crashes >= MAX_CONSECUTIVE_CRASHES) {
      this.failAll(`The search workers keep stopping unexpectedly: ${message}`);
      return;
    }
    if (running) {
      const item = Atomics.load(slot.progress, PROGRESS_ITEM);
      running.job.onTaskDone(running.task, { ok: false, reason: 'crash', item });
    }
    this.pump();
  }

  private kill(slot: Slot, reason: 'timeout' | 'cancelled'): void {
    const running = slot.current;
    slot.dead = true;
    slot.current = null;
    this.slots = this.slots.filter((s) => s !== slot);
    this.options.logger.debug(`Terminating a search worker (${reason})`);
    slot.worker.terminate().catch(() => undefined);
    if (running) {
      const item = Atomics.load(slot.progress, PROGRESS_ITEM);
      running.job.onTaskDone(running.task, { ok: false, reason, item });
    }
    this.pump();
  }

  private failAll(message: string): void {
    this.crashes = 0;
    this.options.logger.warn(message);
    this.terminateAll();
    for (const job of [...this.jobs]) job.onPoolFailure(message);
  }

  private terminateAll(): void {
    const slots = this.slots;
    this.slots = [];
    for (const slot of slots) {
      slot.dead = true;
      slot.current = null;
      slot.worker.terminate().catch(() => undefined);
    }
  }

  // --- Timers -----------------------------------------------------------------------------

  private updateTimers(): void {
    const busy = this.slots.some((s) => s.current);
    if (busy) this.startWatchdog();
    else this.stopWatchdog();
    if (!busy && this.jobs.length === 0 && this.slots.length > 0) this.startIdleTimer();
    else this.clearIdleTimer();
  }

  private startWatchdog(): void {
    if (this.watchdog) return;
    const period = Math.min(
      250,
      Math.max(20, Math.floor(Math.min(this.options.watchdogMs, this.options.cancelGraceMs) / 4)),
    );
    this.watchdog = setInterval(() => this.checkWorkers(), period);
    this.watchdog.unref();
  }

  private stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  private startIdleTimer(): void {
    if (this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.jobs.length === 0) this.terminateAll();
    }, this.options.idleMs);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private checkWorkers(): void {
    const now = performance.now();
    for (const slot of [...this.slots]) {
      const running = slot.current;
      if (!running) continue;
      const beat = Atomics.load(slot.progress, PROGRESS_HEARTBEAT);
      if (beat !== running.lastBeat) {
        running.lastBeat = beat;
        running.lastChange = now;
        continue;
      }
      const cancelledAt = running.job.cancelledAt;
      if (cancelledAt !== null) {
        if (now - Math.max(running.lastChange, cancelledAt) > this.options.cancelGraceMs) {
          this.kill(slot, 'cancelled');
        }
      } else if (now - running.lastChange > this.options.watchdogMs) {
        this.kill(slot, 'timeout');
      }
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
