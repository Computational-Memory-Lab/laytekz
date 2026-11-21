// The shell feature host (V2, WP09). It validates and starts the features in
// features/index.js (SHELL_FEATURES) and hands each a ShellCtx: the only way a
// feature reaches the main window, the server session, settings.json, IPC and
// the app's local pages. main.js creates one host and lends it to menu.js
// (feature menu items), navigation.js (the settings-window intercept),
// hardening.js (permission vetoes), protocol.js (per-page CSP) and
// ui-bridge.js (the shared ui:* channels for feature pages).
//
// No Electron import here, at the top or anywhere: main.js injects what the
// host needs (createShellHost's deps), so the validation, the lifecycle and
// the IPC sender checks run in plain Node in the unit tests.
//
// A feature that is invalid in part loses that part, and one whose start()
// throws stops running; both are reported in `problems`, never thrown, so a
// broken feature never stops the app from starting.

import { acceleratorOwner } from '../rules.js';

export const MENU_PLACES = Object.freeze(['app', 'file', 'view', 'help']);
/** The settings page desktop 1.0 already had. Its bridge lives in dialogs.js, so the host opens it through deps.showChangeServer. */
export const BUILT_IN_SETTINGS_PAGE = 'change-server.html';
/** The app menu's own item ids (menu.js); a feature item may not reuse one. */
export const CORE_MENU_IDS = Object.freeze([
  'about', 'settings', 'change-server', 'reload', 'force-reload', 'help-site', 'help-source', 'help-privacy',
]);
/** Channels ui-bridge.js answers for every local page (src/preload/ui.cjs); a feature serves them for its own pages. */
export const UI_CHANNELS = Object.freeze(['ui:get-state', 'ui:action']);

const FEATURE_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const PAGE_RE = /^[a-z0-9-]+\.html$/;
const PRELOAD_RE = /^[a-z0-9-]+\.cjs$/;
const PARTITION_RE = /^(persist:)?laytekz-[a-z0-9-]{1,40}$/;
const REMOTE_PARTITION = 'persist:laytekz';
const CHANNEL_RE = /^[a-z][a-z0-9-]{0,31}:[A-Za-z0-9_:-]{1,64}$/;
const SETTINGS_KEY_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const ITEM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const HASH_RE = /^[A-Za-z0-9_-]{1,64}$/;
const UI_PAGE_PREFIX = 'laytekz-ui://app/';

/**
 * Checks the feature list. Returns {records, problems}: one record per usable
 * feature ({id, feature, menu: [{where, item}], pages: Map<page, ShellPage>,
 * vetoes: Set, settingsPage, start}) and one sentence per dropped part.
 * `opts.pageExists(name)` and `opts.preloadExists(name)` look on disk
 * (main.js); without them any well-formed name passes.
 */
