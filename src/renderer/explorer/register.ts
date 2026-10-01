import type { CommandArgs } from '@shared/commands/catalog';
import { relativeTo, type Platform } from '@shared/paths';
import { ipc, platform as hostPlatform } from '../services/ipc';
import { service } from '../services/registry';
import { useLayoutStore } from '../state/layout-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { copyText } from '../ui/clipboard';
import {
  applyFsChanges,
  collapseAll,
  copyToClipboard,
  deleteEntries,
  duplicateEntries,
  openRoot,
  paste,
  refreshAll,
  reveal,
  selectedPaths,
  startCreate,
  startRename,
  useExplorerStore,
  createTarget,
} from './explorer-store';

const platform = hostPlatform as Platform;

/** Provides the explorer's commands and keeps the tree in step with the workspace and the editor. */
export function register(): void {
  const commands = service('commands');
  const contextKeys = service('contextKeys');
  const run = (id: string, handler: (args?: never) => unknown) => commands.register(id, handler);

  // The tree follows the open folder.
  let root = useWorkspaceStore.getState().workspace?.root ?? null;
  void openRoot(root);
  useWorkspaceStore.subscribe((state) => {
    const next = state.workspace?.root ?? null;
    if (next === root) return;
    root = next;
    void openRoot(next);
  });

  ipc.on('fs:changed', applyFsChanges);

  // Focus inside the tree enables the explorer keybindings (rename, delete, copy, paste).
  const syncFocus = () => {
    const active = document.activeElement;
    contextKeys.set(
      'explorerFocus',
      !!active && !!active.closest('[data-region="sidebar"] .explorer'),
    );
  };
  document.addEventListener('focusin', syncFocus, true);
  document.addEventListener('focusout', () => queueMicrotask(syncFocus), true);

  // The tree follows the active editor, without taking keyboard focus.
  service('editor').onDidChangeActivePath((path) => {
    const layout = useLayoutStore.getState();
    if (path && layout.sidebarVisible && layout.sidebarView === 'explorer') void reveal(path);
  });

  run('explorer.newFile', () => startCreate('file'));
  run('explorer.newFolder', () => startCreate('directory'));
  run('explorer.rename', () => {
    const selected = selectedPaths();
    const path = selected.length === 1 ? selected[0] : useExplorerStore.getState().focused;
    if (path) startRename(path);
  });
  run('explorer.delete', () => deleteEntries(selectedPaths()));
  run('explorer.copy', () => copyToClipboard(selectedPaths(), 'copy'));
  run('explorer.cut', () => copyToClipboard(selectedPaths(), 'cut'));
  run('explorer.paste', () => {
    const target = createTarget();
    return target ? paste(target) : undefined;
  });
  run('explorer.duplicate', () => duplicateEntries(selectedPaths()));
  run('explorer.refresh', () => refreshAll());
  run('explorer.collapseAll', () => collapseAll());
  run('explorer.copyPath', () => copyText(selectedPaths().join('\n')));
  run('explorer.copyRelativePath', () =>
    copyText(
      selectedPaths()
        .map((p) => (root ? relativeTo(root, p, platform) : null) ?? p)
        .join('\n'),
    ),
  );
  run('explorer.revealInOS', () => {
    const path = selectedPaths()[0];
    return path ? ipc.invoke('fs:reveal', path) : undefined;
  });
  run('explorer.reveal', ((args?: CommandArgs['explorer.reveal']) => {
    if (!args?.path) return undefined;
    service('layout').showSidebar('explorer', { focus: false });
    return reveal(args.path);
  }) as never);
  run('explorer.openToSide', async () => {
    const path = selectedPaths()[0];
    if (!path) return;
    const editor = service('editor');
    // Show the file in a second group on the right.
    await editor.openFile(path, { preview: false, focus: true });
    await commands.execute('editor.splitRight');
  });
  run('explorer.findInFolder', () => {
    const path = selectedPaths()[0];
    if (!path || !root) return undefined;
    const rel = relativeTo(root, path, platform) ?? '';
    return commands.execute('search.findInFiles', { include: rel });
  });
}
