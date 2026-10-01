/**
 * Layered settings: defaults < user settings.json < workspace <root>/.inc/settings.json < policy.
 *
 * The service owns the user file and one workspace file per window, keeps them parsed and
 * validated, resolves a snapshot per window and reports changes to the renderer and to other main
 * process slices. Edits are targeted JSONC edits written atomically, so comments and formatting in
 * the user's file survive.
 */
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type { SettingsIssue, SettingsSnapshot } from '@shared/api/settings';
import { IncError, toIncError } from '@shared/errors';
import {
  SETTINGS,
  cloneValue,
  isSettingKey,
  validateSetting,
  type SettingKey,
  type SettingValues,
} from '@shared/settings';
import {
  Emitter,
  type Logger,
  type PolicyHost,
  type SettingsHost,
  type Unsubscribe,
  type WorkspaceHost,
} from '../kernel';
import { ConfigFile } from './config-file';
import {
  MAX_CONFIG_BYTES,
  atomicWriteFile,
  createIfMissing,
  readConfigText,
  resolveWriteTarget,
} from './fs-util';
import { describeProblem, parseDocument, removeTopLevel, setTopLevel } from './jsonc';
import { changedKeys, parseSettingsFile, resolveSettings, type ParsedSettingsFile } from './layers';
import { USER_SETTINGS_TEMPLATE, WORKSPACE_SETTINGS_TEMPLATE } from './templates';
import { watchFile, type FileWatcher } from './watcher';

export const USER_SETTINGS_FILE = 'settings.json';
export const WORKSPACE_SETTINGS_DIR = '.inc';

export type SettingsScope = 'user' | 'workspace';

export interface SettingsEnv {
  userDataDir: string;
  logger: Logger;
  /** Read at call time: the workspace slice replaces the host after this service is created. */
  workspaces(): WorkspaceHost;
  policy: PolicyHost;
  /** Push a snapshot to one window (`settings:changed`). */
  notify(windowId: number, snapshot: SettingsSnapshot): void;
  /** Watch files for external edits. Default true. */
  watch?: boolean;
  debounceMs?: number;
}

interface WorkspaceLayer {
  root: string;
  config: ConfigFile<ParsedSettingsFile>;
  watcher: FileWatcher | null;
}

interface CacheEntry {
  snapshot: SettingsSnapshot;
  root: string | null;
  trusted: boolean;
  policy: object;
  version: number;
}

type ChangeScope = 'all' | number;

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

function workspaceFileFor(root: string): string {
  return path.join(root, WORKSPACE_SETTINGS_DIR, USER_SETTINGS_FILE);
}

export class SettingsService implements SettingsHost {
  private readonly user: ConfigFile<ParsedSettingsFile>;
  private readonly userWatchers: FileWatcher[] = [];
  private readonly layers = new Map<number, WorkspaceLayer>();
  private readonly entries = new Map<number | null, CacheEntry>();
  private readonly emitter = new Emitter<{ windowId: number | null; keys: SettingKey[] }>();
  private readonly loggedIssues = new Set<string>();
  private readonly subscriptions: Unsubscribe[] = [];
  private boundHost: WorkspaceHost | null = null;
  private hostSubscriptions: Unsubscribe[] = [];
  private version = 0;
  private writes: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(private readonly env: SettingsEnv) {
    const file = path.join(env.userDataDir, USER_SETTINGS_FILE);
    this.user = new ConfigFile(file, parseSettingsFile);
    this.user.load();
    if (env.watch !== false) {
      const options = { debounceMs: env.debounceMs, logger: env.logger };
      const onChange = (): void => {
        if (this.user.load()) this.changed('all');
      };
      this.userWatchers.push(watchFile(file, onChange, options));
      // A settings file that is a symbolic link (dotfile setups) changes where it points to.
      const target = resolveWriteTarget(file);
      if (target !== file) this.userWatchers.push(watchFile(target, onChange, options));
    }
    this.subscriptions.push(env.policy.onDidChange(() => this.changed('all', true)));
    this.logIssues(this.snapshotFor(null).issues);
  }

  // --- SettingsHost ---------------------------------------------------------------------------

