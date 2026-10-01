import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SessionBlob } from '@shared/api/workspace';
import { IncError } from '@shared/errors';
import { pathKey, type Platform } from '@shared/paths';
import { writeFileAtomic } from './atomic-file';

/** Largest serialised session blob accepted. Larger state is refused rather than truncated. */
export const MAX_SESSION_BYTES = 2 * 1024 * 1024;
/** Envelope overhead allowed on top of the blob when reading a file back. */
const ENVELOPE_SLACK_BYTES = 8 * 1024;
const FORMAT = 1;
/** Sessions of workspaces not opened for this long are removed at startup. */
export const SESSION_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

/** On-disk envelope. `key` is the path key of the workspace, or null for the empty window. */
interface SessionFile {
  format: number;
  key: string | null;
  savedAt: number;
  blob: SessionBlob;
}

/**
 * Per-workspace UI state, stored as `sessions/<sha1 of the normalised root | "empty">.json`.
 *
 * The blob is opaque to this class apart from its `version` (the renderer decides whether it can
 * use it). Any file that is unreadable, oversized, of another format or written for a different
 * workspace is treated as absent.
 */
export class SessionStore {
  private readonly dir: string;
  /** Saves for one file are applied in order, so a slow older write cannot land after a newer one. */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    userDataDir: string,
    private readonly platform: Platform,
    private readonly warn: (message: string) => void,
  ) {
    this.dir = path.join(userDataDir, 'sessions');
  }

  fileFor(root: string | null): string {
    const name =
      root === null
        ? 'empty'
        : createHash('sha1').update(pathKey(root, this.platform)).digest('hex');
    return path.join(this.dir, `${name}.json`);
  }

  async load(root: string | null): Promise<SessionBlob | null> {
    const file = this.fileFor(root);
    let text: string;
    try {
      const stat = await fs.promises.stat(file);
      if (!stat.isFile() || stat.size > MAX_SESSION_BYTES + ENVELOPE_SLACK_BYTES) {
        this.warn(`Ignoring session file ${path.basename(file)}: unexpected size or type`);
        return null;
      }
      text = await fs.promises.readFile(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.warn(`Could not read session ${path.basename(file)}: ${(e as Error).message}`);
      }
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.warn(`Session ${path.basename(file)} is not valid JSON and was ignored`);
      return null;
    }
    const envelope = parsed as Partial<SessionFile> | null;
    const expectedKey = root === null ? null : pathKey(root, this.platform);
    if (
      !envelope ||
      typeof envelope !== 'object' ||
      envelope.format !== FORMAT ||
      envelope.key !== expectedKey ||
      !isSessionBlob(envelope.blob)
    ) {
      this.warn(`Session ${path.basename(file)} has an unsupported format and was ignored`);
      return null;
    }
    return envelope.blob;
  }

  async save(root: string | null, blob: unknown): Promise<void> {
    const { json, bytes } = serialiseBlob(blob);
    if (bytes > MAX_SESSION_BYTES) {
      throw new IncError(
        'E_TOO_LARGE',
        `Session state is ${bytes} bytes; the limit is ${MAX_SESSION_BYTES} bytes.`,
        { bytes, limit: MAX_SESSION_BYTES },
      );
    }
    const key = root === null ? null : pathKey(root, this.platform);
    // The blob is already serialised; splice it in rather than serialising megabytes again.
    const text = `{"format":${FORMAT},"key":${JSON.stringify(key)},"savedAt":${Date.now()},"blob":${json}}`;
    const file = this.fileFor(root);
    const previous = this.queues.get(file) ?? Promise.resolve();
    const write = previous.then(() => writeFileAtomic(file, text));
    const tail = write.catch(() => undefined);
    this.queues.set(file, tail);
    try {
      await write;
    } finally {
      if (this.queues.get(file) === tail) this.queues.delete(file);
    }
  }

  /** Remove sessions whose files have not been written for {@link SESSION_RETENTION_MS}. */
  async pruneStale(now = Date.now()): Promise<number> {
    let removed = 0;
    let names: string[];
    try {
      names = await fs.promises.readdir(this.dir);
    } catch {
      return 0;
    }
    for (const name of names) {
      if (!/^(?:[0-9a-f]{40}|empty)\.json$/.test(name)) continue;
      const file = path.join(this.dir, name);
      try {
        const stat = await fs.promises.stat(file);
        if (stat.isFile() && now - stat.mtimeMs > SESSION_RETENTION_MS) {
          await fs.promises.rm(file, { force: true });
          removed++;
        }
      } catch {
        /* raced with a save or a removal; leave it for the next start */
      }
    }
    return removed;
  }
}

function isSessionBlob(value: unknown): value is SessionBlob {
  if (!value || typeof value !== 'object') return false;
  const blob = value as Partial<SessionBlob>;
  return Number.isSafeInteger(blob.version) && (blob.version as number) >= 1 && 'data' in blob;
}

function serialiseBlob(value: unknown): { json: string; bytes: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IncError('E_INVALID', 'The session state must be an object.');
  }
  const blob = value as Partial<SessionBlob>;
  if (!Number.isSafeInteger(blob.version) || (blob.version as number) < 1) {
    throw new IncError('E_INVALID', 'The session version must be a positive integer.');
  }
  if (blob.data === undefined) {
    throw new IncError('E_INVALID', 'The session state has no data.');
  }
  let json: string | undefined;
  try {
    json = JSON.stringify({ version: blob.version, data: blob.data });
  } catch {
    json = undefined;
  }
  if (json === undefined) {
    throw new IncError('E_INVALID', 'The session data cannot be stored as JSON.');
  }
  return { json, bytes: Buffer.byteLength(json, 'utf8') };
}