export function validateFeatures(features, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const pageExists = opts.pageExists ?? (() => true);
  const preloadExists = opts.preloadExists ?? (() => true);
  const problems = [];
  const records = [];
  const ids = new Set();
  const itemIds = new Set(CORE_MENU_IDS);
  const pageOwner = new Map();
  let settingsOwner = null;

  for (const [index, feature] of (Array.isArray(features) ? features : []).entries()) {
    if (!feature || typeof feature !== 'object' || typeof feature.id !== 'string' || !FEATURE_ID_RE.test(feature.id)) {
      problems.push(`Shell feature #${index} has no valid id and was skipped.`);
      continue;
    }
    const { id } = feature;
    if (ids.has(id)) {
      problems.push(`Shell feature ${id} is listed twice; the second was skipped.`);
      continue;
    }
    ids.add(id);
    const say = (text) => problems.push(`Shell feature ${id}: ${text}`);

    const pages = new Map();
    if (feature.pages !== undefined) {
      if (!feature.pages || typeof feature.pages !== 'object' || Array.isArray(feature.pages)) {
        say('pages must be an object keyed by page file name; ignored.');
      } else {
        for (const [page, spec] of Object.entries(feature.pages)) {
          const checked = checkPage(page, spec, { pageExists, preloadExists });
          if (typeof checked === 'string') say(checked);
          else if (pageOwner.has(page)) say(`page ${page} already belongs to ${pageOwner.get(page)}; ignored.`);
          else {
            pages.set(page, checked);
            pageOwner.set(page, id);
          }
        }
      }
    }

    let settingsPage = null;
    if (feature.settingsPage !== undefined) {
      const page = feature.settingsPage;
      if (typeof page !== 'string' || !PAGE_RE.test(page)) say('settingsPage must be a page file name; ignored.');
      else if (settingsOwner) say(`settingsPage is already set by ${settingsOwner}; ignored.`);
      else if (page !== BUILT_IN_SETTINGS_PAGE && !pages.has(page) && pageOwner.has(page)) {
        say(`settingsPage ${page} belongs to ${pageOwner.get(page)}; ignored.`);
      } else if (page !== BUILT_IN_SETTINGS_PAGE && !pages.has(page) && !pageExists(page)) {
        say(`settingsPage ${page} is not a file under src/ui; ignored.`);
      } else {
        settingsPage = page;
        settingsOwner = id;
        // A settings page the feature did not declare gets the defaults (UI session, no preload, the default CSP).
        if (page !== BUILT_IN_SETTINGS_PAGE && !pages.has(page)) {
          pages.set(page, Object.freeze({}));
          pageOwner.set(page, id);
        }
      }
    }

    const menu = [];
    if (feature.menu !== undefined) {
      if (!Array.isArray(feature.menu)) say('menu must be an array; ignored.');
      else {
        for (const entry of feature.menu) {
          const checked = checkMenuEntry(entry, { platform, itemIds });
          for (const text of checked.problems) say(text);
          if (checked.entry) menu.push(checked.entry);
        }
      }
    }

    const vetoes = new Set();
    if (feature.vetoPermissions !== undefined) {
      if (!Array.isArray(feature.vetoPermissions)) say('vetoPermissions must be an array of permission names; ignored.');
      else {
        for (const p of feature.vetoPermissions) {
          if (typeof p === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(p)) vetoes.add(p);
          else say(`vetoPermissions entry ${JSON.stringify(p)} is not a permission name; ignored.`);
        }
      }
    }

    let start = null;
    if (feature.start !== undefined) {
      if (typeof feature.start === 'function') start = feature.start;
      else say('start must be a function; ignored.');
    }

    records.push({ id, feature, menu, pages, vetoes, settingsPage, start });
  }
  return { records, problems };
}

function checkPage(page, spec, { pageExists, preloadExists }) {
  if (!PAGE_RE.test(page)) return `page ${JSON.stringify(page)} is not a flat .html file name under src/ui; ignored.`;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return `page ${page} needs an object ({csp?, preload?, partition?}); ignored.`;
  if (!pageExists(page)) return `page ${page} is not a file under src/ui; ignored.`;
  const out = {};
  if (spec.csp !== undefined) {
    if (typeof spec.csp !== 'string' || !spec.csp.trim() || /[\r\n]/.test(spec.csp)) return `page ${page} has an invalid csp; ignored.`;
    out.csp = spec.csp.trim();
  }
  if (spec.preload !== undefined) {
    if (typeof spec.preload !== 'string' || !PRELOAD_RE.test(spec.preload)) return `page ${page}: preload must be a .cjs file name under src/preload; ignored.`;
    if (!preloadExists(spec.preload)) return `page ${page}: preload ${spec.preload} is not a file under src/preload; ignored.`;
    out.preload = spec.preload;
  }
  if (spec.partition !== undefined) {
    if (typeof spec.partition !== 'string' || !PARTITION_RE.test(spec.partition) || spec.partition === REMOTE_PARTITION) {
      return `page ${page}: partition must be "laytekz-<name>" or "persist:laytekz-<name>", never the server's; ignored.`;
    }
    out.partition = spec.partition;
  }
  return Object.freeze(out);
}

function checkMenuEntry(entry, { platform, itemIds }) {
  const problems = [];
  if (!entry || typeof entry !== 'object' || !MENU_PLACES.includes(entry.where)) {
    return { entry: null, problems: [`a menu entry needs where: ${MENU_PLACES.join(' | ')}; ignored.`] };
  }
  const item = entry.item;
  if (!item || typeof item !== 'object' || Array.isArray(item)) return { entry: null, problems: ['a menu entry has no item; ignored.'] };
  if (item.type !== 'separator' && (typeof item.id !== 'string' || !ITEM_ID_RE.test(item.id))) {
    return { entry: null, problems: ['every menu item needs an id (letters, digits, - _ .); ignored.'] };
  }
  if (typeof item.id === 'string') {
    if (itemIds.has(item.id)) return { entry: null, problems: [`menu item id ${item.id} is taken; ignored.`] };
    itemIds.add(item.id);
  }
  return { entry: { where: entry.where, item: checkItem(item, platform, problems, itemIds) }, problems };
}

