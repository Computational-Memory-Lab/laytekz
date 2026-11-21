// The console (V2, WP17): the shell environment and settings in plain Node,
// then the terminal in the app: Ctrl+` (View → Console) opens the docked
// panel, a command runs and prints, resizing reaches the shell, pop-out and
// dock keep the tabs, the page has no network, the remote page sees nothing,
// the quit guard asks while a command runs, and the off switch works.

import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateFeatures } from '../src/main/features/host.js';
import consoleFeature, { CONSOLE_CSP } from '../src/main/features/console/index.js';
import {
  CONSOLE_DEFAULTS, checkSetting, defaultShell, linkAllowed, quitQuestion, readSettings, runningCommands,
  shellEnv, splitCommand,
} from '../src/main/features/console/shell-env.js';
import { clickMenuItem, launchApp, menuItems, until } from './helpers.mjs';
import { startMockServer } from './mock-server.mjs';

const CONSOLE_URL = 'laytekz-ui://app/console.html';

// ------------------------------------------------------------ plain Node

test.describe('console logic (no Electron)', () => {
  test('the shell environment drops what would change how Electron or Node start', () => {
    const env = shellEnv({
      PATH: '/usr/bin', HOME: '/Users/x', ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1', NODE_OPTIONS: '--inspect',
      CHROME_DESKTOP: 'x', GOOGLE_API_KEY: 'k', LAYTEKZ_TEST_MODE: '1', LANG: 'fr_CA.UTF-8',
    });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/Users/x');
    for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR', 'NODE_OPTIONS', 'CHROME_DESKTOP', 'GOOGLE_API_KEY', 'LAYTEKZ_TEST_MODE']) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.TERM).toBe('xterm-256color');
    expect(env.COLORTERM).toBe('truecolor');
    expect(env.TERM_PROGRAM).toBe('Laytekz');
    expect(env.LANG).toBe('fr_CA.UTF-8');
    if (process.platform !== 'win32') expect(shellEnv({}).LANG).toBe('en_US.UTF-8');
  });

  test('the shell: the login shell by default, or the setting split on spaces and double quotes', () => {
    expect(defaultShell({ platform: 'darwin', env: { SHELL: '/opt/homebrew/bin/fish' } })).toEqual({ file: '/opt/homebrew/bin/fish', args: ['-l'], name: 'fish' });
    expect(defaultShell({ platform: 'darwin', env: {} })).toEqual({ file: '/bin/zsh', args: ['-l'], name: 'zsh' });
    expect(defaultShell({ platform: 'linux', env: { SHELL: 'relative/sh' } }).file).toBe('/bin/bash');
    expect(defaultShell({ platform: 'win32', env: {}, exists: () => false }).name).toBe('powershell.exe');
    expect(defaultShell({ platform: 'darwin', setting: '/bin/bash --norc' })).toEqual({ file: '/bin/bash', args: ['--norc'], name: 'bash' });
    expect(splitCommand('"/Applications/My Shell/bin/sh" -i  -x')).toEqual(['/Applications/My Shell/bin/sh', '-i', '-x']);
    expect(splitCommand('   ')).toEqual([]);
  });

  test('settings are checked; stored junk falls back to the defaults', () => {
    expect(checkSetting('enabled', false)).toBe(false);
    expect(checkSetting('enabled', 'no')).toBeNull();
    expect(checkSetting('fontSize', 7)).toBeNull();
    expect(checkSetting('fontSize', 14)).toBe(14);
    expect(checkSetting('scrollback', 1.5)).toBeNull();
    expect(checkSetting('cursorStyle', 'bar')).toBe('bar');
    expect(checkSetting('shell', 'a\nb')).toBeNull();
    expect(checkSetting('panelHeight', 0.99)).toBe(0.75);
    expect(checkSetting('panelHeight', 0.01)).toBe(0.2);
    expect(checkSetting('unknown', 1)).toBeNull();
    const stored = { enabled: 'yes', fontSize: 15, scrollback: -1 };
    expect(readSettings((k) => stored[k])).toEqual({ ...CONSOLE_DEFAULTS, fontSize: 15 });
    expect(readSettings(() => { throw new Error('broken'); })).toEqual({ ...CONSOLE_DEFAULTS });
  });

  test('the quit question names the commands running in the foreground', () => {
    const sessions = [
      { shellName: 'zsh', process: 'zsh' },
      { shellName: 'zsh', process: 'latexmk' },
      { shellName: 'bash', process: '-bash' },
      { shellName: 'zsh', process: 'sleep', exited: true },
      { shellName: 'zsh', process: 'claude' },
    ];
    expect(runningCommands(sessions)).toEqual(['latexmk', 'claude']);
    expect(quitQuestion([])).toBeNull();
    expect(quitQuestion(['sleep']).message).toBe('A command is still running in the console (sleep).');
    expect(quitQuestion(['latexmk', 'claude']).message).toBe('2 commands are still running in the console (latexmk, claude).');
  });

  test('only web links open from the terminal', () => {
    expect(linkAllowed('https://example.org/a')).toBe(true);
    expect(linkAllowed('http://localhost:3000')).toBe(true);
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'laytekz-ui://app/console.html', 'https://u:p@example.org', 'not a url']) {
      expect(linkAllowed(bad)).toBe(false);
    }
  });

  test('the feature passes the shell host: its pages, Ctrl+` and the clipboard veto', () => {
    const { records, problems } = validateFeatures([consoleFeature], { platform: 'darwin' });
    expect(problems).toEqual([]);
    const [r] = records;
    expect(r.menu.find((m) => m.item.id === 'console-toggle')).toMatchObject({ where: 'view', item: { accelerator: 'Control+`' } });
    expect(validateFeatures([consoleFeature], { platform: 'win32' }).problems).toEqual([]);
    expect(r.pages.get('console.html')).toEqual({ partition: 'laytekz-console', preload: 'console.cjs', csp: CONSOLE_CSP });
    expect(r.pages.get('console-settings.html')).toEqual({ partition: 'laytekz-console', preload: 'console.cjs' });
    expect([...r.vetoes]).toEqual(['clipboard-read']);
    expect(CONSOLE_CSP).toContain("connect-src 'none'");
    expect(CONSOLE_CSP).toContain("script-src 'self';");
  });
});

