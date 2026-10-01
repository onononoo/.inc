/**
 * Opening links in the system browser. Only http, https and mailto are ever handed to the
 * operating system, and administrators decide (policy `features.externalLinks`) whether that
 * happens silently, after a confirmation that shows the exact address, or never.
 */
import type { PolicyFeatures } from '@shared/policy';

export const EXTERNAL_PROTOCOLS: readonly string[] = ['http:', 'https:', 'mailto:'];

const MAX_URL_LENGTH = 2048;
/** Longest address shown in the confirmation; the real address is never truncated when opened. */
const MAX_DISPLAY_LENGTH = 600;

/**
 * Parse a link for the system browser. Returns null unless it is a well-formed http(s) or mailto
 * URL. Addresses with embedded credentials, whitespace or control characters are refused:
 * they exist to disguise where a link really goes.
 */
export function parseExternalUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text.length === 0 || text.length > MAX_URL_LENGTH) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f-\u009f]/.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (!EXTERNAL_PROTOCOLS.includes(url.protocol)) return null;
  if (url.protocol !== 'mailto:') {
    if (url.hostname === '') return null;
    if (url.username !== '' || url.password !== '') return null;
  }
  return url;
}

/** The address as shown in a confirmation: the normalised form (IDN hosts appear as punycode). */
export function displayUrl(url: URL): string {
  const text = url.href;
  if (text.length <= MAX_DISPLAY_LENGTH) return text;
  const half = Math.floor((MAX_DISPLAY_LENGTH - 3) / 2);
  return `${text.slice(0, half)}...${text.slice(text.length - half)}`;
}

export interface ExternalLinkDeps {
  mode: PolicyFeatures['externalLinks'];
  /** Ask the user; resolves true when they chose to open the link. */
  confirm(address: string): Promise<boolean>;
  /** Hand the link to the operating system. */
  open(href: string): Promise<void>;
  log(level: 'info' | 'warn', message: string): void;
}

/** Returns whether the link was opened. Never throws for a refused or failed link. */
export async function openExternalLink(raw: unknown, deps: ExternalLinkDeps): Promise<boolean> {
  const url = parseExternalUrl(raw);
  if (!url) {
    deps.log('warn', 'Refused an external link: unsupported or malformed address');
    return false;
  }
  if (deps.mode === 'deny') {
    deps.log('info', `External link blocked by policy (${url.protocol})`);
    return false;
  }
  if (deps.mode === 'prompt' && !(await deps.confirm(displayUrl(url)))) return false;
  try {
    await deps.open(url.href);
    return true;
  } catch (e) {
    deps.log('warn', `The system could not open the link (${url.protocol}): ${String(e)}`);
    return false;
  }
}
