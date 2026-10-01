import { EDITOR_COMMANDS } from './editor';
import { PALETTE_COMMANDS } from './palette';
import { PLATFORM_COMMANDS } from './platform';
import { SIDEBAR_COMMANDS } from './sidebar';
import type { CommandDef } from './types';
import { WORKBENCH_COMMANDS } from './workbench';

export type { CommandArgs } from './args';
export type { CommandDef, KeybindingDef, MenuPlacement } from './types';

/**
 * Every command .inc ships. This list drives the native menus, the command palette, the
 * keyboard shortcuts reference and the generated docs. The renderer registers a handler for
 * each id; a command without a handler is disabled.
 */
export const COMMANDS: readonly CommandDef[] = [
  ...WORKBENCH_COMMANDS,
  ...PALETTE_COMMANDS,
  ...EDITOR_COMMANDS,
  ...SIDEBAR_COMMANDS,
  ...PLATFORM_COMMANDS,
];

const byId = new Map<string, CommandDef>();
for (const c of COMMANDS) byId.set(c.id, c);

export function commandById(id: string): CommandDef | undefined {
  return byId.get(id);
}

/** Catalog problems (duplicate ids, duplicate unconditional keybindings). Asserted by a unit test. */
export function validateCatalog(commands: readonly CommandDef[] = COMMANDS): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const bindings = new Map<string, string>();
  for (const c of commands) {
    if (ids.has(c.id)) problems.push(`Duplicate command id: ${c.id}`);
    ids.add(c.id);
    if (!/^[a-z][A-Za-z0-9]*\.[A-Za-z0-9.]+$/.test(c.id)) problems.push(`Bad command id: ${c.id}`);
    if (c.keybinding) {
      for (const platform of ['win', 'mac'] as const) {
        const key = platform === 'mac' ? (c.keybinding.mac ?? c.keybinding.key) : c.keybinding.key;
        const slot = `${platform}|${key}|${c.keybinding.when ?? ''}`;
        const other = bindings.get(slot);
        if (other) problems.push(`Keybinding ${key} (${platform}) used by ${other} and ${c.id}`);
        else bindings.set(slot, c.id);
      }
    }
  }
  return problems;
}
