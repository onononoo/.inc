import path from 'node:path';
import { IncError } from '@shared/errors';
import { relativeTo, segments, type Platform } from '@shared/paths';

const MAX_PATH_LENGTH = 32_768;
const MAX_PATH_COUNT = 200_000;

/** Characters of pathspec arguments sent to one Git process (Windows allows about 32 000). */
export const ARGUMENT_BUDGET_CHARS = 24_000;

function invalid(message: string, details?: unknown): IncError {
  return new IncError('E_INVALID', message, details);
}

/** True when the string is an absolute path on this platform (and not drive-relative). */
function isAbsolutePath(value: string, platform: Platform): boolean {
  if (platform === 'win32') {
    if (/^[\\/](?![\\/])/.test(value)) return false; // "\dir" depends on the current drive
    return path.win32.isAbsolute(value);
  }
  return path.posix.isAbsolute(value);
}

export interface PathCheck {
  /** Absolute repository top level. */
  repoRoot: string;
  platform: Platform;
  /** Allow the repository root itself (an empty relative path). */
  allowRoot?: boolean;
}

/**
 * Check one absolute path received over IPC and return it relative to the repository root with
 * forward slashes ('' for the root). Rejects relative paths, paths outside the repository and
 * anything inside the `.git` folder.
 */
export function toRepoRelative(input: unknown, check: PathCheck): string {
  if (typeof input !== 'string' || input === '') {
    throw invalid('Choose a file or folder.');
  }
  if (input.length > MAX_PATH_LENGTH || input.includes('\0')) {
    throw invalid('That is not a valid path.');
  }
  if (!isAbsolutePath(input, check.platform)) {
    throw invalid('The path must be absolute.', { path: input });
  }
  const pathApi = check.platform === 'win32' ? path.win32 : path.posix;
  const resolved = pathApi.resolve(input);
  const relative = relativeTo(check.repoRoot, resolved, check.platform);
  if (relative === null) {
    throw invalid('That path is outside the repository.', { path: input });
  }
  if (relative === '' && !check.allowRoot) {
    throw invalid('Choose files or folders inside the repository, not the repository itself.');
  }
  if (segments(relative).some((segment) => segment.toLowerCase() === '.git')) {
    throw invalid('Paths inside the .git folder cannot be changed.', { path: input });
  }
  return relative;
}

/** Validate a list of absolute paths; duplicates are removed. */
export function toRepoRelativeList(inputs: unknown, check: PathCheck): string[] {
  if (!Array.isArray(inputs)) throw invalid('Expected a list of paths.');
  if (inputs.length > MAX_PATH_COUNT) {
    throw invalid(`Too many paths at once (the limit is ${MAX_PATH_COUNT}).`);
  }
  const unique = new Set<string>();
  for (const input of inputs) unique.add(toRepoRelative(input, check));
  return [...unique];
}

/** Split pathspecs into batches that fit the command-line limit. */
export function chunkPathspecs(
  specs: readonly string[],
  budget = ARGUMENT_BUDGET_CHARS,
): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const spec of specs) {
    const cost = spec.length + 1;
    if (current.length > 0 && size + cost > budget) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(spec);
    size += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** A set of repository-relative file paths that can also answer "is anything under this folder". */
export class PathIndex {
  private readonly files: string[];
  private readonly lookup: Set<string>;

  constructor(files: Iterable<string>) {
    this.lookup = new Set(files);
    this.files = [...this.lookup].sort(compareUnits);
  }

  get size(): number {
    return this.lookup.size;
  }

  has(file: string): boolean {
    return this.lookup.has(file);
  }

  /** True when at least one file lives under the folder `directory`. */
  hasDescendant(directory: string): boolean {
    const prefix = directory === '' ? '' : directory + '/';
    let low = 0;
    let high = this.files.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if ((this.files[mid] as string) < prefix) low = mid + 1;
      else high = mid;
    }
    const candidate = this.files[low];
    return candidate !== undefined && candidate.startsWith(prefix);
  }

  /** True for a file in the set, or a folder containing one. */
  covers(spec: string): boolean {
    return this.has(spec) || this.hasDescendant(spec);
  }

  /** Every file in the set, sorted. */
  toArray(): string[] {
    return [...this.files];
  }
}

function compareUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
