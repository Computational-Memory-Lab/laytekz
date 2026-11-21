// Change server, the menu, About, window state and the single-instance lock.
// Galley: V2 desktop shell (WP09): the shell feature host (in plain Node and
// in the app, with the test-only probe features), Settings…, the
// /settings/desktop-app intercept, the user-agent token, the context menu
// against the page's own, and every accelerator against the web UI's chords.

import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { BUILT_IN_SETTINGS_PAGE, createShellHost, validateFeatures } from '../src/main/features/host.js';
import { SHELL_FEATURES } from '../src/main/features/index.js';
import {
  DESKTOP_UA_TOKEN, WEB_CHORDS, acceleratorOwner, chordKey, withDesktopToken,
} from '../src/main/rules.js';
import { Server } from '../src/main/server.js';
import {
  APP_DIR, cleanEnv, clickMenuItem, findPage, launchApp, launchWithProbe, menuItems, overlayClick, overlayText,
  overlayViews, pageReady, tempDir, until,
} from './helpers.mjs';
import { startMockServer } from './mock-server.mjs';
import { PROBE_CSP } from './mocks/_probe-feature.mjs';

const electronBinary = createRequire(import.meta.url)('electron');
const isMac = process.platform === 'darwin';

async function openChangeServer(ctx) {
  const dialogPromise = ctx.app.waitForEvent('window', (p) => p.url().includes('change-server.html'));
  await ctx.app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('change-server').click());
  const dialog = await dialogPromise;
  await dialog.waitForSelector('[data-testid="server-url"]');
  await expect.poll(() => dialog.inputValue('[data-testid="server-url"]')).not.toBe('');
  return dialog;
}

async function tryServer(dialog, value) {
  await dialog.fill('[data-testid="server-url"]', value);
  await dialog.evaluate(() => document.querySelector('[data-testid="server-save"]').click());
  await expect.poll(() => dialog.textContent('[data-testid="server-message"]')).not.toMatch(/^Checking/);
  return dialog.textContent('[data-testid="server-message"]');
}

/** Waits for the Change Server window (the desktop settings page until a feature names its own), then closes it. */
async function expectSettingsWindow(ctx, trigger) {
  const opened = ctx.app.waitForEvent('window', { predicate: (p) => p.url().includes(BUILT_IN_SETTINGS_PAGE), timeout: 15_000 });
  await trigger();
  const dialog = await opened;
  await dialog.waitForSelector('[data-testid="server-url"]');
  const closed = dialog.waitForEvent('close');
  await dialog.evaluate(() => document.querySelector('[data-testid="server-cancel"]').click());
  await closed;
}

