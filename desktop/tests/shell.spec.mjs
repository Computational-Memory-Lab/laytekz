// Change server, the menu, About, window state and the single-instance lock.

import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  APP_DIR, cleanEnv, launchApp, overlayClick, overlayText, pageReady, tempDir, until,
} from './helpers.mjs';
import { startMockServer } from './mock-server.mjs';

const electronBinary = createRequire(import.meta.url)('electron');

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

test('Change server is reachable from the offline page', async () => {
  const mock = await startMockServer();
  await mock.stop();
  const ctx = await launchApp({ serverUrl: mock.url, env: { LAYTEKZ_TEST_RETRY_MS: '20000' }, waitForPage: false });
  try {
    await until(() => overlayText(ctx.app, 'offline.html'), { message: 'the offline page' });
    const dialogPromise = ctx.app.waitForEvent('window', (p) => p.url().includes('change-server.html'));
    await overlayClick(ctx.app, 'offline.html', 'offline-change-server');
    const dialog = await dialogPromise;
    await dialog.waitForSelector('[data-testid="server-url"]');
    await dialog.evaluate(() => document.querySelector('[data-testid="server-cancel"]').click());
  } finally {
    await ctx.close();
  }
});

test('the menu has About, Change server and Help, and no accelerator shadows the web UI', async () => {
  const mock = await startMockServer();
  const ctx = await launchApp({ serverUrl: mock.url });
  try {
    await pageReady(ctx.page);
    const items = await ctx.app.evaluate(({ Menu }) => {
      const out = [];
      const walk = (menu, top) => {
        for (const item of menu.items) {
          out.push({ id: item.id, label: item.label, role: item.role, accelerator: item.accelerator ?? null, top });
          if (item.submenu) walk(item.submenu, top ?? item.label);
        }
      };
      walk(Menu.getApplicationMenu(), null);
      return out;
    });
    const ids = items.map((i) => i.id);
    for (const id of ['about', 'change-server', 'help-site', 'help-source', 'help-privacy', 'reload']) expect(ids).toContain(id);
    const roles = items.map((i) => i.role).filter(Boolean);
    for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectall', 'zoomin', 'zoomout', 'resetzoom', 'togglefullscreen', 'toggledevtools']) {
      expect(roles).toContain(role);
    }
    // The product name wherever the menu shows one (macOS fills role labels from app.name).
    const labels = items.map((i) => i.label);
    for (const label of ['About Laytekz', 'Laytekz Website']) expect(labels).toContain(label);
    if (process.platform === 'darwin') {
      for (const label of ['Laytekz', 'Hide Laytekz', 'Quit Laytekz']) expect(labels).toContain(label);
    }

    // Chords the web UI binds (src/util/shortcuts.ts and the editor keymaps in the server repo).
    // Compared as sets of modifiers plus a key, so 'Shift+CommandOrControl+F' and
    // 'CmdOrCtrl+Shift+F' are the same chord.
    const chord = (accel) => {
      const parts = accel.toLowerCase().split('+');
      const key = parts.pop() || '+';
      const mods = parts.map((m) => ({ cmdorctrl: 'commandorcontrol', command: 'commandorcontrol', cmd: 'commandorcontrol', ctrl: 'commandorcontrol', control: 'commandorcontrol', option: 'alt' }[m] ?? m)).sort();
      return [...mods, key].join('+');
    };
    const taken = ['S', 'K', 'J', 'F', 'G', 'D', 'B', 'I', '/', '[', ']', 'Enter', 'Shift+M', 'Shift+F', 'Shift+K', 'Shift+G', 'Alt+G', 'Shift+Alt+F']
      .map((k) => chord(`CommandOrControl+${k}`));
    expect(chord('Shift+CommandOrControl+F')).toBe(chord('CmdOrCtrl+Shift+F'));
    const explicit = items.map((i) => i.accelerator).filter(Boolean).map(chord);
    for (const accel of explicit) expect(taken).not.toContain(accel);
    expect(explicit).not.toContain(chord('Shift+Alt+F'));

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
