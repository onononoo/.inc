/** Most recently used commands, kept on this device only. */

const STORAGE_KEY = 'inc.commands.recent';
export const MAX_RECENT_COMMANDS = 10;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** `localStorage` can be missing or throw (blocked storage, private windows); callers must cope. */
function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export interface RecentCommands {
  /** Newest first, at most `MAX_RECENT_COMMANDS`. */
  get(): string[];
  record(id: string): void;
}

function parse(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    for (const entry of value) {
      if (typeof entry === 'string' && entry !== '') seen.add(entry);
      if (seen.size === MAX_RECENT_COMMANDS) break;
    }
    return [...seen];
  } catch {
    return [];
  }
}

export function createRecentCommands(storage?: StorageLike | null): RecentCommands {
  const store = storage === undefined ? defaultStorage() : storage;
  let cache: string[] | null = null;

  const read = (): string[] => {
    if (cache) return cache;
    let raw: string | null;
    try {
      raw = store?.getItem(STORAGE_KEY) ?? null;
    } catch {
      raw = null;
    }
    cache = parse(raw);
    return cache;
  };

  return {
    get: () => [...read()],
    record(id) {
      if (!id) return;
      cache = [id, ...read().filter((existing) => existing !== id)].slice(0, MAX_RECENT_COMMANDS);
      try {
        store?.setItem(STORAGE_KEY, JSON.stringify(cache));
      } catch {
        // The in-memory list still orders this session; it is only lost on restart.
      }
    },
  };
}
