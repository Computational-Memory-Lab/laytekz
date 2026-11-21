// What a hostile page, or whoever starts the app, can make the shell do:
// command-line switches, windows and their native options, hand-offs to the
// system browser and to sign-in, the auth window's reach, downloads,
// permissions, client certificates, and a quit cancelled during sign-in.

import { test as base, expect } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { browse } from './browser-sim.mjs';
import {
  APP_DIR, click, cleanEnv, findPage, launchApp, listening, overlayText, pageReady, startSignIn, tempDir, until,
} from './helpers.mjs';
import { startMockServer } from './mock-server.mjs';

const electronBinary = createRequire(import.meta.url)('electron');

const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  mock: async ({}, use) => {
    const mock = await startMockServer();
    await use(mock);
    await mock.close();
  },
  ctx: async ({ mock }, use) => {
    const ctx = await launchApp({ serverUrl: mock.url });
    await pageReady(ctx.page);
    await use(ctx);
    await ctx.close();
  },
});

const goTo = (ctx, url) => ctx.page.evaluate((u) => { window.location.href = u; }, url);
const windowCount = (ctx) => ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
const toast = (ctx) => overlayText(ctx.app, 'toast.html');
const decoded = (p) => { try { return decodeURIComponent(p); } catch { return p; } };

/** Starts the app from source, outside Playwright, and reports how it ended. */
async function spawnApp(args, env, { stopWhen = null, timeout = 8000 } = {}) {
  const dir = await tempDir();
  const child = spawn(electronBinary, [APP_DIR, ...args], {
    env: cleanEnv({ LAYTEKZ_TEST_MODE: '1', LAYTEKZ_TEST_USER_DATA: dir, LAYTEKZ_TEST_SERVER_URL: 'http://127.0.0.1:9', ...env }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill(); resolve('still running'); }, timeout);
    const onData = (d) => {
      output += d;
      if (stopWhen && stopWhen.test(output)) { clearTimeout(timer); child.kill(); resolve('stopped'); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  await new Promise((r) => (child.exitCode !== null || child.signalCode ? r() : child.once('exit', r)));
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  return { result, output };
}

test('a packaged-style launch refuses command-line switches before the DevTools server starts', async () => {
  // Without the guard (a run from source) the switch opens the DevTools server:
  const open = await spawnApp(['--remote-debugging-port=0'], {}, { stopWhen: /DevTools listening on/ });
  expect(open.output).toMatch(/DevTools listening on ws:\/\/127\.0\.0\.1:\d+/);
  // With it (what app.isPackaged turns on), the app exits first:
  const refused = await spawnApp(['--remote-debugging-port=0'], { LAYTEKZ_TEST_SWITCH_GUARD: '1' });
  expect(refused.result).toBe(1);
  expect(refused.output).toContain('Laytekz does not accept command-line switches (--remote-debugging-port)');
  expect(refused.output).not.toContain('DevTools listening');
  for (const args of [['--proxy-server=127.0.0.1:1', '--ignore-certificate-errors'], ['--user-data-dir=/tmp/x'], ['-psn_0_1', '--inspect']]) {
    expect((await spawnApp(args, { LAYTEKZ_TEST_SWITCH_GUARD: '1' })).result).toBe(1);
  }
  // The OS's own argument and plain arguments still start the app.
  expect((await spawnApp(['-psn_0_12345'], { LAYTEKZ_TEST_SWITCH_GUARD: '1' }, { timeout: 4000 })).result).toBe('still running');
});

test('window.open features never reach the native window', async ({ ctx, mock }) => {
  await goTo(ctx, `${mock.url}/hostile/features`);
  const info = await until(() => ctx.app.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('/popup?f=1'));
    if (!w) return null;
    const p = w.webContents.getLastWebPreferences();
    const area = screen.getDisplayMatching(w.getBounds()).workArea;
    const b = w.getBounds();
    return {
      alwaysOnTop: w.isAlwaysOnTop(), closable: w.isClosable(), movable: w.isMovable(), resizable: w.isResizable(),
      minimizable: w.isMinimizable(), maximizable: w.isMaximizable(), opacity: w.getOpacity(), focusable: w.isFocusable(),
      hasShadow: w.hasShadow(), kiosk: w.isKiosk(), fullscreen: w.isFullScreen(), skipTaskbarSafe: true,
      onScreen: b.x + b.width > area.x && b.x < area.x + area.width && b.y + b.height > area.y && b.y < area.y + area.height,
      size: [b.width, b.height], sandbox: p.sandbox, contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration,
    };
  }), { message: 'the popup' });
  expect(info).toEqual({
    alwaysOnTop: false, closable: true, movable: true, resizable: true, minimizable: true, maximizable: true, opacity: 1,
    focusable: true, hasShadow: true, kiosk: false, fullscreen: false, skipTaskbarSafe: true, onScreen: true,
    size: [1100, 800], sandbox: true, contextIsolation: true, nodeIntegration: false,
  });
  // And it closes when asked.
  await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('/popup?f=1')).close());
  await expect.poll(() => windowCount(ctx)).toBe(1);
});

