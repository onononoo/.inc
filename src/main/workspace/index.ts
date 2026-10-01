import { app } from 'electron';
import type { Disposable, Kernel } from '../kernel';
import { WorkspaceService, type WorkspaceEnv } from './service';

const TRUST_SETTING = 'security.workspaceTrust';

/** Windows and macOS keep their own "recent documents" list (jump list, Dock menu). */
function operatingSystemRecents(): WorkspaceEnv['osRecents'] {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return undefined;
  return {
    add: (folder) => app.addRecentDocument(folder),
    clear: () => app.clearRecentDocuments(),
  };
}

/**
 * Workspace slice: open/close folder, workspace trust, recent workspaces, session persistence.
 * Replaces `kernel.workspaces`.
 */
export function register(kernel: Kernel): Disposable {
  const service = new WorkspaceService({
    userDataDir: kernel.info.userDataDir,
    platform: kernel.info.platform,
    logger: kernel.logger,
    isTrustEnabled() {
      // Read at call time: the settings slice and policy can change underneath us. The
      // app-wide value is used on purpose, so a workspace can never switch its own trust off.
      const policy = kernel.policy.state;
      const enforced = policy.values[TRUST_SETTING];
      if (policy.lockedKeys.includes(TRUST_SETTING) && typeof enforced === 'boolean') {
        return enforced;
      }
      return kernel.settings.get(null, TRUST_SETTING) !== false;
    },
    notify: (windowId, info) => kernel.send(windowId, 'workspace:changed', info),
    hasWindow: (windowId) => kernel.getWindow(windowId) !== undefined,
    osRecents: operatingSystemRecents(),
  });

  kernel.workspaces = service;

  kernel.handle('workspace:get', ({ windowId }) => service.getInfo(windowId));
  kernel.handle('workspace:open', ({ windowId }, path) => service.open(windowId, path));
  kernel.handle('workspace:close', ({ windowId }) => service.close(windowId));
  kernel.handle('workspace:setTrust', ({ windowId }, trusted) =>
    service.setTrust(windowId, trusted),
  );
  kernel.handle('workspace:getRecent', () => service.getRecent());
  kernel.handle('workspace:removeRecent', (_ctx, path) => service.removeRecent(path));
  kernel.handle('workspace:clearRecent', () => service.clearRecent());
  kernel.handle('session:load', ({ windowId }) => service.loadSession(windowId));
  kernel.handle('session:save', ({ windowId }, blob) => service.saveSession(windowId, blob));

  const subscriptions = [
    kernel.settings.onDidChange((e) => {
      if (e.keys.includes(TRUST_SETTING)) service.refreshTrustMode();
    }),
    kernel.policy.onDidChange(() => service.refreshTrustMode()),
    kernel.onWindowClosed((windowId) => service.releaseWindow(windowId)),
  ];

  void service.pruneStaleSessions();

  return () => {
    for (const unsubscribe of subscriptions) unsubscribe();
  };
}
