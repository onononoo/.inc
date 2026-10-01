import type { Disposable, Kernel } from '../kernel';
import { GitLocator, GitSession, createHooksDirProvider } from './service';

/**
 * Git slice: status, diff content, staging, commits, branches and remote operations on top of the
 * Git command line. One session per window; sessions follow the window's workspace and trust state.
 */
export function register(kernel: Kernel): Disposable {
  const locator = new GitLocator();
  const hooksDir = createHooksDirProvider(kernel.info.userDataDir);
  const sessions = new Map<number, GitSession>();

  const sessionFor = (windowId: number): GitSession => {
    let session = sessions.get(windowId);
    if (!session) {
      session = new GitSession(kernel, windowId, locator, hooksDir);
      sessions.set(windowId, session);
    }
    return session;
  };

  const drop = (windowId: number) => {
    sessions.get(windowId)?.dispose();
    sessions.delete(windowId);
  };

  const warm = (windowId: number) => {
    void sessionFor(windowId)
      .status()
      .catch((error) => kernel.logger.debug('Initial Git status failed', error));
  };

  const subscriptions = [
    kernel.workspaces.onDidChangeRoot(({ windowId, root }) => {
      drop(windowId);
      if (root) warm(windowId);
    }),
    kernel.workspaces.onDidChangeTrust(({ windowId }) => {
      const session = sessions.get(windowId);
      if (!session) return;
      session.reset();
      void session.refresh().catch((error) => kernel.logger.debug('Git refresh failed', error));
    }),
    kernel.fsChanges.on(({ windowId, changes }) => sessions.get(windowId)?.onFilesChanged(changes)),
    kernel.onWindowClosed(drop),
    kernel.settings.onDidChange(({ windowId, keys }) => {
      const affected = keys.some((k) => k === 'git.enabled' || k === 'git.path');
      if (affected) locator.clear();
      const ids =
        windowId === null ? [...sessions.keys()] : sessions.has(windowId) ? [windowId] : [];
      for (const id of ids) {
        const session = sessions.get(id);
        if (!session) continue;
        if (affected) {
          session.reset();
          void session.refresh().catch((error) => kernel.logger.debug('Git refresh failed', error));
        }
        if (keys.includes('git.autoFetch')) session.syncAutoFetch();
      }
    }),
  ];

  kernel.handle('git:detect', ({ windowId }) => sessionFor(windowId).detect());
  kernel.handle('git:status', ({ windowId }) => sessionFor(windowId).status());
  kernel.handle('git:refresh', ({ windowId }) => sessionFor(windowId).refresh());
  kernel.handle('git:stage', ({ windowId }, paths) => sessionFor(windowId).stage(paths));
  kernel.handle('git:unstage', ({ windowId }, paths) => sessionFor(windowId).unstage(paths));
  kernel.handle('git:discard', ({ windowId }, paths) => sessionFor(windowId).discard(paths));
  kernel.handle('git:stageAll', ({ windowId }) => sessionFor(windowId).stageAll());
  kernel.handle('git:unstageAll', ({ windowId }) => sessionFor(windowId).unstageAll());
  kernel.handle('git:commit', ({ windowId }, request) => sessionFor(windowId).commit(request));
  kernel.handle('git:show', ({ windowId }, file, ref) => sessionFor(windowId).show(file, ref));
  kernel.handle('git:branches', ({ windowId }) => sessionFor(windowId).branches());
  kernel.handle('git:checkout', ({ windowId }, ref) => sessionFor(windowId).checkout(ref));
  kernel.handle('git:createBranch', ({ windowId }, name, checkout) =>
    sessionFor(windowId).createBranch(name, checkout),
  );
  kernel.handle('git:fetch', ({ windowId }) => sessionFor(windowId).fetch());
  kernel.handle('git:pull', ({ windowId }) => sessionFor(windowId).pull());
  kernel.handle('git:push', ({ windowId }) => sessionFor(windowId).push());
  kernel.handle('git:log', ({ windowId }, options) => sessionFor(windowId).log(options));
  kernel.handle('git:init', ({ windowId }) => sessionFor(windowId).init());

  for (const id of kernel.getWindowIds()) {
    if (kernel.workspaces.getRoot(id)) warm(id);
  }

  return () => {
    for (const off of subscriptions) off();
    for (const id of [...sessions.keys()]) drop(id);
  };
}
