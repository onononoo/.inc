import type { MenuItem } from '../contracts/layout';

/** Pure keyboard-navigation helpers for menus. */

type Navigable = Pick<MenuItem, 'label' | 'disabled'>;

function enabled(item: Navigable | undefined): boolean {
  return item !== undefined && !item.disabled;
}

export function firstEnabledIndex(items: readonly Navigable[]): number {
  return items.findIndex(enabled);
}

export function lastEnabledIndex(items: readonly Navigable[]): number {
  for (let i = items.length - 1; i >= 0; i--) if (enabled(items[i])) return i;
  return -1;
}

/**
 * The next enabled item after `from` in `direction`, wrapping around the ends.
 * `from` may be -1 (nothing active). Returns -1 when no item is enabled.
 */
export function nextEnabledIndex(
  items: readonly Navigable[],
  from: number,
  direction: 1 | -1,
): number {
  const count = items.length;
  if (count === 0) return -1;
  let index = from < 0 ? (direction === 1 ? -1 : count) : from;
  for (let step = 0; step < count; step++) {
    index = (index + direction + count) % count;
    if (enabled(items[index])) return index;
  }
  return -1;
}

/**
 * Type-ahead: the first enabled item whose label starts with `buffer` (case-insensitive), looking
 * from the item after `from` and wrapping. A repeated single character cycles through the items
 * that start with it. Returns -1 when nothing matches.
 */
export function typeaheadIndex(items: readonly Navigable[], buffer: string, from: number): number {
  const query = buffer.toLowerCase();
  if (!query || items.length === 0) return -1;
  const cycling = [...query].every((ch) => ch === query[0]);
  const needle = cycling ? (query[0] as string) : query;
  const count = items.length;
  const begin = cycling ? from + 1 : Math.max(from, 0);
  for (let step = 0; step < count; step++) {
    const index = (((begin + step) % count) + count) % count;
    const item = items[index];
    if (item && enabled(item) && item.label.toLowerCase().startsWith(needle)) return index;
  }
  return -1;
}
