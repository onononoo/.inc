/**
 * Maps an `inc://app/<path>` request to a file under the renderer bundle, refusing anything
 * that could escape it. Pure: no file system access (the caller checks that the file exists).
 */
import path from 'node:path';

export type AppFileResolution =
  | { ok: true; file: string }
  | { ok: false; status: 400 | 403 | 404; reason: string };

export function resolveAppFile(
  root: string,
  rawUrl: string,
  pathApi: Pick<typeof path, 'resolve' | 'sep'> = path,
): AppFileResolution {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, status: 400, reason: 'Malformed URL' };
  }
  if (url.host !== 'app') return { ok: false, status: 404, reason: 'Unknown host' };

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return { ok: false, status: 400, reason: 'Malformed escape sequence' };
  }
  // Backslashes, colons (drive letters, alternate data streams) and NUL never belong in an
  // app resource path. Rejecting them outright keeps Windows and POSIX behaviour identical.
  if (/[\\:\0]/.test(pathname)) return { ok: false, status: 403, reason: 'Forbidden character' };

  const segments = pathname.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.includes('..')) return { ok: false, status: 403, reason: 'Path traversal' };
  if (segments.length === 0) segments.push('index.html');

  const base = pathApi.resolve(root);
  const file = pathApi.resolve(base, ...segments);
  if (!file.startsWith(base + pathApi.sep)) {
    return { ok: false, status: 403, reason: 'Outside the renderer root' };
  }
  return { ok: true, file };
}
