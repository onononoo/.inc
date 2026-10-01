import { create } from 'zustand';
import type { FileMatches, SearchMatch, SearchQuery, SearchStats } from '@shared/api/search';
import { describeError } from '@shared/errors';
import { isWithin, pathKey, type Platform } from '@shared/paths';
import { monaco } from '../monaco';
import { ipc, platform as hostPlatform } from '../services/ipc';
import { hasService, service } from '../services/registry';
import { getSection, setSection } from '../services/session';
import { useWorkspaceStore } from '../state/workspace-store';
import { expandReplacement, replaceOne } from './replace';

const platform = hostPlatform as Platform;
const HISTORY_KEY = 'inc.search.history';
const HISTORY_MAX = 10;
/** The characters that end a word, for whole-word matching in an open editor. */
const WORD_SEPARATORS = '`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?';

export interface SearchOptions {
  query: string;
  replacement: string;
  isRegex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  include: string;
  exclude: string;
}

export interface SearchState extends SearchOptions {
  replaceOpen: boolean;
  searchId: number | null;
  running: boolean;
  files: readonly FileMatches[];
  stats: SearchStats | null;
  error: string | null;
  collapsed: ReadonlySet<string>;
  /** Files changed on disk after the search; the results may be out of date. */
  stale: boolean;
  /** True once a search has been started for the current workspace. */
  searched: boolean;
  /** Bumped when the query field should take focus. */
  focusNonce: number;
  version: number;
}

const DEFAULTS: SearchOptions = {
  query: '',
  replacement: '',
  isRegex: false,
  caseSensitive: false,
  wholeWord: false,
  include: '',
  exclude: '',
};

export const useSearchStore = create<SearchState>(() => ({
  ...DEFAULTS,
  replaceOpen: false,
  searchId: null,
  running: false,
  files: [],
  stats: null,
  error: null,
  collapsed: new Set(),
  stale: false,
  searched: false,
  focusNonce: 0,
  version: 0,
}));

const get = () => useSearchStore.getState();
const patch = (change: Partial<SearchState>) =>
  useSearchStore.setState((s) => ({ ...change, version: s.version + 1 }));

export function focusQuery(): void {
  patch({ focusNonce: get().focusNonce + 1 });
}

export function setOptions(change: Partial<SearchOptions> & { replaceOpen?: boolean }): void {
  patch(change);
  persistOptions();
}

function persistOptions(): void {
  const { isRegex, caseSensitive, wholeWord, include, exclude, replaceOpen } = get();
  setSection('search', { isRegex, caseSensitive, wholeWord, include, exclude, replaceOpen });
}

/** Restore the options (not the results) saved with the workspace session. */
export function restoreOptions(): void {
  const saved = getSection<Partial<SearchOptions> & { replaceOpen?: boolean }>('search');
  if (!saved) return;
  patch({
    isRegex: saved.isRegex === true,
    caseSensitive: saved.caseSensitive === true,
    wholeWord: saved.wholeWord === true,
    include: typeof saved.include === 'string' ? saved.include : '',
    exclude: typeof saved.exclude === 'string' ? saved.exclude : '',
    replaceOpen: saved.replaceOpen === true,
  });
}

// --- history --------------------------------------------------------------------------------

export function readHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function remember(query: string): void {
  if (!query) return;
  const next = [query, ...readHistory().filter((q) => q !== query)].slice(0, HISTORY_MAX);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    /* history is a convenience */
  }
}

// --- running a search -----------------------------------------------------------------------

function splitGlobs(text: string): string[] {
  return text
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);
}

export function currentQuery(): SearchQuery {
  const s = get();
  return {
    pattern: s.query,
    isRegex: s.isRegex,
    caseSensitive: s.caseSensitive,
    wholeWord: s.wholeWord,
    include: splitGlobs(s.include),
    exclude: splitGlobs(s.exclude),
  };
}

let epoch = 0;

/** Start (or restart) the search for the current options. Streams results into the store. */
export async function runSearch(): Promise<void> {
  const mine = ++epoch;
  const previous = get().searchId;
  if (previous !== null) void ipc.invoke('search:cancel', previous).catch(() => undefined);
  const { query } = get();
  if (query === '') {
    patch({
      searchId: null,
      running: false,
      files: [],
      stats: null,
      error: null,
      stale: false,
      searched: false,
    });
    return;
  }
  patch({
    running: true,
    files: [],
    stats: null,
    error: null,
    stale: false,
    searched: true,
    searchId: null,
  });
  try {
    const { searchId } = await ipc.invoke('search:start', currentQuery());
    if (mine !== epoch) {
      void ipc.invoke('search:cancel', searchId).catch(() => undefined);
      return;
    }
    patch({ searchId });
    remember(query);
  } catch (error) {
    if (mine !== epoch) return;
    patch({ running: false, error: describeError(error) });
  }
}

export function cancelSearch(): void {
  epoch++;
  const { searchId } = get();
  if (searchId !== null) void ipc.invoke('search:cancel', searchId).catch(() => undefined);
  patch({ running: false });
}

export function onResults(event: { searchId: number; files: FileMatches[] }): void {
  const state = get();
  if (event.searchId !== state.searchId && state.searchId !== null) return;
  if (state.searchId === null && !state.running) return;
  patch({ files: [...state.files, ...event.files] });
}

export function onDone(event: { searchId: number; stats: SearchStats }): void {
  if (event.searchId !== get().searchId) return;
  patch({ running: false, stats: event.stats, error: event.stats.error ?? null });
}

/** A file result may be out of date once a file it lists changes. */
export function onFilesChanged(paths: readonly string[]): void {
  const state = get();
  if (state.files.length === 0 || state.stale) return;
  const listed = new Set(state.files.map((f) => pathKey(f.path, platform)));
  if (paths.some((p) => listed.has(pathKey(p, platform)))) patch({ stale: true });
}