test('Change server validates the address before switching, and remembers it', async () => {
  const mock = await startMockServer();
  const other = await startMockServer();
  const notLaytekz = http.createServer((req, res) => { res.writeHead(404); res.end('nope'); });
  await new Promise((r) => notLaytekz.listen(0, '127.0.0.1', r));
  const closed = await startMockServer();
  await closed.stop();
  const ctx = await launchApp({ serverUrl: mock.url });
  try {
    await pageReady(ctx.page);
    const dialog = await openChangeServer(ctx);
    expect(await dialog.inputValue('[data-testid="server-url"]')).toBe(mock.url);

    expect(await tryServer(dialog, 'http://example.com')).toMatch(/Use https:\/\//);
    expect(await tryServer(dialog, 'ftp://example.com')).toMatch(/must start with https/);
    expect(await tryServer(dialog, `http://127.0.0.1:${notLaytekz.address().port}`)).toMatch(/does not answer like a Laytekz server/);
    expect(await tryServer(dialog, `http://127.0.0.1:${closed.port}`)).toMatch(/refused the connection/);
    expect(ctx.page.url()).toBe(`${mock.url}/`);

    await dialog.fill('[data-testid="server-url"]', `${other.url}/`);
    const closedPromise = dialog.waitForEvent('close');
    await dialog.evaluate(() => document.querySelector('[data-testid="server-save"]').click());
    await closedPromise;
    await expect.poll(() => ctx.page.url()).toBe(`${other.url}/`);
    expect(await pageReady(ctx.page)).toBe('Signed out');

    const settings = JSON.parse(await fs.readFile(path.join(ctx.dir, 'settings.json'), 'utf8'));
    expect(settings.serverUrl).toBe(other.url);

    // The navigation policy follows the new origin: the old server is now "elsewhere".
    await ctx.page.evaluate((url) => { window.location.href = url; }, `${mock.url}/somewhere`);
    await expect.poll(() => ctx.recorded()).toContain(`${mock.url}/somewhere`);
  } finally {
    await ctx.close();
    await Promise.all([mock.close(), other.close()]);
    notLaytekz.close();
  }
});

test('Change server is reachable from the offline page, and so is the desktop settings window through Settings…', async () => {
  const mock = await startMockServer();
  await mock.stop();
  const ctx = await launchApp({ serverUrl: mock.url, env: { LAYTEKZ_TEST_RETRY_MS: '20000' }, waitForPage: false });
  try {
    await until(() => overlayText(ctx.app, 'offline.html'), { message: 'the offline page' });
    const dialogPromise = ctx.app.waitForEvent('window', (p) => p.url().includes('change-server.html'));
    await overlayClick(ctx.app, 'offline.html', 'offline-change-server');
    const dialog = await dialogPromise;
    await dialog.waitForSelector('[data-testid="server-url"]');
    const closed = dialog.waitForEvent('close');
    await dialog.evaluate(() => document.querySelector('[data-testid="server-cancel"]').click());
    await closed;
    // Galley: V2: with the server out of reach, Settings… can only mean the desktop's own settings.
    await expectSettingsWindow(ctx, () => clickMenuItem(ctx.app, 'settings'));
  } finally {
    await ctx.close();
  }
});

// Galley: V2 (WP09). The chords of the plan's table (section 2.3) and of V1's
// web UI (util/shortcuts.ts and the editor keymaps), mirrored here on purpose
// rather than read from rules.js, so a chord dropped from rules.js fails.
const WEB_UI_CHORDS = [
  // V1
  'Mod+S', 'Mod+K', 'Mod+J', 'Mod+F', 'Mod+G', 'Mod+D', 'Mod+B', 'Mod+I', 'Mod+/', 'Mod+[', 'Mod+]', 'Mod+Enter',
  'Mod+Shift+M', 'Mod+Shift+F', 'Mod+Shift+K', 'Mod+Shift+G', 'Mod+Alt+G', 'Shift+Alt+F', 'Mod+Shift+C',
  // V2 (plan §2.3)
  'Mod+Shift+E', 'Mod+Shift+X', 'Mod+Shift+Space', 'Alt+Enter', 'Shift+Alt+Enter', 'Mod+Shift+H', 'Mod+Shift+U',
  'Shift+Alt+A', 'Tab', 'Mod+Right', 'Escape', 'Alt+\\', 'Mod+Shift+V', 'Mod+P', 'Shift+F10',
];
// The desktop's own accelerators the plan allows (section 2.3): ⌘R, ⇧⌘R,
// developer tools, ⌘0/=/−/+, ⌘M, ⌘H, ⌥⌘H, ⌘Q, ⌘W, Ctrl+`, ⌘, (and full screen).
const DESKTOP_ALLOWED = {
  darwin: ['Mod+R', 'Shift+Mod+R', 'Alt+Mod+I', 'Mod+0', 'Mod+=', 'Mod+Plus', 'Mod+-', 'Mod+M', 'Mod+H', 'Alt+Mod+H', 'Mod+Q', 'Mod+W', 'Control+`', 'Mod+,', 'Control+Mod+F'],
  other: ['Mod+R', 'Shift+Mod+R', 'Control+Shift+I', 'Mod+0', 'Mod+=', 'Mod+Plus', 'Mod+-', 'Mod+W', 'Control+`', 'Mod+,', 'F11'],
};
// Edit roles share keys with the editor on purpose: they do the same thing.
const EDIT_ROLES = new Set(['undo', 'redo', 'cut', 'copy', 'paste', 'pasteandmatchstyle', 'delete', 'selectall']);

test('the menu has About, Settings, Change server and Help, and no accelerator shadows the web UI', async () => {
  const mock = await startMockServer();
  const ctx = await launchApp({ serverUrl: mock.url });
  try {
    await pageReady(ctx.page);
    const items = await menuItems(ctx.app);
    const ids = items.map((i) => i.id);
    for (const id of ['about', 'settings', 'change-server', 'help-site', 'help-source', 'help-privacy', 'reload']) expect(ids).toContain(id);
    const roles = items.map((i) => i.role).filter(Boolean);
    for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectall', 'zoomin', 'zoomout', 'resetzoom', 'togglefullscreen', 'toggledevtools']) {
      expect(roles).toContain(role);
    }
    // The product name wherever the menu shows one (macOS fills role labels from app.name).
    const labels = items.map((i) => i.label);
    for (const label of ['About Laytekz', 'Laytekz Website']) expect(labels).toContain(label);
    if (isMac) {
      for (const label of ['Laytekz', 'Hide Laytekz', 'Quit Laytekz', 'Settings…', 'Change Server…']) expect(labels).toContain(label);
    }

    // Settings… owns Cmd/Ctrl+, (the platform's settings chord); Change Server… gave it up.
    const byId = Object.fromEntries(items.filter((i) => i.id).map((i) => [i.id, i]));
    expect(byId.settings.accelerator).toBe('CommandOrControl+,');
    expect(byId['change-server'].accelerator).toBeNull();
    expect(byId.settings.top).toBe(isMac ? 'Laytekz' : '&File');
    // No File menu on macOS until a shell feature puts something in it.
    if (isMac) expect(items.filter((i) => i.top === null).map((i) => i.label)).not.toContain('File');

    // Chords compared as sets of modifiers plus a key, for this platform.
    const platform = process.platform;
    const chord = (accel) => chordKey(accel, platform);
    expect(chord('Shift+CommandOrControl+F')).toBe(chord('CmdOrCtrl+Shift+F'));
    const web = WEB_UI_CHORDS.map(chord);
    const allowed = (isMac ? DESKTOP_ALLOWED.darwin : DESKTOP_ALLOWED.other).map(chord);
    const used = items
      .filter((i) => !(i.role && EDIT_ROLES.has(i.role)))
      .map((i) => ({ id: i.id ?? i.role ?? i.label, accel: i.accelerator ?? i.defaultAccelerator }))
      .filter((i) => i.accel);
    expect(used.length).toBeGreaterThan(5);
    for (const { id, accel } of used) {
      expect(web, `${id}: ${accel}`).not.toContain(chord(accel));
      expect(allowed, `${id}: ${accel} is not one of the desktop's own chords`).toContain(chord(accel));
    }
    // Only Settings… holds Cmd/Ctrl+,.
    expect(used.filter((i) => chord(i.accel) === chord('Mod+,')).map((i) => i.id)).toEqual(['settings']);
    // The rules the host applies to shell features' items cover the same table.
    for (const c of WEB_UI_CHORDS) expect(WEB_CHORDS.map(chord), c).toContain(chord(c));

    // About names the version, the credit, the server's source offer and its privacy page.
    const about = await ctx.app.evaluate(async ({ dialog, Menu }) => {
      let captured = null;
      dialog.showMessageBox = async (...args) => {
        captured = args.at(-1);
        return { response: 1 };
      };
      Menu.getApplicationMenu().getMenuItemById('about').click();
      await new Promise((r) => setTimeout(r, 200));
      return captured;
    });
    expect(about.message).toBe('Laytekz');
    expect(about.detail).toContain('Version 1.0.0');
    expect(about.detail).toContain('Based on Aldine: https://github.com/trahloff/Aldine');
    expect(about.detail).toContain(`licensed under the AGPL-3.0. Its source code: ${mock.url}/source`);
    expect(about.detail).toContain(`Privacy: ${mock.url}/privacy`);
    expect(about.buttons).toEqual(['OK', 'Get the Source Code', 'Privacy']);
    await expect.poll(() => ctx.recorded()).toContain(`${mock.url}/source`);
    await ctx.app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('help-privacy').click());
    await expect.poll(() => ctx.recorded()).toContain(`${mock.url}/privacy`);

    await ctx.app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('help-site').click());
    await expect.poll(() => ctx.recorded()).toContain('https://latex.devon7y.com/');
  } finally {
    await ctx.close();
    await mock.close();
  }
});

test('window size and position are remembered across launches', async () => {
  const mock = await startMockServer();
  const dir = await tempDir();
  try {
    const first = await launchApp({ serverUrl: mock.url, dir });
    await pageReady(first.page);
    await first.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 120, y: 90, width: 1024, height: 700 }));
    await until(async () => {
      const s = JSON.parse(await fs.readFile(path.join(dir, 'settings.json'), 'utf8').catch(() => '{}'));
      return s.window?.bounds?.width === 1024;
    }, { message: 'the window state to be saved' });
    await first.close();

    const second = await launchApp({ serverUrl: mock.url, dir });
    const bounds = await second.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
    expect(bounds.width).toBe(1024);
    expect(bounds.height).toBe(700);
    expect(bounds.x).toBe(120);
    await second.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await mock.close();
  }
});