/** A copy of the item without accelerators another owner holds; submenus too. */
function checkItem(item, platform, problems, itemIds) {
  const out = { ...item };
  if (out.accelerator !== undefined) {
    const owner = typeof out.accelerator === 'string' ? acceleratorOwner(out.accelerator, platform) : 'nobody (not a string)';
    if (owner) {
      problems.push(`menu item ${item.id ?? '(separator)'}: ${out.accelerator} belongs to ${owner}; the item keeps no accelerator.`);
      delete out.accelerator;
    }
  }
  if (Array.isArray(item.submenu)) {
    out.submenu = item.submenu.filter((sub) => sub && typeof sub === 'object').map((sub) => {
      if (typeof sub.id === 'string') {
        if (itemIds.has(sub.id)) {
          problems.push(`menu item id ${sub.id} is taken; it keeps no id.`);
          const { id: _dropped, ...rest } = sub;
          return checkItem(rest, platform, problems, itemIds);
        }
        itemIds.add(sub.id);
      }
      return checkItem(sub, platform, problems, itemIds);
    });
  }
  return out;
}

/**
 * deps = {
 *   features: readonly ShellFeature[],
 *   platform?: string,
 *   server(): Server | null,                 // server.js Server
 *   mainWindow(): BrowserWindow | null,
 *   remoteSession(): Session,                // the main window's session (persist:laytekz)
 *   loadSettings(): object, saveSettings(patch): object,   // settings.js
 *   ipcMain: { handle(channel, fn), removeHandler(channel) },
 *   createLocalWindow(page, spec, opts): BrowserWindow,   // a window on laytekz-ui://app/<page>[#hash]
 *   createOverlay(page, spec, opts): OverlayHandle,      // a view over the main window
 *   focusWindow(win): void,
 *   showChangeServer(): unknown,             // the built-in settings page (dialogs.js)
 *   pageExists?(name), preloadExists?(name), // on disk; checked by validateFeatures
 *   uiUrl?(page): string,
 *   changed?(): void,                        // a feature stopped running: rebuild the menu
 *   log?(text): void,
 * }
 */
