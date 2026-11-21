// Navigation policy, popups, downloads, permissions and the integration OAuth round trip.

import { test as base, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  click, launchApp, overlayText, pageReady, signInViaHandoff, until,
} from './helpers.mjs';
import { startMockServer } from './mock-server.mjs';

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

const windowCount = (ctx) => ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

test('the remote page runs hardened, in a hidden test window, with the window titled "Laytekz – page"', async ({ ctx, mock }) => {
  const info = await ctx.app.evaluate(({ BrowserWindow, session }) => {
    const [win] = BrowserWindow.getAllWindows();
    const prefs = win.webContents.getLastWebPreferences();
    return {
      title: win.getTitle(),
      visible: win.isVisible(),
      min: win.getMinimumSize(),
      background: win.getBackgroundColor(),
      sameSession: win.webContents.session === session.fromPartition('persist:laytekz'),
      prefs: {
        contextIsolation: prefs.contextIsolation,
        sandbox: prefs.sandbox,
        nodeIntegration: prefs.nodeIntegration,
        nodeIntegrationInSubFrames: prefs.nodeIntegrationInSubFrames,
        webSecurity: prefs.webSecurity,
        webviewTag: prefs.webviewTag,
        preload: prefs.preload ?? null,
      },
    };
  });
  expect(info.title).toBe('Laytekz – Projects');
  expect(info.visible).toBe(false);
  expect(info.min).toEqual([800, 540]);
  expect(info.background.toLowerCase()).toBe('#1c1c1e');
  expect(info.sameSession).toBe(true);
  expect(info.prefs).toEqual({
    contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInSubFrames: false,
    webSecurity: true, webviewTag: false, preload: null,
  });
  expect(await ctx.page.evaluate(() => [typeof require, typeof process, typeof window.laytekz])).toEqual(['undefined', 'undefined', 'undefined']);
  expect(ctx.page.url()).toBe(`${mock.url}/`);
});

test('external links go to the system browser, not the window', async ({ ctx, mock }) => {
  await click(ctx.page, '#external');
  await click(ctx.page, '#external-blank');
  await ctx.page.evaluate(() => window.open('https://example.com/scripted', '_blank', 'noopener'));
  await expect.poll(() => ctx.recorded()).toEqual([
    'https://example.com/docs',
    'https://example.com/blank',
    'https://example.com/scripted',
  ]);
  expect(ctx.page.url()).toBe(`${mock.url}/`);
  expect(await windowCount(ctx)).toBe(1);
});

test('off-origin top-level navigation never happens in the window; file: is blocked outright', async ({ ctx, mock }) => {
  await ctx.page.evaluate(() => { window.location.href = 'https://example.org/elsewhere'; });
  await click(ctx.page, '#file');
  await ctx.page.evaluate(() => { window.location.href = 'file:///etc/hosts'; });
  // A same-origin page that redirects off-origin hands the target to the browser too.
  await click(ctx.page, '#redirect-out');
  await expect.poll(() => ctx.recorded()).toEqual(['https://example.org/elsewhere', 'https://example.net/landing']);
  await ctx.page.waitForTimeout(300);
  expect(ctx.page.url()).toBe(`${mock.url}/`);
  expect(await ctx.recorded()).not.toContain('file:///etc/hosts');
  expect(await pageReady(ctx.page)).toBe('Signed out');
});

test('a same-origin popup opens as a hardened in-app window', async ({ ctx, mock }) => {
  const popupPromise = ctx.app.waitForEvent('window');
  await click(ctx.page, '#popup');
  const popup = await popupPromise;
  await popup.waitForURL(`${mock.url}/popup`);
  const info = await ctx.app.evaluate(({ BrowserWindow, session }, url) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === url);
    const prefs = win.webContents.getLastWebPreferences();
    return {
      visible: win.isVisible(),
      title: win.getTitle(),
      sameSession: win.webContents.session === session.fromPartition('persist:laytekz'),
      contextIsolation: prefs.contextIsolation,
      sandbox: prefs.sandbox,
      nodeIntegration: prefs.nodeIntegration,
      webviewTag: prefs.webviewTag,
      preload: prefs.preload ?? null,
    };
  }, `${mock.url}/popup`);
  expect(info).toEqual({
    visible: false, title: 'Laytekz – Popup', sameSession: true, contextIsolation: true, sandbox: true,
    nodeIntegration: false, webviewTag: false, preload: null,
  });
  // The popup follows the same policy: external links leave, the sign-in link hands off.
  await popup.evaluate(() => { window.location.href = 'https://example.com/from-popup'; });
  await expect.poll(() => ctx.recorded()).toContain('https://example.com/from-popup');
  expect(popup.url()).toBe(`${mock.url}/popup`);
});

