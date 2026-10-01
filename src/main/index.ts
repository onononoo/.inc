import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { buildAppInfo, createKernel } from './app';
import { createLogger } from './logger';
import { lockDownSession, registerAppProtocol, registerAppScheme } from './protocol';
import { registerAll } from './register-all';
import { createWindow } from './window';

// Tests and portable/managed deployments can relocate all user data.
const userDataOverride = process.env.INC_USER_DATA_DIR;
if (userDataOverride) app.setPath('userData', path.resolve(userDataOverride));

registerAppScheme();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  void app.whenReady().then(() => {
    const info = buildAppInfo();
    const logger = createLogger(info.logDir);
    logger.info(`Starting ${info.name} ${info.version} on ${info.platform}/${info.arch}`);

    registerAppProtocol(path.join(__dirname, '..', 'renderer'), logger);
    lockDownSession(logger);

    const kernel = createKernel(info, logger);
    registerAll(kernel);
    createWindow(kernel);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(kernel);
    });
    app.on('second-instance', () => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        if (win.isMinimized()) win.restore();
        win.focus();
      } else {
        createWindow(kernel);
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
