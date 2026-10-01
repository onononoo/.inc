/**
 * The explorer's tree as plain data and pure functions: which rows are visible, how a new name is
 * validated, what a copy is called, and where a drop is allowed. The store applies results from
 * the file system to this model; the view renders its rows.
 */
import type { FileEntry } from '@shared/api/fs';
import { basename, dirname, isWithin, join, pathKey, type Platform } from '@shared/paths';

export interface TreeState {
  root: string | null;
  /** Children of every folder that has been read, folders first then files. */
  listings: Readonly<Record<string, readonly FileEntry[]>>;
  expanded: ReadonlySet<string>;
  /** Folders whose listing is being read right now. */
  loading: ReadonlySet<string>;
  /** Folders that could not be read, with a plain-language reason. */
  errors: Readonly<Record<string, string>>;
}

export const EMPTY_TREE: TreeState = {
  root: null,
  listings: {},
  expanded: new Set(),
  loading: new Set(),
  errors: {},
};

export type EditState =
  { type: 'create'; kind: 'file' | 'directory'; parent: string } | { type: 'rename'; path: string };

export type TreeRow =
  | {
      type: 'node';
      path: string;
      name: string;
      kind: 'file' | 'directory';
      isSymlink: boolean;
      depth: number;
      expanded: boolean;
      loading: boolean;
    }
  | { type: 'create'; kind: 'file' | 'directory'; parent: string; depth: number }
  | { type: 'error'; path: string; message: string; depth: number };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Folders first, then natural name order; the same order the main process lists in. */
export function compareEntries(a: FileEntry, b: FileEntry): number {
  if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
  return collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/** The rows to show, top to bottom, for the current tree and (optional) inline edit. */
export function flatten(state: TreeState, edit: EditState | null = null): TreeRow[] {
  const rows: TreeRow[] = [];
  const { root } = state;
  if (!root) return rows;

  const visit = (dir: string, depth: number) => {
    const failure = state.errors[dir];
    if (failure) {
      rows.push({ type: 'error', path: dir, message: failure, depth });
      return;
    }
    if (edit?.type === 'create' && edit.parent === dir) {
      rows.push({ type: 'create', kind: edit.kind, parent: dir, depth });
    }
    for (const entry of state.listings[dir] ?? []) {
      const isDir = entry.kind === 'directory';
      const open = isDir && state.expanded.has(entry.path);
      rows.push({
        type: 'node',
        path: entry.path,
        name: entry.name,
        kind: entry.kind,
        isSymlink: entry.isSymlink,
        depth,
        expanded: open,
        loading: isDir && state.loading.has(entry.path),
      });
      if (open) visit(entry.path, depth + 1);
    }
  };
  visit(root, 0);
  return rows;
}

/** Index of the row for a path, or -1. */
export function indexOfPath(rows: readonly TreeRow[], path: string, platform: Platform): number {
  const key = pathKey(path, platform);
  return rows.findIndex((r) => r.type === 'node' && pathKey(r.path, platform) === key);
}

/** Remove everything the tree remembers about a folder and what is below it. */
export function forgetSubtree(state: TreeState, folder: string, platform: Platform): TreeState {
  const under = (p: string) =>
    pathKey(p, platform) === pathKey(folder, platform) || isWithin(folder, p, platform);
  const listings: Record<string, readonly FileEntry[]> = {};
  for (const [dir, entries] of Object.entries(state.listings))
    if (!under(dir)) listings[dir] = entries;
  const errors: Record<string, string> = {};
  for (const [dir, message] of Object.entries(state.errors)) if (!under(dir)) errors[dir] = message;
  return {
    ...state,
    listings,
    errors,
    expanded: new Set([...state.expanded].filter((p) => !under(p))),
    loading: new Set([...state.loading].filter((p) => !under(p))),
  };
}

// --- names ----------------------------------------------------------------------------------

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f]/;
const WINDOWS_ILLEGAL = /[<>:"|?*]/;

export interface NameCheck {
  ok: boolean;
  /** Plain-language reason when not ok. */
  message?: string;
}

/**
 * Check a name typed for a new or renamed entry. `allowSeparators` lets a new item be typed as a
 * path ("src/utils/a.ts"); each segment is checked on its own.
 */
export function validateName(
  raw: string,
  options: {
    platform: Platform;
    siblings: readonly string[];
    allowSeparators: boolean;
    /** The current name when renaming, so keeping it is not a clash. */
    current?: string;
  },
): NameCheck {
  const { platform, siblings, allowSeparators } = options;
  const name = raw.trim();
  if (name === '') return { ok: false, message: 'A name is required.' };
  const hasSeparator = /[\\/]/.test(name);
  if (hasSeparator && !allowSeparators) {
    return { ok: false, message: 'A name cannot contain slashes.' };
  }
  const parts = hasSeparator ? name.split(/[\\/]/) : [name];
  for (const part of parts) {
    if (part === '') return { ok: false, message: 'A path cannot have an empty segment.' };
    if (part === '.' || part === '..')
      return { ok: false, message: `"${part}" is not a valid name.` };
    if (CONTROL.test(part))
      return { ok: false, message: 'The name contains an invalid character.' };
    if (part.length > 255) return { ok: false, message: 'The name is too long.' };
    if (platform === 'win32') {
      if (WINDOWS_ILLEGAL.test(part)) {
        return {
          ok: false,
          message: 'A name cannot contain any of these characters: < > : " | ? *',
        };
      }
      if (/[. ]$/.test(part))
        return { ok: false, message: 'A name cannot end with a dot or a space.' };
      if (WINDOWS_RESERVED.test(part))
        return { ok: false, message: `"${part}" is a reserved name on Windows.` };
    }
  }
  // A path such as "src/a.ts" may go into a folder that exists; only a plain name can clash.
  if (parts.length === 1) {
    const caseInsensitive = platform !== 'linux';
    const norm = (value: string) => (caseInsensitive ? value.toLowerCase() : value);
    const clash = siblings.some((s) => norm(s) === norm(name) && s !== options.current);
    if (clash) return { ok: false, message: `"${name}" already exists in this folder.` };
  }
  return { ok: true };
}

/** "name copy.ext", "name copy 2.ext", ... the first one that is not taken. */
export function uniqueCopyName(name: string, taken: readonly string[], platform: Platform): string {
  const caseInsensitive = platform !== 'linux';
  const norm = (s: string) => (caseInsensitive ? s.toLowerCase() : s);
  const used = new Set(taken.map(norm));
  if (!used.has(norm(name))) return name;
  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0;
  const stem = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : '';
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? ' copy' : ` copy ${n}`;
    const candidate = `${stem}${suffix}${ext}`;
    if (!used.has(norm(candidate))) return candidate;
  }
}

