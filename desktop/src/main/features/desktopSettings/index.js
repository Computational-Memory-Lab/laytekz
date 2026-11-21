// The desktop app's own settings window (V2, WP41, feature 7), opened for
// <base>/settings/desktop-app (the web app's Desktop section), by Laytekz →
// Desktop App Settings…, by Change Server… (at #server), by Settings… on a
// V1 server or offline, and by File → Linked .bib files… (at #bib).
//
// It holds:
// - Server address: today's check and health probe; the switch happens in
//   place through ShellCtx.applyServer once the host has it (WP41 notes,
//   request R1), and until then saves the address and restarts the app;
// - Open Laytekz when I log in (macOS and Windows, packaged builds);
// - When Laytekz opens: the project list, or the last project (recorded per
//   server from the windows' navigations);
// - Page zoom, 80–150%, kept across reloads and launches; zoom changed with
//   the View menu is kept too;
// - Spelling languages (Windows and Linux; macOS uses System Settings);
// - the local .bib files linked from this computer (features/bibwatch).
//
// The page (src/ui/desktop-settings.*) uses the shared ui.cjs bridge, served
// for this page only through ShellCtx.ipc; the remote page still has no
// preload. No Electron import at the top level.

import { checkHealth, normalizeServerUrl } from '../../server.js';
import { getBibwatch } from '../bibwatch/api.js';
import { setSettingsOpener } from './open.js';
import {
  PREF_DEFAULTS, ZOOM_CHOICES, checkPref, isProjectList, projectPath, readPrefs, sameValue,
} from './prefs.js';

export const SETTINGS_PAGE = 'desktop-settings.html';
const WINDOW = { title: 'Laytekz – Desktop App Settings', width: 620, height: 600, minWidth: 480, minHeight: 360, parent: true };
const REMOTE_PARTITION = 'persist:laytekz';
const PARTS = new Set(['server', 'startup', 'zoom', 'spelling', 'bib']);

let running = null;

/** @type {import('../index.js').ShellFeature} */
const desktopSettingsFeature = {
  id: 'desktopSettings',
  settingsPage: SETTINGS_PAGE,
  pages: { [SETTINGS_PAGE]: { preload: 'ui.cjs' } },
  menu: [
    { where: 'app', item: { id: 'desktop-settings', label: 'Desktop App Settings…', click: () => running?.open() } },
  ],
  start: (ctx) => startDesktopSettings(ctx),
};

