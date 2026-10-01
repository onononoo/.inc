import { create } from 'zustand';
import type { FsChange } from '@shared/api/fs';
import { describeError, isIncError } from '@shared/errors';
import {
  basename,
  dirname,
  isWithin,
  join,
  pathKey,
  relativeTo,
  segments,
  type Platform,
} from '@shared/paths';
import { ipc, platform as hostPlatform } from '../services/ipc';
import { hasService, service } from '../services/registry';
import { getSection, setSection } from '../services/session';
import { getSetting } from '../state/settings-store';
import {
  EMPTY_TREE,
  checkDrop,
  destinationFor,
  forgetSubtree,
  topmostPaths,
  uniqueCopyName,
  type EditState,
  type TreeState,
} from './tree-model';

const platform = hostPlatform as Platform;
const MAX_RESTORED_FOLDERS = 200;
const RELOAD_DEBOUNCE_MS = 200;

export interface ExplorerState extends TreeState {
  selected: ReadonlySet<string>;
  /** Start of a shift-range selection. */
  anchor: string | null;
  /** The row that holds the keyboard position. */
  focused: string | null;
  edit: EditState | null;
  clipboard: { paths: string[]; mode: 'copy' | 'cut' } | null;
  /** Bumped when the set of rows may have changed; consumers memoise on it. */
  version: number;
}

export const useExplorerStore = create<ExplorerState>(() => ({
  ...EMPTY_TREE,
  selected: new Set(),
  anchor: null,
  focused: null,
  edit: null,
  clipboard: null,
  version: 0,
}));

const get = () => useExplorerStore.getState();
const set = (patch: Partial<ExplorerState> | ((s: ExplorerState) => Partial<ExplorerState>)) =>
  useExplorerStore.setState((s) => {
    const change = typeof patch === 'function' ? patch(s) : patch;
    return { ...change, version: s.version + 1 };
  });

const notify = () => service('notifications');

function fail(message: string, error: unknown): void {
  notify().error(message, describeError(error));
}

// --- workspace ------------------------------------------------------------------------------

let generation = 0;

/** Show a different workspace (or none): forget the old tree and read the root. */
export async function openRoot(root: string | null): Promise<void> {
  const mine = ++generation;
  set({
    ...EMPTY_TREE,
    root,
    selected: new Set(),
    anchor: null,
    focused: null,
    edit: null,
  });
  if (!root) return;
  await loadDir(root);
  if (mine !== generation) return;
  const saved = getSection<{ expanded?: string[] }>('explorer');
  const relatives = Array.isArray(saved?.expanded)
    ? saved.expanded.slice(0, MAX_RESTORED_FOLDERS)
    : [];
  for (const rel of relatives) {
    if (mine !== generation) return;
    const dir = join(root, ...segments(rel));
    if (typeof rel === 'string') await expandPath(dir);
  }
}

function persistExpanded(): void {
  const { root, expanded } = get();
  if (!root) return;
  const relatives = [...expanded]
    .map((p) => relativeTo(root, p, platform))
    .filter((p): p is string => p !== null && p !== '')
    .slice(0, MAX_RESTORED_FOLDERS);
  setSection('explorer', { expanded: relatives });
}

// --- reading --------------------------------------------------------------------------------

/** Read one folder. Failure leaves an error row with a way to retry. */
export async function loadDir(dir: string): Promise<void> {
  const mine = generation;
  set((s) => ({ loading: new Set(s.loading).add(dir) }));
  try {
    const entries = await ipc.invoke('fs:readDir', dir);
    if (mine !== generation) return;
    set((s) => {
      const loading = new Set(s.loading);
      loading.delete(dir);
      const errors = { ...s.errors };
      delete errors[dir];
      return { listings: { ...s.listings, [dir]: entries }, loading, errors };
    });
  } catch (error) {
    if (mine !== generation) return;
    set((s) => {
      const loading = new Set(s.loading);
      loading.delete(dir);
      return { loading, errors: { ...s.errors, [dir]: describeError(error) } };
    });
  }
}

