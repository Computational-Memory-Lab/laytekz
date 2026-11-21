// Sign-in through the system browser (RFC 8252 loopback redirect with PKCE),
// following the Laytekz desktop handoff contract:
//
//   1. PKCE verifier + S256 challenge + state; listen on 127.0.0.1:<random>/callback
//   2. open BASE/api/auth/desktop/start?... in the system browser
//   3. the server signs the person in and sends the browser to
//      http://127.0.0.1:<port>/callback?code=...&state=...  (or ?error=access_denied)
//   4. POST BASE/api/auth/desktop/exchange from the window's own session, so the
//      HttpOnly session cookie lands there; confirm with GET /api/auth/me
//   5. the caller reloads the window
//
// The verifier, the code and cookies are never logged.

import crypto from 'node:crypto';
import http from 'node:http';
import { browserPage, PAGES } from './browser-pages.js';

const b64url = (buf) => buf.toString('base64url');

export function createPkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function sameSecret(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const BROWSER_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  connection: 'close',
};

/**
 * hooks = {
 *   server(): Server, session(): Electron.Session, openExternal(url): Promise<boolean>,
 *   timeoutMs: number,
 *   onWaiting(): void,                       // show "finish signing in in your browser"
 *   onEnd(outcome, detail): void,            // 'success' (detail = user), 'denied', 'timeout',
 *                                            // 'failed' (detail = reason), 'cancelled', 'superseded', 'quit'
 * }
 */
export class DesktopSignIn {
  constructor(hooks) {
    this.hooks = hooks;
    this.flow = null;
    this.startedAt = 0;
  }

  get active() {
    return this.flow !== null;
  }

  async start(provider = null) {
    this.cancel('superseded');
    this.startedAt = Date.now();
    const { verifier, challenge } = createPkce();
    const flow = {
      provider,
      verifier,
      challenge,
      state: b64url(crypto.randomBytes(32)),
      server: this.hooks.server(),
      listener: null,
      port: 0,
      redirectUri: null,
      startUrl: null,
      timer: null,
      busy: false,
      done: false,
    };
    this.flow = flow;
    try {
      await this.listen(flow);
    } catch {
      this.end(flow, 'failed', 'Laytekz could not open a local port to finish signing in.');
      return;
    }
    if (flow.done) {
      // Superseded or cancelled while the port was being bound: end() saw no listener yet.
      flow.listener.close();
      return;
    }
    const query = new URLSearchParams({
      code_challenge: challenge,
      code_challenge_method: 'S256',
      redirect_uri: flow.redirectUri,
      state: flow.state,
    });
    if (provider) query.set('provider', provider);
    flow.startUrl = `${flow.server.url('/api/auth/desktop/start')}?${query}`;
    flow.timer = setTimeout(() => this.end(flow, 'timeout'), this.hooks.timeoutMs);
    this.hooks.onWaiting();
    const opened = await this.hooks.openExternal(flow.startUrl);
    if (!opened) this.end(flow, 'failed', 'Laytekz could not open your web browser.');
  }

  /** "Open the browser again": the same start URL works until the attempt ends. */
  reopen() {
    if (this.flow?.startUrl) this.hooks.openExternal(this.flow.startUrl);
  }

  cancel(outcome = 'cancelled') {
    if (this.flow) this.end(this.flow, outcome);
  }

  listen(flow) {
    return new Promise((resolve, reject) => {
      const listener = http.createServer((req, res) => {
        this.handle(flow, req, res).catch(() => {
          if (!res.headersSent) {
            res.writeHead(500, BROWSER_HEADERS);
            res.end(browserPage(PAGES.failed('Something went wrong in the app.')));
          }
          this.end(flow, 'failed', 'Something went wrong while finishing sign-in.');
        });
      });
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', () => {
        flow.listener = listener;
        flow.port = listener.address().port;
        flow.redirectUri = `http://127.0.0.1:${flow.port}/callback`;
        resolve();
      });
    });
  }

  end(flow, outcome, detail) {
    if (flow.done) return;
    flow.done = true;
    clearTimeout(flow.timer);
    flow.verifier = null;
    const listener = flow.listener;
    if (listener) {
      listener.close();
      listener.closeIdleConnections();
      // Let a response that is still being written reach the browser first.
      setTimeout(() => listener.closeAllConnections(), 2000).unref();
    }
    if (this.flow === flow) this.flow = null;
    this.hooks.onEnd(outcome, detail);
  }

  async handle(flow, req, res) {
    const send = (status, page) => {
      res.writeHead(status, BROWSER_HEADERS);
      res.end(browserPage(page));
    };
    // Only this exact origin: guards against DNS rebinding to the port.
    if (req.headers.host !== `127.0.0.1:${flow.port}`) {
      res.writeHead(421, { 'content-type': 'text/plain', connection: 'close' });
      res.end('Misdirected request');
      return;
    }
    const url = new URL(req.url, `http://127.0.0.1:${flow.port}`);
    if (url.pathname !== '/callback') return send(404, PAGES.notFound);
    if (req.method !== 'GET') return send(405, PAGES.notFound);
    if (flow.done || flow.busy) return send(409, PAGES.finished);
    const query = url.searchParams;
    // A wrong state is answered and ignored; the real callback can still arrive.
    if (!sameSecret(query.get('state'), flow.state)) return send(400, PAGES.wrongState);

    flow.busy = true;
    const error = query.get('error');
    if (error) {
      send(200, PAGES.cancelled);
      if (error === 'access_denied') this.end(flow, 'denied');
      else this.end(flow, 'failed', `The server reported an error (${/^[a-z_]{1,64}$/.test(error) ? error : 'unknown'}).`);
      return;
    }
    const code = query.get('code');
    if (!code) {
      const reason = 'The browser did not bring back a sign-in code.';
      send(400, PAGES.failed(reason));
      this.end(flow, 'failed', reason);
      return;
    }
    clearTimeout(flow.timer);
    const result = await this.exchange(flow, code);
    if (flow.done) return send(409, PAGES.finished);
    if (result.ok) {
      send(200, PAGES.signedIn);
      this.end(flow, 'success', result.user);
    } else {
      send(400, PAGES.failed(result.reason));
      this.end(flow, 'failed', result.reason);
    }
  }

  async exchange(flow, code) {
    const ses = this.hooks.session();
    const { server } = flow;
    let res;
    try {
      res = await ses.fetch(server.url('/api/auth/desktop/exchange'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', origin: server.origin },
        body: JSON.stringify({ code, code_verifier: flow.verifier, redirect_uri: flow.redirectUri }),
        credentials: 'include',
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
      await res.arrayBuffer();
    } catch {
      return { ok: false, reason: 'The server could not be reached to finish signing in.' };
    }
    if (res.status === 429) return { ok: false, reason: 'Too many sign-in attempts. Wait a minute, then try again.' };
    if (res.status !== 200) return { ok: false, reason: 'The server did not accept the sign-in (it may have expired).' };
    try {
      const me = await ses.fetch(server.url('/api/auth/me'), {
        credentials: 'include',
        cache: 'no-store',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      const body = await me.json();
      if (body?.user) return { ok: true, user: body.user };
    } catch {
      // reported below
    }
    return { ok: false, reason: 'The server accepted the sign-in, but the session did not reach the app.' };
  }
}
