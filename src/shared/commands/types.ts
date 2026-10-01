import type { MenuName } from '../api/window';

/**
 * Keybinding notation: modifiers joined with "+", chords separated by a space.
 *   "Mod+Shift+P"   Mod = Ctrl on Windows/Linux, Cmd on macOS
 *   "Mod+K Mod+S"   a two-step chord
 * Modifiers: Mod, Ctrl, Cmd, Alt, Shift. Keys use KeyboardEvent.key names, upper-case letters
 * for letters: A-Z, 0-9, F1-F12, Enter, Escape, Tab, Space, Backspace, Delete, ArrowUp/Down/Left/Right,
 * Home, End, PageUp, PageDown and the literal characters ` , . / \ [ ] - = ;
 */
export interface KeybindingDef {
  /** Default chord on every platform unless `mac` is given. */
  key: string;
  /** Overrides `key` on macOS. */
  mac?: string;
  /** When clause (see shared/when.ts). */
  when?: string;
}

export interface MenuPlacement {
  menu: MenuName;
  /** Items in the same group sit together; groups are separated by a divider and ordered by name. */
  group: string;
  order: number;
}

export interface CommandDef {
  /** `domain.action`, stable. */
  id: string;
  /** Sentence-case title shown in the palette and menus. */
  title: string;
  /** Palette prefix, e.g. "File" gives "File: Save". Omit for none. */
  category?: string;
  /** Bound and handled by the renderer keybinding service. */
  keybinding?: KeybindingDef;
  /** Shown next to the menu item but bound by something else (for example Monaco itself). */
  keybindingHint?: string;
  menu?: MenuPlacement;
  /** Enablement; disabled commands are greyed out in menus and hidden from the palette. */
  when?: string;
  /** Set false to keep out of the command palette. */
  palette?: boolean;
}

export const def = (c: CommandDef): CommandDef => c;
