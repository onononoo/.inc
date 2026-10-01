import { def, type CommandDef } from './types';

/** Terminal, tasks, settings, appearance, trust and policy commands. */
export const PLATFORM_COMMANDS: CommandDef[] = [
  // Terminal
  def({
    id: 'terminal.toggle',
    title: 'Toggle terminal',
    category: 'Terminal',
    keybinding: { key: 'Ctrl+`' },
    menu: { menu: 'Terminal', group: '1_terminal', order: 1 },
  }),
  def({
    id: 'terminal.new',
    title: 'New terminal',
    category: 'Terminal',
    keybinding: { key: 'Ctrl+Shift+`' },
    menu: { menu: 'Terminal', group: '1_terminal', order: 2 },
  }),
  def({
    id: 'terminal.kill',
    title: 'Kill active terminal',
    category: 'Terminal',
    when: 'terminalCount > 0',
  }),
  def({
    id: 'terminal.clear',
    title: 'Clear terminal',
    category: 'Terminal',
    keybinding: { key: 'Mod+K', mac: 'Cmd+K', when: 'terminalFocus' },
    menu: { menu: 'Terminal', group: '2_manage', order: 1 },
  }),
  def({ id: 'terminal.focus', title: 'Focus terminal', category: 'Terminal' }),
  def({ id: 'terminal.selectProfile', title: 'Select default shell...', category: 'Terminal' }),
  def({
    id: 'terminal.nextTab',
    title: 'Next terminal',
    category: 'Terminal',
    keybinding: { key: 'Ctrl+PageDown', when: 'terminalFocus' },
    palette: false,
  }),
  def({
    id: 'terminal.previousTab',
    title: 'Previous terminal',
    category: 'Terminal',
    keybinding: { key: 'Ctrl+PageUp', when: 'terminalFocus' },
    palette: false,
  }),
  def({
    id: 'terminal.runTask',
    title: 'Run task...',
    category: 'Terminal',
    menu: { menu: 'Terminal', group: '3_tasks', order: 1 },
  }),
  def({
    id: 'terminal.runCommand',
    title: 'Run command in terminal',
    category: 'Terminal',
    palette: false,
  }),
  def({
    id: 'terminal.copy',
    title: 'Copy terminal selection',
    category: 'Terminal',
    keybinding: { key: 'Ctrl+Shift+C', mac: 'Cmd+C', when: 'terminalFocus' },
    palette: false,
  }),
  def({
    id: 'terminal.paste',
    title: 'Paste into terminal',
    category: 'Terminal',
    keybinding: { key: 'Ctrl+Shift+V', mac: 'Cmd+V', when: 'terminalFocus' },
    palette: false,
  }),

  // Settings and appearance
  def({
    id: 'settings.open',
    title: 'Open settings',
    category: 'Preferences',
    keybinding: { key: 'Mod+,' },
  }),
  def({ id: 'settings.openJson', title: 'Open user settings (JSON)', category: 'Preferences' }),
  def({
    id: 'settings.openWorkspaceJson',
    title: 'Open workspace settings (JSON)',
    category: 'Preferences',
    when: 'hasWorkspace',
  }),
  def({
    id: 'settings.openKeybindings',
    title: 'Open keyboard shortcuts',
    category: 'Preferences',
    keybinding: { key: 'Mod+K Mod+S' },
  }),
  def({
    id: 'settings.openKeybindingsJson',
    title: 'Open keyboard shortcuts (JSON)',
    category: 'Preferences',
  }),
  def({
    id: 'settings.selectTheme',
    title: 'Select color theme...',
    category: 'Preferences',
    keybinding: { key: 'Mod+K Mod+T' },
  }),
  def({
    id: 'settings.manageTrust',
    title: 'Manage workspace trust',
    category: 'Preferences',
    when: 'hasWorkspace',
  }),
  def({
    id: 'settings.showPolicy',
    title: 'Show managed configuration',
    category: 'Preferences',
    when: 'isManaged',
  }),
];
