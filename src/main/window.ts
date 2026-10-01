import { BrowserWindow, nativeTheme, shell } from 'electron';
import path from 'node:path';
import { APP_ORIGIN } from '@shared/ipc';
import type { Kernel } from './kernel';

const TITLEBAR_HEIGHT = 36;
const isMac = process.platform === 'darwin';
/** End-to-end runs set INC_TEST_HIDDEN=1 so automated windows never appear on the desktop. */
const hiddenForTests = process.env.INC_TEST_HIDDEN === '1';

const FALLBACK = {
  dark: { bg: '#161b22', fg: '#c9d1d9' },
  light: { bg: '#f3f5f7', fg: '#2b3138' },
};

/**
 * Create a hardened application window. The renderer is sandboxed, isolated, has no Node
 * integration and can navigate nowhere except the app origin.
 */
export function createWindow(kernel: Kernel): BrowserWindow {
  const scheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  const colors = FALLBACK[scheme];

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: kernel.info.name,
    backgroundColor: colors.bg,
    titleBarStyle: 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 14, y: 11 } }
      : { titleBarOverlay: { color: colors.bg, symbolColor: colors.fg, height: TITLEBAR_HEIGHT } }),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      allowRunningInsecureContent: false,
      devTools: true,
      // Hidden test windows must not be throttled, or timers and animation frames stall.
      backgroundThrottling: !hiddenForTests,
    },
  });

  if (!hiddenForTests) win.once('ready-to-show', () => win.show());

  // Web content never opens windows or navigates away from the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url).catch(() => undefined);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(APP_ORIGIN + '/')) event.preventDefault();
  });
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());

  void win.loadURL(`${APP_ORIGIN}/index.html`);
  return win;
}
