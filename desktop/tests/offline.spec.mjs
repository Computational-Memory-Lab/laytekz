// The offline screen: shown when the server cannot be reached, gone once it is back.

import { test, expect } from '@playwright/test';
import { findPage, launchApp, overlayClick, overlayText, pageReady } from './helpers.mjs';
import { startMockServer } from './mock-server.mjs';

const FAST_RETRY = { LAYTEKZ_TEST_RETRY_MS: '300' };
const offlineText = (ctx) => overlayText(ctx.app, 'offline.html');

test('starting while the server is down shows the offline page, then recovers on its own', async () => {
  const mock = await startMockServer();
  await mock.stop();
  const ctx = await launchApp({ serverUrl: mock.url, env: FAST_RETRY, waitForPage: false });
  try {
    await expect.poll(() => offlineText(ctx)).toContain(`Can't reach 127.0.0.1:${mock.port}`);
    const text = await offlineText(ctx);
    expect(text).toContain('refused the connection');
    expect(text).toContain('Retry Now');
    expect(text).toContain('Change Server');
    expect(await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())).toBe('Laytekz');

    await mock.start();
    await expect.poll(() => offlineText(ctx), { timeout: 15_000 }).toBe(null);
    const page = await findPage(ctx.app, mock.url);
    expect(await pageReady(page)).toBe('Signed out');
    expect(page.url()).toBe(`${mock.url}/`);
  } finally {
    await ctx.close();
    await mock.close();
  }
});

test('a failed top-level load while running shows the offline page; Retry Now recovers', async () => {
  const mock = await startMockServer();
  // A slow automatic retry, so the recovery below comes from the button.
  const ctx = await launchApp({ serverUrl: mock.url, env: { LAYTEKZ_TEST_RETRY_MS: '20000' } });
  try {
    await pageReady(ctx.page);
    await mock.stop();
    await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.reload());
    await expect.poll(() => offlineText(ctx)).toContain("Can't reach");
    await mock.start();
    await overlayClick(ctx.app, 'offline.html', 'offline-retry');
    await expect.poll(() => offlineText(ctx), { timeout: 10_000 }).toBe(null);
    expect(await pageReady(ctx.page)).toBe('Signed out');
  } finally {
    await ctx.close();
    await mock.close();
  }
});

test('a gateway error page (server behind the tunnel is down) counts as offline', async () => {
  const mock = await startMockServer();
  const ctx = await launchApp({ serverUrl: mock.url, env: FAST_RETRY });
  try {
    await pageReady(ctx.page);
    mock.state.outage = true;
    await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.reload());
    await expect.poll(() => offlineText(ctx)).toContain('HTTP 502');
    mock.state.outage = false;
    await expect.poll(() => offlineText(ctx), { timeout: 15_000 }).toBe(null);
    expect(await pageReady(ctx.page)).toBe('Signed out');
  } finally {
    await ctx.close();
    await mock.close();
  }
});

test('an unhealthy server is reported with its own reason', async () => {
  const mock = await startMockServer();
  mock.state.healthOk = false;
  const ctx = await launchApp({ serverUrl: mock.url, env: FAST_RETRY, waitForPage: false });
  try {
    await expect.poll(() => offlineText(ctx)).toContain('The server reported a problem: The datastore cannot be read');
    mock.state.healthOk = true;
    await expect.poll(() => offlineText(ctx), { timeout: 15_000 }).toBe(null);
    expect(await pageReady(await findPage(ctx.app, mock.url))).toBe('Signed out');
  } finally {
    await ctx.close();
    await mock.close();
  }
});
