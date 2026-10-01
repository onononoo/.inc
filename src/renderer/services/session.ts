import type { SessionBlob } from '@shared/api/workspace';
import { ipc } from './ipc';

/**
 * Persisted UI state for the current workspace, shared by several slices.
 *
 * The blob is `{ version, data }` where `data` maps a section name to that slice's own
 * JSON-serialisable state ("editor", "layout", "explorer", "search", ...). Each slice reads its
 * section once at startup with `getSection` and writes it with `setSection`; writes are batched.
 * A slice must tolerate its section being missing or from an older shape.
 */
const VERSION = 1;
const FLUSH_MS = 600;

let sections: Record<string, unknown> = {};
let timer: ReturnType<typeof setTimeout> | undefined;

export async function loadSession(): Promise<void> {
  try {
    const blob = await ipc.invoke('session:load');
    if (blob && blob.version === VERSION && blob.data && typeof blob.data === 'object') {
      sections = { ...(blob.data as Record<string, unknown>) };
    }
  } catch {
    sections = {};
  }
}

export function getSection<T>(name: string): T | undefined {
  return sections[name] as T | undefined;
}

export function setSection(name: string, value: unknown): void {
  sections[name] = value;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void flushSession(), FLUSH_MS);
}

export async function flushSession(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = undefined;
  const blob: SessionBlob = { version: VERSION, data: sections };
  try {
    await ipc.invoke('session:save', blob);
  } catch {
    /* persisting UI state is best effort */
  }
}

/** Forget in-memory sections (used when the workspace changes and a new session is loaded). */
export function resetSession(): void {
  sections = {};
}

window.addEventListener('beforeunload', () => void flushSession());
