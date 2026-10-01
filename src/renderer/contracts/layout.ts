import type { ReactNode } from 'react';
import type { Unsubscribe } from './commands';

export type SidebarView = 'explorer' | 'search' | 'git';
export type PanelView = 'terminal' | 'problems';

/** Owned by the workbench layout slice (`renderer/workbench`). */
export interface LayoutService {
  showSidebar(view: SidebarView, opts?: { focus?: boolean }): void;
  toggleSidebar(): void;
  showPanel(view: PanelView, opts?: { focus?: boolean }): void;
  togglePanel(): void;
  isSidebarVisible(): boolean;
  isPanelVisible(): boolean;
  activeSidebarView(): SidebarView;
  activePanelView(): PanelView;
}

export type NotificationLevel = 'info' | 'warning' | 'error';

export interface NotificationAction {
  label: string;
  run: () => void;
}

export interface NotificationOptions {
  level?: NotificationLevel;
  message: string;
  detail?: string;
  actions?: NotificationAction[];
  /** Milliseconds; 0 keeps it until dismissed. Errors default to 0, others to 6000. */
  timeout?: number;
  /** Notifications with the same key replace each other. */
  key?: string;
}

export interface NotificationService {
  notify(options: NotificationOptions): { dismiss: () => void };
  info(message: string, detail?: string): void;
  warn(message: string, detail?: string): void;
  error(message: string, detail?: string): void;
}

export interface ConfirmOptions {
  title: string;
  message?: string;
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button as destructive. */
  danger?: boolean;
}

export interface ChoiceOptions {
  title: string;
  message?: string;
  detail?: string;
  /** Last button is the "cancel" one unless `cancelIndex` is given. */
  buttons: { label: string; danger?: boolean; primary?: boolean }[];
  cancelIndex?: number;
}

export interface DialogService {
  confirm(options: ConfirmOptions): Promise<boolean>;
  /** Resolves to the chosen button index (or the cancel index on Escape). */
  choose(options: ChoiceOptions): Promise<number>;
  /** Show arbitrary content in a modal dialog until `close` is called. */
  showCustom(
    render: (close: () => void) => ReactNode,
    options: { title: string; width?: number },
  ): void;
}

export interface MenuItem {
  id: string;
  label: string;
  /** Right-aligned shortcut label. */
  keybinding?: string;
  disabled?: boolean;
  checked?: boolean;
  danger?: boolean;
  separatorBefore?: boolean;
  submenu?: MenuItem[];
  run?: () => void;
}

/** In-app context menus rendered with design tokens (not native menus). */
export interface MenuService {
  show(items: MenuItem[], position: { x: number; y: number }): Promise<void>;
}

export interface StatusBarItem {
  id: string;
  side: 'left' | 'right';
  /** Higher priority sits nearer the outer edge of its side. */
  priority: number;
  text: ReactNode;
  tooltip?: string;
  /** Icon name from the shared icon set, shown before the text. */
  icon?: string;
  /** Command executed on click. */
  command?: string;
  visible?: boolean;
  /** Visual emphasis for warnings/errors; keeps colour usage semantic. */
  tone?: 'default' | 'warning' | 'error' | 'accent';
}

export interface StatusBarEntry {
  update(patch: Partial<Omit<StatusBarItem, 'id'>>): void;
  dispose: Unsubscribe;
}

export interface StatusBarService {
  register(item: StatusBarItem): StatusBarEntry;
}
