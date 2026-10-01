import path from 'node:path';
import { pathKey, type Platform } from '@shared/paths';
import { readJsonFileSync, writeFileAtomicSync } from './atomic-file';

const FORMAT = 1;

interface TrustRecord {
  /** The folder as the user opened it, kept for support and diagnostics. */
  path: string;
  trustedAt: number;
}

interface TrustFile {
  version: number;
  trusted: Record<string, TrustRecord>;
}

/**
 * The folders the user has explicitly trusted, persisted in `trust.json`.
 *
 * Only grants are stored: a folder that is absent is untrusted, so a damaged or unreadable file
 * fails safe (everything untrusted). Trust is per folder; a folder inside a trusted parent is not
 * implicitly trusted. Lookups are in-memory and synchronous; every change is written atomically
 * before the call returns.
 */
export class TrustStore {
  private readonly file: string;
  private records = new Map<string, TrustRecord>();

  constructor(
    userDataDir: string,
    private readonly platform: Platform,
    private readonly warn: (message: string) => void,
  ) {
    this.file = path.join(userDataDir, 'trust.json');
    this.load();
  }

  isTrusted(folder: string): boolean {
    return this.records.has(pathKey(folder, this.platform));
  }

  /** Persist a decision. Throws when the file cannot be written; memory is left unchanged then. */
  set(folder: string, trusted: boolean): void {
    const key = pathKey(folder, this.platform);
    const had = this.records.get(key);
    if (trusted === (had !== undefined)) return;
    const next = new Map(this.records);
    if (trusted) next.set(key, { path: folder, trustedAt: Date.now() });
    else next.delete(key);
    this.persist(next);
    this.records = next;
  }

  private load(): void {
    const raw = readJsonFileSync(this.file, this.warn);
    if (!raw || typeof raw !== 'object') return;
    const file = raw as Partial<TrustFile>;
    if (file.version !== FORMAT || !file.trusted || typeof file.trusted !== 'object') {
      this.warn('trust.json has an unsupported format; all folders are untrusted');
      return;
    }
    for (const [key, record] of Object.entries(file.trusted)) {
      if (!record || typeof record !== 'object') continue;
      const { path: folder, trustedAt } = record as Partial<TrustRecord>;
      if (typeof folder !== 'string' || !path.isAbsolute(folder)) continue;
      // Re-derive the key so a hand-edited or cross-platform file cannot smuggle in a wrong key.
      if (pathKey(folder, this.platform) !== key) continue;
      this.records.set(key, {
        path: folder,
        trustedAt: Number.isFinite(trustedAt) ? trustedAt! : 0,
      });
    }
  }

  private persist(records: Map<string, TrustRecord>): void {
    const body: TrustFile = { version: FORMAT, trusted: Object.fromEntries(records) };
    writeFileAtomicSync(this.file, JSON.stringify(body, null, 2) + '\n');
  }
}
