import { BrowserWindow, app, ipcMain } from 'electron';
import type { AppInfo } from '@shared/api/app';
import { toIncError, IncError } from '@shared/errors';
import { APP_ORIGIN, type EventChannel, type EventMap, type IpcEnvelope } from '@shared/ipc';
import type { Platform } from '@shared/paths';
import {
  Emitter,
  createDefaultPolicyHost,
  createDefaultSettingsHost,
  createDefaultWorkspaceHost,
  type Handler,
  type Kernel,
  type Logger,
} from './kernel';

export function buildAppInfo(): AppInfo {
  return {
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform as Platform,
    arch: process.arch,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    userDataDir: app.getPath('userData'),
    logDir: app.getPath('logs'),
    isPackaged: app.isPackaged,
    isDev: !app.isPackaged,
    locale: app.getLocale(),
  };
}

/** IPC is only accepted from frames served by the app's own origin. */
function isTrustedSender(url: string | undefined): boolean {
  return typeof url === 'string' && (url === APP_ORIGIN || url.startsWith(APP_ORIGIN + '/'));
}

export function createKernel(info: AppInfo, logger: Logger): Kernel {
  const created = new Emitter<number>();
  const closed = new Emitter<number>();

  const kernel: Kernel = {
    info,
    logger,
    settings: createDefaultSettingsHost(),
    policy: createDefaultPolicyHost(),
    workspaces: createDefaultWorkspaceHost(),
    fsChanges: new Emitter(),

    handle(channel, handler: Handler<typeof channel>) {
      ipcMain.handle(channel, async (event, ...args): Promise<IpcEnvelope> => {
        if (!isTrustedSender(event.senderFrame?.url)) {
          logger.warn(`Rejected IPC ${channel} from untrusted frame: ${event.senderFrame?.url}`);
          return {
            ok: false,
            error: new IncError('E_PERMISSION', 'Untrusted sender').toJSON(),
          };
        }
        const windowId = BrowserWindow.fromWebContents(event.sender)?.id;
        if (windowId === undefined) {
          return { ok: false, error: new IncError('E_INVALID', 'No window for sender').toJSON() };
        }
        try {
          const value = await (handler as (...a: unknown[]) => unknown)({ windowId }, ...args);
          return { ok: true, value };
        } catch (e) {
          const err = toIncError(e);
          logger.debug(`IPC ${channel} failed: ${err.code} ${err.message}`);
          return { ok: false, error: err.toJSON() };
        }
      });
    },

    send<K extends EventChannel>(windowId: number, channel: K, payload: EventMap[K]) {
      const win = BrowserWindow.fromId(windowId);
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send(channel, payload);
      }
    },

    broadcast<K extends EventChannel>(channel: K, payload: EventMap[K]) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
          win.webContents.send(channel, payload);
        }
      }
    },

    getWindow: (id) => BrowserWindow.fromId(id) ?? undefined,
    getWindowIds: () => BrowserWindow.getAllWindows().map((w) => w.id),
    onWindowCreated: (cb) => created.on(cb),
    onWindowClosed: (cb) => closed.on(cb),
  };

  app.on('browser-window-created', (_e, win) => {
    const id = win.id;
    created.emit(id);
    win.once('closed', () => closed.emit(id));
  });

  return kernel;
}
