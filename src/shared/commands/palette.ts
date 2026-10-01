import { def, type CommandDef } from './types';

/**
 * Commands that only exist to give the quick input surface a second way in.
 * The main palette commands (palette.commands, palette.quickOpen, ...) live with the View and Go menus.
 */
export const PALETTE_COMMANDS: CommandDef[] = [
  def({
    id: 'palette.show',
    title: 'Show command palette',
    category: 'View',
    keybinding: { key: 'F1' },
    palette: false,
  }),
];
