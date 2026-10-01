import { create } from 'zustand';
import type { GitAvailability, GitStatus } from '@shared/api/git';
import { describeError } from '@shared/errors';
import { dirname, isWithin, pathKey, type Platform } from '@shared/paths';
import { ipc, platform as hostPlatform } from '../services/ipc';
import { hasService, service } from '../services/registry';
import { getSetting } from '../state/settings-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { decorationOf, type GitDecoration } from './decorations';

const platform = hostPlatform as Platform;

/**
 * Public surface of the source control slice that other slices (explorer, editor, status bar) use.
 * The scm slice implements the loading; keep these export names and shapes stable.
 */
export { decorationOf, type GitDecoration, type GitTone } from './decorations';

interface GitState {
  /** null = not a repository (or Git disabled); undefined = still loading. */
  status: GitStatus | null | undefined;
  availability: GitAvailability | null;
  available: boolean | null;
  /** The last failure to read the status, in plain language. */
  error: string | null;
  /** Bumped on every status change so consumers can memoize lookups. */
  version: number;
}

export const useGitStore = create<GitState>(() => ({
  status: undefined,
  availability: null,
  available: null,
  error: null,
  version: 0,
}));

// --- decorations ----------------------------------------------------------------------------

let decorations = new Map<string, GitDecoration>();
let changedFolders = new Set<string>();

function rebuild(status: GitStatus | null | undefined): void {
  decorations = new Map();
  changedFolders = new Set();
  if (!status) return;
  for (const file of status.files) {
    const decoration = decorationOf(file);
    if (!decoration || decoration.tone === 'ignored') continue;
    decorations.set(pathKey(file.path, platform), decoration);
    let folder = dirname(file.path);
    for (let guard = 0; guard < 256; guard++) {
      const key = pathKey(folder, platform);
      if (changedFolders.has(key)) break;
      changedFolders.add(key);
      if (!isWithin(status.repo.root, folder, platform)) break;
      const parent = dirname(folder);
      if (parent === folder) break;
      folder = parent;
    }
  }
}

/** Decoration for a file, or null. */
export function decorationFor(path: string): GitDecoration | null {
  return decorations.get(pathKey(path, platform)) ?? null;
}

/** True when some file below the folder has changes. */
export function folderHasChanges(path: string): boolean {
  return changedFolders.has(pathKey(path, platform));
}

// --- loading --------------------------------------------------------------------------------

function applyStatus(status: GitStatus | null): void {
  rebuild(status);
  useGitStore.setState((s) => ({ status, error: null, version: s.version + 1 }));
  syncContextKeys();
}

function syncContextKeys(): void {
  if (!hasService('contextKeys')) return;
  const keys = service('contextKeys');
  const { available, status } = useGitStore.getState();
  keys.set('gitAvailable', available === true);
  keys.set('gitRepo', !!status);
}

/** Detect Git and read the status of the open folder. */
export async function loadGit(): Promise<void> {
  const enabled = getSetting('git.enabled');
  if (!enabled || !useWorkspaceStore.getState().workspace) {
    useGitStore.setState((s) => ({
      available: enabled ? s.available : false,
      version: s.version + 1,
    }));
    applyStatus(null);
    return;
  }
  try {
    const availability = await ipc.invoke('git:detect');
    useGitStore.setState({ availability, available: availability.available });
    if (!availability.available) {
      applyStatus(null);
      return;
    }
    applyStatus(await ipc.invoke('git:status'));
  } catch (error) {
    useGitStore.setState((s) => ({ error: describeError(error), version: s.version + 1 }));
    applyStatus(null);
  }
}

export async function refreshGit(): Promise<void> {
  try {
    applyStatus(await ipc.invoke('git:refresh'));
  } catch (error) {
    useGitStore.setState((s) => ({ error: describeError(error), version: s.version + 1 }));
  }
}

/** Follow the workspace, the status events from the main process and the Git settings. */
export function startGitSync(): void {
  void loadGit();
  ipc.on('git:statusChanged', (status) => applyStatus(status));
  let root = useWorkspaceStore.getState().workspace?.root ?? null;
  useWorkspaceStore.subscribe((state) => {
    const next = state.workspace?.root ?? null;
    if (next === root) return;
    root = next;
    useGitStore.setState({ status: undefined });
    void loadGit();
  });
}
