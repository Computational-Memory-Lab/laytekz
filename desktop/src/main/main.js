// Laytekz desktop: a thin, hardened shell around the Laytekz web app.

// First import: refuses command-line switches in a packaged build before anything starts.
import './switch-guard.js';
import {
  app, BrowserWindow, clipboard, dialog, ipcMain, Menu, screen, session, shell,
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { showAbout, showChangeServer } from './dialogs.js';
import {
  APP_ID, BACKGROUND, DEFAULT_SERVER_URL, RETRY_BASE_MS, RETRY_MAX_MS, SIGNIN_DEBOUNCE_MS, SIGNIN_TIMEOUT_MS, test,
} from './env.js';
import { externalUrl, openExternal } from './external.js';
// Galley: V2 desktop shell (WP09): the shell features and their host.
import { createShellHost } from './features/host.js';
import { SHELL_FEATURES } from './features/index.js';
import {
  REMOTE_PARTITION, UI_PARTITION, hardenApp, hardenRemoteSession, hardenUiSession, localWebPreferences,
  preloadExists, remoteWebPreferences,
} from './hardening.js';
import { buildMenu } from './menu.js';
import { applyAppPolicy, loadInWindow } from './navigation.js';
import { FeatureOverlay, OfflineScreen, Toast } from './overlays.js';
import {
  registerUiScheme, serveUi, uiFileExists, uiUrl,
} from './protocol.js';
import { withDesktopToken } from './rules.js';
import {
  Server, checkHealth, fetchCapabilities, httpReason, isOutageStatus, networkReason, normalizeServerUrl,
} from './server.js';
import { loadSettings, saveSettings } from './settings.js';
import { DesktopSignIn } from './signin.js';
import { installUiBridge, lockLocalContents } from './ui-bridge.js';

const APP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIN_WIDTH = 800;
const MIN_HEIGHT = 540;

// Before 'ready': the test profile and the scheme registration must come first.
if (test.enabled) {
  app.setPath('userData', test.userData);
  app.commandLine.appendSwitch('use-mock-keychain');
}
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
registerUiScheme();
hardenApp();

let server = null;
let remoteSession = null;
let mainWindow = null;
let offline = null;
let toast = null;
let signIn = null;
let lastProvider = null;
const retry = { timer: null, attempt: 0, target: null };
// Galley: V2 desktop shell (WP09): the feature host, and what the server
// said at /api/capabilities (kept per server once it answered).
let features = null;
let capabilities = { base: null, value: null };

const nav = {
  server: () => server,
  signIn: (provider) => startSignIn(provider),
  mainWindow: () => mainWindow,
  childOptions: () => ({
    width: 1100,
    height: 800,
    minWidth: 640,
    minHeight: 480,
    show: !test.enabled,
    backgroundColor: BACKGROUND,
    webPreferences: remoteWebPreferences(),
  }),
  decorate: (win) => decorateWindow(win),
  openDesktopSettings: () => features?.openSettingsPage({ fromPage: true }),
};

const dialogs = {
  mainWindow: () => mainWindow,
  server: () => server,
  session: () => remoteSession,
  apply: (url) => applyServer(url),
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!server) return; // still starting; the first window is on its way
    if (!mainWindow) openMainWindow();
    else bringToFront(mainWindow);
  });
  app.whenReady().then(start);
}

