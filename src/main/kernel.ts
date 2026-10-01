/**
 * The main-process "kernel": the small set of shared facilities every slice builds on.
 *
 * A slice is a folder under `src/main/<slice>/` whose `index.ts` exports
 * `register(kernel): Disposable`. Slices talk to each other only through the kernel (never by
 * importing each other's internals) and read settings lazily: always go through `kernel.settings`
 * at call time, never cache it, because the settings slice may replace the default host.
 */
import type { BrowserWindow } from 'electron';
import type { AppInfo } from '@shared/api/app';
import type { FsChange } from '@shared/api/fs';
import type { SettingsSnapshot } from '@shared/api/settings';
import type { EventChannel, EventMap, InvokeArgs, InvokeChannel, InvokeResult } from '@shared/ipc';
import type { PolicyState } from '@shared/policy';
import { EMPTY_POLICY } from '@shared/policy';
import { defaultSettings, type SettingKey, type SettingValues } from '@shared/settings';

export type Unsubscribe = () => void;
export type Disposable = () => void;

export interface Logger {
  debug(message: string, ...meta: unknown[]): void;
  info(message: string, ...meta: unknown[]): void;
  warn(message: string, ...meta: unknown[]): void;
  error(message: string, ...meta: unknown[]): void;
}

export interface IpcContext {
  /** Id of the BrowserWindow that made the call. */
  windowId: number;
}

export type Handler<K extends InvokeChannel> = (
  ctx: IpcContext,
  ...args: InvokeArgs<K>
) => InvokeResult<K> | Promise<InvokeResult<K>>;

export interface SettingsHost {
  /** Effective value for a window (defaults < user < workspace < policy). Pass null for app-wide reads. */
  get<K extends SettingKey>(windowId: number | null, key: K): SettingValues[K];
  snapshot(windowId: number | null): SettingsSnapshot | null;
  onDidChange(cb: (e: { windowId: number | null; keys: SettingKey[] }) => void): Unsubscribe;
}

export interface PolicyHost {
  readonly state: PolicyState;
  onDidChange(cb: (state: PolicyState) => void): Unsubscribe;
}

export interface WorkspaceHost {
  getRoot(windowId: number): string | null;
  /** Folder that was open when the app last ran, for session restore at startup. */
  getLastOpened(): string | null;
  setRoot(windowId: number, root: string | null): void;
  /** Always true when workspace trust is disabled. */
  isTrusted(windowId: number): boolean;
  setTrusted(windowId: number, trusted: boolean): void;
  onDidChangeRoot(cb: (e: { windowId: number; root: string | null }) => void): Unsubscribe;
  onDidChangeTrust(cb: (e: { windowId: number; trusted: boolean }) => void): Unsubscribe;
}

export interface Kernel {
  readonly info: AppInfo;
  readonly logger: Logger;
  settings: SettingsHost;
  policy: PolicyHost;
  workspaces: WorkspaceHost;
  /**
   * File system changes for each window's workspace, after debouncing. The fs slice emits; the
   * git slice and others listen. (The same batches are also pushed to the renderer as `fs:changed`.)
   */
  readonly fsChanges: Emitter<{ windowId: number; changes: FsChange[] }>;

  /** Register an IPC handler. Throwing rejects the call in the renderer with an IncError. */
  handle<K extends InvokeChannel>(channel: K, handler: Handler<K>): void;
  /** Push an event to one window. */
  send<K extends EventChannel>(windowId: number, channel: K, payload: EventMap[K]): void;
  /** Push an event to every window. */
  broadcast<K extends EventChannel>(channel: K, payload: EventMap[K]): void;

  getWindow(windowId: number): BrowserWindow | undefined;
  getWindowIds(): number[];
  onWindowCreated(cb: (windowId: number) => void): Unsubscribe;
  /** Fires after a window is destroyed; release per-window resources here. */
  onWindowClosed(cb: (windowId: number) => void): Unsubscribe;
}

// --- Default in-memory hosts, replaced by the settings and workspace slices -----------------

export class Emitter<T> {
  private listeners = new Set<(value: T) => void>();
  on(cb: (value: T) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  emit(value: T): void {
    for (const cb of [...this.listeners]) {
      try {
        cb(value);
      } catch {
        /* one listener must not break the others */
      }
    }
  }
}

export function createDefaultSettingsHost(): SettingsHost {
  const values = defaultSettings();
  const emitter = new Emitter<{ windowId: number | null; keys: SettingKey[] }>();
  return {
    get: (_windowId, key) => values[key],
    snapshot: () => null,
    onDidChange: (cb) => emitter.on(cb),
  };
}

export function createDefaultPolicyHost(): PolicyHost {
  const emitter = new Emitter<PolicyState>();
  return { state: EMPTY_POLICY, onDidChange: (cb) => emitter.on(cb) };
}

export function createDefaultWorkspaceHost(): WorkspaceHost {
  const roots = new Map<number, string | null>();
  const trust = new Map<number, boolean>();
  const rootEmitter = new Emitter<{ windowId: number; root: string | null }>();
  const trustEmitter = new Emitter<{ windowId: number; trusted: boolean }>();
  let last: string | null = null;
  return {
    getRoot: (id) => roots.get(id) ?? null,
    getLastOpened: () => last,
    setRoot(id, root) {
      roots.set(id, root);
      if (root) last = root;
      rootEmitter.emit({ windowId: id, root });
    },
    isTrusted: (id) => trust.get(id) ?? true,
    setTrusted(id, trusted) {
      trust.set(id, trusted);
      trustEmitter.emit({ windowId: id, trusted });
    },
    onDidChangeRoot: (cb) => rootEmitter.on(cb),
    onDidChangeTrust: (cb) => trustEmitter.on(cb),
  };
}