test('a project window outlives the main window and keeps its unsynced-edits prompt', async ({ ctx, mock }) => {
  const popupPromise = ctx.app.waitForEvent('window');
  await click(ctx.page, '#popup');
  const popup = await popupPromise;
  await popup.waitForURL(`${mock.url}/popup`);
  await popup.evaluate(() => window.addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = ''; }));
  await popup.mouse.click(5, 5);
  await ctx.app.evaluate(({ dialog }) => {
    globalThis.unloadAsked = 0;
    dialog.showMessageBoxSync = () => { globalThis.unloadAsked += 1; return 1; }; // Stay
  });
  await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('/popup')).close());
  await expect.poll(() => windowCount(ctx)).toBe(1);
  expect(await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getURL())).toBe(`${mock.url}/popup`);
  // Closing the project window itself asks.
  await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await expect.poll(() => ctx.app.evaluate(() => globalThis.unloadAsked)).toBe(1);
  await popup.waitForTimeout(300);
  expect(await windowCount(ctx)).toBe(1);
  await ctx.app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 0; }); // Leave, so the app can quit
});

test('a page cannot open app windows without limit', async ({ ctx, mock }) => {
  await goTo(ctx, `${mock.url}/hostile/popups`);
  await expect.poll(() => windowCount(ctx), { timeout: 10_000 }).toBe(10);
  await ctx.page.waitForTimeout(500);
  expect(await windowCount(ctx)).toBe(10);
});

test('a page cannot flood the system browser; past a few, each one is asked about', async ({ ctx, mock }) => {
  await ctx.app.evaluate(({ dialog }) => {
    globalThis.asked = [];
    dialog.showMessageBox = async (...args) => { globalThis.asked.push(args.at(-1).message); return { response: 1 }; };
  });
  await goTo(ctx, `${mock.url}/hostile/external`);
  await expect.poll(() => ctx.app.evaluate(() => globalThis.asked.length), { timeout: 8000 }).toBeGreaterThan(0);
  await ctx.page.waitForTimeout(800);
  const opened = (await ctx.recorded()).filter((u) => u.startsWith('https://phish.example/'));
  expect(opened).toHaveLength(4);
  expect((await ctx.app.evaluate(() => globalThis.asked))[0]).toMatch(/^The page wants to open phish\.example in your browser\.$/);
});

test('a page cannot start one sign-in after another', async ({ ctx, mock }) => {
  await goTo(ctx, `${mock.url}/hostile/signin`);
  await until(async () => (await ctx.recorded()).some((u) => u.includes('/api/auth/desktop/start')), { message: 'a start URL' });
  await ctx.page.waitForTimeout(1200);
  expect((await ctx.recorded()).filter((u) => u.includes('/api/auth/desktop/start'))).toHaveLength(1);
});

test('a percent-encoded sign-in link starts the handoff too, never the embedded route', async ({ ctx, mock }) => {
  await goTo(ctx, `${mock.url}/api/auth/oauth/goo%67le`);
  const first = await until(async () => (await ctx.recorded()).find((u) => u.includes('/api/auth/desktop/start')), { message: 'a start URL' });
  expect(new URL(first).searchParams.get('provider')).toBe('google');
  expect(mock.seen((r) => decoded(r.path).startsWith('/api/auth/oauth/'))).toHaveLength(0);
  expect(await windowCount(ctx)).toBe(1);
});

test('a sign-in chain that leaves the server never opens an embedded window', async ({ ctx, mock }) => {
  await goTo(ctx, `${mock.url}/api/auth/elsewhere`);
  await until(() => mock.seen((r) => r.path === '/api/auth/elsewhere').length > 0, { message: 'the chain to start' });
  await ctx.page.waitForTimeout(800);
  expect(await windowCount(ctx)).toBe(1);
  expect(mock.seen((r) => r.host.startsWith('localhost:'))).toHaveLength(0);
  expect(await ctx.recorded()).toEqual([]);
});

test('the auth window keeps to the sites the round trip reached; other links go to the browser', async ({ ctx, mock }) => {
  await goTo(ctx, `${mock.url}/api/integrations/page/oauth`);
  const provider = await findPage(ctx.app, `http://localhost:${mock.port}/provider-page`);
  // The third-party page shares the session, but none of the server's permissions.
  expect(await provider.evaluate(() => navigator.permissions.query({ name: 'clipboard-write' }).then((s) => s.state))).not.toBe('granted');
  await click(provider, '#same');
  await provider.waitForURL(`http://localhost:${mock.port}/provider-page?step=2`);
  await click(provider, '#away');
  await expect.poll(() => ctx.recorded()).toContain('https://example.org/elsewhere');
  await click(provider, '#insecure');
  await expect.poll(() => ctx.recorded()).toContain('http://example.org/insecure');
  await provider.waitForTimeout(300);
  expect(provider.url()).toBe(`http://localhost:${mock.port}/provider-page?step=2`);
  expect(await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()))).toContain(`Laytekz – localhost:${mock.port}`);
});