async function startDesktopSettings(ctx) {
  const { app, session, webContents, BrowserWindow } = await import('electron');
  const { DEFAULT_SERVER_URL, test } = await import('../../env.js');
  const { saveSettings } = await import('../../settings.js');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const remote = session.fromPartition(REMOTE_PARTITION);
  const platform = process.platform;
  const loginSupported = platform === 'darwin' || platform === 'win32';
  // Never register a login item from a source run or a test.
  const osLogin = loginSupported && app.isPackaged && !test.enabled;

  const prefs = () => readPrefs((key) => ctx.settings.get(key));
  const record = (entry) => {
    if (!test.enabled) return;
    try {
      fs.appendFileSync(path.join(test.userData, 'desktop-settings.jsonl'), `${JSON.stringify(entry)}\n`);
    } catch { /* best effort */ }
  };

  function store(key, value) {
    ctx.settings.set(key, sameValue(value, PREF_DEFAULTS[key]) ? undefined : value);
  }

  const onServer = (url) => {
    const base = ctx.server();
    return !!base && typeof url === 'string' && (url === base || url.startsWith(`${base}/`) || url.startsWith(`${base}?`));
  };
  const isRemote = (wc) => !!wc && !wc.isDestroyed() && wc.session === remote && wc.getType() === 'window';
  const remoteContents = () => webContents.getAllWebContents().filter(isRemote);

  // ------------------------------------------------------------------ zoom

  const zoomed = new WeakSet();

  function applyZoom(wc) {
    if (!isRemote(wc) || !onServer(wc.getURL())) return;
    wc.setZoomFactor(prefs().zoomFactor);
    if (!zoomed.has(wc)) {
      zoomed.add(wc);
      // Zoom changed with the View menu (or a pinch) is kept when the window closes.
      BrowserWindow.fromWebContents(wc)?.once('close', () => captureZoom(wc));
    }
  }

  /** Keeps the zoom a window has now (the View menu changes it without telling anyone). */
  function captureZoom(wc) {
    if (!zoomed.has(wc) || wc.isDestroyed() || !onServer(wc.getURL())) return;
    const now = checkPref('zoomFactor', wc.getZoomFactor());
    if (now !== null && now !== prefs().zoomFactor) store('zoomFactor', now);
  }

  // ------------------------------------------------------ the last project

  const lastPaths = () => {
    const v = ctx.settings.get('lastPaths', {});
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  };

  function rememberProject(url) {
    const project = ctx.projectFromUrl(url);
    const base = ctx.server();
    if (!project || !base) return;
    const p = projectPath(project);
    const all = lastPaths();
    if (all[base] === p) return;
    // At most a few servers are remembered.
    const next = Object.fromEntries([...Object.entries(all).filter(([k]) => k !== base).slice(-4), [base, p]]);
    ctx.settings.set('lastPaths', next);
  }

  let launchHandled = false;
  function maybeReopen(wc, url) {
    if (launchHandled || wc !== ctx.mainWindow()?.webContents) return;
    if (!onServer(url)) return;
    launchHandled = true;
    const target = lastPaths()[ctx.server()];
    if (prefs().launch !== 'last' || !target || !isProjectList(ctx.server(), url)) return;
    record({ reopen: target });
    wc.loadURL(`${ctx.server()}${target}`).catch(() => {});
  }

  // ------------------------------------------------ every remote window

  const watched = new WeakSet();
  function watchContents(wc) {
    if (!isRemote(wc) || watched.has(wc)) return;
    watched.add(wc);
    wc.on('did-finish-load', () => {
      applyZoom(wc);
      maybeReopen(wc, wc.getURL());
    });
    wc.on('did-start-navigation', (details, legacyUrl, legacyInPlace, legacyMainFrame) => {
      const mainFrame = details?.isMainFrame ?? legacyMainFrame;
      const inPlace = details?.isSameDocument ?? legacyInPlace;
      if (mainFrame && !inPlace) captureZoom(wc);
    });
    wc.on('did-navigate', (_e, url) => rememberProject(url));
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame !== false) rememberProject(url);
    });
  }
  const onCreated = (_event, wc) => {
    // The window session is known once the contents exist; give the BrowserWindow a tick to adopt them.
    setImmediate(() => watchContents(wc));
  };
  app.on('web-contents-created', onCreated);
  for (const wc of remoteContents()) {
    watchContents(wc);
    // Already showing the server (the main window loads before features start): apply now.
    if (!wc.isLoading() && wc.getURL()) {
      applyZoom(wc);
      maybeReopen(wc, wc.getURL());
    }
  }

  // ---------------------------------------------------------- spelling

  const spellingSupported = platform !== 'darwin';
  function applySpelling() {
    if (!spellingSupported) return;
    const wanted = prefs().spellLanguages;
    if (!wanted.length) return;
    const available = new Set(remote.availableSpellCheckerLanguages ?? []);
    const langs = wanted.filter((l) => available.has(l));
    if (!langs.length) return;
    try {
      remote.setSpellCheckerLanguages(langs);
    } catch { /* an unknown language on this system */ }
  }
  applySpelling();

  // ------------------------------------------------------- open at login

  function loginValue() {
    if (osLogin) {
      try {
        return !!app.getLoginItemSettings().openAtLogin;
      } catch { /* fall back to what was chosen */ }
    }
    return prefs().openAtLogin;
  }

  // ------------------------------------------------------- server address

  let restart = null;
  async function saveServer(input) {
    const normalized = normalizeServerUrl(input);
    if (!normalized.ok) return normalized;
    if (normalized.url === ctx.server()) return { ok: true, url: normalized.url, same: true };
    const health = await checkHealth(remote, normalized.url);
    if (!health.ok) return { ok: false, url: normalized.url, error: health.reason };
    if (typeof ctx.applyServer === 'function') {
      // Request R1 (WP41.md): the shell switches in place, as Change Server… did in desktop 1.0.
      ctx.applyServer(normalized.url);
      setImmediate(push);
      return { ok: true, url: normalized.url, switched: true };
    }
    saveSettings({ serverUrl: normalized.url });
    restart = { url: normalized.url, at: Date.now() };
    if (test.enabled) {
      // Test mode never restarts: it records the restart it would do.
      record({ restart: normalized.url });
    } else {
      setTimeout(() => app.quit(), 400);
    }
    return { ok: true, url: normalized.url, restarting: true };
  }

  // ------------------------------------------------------ the page's state

  let page = null;
  let unsubscribe = null;

  function state() {
    for (const wc of remoteContents()) captureZoom(wc);
    const p = prefs();
    const bib = getBibwatch();
    return {
      platform,
      server: { current: ctx.server(), defaultUrl: DEFAULT_SERVER_URL },
      openAtLogin: { supported: loginSupported, value: loginValue(), applies: osLogin },
      launch: { value: p.launch, last: lastPaths()[ctx.server()] ?? null },
      zoom: { value: p.zoomFactor, choices: ZOOM_CHOICES },
      spelling: {
        supported: spellingSupported,
        available: spellingSupported ? [...(remote.availableSpellCheckerLanguages ?? [])] : [],
        selected: p.spellLanguages,
      },
      bib: { running: !!bib, links: bib ? bib.list() : [] },
    };
  }

  function push() {
    if (page && !page.isDestroyed()) page.send('ui:state', state());
  }

  function remember(sender) {
    if (page === sender) return;
    page = sender;
    if (!unsubscribe) {
      const bib = getBibwatch();
      if (bib) unsubscribe = bib.subscribe(() => push());
    }
  }

  async function action(event, name, payload) {
    switch (name) {
      case 'set': {
        const key = payload?.key;
        if (!Object.hasOwn(PREF_DEFAULTS, key)) return { ok: false, error: 'Unknown setting.' };
        const value = checkPref(key, payload.value);
        if (value === null) return { ok: false, error: 'That value is not allowed.' };
        store(key, value);
        if (key === 'zoomFactor') for (const wc of remoteContents()) applyZoom(wc);
        else if (key === 'spellLanguages') {
          if (value.length) applySpelling();
          else if (spellingSupported) try { remote.setSpellCheckerLanguages([app.getLocale()]); } catch { /* keep the system's */ }
        } else if (key === 'openAtLogin' && osLogin) app.setLoginItemSettings({ openAtLogin: value });
        record({ set: key, value });
        return { ok: true, state: state() };
      }
      case 'server-save':
        return saveServer(payload);
      case 'bib-push': {
        const bib = getBibwatch();
        if (!bib || typeof payload !== 'string') return { ok: false, error: 'Local .bib links are not running.' };
        const out = await bib.pushNow(payload, { force: true });
        return { ...out, state: state() };
      }
      case 'bib-unlink': {
        const bib = getBibwatch();
        if (!bib || typeof payload !== 'string') return { ok: false, error: 'Local .bib links are not running.' };
        const out = await bib.unlink(payload);
        return { ...out, state: state() };
      }
      case 'close': {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win && !win.isDestroyed()) win.close();
        return null;
      }
      default:
        return null;
    }
  }

  const offState = ctx.ipc.handle('ui:get-state', (event) => {
    remember(event.sender);
    return state();
  }, { pages: [SETTINGS_PAGE] });
  const offAction = ctx.ipc.handle('ui:action', (event, name, payload) => {
    remember(event.sender);
    return action(event, typeof name === 'string' ? name : '', payload);
  }, { pages: [SETTINGS_PAGE] });

  function open(hash) {
    return ctx.openLocalWindow(SETTINGS_PAGE, { ...WINDOW, ...(PARTS.has(hash) ? { hash } : {}) });
  }

  running = { open };
  setSettingsOpener(open);

  return () => {
    running = null;
    setSettingsOpener(null);
    unsubscribe?.();
    offState();
    offAction();
    app.removeListener('web-contents-created', onCreated);
    // Switching servers restarts the app (request R1 would make it instant).
    if (restart && !test.enabled && Date.now() - restart.at < 120_000) app.relaunch();
  };
}

export default desktopSettingsFeature;
