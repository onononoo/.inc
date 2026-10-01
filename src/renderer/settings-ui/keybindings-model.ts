/**
 * The keyboard shortcuts table and the edits to keybindings.json. The file is JSONC and may hold
 * the person's own comments, so every change is a targeted edit (insert one entry, delete one
 * entry) rather than a rewrite. Pure, so it is unit tested.
 */
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import type { KeybindingOverride } from '@shared/api/settings';
import { COMMANDS } from '@shared/commands/catalog';
import type { CommandDef } from '@shared/commands/types';
import { chordLabel, parseChord } from '@shared/keys';
import type { ResolvedKeybinding } from '../contracts/commands';
import type { Platform } from '@shared/paths';

const FORMAT = { insertSpaces: true, tabSize: 2, eol: '\n' } as const;

export interface ShortcutRow {
  command: CommandDef;
  /** Effective bindings for this command, in priority order. */
  bindings: ResolvedKeybinding[];
  /** The command has a default binding the person removed. */
  unbound: boolean;
  /** At least one binding comes from keybindings.json. */
  modified: boolean;
}

/** One row per catalog command that can be bound (palette-only helpers and menu-less ones included). */
export function shortcutRows(
  resolved: readonly ResolvedKeybinding[],
  overrides: readonly KeybindingOverride[],
): ShortcutRow[] {
  const byCommand = new Map<string, ResolvedKeybinding[]>();
  for (const binding of resolved) {
    const list = byCommand.get(binding.commandId) ?? [];
    list.push(binding);
    byCommand.set(binding.commandId, list);
  }
  const removed = new Set(
    overrides.filter((o) => o.command.startsWith('-')).map((o) => o.command.slice(1)),
  );
  const changed = new Set(
    overrides.filter((o) => !o.command.startsWith('-')).map((o) => o.command),
  );
  return COMMANDS.map((command) => ({
    command,
    bindings: byCommand.get(command.id) ?? [],
    unbound: removed.has(command.id) && !(byCommand.get(command.id)?.length ?? 0),
    modified: removed.has(command.id) || changed.has(command.id),
  }));
}

/** Title as shown in the table: "Category: Title". */
export function commandTitle(command: CommandDef): string {
  return command.category ? `${command.category}: ${command.title}` : command.title;
}

export function matchesShortcut(row: ShortcutRow, query: string, platform: Platform): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const labels = row.bindings.map((b) => {
    const chord = parseChord(b.chord, platform);
    return (chord ? chordLabel(chord, platform) : b.chord).toLowerCase();
  });
  return (
    commandTitle(row.command).toLowerCase().includes(q) ||
    row.command.id.toLowerCase().includes(q) ||
    labels.some(
      (l) => l.includes(q) || l.replace(/[\s+]/g, '').includes(q.replace(/[\s+]/g, '')),
    ) ||
    row.bindings.some((b) => (b.when ?? '').toLowerCase().includes(q))
  );
}

/** Commands (other than `except`) that already use a chord, for the conflict warning. */
export function conflictsFor(
  chord: string,
  except: string,
  resolved: readonly ResolvedKeybinding[],
): string[] {
  const titles = new Map(COMMANDS.map((c) => [c.id, commandTitle(c)]));
  const hits = new Set<string>();
  for (const b of resolved) {
    if (b.chord === chord && b.commandId !== except)
      hits.add(titles.get(b.commandId) ?? b.commandId);
  }
  return [...hits];
}

// --- editing keybindings.json ---------------------------------------------------------------

export interface ParsedFile {
  entries: KeybindingOverride[];
  /** Syntax problems; the file must not be edited while there are any. */
  errors: ParseError[];
  /** The text holds an array (or is empty). */
  isArray: boolean;
}

export function parseKeybindingsFile(text: string): ParsedFile {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  const isArray = Array.isArray(value) || value === undefined;
  const entries = Array.isArray(value)
    ? value.filter(
        (e): e is KeybindingOverride =>
          !!e &&
          typeof e === 'object' &&
          typeof (e as KeybindingOverride).key === 'string' &&
          typeof (e as KeybindingOverride).command === 'string',
      )
    : [];
  return { entries, errors, isArray };
}

const EMPTY_FILE = '[\n]\n';

function lengthOf(text: string): number {
  const value = parse(text, [], { allowTrailingComma: true });
  return Array.isArray(value) ? value.length : 0;
}

/** Add one entry at the end of the array, keeping everything else (comments included) as it was. */
export function addEntry(text: string, entry: KeybindingOverride): string {
  const base = text.trim() === '' ? EMPTY_FILE : text;
  const edits = modify(base, [lengthOf(base)], entry, {
    formattingOptions: FORMAT,
    isArrayInsertion: true,
  });
  return applyEdits(base, edits);
}

/** Remove every entry that matches. Entries are removed from the end so indexes stay valid. */
export function removeEntries(
  text: string,
  matches: (entry: KeybindingOverride) => boolean,
): string {
  const value: unknown = parse(text, [], { allowTrailingComma: true });
  if (!Array.isArray(value)) return text;
  let result = text;
  for (let i = value.length - 1; i >= 0; i--) {
    const entry = value[i] as KeybindingOverride | undefined;
    if (
      entry &&
      typeof entry.key === 'string' &&
      typeof entry.command === 'string' &&
      matches(entry)
    ) {
      result = applyEdits(result, modify(result, [i], undefined, { formattingOptions: FORMAT }));
    }
  }
  return result;
}

/** Give a command a new binding: its previous user entries are replaced and its default is kept off. */
export function setBinding(
  text: string,
  command: string,
  chord: string,
  defaultChords: readonly string[],
): string {
  let next = removeEntries(text, (e) => e.command === command || e.command === `-${command}`);
  for (const old of defaultChords) next = addEntry(next, { key: old, command: `-${command}` });
  return addEntry(next, { key: chord, command });
}

/** Take the default binding(s) away without adding a new one. */
export function removeBinding(
  text: string,
  command: string,
  defaultChords: readonly string[],
): string {
  let next = removeEntries(text, (e) => e.command === command || e.command === `-${command}`);
  for (const old of defaultChords) next = addEntry(next, { key: old, command: `-${command}` });
  return next;
}

/** Back to the default: every user entry for the command goes. */
export function resetBinding(text: string, command: string): string {
  return removeEntries(text, (e) => e.command === command || e.command === `-${command}`);
}