/** Read a folder again and keep what was open. A folder that is gone takes its subtree with it. */
async function reloadDir(dir: string): Promise<void> {
  const mine = generation;
  try {
    const entries = await ipc.invoke('fs:readDir', dir);
    if (mine !== generation) return;
    set((s) => {
      const errors = { ...s.errors };
      delete errors[dir];
      const kept = new Set(entries.filter((e) => e.kind === 'directory').map((e) => e.path));
      const gone = Object.keys(s.listings).filter((d) => dirname(d) === dir && !kept.has(d));
      let next: ExplorerState = { ...s, listings: { ...s.listings, [dir]: entries }, errors };
      for (const folder of gone) next = { ...next, ...forgetSubtree(next, folder, platform) };
      const stillThere = new Set(entries.map((e) => e.path));
      const selected = new Set(
        [...s.selected].filter((p) => dirname(p) !== dir || stillThere.has(p)),
      );
      return {
        listings: next.listings,
        errors: next.errors,
        expanded: next.expanded,
        loading: next.loading,
        selected,
      };
    });
  } catch (error) {
    if (mine !== generation) return;
    if (isIncError(error, 'E_NOT_FOUND') || isIncError(error, 'E_NOT_DIRECTORY')) {
      if (dir !== get().root) {
        set((s) => forgetSubtree(s, dir, platform));
        await reloadDir(dirname(dir));
        return;
      }
    }
    set((s) => ({ errors: { ...s.errors, [dir]: describeError(error) } }));
  }
}

export function retry(dir: string): void {
  set((s) => {
    const errors = { ...s.errors };
    delete errors[dir];
    return { errors };
  });
  void loadDir(dir);
}

export async function toggle(path: string): Promise<void> {
  if (get().expanded.has(path)) collapse(path);
  else await expand(path);
}

export async function expand(path: string): Promise<void> {
  set((s) => ({ expanded: new Set(s.expanded).add(path) }));
  persistExpanded();
  if (!get().listings[path] && !get().loading.has(path)) await loadDir(path);
}

export function collapse(path: string): void {
  set((s) => {
    const expanded = new Set(s.expanded);
    expanded.delete(path);
    return { expanded };
  });
  persistExpanded();
}

export function collapseAll(): void {
  set({ expanded: new Set() });
  persistExpanded();
}

export async function refreshAll(): Promise<void> {
  const dirs = Object.keys(get().listings);
  await Promise.all(dirs.map((d) => reloadDir(d)));
}

/** Expand every folder on the way to `path` (reading each as needed). */
async function expandPath(path: string): Promise<void> {
  const { root } = get();
  if (!root) return;
  const rel = relativeTo(root, path, platform);
  if (rel === null) return;
  let current = root;
  for (const part of segments(rel)) {
    if (!get().listings[current]) await loadDir(current);
    const entry = get().listings[current]?.find(
      (e) => pathKey(e.name, platform) === pathKey(part, platform),
    );
    if (!entry || entry.kind !== 'directory') return;
    current = entry.path;
    if (!get().expanded.has(current)) await expand(current);
  }
}

/** Reveal a file or folder: open its parents, select it and put the keyboard position on it. */
export async function reveal(path: string): Promise<void> {
  const { root } = get();
  if (!root) return;
  const rel = relativeTo(root, path, platform);
  if (rel === null || rel === '') return;
  const parent = dirname(path);
  await expandPath(parent);
  const canonical = get().listings[parent]?.find(
    (e) => pathKey(e.name, platform) === pathKey(basename(path), platform),
  )?.path;
  if (canonical) set({ selected: new Set([canonical]), anchor: canonical, focused: canonical });
}

// --- changes from outside -------------------------------------------------------------------

let pendingDirs = new Set<string>();
let reloadTimer: ReturnType<typeof setTimeout> | undefined;

/** Patch what is loaded after file system changes: re-read only the folders that changed. */
export function applyFsChanges(changes: readonly FsChange[]): void {
  const { root } = get();
  if (!root) return;
  if (changes.some((c) => c.resync)) {
    for (const dir of Object.keys(get().listings)) pendingDirs.add(dir);
  } else {
    for (const change of changes) {
      if (change.type === 'update') continue;
      const parent = dirname(change.path);
      if (get().listings[parent]) pendingDirs.add(parent);
      if (change.type === 'delete' && get().listings[change.path]) {
        set((s) => forgetSubtree(s, change.path, platform));
      }
    }
  }
  if (pendingDirs.size === 0) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    const dirs = [...pendingDirs];
    pendingDirs = new Set();
    void Promise.all(dirs.map((d) => reloadDir(d)));
  }, RELOAD_DEBOUNCE_MS);
}

