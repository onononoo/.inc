import type { PolicyState } from '../policy';
import type { SettingKey, SettingValues } from '../settings';

export type SettingSource = 'default' | 'user' | 'workspace' | 'policy';

export interface SettingsIssue {
  /** File the problem was found in. */
  file: string;
  message: string;
  key?: string;
  /** 1-based line in `file`, when known. */
  line?: number;
}

export interface SettingsSnapshot {
  /** Fully resolved values. */
  effective: SettingValues;
  /** Which layer supplied each effective value. */
  sources: Record<SettingKey, SettingSource>;
  /** Raw validated overrides from each layer. */
  user: Partial<SettingValues>;
  workspace: Partial<SettingValues>;
  /** Keys enforced by policy (read-only in the UI). */
  locked: SettingKey[];
  /** Workspace values ignored because the workspace is not trusted. */
  restrictedIgnored: SettingKey[];
  issues: SettingsIssue[];
  files: { user: string; workspace: string | null; policy: string | null };
}

export interface KeybindingOverride {
  /** Chord notation, e.g. "Mod+Shift+P" or "Mod+K Mod+S". */
  key: string;
  /** Command id. A leading "-" removes the default binding of that command. */
  command: string;
  when?: string;
  args?: unknown;
}

export interface KeybindingsSnapshot {
  entries: KeybindingOverride[];
  issues: SettingsIssue[];
  file: string;
}

export interface SettingsInvoke {
  'settings:get': () => SettingsSnapshot;
  /** Write a value into user or workspace settings. Fails with E_POLICY for locked keys. */
  'settings:set': (
    key: SettingKey,
    value: unknown,
    scope: 'user' | 'workspace',
  ) => SettingsSnapshot;
  /** Remove an override from user or workspace settings. */
  'settings:reset': (key: SettingKey, scope: 'user' | 'workspace') => SettingsSnapshot;
  /** Create the settings file (with a short header) if it does not exist; returns its path so the renderer can open it. */
  'settings:ensureFile': (scope: 'user' | 'workspace') => string;
  'policy:get': () => PolicyState;
  'keybindings:get': () => KeybindingsSnapshot;
  'keybindings:ensureFile': () => string;
}

export interface SettingsEvents {
  'settings:changed': SettingsSnapshot;
  'policy:changed': PolicyState;
  'keybindings:changed': KeybindingsSnapshot;
}
