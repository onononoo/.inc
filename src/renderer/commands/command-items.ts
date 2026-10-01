import type { CommandDef } from '@shared/commands/types';
import { fuzzyMatch } from '@shared/fuzzy';
import type { QuickItem } from './quick-input-controller';

export const RECENT_GROUP = 'Recently used';
export const COMMANDS_GROUP = 'Commands';

/** Score added to a recently used command, newest most. Small: it only breaks near ties. */
const RECENT_BOOST_STEP = 0.02;

export interface CommandItemDeps {
  catalog: readonly CommandDef[];
  /** Has a handler and its `when` clause holds. */
  isEnabled(id: string): boolean;
  labelFor(id: string): string | undefined;
}

/** "File: Save as..." */
export function commandLabel(def: CommandDef): string {
  return def.category ? `${def.category}: ${def.title}` : def.title;
}

export interface CommandItems {
  items: QuickItem<string>[];
  /** Matches before the list was cut. */
  total: number;
}

/**
 * The palette list for a query.
 *
 * Every catalog command that is allowed in the palette, has a handler and passes its `when`
 * clause is a candidate. Without a query, recently used commands come first (newest first) under
 * their own heading, then the rest alphabetically. With a query the list is fuzzy ranked and a
 * recent command wins a near tie.
 */
export function buildCommandItems(
  query: string,
  deps: CommandItemDeps,
  recent: readonly string[],
): CommandItems {
  const q = query.trim();
  const candidates = deps.catalog.filter((def) => def.palette !== false && deps.isEnabled(def.id));
  const recentRank = new Map(recent.map((id, index) => [id, index]));

  const toItem = (def: CommandDef, positions?: number[], group?: string): QuickItem<string> => {
    const keybinding = deps.labelFor(def.id);
    return {
      id: def.id,
      label: commandLabel(def),
      value: def.id,
      ...(keybinding ? { keybinding } : {}),
      ...(positions ? { highlights: positions } : {}),
      ...(group ? { group } : {}),
    };
  };

  if (q === '') {
    const byLabel = (a: CommandDef, b: CommandDef) =>
      commandLabel(a).localeCompare(commandLabel(b), undefined, { sensitivity: 'base' });
    const recents = candidates
      .filter((def) => recentRank.has(def.id))
      .sort((a, b) => (recentRank.get(a.id) as number) - (recentRank.get(b.id) as number));
    const others = candidates.filter((def) => !recentRank.has(def.id)).sort(byLabel);
    const items = [
      ...recents.map((def) => toItem(def, undefined, RECENT_GROUP)),
      ...others.map((def) => toItem(def, undefined, recents.length > 0 ? COMMANDS_GROUP : undefined)),
    ];
    return { items, total: items.length };
  }

  const matches: { def: CommandDef; score: number; positions: number[]; order: number }[] = [];
  candidates.forEach((def, order) => {
    const match = fuzzyMatch(q, commandLabel(def));
    if (!match) return;
    const rank = recentRank.get(def.id);
    const boost = rank === undefined ? 0 : (recent.length - rank) * RECENT_BOOST_STEP;
    matches.push({ def, score: match.score + boost, positions: match.positions, order });
  });
  matches.sort((a, b) => b.score - a.score || a.order - b.order);
  return {
    items: matches.map((m) => toItem(m.def, m.positions)),
    total: matches.length,
  };
}
