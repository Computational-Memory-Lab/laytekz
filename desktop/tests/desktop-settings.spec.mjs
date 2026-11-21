// The desktop app's own settings window (V2, WP41, feature 7). In plain
// Node: the value checks and the last-project rules. In the app: the window
// opens from its menu item and from Change Server… (#server); zoom set there
// is applied, survives a reload and a relaunch; the last project reopens at
// launch when asked; a server address is checked before it is saved; the
// remote page still has no preload.

import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { validateFeatures } from '../src/main/features/host.js';
import { SHELL_FEATURES } from '../src/main/features/index.js';
import {
  PREF_DEFAULTS, checkPref, isProjectList, projectPath, readPrefs,
} from '../src/main/features/desktopSettings/prefs.js';
import { APP_DIR, clickMenuItem, findPage, launchApp, tempDir, until } from './helpers.mjs';
import { startMockServer } from './mock-server.mjs';

const PAGE_URL = 'laytekz-ui://app/desktop-settings.html';

// ------------------------------------------------------------ plain Node

test.describe('desktop settings values (no Electron)', () => {
  test('each value is checked; a missing or wrong one gives the default', () => {
    expect(checkPref('openAtLogin', true)).toBe(true);
    expect(checkPref('openAtLogin', 'yes')).toBeNull();
    expect(checkPref('launch', 'last')).toBe('last');
    expect(checkPref('launch', 'somewhere')).toBeNull();
    expect(checkPref('zoomFactor', 1.254)).toBe(1.25);
    expect(checkPref('zoomFactor', 0.1)).toBeNull();
    expect(checkPref('zoomFactor', Number.NaN)).toBeNull();
    expect(checkPref('spellLanguages', ['en-US', 'fr', 'en-US'])).toEqual(['en-US', 'fr']);
    expect(checkPref('spellLanguages', ['en US'])).toBeNull();
    expect(checkPref('spellLanguages', Array(9).fill('en'))).toBeNull();
    expect(checkPref('serverUrl', 'x')).toBeNull();
    const stored = { launch: 'last', zoomFactor: 'big' };
    expect(readPrefs((k) => stored[k])).toEqual({ ...PREF_DEFAULTS, launch: 'last' });
  });

  test('the last project: its path, and only the project list is replaced at launch', () => {
    expect(projectPath({ id: 'abc123', branch: 'main' })).toBe('/p/abc123');
    expect(projectPath({ id: 'abc123', branch: 'draft/2' })).toBe('/p/abc123?branch=draft%2F2');
    expect(isProjectList('https://x.test', 'https://x.test/')).toBe(true);
    expect(isProjectList('https://x.test/base', 'https://x.test/base?tab=shared#top')).toBe(true);
    expect(isProjectList('https://x.test', 'https://x.test/settings')).toBe(false);
    expect(isProjectList('https://x.test', 'https://x.test/p/abc123')).toBe(false);
  });

  test('the shipped features declare the settings page and their menu items without problems', () => {
    const uiDir = path.join(APP_DIR, 'src', 'ui');
    const { records, problems } = validateFeatures(SHELL_FEATURES, {
      pageExists: (name) => fsSync.existsSync(path.join(uiDir, name)),
      preloadExists: (name) => fsSync.existsSync(path.join(APP_DIR, 'src', 'preload', name)),
    });
    expect(problems.filter((p) => /desktopSettings|bibwatch/.test(p))).toEqual([]);
    const ds = records.find((r) => r.id === 'desktopSettings');
    expect(ds.settingsPage).toBe('desktop-settings.html');
    expect(ds.pages.get('desktop-settings.html')).toEqual({ preload: 'ui.cjs' });
    expect(ds.menu.map((m) => m.item.id)).toEqual(['desktop-settings']);
    expect(records.find((r) => r.id === 'bibwatch').menu.map((m) => [m.where, m.item.id])).toEqual([
      ['file', 'bibwatch-link'], ['file', 'bibwatch-manage'],
    ]);
  });
});

// ------------------------------------------------------------ in the app

async function settingsPage(app) {
  const page = await findPage(app, PAGE_URL);
  await page.waitForSelector('body[data-ready="1"]', { timeout: 10_000 });
  return page;
}

/** The zoom factor of the window showing the server. */
async function mainZoom(app, origin) {
  return app.evaluate(({ BrowserWindow }, o) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith(o));
    return win ? win.webContents.getZoomFactor() : null;
  }, origin);
}

async function mainUrl(app, origin) {
  return app.evaluate(({ BrowserWindow }, o) => BrowserWindow.getAllWindows().map((w) => w.webContents.getURL()).find((u) => u.startsWith(o)) ?? null, origin);
}

