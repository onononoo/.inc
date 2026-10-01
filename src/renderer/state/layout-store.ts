import { create } from 'zustand';
import type { PanelView, SidebarView } from '../contracts/layout';
import { getSection, setSection } from '../services/session';

export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 520;
export const SIDEBAR_DEFAULT = 264;
export const PANEL_MIN = 120;
export const PANEL_DEFAULT = 240;

const SIDEBAR_VIEWS: readonly SidebarView[] = ['explorer', 'search', 'git'];
const PANEL_VIEWS: readonly PanelView[] = ['terminal', 'problems'];
const STORAGE_KEY = 'inc.layout';

export interface LayoutState {
  sidebarVisible: boolean;
  sidebarView: SidebarView;
  sidebarWidth: number;
  panelVisible: boolean;
  panelView: PanelView;
  panelHeight: number;
}

export const DEFAULT_LAYOUT: LayoutState = {
  sidebarVisible: true,
  sidebarView: 'explorer',
  sidebarWidth: SIDEBAR_DEFAULT,
  panelVisible: false,
  panelView: 'terminal',
  panelHeight: PANEL_DEFAULT,
};

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;
}

/** Accept whatever was saved, field by field, so an older or damaged blob never breaks startup. */
export function sanitizeLayout(raw: unknown): LayoutState {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    sidebarVisible:
      typeof source.sidebarVisible === 'boolean'
        ? source.sidebarVisible
        : DEFAULT_LAYOUT.sidebarVisible,
    sidebarView: SIDEBAR_VIEWS.includes(source.sidebarView as SidebarView)
      ? (source.sidebarView as SidebarView)
      : DEFAULT_LAYOUT.sidebarView,
    sidebarWidth: clamp(source.sidebarWidth, SIDEBAR_MIN, SIDEBAR_MAX, SIDEBAR_DEFAULT),
    panelVisible:
      typeof source.panelVisible === 'boolean' ? source.panelVisible : DEFAULT_LAYOUT.panelVisible,
    panelView: PANEL_VIEWS.includes(source.panelView as PanelView)
      ? (source.panelView as PanelView)
      : DEFAULT_LAYOUT.panelView,
    panelHeight: clamp(source.panelHeight, PANEL_MIN, 2000, PANEL_DEFAULT),
  };
}

function readLocal(): unknown {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

function writeLocal(state: LayoutState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* storage may be unavailable; the session blob still keeps the layout */
  }
}

export const useLayoutStore = create<LayoutState>(() => ({ ...DEFAULT_LAYOUT }));

let hydrated = false;

/** Load the saved layout: the workspace session first, then the device-wide copy. */
export function hydrateLayout(): void {
  const saved = getSection<unknown>('layout') ?? readLocal();
  useLayoutStore.setState(sanitizeLayout(saved));
  if (hydrated) return;
  hydrated = true;
  useLayoutStore.subscribe((state) => {
    const snapshot: LayoutState = {
      sidebarVisible: state.sidebarVisible,
      sidebarView: state.sidebarView,
      sidebarWidth: state.sidebarWidth,
      panelVisible: state.panelVisible,
      panelView: state.panelView,
      panelHeight: state.panelHeight,
    };
    setSection('layout', snapshot);
    writeLocal(snapshot);
  });
}

export function setSidebarWidth(width: number): void {
  useLayoutStore.setState({
    sidebarWidth: clamp(width, SIDEBAR_MIN, SIDEBAR_MAX, SIDEBAR_DEFAULT),
  });
}

export function setPanelHeight(height: number, max: number): void {
  useLayoutStore.setState({
    panelHeight: clamp(height, PANEL_MIN, Math.max(PANEL_MIN, max), PANEL_DEFAULT),
  });
}
