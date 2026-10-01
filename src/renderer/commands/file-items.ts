import type { FileSearchItem } from '@shared/api/fs';
import { basename, dirname, relativeTo, type Platform } from '@shared/paths';
import type { QuickItem } from './quick-input-controller';

export interface FileTarget {
  path: string;
  line?: number;
  column?: number;
}

export const RECENT_FILES_GROUP = 'Recently opened';

/** File name first, folder after it. Highlight positions in the path are split between the two. */
export function fileItemFromSearch(
  hit: FileSearchItem,
  position: { line?: number; column?: number },
): QuickItem<FileTarget> {
  const rel = hit.relativePath;
  const cut = rel.lastIndexOf('/') + 1;
  const name = rel.slice(cut);
  const dir = cut > 0 ? rel.slice(0, cut - 1) : '';
  const highlights: number[] = [];
  const descriptionHighlights: number[] = [];
  for (const p of hit.positions) {
    if (p >= cut) highlights.push(p - cut);
    else if (p < dir.length) descriptionHighlights.push(p);
  }
  return {
    id: hit.path,
    label: name,
    ...(dir ? { description: dir } : {}),
    highlights,
    ...(descriptionHighlights.length > 0 ? { descriptionHighlights } : {}),
    value: { path: hit.path, ...position },
  };
}

/** An already known absolute path, shown relative to the workspace when it lives inside it. */
export function fileItemFromPath(
  path: string,
  root: string | null,
  platform: Platform,
  extra: { group?: string; position?: { line?: number; column?: number } } = {},
): QuickItem<FileTarget> {
  const rel = root ? relativeTo(root, path, platform) : null;
  const dir = dirname(rel !== null && rel !== '' ? rel : path);
  return {
    id: path,
    label: basename(path),
    ...(dir ? { description: dir } : {}),
    ...(extra.group ? { group: extra.group } : {}),
    value: { path, ...extra.position },
  };
}

/** Native separators for a path typed with forward slashes (Windows accepts both; the editor compares them). */
export function nativePath(path: string, platform: Platform): string {
  return platform === 'win32' ? path.replace(/\//g, '\\') : path;
}