// --- selection ------------------------------------------------------------------------------

export function select(
  path: string,
  mode: 'single' | 'toggle' | 'range',
  rowPaths: readonly string[],
): void {
  const state = get();
  if (mode === 'single') {
    set({ selected: new Set([path]), anchor: path, focused: path });
  } else if (mode === 'toggle') {
    const selected = new Set(state.selected);
    if (selected.has(path)) selected.delete(path);
    else selected.add(path);
    set({ selected, anchor: path, focused: path });
  } else {
    const from = rowPaths.indexOf(state.anchor ?? path);
    const to = rowPaths.indexOf(path);
    if (from === -1 || to === -1)
      return set({ selected: new Set([path]), anchor: path, focused: path });
    const [a, b] = from < to ? [from, to] : [to, from];
    set({ selected: new Set(rowPaths.slice(a, b + 1)), focused: path });
  }
}

export function setFocused(path: string | null): void {
  if (get().focused !== path) set({ focused: path });
}

export function selectedPaths(): string[] {
  return [...get().selected];
}

// --- inline editing -------------------------------------------------------------------------

/** Where a new item goes: the selected folder, the folder of the selected file, or the root. */
export function createTarget(): string | null {
  const { root, focused } = get();
  if (!root) return null;
  if (!focused) return root;
  return isFolder(focused) ? focused : dirname(focused);
}

function isFolder(path: string): boolean {
  const parent = dirname(path);
  return get().listings[parent]?.some((e) => e.path === path && e.kind === 'directory') ?? false;
}

export async function startCreate(kind: 'file' | 'directory', parent?: string): Promise<void> {
  const target = parent ?? createTarget();
  if (!target) return;
  if (target !== get().root) await expand(target);
  else if (!get().listings[target]) await loadDir(target);
  set({ edit: { type: 'create', kind, parent: target } });
}

export function startRename(path: string): void {
  set({ edit: { type: 'rename', path } });
}

export function cancelEdit(): void {
  if (get().edit) set({ edit: null });
}

// --- file operations ------------------------------------------------------------------------

function siblingsOf(dir: string): string[] {
  return (get().listings[dir] ?? []).map((e) => e.name);
}

export function siblingNames(dir: string): string[] {
  return siblingsOf(dir);
}

/** Create a file or folder from the inline input. Resolves the new path, or null on failure. */
export async function commitCreate(name: string): Promise<string | null> {
  const edit = get().edit;
  if (!edit || edit.type !== 'create') return null;
  const path = join(
    edit.parent,
    ...name
      .trim()
      .split(/[\\/]+/)
      .filter(Boolean),
  );
  set({ edit: null });
  try {
    if (edit.kind === 'file') {
      await ipc.invoke('fs:createFile', path);
    } else {
      await ipc.invoke('fs:createDir', path);
    }
  } catch (error) {
    fail(`Could not create ${basename(path)}.`, error);
    return null;
  }
  await reloadDir(edit.parent);
  await reveal(path);
  if (edit.kind === 'file') await service('commands').execute('editor.openFile', { path });
  return path;
}

export async function commitRename(newName: string): Promise<void> {
  const edit = get().edit;
  if (!edit || edit.type !== 'rename') return;
  const from = edit.path;
  const to = join(dirname(from), newName.trim());
  set({ edit: null });
  if (to === from) return;
  try {
    await ipc.invoke('fs:rename', from, to);
  } catch (error) {
    fail(`Could not rename ${basename(from)}.`, error);
    return;
  }
  if (hasService('editor')) service('editor').renamePath(from, to);
  await reloadDir(dirname(from));
  await reveal(to);
}

export async function deleteEntries(paths: readonly string[]): Promise<void> {
  const targets = topmostPaths(paths, platform);
  if (targets.length === 0) return;
  if (getSetting('files.confirmDelete')) {
    const single = targets.length === 1;
    const ok = await service('dialogs').confirm({
      title: single
        ? `Move ${basename(targets[0] as string)} to the trash?`
        : `Move ${targets.length} items to the trash?`,
      message: 'You can restore them from the trash.',
      confirmLabel: 'Move to trash',
      danger: true,
    });
    if (!ok) return;
  }
  try {
    await ipc.invoke('fs:trash', [...targets]);
  } catch (error) {
    fail('Could not move the items to the trash.', error);
  }
  for (const target of targets) {
    if (hasService('editor')) service('editor').closeFilesUnder(target);
  }
  const parents = new Set(targets.map((t) => dirname(t)));
  await Promise.all([...parents].map((p) => reloadDir(p)));
  set({ selected: new Set(), anchor: null });
}