export function createShellHost(deps) {
  const platform = deps.platform ?? process.platform;
  const log = deps.log ?? ((text) => console.warn(`Laytekz: ${text}`));
  const uiUrl = deps.uiUrl ?? ((page) => `${UI_PAGE_PREFIX}${page}`);
  const { records, problems } = validateFeatures(deps.features, {
    platform, pageExists: deps.pageExists, preloadExists: deps.preloadExists,
  });
  const state = new Map(records.map((r) => [r.id, { failed: false, dispose: null, started: false }]));
  /** webContents id → {featureId, page}: the only senders the host's channels answer. */
  const senders = new Map();
  /** `${featureId}/${page}` → BrowserWindow, one window per page. */
  const windows = new Map();
  /** channel → [{featureId, pages: Set, fn}]. */
  const channels = new Map();
  let stopped = false;
  let lastSettingsOpen = 0;

  const active = (r) => !stopped && !state.get(r.id).failed;
  const recordOf = (id) => records.find((r) => r.id === id) ?? null;

  function fail(r, err, during) {
    const s = state.get(r.id);
    if (s.failed) return;
    s.failed = true;
    const text = `Shell feature ${r.id} stopped: ${during} threw ${err?.stack ?? err}`;
    problems.push(text);
    log(text);
    dropChannels(r.id);
    deps.changed?.();
  }

  // -------------------------------------------------------------- ShellCtx

  function settingsOf(r) {
    const all = () => {
      const f = deps.loadSettings()?.features;
      return f && typeof f === 'object' && !Array.isArray(f) ? f : {};
    };
    const mine = () => {
      const m = all()[r.id];
      return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
    };
    const checkKey = (key) => {
      if (typeof key !== 'string' || !SETTINGS_KEY_RE.test(key)) throw new TypeError(`Settings key ${JSON.stringify(key)} is not allowed.`);
    };
    return Object.freeze({
      get(key, fallback) {
        checkKey(key);
        const value = mine()[key];
        return value === undefined ? fallback : structuredClone(value);
      },
      set(key, value) {
        checkKey(key);
        const next = { ...mine() };
        if (value === undefined) delete next[key];
        else {
          const text = JSON.stringify(value);
          if (text === undefined) throw new TypeError(`Settings value for ${key} cannot be stored as JSON.`);
          next[key] = JSON.parse(text);
        }
        deps.saveSettings({ features: { ...all(), [r.id]: next } });
      },
    });
  }

  function sessionFetch(path, init = {}) {
    return Promise.resolve().then(() => {
      const server = deps.server();
      if (!server) throw new Error('No server is chosen yet.');
      if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
        throw new TypeError('sessionFetch takes a path on the server, starting with a single /.');
      }
      const url = server.url(path);
      if (!server.owns(url)) throw new TypeError(`sessionFetch: ${path} is not on the server.`);
      // The window session's cookie goes along; nothing adds an Origin header,
      // so the server's origin check treats it as a non-browser client.
      return deps.remoteSession().fetch(url, { credentials: 'include', cache: 'no-store', ...init });
    });
  }

  function pageSpec(r, page) {
    const spec = r.pages.get(page);
    if (!spec) throw new Error(`Shell feature ${r.id} has no page ${JSON.stringify(page)} (declare it in pages).`);
    return spec;
  }

  function track(contents, featureId, page) {
    if (!contents || senders.has(contents.id)) return;
    const id = contents.id;
    senders.set(id, { featureId, page });
    contents.once?.('destroyed', () => {
      if (senders.get(id)?.featureId === featureId) senders.delete(id);
    });
  }

  function openLocalWindow(r, page, opts = {}) {
    const spec = pageSpec(r, page);
    const key = `${r.id}/${page}`;
    const hash = typeof opts.hash === 'string' && HASH_RE.test(opts.hash) ? opts.hash : null;
    const existing = windows.get(key);
    if (existing && !existing.isDestroyed()) {
      if (hash) existing.webContents.executeJavaScript(`location.hash = ${JSON.stringify(`#${hash}`)}`).catch(() => {});
      deps.focusWindow(existing);
      return existing;
    }
    const win = deps.createLocalWindow(page, spec, { ...windowOptions(opts), hash });
    windows.set(key, win);
    track(win.webContents, r.id, page);
    win.on('closed', () => {
      if (windows.get(key) === win) windows.delete(key);
    });
    return win;
  }

  function overlay(r, page, opts = {}) {
    const spec = pageSpec(r, page);
    if (!deps.mainWindow()) throw new Error('There is no main window to lay an overlay over.');
    return deps.createOverlay(page, spec, {
      bounds: typeof opts.bounds === 'function' ? opts.bounds : null,
      background: typeof opts.background === 'string' ? opts.background : null,
      onContents: (contents) => track(contents, r.id, page),
    });
  }

  // ------------------------------------------------------------------ IPC

  /** {featureId, page} when the sender is the top frame of a page this host opened, showing that page; else null. */
  function senderPage(event) {
    const frame = event?.senderFrame;
    const sender = event?.sender;
    if (!frame || !sender || frame.parent) return null;
    const known = senders.get(sender.id);
    if (!known) return null;
    const url = String(frame.url ?? '').split('#')[0];
    return url === uiUrl(known.page) ? known : null;
  }

  function dispatch(channel, event, args) {
    const from = senderPage(event);
    if (!from) return null;
    const entry = channels.get(channel)?.find((e) => e.featureId === from.featureId && e.pages.has(from.page));
    if (!entry) return null;
    const r = recordOf(entry.featureId);
    if (!r || !active(r)) return null;
    return entry.fn(event, ...args);
  }

  function handle(r, channel, fn, opts) {
    if (typeof channel !== 'string' || !CHANNEL_RE.test(channel)) throw new TypeError(`IPC channel ${JSON.stringify(channel)} is not allowed.`);
    if (channel.startsWith('ui:') && !UI_CHANNELS.includes(channel)) throw new TypeError(`ui:* is the shared bridge's; only ${UI_CHANNELS.join(' and ')} may be served.`);
    if (typeof fn !== 'function') throw new TypeError('ipc.handle needs a function.');
    const pages = Array.isArray(opts?.pages) ? opts.pages : [];
    if (!pages.length) throw new TypeError('ipc.handle needs {pages: [...]}: the pages allowed to call it.');
    for (const page of pages) pageSpec(r, page);
    if (!active(r)) return () => {};
    const list = channels.get(channel) ?? [];
    const overlap = list.find((e) => e.featureId === r.id && pages.some((p) => e.pages.has(p)));
    if (overlap) throw new Error(`${channel} is already served for one of these pages.`);
    const entry = { featureId: r.id, pages: new Set(pages), fn };
    if (!list.length && !UI_CHANNELS.includes(channel)) {
      deps.ipcMain.handle(channel, (event, ...args) => dispatch(channel, event, args));
    }
    list.push(entry);
    channels.set(channel, list);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      removeEntry(channel, entry);
    };
  }

  function removeEntry(channel, entry) {
    const list = (channels.get(channel) ?? []).filter((e) => e !== entry);
    if (list.length) channels.set(channel, list);
    else {
      channels.delete(channel);
      if (!UI_CHANNELS.includes(channel)) deps.ipcMain.removeHandler(channel);
    }
  }

  function dropChannels(featureId) {
    for (const [channel, list] of [...channels]) {
      for (const entry of list.filter((e) => e.featureId === featureId)) removeEntry(channel, entry);
    }
  }

  function makeCtx(r) {
    return Object.freeze({
      server: () => deps.server()?.base ?? null,
      mainWindow: () => {
        const win = deps.mainWindow();
        return win && !win.isDestroyed() ? win : null;
      },
      settings: settingsOf(r),
      projectFromUrl: (url) => deps.server()?.projectFromUrl(url) ?? null,
      sessionFetch,
      ipc: Object.freeze({ handle: (channel, fn, opts) => handle(r, channel, fn, opts) }),
      openLocalWindow: (page, opts) => openLocalWindow(r, page, opts),
      overlay: (page, opts) => overlay(r, page, opts),
      // Galley: V2 (WP17 R1): re-reads every item's function-valued `visible`.
      rebuildMenu: () => { if (active(r)) deps.changed?.(); },
      // Galley: V2 (WP41 R1): the settings page's feature switches servers in place (desktop settings, Server address).
      ...(r.settingsPage && deps.applyServer ? { applyServer: (url) => { if (active(r)) deps.applyServer(url); } } : {}),
    });
  }

  // ------------------------------------------------------------ the host

  const contexts = new Map(records.map((r) => [r.id, makeCtx(r)]));

  /** Runs each feature's start(ctx) once, in list order. Call after the main window exists. */
  function start() {
    for (const r of records) {
      const s = state.get(r.id);
      if (s.started || s.failed || stopped) continue;
      s.started = true;
      if (!r.start) continue;
      let out;
      try {
        out = r.start(contexts.get(r.id));
      } catch (err) {
        fail(r, err, 'start()');
        continue;
      }
      if (typeof out === 'function') s.dispose = out;
      else if (out && typeof out.then === 'function') {
        out.then((d) => {
          if (typeof d !== 'function') return;
          if (stopped) runDispose(r, d);
          else s.dispose = d;
        }, (err) => fail(r, err, 'start()'));
      }
    }
  }

  function runDispose(r, dispose) {
    try {
      const out = dispose();
      if (out && typeof out.then === 'function') out.catch((err) => log(`Shell feature ${r.id}: its stop function threw ${err?.stack ?? err}`));
    } catch (err) {
      log(`Shell feature ${r.id}: its stop function threw ${err?.stack ?? err}`);
    }
  }

  /** At quit: each running feature's stop function, last started first; then every channel goes. */
  function stop() {
    if (stopped) return;
    stopped = true;
    for (const r of [...records].reverse()) {
      const s = state.get(r.id);
      const dispose = s.dispose;
      s.dispose = null;
      if (dispose && !s.failed) runDispose(r, dispose);
    }
    for (const r of records) dropChannels(r.id);
  }

  /** Menu items for one place (MENU_PLACES), from running features, in list order. A throwing click is logged, not raised. */
  function menuItems(where) {
    const out = [];
    for (const r of records) {
      if (!active(r)) continue;
      for (const entry of r.menu) if (entry.where === where) out.push(guardClicks(r, entry.item));
    }
    return out;
  }

  function guardClicks(r, item) {
    const out = { ...item };
    // Galley: V2 (WP17 R1, applied by WP25): an item may ask whether it shows now (re-read at each rebuild).
    if (typeof item.visible === 'function') {
      try { out.visible = !!item.visible(); } catch { out.visible = true; }
    }
    if (typeof item.click === 'function') {
      out.click = (...args) => {
        try {
          const result = item.click(...args);
          if (result && typeof result.then === 'function') result.catch((err) => log(`Shell feature ${r.id}: menu item ${item.id} threw ${err?.stack ?? err}`));
        } catch (err) {
          log(`Shell feature ${r.id}: menu item ${item.id} threw ${err?.stack ?? err}`);
        }
      };
    }
    if (Array.isArray(item.submenu)) out.submenu = item.submenu.map((sub) => guardClicks(r, sub));
    return out;
  }

  /** Whether a running feature refuses this permission to the remote page. */
  function vetoed(permission) {
    return records.some((r) => active(r) && r.vetoes.has(permission));
  }

  /** The CSP a feature set for one of its pages, or null for the default (protocol.js UI_CSP). */
  function cspFor(page) {
    for (const r of records) {
      const spec = r.pages.get(page);
      if (spec?.csp) return spec.csp;
    }
    return null;
  }

  /** Every session partition a feature page uses (each needs the laytekz-ui:// handler and the UI session's hardening). */
  function partitions() {
    const out = new Set();
    for (const r of records) for (const spec of r.pages.values()) if (spec.partition) out.add(spec.partition);
    return out;
  }

  /** The feature page <base>/settings/desktop-app opens; the built-in Change Server page until a feature names another. */
  function settingsPage() {
    const owner = records.find((r) => r.settingsPage && active(r));
    return owner ? owner.settingsPage : BUILT_IN_SETTINGS_PAGE;
  }

  /**
   * Opens (or focuses) the desktop settings window. `hash` names the part
   * to show ('server' for Change Server…); the page reads location.hash.
   * `fromPage`: asked for by a web page, at most once a second.
   */
  function openSettingsPage({ hash = null, fromPage = false } = {}) {
    if (fromPage) {
      const now = Date.now();
      if (now - lastSettingsOpen < 1000) return null;
      lastSettingsOpen = now;
    }
    const owner = records.find((r) => r.settingsPage && active(r));
    if (!owner || owner.settingsPage === BUILT_IN_SETTINGS_PAGE) return deps.showChangeServer();
    return openLocalWindow(owner, owner.settingsPage, {
      hash, title: 'Laytekz Settings', width: 620, height: 560, parent: true,
    });
  }

  return Object.freeze({
    get problems() { return [...problems]; },
    get stopped() { return stopped; },
    featureIds: () => records.map((r) => r.id),
    running: (id) => {
      const r = recordOf(id);
      return !!r && active(r);
    },
    start,
    stop,
    menuItems,
    vetoed,
    cspFor,
    partitions,
    settingsPage,
    openSettingsPage,
    /** For ui-bridge.js: a ui:* call from a page no built-in bridge serves. */
    dispatch,
    senderPage,
    /** Tests only: a feature's ShellCtx. */
    contextOf: (id) => contexts.get(id) ?? null,
  });
}

/** The BrowserWindow options a feature may choose for its local window; the rest (webPreferences, show, …) is the host's. */
function windowOptions(opts) {
  const out = {};
  const int = (v, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : undefined);
  out.width = int(opts.width, 200, 4000);
  out.height = int(opts.height, 120, 4000);
  out.minWidth = int(opts.minWidth, 200, 4000);
  out.minHeight = int(opts.minHeight, 120, 4000);
  for (const flag of ['resizable', 'minimizable', 'maximizable', 'modal', 'parent']) {
    if (typeof opts[flag] === 'boolean') out[flag] = opts[flag];
  }
  if (typeof opts.title === 'string') out.title = opts.title.slice(0, 120);
  if (typeof opts.background === 'string' && /^#[0-9a-f]{6}$/i.test(opts.background)) out.background = opts.background;
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}
