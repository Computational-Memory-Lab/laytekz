// Where windows may go.
//
// App windows (the main window and same-origin popups) stay on the Laytekz
// server. Its sign-in link starts the system-browser handoff; any other web
// address opens in the system browser. A redirect chain that starts at the
// server's /api/ and leaves the origin is an integration's OAuth round trip
// (GitHub, GitLab, ...): it runs in a separate hardened auth window that
// shares the session and closes once the chain comes back to the server.

import { BrowserWindow } from 'electron';
import { test } from './env.js';
import { externalUrl, openFromPage } from './external.js';
import { isLoopbackHost } from './server.js';
import { remoteWebPreferences } from './hardening.js';

const isWeb = (raw) => /^https?:\/\//i.test(raw ?? '');

/** At most this many app windows at once: a page cannot open windows without end. */
export const MAX_APP_WINDOWS = 10;
const appWindows = new Set();

/**
 * ctx = {
 *   server(): Server,
 *   signIn(provider): void,
 *   mainWindow(): BrowserWindow | null,
 *   childOptions(): BrowserWindowConstructorOptions,   // for same-origin popups
 *   decorate(win): void,                                // context menu and unload guard for popups
 * }
 */
export function applyAppPolicy(win, ctx) {
  const contents = win.webContents;
  let chainStart = null;
  appWindows.add(win);
  win.on('closed', () => appWindows.delete(win));

  contents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) chainStart = details.url;
  });

  contents.on('will-navigate', (event) => {
    if (decide(ctx, event.url, null, win) !== 'allow') event.preventDefault();
  });

  contents.on('will-redirect', (event) => {
    if (event.isMainFrame === false) return;
    if (decide(ctx, event.url, chainStart, win) !== 'allow') event.preventDefault();
  });

  contents.setWindowOpenHandler(({ url }) => {
    const server = ctx.server();
    const provider = server.signInProvider(url);
    if (provider) {
      ctx.signIn(provider);
      return { action: 'deny' };
    }
    if (server.owns(url)) {
      if (appWindows.size >= MAX_APP_WINDOWS) return { action: 'deny' };
      return {
        action: 'allow',
        // A project in its own window keeps its unsynced-edits prompt when the main window closes.
        outlivesOpener: true,
        // Built from a fixed option set: the page's window.open features (frameless,
        // always on top, not closable, off screen, ...) never reach the window.
        createWindow: (options) => {
          const child = new BrowserWindow({ ...ctx.childOptions(), webContents: options.webContents });
          applyAppPolicy(child, ctx);
          ctx.decorate(child);
          return child.webContents;
        },
      };
    }
    openFromPage(url, win);
    return { action: 'deny' };
  });
}

/** 'allow', or 'handled' / 'blocked' (both cancel the navigation). */
function decide(ctx, url, chainStart, win) {
  const server = ctx.server();
  const provider = server.signInProvider(url)
    ?? (chainStart && !server.owns(url) ? server.signInProvider(chainStart) : null);
  if (provider) {
    ctx.signIn(provider);
    return 'handled';
  }
  if (server.owns(url)) return 'allow';
  if (chainStart && server.isApi(chainStart) && isWeb(url)) {
    // Sign-in chains (<base>/api/auth/...) never run embedded: the provider's
    // page belongs in the system browser, which only the handoff opens.
    if (server.isAuthApi(chainStart)) return 'blocked';
    openAuthWindow(ctx, chainStart, win);
    return 'handled';
  }
  if (externalUrl(url)) {
    openFromPage(url, win);
    return 'handled';
  }
  return 'blocked';
}

/** Load a server URL in an app window; the sign-in link still goes to the system browser. */
export function loadInWindow(ctx, win, url) {
  const provider = ctx.server().signInProvider(url);
  if (provider) {
    ctx.signIn(provider);
    return;
  }
  win.loadURL(url).catch(() => {
    // did-fail-load reports real failures; a cancelled navigation is not one
  });
}

/** https, or plain http on this computer only. */
function secureEnough(url) {
  return url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname));
}

function openAuthWindow(ctx, startUrl, owner) {
  // A popup whose first navigation was the round trip has nothing to return to.
  let returnTo = owner;
  const ownerUrl = owner.webContents.getURL();
  if (!ownerUrl || ownerUrl === 'about:blank') {
    returnTo = ctx.mainWindow();
    owner.close();
  }
  const main = ctx.mainWindow();
  const win = new BrowserWindow({
    width: 900,
    height: 760,
    minWidth: 480,
    minHeight: 480,
    parent: main && !main.isDestroyed() ? main : undefined,
    show: false,
    title: 'Connecting…',
    autoHideMenuBar: true,
    webPreferences: remoteWebPreferences(),
  });

  const label = () => {
    try {
      return new URL(win.webContents.getURL()).host;
    } catch {
      return '';
    }
  };
  // The title always names the site being shown, not what the page claims.
  win.on('page-title-updated', (event) => event.preventDefault());
  win.webContents.on('did-navigate', () => win.setTitle(`Laytekz – ${label()}`));

  const back = (url) => {
    if (!win.isDestroyed()) win.close();
    const target = returnTo && !returnTo.isDestroyed() ? returnTo : ctx.mainWindow();
    if (target) loadInWindow(ctx, target, url);
  };

  // Sites the round trip reached through the servers' own redirects. A page in
  // the window may move within them; a link to anywhere else opens in the
  // system browser instead of an app-titled window with no address bar.
  const visited = new Set();
  const check = (event, redirect) => {
    const server = ctx.server();
    const { url } = event;
    if (server.owns(url)) {
      // The integration's callback runs here, with the shared cookies.
      if (server.isApi(url) && !server.signInProvider(url)) return;
      event.preventDefault();
      back(url);
      return;
    }
    let parsed = null;
    try {
      parsed = new URL(url);
    } catch {
      // not a URL: blocked below
    }
    if (parsed && isWeb(url) && secureEnough(parsed) && (redirect || visited.has(parsed.origin))) {
      visited.add(parsed.origin);
      return;
    }
    event.preventDefault();
    if (externalUrl(url)) openFromPage(url, win);
  };
  win.webContents.on('will-navigate', (event) => check(event, false));
  win.webContents.on('will-redirect', (event) => {
    if (event.isMainFrame !== false) check(event, true);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openFromPage(url, win);
    return { action: 'deny' };
  });

  // A third-party page never gets to keep the window open with beforeunload.
  win.webContents.on('will-prevent-unload', (event) => event.preventDefault());
  win.once('ready-to-show', () => {
    if (!test.enabled) win.show();
  });
  win.loadURL(startUrl).catch(() => {});
  return win;
}
