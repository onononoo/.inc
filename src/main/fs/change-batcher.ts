import path from 'node:path';
import type { FsChange } from '@shared/api/fs';
import { isTempFileName } from './util';

export type ChangeType = FsChange['type'];

export interface ChangeBatcherOptions {
  /** Called with each batch. Never called with an empty list. */
  onFlush: (changes: FsChange[]) => void;
  /** Path reported by the single "resync" change that replaces an oversized batch. */
  resyncPath: () => string;
  /** How long changes are collected before a batch is emitted. Default 75 ms. */
  windowMs?: number;
  /** More distinct paths than this in one window collapse into a resync. Default 5000. */
  stormThreshold?: number;
}

export const DEFAULT_WINDOW_MS = 75;
export const DEFAULT_STORM_THRESHOLD = 5000;

/**
 * How two changes to the same path within one batch combine, or null when they cancel out
 * (created and deleted again before anyone could see it).
 */
export function mergeChangeTypes(previous: ChangeType, next: ChangeType): ChangeType | null {
  switch (previous) {
    case 'create':
      if (next === 'delete') return null;
      return 'create';
    case 'delete':
      // Deleted and created again: the path exists, with new content.
      return next === 'delete' ? 'delete' : 'update';
    case 'update':
      return next === 'create' ? 'update' : next;
  }
}

/** True for paths whose changes are noise: our own temporary files and Git object storage. */
export function isIgnoredPath(target: string): boolean {
  if (isTempFileName(path.basename(target))) return true;
  const normalised = target.replace(/\\/g, '/');
  return normalised.includes('/.git/objects/') || normalised.endsWith('/.git/objects');
}

/**
 * Collects raw watcher events and emits them as small, de-duplicated batches. Several events for
 * one path become one change; a flood of events (a branch switch, an install) is replaced by a
 * single resync change so the consumer refreshes once instead of being flooded.
 */
export class ChangeBatcher {
  private readonly pending = new Map<string, FsChange>();
  private timer: NodeJS.Timeout | null = null;
  private storm = false;
  private disposed = false;
  private readonly windowMs: number;
  private readonly stormThreshold: number;

  constructor(private readonly options: ChangeBatcherOptions) {
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.stormThreshold = options.stormThreshold ?? DEFAULT_STORM_THRESHOLD;
  }

  push(changes: readonly FsChange[]): void {
    if (this.disposed) return;
    for (const change of changes) {
      if (change.resync) {
        this.requestResync();
        continue;
      }
      if (this.storm || isIgnoredPath(change.path)) continue;
      const known = this.pending.get(change.path);
      if (!known) {
        this.pending.set(change.path, { type: change.type, path: change.path });
      } else {
        const merged = mergeChangeTypes(known.type, change.type);
        if (merged === null) this.pending.delete(change.path);
        else known.type = merged;
      }
      if (this.pending.size > this.stormThreshold) {
        this.requestResync();
        break;
      }
    }
    this.arm();
  }

  /** Replace everything collected so far with one resync change. */
  requestResync(): void {
    if (this.disposed) return;
    this.storm = true;
    this.pending.clear();
    this.arm();
  }

  /** Emit what has been collected now instead of waiting for the window to end. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.disposed) return;
    let batch: FsChange[];
    if (this.storm) {
      batch = [{ type: 'update', path: this.options.resyncPath(), resync: true }];
    } else {
      batch = [...this.pending.values()];
    }
    this.storm = false;
    this.pending.clear();
    if (batch.length > 0) this.options.onFlush(batch);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }

  private arm(): void {
    if (this.timer || (this.pending.size === 0 && !this.storm)) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.windowMs);
  }
}
