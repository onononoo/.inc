/**
 * What the settings editor shows: which settings match a search and a category, how a row is
 * presented (modified, locked, restricted), and how typed text becomes a value. Pure, so the rules
 * are unit tested without a DOM.
 */
import type { SettingsSnapshot } from '@shared/api/settings';
import { SETTINGS, type SettingCategory, type SettingDef, type SettingKey } from '@shared/settings';

export type Scope = 'user' | 'workspace';
export type CategoryFilter = SettingCategory | 'modified' | 'managed' | 'all';

export const ALL_SETTINGS: readonly SettingDef[] = Object.values(SETTINGS) as SettingDef[];

/** Every term of the query must appear in the title, description, key, category or tags. */
export function matchesQuery(def: SettingDef, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = [def.title, def.description, def.key, def.category, ...(def.tags ?? [])]
    .join(' ')
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/** Title matches rank above description matches, so searching "font" lists the font settings first. */
export function rankScore(def: SettingDef, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const title = def.title.toLowerCase();
  if (title === q) return 0;
  if (title.startsWith(q)) return 1;
  if (title.includes(q)) return 2;
  if (def.key.toLowerCase().includes(q)) return 3;
  return 4;
}

export interface RowState {
  def: SettingDef;
  /** The value in effect. */
  value: unknown;
  /** The value is set in the layer being edited. */
  modified: boolean;
  /** Enforced by the organization's policy: shown but not editable. */
  locked: boolean;
  /** Ignored in this (untrusted) workspace until it is trusted. */
  restricted: boolean;
  /** Where the effective value comes from. */
  source: 'default' | 'user' | 'workspace' | 'policy';
}

export function rowState(
  def: SettingDef,
  snapshot: SettingsSnapshot,
  scope: Scope,
  trusted: boolean,
): RowState {
  const key = def.key as SettingKey;
  const layer = scope === 'user' ? snapshot.user : snapshot.workspace;
  return {
    def,
    value: snapshot.effective[key],
    modified: Object.prototype.hasOwnProperty.call(layer, key),
    locked: snapshot.locked.includes(key),
    restricted: scope === 'workspace' && !!def.restricted && !trusted,
    source: snapshot.sources[key] ?? 'default',
  };
}

export interface VisibleOptions {
  query: string;
  category: CategoryFilter;
  scope: Scope;
  trusted: boolean;
}

/** The rows to show for a search and a filter, best matches first. */
export function visibleRows(snapshot: SettingsSnapshot, options: VisibleOptions): RowState[] {
  const { query, category, scope, trusted } = options;
  const rows: RowState[] = [];
  for (const def of ALL_SETTINGS) {
    // A workspace file can only override settings whose scope allows it.
    if (scope === 'workspace' && def.scope !== 'workspace') continue;
    if (!matchesQuery(def, query)) continue;
    const row = rowState(def, snapshot, scope, trusted);
    if (category === 'modified' && !row.modified) continue;
    if (category === 'managed' && !row.locked) continue;
    if (
      category !== 'all' &&
      category !== 'modified' &&
      category !== 'managed' &&
      def.category !== category
    )
      continue;
    rows.push(row);
  }
  if (query.trim()) rows.sort((a, b) => rankScore(a.def, query) - rankScore(b.def, query));
  return rows;
}

/** Category counts for the sidebar of the editor, for the current search. */
export function categoryCounts(
  snapshot: SettingsSnapshot,
  options: Omit<VisibleOptions, 'category'>,
): Record<string, number> {
  const counts: Record<string, number> = { all: 0, modified: 0, managed: 0 };
  for (const def of ALL_SETTINGS) {
    if (options.scope === 'workspace' && def.scope !== 'workspace') continue;
    if (!matchesQuery(def, options.query)) continue;
    const row = rowState(def, snapshot, options.scope, options.trusted);
    counts.all = (counts.all ?? 0) + 1;
    counts[def.category] = (counts[def.category] ?? 0) + 1;
    if (row.modified) counts.modified = (counts.modified ?? 0) + 1;
    if (row.locked) counts.managed = (counts.managed ?? 0) + 1;
  }
  return counts;
}

// --- typed input ----------------------------------------------------------------------------

/** Parse a number typed into a field. Returns null for anything that is not a plain finite number. */
export function parseNumberInput(text: string): number | null {
  const trimmed = text.trim();
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** Split text typed into a list editor ("a, b") into entries, trimming and dropping empties. */
export function parseListInput(
  text: string,
  type: 'string[]' | 'number[]',
): { values: (string | number)[]; invalid: string[] } {
  const parts = text
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (type === 'string[]') return { values: parts, invalid: [] };
  const values: number[] = [];
  const invalid: string[] = [];
  for (const part of parts) {
    const n = parseNumberInput(part);
    if (n === null) invalid.push(part);
    else values.push(n);
  }
  return { values, invalid };
}

/** Short text for a value, for the tooltip of the "managed" lock and the policy view. */
export function describeValue(value: unknown): string {
  if (typeof value === 'string') return value === '' ? '(empty)' : value;
  if (Array.isArray(value)) return value.length === 0 ? '(empty list)' : value.join(', ');
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.length === 0
      ? '(none)'
      : entries.map(([k, v]) => `${k}: ${String(v)}`).join(', ');
  }
  return String(value);
}

/** "Editor: Font size" is shown as a dimmed category and a semibold name, with one fixed gap. */
export function splitTitle(def: SettingDef): { prefix: string; name: string } {
  return { prefix: def.category, name: def.title };
}
