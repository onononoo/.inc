import { BrowserWindow, nativeTheme, shell } from 'electron';
import path from 'node:path';
import { APP_ORIGIN } from '@shared/ipc';
import type { Kernel } from './kernel';
import { openExternalLink } from './shell/external-links';
import { securityStats } from './shell/security-stats';

export const TITLEBAR_HEIGHT = 36;
const isMac = process.platform === 'darwin';
/** End-to-end runs set INC_TEST_HIDDEN=1 so automated windows never appear on the desktop. */
export const hiddenForTests = process.env.INC_TEST_HIDDEN === '1';

/** Colours used before the renderer has painted (and remembered from the last session). */
const FALLBACK = {
  dark: { background: '#161b22', foreground: '#c9d1d9' },
  light: { background: '#f3f5f7', foreground: '#2b3138' },
};

export interface WindowAppearance {
  scheme: 'light' | 'dark';
  background: string;
  foreground: string;
}

export interface WindowStart {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
  fullscreen: boolean;
  appearance?: WindowAppearance | null;
}

export function fallbackAppearance(): WindowAppearance {
  const scheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  return { scheme, ...FALLBACK[scheme] };
}

/**
 * Create a hardened application window. The renderer is sandboxed, isolated, has no Node
 * integration and can navigate nowhere except the app origin. The caller attaches behaviour
 * (close handshake, state events, menus) and decides what to load into it.
 */
export function createWindow(kernel: Kernel, start: WindowStart): BrowserWindow {
  const look = start.appearance ?? fallbackAppearance();

  const win = new BrowserWindow({
    x: start.x,
    y: start.y,
    width: start.width,
    height: start.height,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: kernel.info.name,
    backgroundColor: look.background,
    titleBarStyle: 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 14, y: 11 } }
      : {
          titleBarOverlay: {
            color: look.background,
            symbolColor: look.foreground,
            height: TITLEBAR_HEIGHT,
          },
        }),
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

  if (start.maximized) win.maximize();
  if (start.fullscreen) win.setFullScreen(true);
  if (!hiddenForTests) win.once('ready-to-show', () => win.show());

  // Web content never opens windows or navigates away from the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    securityStats.recordBlockedNavigation();
    void openExternalLink(url, {
      mode: kernel.policy.state.features.externalLinks,
      confirm: async () => false, // a page-initiated popup is never opened after a prompt
      open: (href) => shell.openExternal(href),
      log: (level, message) => kernel.logger[level](message),
    });
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(APP_ORIGIN + '/')) {
      securityStats.recordBlockedNavigation();
      event.preventDefault();
    }
  });
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());

  void win.loadURL(`${APP_ORIGIN}/index.html`);
  return win;
}
