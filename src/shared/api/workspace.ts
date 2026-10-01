export type TrustState = 'trusted' | 'untrusted';

export interface WorkspaceInfo {
  /** Absolute path of the opened folder. */
  root: string;
  /** Folder name, used in the title bar. */
  name: string;
  trust: TrustState;
  /** False when workspace trust is turned off (setting or policy): every workspace is then treated as trusted. */
  trustEnabled: boolean;
}

export interface RecentWorkspace {
  path: string;
  name: string;
  lastOpened: number;
}

/** Opaque, versioned renderer state persisted per workspace (open editors, layout, view state). */
export interface SessionBlob {
  version: number;
  data: unknown;
}

export interface WorkspaceInvoke {
  /** The folder this window has open, or null. */
  'workspace:get': () => WorkspaceInfo | null;
  /**
   * Open a folder in this window (replaces the current one). Emits `workspace:changed`.
   * Rejects with E_INVALID (not an absolute path), E_NOT_FOUND, E_NOT_DIRECTORY or E_PERMISSION.
   */
  'workspace:open': (path: string) => WorkspaceInfo;
  'workspace:close': () => void;
  /** Persist the trust decision for the current folder. Rejects with E_NO_WORKSPACE when none is open. */
  'workspace:setTrust': (trusted: boolean) => WorkspaceInfo;
  /** Most recent first, at most 20; folders that no longer exist are dropped. */
  'workspace:getRecent': () => RecentWorkspace[];
  'workspace:removeRecent': (path: string) => RecentWorkspace[];
  'workspace:clearRecent': () => void;
  /** Session for the current workspace (or the empty-window session when none is open). */
  'session:load': () => SessionBlob | null;
  /** Rejects with E_INVALID for a malformed blob and E_TOO_LARGE above 2 MB. */
  'session:save': (blob: SessionBlob) => void;
}

export interface WorkspaceEvents {
  'workspace:changed': WorkspaceInfo | null;
}
