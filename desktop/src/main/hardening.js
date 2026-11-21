// Window preferences, permissions, downloads and app-wide guards.
// The remote page is treated as untrusted relative to the OS: no Node, no
// preload, sandboxed, and only the permissions the editor needs.

import { app, BrowserWindow, dialog } from 'electron';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from './env.js';
import { isProgramFile } from './rules.js';

export const REMOTE_PARTITION = 'persist:laytekz';
export const UI_PARTITION = 'laytekz-ui';
// Galley: V2 desktop shell (WP09): shell feature pages pick their preload from here.
export const PRELOAD_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'preload');
export const UI_PRELOAD = path.join(PRELOAD_DIR, 'ui.cjs');

// Copying to the clipboard is all the web UI asks for; it never reads the
// clipboard or uses the Fullscreen API (View > Enter Full Screen is the window's).
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write']);

const common = () => ({
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  navigateOnDragDrop: false,
  experimentalFeatures: false,
  safeDialogs: true,
  // Hidden test windows must keep painting, or Playwright waits forever.
  backgroundThrottling: !test.enabled,
});

/** For every window that shows the Laytekz server or a third-party sign-in page. No preload. */
export function remoteWebPreferences() {
  return { ...common(), partition: REMOTE_PARTITION, spellcheck: true };
}

/** For the app's own local pages (laytekz-ui://), which get a tiny IPC bridge. */
export function uiWebPreferences() {
  return { ...common(), partition: UI_PARTITION, preload: UI_PRELOAD, spellcheck: false };
}

/**
 * Galley: V2 desktop shell (WP09). For a shell feature's local page
 * (ShellPage): its own partition or the UI session, and its own preload
 * from src/preload or none at all. Never used for the remote page.
 */
export function localWebPreferences(spec = {}) {
  const prefs = { ...common(), partition: spec.partition ?? UI_PARTITION, spellcheck: false };
  if (spec.preload) prefs.preload = path.join(PRELOAD_DIR, spec.preload);
  return prefs;
}

/** Whether src/preload holds this preload (the shell feature host checks declared pages). */
export function preloadExists(name) {
  return /^[a-z0-9-]+\.cjs$/.test(name) && fs.existsSync(path.join(PRELOAD_DIR, name));
}

function originOf(raw) {
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/** Guards that hold for every webContents the app ever creates, whatever window it is in. */
export function hardenApp() {
  // Without a handler Electron answers a TLS client-certificate request with
  // the first certificate in the store, identifying the person to any site
  // that asks. The app needs none: decline.
  app.on('select-client-certificate', (event, _contents, _url, _list, callback) => {
    event.preventDefault();
    callback();
  });
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
    // Specific windows replace this with their own policy right after creation.
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const blockFile = (event) => {
      if (/^file:/i.test(event.url ?? '')) event.preventDefault();
    };
    contents.on('will-navigate', blockFile);
    contents.on('will-frame-navigate', blockFile);
    contents.on('will-redirect', blockFile);
  });
}

/**
 * The session the Laytekz server runs in.
 * hooks.server() → the current Server; hooks.downloadDone(state, filePath),
 * hooks.downloadBlocked(message) report to the person; hooks.vetoed(permission)
 * (Galley: V2, the shell features' vetoPermissions) refuses one of the
 * allowed permissions while a feature that needs it refused runs.
 */
export function hardenRemoteSession(ses, hooks) {
  const ours = (raw) => originOf(raw) === hooks.server().origin;
  const allowed = (permission) => ALLOWED_PERMISSIONS.has(permission) && !hooks.vetoed?.(permission);

  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(allowed(permission) && ours(details?.requestingUrl ?? contents?.getURL()));
  });
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) => (
    allowed(permission) && ours(requestingOrigin)
  ));
  ses.setDevicePermissionHandler(() => false);

  ses.on('will-download', (event, item, contents) => {
    const url = item.getURL();
    // A data: URL names no origin, and the frame that made it may be a
    // cross-origin iframe; the web UI downloads only server and blob: URLs.
    const origin = url.startsWith('data:') ? null : originOf(url);
    if (origin !== hooks.server().origin) {
      event.preventDefault();
      hooks.downloadBlocked(`Blocked a download from ${url.startsWith('data:') ? 'a data: address' : originOf(url) ?? 'another site'}.`);
      return;
    }
    const name = item.getFilename() || 'download';
    if (isProgramFile(name)) {
      event.preventDefault();
      hooks.downloadBlocked(`Blocked ${name}: Laytekz does not download programs.`);
      return;
    }
    if (!prompts.allow()) {
      event.preventDefault();
      hooks.downloadBlocked('Blocked another download: the page asked for several at once.');
      return;
    }
    const owner = (contents && BrowserWindow.fromWebContents(contents)) || BrowserWindow.getFocusedWindow();
    const options = {
      title: 'Save download',
      defaultPath: path.join(app.getPath('downloads'), name),
    };
    const target = owner ? dialog.showSaveDialogSync(owner, options) : dialog.showSaveDialogSync(options);
    prompts.ended();
    if (!target) {
      event.preventDefault();
      return;
    }
    item.setSavePath(target);
    item.once('done', async (_e, state) => {
      if (state === 'completed') await markAsDownloaded(target);
      hooks.downloadDone(state, target);
    });
  });
}

// Save prompts are synchronous: downloads a page starts while one is open
// arrive the moment it closes. Those, and more than a few prompts in a short
// time, are refused, so a page cannot keep a person in save dialogs.
export const DOWNLOAD_PROMPT_BUDGET = 3;
export const DOWNLOAD_PROMPT_WINDOW_MS = 15_000;
const QUEUED_MS = 1000;
const prompts = {
  times: [],
  lastEnded: 0,
  allow() {
    const now = Date.now();
    this.times = this.times.filter((t) => now - t < DOWNLOAD_PROMPT_WINDOW_MS);
    if (now - this.lastEnded < QUEUED_MS || this.times.length >= DOWNLOAD_PROMPT_BUDGET) return false;
    this.times.push(now);
    return true;
  },
  ended() {
    this.lastEnded = Date.now();
  },
};

/**
 * What a browser does to a file it downloads, so the OS checks it before it
 * is opened: the quarantine attribute on macOS (Gatekeeper), the
 * Mark of the Web on Windows (SmartScreen). Best effort: a volume that
 * cannot hold the attribute keeps the file without it.
 */
export function markAsDownloaded(file) {
  return new Promise((resolve) => {
    if (process.platform === 'darwin') {
      const value = `0083;${Math.floor(Date.now() / 1000).toString(16)};${app.getName()};${crypto.randomUUID().toUpperCase()}`;
      execFile('/usr/bin/xattr', ['-w', 'com.apple.quarantine', value, file], () => resolve());
    } else if (process.platform === 'win32') {
      fs.writeFile(`${file}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n', () => resolve());
    } else {
      resolve();
    }
  });
}

/** The session for the app's own pages: no network, no permissions, no downloads. */
export function hardenUiSession(ses) {
  ses.setPermissionRequestHandler((_c, _p, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.on('will-download', (event) => event.preventDefault());
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !/^(laytekz-ui|devtools):/.test(details.url) });
  });
}
