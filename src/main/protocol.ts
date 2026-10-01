import { net, protocol, session } from 'electron';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { APP_SCHEME } from '@shared/ipc';
import type { Logger } from './kernel';

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

/** Serve the bundled renderer from `rendererDir` at inc://app/. Refuses anything outside it. */
export function registerAppProtocol(rendererDir: string, logger: Logger): void {
  const root = path.resolve(rendererDir);
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'app') return new Response('Not found', { status: 404 });
    const pathname = decodeURIComponent(url.pathname);
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (file !== root && !file.startsWith(root + path.sep)) {
      logger.warn(`Blocked request outside renderer root: ${request.url}`);
      return new Response('Forbidden', { status: 403 });
    }
    const upstream = await net.fetch(pathToFileURL(file).toString(), {
      bypassCustomProtocolHandlers: true,
    });
    const headers = new Headers(upstream.headers);
    headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(upstream.body, { status: upstream.status, headers });
  });
}

export interface NetworkGuard {
  /** Number of network requests from web content that were blocked. Reported in diagnostics. */
  blockedCount(): number;
}

/**
 * The renderer never needs the network: every remote request is cancelled, permissions
 * are denied, and only the app scheme is allowed. This is what makes ".inc sends nothing
 * anywhere" verifiable rather than a promise.
 */
export function lockDownSession(logger: Logger): NetworkGuard {
  const ses = session.defaultSession;
  let blocked = 0;
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] },
    (details, callback) => {
      blocked++;
      logger.warn(`Blocked network request: ${details.method} ${details.url}`);
      callback({ cancel: true });
    },
  );
  return { blockedCount: () => blocked };
}
