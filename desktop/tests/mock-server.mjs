// A stand-in Laytekz server for the desktop tests (plain node:http).
//
// It implements the desktop handoff contract (start → continue → loopback
// redirect, exchange with PKCE), /api/health, /api/auth/me from the session
// cookie, and a page with the links the shell has to handle. Requests to
// http://localhost:<port> act as a third-party OAuth provider for the
// integration round trip; http://127.0.0.1:<port> is the Laytekz origin.
// The /hostile/* pages act without any user gesture, as stored XSS or a
// malicious server could; the shell must contain what they try.

import crypto from 'node:crypto';
import http from 'node:http';

export const TEST_USER = { id: 'u1', name: 'Test User', email: 'test.user@example.test' };

const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const STATE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const b64url = (buf) => buf.toString('base64url');

function validLoopbackRedirect(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const port = Number(url.port);
  return raw.length <= 200 && url.protocol === 'http:' && url.hostname === '127.0.0.1'
    && Number.isInteger(port) && port >= 1024 && port <= 65535 && url.pathname === '/callback'
    && !url.search && !url.hash && !url.username && !url.password;
}

function cookiesOf(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

const scriptPage = (title, script, body = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>
<body><h1 id="who">${title}</h1>${body}<script>${script}</script></body></html>`;

const HOSTILE = {
  '/hostile/external': scriptPage('Hostile external', `
    for (let i = 0; i < 6; i++) setTimeout(() => { location.href = 'https://phish.example/n' + i; }, 40 * i);
    for (let i = 0; i < 4; i++) window.open('https://phish.example/w' + i, '_blank');`),
  '/hostile/signin': scriptPage('Hostile sign-in', `
    let n = 0; const t = setInterval(() => { location.href = '/api/auth/oauth/google'; if (++n >= 5) clearInterval(t); }, 150);`),
  '/hostile/popups': scriptPage('Hostile popups', `for (let i = 0; i < 14; i++) window.open('/popup?i=' + i, '_blank');`),
  '/hostile/features': scriptPage('Hostile features', `window.open('/popup?f=1', 'x', 'frame=no,transparent=yes,alwaysOnTop=yes,closable=no,minimizable=no,maximizable=no,movable=no,resizable=no,skipTaskbar=yes,opacity=0.2,x=-3000,y=-3000,width=200,height=200,focusable=no,hasShadow=no,kiosk=yes,fullscreen=yes');`),
  '/hostile/downloads': scriptPage('Hostile downloads', `
    for (let i = 0; i < 5; i++) setTimeout(() => { const a = document.createElement('a'); a.href = '/files/paper.pdf?i=' + i; a.download = 'f' + i + '.pdf'; document.body.append(a); a.click(); }, 100 * i);`),
  '/hostile/data-download': scriptPage('Hostile data download', `
    const a = document.createElement('a'); a.href = 'data:text/plain,planted'; a.download = 'planted.txt'; document.body.append(a); a.click();`),
};

function appPage(options) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Projects – Mock</title>
<style>body{background:#1c1c1e;color:#f5f5f7;font:14px sans-serif} a{display:block;color:#5b8cff;margin:4px 0}</style></head>
<body>
<h1 id="who">Loading…</h1>
<a id="signin" href="/api/auth/oauth/google">Continue with Google</a>
<a id="external" href="https://example.com/docs">Documentation</a>
<a id="external-blank" href="https://example.com/blank" target="_blank" rel="noopener">Documentation in a new tab</a>
<a id="popup" href="/popup" target="_blank">Same-origin popup</a>
<a id="download" href="/files/paper.pdf" download="paper.pdf">Download the PDF</a>
<a id="file" href="file:///etc/hosts">A file link</a>
<a id="integration" href="/api/integrations/demo/oauth">Connect the demo integration</a>
<a id="redirect-out" href="/redirect-out">A page that redirects elsewhere</a>
<script>
fetch('/api/auth/me').then((r) => r.json()).then((me) => {
  document.getElementById('who').textContent = me.user ? 'Signed in as ' + me.user.name : 'Signed out';
  document.body.dataset.ready = '1';
  ${options.autoSignIn ? "if (!me.user) setTimeout(() => document.getElementById('signin').click(), 300);" : ''}
});
</script>
</body></html>`;
}

export async function startMockServer(options = {}) {
  const state = {
    requests: [],
    starts: [],
    exchanges: [],
    integrations: [],
    handoffs: new Map(),
    codes: new Map(),
    sessions: new Map(),
    healthOk: true,
    outage: false,
    approvalPending: false,
    failExchange: false,
    redirectExchange: false,
    autoSignIn: !!options.autoSignIn,
  };
  let port = options.port ?? 0;
  let server = null;
  const sockets = new Set();
  const origin = () => `http://127.0.0.1:${port}`;

  const send = (res, status, body, headers = {}) => {
    const isText = typeof body === 'string';
    res.writeHead(status, {
      'content-type': isText ? 'text/html; charset=utf-8' : 'application/json',
      'cache-control': 'no-store',
      ...headers,
    });
    res.end(isText ? body : JSON.stringify(body));
  };
  const redirect = (res, location, headers = {}) => {
    res.writeHead(302, { location, 'cache-control': 'no-store', ...headers });
    res.end();
  };

  async function provider(req, res, url) {
    // The third-party OAuth provider, on a different origin (localhost vs 127.0.0.1).
    if (url.pathname === '/provider-page') {
      return send(res, 200, `<!doctype html><title>Provider</title><body><h1>Provider</h1>
<a id="away" href="https://example.org/elsewhere">A link to another site</a>
<a id="same" href="/provider-page?step=2">Next step on the provider's site</a>
<a id="insecure" href="/redirect-insecure">A redirect to plain http</a></body>`);
    }
    if (url.pathname === '/redirect-insecure') return redirect(res, 'http://example.org/insecure');
    if (url.pathname === '/authorize') {
      const back = new URL(url.searchParams.get('redirect_uri'));
      back.searchParams.set('code', 'provider-code');
      back.searchParams.set('state', url.searchParams.get('state'));
      return redirect(res, back.href);
    }
    return send(res, 404, '<p>provider: not found</p>');
  }

  async function handle(req, res) {
    const url = new URL(req.url, origin());
    const cookies = cookiesOf(req);
    state.requests.push({
      method: req.method,
      host: req.headers.host,
      path: url.pathname,
      search: url.search,
      sessionCookie: !!cookies.aldine_session,
      origin: req.headers.origin ?? null,
      userAgent: req.headers['user-agent'] ?? '',
    });
    if ((req.headers.host ?? '').startsWith('localhost:')) return provider(req, res, url);

    const user = state.sessions.get(cookies.aldine_session) ?? null;
    const route = `${req.method} ${url.pathname}`;

    if (state.outage) return send(res, 502, '<h1>502 Bad Gateway</h1>');

    switch (route) {
      case 'GET /api/health':
        return state.healthOk
          ? send(res, 200, { ok: true, name: 'aldine' })
          : send(res, 503, { ok: false, name: 'aldine', error: 'The datastore cannot be read' });

      case 'GET /api/auth/me':
        return send(res, 200, { authEnabled: true, passwordAuth: false, user, providers: [{ id: 'google', label: 'Google' }] });

      case 'GET /api/auth/oauth/google':
        // The app must never load this in a window: Google refuses embedded sign-in.
        return send(res, 500, '<h1>Embedded sign-in attempted</h1>');

      case 'GET /api/auth/desktop/start': {
        const q = url.searchParams;
        const params = {
          code_challenge: q.get('code_challenge'),
          code_challenge_method: q.get('code_challenge_method'),
          redirect_uri: q.get('redirect_uri'),
          state: q.get('state'),
          provider: q.get('provider'),
        };
        const valid = CHALLENGE_RE.test(params.code_challenge ?? '') && params.code_challenge_method === 'S256'
          && validLoopbackRedirect(params.redirect_uri ?? '') && STATE_RE.test(params.state ?? '')
          && (params.provider === null || params.provider === 'google');
        state.starts.push({ ...params, valid });
        if (!valid) return send(res, 400, '<h1>Invalid desktop sign-in request</h1>');
        const id = b64url(crypto.randomBytes(16));
        state.handoffs.set(id, params);
        // The real server signs the handoff into the cookie and, behind https with
        // no base path, names it __Host-aldine_desktop_handoff; over plain http,
        // as here, the name is the same as this one. The app never sees it.
        const cookie = `aldine_desktop_handoff=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`;
        if (state.approvalPending) return send(res, 403, '<h1>Waiting for approval</h1>', { 'set-cookie': cookie });
        return redirect(res, '/api/auth/desktop/continue', { 'set-cookie': cookie });
      }

      case 'GET /api/auth/desktop/continue': {
        const handoff = state.handoffs.get(cookies.aldine_desktop_handoff);
        if (!handoff) return send(res, 400, '<h1>No desktop sign-in in progress</h1>');
        state.handoffs.delete(cookies.aldine_desktop_handoff);
        const code = b64url(crypto.randomBytes(32));
        state.codes.set(code, {
          challenge: handoff.code_challenge,
          redirectUri: handoff.redirect_uri,
          exp: Date.now() + 60_000,
          used: false,
        });
        const back = new URL(handoff.redirect_uri);
        back.searchParams.set('code', code);
        back.searchParams.set('state', handoff.state);
        return redirect(res, back.href, { 'set-cookie': 'aldine_desktop_handoff=; Path=/; Max-Age=0' });
      }

      case 'POST /api/auth/desktop/exchange': {
        const contentType = req.headers['content-type'] ?? '';
        const raw = await readBody(req);
        const entry = { contentType, origin: req.headers.origin ?? null, hadSessionCookie: !!cookies.aldine_session, status: 0, body: null };
        state.exchanges.push(entry);
        if (state.redirectExchange) {
          // Answers like a misconfigured proxy would; the app must not follow it.
          entry.status = 302;
          return redirect(res, '/api/auth/me');
        }
        if (!contentType.startsWith('application/json')) {
          entry.status = 415;
          return send(res, 415, { error: 'unsupported_media_type' });
        }
        let body = null;
        try {
          body = JSON.parse(raw);
        } catch {
          // invalid below
        }
        entry.body = body;
        const record = body && state.codes.get(body.code);
        const verifierOk = record && typeof body.code_verifier === 'string'
          && b64url(crypto.createHash('sha256').update(body.code_verifier).digest()) === record.challenge;
        const ok = !state.failExchange && record && !record.used && record.exp > Date.now()
          && body.redirect_uri === record.redirectUri && verifierOk;
        if (record) record.used = true;
        if (!ok) {
          entry.status = 400;
          return send(res, 400, { error: 'invalid_grant' });
        }
        const sid = b64url(crypto.randomBytes(24));
        state.sessions.set(sid, TEST_USER);
        entry.status = 200;
        return send(res, 200, { user: TEST_USER }, {
          'set-cookie': `aldine_session=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`,
        });
      }

      case 'POST /api/auth/logout':
        state.sessions.delete(cookies.aldine_session);
        return send(res, 200, { ok: true }, { 'set-cookie': 'aldine_session=; Path=/; Max-Age=0' });

      case 'GET /api/integrations/demo/oauth': {
        const st = b64url(crypto.randomBytes(12));
        const callback = `${origin()}/api/integrations/demo/callback`;
        return redirect(res, `http://localhost:${port}/authorize?state=${st}&redirect_uri=${encodeURIComponent(callback)}`, {
          'set-cookie': `demo_state=${st}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`,
        });
      }

      case 'GET /api/integrations/demo/callback': {
        const stateOk = !!cookies.demo_state && cookies.demo_state === url.searchParams.get('state');
        state.integrations.push({ stateOk, user: user?.name ?? null, code: url.searchParams.get('code') });
        return redirect(res, '/?connected=demo', { 'set-cookie': 'demo_state=; Path=/; Max-Age=0' });
      }

      case 'GET /redirect-out':
        return redirect(res, 'https://example.net/landing');

      case 'GET /api/integrations/page/oauth':
        // An integration whose provider shows a page (with links) before coming back.
        return redirect(res, `http://localhost:${port}/provider-page`);

      case 'GET /api/auth/elsewhere':
        // A chain under /api/auth/ that leaves the origin: never an embedded window.
        return redirect(res, `http://localhost:${port}/provider-page`);

      case 'GET /source':
        return redirect(res, '/source.tar.gz');

      case 'GET /privacy':
        return send(res, 200, '<!doctype html><title>Privacy · Laytekz</title><h1>Privacy</h1>');

      case 'GET /files/run.command':
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="run.command"' });
        return res.end('#!/bin/sh\necho hi\n');

      case 'GET /popup':
        return send(res, 200, '<!doctype html><title>Popup – Mock</title><body style="background:#1c1c1e;color:#eee"><h1>Popup</h1></body>');

      case 'GET /files/paper.pdf':
        res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="paper.pdf"' });
        return res.end('%PDF-1.4\n% mock\n');

      case 'GET /source.tar.gz':
        res.writeHead(200, { 'content-type': 'application/gzip' });
        return res.end('mock');

      default:
        if (req.method === 'GET' && HOSTILE[url.pathname]) return send(res, 200, HOSTILE[url.pathname]);
        if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return send(res, 200, appPage(state));
        return send(res, 404, { error: 'not found' });
    }
  }

  function listen() {
    return new Promise((resolve, reject) => {
      server = http.createServer((req, res) => {
        handle(req, res).catch((err) => {
          if (!res.headersSent) send(res, 500, { error: String(err) });
        });
      });
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
      });
    });
  }

  async function stop() {
    if (!server) return;
    const s = server;
    server = null;
    await new Promise((resolve) => {
      s.close(() => resolve());
      for (const socket of sockets) socket.destroy();
    });
  }

  await listen();
  return {
    state,
    get port() { return port; },
    get url() { return origin(); },
    start: listen,
    stop,
    close: stop,
    /** Requests matching a predicate, newest last. */
    seen: (predicate) => state.requests.filter(predicate),
  };
}