  get<K extends SettingKey>(windowId: number | null, key: K): SettingValues[K] {
    const value = this.snapshotFor(windowId).effective[key];
    return typeof value === 'object' && value !== null ? cloneValue(value) : value;
  }

  snapshot(windowId: number | null): SettingsSnapshot {
    return this.snapshotFor(windowId);
  }

  /** `windowId` is null when the change reaches every window (user or policy settings changed). */
  onDidChange(cb: (e: { windowId: number | null; keys: SettingKey[] }) => void): Unsubscribe {
    return this.emitter.on(cb);
  }

  // --- lifecycle ------------------------------------------------------------------------------

  /**
   * Follow the workspace host. The workspace slice replaces `kernel.workspaces` after this
   * service is created, so the subscription is (re)made whenever the host object changes.
   */
  attach(): void {
    const host = this.env.workspaces();
    if (host === this.boundHost) return;
    for (const unsubscribe of this.hostSubscriptions) unsubscribe();
    this.boundHost = host;
    this.hostSubscriptions = [
      host.onDidChangeRoot(({ windowId }) => this.changed(windowId)),
      host.onDidChangeTrust(({ windowId }) => this.changed(windowId)),
    ];
    this.version++;
  }

  /** Drop everything held for a window that was closed. */
  releaseWindow(windowId: number): void {
    this.entries.delete(windowId);
    this.disposeLayer(windowId);
  }

  dispose(): void {
    this.disposed = true;
    for (const watcher of this.userWatchers.splice(0)) watcher.dispose();
    for (const id of [...this.layers.keys()]) this.disposeLayer(id);
    for (const unsubscribe of this.hostSubscriptions.splice(0)) unsubscribe();
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe();
    this.boundHost = null;
    this.entries.clear();
  }

  // --- reading --------------------------------------------------------------------------------

  /** Path of the user settings file. */
  get userFile(): string {
    return this.user.file;
  }

  /** Re-read the user file now (also used by the file watcher). */
  reloadUser(): void {
    if (this.user.load()) this.changed('all');
  }

  /** Re-read a window's workspace file now. */
  reloadWorkspace(windowId: number): void {
    const layer = this.layers.get(windowId);
    if (layer?.config.load()) this.changed(windowId);
  }

  private snapshotFor(windowId: number | null): SettingsSnapshot {
    this.attach();
    const host = this.env.workspaces();
    const root = windowId === null ? null : host.getRoot(windowId);
    const trusted = windowId === null ? true : host.isTrusted(windowId);
    const policy = this.env.policy.state;
    const hit = this.entries.get(windowId);
    if (
      hit &&
      hit.version === this.version &&
      hit.root === root &&
      hit.trusted === trusted &&
      hit.policy === policy
    ) {
      return hit.snapshot;
    }

    const layer = windowId === null ? null : this.layerFor(windowId, root);
    const userFile = this.user.value;
    const workspaceFile = layer?.config.value;
    const snapshot = deepFreeze(
      resolveSettings({
        user: { file: this.user.file, entries: userFile.entries, issues: userFile.issues },
        workspace:
          layer && workspaceFile
            ? {
                file: layer.config.file,
                entries: workspaceFile.entries,
                issues: workspaceFile.issues,
              }
            : null,
        trusted,
        policy,
        workspaceFile: root ? workspaceFileFor(root) : null,
      }),
    );
    this.entries.set(windowId, { snapshot, root, trusted, policy, version: this.version });
    return snapshot;
  }

  private layerFor(windowId: number, root: string | null): WorkspaceLayer | null {
    const existing = this.layers.get(windowId);
    if (existing && existing.root === root) return existing;
    if (existing) this.disposeLayer(windowId);
    if (root === null) return null;

    const file = workspaceFileFor(root);
    const config = new ConfigFile(file, parseSettingsFile);
    config.load();
    const watcher =
      this.env.watch === false
        ? null
        : watchFile(file, () => this.reloadWorkspace(windowId), {
            debounceMs: this.env.debounceMs,
            logger: this.env.logger,
          });
    const layer = { root, config, watcher };
    this.layers.set(windowId, layer);
    return layer;
  }

  private disposeLayer(windowId: number): void {
    this.layers.get(windowId)?.watcher?.dispose();
    this.layers.delete(windowId);
  }

  // --- change notification --------------------------------------------------------------------

