/**
 * Which frames may talk to the main process. Only the top-level document served from the app's
 * own origin qualifies: anything else (another scheme, a look-alike host, a sub-frame) is
 * rejected, so even a compromised page that somehow loaded elsewhere cannot reach a handler.
 */
import { APP_SCHEME } from '@shared/ipc';

const MAX_URL_LENGTH = 2048;

/** True for `inc://app/...` without credentials or a port. */
export function isTrustedFrameUrl(url: unknown): boolean {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL_LENGTH) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === `${APP_SCHEME}:` &&
    parsed.host === 'app' &&
    parsed.username === '' &&
    parsed.password === ''
  );
}

export interface SenderFrameLike {
  url: string;
  /** null for the top-level frame. */
  parent: unknown;
}

/** True for a live, top-level frame of the app origin. `frame` is null once the frame is gone. */
export function isTrustedSenderFrame(frame: SenderFrameLike | null | undefined): boolean {
  return !!frame && frame.parent === null && isTrustedFrameUrl(frame.url);
}