test('closing a window with unsynced edits asks first instead of silently refusing', async () => {
  const mock = await startMockServer();
  const ctx = await launchApp({ serverUrl: mock.url });
  try {
    await pageReady(ctx.page);
    // What the web UI does while edits are unsynced (editor/syncStatus.ts).
    await ctx.page.evaluate(() => window.addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = ''; }));
    await ctx.page.mouse.click(5, 5); // Chromium honours beforeunload only after a user gesture
    const answer = (choice) => ctx.app.evaluate(({ dialog, BrowserWindow }, c) => {
      globalThis.unloadAsked = (globalThis.unloadAsked ?? 0);
      dialog.showMessageBoxSync = () => { globalThis.unloadAsked += 1; return c; };
      BrowserWindow.getAllWindows()[0].close();
    }, choice);
    const windows = () => ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

    await answer(1); // Stay
    await expect.poll(() => ctx.app.evaluate(() => globalThis.unloadAsked)).toBe(1);
    await ctx.page.waitForTimeout(300);
    expect(await windows()).toBe(1);

    await answer(0); // Leave
    await expect.poll(windows).toBe(0);
    expect(await ctx.app.evaluate(() => globalThis.unloadAsked)).toBe(2);
  } finally {
    await ctx.close();
    await mock.close();
  }
});

test('a second launch with the same profile exits and leaves the first running', async () => {
  const mock = await startMockServer();
  const ctx = await launchApp({ serverUrl: mock.url });
  try {
    await pageReady(ctx.page);
    const child = spawn(electronBinary, [APP_DIR], {
      env: cleanEnv({ LAYTEKZ_TEST_MODE: '1', LAYTEKZ_TEST_USER_DATA: ctx.dir, LAYTEKZ_TEST_SERVER_URL: mock.url }),
      stdio: 'ignore',
    });
    const code = await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve('still running'); }, 15_000);
      child.on('exit', (c) => { clearTimeout(timer); resolve(c); });
    });
    expect(code).toBe(0);
    expect(await pageReady(ctx.page)).toBe('Signed out');
  } finally {
    await ctx.close();
    await mock.close();
  }
});

// ------------------------------------------------------ V2 desktop shell (WP09)

test('Settings… hands the page the open-settings event; unhandled, a V2 server shows /settings', async () => {
  const mock = await startMockServer();
  const ctx = await launchApp({ serverUrl: mock.url });
  try {
    await pageReady(ctx.page);
    // What the web app does (settings/types.ts OPEN_SETTINGS_EVENT): open its settings, cancel the event.
    await ctx.page.evaluate(() => {
      window.openSettingsEvents = [];
      window.handleSettings = (e) => {
        window.openSettingsEvents.push({ detail: e.detail, cancelable: e.cancelable, trusted: e.isTrusted });
        e.preventDefault();
      };
      window.addEventListener('laytekz:open-settings', window.handleSettings);
    });
    await clickMenuItem(ctx.app, 'settings');
    await expect.poll(() => ctx.page.evaluate(() => window.openSettingsEvents.length)).toBe(1);
    expect(await ctx.page.evaluate(() => window.openSettingsEvents[0])).toEqual({ detail: null, cancelable: true, trusted: false });
    await ctx.page.waitForTimeout(500);
    expect(ctx.page.url()).toBe(`${mock.url}/`);

    // A page that leaves the event alone (no settings page of its own): the server's /settings.
    await ctx.page.evaluate(() => window.removeEventListener('laytekz:open-settings', window.handleSettings));
    await clickMenuItem(ctx.app, 'settings');
    await expect.poll(() => ctx.page.url()).toBe(`${mock.url}/settings`);
    expect(mock.seen((r) => r.path === '/api/capabilities').length).toBeGreaterThan(0);
    expect(await ctx.recorded()).toEqual([]);
  } finally {
    await ctx.close();
    await mock.close();
  }
});

test('Settings… against a server without /api/capabilities (V1) opens the desktop settings window, as in desktop 1.0', async () => {
  const mock = await startMockServer({ capabilities: null });
  const ctx = await launchApp({ serverUrl: mock.url });
  try {
    await pageReady(ctx.page);
    await expectSettingsWindow(ctx, () => clickMenuItem(ctx.app, 'settings'));
    expect(ctx.page.url()).toBe(`${mock.url}/`);
  } finally {
    await ctx.close();
    await mock.close();
  }
});

test('<base>/settings/desktop-app opens the desktop settings window, never the page', async () => {
  const mock = await startMockServer();
  const ctx = await launchApp({ serverUrl: mock.url });
  try {
    await pageReady(ctx.page);
    const appWindows = () => ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .map((w) => w.webContents.getURL()).filter((u) => !u.startsWith('laytekz-ui:')));

    // The web app's Desktop settings button (window.open), with a query the shell ignores.
    await expectSettingsWindow(ctx, () => ctx.page.evaluate(() => window.open('/settings/desktop-app?from=settings', '_blank')));
    expect(await appWindows()).toEqual([`${mock.url}/`]);
    // A plain navigation to it, a second later (repeats within a second are ignored).
    await ctx.page.waitForTimeout(1100);
    await expectSettingsWindow(ctx, () => ctx.page.evaluate(() => { window.location.href = '/settings/desktop-app#desktop'; }));
    await ctx.page.waitForTimeout(300);
    expect(ctx.page.url()).toBe(`${mock.url}/`);
    expect(mock.seen((r) => r.path.startsWith('/settings/desktop-app'))).toHaveLength(0);
    expect(await ctx.recorded()).toEqual([]);
  } finally {
    await ctx.close();
    await mock.close();
  }
});

