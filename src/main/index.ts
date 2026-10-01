import { app } from 'electron';
import path from 'node:path';
import { buildAppInfo, createKernel } from './app';
import type { Logger } from './kernel';
import { createLogger } from './logger';
import { lockDownSession, registerAppProtocol, registerAppScheme } from './protocol';
import { registerAll } from './register-all';
import { ensureWindow, launch } from './shell';

// Everything in the renderer runs in the Chromium sandbox; enable it for every renderer process.
app.enableSandbox();

// Tests and portable/managed deployments can relocate all user data.
const userDataOverride = process.env.INC_USER_DATA_DIR;
if (userDataOverride) app.setPath('userData', path.resolve(userDataOverride));

let logger: Logger | null = null;
const report = (message: string, error: unknown) => {
  if (logger) logger.error(message, error);
  else console.error(message, error);
};
// A stray error must be recorded, not shown as a crash dialog or silently lost.
process.on('uncaughtException', (error) => report('Uncaught exception in the main process', error));
process.on('unhandledRejection', (reason) => report('Unhandled promise rejection', reason));

registerAppScheme();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // macOS can hand over documents before the app is ready.
  let ready = false;
  const earlyOpen: string[] = [];
  app.on('open-file', (event, file) => {
    event.preventDefault();
    if (ready) launch([process.execPath, file], process.cwd());
    else earlyOpen.push(file);
  });
  app.on('second-instance', (_event, argv, workingDirectory) => launch(argv, workingDirectory));

  void app.whenReady().then(() => {
    const info = buildAppInfo();
    logger = createLogger(info.logDir);
    logger.info(`Starting ${info.name} ${info.version} on ${info.platform}/${info.arch}`);

    registerAppProtocol(path.join(__dirname, '..', 'renderer'), logger);
    lockDownSession(logger);

    const kernel = createKernel(info, logger);
    registerAll(kernel);
    launch([...process.argv, ...earlyOpen], process.cwd(), { initial: true });
    ready = true;

    app.on('activate', ensureWindow);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
