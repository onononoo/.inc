import type { RecentWorkspace, SessionBlob, WorkspaceInfo } from '@shared/api/workspace';
import { IncError, toIncError } from '@shared/errors';
import { samePath, type Platform } from '@shared/paths';
import { Emitter, type Logger, type Unsubscribe, type WorkspaceHost } from '../kernel';
import {
  assertOpenableFolder,
  assertOpenableFolderSync,
  isExistingFolderSync,
  normaliseRootInput,
} from './root-path';
import { RecentStore, folderName } from './recent-store';
import { SessionStore } from './session-store';
import { TrustStore } from './trust-store';

/** Everything the service needs from its surroundings; the slice entry point wires the kernel in. */
export interface WorkspaceEnv {
  userDataDir: string;
  platform: Platform;
  logger: Logger;
  /** Whether workspace trust is on: the `security.workspaceTrust` setting, or the policy value that overrides it. */
  isTrustEnabled(): boolean;
  /** Push the window's workspace state to its renderer (`workspace:changed`). */
  notify(windowId: number, info: WorkspaceInfo | null): void;
  hasWindow(windowId: number): boolean;
  /** Operating-system "recent documents" list (Windows jump list, macOS Dock menu). */
  osRecents?: { add(folder: string): void; clear(): void };
}

interface WindowState {
  root: string;
  /** The user has trusted this folder (persisted). Only meaningful while trust is enabled. */
  granted: boolean;
  /** What the renderer was last told, to notify only on real changes. */
  announced: { trusted: boolean; enabled: boolean };
}

/**
 * Per-window workspace roots, trust, recents and sessions. Implements the kernel's
 * {@link WorkspaceHost} so every other slice sees the same state.
 */
export class WorkspaceService implements WorkspaceHost {
  private readonly windows = new Map<number, WindowState>();
  private readonly rootEvents = new Emitter<{ windowId: number; root: string | null }>();
  private readonly trustEvents = new Emitter<{ windowId: number; trusted: boolean }>();
  private readonly trust: TrustStore;
  private readonly recents: RecentStore;
  private readonly sessions: SessionStore;

  constructor(private readonly env: WorkspaceEnv) {
    const warn = (message: string) => env.logger.warn(message);
    this.trust = new TrustStore(env.userDataDir, env.platform, warn);
    this.recents = new RecentStore(env.userDataDir, env.platform, warn);
    this.sessions = new SessionStore(env.userDataDir, env.platform, warn);
  }

  // --- WorkspaceHost (synchronous, used by other slices) --------------------------------------

  getRoot(windowId: number): string | null {
    return this.windows.get(windowId)?.root ?? null;
  }

  getLastOpened(): string | null {
    const last = this.recents.getLastOpened();
    return last !== null && isExistingFolderSync(last) ? last : null;
  }

  setRoot(windowId: number, root: string | null): void {
    if (root === null) {
      this.replaceRoot(windowId, null);
      return;
    }
    const normalised = normaliseRootInput(root);
    assertOpenableFolderSync(normalised);
    this.replaceRoot(windowId, normalised);
  }

  isTrusted(windowId: number): boolean {
    return this.effectiveTrust(this.windows.get(windowId));
  }

  setTrusted(windowId: number, trusted: boolean): void {
    this.setTrust(windowId, trusted);
  }

  onDidChangeRoot(cb: (e: { windowId: number; root: string | null }) => void): Unsubscribe {
    return this.rootEvents.on(cb);
  }

  onDidChangeTrust(cb: (e: { windowId: number; trusted: boolean }) => void): Unsubscribe {
    return this.trustEvents.on(cb);
  }

  // --- IPC handlers ---------------------------------------------------------------------------

  getInfo(windowId: number): WorkspaceInfo | null {
    return this.infoFor(this.windows.get(windowId));
  }

  async open(windowId: number, requested: unknown): Promise<WorkspaceInfo> {
    const root = normaliseRootInput(requested);
    await assertOpenableFolder(root);
    if (!this.env.hasWindow(windowId)) {
      throw new IncError(
        'E_CANCELLED',
        'The window was closed before the folder finished opening.',
      );
    }
    this.replaceRoot(windowId, root);
    return this.infoFor(this.windows.get(windowId))!;
  }

  close(windowId: number): void {
    const previous = this.windows.get(windowId)?.root;
    this.replaceRoot(windowId, null);
    if (previous !== undefined) this.recents.clearLastOpened(previous);
  }