// ---------------------------------------------------------------- in the app

/** Runs `code` in the console page (docked or popped out); null when there is none. */
async function inConsole(app, code) {
  return app.evaluate(async ({ BrowserWindow }, [url, js]) => {
    for (const win of BrowserWindow.getAllWindows()) {
      const pages = [win.webContents, ...win.contentView.children.map((v) => v.webContents)];
      for (const wc of pages) {
        if (wc && !wc.isDestroyed() && wc.getURL().split('#')[0] === url) return wc.executeJavaScript(js);
      }
    }
    return null;
  }, [CONSOLE_URL, code]);
}

/** Where the console page is: {where: 'dock'|'window'|null, bounds, content: [w, h], partitionOk}. */
async function consoleState(app) {
  return app.evaluate(({ BrowserWindow, session }, url) => {
    const consoleSession = session.fromPartition('laytekz-console');
    for (const win of BrowserWindow.getAllWindows()) {
      for (const view of win.contentView.children) {
        const wc = view.webContents;
        if (wc && !wc.isDestroyed() && wc.getURL() === url) {
          return { where: 'dock', bounds: view.getBounds(), content: win.getContentSize(), partitionOk: wc.session === consoleSession };
        }
      }
      if (win.webContents.getURL().split('#')[0] === url) {
        return { where: 'window', bounds: null, content: win.getContentSize(), partitionOk: win.webContents.session === consoleSession };
      }
    }
    return { where: null };
  }, CONSOLE_URL);
}

const screenText = (app) => inConsole(app, `(() => {
  const el = document.querySelector('[data-testid="console-terminal"]:not([hidden]) .xterm-rows');
  return el ? el.innerText : '';
})()`);

