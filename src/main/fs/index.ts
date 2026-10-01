import { shell } from 'electron';
import path from 'node:path';
import type { FileSearchResult } from '@shared/api/fs';
import { isWithin } from '@shared/paths';
import type { Disposable, Kernel } from '../kernel';
import { EditorConfigResolver } from './editorconfig';
import { enabledPatterns, compileGlobs, isEntryExcluded } from './excludes';
import { requireAbsolute } from './errors';
import { FileIndex } from './file-index';
import { copyPath, createEmptyFile, createFolder, movePath, trashPaths } from './fs-ops';
import { readDirectory } from './read-dir';
import { pathExists, statPath } from './stat';
import { readFileBytes, readTextFile, writeTextFile } from './text-file';
import { WindowWatcher } from './watcher';

const MIB = 1024 * 1024;
const DEFAULT_BYTES_CAP = 32 * MIB;
const MAX_BYTES_CAP = 256 * MIB;
const DEFAULT_SEARCH_LIMIT = 100;
const EMPTY_SEARCH: FileSearchResult = { items: [], total: 0, indexing: false, indexedCount: 0 };

interface WindowState {
  watcher: WindowWatcher;
  editorConfig: EditorConfigResolver;
  index: FileIndex | null;
  root: string | null;
}

/**
 * File system slice: fs:* handlers, native file watching, the quick-open file index (files:search)
 * and EditorConfig resolution. Everything is per window and follows the window's workspace root.
 */