  setTrust(windowId: number, trusted: unknown): WorkspaceInfo {
    if (typeof trusted !== 'boolean') {
      throw new IncError('E_INVALID', 'Trust must be true or false.');
    }
    const state = this.windows.get(windowId);
    if (!state) throw new IncError('E_NO_WORKSPACE', 'Open a folder before changing trust.');
    try {
      this.trust.set(state.root, trusted);
    } catch (e) {
      this.env.logger.error('Could not persist workspace trust', e);
      throw new IncError(
        'E_IO',
        'The trust decision could not be saved. Check that the user data folder is writable.',
        {
          cause: toIncError(e).message,
        },
      );
    }
    for (const [id, other] of this.windows) {
      if (samePath(other.root, state.root, this.env.platform)) {
        other.granted = trusted;
        this.announce(id, other);
      }
    }
    return this.infoFor(state)!;
  }

  async getRecent(): Promise<RecentWorkspace[]> {
    return this.recents.list();
  }

  async removeRecent(requested: unknown): Promise<RecentWorkspace[]> {
    this.recents.remove(normaliseRootInput(requested));
    return this.recents.list();
  }

  clearRecent(): void {
    this.recents.clear();
    try {
      this.env.osRecents?.clear();
    } catch (e) {
      this.env.logger.warn('Could not clear the operating system recent list', e);
    }
  }

  loadSession(windowId: number): Promise<SessionBlob | null> {
    return this.sessions.load(this.getRoot(windowId));
  }

  saveSession(windowId: number, blob: unknown): Promise<void> {
    return this.sessions.save(this.getRoot(windowId), blob);
  }

  // --- lifecycle ------------------------------------------------------------------------------

  /** The trust setting or policy changed: re-evaluate every window. */
  refreshTrustMode(): void {
    for (const [id, state] of this.windows) this.announce(id, state);
  }

  /** Drop per-window state after the window is destroyed. The folder stays the one to restore. */
  releaseWindow(windowId: number): void {
    this.windows.delete(windowId);
  }

  /** Housekeeping run once at startup; never throws. */
  async pruneStaleSessions(): Promise<void> {
    try {
      const removed = await this.sessions.pruneStale();
      if (removed > 0) this.env.logger.info(`Removed ${removed} stale session file(s)`);
    } catch (e) {
      this.env.logger.warn('Could not prune old sessions', e);
    }
  }

  // --- internals ------------------------------------------------------------------------------

  private effectiveTrust(state: WindowState | undefined): boolean {
    if (!state) return true;
    return !this.env.isTrustEnabled() || state.granted;
  }

  private infoFor(state: WindowState | undefined): WorkspaceInfo | null {
    if (!state) return null;
    return {
      root: state.root,
      name: folderName(state.root),
      trust: this.effectiveTrust(state) ? 'trusted' : 'untrusted',
      trustEnabled: this.env.isTrustEnabled(),
    };
  }

  private replaceRoot(windowId: number, root: string | null): void {
    const previous = this.windows.get(windowId);

    if (root !== null && previous && samePath(previous.root, root, this.env.platform)) {
      this.remember(previous.root);
      return;
    }
    if (root === null && !previous) return;

    if (root === null) {
      this.windows.delete(windowId);
    } else {
      const granted = this.trust.isTrusted(root);
      this.windows.set(windowId, {
        root,
        granted,
        announced: {
          trusted: !this.env.isTrustEnabled() || granted,
          enabled: this.env.isTrustEnabled(),
        },
      });
      this.remember(root);
    }

    const wasTrusted = this.effectiveTrust(previous);
    const state = this.windows.get(windowId);
    this.rootEvents.emit({ windowId, root });
    const nowTrusted = this.effectiveTrust(state);
    if (nowTrusted !== wasTrusted) this.trustEvents.emit({ windowId, trusted: nowTrusted });
    this.env.notify(windowId, this.infoFor(state));
  }

  /** Record the folder in the recent list and the operating system's list. */
  private remember(root: string): void {
    try {
      this.recents.add(root);
    } catch (e) {
      this.env.logger.warn('Could not save the recent folders list', e);
    }
    try {
      this.env.osRecents?.add(root);
    } catch (e) {
      this.env.logger.warn('Could not update the operating system recent list', e);
    }
  }

  private announce(windowId: number, state: WindowState): void {
    const trusted = this.effectiveTrust(state);
    const enabled = this.env.isTrustEnabled();
    const before = state.announced;
    if (before.trusted === trusted && before.enabled === enabled) return;
    state.announced = { trusted, enabled };
    if (before.trusted !== trusted) this.trustEvents.emit({ windowId, trusted });
    this.env.notify(windowId, this.infoFor(state));
  }
}