  /**
   * Something that feeds the snapshots changed. Recompute every affected window and tell the
   * renderer when its snapshot differs (always, when `force`), and other slices which keys moved.
   * Only windows that have been looked at before have a baseline to compare against.
   */
  private changed(scope: ChangeScope, force = false): void {
    if (this.disposed) return;
    this.version++;
    const ids = scope === 'all' ? [...this.entries.keys()] : this.entries.has(scope) ? [scope] : [];
    const moved = new Set<SettingKey>();
    const perWindow: { windowId: number; keys: SettingKey[] }[] = [];

    for (const id of ids) {
      const before = this.entries.get(id)?.snapshot;
      if (!before) continue;
      const after = this.snapshotFor(id);
      const keys = changedKeys(before, after);
      for (const key of keys) moved.add(key);
      if (id !== null) {
        if (keys.length > 0) perWindow.push({ windowId: id, keys });
        if (force || JSON.stringify(before) !== JSON.stringify(after)) {
          this.env.notify(id, after);
        }
      }
      this.logIssues(after.issues);
    }

    if (scope === 'all') {
      if (moved.size > 0) this.emitter.emit({ windowId: null, keys: [...moved] });
    } else {
      for (const event of perWindow) this.emitter.emit(event);
    }
  }

  /** Each problem is logged once, not on every reload. */
  private logIssues(issues: readonly SettingsIssue[]): void {
    for (const issue of issues) {
      const id = `${issue.file}\n${issue.line ?? 0}\n${issue.message}`;
      if (this.loggedIssues.has(id)) continue;
      this.loggedIssues.add(id);
      this.env.logger.warn(
        `Settings: ${issue.message} (${issue.file}${issue.line ? `:${issue.line}` : ''})`,
      );
    }
  }

  // --- writing --------------------------------------------------------------------------------

  async set(
    windowId: number,
    key: unknown,
    value: unknown,
    scope: unknown,
  ): Promise<SettingsSnapshot> {
    const target = this.checkWrite(windowId, key, scope, 'set');
    const result = validateSetting(target.key, value);
    if (!result.ok) {
      throw new IncError('E_INVALID', `${SETTINGS[target.key].title}: ${result.reason}`);
    }
    // A value that is already too big can never fit; refuse before the (slow) JSONC formatting.
    if (Buffer.byteLength(JSON.stringify(result.value) ?? '', 'utf8') > MAX_CONFIG_BYTES) {
      throw new IncError('E_TOO_LARGE', 'The settings file would be larger than 1 MB.');
    }
    await this.edit(windowId, target.scope, (text) => setTopLevel(text, target.key, result.value));
    return this.snapshotFor(windowId);
  }

  async reset(windowId: number, key: unknown, scope: unknown): Promise<SettingsSnapshot> {
    const target = this.checkWrite(windowId, key, scope, 'reset');
    await this.edit(windowId, target.scope, (text) => removeTopLevel(text, target.key), {
      createIfMissing: false,
    });
    return this.snapshotFor(windowId);
  }

  /** Create the settings file with a short header when it is missing; returns its path. */
  async ensureFile(windowId: number, scope: unknown): Promise<string> {
    const checked = this.checkScope(scope);
    return this.enqueue(async () => {
      if (checked === 'user') {
        await this.guard(
          () => createIfMissing(resolveWriteTarget(this.user.file), USER_SETTINGS_TEMPLATE),
          this.user.file,
        );
        this.reloadUser();
        return this.user.file;
      }
      const root = this.requireRoot(windowId);
      const file = workspaceFileFor(root);
      await this.assertWorkspaceFolderSafe(root);
      await this.guard(() => createIfMissing(file, WORKSPACE_SETTINGS_TEMPLATE), file);
      this.snapshotFor(windowId);
      this.reloadWorkspace(windowId);
      return file;
    });
  }

  private checkScope(scope: unknown): SettingsScope {
    if (scope !== 'user' && scope !== 'workspace') {
      throw new IncError('E_INVALID', 'The scope must be "user" or "workspace".');
    }
    return scope;
  }

