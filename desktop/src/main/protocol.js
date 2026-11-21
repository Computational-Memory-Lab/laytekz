// laytekz-ui://app/<file> serves the app's own static pages from src/ui.
// It is registered only on the UI session, so the remote page cannot load it.

import { protocol } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const UI_SCHEME = 'laytekz-ui';
export const UI_ORIGIN = `${UI_SCHEME}://app`;
const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export const UI_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Must run before app 'ready'. */
export function registerUiScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: UI_SCHEME, privileges: { standard: true, secure: true } },
  ]);
}

export function uiUrl(page) {
  return `${UI_ORIGIN}/${page}`;
}

export function serveUi(ses) {
  ses.protocol.handle(UI_SCHEME, async (request) => {
    const url = new URL(request.url);
    const name = url.pathname.replace(/^\/+/, '');
    if (url.host !== 'app' || !/^[a-z0-9-]+\.(html|js|css|svg)$/.test(name)) {
      return new Response('Not found', { status: 404 });
    }
    try {
      const body = await fs.readFile(path.join(UI_DIR, name));
      return new Response(body, {
        headers: {
          'content-type': TYPES[path.extname(name)],
          'content-security-policy': UI_CSP,
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}