test('the user agent of the page and of its requests ends with Laytekz-Desktop/<version>', async () => {
  const mock = await startMockServer();
  const ctx = await launchApp({ serverUrl: mock.url });
  try {
    await pageReady(ctx.page);
    const ua = await ctx.page.evaluate(() => navigator.userAgent);
    expect(ua).toMatch(/ Laytekz-Desktop\/1\.0\.0$/);
    expect(ua.match(/Laytekz-Desktop\//g)).toHaveLength(1);
    for (const p of ['/', '/api/auth/me']) {
      const seen = mock.seen((r) => r.path === p && r.method === 'GET');
      expect(seen.length, p).toBeGreaterThan(0);
      for (const r of seen) expect(r.userAgent, p).toMatch(/ Laytekz-Desktop\/1\.0\.0$/);
    }
  } finally {
    await ctx.close();
    await mock.close();
  }
});

test('a contextmenu the page cancels shows no native menu; one it leaves alone on a misspelt word offers spelling', async () => {
  const mock = await startMockServer();
  const ctx = await launchApp({ serverUrl: mock.url });
  try {
    await pageReady(ctx.page);
    await ctx.page.evaluate(() => { window.location.href = '/editor-sim'; });
    await ctx.page.waitForSelector('body[data-ready="1"] #zone');
    // Record the native menus instead of showing them (a hidden test window has nowhere to show one).
    await ctx.app.evaluate(({ BrowserWindow, Menu }) => {
      globalThis.shownMenus = [];
      globalThis.contextMenuEvents = [];
      Menu.prototype.popup = function popup() {
        globalThis.shownMenus.push(this.items.map((i) => i.label || i.role));
      };
      const [win] = BrowserWindow.getAllWindows();
      win.webContents.on('context-menu', (_e, p) => {
        globalThis.contextMenuEvents.push({ misspelledWord: p.misspelledWord, suggestions: p.dictionarySuggestions, editable: p.isEditable });
      });
    });
    const shown = () => ctx.app.evaluate(() => ({ menus: globalThis.shownMenus, events: globalThis.contextMenuEvents }));

    // The page's own menu (the editor cancels the DOM event): Electron never hears of it.
    const zone = await ctx.page.locator('#zone').boundingBox();
    await ctx.page.mouse.click(zone.x + 40, zone.y + 40, { button: 'right' });
    await expect.poll(() => ctx.page.evaluate(() => window.cancelled)).toBe(1);
    await ctx.page.waitForTimeout(600);
    expect(await shown()).toEqual({ menus: [], events: [] });

    // Left alone, on a misspelt word in editable text: the spelling suggestions, then the edit items.
    await ctx.page.click('#text');
    await ctx.page.keyboard.press('End');
    await ctx.page.keyboard.type(' ');
    const word = await ctx.page.evaluate(() => {
      const node = document.getElementById('text').firstChild;
      const at = node.textContent.indexOf('mispelled');
      const range = document.createRange();
      range.setStart(node, at + 2);
      range.setEnd(node, at + 6);
      const b = range.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    });
    const spelled = await until(async () => {
      await ctx.page.mouse.click(word.x, word.y, { button: 'right' });
      await ctx.page.waitForTimeout(400);
      const { events, menus } = await shown();
      const last = events.at(-1);
      return last?.misspelledWord ? { last, menu: menus.at(-1) } : null;
    }, { timeout: 20_000, interval: 600, message: 'a right-click on the misspelt word to report it' });
    expect(spelled.last.misspelledWord).toBe('mispelled');
    expect(spelled.last.editable).toBe(true);
    expect(spelled.menu).toContain('Add to Dictionary');
    expect(spelled.menu.map((l) => String(l).toLowerCase())).toContain('cut');
    if (spelled.last.suggestions.length) {
      expect(spelled.menu.slice(0, Math.min(5, spelled.last.suggestions.length))).toEqual(spelled.last.suggestions.slice(0, 5));
    } else {
      expect(spelled.menu).toContain('No Guesses Found');
    }
    // The cancelled zone still shows nothing.
    const before = (await shown()).events.length;
    await ctx.page.mouse.click(zone.x + 40, zone.y + 40, { button: 'right' });
    await expect.poll(() => ctx.page.evaluate(() => window.cancelled)).toBe(2);
    await ctx.page.waitForTimeout(400);
    expect((await shown()).events.length).toBe(before);
  } finally {
    await ctx.close();
    await mock.close();
  }
});

test('shell features: menu places, start context, own pages, IPC, overlay, vetoes and stop at quit', async () => {
  const mock = await startMockServer();
  const ctx = await launchWithProbe({ serverUrl: mock.url });
  try {
    await pageReady(ctx.page);

    // Menu items in their places; a shadowing accelerator dropped; a bad entry and a failed feature's items absent.
    const items = await menuItems(ctx.app);
    const byId = Object.fromEntries(items.filter((i) => i.id).map((i) => [i.id, i]));
    expect(byId['probe-app'].top).toBe(isMac ? 'Laytekz' : '&File');
    expect(byId['probe-file'].top).toBe(isMac ? 'File' : '&File');
    expect(byId['probe-file'].accelerator).toBeNull();
    expect(byId['probe-view'].top).toBe(isMac ? 'View' : '&View');
    expect(byId['probe-view'].accelerator).toBe('Control+`');
    expect(byId['probe-help'].top).toBe(isMac ? 'Help' : '&Help');
    expect(byId['probe-bad']).toBeUndefined();
    expect(byId['probe-broken-help']).toBeUndefined();
    const appMenu = items.filter((i) => i.top === (isMac ? 'Laytekz' : '&File')).map((i) => i.id);
    // Galley: V2 (WP17 R3, applied by WP25): shipped features' app items (Console Settings…) come first, in list order.
    expect(appMenu.slice(appMenu.indexOf('change-server') + 1, appMenu.indexOf('probe-app') + 1)).toEqual(['console-settings', 'probe-app']);

    // start(ctx) ran once, after the main window existed, with the server in use.
    const started = await ctx.app.evaluate(() => globalThis.laytekzProbe.started);
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ server: mock.url, mainWindow: true });
    const settingsFile = () => fs.readFile(path.join(ctx.dir, 'settings.json'), 'utf8').then(JSON.parse);
    expect((await settingsFile()).features?.probe?.startedWith).toBe(mock.url);

    // projectFromUrl and sessionFetch: the window session's cookie, no Origin header, the desktop user agent.
    expect(await ctx.app.evaluate((_e, base) => {
      const { ctx: c } = globalThis.laytekzProbe;
      return [c.projectFromUrl(`${base}/p/abcd1234?branch=draft`), c.projectFromUrl(`${base}/p/abcd1234/settings/editor`), c.projectFromUrl('https://elsewhere.example/p/abcd1234'), c.projectFromUrl(`${base}/`)];
    }, mock.url)).toEqual([{ id: 'abcd1234', branch: 'draft' }, { id: 'abcd1234', branch: 'main' }, null, null]);
    await ctx.app.evaluate(({ session }, url) => session.fromPartition('persist:laytekz').cookies.set({ url, name: 'aldine_session', value: 'probe-session' }), mock.url);
    const echo = await ctx.app.evaluate(async () => {
      const res = await globalThis.laytekzProbe.ctx.sessionFetch('/api/probe/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"n":1}' });
      return { status: res.status, body: await res.json() };
    });
    expect(echo.status).toBe(200);
    expect(echo.body).toMatchObject({ method: 'POST', origin: null, sessionCookie: true, body: '{"n":1}' });
    expect(echo.body.userAgent).toMatch(/ Laytekz-Desktop\/1\.0\.0$/);
    expect(await ctx.app.evaluate(() => globalThis.laytekzProbe.ctx.sessionFetch('https://elsewhere.example/x').then(() => 'sent', (e) => e.message)))
      .toMatch(/path on the server/);

    // A menu item that throws is logged, never raised; the others still work.
    await clickMenuItem(ctx.app, 'probe-help');
    await clickMenuItem(ctx.app, 'probe-app');
    await expect.poll(() => ctx.app.evaluate(() => globalThis.laytekzProbe.events.map((e) => e.name))).toContain('menu:app');

    // Its own local window: its partition, its preload, its CSP, and its state through the shared bridge.
    await ctx.app.evaluate(() => { globalThis.laytekzProbe.ctx.openLocalWindow('offline.html', { title: 'Probe', width: 480, height: 320 }); });
    const local = await findPage(ctx.app, 'laytekz-ui://app/offline.html');
    await expect.poll(() => local.textContent('#host')).toBe('probe-host');
    const prefs = await ctx.app.evaluate(({ BrowserWindow, session }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === 'laytekz-ui://app/offline.html');
      const p = win.webContents.getLastWebPreferences();
      return {
        probeSession: win.webContents.session === session.fromPartition('laytekz-probe'),
        sandbox: p.sandbox,
        contextIsolation: p.contextIsolation,
        nodeIntegration: p.nodeIntegration,
        visible: win.isVisible(),
      };
    });
    expect(prefs).toEqual({ probeSession: true, sandbox: true, contextIsolation: true, nodeIntegration: false, visible: false });
    // Its declared preload (ui.cjs, the shared bridge) is what the page has: getLastWebPreferences does not report preloads.
    expect(await local.evaluate(() => [Object.keys(window.laytekz).sort(), typeof require, typeof process]))
      .toEqual([['action', 'onState', 'state'], 'undefined', 'undefined']);
    await local.click('[data-testid="offline-retry"]');
    await expect.poll(() => ctx.app.evaluate(() => globalThis.laytekzProbe.events.map((e) => e.name))).toContain('action:retry');
    // A second open focuses the same window.
    await ctx.app.evaluate(() => { globalThis.laytekzProbe.ctx.openLocalWindow('offline.html'); });
    expect(await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .filter((w) => w.webContents.getURL() === 'laytekz-ui://app/offline.html').length)).toBe(1);
    // The page's CSP is the feature's; other pages keep the default; the partition has no network.
    const csp = await ctx.app.evaluate(async ({ session }) => {
      const ses = session.fromPartition('laytekz-probe');
      const own = await ses.fetch('laytekz-ui://app/offline.html');
      const other = await ses.fetch('laytekz-ui://app/toast.html');
      return [own.headers.get('content-security-policy'), other.headers.get('content-security-policy')];
    });
    expect(csp[0]).toBe(PROBE_CSP);
    expect(csp[1]).not.toBe(PROBE_CSP);
    expect(csp[1]).toContain("default-src 'none'");
    expect(await local.evaluate((url) => fetch(url).then(() => 'reached', () => 'blocked'), `${mock.url}/api/health`)).toBe('blocked');

    // An overlay over the main window, from a menu item: its page, its partition, the bounds it chose.
    await clickMenuItem(ctx.app, 'probe-view');
    const overlay = await until(async () => (await overlayViews(ctx.app)).find((v) => v.url === 'laytekz-ui://app/offline.html'), { message: 'the probe overlay' });
    expect(overlay.partition).toBe('laytekz-probe');
    expect(overlay.bounds.height).toBe(200);
    await expect.poll(() => overlayText(ctx.app, 'offline.html')).toContain('probe-host');

    // The remote page: still no preload and no bridge; the vetoed permission refused.
    expect(await ctx.page.evaluate(() => [typeof window.laytekz, typeof require, typeof process])).toEqual(['undefined', 'undefined', 'undefined']);
    expect(await ctx.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('http'));
      return win.webContents.getLastWebPreferences().preload ?? null;
    })).toBeNull();
    expect(await ctx.page.evaluate(() => navigator.permissions.query({ name: 'clipboard-write' }).then((s) => s.state))).not.toBe('granted');

    // Quit: the feature's stop function ran.
    await ctx.app.close();
    expect((await settingsFile()).features?.probe?.stopped).toBe(true);
  } finally {
    await ctx.close();
    await mock.close();
  }
});

