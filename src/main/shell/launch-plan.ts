/**
 * Decides which window each folder and file of a launch request goes to. Pure: the caller
 * describes the windows that exist and carries out the resulting plan.
 */
import type { OpenPathsRequest } from '@shared/api/app';
import type { LaunchRequest, OpenTarget } from './argv';

export interface WindowSnapshot {
  id: number;
  root: string | null;
  /** The window that was most recently focused, or the only one. */
  focused: boolean;
}

export interface LaunchContext {
  windows: readonly WindowSnapshot[];
  /** Folder to reopen when the launch names nothing (restore session). */
  restoreFolder: string | null;
  /** Case-insensitive folder comparison (Windows, macOS default volumes). */
  caseInsensitive: boolean;
}

/** One window's share of a launch. */
export interface LaunchTarget {
  /** An existing window, or null to create one. */
  windowId: number | null;
  /** Folder to open in it, if any. */
  folder: string | null;
  files: OpenTarget[];
}

export interface LaunchPlan {
  targets: LaunchTarget[];
  /** Window to bring to the front once everything is open (the last target, or an existing window). */
  focusWindowId: number | null | 'last-target';
}

function normalise(folder: string, caseInsensitive: boolean): string {
  const trimmed = folder.length > 1 ? folder.replace(/[\\/]+$/, '') : folder;
  return caseInsensitive ? trimmed.toLowerCase() : trimmed;
}

export function planLaunch(request: LaunchRequest, context: LaunchContext): LaunchPlan {
  const { windows, restoreFolder, caseInsensitive } = context;
  const same = (a: string, b: string) => normalise(a, caseInsensitive) === normalise(b, caseInsensitive);
  const focusedFirst = [...windows].sort((a, b) => Number(b.focused) - Number(a.focused));
  const targets: LaunchTarget[] = [];
  const claimed = new Set<number>();

  const nothingRequested = request.folders.length === 0 && request.files.length === 0;
  if (nothingRequested) {
    if (windows.length === 0) {
      return {
        targets: [{ windowId: null, folder: restoreFolder, files: [] }],
        focusWindowId: 'last-target',
      };
    }
    if (request.newWindow) {
      return {
        targets: [{ windowId: null, folder: null, files: [] }],
        focusWindowId: 'last-target',
      };
    }
    return { targets: [], focusWindowId: focusedFirst[0]?.id ?? null };
  }

  for (const folder of request.folders) {
    const open = windows.find((w) => w.root !== null && same(w.root, folder));
    if (open && !request.newWindow && !claimed.has(open.id)) {
      claimed.add(open.id);
      targets.push({ windowId: open.id, folder: null, files: [] });
      continue;
    }
    const empty = request.newWindow
      ? undefined
      : focusedFirst.find((w) => w.root === null && !claimed.has(w.id));
    if (empty) {
      claimed.add(empty.id);
      targets.push({ windowId: empty.id, folder, files: [] });
    } else {
      targets.push({ windowId: null, folder, files: [] });
    }
  }

  if (request.files.length > 0) {
    const first = targets[0];
    if (first) {
      first.files = [...request.files];
    } else if (request.newWindow) {
      targets.push({ windowId: null, folder: null, files: [...request.files] });
    } else {
      const window = focusedFirst[0];
      targets.push({ windowId: window?.id ?? null, folder: null, files: [...request.files] });
    }
  }

  return { targets, focusWindowId: 'last-target' };
}

/** Files with the same position travel together; each distinct position is its own request. */
export function groupOpenRequests(files: readonly OpenTarget[]): OpenPathsRequest[] {
  const requests: OpenPathsRequest[] = [];
  const plain: string[] = [];
  for (const file of files) {
    if (file.line === undefined) {
      plain.push(file.path);
    } else {
      requests.push({
        paths: [file.path],
        line: file.line,
        ...(file.column !== undefined ? { column: file.column } : {}),
      });
    }
  }
  return plain.length > 0 ? [{ paths: plain }, ...requests] : requests;
}

/** Open requests that arrived before a window's renderer started listening. */
export class PendingOpenQueue {
  private readonly queues = new Map<number, OpenPathsRequest[]>();
  private readonly listening = new Set<number>();

  /** Deliver now if the renderer is listening, otherwise hold the request. Returns true if it must be sent. */
  offer(windowId: number, request: OpenPathsRequest): boolean {
    if (this.listening.has(windowId)) return true;
    const queue = this.queues.get(windowId) ?? [];
    queue.push(request);
    this.queues.set(windowId, queue);
    return false;
  }

  /** The renderer subscribed: hand over everything held and switch to live delivery. */
  consume(windowId: number): OpenPathsRequest[] {
    this.listening.add(windowId);
    const queue = this.queues.get(windowId) ?? [];
    this.queues.delete(windowId);
    return queue;
  }

  /** The page is loading again (reload): its listeners are gone, so hold requests until it re-subscribes. */
  pause(windowId: number): void {
    this.listening.delete(windowId);
  }

  release(windowId: number): void {
    this.queues.delete(windowId);
    this.listening.delete(windowId);
  }
}
