/**
 * Native application menu, as a pure function of the command catalog, the platform and the labels.
 *
 * The output is plain data (no Electron types) so it can be unit tested; `menu-host.ts` turns it
 * into a real menu. Rules that matter:
 *  - Items run catalog commands. Clicking one sends `command:execute` to the renderer; Edit items
 *    are commands too (never Electron roles) so Monaco keeps handling undo, copy and paste itself.
 *  - Accelerators are display hints only (`registerAccelerator: false`). The renderer keybinding
 *    service owns every key press, so a key can never fire twice.
 *  - Groups inside a menu are ordered by name and separated by a divider; items by `order`.
 */
import { MENU_NAMES, type MenuName } from '@shared/api/window';
import type { CommandDef } from '@shared/commands/types';
import type { Platform } from '@shared/paths';

export type MenuRole =
  'services' | 'hide' | 'hideOthers' | 'unhide' | 'minimize' | 'zoom' | 'front';

export interface MenuTemplateItem {
  label?: string;
  type?: 'separator';
  /** Catalog command this item runs. */
  commandId?: string;
  /** Native macOS behaviour that has no renderer equivalent (Services, Hide, Minimize...). */
  role?: MenuRole;
  /** Shown next to the label. Never registered as a shortcut. */
  accelerator?: string;
  registerAccelerator?: false;
  submenu?: MenuTemplateItem[];
}

export interface MenuLabels {
  menus: Record<MenuName, string>;
  window: string;
  minimize: string;
  zoom: string;
  bringAllToFront: string;
  services: string;
  settings: string;
  /** `{name}` is replaced with the product name. */
  hide: string;
  hideOthers: string;
  showAll: string;
  quit: string;
}

export const DEFAULT_MENU_LABELS: MenuLabels = {
  menus: {
    File: 'File',
    Edit: 'Edit',
    Selection: 'Selection',
    View: 'View',
    Go: 'Go',
    Terminal: 'Terminal',
    Help: 'Help',
  },
  window: 'Window',
  minimize: 'Minimize',
  zoom: 'Zoom',
  bringAllToFront: 'Bring all to front',
  services: 'Services',
  settings: 'Settings...',
  hide: 'Hide {name}',
  hideOthers: 'Hide others',
  showAll: 'Show all',
  quit: 'Quit {name}',
};

/** Top-level order of the catalog menus. */
export const MENU_ORDER: readonly MenuName[] = MENU_NAMES;

/** Commands that live in the macOS application menu instead of File and Help. */
const MAC_APP_MENU_COMMANDS: ReadonlySet<string> = new Set(['help.about', 'file.exit']);

export interface MenuInput {
  commands: readonly CommandDef[];
  platform: Platform;
  productName: string;
  labels?: MenuLabels;
  /** Return false to leave a command out (for example terminal commands when policy disables the terminal). */
  isAvailable?: (commandId: string) => boolean;
}

const NAMED_KEYS: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Enter: 'Return',
  Escape: 'Escape',
  Space: 'Space',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
};

const PUNCTUATION = new Set(['`', ',', '.', '/', '\\', '[', ']', '-', '=', ';']);

/**
 * Convert catalog key notation ("Mod+Shift+P") to an Electron accelerator for display.
 * Returns undefined for chords ("Mod+K Mod+S"), which a menu cannot show, and for chords that
 * use a modifier the platform does not have.
 */
export function toAccelerator(notation: string, platform: Platform): string | undefined {
  const trimmed = notation.trim();
  if (!trimmed || /\s/.test(trimmed)) return undefined;
  const parts = trimmed.split('+');
  const rawKey = parts.pop();
  if (!rawKey) return undefined;

  const modifiers: string[] = [];
  for (const part of parts) {
    switch (part) {
      case 'Mod':
        modifiers.push('CommandOrControl');
        break;
      case 'Ctrl':
        modifiers.push('Control');
        break;
      case 'Cmd':
        if (platform !== 'darwin') return undefined;
        modifiers.push('Command');
        break;
      case 'Alt':
        modifiers.push('Alt');
        break;
      case 'Shift':
        modifiers.push('Shift');
        break;
      default:
        return undefined;
    }
  }

  let key: string | undefined;
  if (NAMED_KEYS[rawKey]) key = NAMED_KEYS[rawKey];
  else if (/^[A-Z0-9]$/.test(rawKey)) key = rawKey;
  else if (/^F([1-9]|1[0-2])$/.test(rawKey)) key = rawKey;
  else if (PUNCTUATION.has(rawKey)) key = rawKey;
  if (!key) return undefined;
  return [...modifiers, key].join('+');
}

