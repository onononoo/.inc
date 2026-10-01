/**
 * While the integrated terminal has keyboard focus, most keys belong to the shell: Ctrl+W deletes a
 * word, Ctrl+N and Ctrl+P walk through history, Alt+Arrow moves by word. Only commands that are
 * about the window itself (the palette, quick open, views, terminal management) may take a key
 * away from the shell. Everything else is typed into the shell.
 */
const PASSTHROUGH_PREFIXES = ['terminal.', 'view.', 'palette.'];
const PASSTHROUGH_IDS: ReadonlySet<string> = new Set([
  'file.newWindow',
  'file.openFolder',
  'file.openFile',
  'file.openRecent',
  'file.closeWindow',
  'file.exit',
  'search.findInFiles',
  'search.replaceInFiles',
  'settings.open',
  'help.shortcuts',
]);

/** True when a command may run from a keybinding while the terminal has focus. */
export function runsInTerminal(commandId: string): boolean {
  return (
    PASSTHROUGH_IDS.has(commandId) || PASSTHROUGH_PREFIXES.some((p) => commandId.startsWith(p))
  );
}
