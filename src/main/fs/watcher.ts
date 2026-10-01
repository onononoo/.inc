import parcel from '@parcel/watcher';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FsChange } from '@shared/api/fs';
import { IncError } from '@shared/errors';
import { isWithin, samePath, type Platform } from '@shared/paths';
import { ChangeBatcher } from './change-batcher';
import { errnoOf, fsError } from './errors';
import type { Logger } from '../kernel';

/** Folders that are never worth watching, whatever the settings say. */
export const ALWAYS_IGNORED = ['**/.git/objects/**'];

/** Delay before each attempt to watch a root that disappeared or could not be watched. */
const DEFAULT_RETRY_DELAYS_MS = [500, 1000, 2000, 5000, 15000];
const DEFAULT_HEALTH_CHECK_MS = 5000;
const MAX_EXTRA_WATCHES = 128;

let nextHandle = 1;

export interface WindowWatcherOptions {
  logger: Pick<Logger, 'debug' | 'info' | 'warn'>;
  /** Enabled `files.watcherExclude` globs. Read on every (re)subscription. */
  getIgnore: () => string[];
  /** Receives each batch of changes. */
  emit: (changes: FsChange[]) => void;
  platform: Platform;
  windowMs?: number;
  stormThreshold?: number;
  retryDelaysMs?: readonly number[];
  healthCheckMs?: number;
}

interface WatchSpec {
  dir: string;
  /** Only direct children (and the folder itself) are of interest. */
  shallow: boolean;
  /** Only changes to this entry name are of interest (watching a single file). */
  onlyName: string | null;
}

interface ActiveWatch {
  spec: WatchSpec;
  realDir: string;
  subscription: parcel.AsyncSubscription;
  ignoreKey: string;
}

/**
 * File watching for one window: the workspace root plus any extra paths the renderer asked for,
 * all feeding one batcher. Survives the root disappearing (it keeps retrying and reports a resync
 * when the folder is back), watcher errors, and rapid workspace switches (operations are serialised
 * and stale ones abandon their work).
 */
export class WindowWatcher {
  private readonly batcher: ChangeBatcher;
  private readonly retryDelays: readonly number[];
  private readonly healthCheckMs: number;
  private chain: Promise<void> = Promise.resolve();
  private generation = 0;
  private disposed = false;
  private root: string | null = null;
  private rootWatch: ActiveWatch | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryAttempt = 0;
  private healthTimer: NodeJS.Timeout | null = null;
  private readonly extras = new Map<number, ActiveWatch>();

  constructor(private readonly options: WindowWatcherOptions) {
    this.retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.healthCheckMs = options.healthCheckMs ?? DEFAULT_HEALTH_CHECK_MS;
    this.batcher = new ChangeBatcher({
      windowMs: options.windowMs,
      stormThreshold: options.stormThreshold,
      resyncPath: () => this.root ?? path.parse(process.cwd()).root,
      onFlush: (changes) => {
        try {
          options.emit(changes);
        } catch (error) {
          options.logger.warn('A file change listener failed', error);
        }
      },
    });
  }

  /** Root currently being watched (or retried), or null. */
  get currentRoot(): string | null {
    return this.root;
  }

  /** Emit pending changes immediately. */
  flush(): void {
    this.batcher.flush();
  }

  /** Watch a different workspace root, or none. Resolves once the new watcher is running. */
  setRoot(root: string | null): Promise<void> {
    const generation = ++this.generation;
    this.root = root;
    this.stopRetryAndHealth();
    this.retryAttempt = 0;
    return this.enqueue(async () => {
      await this.stopRoot();
      if (generation !== this.generation || this.disposed || !root) return;
      await this.startRoot(root, generation);
    });
  }

  /** Re-subscribe watchers whose exclude globs changed. */
  refreshIgnore(): Promise<void> {
    const generation = this.generation;
    return this.enqueue(async () => {
      if (this.disposed || generation !== this.generation) return;
      const key = this.ignoreList().join('\n');
      if (this.root && this.rootWatch && this.rootWatch.ignoreKey !== key) {
        await this.stopRoot();
        await this.startRoot(this.root, generation);
        this.batcher.requestResync();
      }
      for (const [handle, watch] of [...this.extras]) {
        if (watch.ignoreKey === key) continue;
        await this.closeSubscription(watch);
        const reopened = await this.open(watch.spec, handle);
        if (reopened) this.extras.set(handle, reopened);
        else this.extras.delete(handle);
      }
    });
  }

