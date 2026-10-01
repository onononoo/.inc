import type { Platform } from '../paths';

export interface AppInfo {
  /** Product name, ".inc". */
  name: string;
  version: string;
  platform: Platform;
  arch: string;
  electron: string;
  chrome: string;
  node: string;
  /** Folder holding settings.json, keybindings.json, sessions and logs. */
  userDataDir: string;
  logDir: string;
  isPackaged: boolean;
  /** True for unpackaged development runs. */
  isDev: boolean;
  locale: string;
}

/** Files (and an optional position) a launch or the OS asked a window to open. */
export interface OpenPathsRequest {
  paths: string[];
  line?: number;
  column?: number;
}

export interface AppInvoke {
  'app:getInfo': () => AppInfo;
  /** Plain-text support report (versions, OS, policy state, settings sources). Contains no file contents or user identity. */
  'app:getDiagnostics': () => string;
  /** Open an http(s) or mailto link in the system browser, honouring policy `externalLinks`. Returns whether it was opened. */
  'app:openExternal': (url: string) => boolean;
  /** Reveal the log folder in the file manager. */
  'app:showLogs': () => void;
  /** Renderer log sink; written to the log folder. */
  'app:log': (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  'app:quit': () => void;
  /**
   * Take the open requests that arrived before this window's renderer was listening (command-line
   * files, files handed over by the OS at launch). Call once, right after subscribing to
   * `app:openPaths`; later requests are pushed as events. Returns an empty list when none are waiting.
   */
  'app:consumePendingOpen': () => OpenPathsRequest[];
}

export interface AppEvents {
  /** The OS or a second launch asked this window to open files or folders. */
  'app:openPaths': OpenPathsRequest;
}