// ------------------------------------------------ V2 shell host, without Electron

test.describe('shell feature host (no Electron)', () => {
  const FAKE_UI = 'laytekz-ui://app/';

  /** A host over fake Electron parts; `log` collects warnings, `windows` the local windows made. */
  function makeHost(features, overrides = {}) {
    const store = { data: {} };
    const handlers = new Map();
    const calls = { windows: [], overlays: [], focused: [], changeServer: 0, changed: 0, log: [], fetches: [] };
    let nextId = 100;
    const server = overrides.server === undefined ? new Server('https://laytekz.invalid/base') : overrides.server;
    const host = createShellHost({
      features,
      platform: overrides.platform ?? 'darwin',
      server: () => server,
      mainWindow: () => overrides.mainWindow ?? null,
      remoteSession: () => ({ fetch: async (url, init) => { calls.fetches.push({ url, init }); return { status: 200 }; } }),
      loadSettings: () => store.data,
      saveSettings: (patch) => { store.data = { ...store.data, ...patch }; return store.data; },
      ipcMain: {
        handle: (channel, fn) => {
          if (handlers.has(channel)) throw new Error(`second handler for ${channel}`);
          handlers.set(channel, fn);
        },
        removeHandler: (channel) => handlers.delete(channel),
      },
      createLocalWindow: (page, spec, opts) => {
        const win = fakeWindow(nextId++);
        calls.windows.push({ page, spec, opts, win });
        return win;
      },
      createOverlay: (page, spec, opts) => {
        calls.overlays.push({ page, spec, opts });
        return { page };
      },
      focusWindow: (win) => calls.focused.push(win),
      showChangeServer: () => { calls.changeServer += 1; return 'change-server'; },
      uiUrl: (page) => `${FAKE_UI}${page}`,
      changed: () => { calls.changed += 1; },
      log: (text) => calls.log.push(text),
      ...(overrides.pageExists ? { pageExists: overrides.pageExists } : {}),
    });
    return { host, store, handlers, calls };
  }

  function fakeWindow(id) {
    const on = {};
    const contents = {
      id,
      scripts: [],
      executeJavaScript: (code) => { contents.scripts.push(code); return Promise.resolve(); },
      once: (event, fn) => { (on[`contents:${event}`] ??= []).push(fn); },
    };
    return {
      webContents: contents,
      destroyed: false,
      isDestroyed() { return this.destroyed; },
      on: (event, fn) => { (on[event] ??= []).push(fn); },
      close() {
        this.destroyed = true;
        for (const fn of on['contents:destroyed'] ?? []) fn();
        for (const fn of on.closed ?? []) fn();
      },
    };
  }

  const event = (senderId, url, parent = null) => ({ sender: { id: senderId }, senderFrame: { url, parent } });

  test('the shipped shell features are valid', () => {
    const { records, problems } = validateFeatures(SHELL_FEATURES, { platform: 'darwin' });
    expect(problems).toEqual([]);
    expect(records.map((r) => r.id)).toEqual(['console', 'desktopSettings', 'bibwatch']);
    // Galley: V2 (WP17 R3, applied by WP25): the console is filled; the other two are still stubs.
    const consoleRecord = records.find((r) => r.id === 'console');
    expect(consoleRecord.menu.map((m) => [m.where, m.item.id])).toEqual([['view', 'console-toggle'], ['app', 'console-settings']]);
    expect([...consoleRecord.vetoes]).toEqual(['clipboard-read']);
    expect(typeof consoleRecord.start).toBe('function');
    for (const r of records.filter((x) => x.id !== 'console')) {
      expect(r.menu).toEqual([]);
      expect(r.vetoes.size).toBe(0);
      expect(r.start).toBeNull();
    }
    expect(records.find((r) => r.id === 'desktopSettings').settingsPage).toBe(BUILT_IN_SETTINGS_PAGE);
    const { host } = makeHost(SHELL_FEATURES);
    expect(host.settingsPage()).toBe(BUILT_IN_SETTINGS_PAGE);
    expect(host.menuItems('view').map((i) => i.id)).toEqual(['console-toggle']);
    expect(host.vetoed('clipboard-read')).toBe(true);
    expect([...host.partitions()]).toEqual(['laytekz-console']);
    expect(host.cspFor('offline.html')).toBeNull();
  });

  test('invalid parts of a feature are dropped and reported, never thrown', () => {
    const features = [
      { id: 'ok', menu: [
        { where: 'view', item: { id: 'ok-console', label: 'Console', accelerator: 'Control+`' } },
        { where: 'app', item: { id: 'ok-cite', label: 'Cite', accelerator: 'CommandOrControl+Shift+E' } },
        { where: 'app', item: { id: 'ok-settings', label: 'Mine', accelerator: 'CmdOrCtrl+,' } },
        { where: 'file', item: { id: 'settings', label: 'Taken id' } },
        { where: 'file', item: { label: 'No id' } },
        { where: 'dock', item: { id: 'ok-dock', label: 'Nowhere' } },
        { where: 'help', item: { id: 'ok-sub', label: 'Sub', submenu: [{ id: 'ok-sub-1', label: 'One', accelerator: 'Shift+Alt+A' }] } },
      ],
      pages: {
        'good.html': { csp: "default-src 'none'", preload: 'ui.cjs', partition: 'persist:laytekz-ok' },
        'Bad.html': {},
        'remote.html': { partition: 'persist:laytekz' },
        'inject.html': { csp: "default-src 'none'\nscript-src *" },
        'climb.html': { preload: '../evil.cjs' },
      },
      vetoPermissions: ['clipboard-read', 42],
      settingsPage: 'good.html',
      start: 'soon' },
      { id: 'ok' },
      { id: '' },
      { id: 'second', settingsPage: 'other.html', pages: { 'good.html': {} } },
    ];
    const { records, problems } = validateFeatures(features, { platform: 'darwin' });
    expect(records.map((r) => r.id)).toEqual(['ok', 'second']);
    const ok = records[0];
    const menu = Object.fromEntries(ok.menu.map((e) => [e.item.id, e]));
    expect(Object.keys(menu)).toEqual(['ok-console', 'ok-cite', 'ok-settings', 'ok-sub']);
    expect(menu['ok-console'].item.accelerator).toBe('Control+`');
    expect(menu['ok-cite'].item.accelerator).toBeUndefined();
    expect(menu['ok-settings'].item.accelerator).toBeUndefined();
    expect(menu['ok-sub'].item.submenu[0].accelerator).toBeUndefined();
    expect([...ok.pages.keys()]).toEqual(['good.html']);
    expect(ok.pages.get('good.html')).toEqual({ csp: "default-src 'none'", preload: 'ui.cjs', partition: 'persist:laytekz-ok' });
    expect([...ok.vetoes]).toEqual(['clipboard-read']);
    expect(ok.settingsPage).toBe('good.html');
    expect(ok.start).toBeNull();
    expect(records[1].settingsPage).toBeNull();
    expect(records[1].pages.size).toBe(0);
    const text = problems.join('\n');
    for (const pattern of [
      /Mod\+Shift\+E|CommandOrControl\+Shift\+E belongs to the web UI/, /CmdOrCtrl\+, belongs to the app menu/, /Shift\+Alt\+A belongs to the web UI/,
      /menu item id settings is taken/, /needs an id/, /needs where/, /"Bad.html" is not a flat/, /never the server's/, /invalid csp/,
      /preload must be a \.cjs file name/, /42/, /start must be a function/, /listed twice/, /#2 has no valid id/,
      /settingsPage is already set by ok/, /page good.html already belongs to ok/,
    ]) expect(text).toMatch(pattern);
  });

  test('accelerators compare as sets of modifiers per platform; Ctrl+` and Cmd/Ctrl+, are where the plan puts them', () => {
    expect(chordKey('Shift+CommandOrControl+F', 'darwin')).toBe('shift+cmd+f');
    expect(chordKey('CmdOrCtrl+Shift+F', 'win32')).toBe('ctrl+shift+f');
    expect(chordKey('Control+`', 'darwin')).toBe('ctrl+`');
    expect(chordKey('Command+`', 'darwin')).toBe('cmd+`');
    expect(chordKey('CommandOrControl+Plus', 'darwin')).toBe(chordKey('Cmd++', 'darwin'));
    expect(chordKey('Alt+Return', 'win32')).toBe(chordKey('Alt+Enter', 'win32'));
    expect(chordKey('Shift+', 'darwin')).toBeNull();
    expect(chordKey('Hyper+K', 'darwin')).toBeNull();
    for (const platform of ['darwin', 'win32', 'linux']) {
      for (const c of WEB_UI_CHORDS) expect(acceleratorOwner(c, platform), `${c} on ${platform}`).toBe('the web UI');
      expect(acceleratorOwner('Control+`', platform)).toBeNull();
      expect(acceleratorOwner('CommandOrControl+,', platform)).toBe('the app menu');
      expect(acceleratorOwner('CommandOrControl+Shift+Alt+L', platform)).toBeNull();
    }
    // macOS keeps Cmd+` for cycling windows; Ctrl+` (the console) is a different chord there.
    expect(acceleratorOwner('Command+`', 'darwin')).toBe('the app menu');
    expect(acceleratorOwner('Control+`', 'darwin')).toBeNull();
  });

  test('the user-agent token is appended once, with a clean version', () => {
    const base = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140.0 Electron/45.4.1 Safari/537.36';
    expect(withDesktopToken(base, '2.0.0')).toBe(`${base} ${DESKTOP_UA_TOKEN}/2.0.0`);
    expect(withDesktopToken(`${base} Laytekz-Desktop/1.0.0`, '2.0.0')).toBe(`${base} Laytekz-Desktop/2.0.0`);
    expect(withDesktopToken(base, '2.0.0 evil/1')).toBe(`${base} Laytekz-Desktop/0`);
  });

  test('the server knows its desktop-settings address and its project pages', () => {
    const s = new Server('https://example.org/laytekz');
    expect(s.isDesktopSettings('https://example.org/laytekz/settings/desktop-app')).toBe(true);
    expect(s.isDesktopSettings('https://example.org/laytekz/settings/desktop-app?x=1#y')).toBe(true);
    expect(s.isDesktopSettings('https://example.org/laytekz/settings/desktop-app/')).toBe(true);
    expect(s.isDesktopSettings('https://example.org/laytekz/settings/desktop-%61pp')).toBe(true);
    expect(s.isDesktopSettings('https://example.org/laytekz/settings/desktop')).toBe(false);
    expect(s.isDesktopSettings('https://example.org/laytekz/settings/desktop-app/more')).toBe(false);
    expect(s.isDesktopSettings('https://example.org/settings/desktop-app')).toBe(false);
    expect(s.isDesktopSettings('https://elsewhere.example/laytekz/settings/desktop-app')).toBe(false);
    expect(s.projectFromUrl('https://example.org/laytekz/p/abcd1234')).toEqual({ id: 'abcd1234', branch: 'main' });
    expect(s.projectFromUrl('https://example.org/laytekz/p/abcd1234?branch=feature/x')).toEqual({ id: 'abcd1234', branch: 'feature/x' });
    expect(s.projectFromUrl('https://example.org/laytekz/p/abcd1234/settings/editor#editor.font')).toEqual({ id: 'abcd1234', branch: 'main' });
    expect(s.projectFromUrl('https://example.org/laytekz/p/ABCD')).toBeNull();
    expect(s.projectFromUrl('https://example.org/laytekz/p/abcd1234?branch=a..b')).toBeNull();
    expect(s.projectFromUrl('https://example.org/p/abcd1234')).toBeNull();
    expect(s.projectFromUrl('https://example.org/laytekz/')).toBeNull();
    expect(s.projectFromUrl('not a url')).toBeNull();
  });

  test('start and stop: each feature once, in order; stop functions in reverse; a failing start is reported and its parts withdrawn', async () => {
    const order = [];
    let resolveAsync;
    const features = [
      { id: 'a', start: () => { order.push('start a'); return () => order.push('stop a'); } },
      {
        id: 'b',
        menu: [{ where: 'help', item: { id: 'b-help', label: 'B' } }],
        vetoPermissions: ['clipboard-read'],
        pages: { 'b.html': {} },
        settingsPage: 'b.html',
        start: () => { order.push('start b'); throw new Error('b broke'); },
      },
      { id: 'c', start: () => { order.push('start c'); return new Promise((r) => { resolveAsync = r; }); } },
      { id: 'd', menu: [{ where: 'help', item: { id: 'd-help', label: 'D', click: () => { throw new Error('d click'); } } }] },
    ];
    const { host, calls } = makeHost(features);
    expect(host.menuItems('help').map((i) => i.id)).toEqual(['b-help', 'd-help']);
    expect(host.vetoed('clipboard-read')).toBe(true);
    expect(host.settingsPage()).toBe('b.html');
    host.start();
    host.start();
    expect(order).toEqual(['start a', 'start b', 'start c']);
    expect(host.running('b')).toBe(false);
    expect(host.running('a')).toBe(true);
    expect(host.menuItems('help').map((i) => i.id)).toEqual(['d-help']);
    expect(host.vetoed('clipboard-read')).toBe(false);
    expect(host.settingsPage()).toBe(BUILT_IN_SETTINGS_PAGE);
    expect(host.openSettingsPage()).toBe('change-server');
    expect(calls.changed).toBe(1);
    expect(host.problems.join('\n')).toMatch(/Shell feature b stopped: start\(\) threw Error: b broke/);
    // A throwing menu item is logged.
    host.menuItems('help')[0].click();
    expect(calls.log.join('\n')).toMatch(/menu item d-help threw Error: d click/);
    resolveAsync(() => order.push('stop c'));
    await new Promise((r) => setTimeout(r, 0));
    host.stop();
    host.stop();
    expect(order).toEqual(['start a', 'start b', 'start c', 'stop c', 'stop a']);
    expect(host.menuItems('help')).toEqual([]);
  });

  test('ShellCtx: the server, its projects, and settings kept under features.<id>', () => {
    const { host, store } = makeHost([{ id: 'one' }, { id: 'two' }]);
    const one = host.contextOf('one');
    const two = host.contextOf('two');
    expect(one.server()).toBe('https://laytekz.invalid/base');
    expect(one.mainWindow()).toBeNull();
    expect(one.projectFromUrl('https://laytekz.invalid/base/p/abcd1234?branch=x')).toEqual({ id: 'abcd1234', branch: 'x' });
    expect(one.settings.get('height', 0.38)).toBe(0.38);
    one.settings.set('height', 0.5);
    one.settings.set('copies', [{ path: '/tmp/x', at: 1 }]);
    two.settings.set('height', 0.2);
    expect(store.data.features).toEqual({ one: { height: 0.5, copies: [{ path: '/tmp/x', at: 1 }] }, two: { height: 0.2 } });
    const copies = one.settings.get('copies');
    copies.push('mutated');
    expect(one.settings.get('copies')).toHaveLength(1);
    one.settings.set('height', undefined);
    expect(one.settings.get('height', 'gone')).toBe('gone');
    expect(() => one.settings.set('__proto__', 1)).toThrow(/not allowed/);
    expect(() => one.settings.set('fn', () => 1)).toThrow(/JSON/);
    expect(() => one.settings.get('a b')).toThrow(/not allowed/);
  });

  test('sessionFetch: only paths on the server, with the window session cookie and nothing added', async () => {
    const { host, calls } = makeHost([{ id: 'one' }]);
    const one = host.contextOf('one');
    await one.sessionFetch('/api/projects/abcd1234/libraries', { method: 'PUT', body: 'x', headers: { 'content-type': 'text/plain' } });
    expect(calls.fetches).toEqual([{
      url: 'https://laytekz.invalid/base/api/projects/abcd1234/libraries',
      init: { credentials: 'include', cache: 'no-store', method: 'PUT', body: 'x', headers: { 'content-type': 'text/plain' } },
    }]);
    for (const bad of ['https://evil.example/x', '//evil.example/x', 'api/x', '/a\\b', 42]) {
      await expect(one.sessionFetch(bad)).rejects.toThrow(/path on the server/);
    }
    const none = makeHost([{ id: 'one' }], { server: null });
    await expect(none.host.contextOf('one').sessionFetch('/api/x')).rejects.toThrow(/No server/);
  });

  test('IPC: a channel answers only the top frame of a page the host opened for that feature', async () => {
    const features = [
      { id: 'one', pages: { 'one.html': { preload: 'ui.cjs' }, 'two.html': {} } },
      { id: 'other', pages: { 'other.html': {} } },
    ];
    const { host, handlers, calls } = makeHost(features);
    const one = host.contextOf('one');
    expect(() => one.ipc.handle('one:echo', () => 1, { pages: ['other.html'] })).toThrow(/has no page/);
    expect(() => one.ipc.handle('ui:secret', () => 1, { pages: ['one.html'] })).toThrow(/shared bridge/);
    expect(() => one.ipc.handle('Bad Channel', () => 1, { pages: ['one.html'] })).toThrow(/not allowed/);
    expect(() => one.ipc.handle('one:echo', () => 1, {})).toThrow(/pages/);
    const remove = one.ipc.handle('one:echo', (_e, value) => `echo ${value}`, { pages: ['one.html'] });
    one.ipc.handle('ui:get-state', () => ({ from: 'one' }), { pages: ['one.html'] });
    expect([...handlers.keys()]).toEqual(['one:echo']);
    expect(() => one.ipc.handle('one:echo', () => 2, { pages: ['one.html'] })).toThrow(/already served/);

    const win = one.openLocalWindow('one.html', { title: 'One', width: 400, height: 300, hash: 'server', webPreferences: { nodeIntegration: true } });
    expect(calls.windows[0].opts).toEqual({ title: 'One', width: 400, height: 300, hash: 'server' });
    expect(one.openLocalWindow('one.html', { hash: 'zoom' })).toBe(win);
    expect(calls.focused).toEqual([win]);
    expect(win.webContents.scripts).toEqual(['location.hash = "#zoom"']);
    const other = one.openLocalWindow('two.html');
    const id = win.webContents.id;
    const invoke = (e, ...args) => handlers.get('one:echo')(e, ...args);

    expect(await invoke(event(id, `${FAKE_UI}one.html`), 'hi')).toBe('echo hi');
    expect(await invoke(event(id, `${FAKE_UI}one.html#server`), 'hash')).toBe('echo hash');
    expect(await invoke(event(id, `${FAKE_UI}one.html`, { url: 'x' }), 'sub')).toBeNull();
    expect(await invoke(event(id, `${FAKE_UI}two.html`), 'moved')).toBeNull();
    expect(await invoke(event(id, `${FAKE_UI}one.html?x=1`), 'query')).toBeNull();
    expect(await invoke(event(other.webContents.id, `${FAKE_UI}two.html`), 'page')).toBeNull();
    expect(await invoke(event(999, `${FAKE_UI}one.html`), 'stranger')).toBeNull();
    expect(await invoke({ sender: { id }, senderFrame: null }, 'gone')).toBeNull();
    expect(host.dispatch('ui:get-state', event(id, `${FAKE_UI}one.html`), [])).toEqual({ from: 'one' });
    expect(host.dispatch('ui:get-state', event(other.webContents.id, `${FAKE_UI}two.html`), [])).toBeNull();

    // A closed window's contents never answer again, even if the id came back.
    win.close();
    expect(await invoke(event(id, `${FAKE_UI}one.html`), 'closed')).toBeNull();
    const again = one.openLocalWindow('one.html');
    expect(again).not.toBe(win);
    remove();
    remove();
    expect(handlers.has('one:echo')).toBe(false);
    one.ipc.handle('one:echo', () => 'back', { pages: ['one.html'] });
    host.stop();
    expect(handlers.size).toBe(0);
  });

  test('overlays and the settings page go through the host', () => {
    const features = [
      { id: 'settingsFeature', settingsPage: 'desktop-settings.html', pages: { 'desktop-settings.html': { preload: 'ui.cjs' } } },
      { id: 'panel', pages: { 'panel.html': { partition: 'laytekz-panel' } } },
    ];
    const { host, calls } = makeHost(features, { mainWindow: { isDestroyed: () => false } });
    expect([...host.partitions()]).toEqual(['laytekz-panel']);
    const handle = host.contextOf('panel').overlay('panel.html', { bounds: () => ({ x: 0, y: 0, width: 1, height: 1 }), background: '#000000' });
    expect(handle).toEqual({ page: 'panel.html' });
    expect(calls.overlays[0].spec).toEqual({ partition: 'laytekz-panel' });
    expect(typeof calls.overlays[0].opts.onContents).toBe('function');
    expect(() => host.contextOf('panel').overlay('missing.html')).toThrow(/has no page/);
    const win = host.openSettingsPage({ hash: 'server' });
    expect(calls.windows.at(-1)).toMatchObject({ page: 'desktop-settings.html', opts: { hash: 'server', parent: true } });
    expect(host.openSettingsPage({ fromPage: true })).toBe(win);
    expect(host.openSettingsPage({ fromPage: true })).toBeNull();
    expect(calls.changeServer).toBe(0);
    const noWindow = makeHost(features);
    expect(() => noWindow.host.contextOf('panel').overlay('panel.html')).toThrow(/no main window/);
  });
});