  /** Watch an additional file or folder. Returns a handle for `unwatch`. */
  async watchExtra(target: string, recursive: boolean): Promise<number> {
    if (this.disposed) throw new IncError('E_CANCELLED', 'The window is closing.');
    if (this.extras.size >= MAX_EXTRA_WATCHES) {
      throw new IncError(
        'E_INVALID',
        'Too many paths are being watched. Stop watching some first.',
      );
    }
    let info;
    try {
      info = await fsp.stat(target);
    } catch (error) {
      throw fsError(error, 'watch', target);
    }
    const isFolder = info.isDirectory();
    const spec: WatchSpec = isFolder
      ? { dir: target, shallow: !recursive, onlyName: null }
      : { dir: path.dirname(target), shallow: true, onlyName: path.basename(target) };
    const handle = nextHandle++;
    // Reserve the slot so the limit holds while the subscription is being created.
    let created: ActiveWatch | null = null;
    await this.enqueue(async () => {
      if (this.disposed) return;
      created = await this.open(spec, handle);
      if (created) this.extras.set(handle, created);
    });
    if (!created) {
      throw new IncError(
        'E_IO',
        `Could not watch "${path.basename(target) || target}" for changes.`,
        {
          path: target,
        },
      );
    }
    return handle;
  }

  /** Stop an extra watch. Unknown handles are ignored. */
  unwatch(handle: number): Promise<void> {
    return this.enqueue(async () => {
      const watch = this.extras.get(handle);
      if (!watch) return;
      this.extras.delete(handle);
      await this.closeSubscription(watch);
    });
  }

