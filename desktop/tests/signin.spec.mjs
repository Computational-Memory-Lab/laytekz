// Sign-in through the system browser: the desktop handoff contract end to end.

import { test as base, expect } from '@playwright/test';
import http from 'node:http';
import os from 'node:os';
import { browse } from './browser-sim.mjs';
import {
  click, launchApp, listening, overlayClick, overlayText, pageReady, sha256url, signInViaHandoff, startSignIn, until,
} from './helpers.mjs';
import { startMockServer } from './mock-server.mjs';

const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  mock: async ({}, use) => {
    const mock = await startMockServer();
    await use(mock);
    await mock.close();
  },
  appEnv: [{}, { option: true }],
  ctx: async ({ mock, appEnv }, use) => {
    const ctx = await launchApp({ serverUrl: mock.url, env: appEnv });
    await pageReady(ctx.page);
    await use(ctx);
    await ctx.close();
  },
});

const toast = (ctx) => overlayText(ctx.app, 'toast.html');

test('clicking sign-in opens a well-formed start URL in the system browser, not in the window', async ({ ctx, mock }) => {
  const { url, params } = await startSignIn(ctx);

  expect(url.origin).toBe(mock.url);
  expect(url.pathname).toBe('/api/auth/desktop/start');
  expect(Object.keys(params).sort()).toEqual(['code_challenge', 'code_challenge_method', 'provider', 'redirect_uri', 'state']);
  expect(params.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(params.code_challenge_method).toBe('S256');
  expect(params.redirect_uri).toMatch(/^http:\/\/127\.0\.0\.1:\d{4,5}\/callback$/);
  expect(params.state).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
  expect(params.provider).toBe('google');

  // The window stayed put and never requested the embedded OAuth route.
  expect(ctx.page.url()).toBe(`${mock.url}/`);
  expect(mock.seen((r) => r.path.startsWith('/api/auth/oauth/'))).toHaveLength(0);
  await expect.poll(() => toast(ctx)).toContain('Finish signing in in your browser');
  await expect.poll(() => toast(ctx)).toContain('Open the Browser Again');
  expect(await listening(params.redirect_uri)).toBe(true);
});

test('completing the callback exchanges the code and signs the window in', async ({ ctx, mock }) => {
  const { start, result } = await signInViaHandoff(ctx);
  expect(result.text).toContain('You are signed in');
  expect(result.text).toContain('Return to Laytekz.');
  expect(result.text).toContain('<title>You are signed in – Laytekz</title>');
  expect(result.url).toBe(`${start.params.redirect_uri}?code=${new URL(result.url).searchParams.get('code')}&state=${start.params.state}`);

  // Exactly one exchange, JSON, with the verifier that hashes to the challenge.
  expect(mock.state.exchanges).toHaveLength(1);
  const exchange = mock.state.exchanges[0];
  expect(exchange.status).toBe(200);
  expect(exchange.contentType).toMatch(/^application\/json/);
  expect(exchange.origin).toBe(mock.url);
  expect(Object.keys(exchange.body).sort()).toEqual(['code', 'code_verifier', 'redirect_uri']);
  expect(exchange.body.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(sha256url(exchange.body.code_verifier)).toBe(start.params.code_challenge);
  expect(exchange.body.redirect_uri).toBe(start.params.redirect_uri);

  // The HttpOnly cookie is in the window's own session, and /api/auth/me sees it.
  const cookies = await ctx.app.evaluate(({ session }) => session.fromPartition('persist:laytekz').cookies.get({ name: 'aldine_session' }));
  expect(cookies).toHaveLength(1);
  expect(cookies[0].httpOnly).toBe(true);
  expect(mock.seen((r) => r.path === '/api/auth/me' && r.sessionCookie).length).toBeGreaterThanOrEqual(2);

  await expect.poll(() => toast(ctx)).toBe(null);
  await expect.poll(() => listening(start.params.redirect_uri)).toBe(false);
});

test('a callback with the wrong state is refused and the attempt keeps waiting', async ({ ctx, mock }) => {
  const { url, params } = await startSignIn(ctx);
  const wrong = await fetch(`${params.redirect_uri}?code=forged&state=${'x'.repeat(43)}`);
  expect(wrong.status).toBe(400);
  expect(await wrong.text()).toContain('out of date');
  const missing = await fetch(`${params.redirect_uri}?code=forged`);
  expect(missing.status).toBe(400);
  const otherPath = await fetch(params.redirect_uri.replace('/callback', '/other'));
  expect(otherPath.status).toBe(404);
  expect(mock.state.exchanges).toHaveLength(0);
  await expect.poll(() => toast(ctx)).toContain('Finish signing in');

  // The genuine callback still works afterwards.
  const result = await browse(url.href);
  expect(result.status).toBe(200);
  await expect.poll(() => ctx.page.textContent('#who')).toBe('Signed in as Test User');
});

test('Cancel in the app closes the listener', async ({ ctx }) => {
  const { params } = await startSignIn(ctx);
  await until(() => toast(ctx), { message: 'the waiting toast' });
  await overlayClick(ctx.app, 'toast.html', 'toast-action-1');
  await expect.poll(() => toast(ctx)).toBe(null);
  await expect.poll(() => listening(params.redirect_uri)).toBe(false);
});

test('"Open the browser again" reopens the same start URL', async ({ ctx }) => {
  const { url } = await startSignIn(ctx);
  await until(() => toast(ctx), { message: 'the waiting toast' });
  await overlayClick(ctx.app, 'toast.html', 'toast-action-0');
  const again = await until(async () => {
    const all = await ctx.recorded();
    return all.length >= 2 ? all : null;
  });
  expect(again[1]).toBe(url.href);
  expect(await toast(ctx)).toContain('Finish signing in');
});

test('error=access_denied from the browser ends the attempt', async ({ ctx, mock }) => {
  const { params } = await startSignIn(ctx);
  const res = await fetch(`${params.redirect_uri}?error=access_denied&state=${params.state}`);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('Sign-in cancelled');
  await expect.poll(() => toast(ctx)).toContain('cancelled in the browser');
  await expect.poll(() => listening(params.redirect_uri)).toBe(false);
  expect(mock.state.exchanges).toHaveLength(0);
});

test.describe('a later attempt', () => {
  test.use({ appEnv: { LAYTEKZ_TEST_SIGNIN_DEBOUNCE_MS: '300' } });

  test('a second attempt cancels the first', async ({ ctx }) => {
    const first = await startSignIn(ctx, 1);
    await ctx.page.waitForTimeout(400);
    const second = await startSignIn(ctx, 2);
    expect(second.params.state).not.toBe(first.params.state);
    expect(second.params.code_challenge).not.toBe(first.params.code_challenge);
    expect(second.params.redirect_uri).not.toBe(first.params.redirect_uri);
    await expect.poll(() => listening(first.params.redirect_uri)).toBe(false);
    const result = await browse(second.url.href);
    expect(result.status).toBe(200);
    await expect.poll(() => ctx.page.textContent('#who')).toBe('Signed in as Test User');
  });
});

test('a second click on sign-in while the first attempt is young does nothing', async ({ ctx }) => {
  const first = await startSignIn(ctx, 1);
  await click(ctx.page, '#signin');
  await ctx.page.waitForTimeout(500);
  expect((await ctx.recorded()).filter((u) => u.includes('/api/auth/desktop/start'))).toHaveLength(1);
  expect(await listening(first.params.redirect_uri)).toBe(true);
  await expect.poll(() => toast(ctx)).toContain('Open the Browser Again');
});

test('a failed exchange is reported in the browser and in the app', async ({ ctx, mock }) => {
  mock.state.failExchange = true;
  const { url, params } = await startSignIn(ctx);
  const result = await browse(url.href);
  expect(result.status).toBe(400);
  expect(result.text).toContain('could not finish signing in');
  expect(mock.state.exchanges[0].status).toBe(400);
  await expect.poll(() => toast(ctx)).toContain('did not accept the sign-in');
  await expect.poll(() => toast(ctx)).toContain('Try Again');
  await expect.poll(() => listening(params.redirect_uri)).toBe(false);
  const cookies = await ctx.app.evaluate(({ session }) => session.fromPartition('persist:laytekz').cookies.get({ name: 'aldine_session' }));
  expect(cookies).toHaveLength(0);
  expect(await ctx.page.textContent('#who')).toBe('Signed out');
});

test('a replayed callback after success is refused', async ({ ctx, mock }) => {
  const { result } = await signInViaHandoff(ctx);
  // The listener is closed now; even a fast replay sends no second exchange.
  await fetch(result.url).catch(() => null);
  await ctx.page.waitForTimeout(300);
  expect(mock.state.exchanges).toHaveLength(1);
});

test('the listener answers only its own origin, binds to 127.0.0.1, and takes only GET', async ({ ctx, mock }) => {
  const { url, params } = await startSignIn(ctx);
  const port = Number(new URL(params.redirect_uri).port);
  const raw = (host, method = 'GET') => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: `/callback?code=x&state=${params.state}`, headers: { host } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', (err) => resolve(err.code));
    req.end();
  });
  expect(await raw(`localhost:${port}`)).toBe(421);
  expect(await raw(`evil.example:${port}`)).toBe(421);
  expect(await raw(`127.0.0.1:${port}`, 'POST')).toBe(405);
  const address = Object.values(os.networkInterfaces()).flat().find((i) => i.family === 'IPv4' && !i.internal)?.address ?? null;
  if (address) {
    const other = await new Promise((resolve) => {
      const req = http.request({ host: address, port, path: '/callback' }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', (err) => resolve(err.code));
      req.end();
    });
    expect(other).toBe('ECONNREFUSED');
  }
  expect(mock.state.exchanges).toHaveLength(0);
  const result = await browse(url.href);
  expect(result.status).toBe(200);
});

test('two callbacks at once give one exchange', async ({ ctx, mock }) => {
  const { url } = await startSignIn(ctx);
  // Play the browser as far as the loopback redirect, then call it twice at once.
  let current = url.href;
  let jar = '';
  for (let hop = 0; hop < 5 && !current.includes('/callback'); hop += 1) {
    const res = await fetch(current, { redirect: 'manual', headers: { cookie: jar } });
    jar = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') || jar;
    current = new URL(res.headers.get('location'), current).href;
  }
  const [a, b] = await Promise.all([fetch(current), fetch(current)]);
  expect([a.status, b.status].sort()).toEqual([200, 409]);
  await expect.poll(() => ctx.page.textContent('#who')).toBe('Signed in as Test User');
  expect(mock.state.exchanges).toHaveLength(1);
});

test('an exchange answered with a redirect is not followed', async ({ ctx, mock }) => {
  mock.state.redirectExchange = true;
  const { url } = await startSignIn(ctx);
  const result = await browse(url.href);
  expect(result.status).toBe(400);
  expect(mock.state.exchanges).toHaveLength(1);
  expect(mock.state.exchanges[0].status).toBe(302);
  await expect.poll(() => toast(ctx)).toContain('could not be reached');
  expect(await ctx.page.textContent('#who')).toBe('Signed out');
});

test.describe('timeouts', () => {
  test.use({ appEnv: { LAYTEKZ_TEST_SIGNIN_TIMEOUT_MS: '1500' } });

  test('an attempt that never comes back times out (account awaiting approval)', async ({ ctx, mock }) => {
    mock.state.approvalPending = true;
    const { url, params } = await startSignIn(ctx);
    const page = await browse(url.href);
    expect(page.status).toBe(403);
    expect(page.text).toContain('Waiting for approval');
    await expect.poll(() => toast(ctx), { timeout: 8000 }).toContain('timed out');
    await expect.poll(() => listening(params.redirect_uri)).toBe(false);
    expect(mock.state.exchanges).toHaveLength(0);
  });
});

test('quitting mid-flow closes the listener', async ({ mock }) => {
  const ctx = await launchApp({ serverUrl: mock.url });
  try {
    await pageReady(ctx.page);
    const { params } = await startSignIn(ctx);
    expect(await listening(params.redirect_uri)).toBe(true);
    await ctx.app.close();
    await expect.poll(() => listening(params.redirect_uri)).toBe(false);
  } finally {
    await ctx.close();
  }
});

test('the sign-in link opened with window.open also starts the handoff', async ({ ctx, mock }) => {
  await ctx.page.evaluate(() => window.open('/api/auth/oauth/google', '_blank'));
  const urls = await until(async () => {
    const all = (await ctx.recorded()).filter((u) => u.includes('/api/auth/desktop/start'));
    return all.length ? all : null;
  });
  expect(new URL(urls[0]).searchParams.get('provider')).toBe('google');
  const windows = await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  expect(windows).toBe(1);
  expect(mock.seen((r) => r.path.startsWith('/api/auth/oauth/'))).toHaveLength(0);
});
