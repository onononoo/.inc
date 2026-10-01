import { create } from 'zustand';
import type { SettingsSnapshot } from '@shared/api/settings';
import { defaultSettings, type SettingKey, type SettingValues } from '@shared/settings';
import { ipc } from '../services/ipc';

interface SettingsState {
  snapshot: SettingsSnapshot | null;
}

export const useSettingsStore = create<SettingsState>(() => ({ snapshot: null }));

let started = false;

/** Load settings and keep them in sync with the main process. Safe to call more than once. */
export async function initSettings(): Promise<void> {
  if (started) return;
  started = true;
  ipc.on('settings:changed', (snapshot) => useSettingsStore.setState({ snapshot }));
  useSettingsStore.setState({ snapshot: await ipc.invoke('settings:get').catch(() => null) });
}

const DEFAULTS = defaultSettings();

/** Current effective value of a setting (the default until the snapshot has loaded). */
export function getSetting<K extends SettingKey>(key: K): SettingValues[K] {
  return useSettingsStore.getState().snapshot?.effective[key] ?? DEFAULTS[key];
}

/** React hook: re-renders only when this setting's value changes. */
export function useSetting<K extends SettingKey>(key: K): SettingValues[K] {
  return useSettingsStore((s) => s.snapshot?.effective[key] ?? DEFAULTS[key]);
}

export function useIsLocked(key: SettingKey): boolean {
  return useSettingsStore((s) => s.snapshot?.locked.includes(key) ?? false);
}

export async function setSetting<K extends SettingKey>(
  key: K,
  value: SettingValues[K],
  scope: 'user' | 'workspace' = 'user',
): Promise<void> {
  const snapshot = await ipc.invoke('settings:set', key, value, scope);
  useSettingsStore.setState({ snapshot });
}

export async function resetSetting(
  key: SettingKey,
  scope: 'user' | 'workspace' = 'user',
): Promise<void> {
  const snapshot = await ipc.invoke('settings:reset', key, scope);
  useSettingsStore.setState({ snapshot });
}
