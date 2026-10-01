import { app, net, protocol, session } from 'electron';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { APP_ORIGIN, APP_SCHEME } from '@shared/ipc';
import type { Logger } from './kernel';
import { resolveAppFile } from './shell/protocol-paths';
import { securityStats } from './shell/security-stats';

/**
 * Content security policy for the renderer. No remote origins, no eval, no inline scripts.
 * Inline styles are allowed because Monaco and React set element styles at runtime.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Must run before `app.whenReady()`. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    },
  ]);
}

function plain(status: number, text: string): Response {
  return new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

/**
 * Serve the bundled renderer from `rendererDir` at inc://app/. Only GET and HEAD, only regular
 * files below the root: traversal, drive-letter and backslash tricks, and directory listings
 * are all refused.
 */
export function registerAppProtocol(rendererDir: string, logger: Logger): void {
  const root = path.resolve(rendererDir);
  protocol.handle(APP_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return plain(405, 'Method not allowed');
    }
    const resolved = resolveAppFile(root, request.url);
    if (!resolved.ok) {
      logger.warn(`Refused app request (${resolved.reason}): ${request.url}`);
      return plain(resolved.status, resolved.reason);
    }
    let isFile = false;
    try {
      isFile = (await fs.promises.stat(resolved.file)).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) return plain(404, 'Not found');

    const upstream = await net.fetch(pathToFileURL(resolved.file).toString(), {
      bypassCustomProtocolHandlers: true,
    });
    const headers = new Headers(upstream.headers);
    headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    return new Response(upstream.body, { status: upstream.status, headers });
  });
}

/** Permissions the app page may use. Everything else (camera, location, notifications...) is denied. */
const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-read', 'clipboard-sanitized-write']);

function isAppRequester(origin: string | undefined): boolean {
  return origin === APP_ORIGIN || origin === `${APP_ORIGIN}/`;
}

/**
 * The renderer never needs the network: every remote request is cancelled, permissions
 * are denied, and only the app scheme is allowed. This is what makes ".inc sends nothing
 * anywhere" verifiable rather than a promise. Blocked requests are counted in `securityStats`
 * and reported by the diagnostics text.
 */
export function lockDownSession(logger: Logger): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const allowed = ALLOWED_PERMISSIONS.has(permission) && isAppRequester(details.securityOrigin);
    if (!allowed) logger.warn(`Denied permission request: ${permission}`);
    callback(allowed);
  });
  ses.setPermissionCheckHandler(
    (_wc, permission, requestingOrigin) =>
      ALLOWED_PERMISSIONS.has(permission) && isAppRequester(requestingOrigin),
  );
  ses.setDevicePermissionHandler(() => false);
  ses.setSpellCheckerEnabled(false);
  ses.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] },
    (details, callback) => {
      securityStats.recordBlockedRequest();
      logger.warn(`Blocked network request: ${details.method} ${details.url}`);
      callback({ cancel: true });
    },
  );
  // Nothing in the app ever asks the user to trust a certificate.
  app.on('certificate-error', (event, _wc, url, _error, _certificate, callback) => {
    event.preventDefault();
    logger.warn(`Rejected certificate for ${url}`);
    callback(false);
  });
}