  private checkWrite(
    windowId: number,
    key: unknown,
    scopeInput: unknown,
    mode: 'set' | 'reset',
  ): { key: SettingKey; scope: SettingsScope } {
    const scope = this.checkScope(scopeInput);
    if (typeof key !== 'string' || !isSettingKey(key)) {
      throw new IncError('E_INVALID', `"${String(key)}" is not a known setting.`);
    }
    const def = SETTINGS[key];
    if (this.env.policy.state.lockedKeys.includes(key)) {
      throw new IncError('E_POLICY', `"${def.title}" is managed by your organization.`, { key });
    }
    if (scope === 'workspace') {
      if (def.scope === 'user') {
        throw new IncError(
          'E_INVALID',
          `"${def.title}" can only be changed in your user settings.`,
        );
      }
      this.requireRoot(windowId);
      if (mode === 'set' && def.restricted && !this.env.workspaces().isTrusted(windowId)) {
        throw new IncError(
          'E_UNTRUSTED',
          `Trust this folder to change "${def.title}" in its settings.`,
        );
      }
    }
    return { key, scope };
  }

  private requireRoot(windowId: number): string {
    const root = this.env.workspaces().getRoot(windowId);
    if (root === null) throw new IncError('E_NO_WORKSPACE', 'Open a folder first.');
    return root;
  }

  /** Refuse to write through a `.inc` folder that is a link, which could point outside the workspace. */
  private async assertWorkspaceFolderSafe(root: string): Promise<void> {
    const dir = path.join(root, WORKSPACE_SETTINGS_DIR);
    let info;
    try {
      info = await lstat(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    if (info.isSymbolicLink()) {
      throw new IncError(
        'E_PERMISSION',
        `The ${WORKSPACE_SETTINGS_DIR} folder in this workspace is a symbolic link, so .inc will not write settings through it.`,
      );
    }
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writes.then(task, task);
    this.writes = run.catch(() => undefined);
    return run;
  }

  private async guard<T>(action: () => Promise<T>, file: string): Promise<T> {
    try {
      return await action();
    } catch (e) {
      if (e instanceof IncError) throw e;
      const error = toIncError(e);
      throw new IncError(error.code, `Could not write ${file}. ${error.message}`, error.details);
    }
  }

  /**
   * Read the current text of a settings file from disk, apply `transform`, and write the result
   * atomically. A file with a syntax error is never edited: the user's text may be half typed.
   */
  private edit(
    windowId: number,
    scope: SettingsScope,
    transform: (text: string) => string,
    options: { createIfMissing?: boolean } = {},
  ): Promise<void> {
    return this.enqueue(async () => {
      const root = scope === 'workspace' ? this.requireRoot(windowId) : null;
      const file = root === null ? this.user.file : workspaceFileFor(root);
      const target = root === null ? resolveWriteTarget(file) : file;
      if (root !== null) await this.assertWorkspaceFolderSafe(root);

      const read = readConfigText(target);
      if (read.kind === 'error') {
        throw new IncError('E_IO', `${file} could not be read. ${read.message}`);
      }
      if (read.kind === 'missing' && options.createIfMissing === false) return;
      const bom = read.kind === 'ok' && read.bom;
      const template = scope === 'user' ? USER_SETTINGS_TEMPLATE : WORKSPACE_SETTINGS_TEMPLATE;
      const text = read.kind === 'ok' ? read.text : template;

      const doc = parseDocument(text);
      const first = doc.problems[0];
      if (first) {
        throw new IncError(
          'E_INVALID',
          `${file} has a syntax error. ${describeProblem(first)} Fix the file, then try again.`,
        );
      }
      if (doc.root && doc.root.type !== 'object') {
        throw new IncError(
          'E_INVALID',
          `${file} must contain a single object. Fix the file, then try again.`,
        );
      }

      const next = transform(text);
      if (next === text && read.kind === 'ok') return;
      if (Buffer.byteLength(next, 'utf8') > MAX_CONFIG_BYTES) {
        throw new IncError('E_TOO_LARGE', 'The settings file would be larger than 1 MB.');
      }
      await this.guard(() => atomicWriteFile(target, (bom ? '﻿' : '') + next), file);

      if (root === null) {
        if (this.user.apply(next)) this.changed('all');
      } else {
        this.snapshotFor(windowId);
        if (this.layers.get(windowId)?.config.apply(next)) this.changed(windowId);
      }
    });
  }
}
