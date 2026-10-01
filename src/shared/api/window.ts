import type { Platform } from '../paths';

export type MenuName = 'File' | 'Edit' | 'Selection' | 'View' | 'Go' | 'Terminal' | 'Help';

/** Top-level order of the application menus, in both the native and the in-window menu bar. */
export const MENU_NAMES: readonly MenuName[] = [
  'File',
  'Edit',
  'Selection',
  'View',
  'Go',
  'Terminal',
  'Help',
];

export interface WindowState {
  maximized: boolean;
  fullscreen: boolean;
  focused: boolean;
  platform: Platform;
  /** Native window controls are drawn by the OS over the title bar area (Windows/Linux overlay, macOS traffic lights). */
  nativeControls: boolean;
}

/** CSS colors the renderer measured from its tokens, so the OS-drawn controls match the theme. */
export interface TitleBarColors {
  background: string;
  foreground: string;
}

export interface WindowInvoke {
  'window:getState': () => WindowState;
  'window:control': (
    action: 'minimize' | 'maximize' | 'restore' | 'close' | 'toggleFullscreen',
  ) => void;
  'window:setTitle': (title: string) => void;
  /** macOS: mark the window as having unsaved changes. */
  'window:setDocumentEdited': (edited: boolean) => void;
  /** Sync native theme (menus, dialogs, scrollbars) and title bar overlay colors. */
  'window:setTheme': (scheme: 'light' | 'dark', titleBar: TitleBarColors) => void;
  /** Zoom level, 0 = 100%. */
  'window:setZoom': (level: number) => void;
  /** Open a new window, optionally on a folder. */
  'window:new': (folder?: string) => void;
  'window:reload': () => void;
  'window:toggleDevTools': () => void;
  /** Show a native drop-down menu (built from the command catalog) at window coordinates. */
  'window:showMenu': (menu: MenuName, x: number, y: number) => void;
  /** Answer to `window:beforeClose`: it is now safe to close. */
  'window:confirmClose': () => void;
}

export interface WindowEvents {
  'window:stateChanged': WindowState;
  /** The user asked to close the window. The renderer must check for unsaved work, then call `window:confirmClose` (or do nothing to cancel). */
  'window:beforeClose': void;
  /** Run a command by id. Sent by native menus and OS-level integrations. */
  'command:execute': { id: string; args?: unknown };
  /** The window gained or lost OS focus (drives auto save on focus change). */
  'window:focusChanged': { focused: boolean };
}
