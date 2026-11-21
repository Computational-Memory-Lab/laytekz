// The console: a terminal in the desktop app (feature 5). WP17 built the
// terminal; WP25 added the agent buttons (agents.js, tokens.js).
//
// View → Console (Ctrl+`) opens a panel over the bottom of the main window,
// with one shell per tab, running in the user's home folder. The panel can
// pop out into its own window and dock again. The shells run in a utility
// process (pty-host.js) that starts with the first tab, so nothing runs until
// the console is opened. Laytekz → Console Settings… has the off switch.
//
// The console page lives in its own in-memory partition (laytekz-console),
// with no network and its own preload (src/preload/console.cjs); the remote
// page cannot reach or detect it. Everything here reaches Electron through
// the ShellCtx, plus a dynamic import in start(), so this file loads in plain
// Node (the feature list's unit tests).

import { createPanel } from './console-panel.js';
import { createSessions } from './console-sessions.js';
import { installBridge } from './console-bridge.js';
import { checkSetting, CONSOLE_DEFAULTS, quitQuestion, readSettings } from './shell-env.js';
// Galley: V2 (WP25): ▶ Claude Code / ▶ Codex.
import { createAgents, installAgentBridge } from './agents.js';
import { createTokenStore } from './tokens.js';

// xterm.js (5.1 and later) adds <style> elements, so the console page alone
// allows inline styles. Scripts stay 'self'; no network of any kind.
export const CONSOLE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const PAGE = { partition: 'laytekz-console', preload: 'console.cjs' };

let running = null;

/** @type {import('../index.js').ShellFeature} */
const consoleFeature = {
  id: 'console',
  pages: {
    'console.html': { ...PAGE, csp: CONSOLE_CSP },
    'console-settings.html': { ...PAGE },
  },
  menu: [
    // Galley: V2 (WP25, from WP17's R1): hidden while the console is turned off, also after a menu rebuild.
    { where: 'view', item: { id: 'console-toggle', label: 'Console', accelerator: 'Control+`', visible: () => running?.enabled() ?? true, click: () => running?.toggle() } },
    { where: 'app', item: { id: 'console-settings', label: 'Console Settings…', click: () => running?.openSettingsWindow() } },
  ],
  // The remote page never reads the clipboard: what a shell printed may be on it.
  vetoPermissions: ['clipboard-read'],
  start: (ctx) => startConsole(ctx),
};