test('downloads from the server go through the save dialog and offer Show in Folder; other origins are blocked', async ({ ctx, mock }) => {
  const target = path.join(ctx.dir, 'saved-paper.pdf');
  await ctx.app.evaluate(({ dialog }, file) => {
    globalThis.saveDialogCalls = 0;
    dialog.showSaveDialogSync = () => {
      globalThis.saveDialogCalls += 1;
      return file;
    };
  }, target);

  await click(ctx.page, '#download');
  await until(async () => (await fs.readFile(target, 'utf8').catch(() => '')).startsWith('%PDF'), { message: 'the saved file' });
  await expect.poll(() => overlayText(ctx.app, 'toast.html')).toContain('Saved saved-paper.pdf');
  expect(await overlayText(ctx.app, 'toast.html')).toContain('Show in Folder');

  const blocked = path.join(ctx.dir, 'blocked.pdf');
  await ctx.app.evaluate(({ BrowserWindow, dialog }, [file, url]) => {
    dialog.showSaveDialogSync = () => {
      globalThis.saveDialogCalls += 1;
      return file;
    };
    BrowserWindow.getAllWindows()[0].webContents.downloadURL(url);
  }, [blocked, `http://localhost:${mock.port}/files/paper.pdf`]);
  await expect.poll(() => overlayText(ctx.app, 'toast.html')).toContain(`Blocked a download from http://localhost:${mock.port}`);
  expect(await ctx.app.evaluate(() => globalThis.saveDialogCalls)).toBe(1);
  await expect(fs.access(blocked)).rejects.toThrow();
});

test('cancelling the save dialog cancels the download', async ({ ctx }) => {
  await ctx.app.evaluate(({ dialog }) => { dialog.showSaveDialogSync = () => undefined; });
  await click(ctx.page, '#download');
  await ctx.page.waitForTimeout(800);
  expect(await overlayText(ctx.app, 'toast.html')).toBe(null);
});

test('permissions: only writing to the clipboard, for our origin', async ({ ctx }) => {
  const result = await ctx.page.evaluate(async () => {
    const query = async (name) => {
      try {
        return (await navigator.permissions.query({ name })).state;
      } catch (err) {
        return `error: ${err.name}`;
      }
    };
    return {
      geolocation: await query('geolocation'),
      camera: await query('camera'),
      notifications: await Notification.requestPermission(),
      clipboardRead: await query('clipboard-read'),
      clipboardWrite: await query('clipboard-write'),
    };
  });
  expect(result.geolocation).toBe('denied');
  expect(result.camera).toBe('denied');
  expect(result.notifications).toBe('denied');
  expect(result.clipboardRead).toBe('denied');
  expect(result.clipboardWrite).toBe('granted');
});

test('an integration OAuth round trip runs in an in-app auth window and returns with the same cookies', async ({ ctx, mock }) => {
  await signInViaHandoff(ctx);
  const recordedBefore = (await ctx.recorded()).length;

  await click(ctx.page, '#integration');
  // The window's own /api/ navigation is cancelled (ERR_ABORTED) when the chain leaves the origin,
  // so poll rather than wait for a navigation.
  await expect.poll(() => ctx.page.url(), { timeout: 15_000 }).toBe(`${mock.url}/?connected=demo`);

  expect(mock.state.integrations).toEqual([{ stateOk: true, user: 'Test User', code: 'provider-code' }]);
  // The provider was visited (in the auth window), nothing went to the system browser,
  // and the auth window closed itself once the chain came back.
  expect(mock.seen((r) => r.host.startsWith('localhost:') && r.path === '/authorize').length).toBeGreaterThanOrEqual(1);
  expect((await ctx.recorded()).length).toBe(recordedBefore);
  await expect.poll(() => windowCount(ctx)).toBe(1);
  expect(await pageReady(ctx.page)).toBe('Signed in as Test User');
});