async function start() {
  const featureList = await shellFeatures();
  server = initialServer();
  remoteSession = session.fromPartition(REMOTE_PARTITION);
  // Galley: V2 (WP09): " Laytekz-Desktop/<version>" tells the web app it runs
  // here (its Desktop settings section, and Cmd/Ctrl+, left to the menu).
  remoteSession.setUserAgent(withDesktopToken(remoteSession.getUserAgent(), app.getVersion()));
  features = createShellHost({
    features: featureList,
    server: () => server,
    mainWindow: () => mainWindow,
    remoteSession: () => remoteSession,
    loadSettings,
    saveSettings,
    ipcMain,
    createLocalWindow,
    createOverlay,
    focusWindow: (win) => bringToFront(win),
    showChangeServer: () => showChangeServer(dialogs),
    // Galley: V2 (WP41 R1): the desktop settings window's Server address switches in place.
    applyServer: (url) => {
      const normalized = normalizeServerUrl(url);
      if (normalized.ok) applyServer(normalized.url);
    },
    pageExists: uiFileExists,
    preloadExists,
    uiUrl,
    changed: () => rebuildMenu(),
  });
  for (const problem of features.problems) console.warn(`Laytekz: ${problem}`);
  hardenRemoteSession(remoteSession, {
    vetoed: (permission) => features.vetoed(permission),
    server: () => server,
    downloadDone: (state, file) => {
      if (state === 'completed') {
        toast?.show({
          message: `Saved ${path.basename(file)}`,
          actions: [{ label: 'Show in Folder', primary: true, run: () => shell.showItemInFolder(file) }],
          timeoutMs: 12_000,
        });
      } else if (state === 'interrupted') {
        toast?.show({ message: `The download of ${path.basename(file)} failed.`, tone: 'error', timeoutMs: 12_000 });
      }
    },
    downloadBlocked: (message) => {
      toast?.show({ message, tone: 'error', timeoutMs: 8000 });
    },
  });
  const cspFor = (name) => features.cspFor(name);
  const uiSession = session.fromPartition(UI_PARTITION);
  serveUi(uiSession, { cspFor });
  hardenUiSession(uiSession);
  // Galley: V2 (WP09): a feature page in its own partition gets the same scheme and the same hardening.
  for (const partition of features.partitions()) {
    if (partition === UI_PARTITION) continue;
    const ses = session.fromPartition(partition);
    serveUi(ses, { cspFor });
    hardenUiSession(ses);
  }
  installUiBridge({ fallback: (channel, event, args) => features.dispatch(channel, event, args) });

  signIn = new DesktopSignIn({
    server: () => server,
    session: () => remoteSession,
    openExternal,
    timeoutMs: test.signinTimeoutMs ?? SIGNIN_TIMEOUT_MS,
    onWaiting: () => toast?.show({
      key: 'signin',
      tone: 'progress',
      dismissible: false,
      message: 'Finish signing in in your browser.',
      actions: [
        { label: 'Open the Browser Again', keepOpen: true, run: () => signIn.reopen() },
        { label: 'Cancel', run: () => signIn.cancel() },
      ],
    }),
    onEnd: signInEnded,
  });

  rebuildMenu();

  if (process.platform === 'darwin' && !app.isPackaged) {
    const icon = path.join(APP_ROOT, 'build', 'icon.png');
    if (fs.existsSync(icon)) app.dock?.setIcon(icon);
  }

  app.on('activate', () => {
    if (!mainWindow) openMainWindow();
    else bringToFront(mainWindow);
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  // will-quit, not before-quit: a quit the unsynced-edits prompt cancels ("Stay")
  // must leave a sign-in in progress alone (and, Galley: V2, the features running).
  app.on('will-quit', () => {
    signIn?.cancel('quit');
    features?.stop();
  });

  openMainWindow();
  // Galley: V2 (WP09): each shell feature's start(ctx), once, after the main window exists.
  features.start();
}

// ------------------------------------------------- shell features (Galley: V2, WP09)

/** SHELL_FEATURES, plus the test-only extras (env.js test.shellFeatures). */
async function shellFeatures() {
  if (!test.shellFeatures) return SHELL_FEATURES;
  try {
    const mod = await import(pathToFileURL(test.shellFeatures).href);
    return [...SHELL_FEATURES, ...(Array.isArray(mod.default) ? mod.default : [])];
  } catch (err) {
    console.error('Laytekz: could not load the test shell features:', err);
    return SHELL_FEATURES;
  }
}

function rebuildMenu() {
  buildMenu({
    about: () => showAbout(dialogs),
    settings: (win) => openWebSettings(win),
    changeServer: () => features.openSettingsPage({ hash: 'server' }),
    reload: reloadWindow,
    server: () => server,
    items: (where) => features.menuItems(where),
  });
}

/** A window on one of a shell feature's local pages (ShellCtx.openLocalWindow). */
function createLocalWindow(page, spec, opts) {
  const parent = opts.parent && mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const size = {};
  for (const key of ['minWidth', 'minHeight']) if (opts[key] !== undefined) size[key] = opts[key];
  const win = new BrowserWindow({
    width: opts.width ?? 560,
    height: opts.height ?? 440,
    ...size,
    useContentSize: true,
    resizable: opts.resizable ?? true,
    minimizable: opts.minimizable ?? true,
    maximizable: opts.maximizable ?? true,
    fullscreenable: false,
    parent,
    modal: !!opts.modal && !!parent && !test.enabled,
    show: false,
    title: opts.title ?? 'Laytekz',
    backgroundColor: opts.background ?? BACKGROUND,
    autoHideMenuBar: true,
    webPreferences: localWebPreferences(spec),
  });
  lockLocalContents(win.webContents);
  win.once('ready-to-show', () => {
    if (!test.enabled) win.show();
  });
  win.loadURL(`${uiUrl(page)}${opts.hash ? `#${opts.hash}` : ''}`).catch(() => {});
  return win;
}

/** A shell feature's page over the main window (ShellCtx.overlay); the toast stays on top. */
function createOverlay(page, spec, opts) {
  return new FeatureOverlay(mainWindow, page, spec, { ...opts, raised: () => toast?.raise() }).api();
}

/** What the server says at /api/capabilities; null for a server older than V2 (or none reachable). */
async function serverCapabilities() {
  const current = server;
  if (capabilities.base === current.base && capabilities.value) return capabilities.value;
  const value = await fetchCapabilities(remoteSession, current.base);
  if (value && current === server) capabilities = { base: current.base, value };
  return value;
}

// The page's own globals cannot change what this script does.
const OPEN_SETTINGS_WORLD = 1009;
const OPEN_SETTINGS_SCRIPT = "!window.dispatchEvent(new CustomEvent('laytekz:open-settings', { cancelable: true, detail: null }))";
const NO_ANSWER = Symbol('no answer');

/**
 * Settings… (Cmd/Ctrl+,). The window in front, if it shows the server, else
 * the main window, gets the cancelable 'laytekz:open-settings' event; the web
 * app opens its settings and cancels it. If nothing cancels it, a server with
 * /api/capabilities (V2) loads /settings; an older server has no settings page,
 * so the shortcut opens the desktop settings window, as in desktop 1.0. So does
 * the offline screen.
 */
async function openWebSettings(win) {
  const onServer = (w) => !!w && !w.isDestroyed() && server.owns(w.webContents.getURL());
  const target = onServer(win) ? win : mainWindow;
  if (!target || target.isDestroyed()) {
    const caps = await serverCapabilities();
    openMainWindow(server.url(caps ? '/settings' : '/'));
    if (!caps) features.openSettingsPage();
    return;
  }
  if (target === mainWindow && offline?.visible) {
    features.openSettingsPage();
    return;
  }
  let handled = false;
  if (onServer(target)) {
    let timer;
    try {
      handled = await Promise.race([
        target.webContents.executeJavaScriptInIsolatedWorld(OPEN_SETTINGS_WORLD, [{ code: OPEN_SETTINGS_SCRIPT }], true),
        new Promise((resolve) => { timer = setTimeout(() => resolve(NO_ANSWER), 3000); }),
      ]);
    } catch {
      handled = false;
    } finally {
      clearTimeout(timer);
    }
  }
  // A page that never answered may still be opening its settings: leave it be.
  if (handled === true || handled === NO_ANSWER || target.isDestroyed()) return;
  if (await serverCapabilities()) loadInWindow(nav, target, server.url('/settings'));
  else features.openSettingsPage();
}

function initialServer() {
  for (const candidate of [test.serverUrl, loadSettings().serverUrl, DEFAULT_SERVER_URL]) {
    const normalized = candidate ? normalizeServerUrl(candidate) : null;
    if (normalized?.ok) return new Server(normalized.url);
  }
  return new Server(DEFAULT_SERVER_URL);
}

// ---------------------------------------------------------------- main window

function savedWindowState() {
  const saved = loadSettings().window;
  const fallback = { bounds: { width: 1280, height: 820 }, maximized: false };
  if (!saved || typeof saved !== 'object') return fallback;
  const { x, y, width, height } = saved.bounds ?? {};
  if (![x, y, width, height].every(Number.isFinite)) return { ...fallback, maximized: !!saved.maximized };
  // Only reuse a position that is still on a connected display.
  const area = screen.getDisplayMatching({ x, y, width, height }).workArea;
  const onScreen = x < area.x + area.width - 80 && x + width > area.x + 80
    && y >= area.y - 10 && y < area.y + area.height - 80;
  return {
    bounds: onScreen
      ? { x, y, width: Math.max(MIN_WIDTH, width), height: Math.max(MIN_HEIGHT, height) }
      : { width: Math.max(MIN_WIDTH, width), height: Math.max(MIN_HEIGHT, height) },
    maximized: !!saved.maximized,
  };
}

function trackWindowState(win) {
  let timer = null;
  const save = () => {
    clearTimeout(timer);
    if (win.isDestroyed()) return;
    saveSettings({ window: { bounds: win.getNormalBounds(), maximized: win.isMaximized() } });
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(save, 600);
  };
  for (const event of ['resize', 'move', 'maximize', 'unmaximize']) win.on(event, later);
  win.on('close', save);
}

// Galley: V2 (WP09): `target`, for Settings… with no window open.
function openMainWindow(target = server.url('/')) {
  const { bounds, maximized } = savedWindowState();
  const win = new BrowserWindow({
    ...bounds,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    title: 'Laytekz',
    backgroundColor: BACKGROUND,
    webPreferences: remoteWebPreferences(),
  });
  mainWindow = win;
  offline = new OfflineScreen(win, (name) => {
    if (name === 'retry') connect(retry.target ?? server.url('/'));
    // Galley: V2 (WP09): the desktop settings page, which is Change Server until a shell feature names its own.
    else if (name === 'change-server') features.openSettingsPage({ hash: 'server' });
  });
  toast = new Toast(win);
  applyAppPolicy(win, nav);
  decorateWindow(win);
  trackWindowState(win);

  let revealed = false;
  const reveal = () => {
    if (revealed || win.isDestroyed()) return;
    revealed = true;
    if (test.enabled) return;
    if (maximized) win.maximize();
    win.show();
  };
  win.once('ready-to-show', reveal);
  setTimeout(reveal, 1500);

  const contents = win.webContents;
  contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    // -3 is ERR_ABORTED: a navigation the policy cancelled, or one that became a download.
    if (!isMainFrame || code === -3 || !server.owns(url)) return;
    showOffline(networkReason(description), url);
  });
  contents.on('did-navigate', (_event, url, status) => {
    if (!server.owns(url)) return;
    if (isOutageStatus(status)) showOffline(httpReason(status), url);
    else retry.attempt = 0;
  });
  win.on('closed', () => {
    if (mainWindow !== win) return;
    clearTimeout(retry.timer);
    mainWindow = null;
    offline = null;
    toast = null;
  });

  connect(target);
  return win;
}

function bringToFront(win) {
  if (!win || win.isDestroyed() || test.enabled) return;
  if (win.isMinimized()) win.restore();
  if (process.platform === 'darwin') app.focus({ steal: true });
  win.show();
  win.focus();
}

// ------------------------------------------------------- connection and offline

async function connect(target) {
  clearTimeout(retry.timer);
  const current = server;
  if (offline?.visible) offline.show({ ...offline.state, checking: true });
  const health = await checkHealth(remoteSession, current.base);
  if (current !== server || !mainWindow) return;
  if (!health.ok) {
    showOffline(health.reason, target);
    return;
  }
  offline.hide();
  loadInWindow(nav, mainWindow, target);
}

function showOffline(reason, target) {
  if (!mainWindow) return;
  clearTimeout(retry.timer);
  const base = test.retryBaseMs ?? RETRY_BASE_MS;
  const max = test.retryBaseMs ? base * 8 : RETRY_MAX_MS;
  const delay = Math.min(base * 2 ** retry.attempt, max);
  retry.attempt += 1;
  retry.target = target;
  offline.show({ host: server.host, url: server.base, reason, nextRetryAt: Date.now() + delay, checking: false });
  toast.raise();
  mainWindow.setTitle('Laytekz');
  retry.timer = setTimeout(() => connect(target), delay);
}

function reloadWindow(win, ignoreCache) {
  if (!win) return;
  if (win === mainWindow && offline?.visible) {
    connect(retry.target ?? server.url('/'));
    return;
  }
  if (ignoreCache) win.webContents.reloadIgnoringCache();
  else win.webContents.reload();
}

function applyServer(url) {
  saveSettings({ serverUrl: url });
  signIn.cancel();
  server = new Server(url);
  retry.attempt = 0;
  if (!mainWindow) openMainWindow();
  else connect(server.url('/'));
}

// ------------------------------------------------------------------- sign-in

function startSignIn(provider) {
  // A page can go to the sign-in link again and again without a click. While
  // an attempt is young another start does nothing; its toast offers
  // "Open the Browser Again".
  const debounce = test.signinDebounceMs ?? SIGNIN_DEBOUNCE_MS;
  if (signIn.active && Date.now() - signIn.startedAt < debounce) return;
  lastProvider = provider;
  toast?.hide('signin-result');
  signIn.start(provider);
}

function signInEnded(outcome, detail) {
  if (outcome === 'superseded' || outcome === 'quit') return;
  toast?.hide('signin');
  if (outcome === 'cancelled') return;
  if (outcome === 'success') {
    afterSignIn();
    return;
  }
  const messages = {
    denied: 'Sign-in was cancelled in the browser.',
    timeout: 'Sign-in timed out. If your account is waiting for approval, try again once it is approved.',
    failed: typeof detail === 'string' ? detail : 'Sign-in failed.',
  };
  toast?.show({
    key: 'signin-result',
    tone: outcome === 'denied' ? 'info' : 'error',
    message: messages[outcome] ?? messages.failed,
    actions: [{ label: 'Try Again', primary: true, run: () => startSignIn(lastProvider) }],
  });
}

function afterSignIn() {
  if (!mainWindow) {
    openMainWindow();
    return;
  }
  const current = mainWindow.webContents.getURL();
  if (server.owns(current) && !offline.visible) mainWindow.webContents.reload();
  else connect(server.url('/'));
  bringToFront(mainWindow);
}

// ------------------------------------------------- context menu, unload guard

// The site titles a page "<page> – <site name>". A window here leads with the
// app, the way Mac apps title their windows: "Laytekz – <page>". The text after
// the last dash (the site's own name) is dropped.
function windowTitle(pageTitle) {
  const text = String(pageTitle || '').replace(/\s+/g, ' ').trim();
  const cut = text.lastIndexOf(' – ');
  const page = (cut > 0 ? text.slice(0, cut) : text).trim();
  if (!page || page === 'Laytekz') return 'Laytekz';
  return `Laytekz – ${page.slice(0, 120)}`;
}

function decorateWindow(win) {
  win.on('page-title-updated', (event, title) => {
    event.preventDefault();
    // The offline screen titles the main window itself.
    if (win === mainWindow && offline && offline.visible) return;
    win.setTitle(windowTitle(title));
  });
  // The web UI blocks unload while edits are unsynced. Electron would otherwise
  // cancel the close or quit silently, so ask the way a browser does.
  win.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      title: 'Unsynced edits',
      message: 'Some edits have not reached the server yet.',
      detail: 'If you leave now, they may be lost.',
      buttons: ['Leave', 'Stay'],
      defaultId: 1,
      cancelId: 1,
    });
    if (choice === 0) event.preventDefault();
  });
  win.webContents.on('context-menu', (_event, params) => {
    const contents = win.webContents;
    const items = [];
    if (params.misspelledWord) {
      for (const word of params.dictionarySuggestions.slice(0, 5)) {
        items.push({ label: word, click: () => contents.replaceMisspelling(word) });
      }
      if (!params.dictionarySuggestions.length) items.push({ label: 'No Guesses Found', enabled: false });
      items.push(
        { label: 'Add to Dictionary', click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord) },
        { type: 'separator' },
      );
    }
    if (params.linkURL && externalUrl(params.linkURL)) {
      items.push({ label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) });
      if (!server.owns(params.linkURL)) {
        items.push({ label: 'Open Link in Browser', click: () => openExternal(params.linkURL) });
      }
      items.push({ type: 'separator' });
    }
    if (params.isEditable) {
      const f = params.editFlags;
      items.push(
        { role: 'undo', enabled: f.canUndo },
        { role: 'redo', enabled: f.canRedo },
        { type: 'separator' },
        { role: 'cut', enabled: f.canCut },
        { role: 'copy', enabled: f.canCopy },
        { role: 'paste', enabled: f.canPaste },
        { role: 'selectAll', enabled: f.canSelectAll },
      );
    } else if (params.selectionText.trim()) {
      items.push({ role: 'copy' });
    }
    while (items.length && items.at(-1).type === 'separator') items.pop();
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });
}