export function register(kernel: Kernel): Disposable {
  const states = new Map<number, WindowState>();
  const platform = kernel.info.platform;

  const rootOf = (windowId: number) => kernel.workspaces.getRoot(windowId);

  function attachRoot(windowId: number, state: WindowState, root: string | null): void {
    state.root = root;
    state.index?.dispose();
    state.index = null;
    state.editorConfig.clear();
    void state.watcher
      .setRoot(root)
      .catch((error) => kernel.logger.warn('Could not watch the workspace', error));
    if (!root) return;
    const index = new FileIndex({
      root,
      platform,
      getExcludes: () => kernel.settings.get(windowId, 'files.exclude'),
      gitPath: 'git',
      onProgress: (progress) => kernel.send(windowId, 'files:indexProgress', progress),
    });
    state.index = index;
    void index.build().catch((error) => kernel.logger.warn('Could not index the workspace', error));
  }

  function stateFor(windowId: number): WindowState {
    let state = states.get(windowId);
    if (!state) {
      const created: WindowState = {
        watcher: new WindowWatcher({
          logger: kernel.logger,
          platform,
          getIgnore: () => enabledPatterns(kernel.settings.get(windowId, 'files.watcherExclude')),
          emit: (changes) => {
            created.editorConfig.noteChanges(changes.map((c) => c.path));
            void created.index?.apply(changes);
            kernel.send(windowId, 'fs:changed', changes);
            kernel.fsChanges.emit({ windowId, changes });
          },
        }),
        editorConfig: new EditorConfigResolver(),
        index: null,
        root: null,
      };
      states.set(windowId, created);
      state = created;
      attachRoot(windowId, state, rootOf(windowId));
    }
    return state;
  }

  const releaseWindow = (windowId: number) => {
    const state = states.get(windowId);
    if (!state) return;
    states.delete(windowId);
    state.index?.dispose();
    void state.watcher.dispose();
  };

  const subscriptions = [
    kernel.workspaces.onDidChangeRoot(({ windowId, root }) =>
      attachRoot(windowId, stateFor(windowId), root),
    ),
    kernel.onWindowClosed(releaseWindow),
    kernel.settings.onDidChange(({ windowId, keys }) => {
      const ids = windowId === null ? [...states.keys()] : states.has(windowId) ? [windowId] : [];
      for (const id of ids) {
        const state = states.get(id);
        if (!state) continue;
        if (keys.includes('files.watcherExclude')) {
          void state.watcher
            .refreshIgnore()
            .catch((error) => kernel.logger.warn('Could not refresh watcher', error));
        }
        if (keys.includes('files.exclude') && state.index) void state.index.build();
        if (keys.includes('files.useEditorConfig')) state.editorConfig.clear();
      }
    }),
  ];

  kernel.handle('fs:readDir', async ({ windowId }, target, options) => {
    const dir = requireAbsolute(target);
    const root = rootOf(windowId);
    let exclude: ((name: string, isDirectory: boolean) => boolean) | undefined;
    if (options?.applyExcludes !== false && root && isWithin(root, dir, platform)) {
      const test = compileGlobs(enabledPatterns(kernel.settings.get(windowId, 'files.exclude')));
      const base = path.relative(root, dir).split(path.sep).join('/');
      exclude = (name, isDirectory) =>
        isEntryExcluded(test, base ? `${base}/${name}` : name, isDirectory);
    }
    return readDirectory(dir, { exclude });
  });
  kernel.handle('fs:stat', (_ctx, target) => statPath(requireAbsolute(target)));
  kernel.handle('fs:exists', (_ctx, target) => pathExists(requireAbsolute(target)));
  kernel.handle('fs:readFile', ({ windowId }, target, options) =>
    readTextFile(requireAbsolute(target), {
      encoding: options?.encoding,
      maxBytes: options?.maxBytes ?? kernel.settings.get(windowId, 'editor.maxFileSizeMB') * MIB,
    }),
  );
  kernel.handle('fs:readBytes', (_ctx, target, maxBytes) =>
    readFileBytes(requireAbsolute(target), Math.min(maxBytes ?? DEFAULT_BYTES_CAP, MAX_BYTES_CAP)),
  );
  kernel.handle('fs:writeFile', (_ctx, target, content, options) =>
    writeTextFile(requireAbsolute(target), String(content), options ?? {}),
  );
  kernel.handle('fs:createFile', (_ctx, target) => createEmptyFile(requireAbsolute(target)));
  kernel.handle('fs:createDir', (_ctx, target) => createFolder(requireAbsolute(target)));
  kernel.handle('fs:rename', (_ctx, from, to, options) =>
    movePath(
      requireAbsolute(from, 'source path'),
      requireAbsolute(to, 'destination path'),
      options,
    ),
  );
  kernel.handle('fs:copy', (_ctx, from, to, options) =>
    copyPath(
      requireAbsolute(from, 'source path'),
      requireAbsolute(to, 'destination path'),
      options,
    ),
  );
  kernel.handle('fs:trash', ({ windowId }, paths) => {
    const root = rootOf(windowId);
    return trashPaths(
      paths.map((p) => requireAbsolute(p)),
      { trashItem: (target) => shell.trashItem(target), protectedPaths: root ? [root] : [] },
    );
  });
  kernel.handle('fs:reveal', (_ctx, target) => {
    shell.showItemInFolder(requireAbsolute(target));
  });
  kernel.handle('fs:watch', ({ windowId }, target, recursive) =>
    stateFor(windowId).watcher.watchExtra(requireAbsolute(target), recursive === true),
  );
  kernel.handle('fs:unwatch', ({ windowId }, handle) => stateFor(windowId).watcher.unwatch(handle));

  kernel.handle('files:search', ({ windowId }, query, limit) => {
    const state = stateFor(windowId);
    if (!state.index) return EMPTY_SEARCH;
    return state.index.search(String(query ?? ''), limit ?? DEFAULT_SEARCH_LIMIT);
  });
  kernel.handle('editorconfig:resolve', ({ windowId }, target) => {
    if (!kernel.settings.get(windowId, 'files.useEditorConfig')) return null;
    return stateFor(windowId).editorConfig.resolve(requireAbsolute(target));
  });

  // Windows opened before this slice registered (or that never made a call) are picked up lazily.
  for (const id of kernel.getWindowIds()) stateFor(id);

  return () => {
    for (const off of subscriptions) off();
    for (const id of [...states.keys()]) releaseWindow(id);
  };
}