export function clearResults(): void {
  cancelSearch();
  patch({ files: [], stats: null, error: null, stale: false, searched: false, searchId: null });
}

// --- tree state -----------------------------------------------------------------------------

export function toggleCollapsed(path: string): void {
  const collapsed = new Set(get().collapsed);
  if (collapsed.has(path)) collapsed.delete(path);
  else collapsed.add(path);
  patch({ collapsed });
}

export function collapseAll(): void {
  patch({ collapsed: new Set(get().files.map((f) => f.path)) });
}

export function expandAll(): void {
  patch({ collapsed: new Set() });
}

export function dismissFile(path: string): void {
  patch({ files: get().files.filter((f) => f.path !== path) });
}

export function dismissMatch(path: string, match: SearchMatch): void {
  const files = get()
    .files.map((f) =>
      f.path === path ? { ...f, matches: f.matches.filter((m) => m !== match) } : f,
    )
    .filter((f) => f.matches.length > 0);
  patch({ files });
}

export function totals(files: readonly FileMatches[]): { files: number; matches: number } {
  let matches = 0;
  for (const f of files) matches += f.matches.length;
  return { files: files.length, matches };
}

// --- replacing ------------------------------------------------------------------------------

function regexFor(options: SearchOptions): RegExp | null {
  if (!options.isRegex) return null;
  try {
    return new RegExp(options.query, `g${options.caseSensitive ? '' : 'i'}u`);
  } catch {
    try {
      return new RegExp(options.query, `g${options.caseSensitive ? '' : 'i'}`);
    } catch {
      return null;
    }
  }
}

function openModel(path: string) {
  if (!hasService('editor')) return null;
  const dirty = service('editor').getDirtyText(path) !== undefined;
  return dirty ? monaco.editor.getModel(monaco.Uri.file(path)) : null;
}

/** Replace in an open, unsaved document through its model, so it stays one undoable edit. */
function replaceInModel(
  path: string,
  options: SearchOptions,
  only?: SearchMatch,
): { replacements: number } | null {
  const model = openModel(path);
  if (!model) return null;
  const found = model.findMatches(
    options.query,
    true,
    options.isRegex,
    options.caseSensitive,
    options.wholeWord ? WORD_SEPARATORS : null,
    options.isRegex,
  );
  const edits = found
    .filter(
      (m) =>
        !only || (m.range.startLineNumber === only.line && m.range.startColumn === only.column),
    )
    .map((m) => ({
      range: m.range,
      text: options.isRegex
        ? expandReplacement(options.replacement, m.matches ?? [])
        : options.replacement,
    }));
  if (edits.length === 0) return { replacements: 0 };
  model.pushStackElement();
  model.pushEditOperations([], edits, () => null);
  model.pushStackElement();
  return { replacements: edits.length };
}

export interface ReplaceSummary {
  filesChanged: number;
  replacements: number;
  skipped: { path: string; reason: string }[];
}

/** Replace in every listed file. Open unsaved files go through the editor; the rest on disk. */
export async function replaceAll(files: readonly FileMatches[]): Promise<ReplaceSummary> {
  const options = get();
  const summary: ReplaceSummary = { filesChanged: 0, replacements: 0, skipped: [] };
  const onDisk: string[] = [];
  for (const file of files) {
    const viaModel = replaceInModel(file.path, options);
    if (viaModel) {
      if (viaModel.replacements > 0) {
        summary.filesChanged++;
        summary.replacements += viaModel.replacements;
      }
    } else {
      onDisk.push(file.path);
    }
  }
  if (onDisk.length > 0) {
    try {
      const result = await ipc.invoke('search:replace', {
        query: currentQuery(),
        replacement: options.replacement,
        files: onDisk.map((path) => ({ path })),
      });
      summary.filesChanged += result.filesChanged;
      summary.replacements += result.replacements;
      summary.skipped.push(...result.skipped);
    } catch (error) {
      for (const path of onDisk) summary.skipped.push({ path, reason: describeError(error) });
    }
  }
  return summary;
}

/** Replace one file's matches (all of them) or a single match. */
export async function replaceInFile(
  file: FileMatches,
  only?: SearchMatch,
): Promise<ReplaceSummary> {
  const options = get();
  if (!only) return replaceAll([file]);
  const summary: ReplaceSummary = { filesChanged: 0, replacements: 0, skipped: [] };
  const viaModel = replaceInModel(file.path, options, only);
  if (viaModel) {
    summary.filesChanged = viaModel.replacements > 0 ? 1 : 0;
    summary.replacements = viaModel.replacements;
    return summary;
  }
  try {
    const read = await ipc.invoke('fs:readFile', file.path);
    if (read.kind !== 'text') throw new Error('The file is not a text file.');
    const next = replaceOne(
      read.content,
      { line: only.line, column: only.column, length: only.length },
      {
        replacement: options.replacement,
        matchedText: only.preview.slice(only.previewMatchStart, only.previewMatchEnd),
        regex: regexFor(options),
      },
    );
    if (next === null) {
      summary.skipped.push({ path: file.path, reason: 'The file changed since the search.' });
      return summary;
    }
    await ipc.invoke('fs:writeFile', file.path, next, {
      encoding: read.encoding,
      expectedMtimeMs: read.mtimeMs,
    });
    summary.filesChanged = 1;
    summary.replacements = 1;
  } catch (error) {
    summary.skipped.push({ path: file.path, reason: describeError(error) });
  }
  return summary;
}

/** True when the path is inside the workspace (results outside it are never offered). */
export function insideWorkspace(path: string): boolean {
  const root = useWorkspaceStore.getState().workspace?.root;
  return !!root && isWithin(root, path, platform);
}
