import type { ReactNode } from 'react';
import { create } from 'zustand';
import type {
  ChoiceOptions,
  ConfirmOptions,
  DialogService,
  LayoutService,
  MenuItem,
  MenuService,
  PanelView,
  SidebarView,
  StatusBarEntry,
  StatusBarItem,
  StatusBarService,
} from '../contracts/layout';
import { service } from '../services/registry';
import { useLayoutStore } from '../state/layout-store';
import { Button } from '../ui/Button';

// --- Dialogs ---------------------------------------------------------------------------------

export interface DialogEntry {
  id: number;
  title: string;
  width: number;
  role: 'dialog' | 'alertdialog';
  body: ReactNode;
  /** Right-aligned actions; absent for custom dialogs that render their own. */
  actions?: ReactNode;
  /** Escape: runs the cancel path. */
  onEscape: () => void;
}

interface DialogState {
  stack: DialogEntry[];
}

export const useDialogStore = create<DialogState>(() => ({ stack: [] }));

let nextDialogId = 1;

function openDialog(entry: Omit<DialogEntry, 'id'>): { id: number; close: () => void } {
  const id = nextDialogId++;
  useDialogStore.setState((s) => ({ stack: [...s.stack, { ...entry, id }] }));
  return { id, close: () => closeDialog(id) };
}

export function closeDialog(id: number): void {
  useDialogStore.setState((s) => ({ stack: s.stack.filter((d) => d.id !== id) }));
}

export function createDialogService(): DialogService {
  return {
    confirm(options: ConfirmOptions): Promise<boolean> {
      return new Promise((resolve) => {
        let entryId = 0;
        const answer = (value: boolean) => {
          closeDialog(entryId);
          resolve(value);
        };
        const body = (
          <>
            {options.message && <p>{options.message}</p>}
            {options.detail && <p>{options.detail}</p>}
          </>
        );
        const opened = openDialog({
          title: options.title,
          width: 400,
          role: 'alertdialog',
          body: options.message || options.detail ? body : null,
          actions: (
            <>
              <Button data-autofocus onClick={() => answer(false)}>
                {options.cancelLabel ?? 'Cancel'}
              </Button>
              <Button variant={options.danger ? 'danger' : 'primary'} onClick={() => answer(true)}>
                {options.confirmLabel ?? 'OK'}
              </Button>
            </>
          ),
          onEscape: () => answer(false),
        });
        entryId = opened.id;
      });
    },

    choose(options: ChoiceOptions): Promise<number> {
      return new Promise((resolve) => {
        let entryId = 0;
        const cancelIndex = options.cancelIndex ?? options.buttons.length - 1;
        const answer = (index: number) => {
          closeDialog(entryId);
          resolve(index);
        };
        const body = (
          <>
            {options.message && <p>{options.message}</p>}
            {options.detail && <p>{options.detail}</p>}
          </>
        );
        const opened = openDialog({
          title: options.title,
          width: 440,
          role: 'alertdialog',
          body: options.message || options.detail ? body : null,
          actions: options.buttons.map((button, index) => (
            <Button
              key={index}
              data-autofocus={index === cancelIndex ? true : undefined}
              variant={button.danger ? 'danger' : button.primary ? 'primary' : 'secondary'}
              onClick={() => answer(index)}
            >
              {button.label}
            </Button>
          )),
          onEscape: () => answer(cancelIndex),
        });
        entryId = opened.id;
      });
    },

    showCustom(render, options) {
      let entryId = 0;
      const close = () => closeDialog(entryId);
      const opened = openDialog({
        title: options.title,
        width: options.width ?? 480,
        role: 'dialog',
        body: render(close),
        onEscape: close,
      });
      entryId = opened.id;
    },
  };
}

// --- Context menus ---------------------------------------------------------------------------

export interface MenuRequest {
  items: readonly MenuItem[];
  position: { x: number; y: number };
  resolve: () => void;
}

interface MenuState {
  request: MenuRequest | null;
}

export const useMenuStore = create<MenuState>(() => ({ request: null }));

export function createMenuService(): MenuService {
  return {
    show(items, position) {
      return new Promise<void>((resolve) => {
        useMenuStore.getState().request?.resolve();
        useMenuStore.setState({ request: { items, position, resolve } });
      });
    },
  };
}

export function closeMenu(): void {
  const current = useMenuStore.getState().request;
  useMenuStore.setState({ request: null });
  current?.resolve();
}

// --- Status bar ------------------------------------------------------------------------------

interface StatusBarState {
  items: Record<string, StatusBarItem>;
}

export const useStatusBarStore = create<StatusBarState>(() => ({ items: {} }));

export function createStatusBarService(): StatusBarService {
  return {
    register(item: StatusBarItem): StatusBarEntry {
      useStatusBarStore.setState((s) => ({ items: { ...s.items, [item.id]: item } }));
      return {
        update(patch) {
          useStatusBarStore.setState((s) => {
            const current = s.items[item.id];
            return current ? { items: { ...s.items, [item.id]: { ...current, ...patch } } } : s;
          });
        },
        dispose() {
          useStatusBarStore.setState((s) => {
            const next = { ...s.items };
            delete next[item.id];
            return { items: next };
          });
        },
      };
    },
  };
}

// --- Layout ----------------------------------------------------------------------------------

/** Move keyboard focus to the first control inside a region (sidebar or bottom panel). */
function focusRegion(region: 'sidebar' | 'panel'): void {
  requestAnimationFrame(() => {
    const root = document.querySelector<HTMLElement>(`[data-region="${region}"]`);
    const target = root?.querySelector<HTMLElement>(
      '[data-autofocus], input:not([disabled]), [role="tree"], [role="listbox"], textarea, button:not([disabled]), [tabindex="0"]',
    );
    target?.focus({ preventScroll: true });
  });
}

export function createLayoutService(): LayoutService {
  const set = useLayoutStore.setState;
  const get = useLayoutStore.getState;
  return {
    showSidebar(view: SidebarView, opts) {
      set({ sidebarVisible: true, sidebarView: view });
      if (opts?.focus) focusRegion('sidebar');
    },
    toggleSidebar() {
      set({ sidebarVisible: !get().sidebarVisible });
    },
    showPanel(view: PanelView, opts) {
      set({ panelVisible: true, panelView: view });
      if (opts?.focus) focusRegion('panel');
    },
    togglePanel() {
      set({ panelVisible: !get().panelVisible });
    },
    isSidebarVisible: () => get().sidebarVisible,
    isPanelVisible: () => get().panelVisible,
    activeSidebarView: () => get().sidebarView,
    activePanelView: () => get().panelView,
  };
}

/** Where other slices ask the workbench to show an editor-adjacent view. */
export function layout(): LayoutService {
  return service('layout');
}