  /** Stop everything. The watcher cannot be used afterwards. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.generation++;
    this.root = null;
    this.stopRetryAndHealth();
    this.batcher.dispose();
    await this.enqueue(async () => {
      await this.stopRoot();
      for (const watch of [...this.extras.values()]) await this.closeSubscription(watch);
      this.extras.clear();
    });
  }

  // --- internals -----------------------------------------------------------------------------

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.chain.then(task).catch((error: unknown) => {
      this.options.logger.warn('File watcher operation failed', error);
    });
    this.chain = run;
    return run;
  }

  private ignoreList(): string[] {
    return [...new Set([...ALWAYS_IGNORED, ...this.options.getIgnore()])];
  }

  private async open(spec: WatchSpec, handle: number | 'root'): Promise<ActiveWatch | null> {
    const base = this.ignoreList();
    const ignore = spec.shallow ? [...base, '*/**'] : base;
    let realDir = spec.dir;
    try {
      realDir = await fsp.realpath(spec.dir);
    } catch {
      /* subscribing reports the real problem */
    }
    const isRoot = handle === 'root';
    const generation = this.generation;
    const onEvents = (error: Error | null, events: parcel.Event[]) => {
      if (this.disposed || (isRoot && generation !== this.generation)) return;
      if (error) {
        this.options.logger.warn(`File watcher error for ${spec.dir}: ${error.message}`);
        if (isRoot) this.rootLost(generation);
        else void this.dropExtra(handle);
        return;
      }
      this.onEvents(spec, realDir, events, isRoot ? generation : null);
    };
    const attempt = async (globs: string[]): Promise<parcel.AsyncSubscription> =>
      parcel.subscribe(spec.dir, onEvents, { ignore: globs });
    try {
      let subscription: parcel.AsyncSubscription;
      try {
        subscription = await attempt(ignore);
      } catch (error) {
        if (errnoOf(error) === 'ENOENT') throw error;
        // A malformed exclude glob must not leave the folder unwatched.
        this.options.logger.warn(`Watching ${spec.dir} with the default excludes only`, error);
        subscription = await attempt(spec.shallow ? [...ALWAYS_IGNORED, '*/**'] : ALWAYS_IGNORED);
      }
      return { spec, realDir, subscription, ignoreKey: base.join('\n') };
    } catch (error) {
      this.options.logger.warn(`Could not watch ${spec.dir}`, error);
      return null;
    }
  }

  private async dropExtra(handle: number | 'root'): Promise<void> {
    if (handle === 'root') return;
    await this.enqueue(async () => {
      const watch = this.extras.get(handle);
      if (!watch) return;
      this.extras.delete(handle);
      await this.closeSubscription(watch);
    });
  }

  private async closeSubscription(watch: ActiveWatch): Promise<void> {
    try {
      await watch.subscription.unsubscribe();
    } catch (error) {
      // The watched folder may already be gone; the subscription is dead either way.
      this.options.logger.debug(`Unsubscribing ${watch.spec.dir} failed: ${String(error)}`);
    }
  }

  private async startRoot(root: string, generation: number): Promise<void> {
    const watch = await this.open({ dir: root, shallow: false, onlyName: null }, 'root');
    if (!watch) {
      if (generation === this.generation && !this.disposed) this.scheduleRetry(generation);
      return;
    }
    if (generation !== this.generation || this.disposed) {
      await this.closeSubscription(watch);
      return;
    }
    this.rootWatch = watch;
    this.retryAttempt = 0;
    this.startHealthCheck(root, generation);
  }

  private async stopRoot(): Promise<void> {
    const watch = this.rootWatch;
    this.rootWatch = null;
    if (watch) await this.closeSubscription(watch);
  }

  private rootLost(generation: number): void {
    if (generation !== this.generation || this.disposed) return;
    const root = this.root;
    this.stopRetryAndHealth();
    void this.enqueue(async () => {
      if (generation !== this.generation || this.disposed || !root) return;
      await this.stopRoot();
      this.batcher.requestResync();
      this.scheduleRetry(generation);
    });
  }

  private scheduleRetry(generation: number): void {
    if (this.retryTimer || this.disposed) return;
    const delay =
      this.retryDelays[Math.min(this.retryAttempt, this.retryDelays.length - 1)] ?? 5000;
    this.retryAttempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.enqueue(async () => {
        const root = this.root;
        if (generation !== this.generation || this.disposed || !root || this.rootWatch) return;
        await this.startRoot(root, generation);
        if (this.rootWatch) {
          this.options.logger.info(`Watching ${root} again`);
          this.batcher.requestResync();
        }
      });
    }, delay);
    this.retryTimer.unref();
  }

  private startHealthCheck(root: string, generation: number): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = setInterval(() => {
      fsp.stat(root).then(
        () => undefined,
        (error: unknown) => {
          const code = errnoOf(error);
          if (code === 'ENOENT' || code === 'ENOTDIR') this.rootLost(generation);
        },
      );
    }, this.healthCheckMs);
    this.healthTimer.unref();
  }

  private stopRetryAndHealth(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.retryTimer = null;
    this.healthTimer = null;
  }

  /** Paths reported through a symbolic link or in different letter case are mapped back to `dir`. */
  private rebase(spec: WatchSpec, realDir: string, reported: string): string {
    if (isWithin(spec.dir, reported, this.options.platform)) return reported;
    if (isWithin(realDir, reported, this.options.platform)) {
      return path.join(spec.dir, reported.slice(realDir.length));
    }
    return reported;
  }

  private onEvents(
    spec: WatchSpec,
    realDir: string,
    events: parcel.Event[],
    rootGeneration: number | null,
  ): void {
    const changes: FsChange[] = [];
    let rootGone = false;
    for (const event of events) {
      const eventPath = this.rebase(spec, realDir, event.path);
      if (spec.onlyName !== null) {
        const sameName = samePath(path.basename(eventPath), spec.onlyName, this.options.platform);
        if (!sameName) continue;
      }
      if (
        rootGeneration !== null &&
        event.type === 'delete' &&
        samePath(eventPath, spec.dir, this.options.platform)
      ) {
        rootGone = true;
      }
      changes.push({ type: event.type, path: eventPath });
    }
    if (rootGone && rootGeneration !== null) {
      this.rootLost(rootGeneration);
      return;
    }
    if (changes.length > 0) this.batcher.push(changes);
  }
}