async function startConsole(ctx) {
  const electron = await import('electron');
  const { app, dialog, Menu, shell, utilityProcess, BrowserWindow, clipboard, safeStorage } = electron;
  const { test } = await import('../../env.js');

  const settings = () => readSettings((key) => ctx.settings.get(key));
  let attached = null;

  const send = (channel, ...args) => {
    if (attached && !attached.isDestroyed()) attached.send(channel, ...args);
  };

  const sessions = createSessions({
    fork: (modulePath, args, opts) => utilityProcess.fork(modulePath, args, opts),
    settings,
    send,
    attached: () => !!attached && !attached.isDestroyed(),
  });

  const panel = createPanel({
    ctx,
    settings,
    saveSetting: (key, value) => ctx.settings.set(key, value),
    detached: (contents) => {
      if (contents === attached) {
        attached = null;
        sessions.resetFlow();
      }
    },
  });

  function attach(contents) {
    if (attached === contents) return;
    attached = contents;
    sessions.resetFlow();
    contents.once('destroyed', () => {
      if (attached === contents) {
        attached = null;
        sessions.resetFlow();
      }
    });
  }

  function openSettingsWindow() {
    ctx.openLocalWindow('console-settings.html', { title: 'Laytekz – Console Settings', width: 520, height: 420, minWidth: 420, minHeight: 320 });
  }

  function menuItem() {
    try {
      return Menu.getApplicationMenu()?.getMenuItemById('console-toggle') ?? null;
    } catch {
      return null;
    }
  }

  function applyEnabled() {
    const on = settings().enabled;
    const item = menuItem();
    if (item) item.visible = on;
    if (!on) {
      panel.destroy();
      sessions.stopAll();
    }
  }

  function setSetting(key, value) {
    const checked = checkSetting(key, value);
    if (checked === null) return settings();
    if (checked === CONSOLE_DEFAULTS[key]) ctx.settings.set(key, undefined);
    else ctx.settings.set(key, checked);
    const next = settings();
    if (key === 'enabled') applyEnabled();
    send('console:settings', next);
    return next;
  }

  const disposeBridge = installBridge({
    ctx,
    sessions,
    panel,
    settings,
    setSetting,
    openSettingsWindow,
    openExternal: (url) => {
      if (test.enabled) {
        // The test mode records instead of opening a browser (env.js recordFile).
        import('node:fs').then((fs) => fs.appendFileSync(test.recordFile, `${JSON.stringify({ url, from: 'console' })}\n`)).catch(() => {});
      } else {
        shell.openExternal(url).catch(() => {});
      }
    },
    attach,
    platform: process.platform,
  });

  // Galley: V2 (WP25): the agent buttons (agents.js) and their tokens (tokens.js).
  const agents = createAgents({
    ctx,
    sessions,
    tokens: createTokenStore({ settings: ctx.settings, sessionFetch: ctx.sessionFetch, safeStorage }),
    userData: app.getPath('userData'),
    enabled: () => settings().agents,
    copy: (text) => clipboard.writeText(text),
    confirm: (question) => confirmAgent(question),
    // Tests run fake agents from one folder, never the real ones (from source only).
    testBinDir: test.enabled && !app.isPackaged && process.env.LAYTEKZ_TEST_AGENT_BIN ? process.env.LAYTEKZ_TEST_AGENT_BIN : null,
  });
  const disposeAgents = installAgentBridge({ ctx, agents });

  async function confirmAgent(question) {
    if (test.enabled) {
      // Test mode never shows a dialog: it records the question and answers from the environment.
      const fs = await import('node:fs');
      fs.appendFileSync(`${test.userData}/agent-consent.jsonl`, `${JSON.stringify(question)}\n`);
      const answer = app.isPackaged ? 'allow' : (process.env.LAYTEKZ_TEST_AGENT_CONSENT || 'allow');
      return { allow: answer !== 'cancel', always: answer === 'always' };
    }
    const win = BrowserWindow.getFocusedWindow() ?? ctx.mainWindow();
    const options = {
      type: 'question',
      message: question.message,
      detail: question.detail,
      buttons: ['Allow', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      checkboxLabel: question.checkbox,
      checkboxChecked: false,
    };
    const { response, checkboxChecked } = await (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));
    return { allow: response === 0, always: response === 0 && checkboxChecked };
  }

  // Quitting while a command runs in a tab asks first.
  let confirmedAt = 0;
  const onBeforeQuit = (event) => {
    if (Date.now() - confirmedAt < 5000) return;
    const question = quitQuestion(sessions.running());
    if (!question) return;
    let quit;
    if (test.enabled) {
      // Test mode never shows a dialog: it records the question and answers from the environment.
      import('node:fs').then((fs) => fs.appendFileSync(`${test.userData}/console-quit.jsonl`, `${JSON.stringify(question)}\n`)).catch(() => {});
      quit = process.env.LAYTEKZ_TEST_CONSOLE_QUIT !== 'cancel' || app.isPackaged;
    } else {
      const win = BrowserWindow.getFocusedWindow() ?? ctx.mainWindow();
      const options = {
        type: 'warning',
        message: question.message,
        detail: question.detail,
        buttons: ['Quit', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
      };
      quit = (win ? dialog.showMessageBoxSync(win, options) : dialog.showMessageBoxSync(options)) === 0;
    }
    if (quit) confirmedAt = Date.now();
    else event.preventDefault();
  };
  app.on('before-quit', onBeforeQuit);

  running = {
    enabled: () => settings().enabled,
    toggle: () => {
      if (!settings().enabled) return;
      panel.toggle();
    },
    openSettingsWindow,
  };
  applyEnabled();

  return () => {
    running = null;
    app.removeListener('before-quit', onBeforeQuit);
    disposeBridge();
    disposeAgents();
    panel.destroy();
    sessions.stop();
  };
}

export default consoleFeature;
