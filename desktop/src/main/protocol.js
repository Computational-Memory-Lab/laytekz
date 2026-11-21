// laytekz-ui://app/<file> serves the app's own static pages from src/ui.
// It is registered only on the UI session (and, Galley: V2, on a shell
// feature's own partition), so the remote page cannot load it.

import { protocol } from 'electron';
import { existsSync } from 'node:fs';
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
  // Galley: V2 desktop shell (WP09): images and fonts for the shell features' pages.
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};
const NAME_RE = /^[a-z0-9-]+\.(html|js|css|svg|png|woff2)$/;

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

/** Whether src/ui holds this page (the shell feature host checks declared pages). */
export function uiFileExists(name) {
  return NAME_RE.test(name) && existsSync(path.join(UI_DIR, name));
}

/**
 * Serves src/ui in one session. Galley: V2 desktop shell (WP09):
 * `opts.cspFor(name)` returns a shell feature's own CSP for one of its pages
 * (ShellPage.csp), or null for UI_CSP; it is also how a feature partition's
 * session gets the scheme.
 */
export function serveUi(ses, opts = {}) {
  ses.protocol.handle(UI_SCHEME, async (request) => {
    const url = new URL(request.url);
    const name = url.pathname.replace(/^\/+/, '');
    if (url.host !== 'app' || !NAME_RE.test(name)) {
      return new Response('Not found', { status: 404 });
    }
    try {
      const body = await fs.readFile(path.join(UI_DIR, name));
      return new Response(body, {
        headers: {
          'content-type': TYPES[path.extname(name)],
          'content-security-policy': (name.endsWith('.html') && opts.cspFor?.(name)) || UI_CSP,
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}