const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));

test.describe('desktop settings window', () => {
  test('zoom is applied, kept across a reload and a relaunch; the last project reopens; no preload on the remote page', async () => {
    test.setTimeout(120_000);
    const mock = await startMockServer();
    const dir = await tempDir();
    let ctx = await launchApp({ serverUrl: mock.url, dir });
    try {
      expect(await ctx.page.evaluate(() => typeof window.laytekz)).toBe('undefined');

      await clickMenuItem(ctx.app, 'desktop-settings');
      const page = await settingsPage(ctx.app);
      expect(await page.inputValue('[data-testid="desktop-server-url"]')).toBe(mock.url);
      expect(await page.inputValue('[data-testid="desktop-zoom"]')).toBe('1');

      await page.selectOption('[data-testid="desktop-zoom"]', '1.25');
      await expect.poll(() => mainZoom(ctx.app, mock.url)).toBeCloseTo(1.25, 2);
      expect((await readJson(path.join(dir, 'settings.json'))).features.desktopSettings.zoomFactor).toBe(1.25);

      await ctx.page.reload();
      await ctx.page.waitForSelector('body[data-ready="1"]');
      await expect.poll(() => mainZoom(ctx.app, mock.url)).toBeCloseTo(1.25, 2);

      // Opening a project records it for this server.
      await ctx.page.goto(`${mock.url}/p/proj1234?branch=draft`);
      await expect.poll(async () => (await readJson(path.join(dir, 'settings.json'))).features.desktopSettings.lastPaths?.[mock.url])
        .toBe('/p/proj1234?branch=draft');
      await page.click('[data-testid="desktop-launch-last"]');
      await expect.poll(async () => (await readJson(path.join(dir, 'settings.json'))).features.desktopSettings.launch).toBe('last');
      await ctx.close({ keepDir: true });

      // Relaunch: the project list is replaced by the last project, at the same zoom.
      ctx = await launchApp({ serverUrl: mock.url, dir });
      await until(async () => (await mainUrl(ctx.app, mock.url))?.includes('/p/proj1234?branch=draft'), { message: 'the last project to reopen' });
      await expect.poll(() => mainZoom(ctx.app, mock.url)).toBeCloseTo(1.25, 2);
      expect(await ctx.page.evaluate(() => typeof window.laytekz)).toBe('undefined');
    } finally {
      await ctx.close();
      await mock.stop();
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test('Change Server… opens it at #server; a bad address is refused, a good one saved for the restart', async () => {
    test.setTimeout(90_000);
    const mock = await startMockServer();
    const second = await startMockServer();
    const ctx = await launchApp({ serverUrl: mock.url });
    try {
      await clickMenuItem(ctx.app, 'change-server');
      const page = await settingsPage(ctx.app);
      expect(new URL(page.url()).hash).toBe('#server');

      await page.fill('[data-testid="desktop-server-url"]', 'http://example.com');
      await page.click('[data-testid="desktop-server-save"]');
      await expect(page.locator('[data-testid="desktop-server-message"]')).toHaveText(/Use https:\/\//);

      // The same server: nothing to do.
      await page.fill('[data-testid="desktop-server-url"]', mock.url);
      await page.click('[data-testid="desktop-server-save"]');
      await expect(page.locator('[data-testid="desktop-server-message"]')).toHaveText(`Already connected to ${mock.url}.`);

      const other = second.url;
      await page.fill('[data-testid="desktop-server-url"]', other);
      await page.click('[data-testid="desktop-server-save"]');
      const message = page.locator('[data-testid="desktop-server-message"]');
      await expect(message).toHaveText(new RegExp(`^(Connected to|Laytekz restarts to connect to) ${other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.$`));
      expect((await readJson(path.join(ctx.dir, 'settings.json'))).serverUrl).toBe(other);
      if ((await message.textContent()).startsWith('Connected')) {
        // With request R1 (ShellCtx.applyServer) the main window switches in place.
        await expect.poll(() => mainUrl(ctx.app, other)).toBe(`${other}/`);
      } else {
        const log = (await fs.readFile(path.join(ctx.dir, 'desktop-settings.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
        expect(log).toContainEqual({ restart: other });
      }

      // The web app's Desktop button (window.open) reaches the same window.
      await ctx.page.evaluate(() => { window.open('/settings/desktop-app'); });
      await new Promise((r) => setTimeout(r, 500));
      const pages = ctx.app.windows().filter((p) => p.url().startsWith(PAGE_URL));
      expect(pages).toHaveLength(1);
    } finally {
      await ctx.close();
      await mock.stop();
      await second.stop();
    }
  });
});
