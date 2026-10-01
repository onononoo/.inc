import { useSyncExternalStore } from 'react';
import type { ThemeSetting } from '@shared/settings';
import { ipc } from '../services/ipc';
import { getSetting, useSettingsStore } from '../state/settings-store';

export type ResolvedTheme = 'light' | 'dark' | 'hc-light' | 'hc-dark';

const STORAGE_KEY = 'inc.theme';
const THEMES: readonly ResolvedTheme[] = ['light', 'dark', 'hc-light', 'hc-dark'];

/** Pure: what a theme setting means given the system preference. */
export function resolveTheme(setting: ThemeSetting, systemPrefersDark: boolean): ResolvedTheme {
  if (setting === 'system') return systemPrefersDark ? 'dark' : 'light';
  return setting;
}

function systemDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function isResolved(value: unknown): value is ResolvedTheme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

/**
 * Apply the last theme before React renders, so the window never flashes the wrong colours. The
 * proper value (from settings) replaces it as soon as settings have loaded.
 */
export function applyStoredTheme(): void {
  let stored: string | null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    stored = null;
  }
  document.documentElement.dataset.theme = isResolved(stored)
    ? stored
    : systemDark()
      ? 'dark'
      : 'light';
}

let current: ResolvedTheme | null = null;
const listeners = new Set<() => void>();

/** The theme being shown. */
export function currentTheme(): ResolvedTheme {
  return (
    current ??
    (isResolved(document.documentElement.dataset.theme)
      ? document.documentElement.dataset.theme
      : 'light')
  );
}

export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, currentTheme);
}

/** Colours the title bar overlay and window background must match, measured from the tokens. */
function measureChrome(): { background: string; foreground: string } {
  const style = getComputedStyle(document.documentElement);
  return {
    background: style.getPropertyValue('--surface-titlebar').trim(),
    foreground: style.getPropertyValue('--text-primary').trim(),
  };
}

/** Show `theme`, tell the editor, the native window and the next launch. */
export function showTheme(theme: ResolvedTheme): void {
  const changed = current !== theme;
  current = theme;
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* the setting is still the source of truth */
  }
  if (!changed) return;
  window.dispatchEvent(new CustomEvent('inc:theme-changed', { detail: theme }));
  for (const listener of [...listeners]) listener();
  // The measured colours change one frame after the attribute does.
  requestAnimationFrame(() => {
    const { background, foreground } = measureChrome();
    const scheme = theme === 'dark' || theme === 'hc-dark' ? 'dark' : 'light';
    void ipc.invoke('window:setTheme', scheme, { background, foreground }).catch(() => undefined);
  });
}

function sync(): void {
  showTheme(resolveTheme(getSetting('appearance.theme'), systemDark()));
}

/** Follow `appearance.theme` and the system preference for the life of the window. */
export function startThemeSync(): void {
  sync();
  let last = getSetting('appearance.theme');
  useSettingsStore.subscribe(() => {
    const next = getSetting('appearance.theme');
    if (next !== last) {
      last = next;
      sync();
    }
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (getSetting('appearance.theme') === 'system') sync();
  });
}

/** Zoom follows `appearance.zoomLevel`. */
export function startZoomSync(): void {
  let last = Number.NaN;
  const apply = () => {
    const level = getSetting('appearance.zoomLevel');
    if (level === last) return;
    last = level;
    void ipc.invoke('window:setZoom', level).catch(() => undefined);
  };
  apply();
  useSettingsStore.subscribe(apply);
}
