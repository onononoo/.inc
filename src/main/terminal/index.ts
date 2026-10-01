import { app } from 'electron';
import os from 'node:os';
import type { Disposable, Kernel } from '../kernel';
import { TerminalService, type TerminalHost } from './service';

/**
 * Terminal slice: PTY sessions, shell profiles and task listing.
 *
 * Settings, policy and workspace state are read through the kernel on every call, because the
 * settings and workspace slices replace the kernel's default hosts after this module loads.
 */
export function register(kernel: Kernel): Disposable {
  const host: TerminalHost = {
    platform: process.platform,
    appVersion: kernel.info.version,
    env: process.env,
    logger: kernel.logger,
    homeDir: os.homedir(),
    features: () => kernel.policy.state.features,
    setting: (windowId, key) => kernel.settings.get(windowId, key),
    isTrusted: (windowId) => kernel.workspaces.isTrusted(windowId),
    workspaceRoot: (windowId) => kernel.workspaces.getRoot(windowId),
    send: (windowId, channel, payload) => kernel.send(windowId, channel, payload),
  };
  const service = new TerminalService(host);

  kernel.handle('terminal:listProfiles', ({ windowId }) => service.listProfiles(windowId));
  kernel.handle('terminal:create', ({ windowId }, options) => service.create(windowId, options));
  kernel.handle('terminal:write', ({ windowId }, id, data) => service.write(windowId, id, data));
  kernel.handle('terminal:resize', ({ windowId }, id, cols, rows) =>
    service.resize(windowId, id, cols, rows),
  );
  kernel.handle('terminal:kill', ({ windowId }, id) => service.kill(windowId, id));
  kernel.handle('terminal:ack', ({ windowId }, id, count) => service.ack(windowId, id, count));
  kernel.handle('tasks:list', ({ windowId }) => service.listTasks(windowId));

  const unsubscribeClosed = kernel.onWindowClosed((windowId) => service.disposeWindow(windowId));
  // Shells must not outlive the application; wait for them so no process is left behind.
  const onQuit = () => service.dispose(true);
  app.on('will-quit', onQuit);

  return () => {
    unsubscribeClosed();
    app.removeListener('will-quit', onQuit);
    service.dispose(true);
  };
}