test('downloads: program files and data: addresses are refused, without a save dialog', async ({ ctx, mock }) => {
  await ctx.app.evaluate(({ dialog }) => {
    globalThis.saveDialogs = 0;
    dialog.showSaveDialogSync = () => { globalThis.saveDialogs += 1; return undefined; };
  });
  await ctx.app.evaluate(({ BrowserWindow }, u) => BrowserWindow.getAllWindows()[0].webContents.downloadURL(u), `${mock.url}/files/run.command`);
  await expect.poll(() => toast(ctx)).toContain('Blocked run.command: Laytekz does not download programs.');
  await goTo(ctx, `${mock.url}/hostile/data-download`);
  await expect.poll(() => toast(ctx)).toContain('Blocked a download from a data: address.');
  expect(await ctx.app.evaluate(() => globalThis.saveDialogs)).toBe(0);
});

test('downloads: a page cannot keep a person in save dialogs', async ({ ctx, mock }) => {
  await ctx.app.evaluate(({ dialog }) => {
    globalThis.saveDialogs = 0;
    dialog.showSaveDialogSync = () => { globalThis.saveDialogs += 1; return undefined; };
  });
  await goTo(ctx, `${mock.url}/hostile/downloads`);
  await expect.poll(() => toast(ctx), { timeout: 8000 }).toContain('Blocked another download: the page asked for several at once.');
  await ctx.page.waitForTimeout(800);
  const shown = await ctx.app.evaluate(() => globalThis.saveDialogs);
  expect(shown).toBeGreaterThanOrEqual(1);
  expect(shown).toBeLessThanOrEqual(3);
});

test('downloads: a saved file is marked as downloaded for the OS to check', async ({ ctx }) => {
  test.skip(process.platform !== 'darwin', 'the quarantine attribute is macOS; Windows gets a Zone.Identifier stream');
  const target = path.join(ctx.dir, 'quarantined.pdf');
  await ctx.app.evaluate(({ dialog }, file) => { dialog.showSaveDialogSync = () => file; }, target);
  await click(ctx.page, '#download');
  await expect.poll(() => overlayText(ctx.app, 'toast.html')).toContain('Saved quarantined.pdf');
  const value = execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', target], { encoding: 'utf8' }).trim();
  expect(value).toMatch(/^0083;[0-9a-f]+;Laytekz;[0-9A-F-]{36}$/);
});

test('permissions: a cross-origin frame in the page gets none', async ({ ctx, mock }) => {
  await ctx.page.evaluate((src) => new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.src = src;
    frame.onload = resolve;
    document.body.append(frame);
  }), `http://localhost:${mock.port}/provider-page`);
  const frame = ctx.page.frames().find((f) => f.url().startsWith(`http://localhost:${mock.port}/`));
  const query = (name) => navigator.permissions.query({ name }).then((s) => s.state, (e) => `error: ${e.name}`);
  expect(await ctx.page.evaluate(query, 'clipboard-write')).toBe('granted');
  expect(await frame.evaluate(query, 'clipboard-write')).not.toBe('granted');
  expect(await frame.evaluate(() => Notification.requestPermission())).toBe('denied');
});

test('a TLS client-certificate request is declined, not answered with the first certificate', async ({ ctx }) => {
  const r = await ctx.app.evaluate(({ app }) => {
    const out = { prevented: false, called: false, chosen: 'unset', listeners: app.listenerCount('select-client-certificate') };
    const event = { preventDefault: () => { out.prevented = true; } };
    app.emit('select-client-certificate', event, null, 'https://mtls.example/', [{ subjectName: 'Somebody', issuerName: 'CA' }], (cert) => {
      out.called = true;
      out.chosen = cert === undefined ? 'none' : 'a certificate';
    });
    return out;
  });
  expect(r).toEqual({ prevented: true, called: true, chosen: 'none', listeners: 1 });
});

test('a quit cancelled with "Stay" leaves the sign-in in progress alone', async ({ ctx, mock }) => {
  const { url, params } = await startSignIn(ctx);
  await ctx.page.evaluate(() => window.addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = ''; }));
  await ctx.page.mouse.click(5, 5);
  await ctx.app.evaluate(({ app, dialog }) => {
    dialog.showMessageBoxSync = () => 1; // Stay
    app.quit();
  });
  await ctx.page.waitForTimeout(800);
  expect(await windowCount(ctx)).toBe(1);
  expect(await listening(params.redirect_uri)).toBe(true);
  expect(await toast(ctx)).toContain('Finish signing in');
  // The reload after signing in asks about the unsynced edits too; this time, Leave.
  await ctx.app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 0; });
  const result = await browse(url.href);
  expect(result.status).toBe(200);
  await expect.poll(() => ctx.page.textContent('#who')).toBe('Signed in as Test User');
  expect(mock.state.exchanges).toHaveLength(1);
});