const type = (app, text) => inConsole(app, `(async () => {
  const tab = document.querySelector('[data-testid="console-tab"][aria-selected="true"]');
  return window.laytekzConsole.input(tab.dataset.session, ${JSON.stringify(text)});
})()`);

async function waitForText(app, pattern, timeout = 15_000) {
  return until(async () => {
    const text = await screenText(app);
    return text && pattern.test(text) ? text : null;
  }, { timeout, message: `console text ${pattern}` });
}

async function openConsole(app) {
  await clickMenuItem(app, 'console-toggle');
  await until(async () => (await inConsole(app, 'document.body.dataset.ready')) === '1', { message: 'the console page' });
  await until(async () => (await inConsole(app, 'document.querySelectorAll(".xterm-rows").length')) > 0, { message: 'a terminal' });
}

test.describe('console in the app', () => {
  let mock;
  test.beforeAll(async () => {
    mock = await startMockServer();
  });
  test.afterAll(async () => {
    await mock?.stop();
  });

  test('Ctrl+` opens the docked console; a command prints; resize, pop-out and dock keep the tab', async () => {
    test.setTimeout(120_000);
    const ctx = await launchApp({ serverUrl: mock.url });
    try {
      const items = await menuItems(ctx.app);
      expect(items.find((i) => i.id === 'console-toggle')).toMatchObject({ label: 'Console', accelerator: 'Control+`', visible: true });
      expect(items.find((i) => i.id === 'console-settings')).toMatchObject({ label: 'Console Settings…' });
      expect(await consoleState(ctx.app)).toEqual({ where: null });

      await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1100, 760));
      await openConsole(ctx.app);
      const docked = await consoleState(ctx.app);
      expect(docked.where).toBe('dock');
      expect(docked.partitionOk).toBe(true);
      const [w, h] = docked.content;
      expect(docked.bounds.width).toBe(w);
      expect(docked.bounds.y + docked.bounds.height).toBe(h);
      expect(docked.bounds.height).toBe(Math.round(h * 0.38));

      await type(ctx.app, 'echo laytekz-$((6*7))\r');
      await waitForText(ctx.app, /laytekz-42/);

      // The remote page sees neither bridge.
      expect(await ctx.page.evaluate(() => [typeof window.laytekz, typeof window.laytekzConsole])).toEqual(['undefined', 'undefined']);
      // The console page has no network at all.
      expect(await inConsole(ctx.app, `fetch(${JSON.stringify(mock.url)}).then(() => 'reached', () => 'blocked')`)).toBe('blocked');

      // Resizing the window reflows the terminal, and the shell sees the new size.
      await type(ctx.app, 'clear; stty size\r');
      const before = (await waitForText(ctx.app, /^\d+ \d+$/m)).match(/^(\d+) (\d+)$/m);
      await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 900));
      await until(async () => (await consoleState(ctx.app)).bounds?.width === 1400, { message: 'the panel follows the window' });
      await new Promise((r) => setTimeout(r, 400));
      await type(ctx.app, 'clear; stty size\r');
      const after = await until(async () => {
        const m = (await screenText(ctx.app)).match(/^(\d+) (\d+)$/m);
        return m && m[0] !== before[0] ? m : null;
      }, { message: 'a new stty size' });
      expect(Number(after[2])).toBeGreaterThan(Number(before[2]));
      expect(Number(after[1])).toBeGreaterThan(Number(before[1]));

      // Pop out: the panel leaves the main window, a window shows the same tab with its output.
      await type(ctx.app, 'echo popped-$((2+3))\r');
      await waitForText(ctx.app, /popped-5/);
      await inConsole(ctx.app, `document.querySelector('[data-testid="console-popout"]').click()`);
      await until(async () => (await consoleState(ctx.app)).where === 'window', { message: 'the pop-out window' });
      await until(async () => (await inConsole(ctx.app, 'document.body.dataset.ready')) === '1', { message: 'the popped-out page' });
      expect(await inConsole(ctx.app, 'document.querySelectorAll("[data-testid=console-tab]").length')).toBe(1);
      await waitForText(ctx.app, /popped-5/);
      await type(ctx.app, 'echo still-$((10*10))\r');
      await waitForText(ctx.app, /still-100/);

      // Dock: back over the main window, same tab.
      await inConsole(ctx.app, `document.querySelector('[data-testid="console-dock"]').click()`);
      await until(async () => (await consoleState(ctx.app)).where === 'dock', { message: 'docked again' });
      await until(async () => (await inConsole(ctx.app, 'document.body.dataset.ready')) === '1', { message: 'the docked page' });
      await waitForText(ctx.app, /still-100/);

      // Hide (the × button; Ctrl+` does the same while the console has focus,
      // which a hidden test window never gets); the shell keeps running.
      await inConsole(ctx.app, `document.querySelector('[data-testid="console-hide"]').click()`);
      await until(async () => (await consoleState(ctx.app)).where === null, { message: 'the panel hidden' });
      await clickMenuItem(ctx.app, 'console-toggle');
      await until(async () => (await consoleState(ctx.app)).where === 'dock', { message: 'the panel shown again' });
      await type(ctx.app, 'echo back-$((7*6))\r');
      await waitForText(ctx.app, /back-42/);
    } finally {
      await ctx.close();
    }
  });

  test('quitting while a command runs asks first; the off switch closes the console and hides its menu item', async () => {
    test.setTimeout(90_000);
    const ctx = await launchApp({ serverUrl: mock.url, env: { LAYTEKZ_TEST_CONSOLE_QUIT: 'cancel' } });
    try {
      await openConsole(ctx.app);
      await type(ctx.app, 'echo ready-$((1+1)); sleep 30\r');
      await waitForText(ctx.app, /ready-2/);
      // The pty host reports the foreground process about once a second.
      await new Promise((r) => setTimeout(r, 1500));
      await ctx.app.evaluate(({ app }) => { app.quit(); });
      const asked = await until(async () => {
        try {
          return await fs.readFile(path.join(ctx.dir, 'console-quit.jsonl'), 'utf8');
        } catch {
          return null;
        }
      }, { message: 'the quit question' });
      expect(JSON.parse(asked.trim().split('\n')[0]).message).toBe('A command is still running in the console (sleep).');
      // Cancelled: the app and the console are still there.
      expect(await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBeGreaterThan(0);
      expect((await consoleState(ctx.app)).where).toBe('dock');

      // The off switch, from Console Settings…
      const settingsPromise = ctx.app.waitForEvent('window', (p) => p.url().includes('console-settings.html'));
      await clickMenuItem(ctx.app, 'console-settings');
      const settings = await settingsPromise;
      await settings.waitForSelector('body[data-ready="1"]');
      expect(await settings.isChecked('[data-testid="console-setting-enabled"]')).toBe(true);
      expect(await settings.evaluate(() => fetch('https://example.org').then(() => 'reached', () => 'blocked'))).toBe('blocked');
      await settings.uncheck('[data-testid="console-setting-enabled"]');
      await until(async () => (await consoleState(ctx.app)).where === null, { message: 'the console closed' });
      const item = (await menuItems(ctx.app)).find((i) => i.id === 'console-toggle');
      expect(item.visible).toBe(false);
      const saved = JSON.parse(await fs.readFile(path.join(ctx.dir, 'settings.json'), 'utf8'));
      expect(saved.features.console.enabled).toBe(false);
      // Ctrl+` does nothing while it is off.
      await clickMenuItem(ctx.app, 'console-toggle');
      await new Promise((r) => setTimeout(r, 500));
      expect((await consoleState(ctx.app)).where).toBe(null);
      // On again: the default is not stored.
      await settings.check('[data-testid="console-setting-enabled"]');
      await until(async () => (await menuItems(ctx.app)).find((i) => i.id === 'console-toggle')?.visible, { message: 'the menu item back' });
      const again = JSON.parse(await fs.readFile(path.join(ctx.dir, 'settings.json'), 'utf8'));
      expect(again.features.console.enabled).toBeUndefined();
    } finally {
      await ctx.app.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await ctx.close();
    }
  });
});