/** The shortcut text a menu shows for a command on a platform, if it has a single-chord binding. */
export function acceleratorFor(command: CommandDef, platform: Platform): string | undefined {
  const binding = command.keybinding;
  if (binding) {
    const notation = platform === 'darwin' ? (binding.mac ?? binding.key) : binding.key;
    return toAccelerator(notation, platform);
  }
  if (command.keybindingHint) return toAccelerator(command.keybindingHint, platform);
  return undefined;
}

function fill(template: string, name: string): string {
  return template.replace('{name}', name);
}

function commandItem(command: CommandDef, platform: Platform): MenuTemplateItem {
  const accelerator = acceleratorFor(command, platform);
  return {
    label: command.title,
    commandId: command.id,
    ...(accelerator ? { accelerator, registerAccelerator: false as const } : {}),
  };
}

/** Items of one catalog menu: groups ordered by name, items by `order`, dividers between groups. */
export function buildSubmenu(input: MenuInput, name: MenuName): MenuTemplateItem[] {
  const { commands, platform, isAvailable } = input;
  const groups = new Map<string, CommandDef[]>();
  for (const command of commands) {
    const placement = command.menu;
    if (!placement || placement.menu !== name) continue;
    if (platform === 'darwin' && MAC_APP_MENU_COMMANDS.has(command.id)) continue;
    if (isAvailable && !isAvailable(command.id)) continue;
    const list = groups.get(placement.group);
    if (list) list.push(command);
    else groups.set(placement.group, [command]);
  }

  const items: MenuTemplateItem[] = [];
  const groupNames = [...groups.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const groupName of groupNames) {
    const members = (groups.get(groupName) ?? []).slice().sort((a, b) => {
      const delta = (a.menu?.order ?? 0) - (b.menu?.order ?? 0);
      return delta !== 0 ? delta : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    if (items.length > 0) items.push({ type: 'separator' });
    for (const command of members) items.push(commandItem(command, platform));
  }
  return items;
}

function macAppMenu(input: MenuInput): MenuTemplateItem {
  const labels = input.labels ?? DEFAULT_MENU_LABELS;
  const name = input.productName;
  const byId = new Map(input.commands.map((c) => [c.id, c]));
  const about = byId.get('help.about');
  const quit = byId.get('file.exit');
  const settings = byId.get('settings.open');
  const has = (id: string) => (input.isAvailable ? input.isAvailable(id) : true);

  const items: MenuTemplateItem[] = [];
  if (about && has(about.id)) items.push({ label: about.title, commandId: about.id });
  if (settings && has(settings.id)) {
    if (items.length) items.push({ type: 'separator' });
    items.push({ ...commandItem(settings, 'darwin'), label: labels.settings });
  }
  if (items.length) items.push({ type: 'separator' });
  items.push(
    { label: labels.services, role: 'services' },
    { type: 'separator' },
    { label: fill(labels.hide, name), role: 'hide' },
    { label: labels.hideOthers, role: 'hideOthers' },
    { label: labels.showAll, role: 'unhide' },
  );
  if (quit && has(quit.id)) {
    items.push(
      { type: 'separator' },
      { ...commandItem(quit, 'darwin'), label: fill(labels.quit, name) },
    );
  }
  return { label: name, submenu: items };
}

function macWindowMenu(labels: MenuLabels): MenuTemplateItem {
  return {
    label: labels.window,
    submenu: [
      { label: labels.minimize, role: 'minimize' },
      { label: labels.zoom, role: 'zoom' },
      { type: 'separator' },
      { label: labels.bringAllToFront, role: 'front' },
    ],
  };
}

/** The full application menu bar for a platform. */
export function buildMenuTemplate(input: MenuInput): MenuTemplateItem[] {
  const labels = input.labels ?? DEFAULT_MENU_LABELS;
  const template: MenuTemplateItem[] = [];
  if (input.platform === 'darwin') template.push(macAppMenu(input));

  for (const name of MENU_ORDER) {
    if (name === 'Help' && input.platform === 'darwin') template.push(macWindowMenu(labels));
    const submenu = buildSubmenu(input, name);
    if (submenu.length > 0) template.push({ label: labels.menus[name], submenu });
  }
  return template;
}

/** Every command id referenced by a template, in order. Used by tests and by the click handler. */
export function commandIdsOf(template: readonly MenuTemplateItem[]): string[] {
  const ids: string[] = [];
  for (const item of template) {
    if (item.commandId) ids.push(item.commandId);
    if (item.submenu) ids.push(...commandIdsOf(item.submenu));
  }
  return ids;
}