/** Selection start for a rename: the base name without the extension. */
export function baseNameRange(name: string, isFile: boolean): [number, number] {
  const dot = name.lastIndexOf('.');
  return [0, isFile && dot > 0 ? dot : name.length];
}

// --- moving ---------------------------------------------------------------------------------

export type DropVerdict = { ok: true; target: string } | { ok: false; reason: string };

/**
 * Can `sources` be dropped on `targetPath`? Dropping on a file drops into its folder. A folder
 * cannot go into itself or below itself, and dropping where an item already lives does nothing.
 */
export function checkDrop(
  sources: readonly string[],
  targetPath: string,
  targetIsDirectory: boolean,
  platform: Platform,
): DropVerdict {
  const target = targetIsDirectory ? targetPath : dirname(targetPath);
  const targetKey = pathKey(target, platform);
  let movable = 0;
  for (const source of sources) {
    const sourceKey = pathKey(source, platform);
    if (sourceKey === targetKey || isWithin(source, target, platform)) {
      return { ok: false, reason: 'A folder cannot be moved into itself.' };
    }
    if (pathKey(dirname(source), platform) !== targetKey) movable++;
  }
  return movable === 0
    ? { ok: false, reason: 'The items are already in this folder.' }
    : { ok: true, target };
}

/** Destination path for an item moved or copied into `folder`. */
export function destinationFor(source: string, folder: string): string {
  return join(folder, basename(source));
}

/** Keep only the topmost paths: a folder and a file inside it selected together count once. */
export function topmostPaths(paths: readonly string[], platform: Platform): string[] {
  return paths.filter((p) => !paths.some((other) => other !== p && isWithin(other, p, platform)));
}
