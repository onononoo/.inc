import type { GitChangeCode } from '@shared/api/git';

/** One changed path from `git status --porcelain=v2`, with repository-relative POSIX paths. */
export interface ParsedEntry {
  kind: 'ordinary' | 'rename' | 'unmerged' | 'untracked' | 'ignored';
  /** Two-letter status as Git prints it ('.' for unchanged); '??' for untracked, '!!' for ignored. */
  xy: string;
  path: string;
  /** Source path of a rename or copy. */
  origPath?: string;
  /** Untracked folder reported as a whole (its path had a trailing slash in Git's output). */
  isDirectory: boolean;
}

export interface ParsedBranch {
  /** Full commit id, or null before the first commit. */
  oid: string | null;
  /** Branch name, or null when HEAD is detached. */
  head: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
}

export interface ParsedStatus {
  branch: ParsedBranch;
  /** The first `maxEntries` entries, in Git's order (sorted by path). */
  entries: ParsedEntry[];
  /** Every entry Git reported, including those beyond `maxEntries`. */
  totalChanged: number;
  truncated: boolean;
}

const CODES = new Set(['M', 'A', 'D', 'R', 'C', 'T']);

/** Status letter for one side; null for unchanged. Unmerged letters become modified. */
export function toChangeCode(letter: string | undefined): GitChangeCode | null {
  if (!letter || letter === '.') return null;
  if (CODES.has(letter)) return letter as GitChangeCode;
  if (letter === 'U') return 'M';
  return null;
}

/** First `count` space-separated fields and the remainder (which may contain spaces). */
function splitFields(text: string, count: number): { fields: string[]; rest: string } | null {
  const fields: string[] = [];
  let start = 0;
  for (let i = 0; i < count; i++) {
    const end = text.indexOf(' ', start);
    if (end === -1) return null;
    fields.push(text.slice(start, end));
    start = end + 1;
  }
  return { fields, rest: text.slice(start) };
}

/**
 * Incremental parser for `git status --porcelain=v2 -z --branch --untracked-files=normal`.
 *
 * Output is fed in as it arrives, so a status with hundreds of thousands of entries never has to
 * sit in memory at once: only the first `maxEntries` are kept, the rest are counted.
 */
export class PorcelainStatusParser {
  private carry: Buffer = Buffer.alloc(0);
  private waitingForOrigin: ParsedEntry | null = null;
  private readonly entries: ParsedEntry[] = [];
  private total = 0;
  private readonly branch: ParsedBranch = {
    oid: null,
    head: null,
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
  };

  constructor(private readonly maxEntries: number) {}

  push(chunk: Buffer): void {
    let buffer = this.carry.length > 0 ? Buffer.concat([this.carry, chunk]) : chunk;
    let start = 0;
    for (;;) {
      const end = buffer.indexOf(0, start);
      if (end === -1) break;
      this.consume(buffer.toString('utf8', start, end));
      start = end + 1;
    }
    buffer = buffer.subarray(start);
    this.carry = Buffer.from(buffer); // detach from the (possibly large) source chunk
  }

  finish(): ParsedStatus {
    if (this.carry.length > 0) {
      this.consume(this.carry.toString('utf8'));
      this.carry = Buffer.alloc(0);
    }
    this.waitingForOrigin = null;
    return {
      branch: { ...this.branch },
      entries: this.entries,
      totalChanged: this.total,
      truncated: this.total > this.entries.length,
    };
  }

  private consume(token: string): void {
    if (this.waitingForOrigin) {
      this.waitingForOrigin.origPath = token;
      this.waitingForOrigin = null;
      return;
    }
    if (token === '') return;
    switch (token[0]) {
      case '#':
        this.header(token);
        return;
      case '1': {
        const parsed = splitFields(token, 8);
        if (parsed) this.add({ kind: 'ordinary', xy: parsed.fields[1] ?? '..', path: parsed.rest });
        return;
      }
      case '2': {
        const parsed = splitFields(token, 9);
        if (!parsed) return;
        const entry = this.add({
          kind: 'rename',
          xy: parsed.fields[1] ?? '..',
          path: parsed.rest,
        });
        // The next token is the original path, whether or not this entry is stored.
        this.waitingForOrigin = entry ?? { kind: 'rename', xy: '..', path: '', isDirectory: false };
        return;
      }
      case 'u': {
        const parsed = splitFields(token, 10);
        if (parsed) this.add({ kind: 'unmerged', xy: parsed.fields[1] ?? 'UU', path: parsed.rest });
        return;
      }
      case '?':
        this.add({ kind: 'untracked', xy: '??', path: token.slice(2) });
        return;
      case '!':
        this.add({ kind: 'ignored', xy: '!!', path: token.slice(2) });
        return;
      default:
        return; // a record type from a newer Git: ignore it rather than fail
    }
  }

  private add(entry: Omit<ParsedEntry, 'isDirectory'>): ParsedEntry | null {
    this.total++;
    const isDirectory =
      (entry.kind === 'untracked' || entry.kind === 'ignored') && entry.path.endsWith('/');
    if (this.entries.length >= this.maxEntries) return null;
    const stored: ParsedEntry = {
      ...entry,
      path: isDirectory ? entry.path.slice(0, -1) : entry.path,
      isDirectory,
    };
    this.entries.push(stored);
    return stored;
  }

  private header(line: string): void {
    const space = line.indexOf(' ', 2);
    if (space === -1) return;
    const key = line.slice(2, space);
    const value = line.slice(space + 1);
    switch (key) {
      case 'branch.oid':
        this.branch.oid = value === '(initial)' ? null : value;
        return;
      case 'branch.head':
        this.branch.detached = value === '(detached)';
        this.branch.head = this.branch.detached ? null : value;
        return;
      case 'branch.upstream':
        this.branch.upstream = value;
        return;
      case 'branch.ab': {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        if (match) {
          this.branch.ahead = Number(match[1]);
          this.branch.behind = Number(match[2]);
        }
        return;
      }
      default:
        return;
    }
  }
}

/** Parse a complete status output; a convenience over `PorcelainStatusParser` for small inputs. */
export function parsePorcelainStatus(output: string | Buffer, maxEntries: number): ParsedStatus {
  const parser = new PorcelainStatusParser(maxEntries);
  parser.push(typeof output === 'string' ? Buffer.from(output, 'utf8') : output);
  return parser.finish();
}