export async function duplicateEntries(paths: readonly string[]): Promise<void> {
  for (const source of topmostPaths(paths, platform)) {
    const dir = dirname(source);
    const name = uniqueCopyName(basename(source), siblingsOf(dir), platform);
    try {
      await ipc.invoke('fs:copy', source, join(dir, name));
    } catch (error) {
      fail(`Could not duplicate ${basename(source)}.`, error);
    }
    await reloadDir(dir);
  }
}

export function copyToClipboard(paths: readonly string[], mode: 'copy' | 'cut'): void {
  set({ clipboard: paths.length > 0 ? { paths: topmostPaths(paths, platform), mode } : null });
}

type Conflict = 'overwrite' | 'skip' | 'cancel';

async function askConflict(name: string): Promise<Conflict> {
  const choice = await service('dialogs').choose({
    title: `${name} already exists`,
    message: 'A file or folder with this name is already in the destination.',
    buttons: [
      { label: 'Replace', danger: true },
      { label: 'Skip' },
      { label: 'Cancel', primary: true },
    ],
    cancelIndex: 2,
  });
  return choice === 0 ? 'overwrite' : choice === 1 ? 'skip' : 'cancel';
}

/** Move or copy items into a folder, resolving name clashes. Used by paste and by drag and drop. */
export async function transfer(
  sources: readonly string[],
  folder: string,
  mode: 'copy' | 'move',
): Promise<void> {
  const touched = new Set<string>([folder]);
  let last: string | null = null;
  for (const source of topmostPaths(sources, platform)) {
    let destination = destinationFor(source, folder);
    if (pathKey(destination, platform) === pathKey(source, platform)) {
      if (mode === 'move') continue;
      destination = join(folder, uniqueCopyName(basename(source), siblingsOf(folder), platform));
    }
    let overwrite = false;
    const exists = siblingsOf(folder).some(
      (n) => pathKey(n, platform) === pathKey(basename(destination), platform),
    );
    if (exists) {
      if (mode === 'copy') {
        destination = join(folder, uniqueCopyName(basename(source), siblingsOf(folder), platform));
      } else {
        const answer = await askConflict(basename(destination));
        if (answer === 'cancel') break;
        if (answer === 'skip') continue;
        overwrite = true;
      }
    }
    try {
      if (mode === 'copy') {
        await ipc.invoke('fs:copy', source, destination);
      } else {
        await ipc.invoke('fs:rename', source, destination, { overwrite });
        if (hasService('editor')) service('editor').renamePath(source, destination);
      }
      touched.add(dirname(source));
      last = destination;
    } catch (error) {
      fail(`Could not ${mode === 'copy' ? 'copy' : 'move'} ${basename(source)}.`, error);
    }
  }
  await Promise.all([...touched].map((d) => reloadDir(d)));
  if (last) await reveal(last);
}

export async function paste(folder: string): Promise<void> {
  const clip = get().clipboard;
  if (!clip) return;
  const sources = clip.paths;
  if (clip.mode === 'cut') {
    set({ clipboard: null });
    await transfer(sources, folder, 'move');
  } else {
    await transfer(sources, folder, 'copy');
  }
}

/** Drag and drop: `copy` is true when a modifier key asked for a copy. */
export async function dropOn(
  sources: readonly string[],
  targetPath: string,
  targetIsDirectory: boolean,
  copy: boolean,
): Promise<void> {
  const verdict = checkDrop(sources, targetPath, targetIsDirectory, platform);
  if (!verdict.ok) {
    if (verdict.reason !== 'The items are already in this folder.') notify().info(verdict.reason);
    return;
  }
  await expand(verdict.target);
  await transfer(sources, verdict.target, copy ? 'copy' : 'move');
}

/** True when `path` is inside the workspace root. */
export function inWorkspace(path: string): boolean {
  const { root } = get();
  return !!root && isWithin(root, path, platform);
}
