// "Change server…" (a small local page in a modal window) and About Laytekz.

import { app, BrowserWindow, dialog } from 'electron';
import { BACKGROUND, DEFAULT_SERVER_URL, UPSTREAM_NAME, UPSTREAM_URL, test } from './env.js';
import { openExternal } from './external.js';
import { uiWebPreferences } from './hardening.js';
import { uiUrl } from './protocol.js';
import { checkHealth, normalizeServerUrl } from './server.js';
import { bindUi } from './ui-bridge.js';

let changeServerWindow = null;

/**
 * ctx = {mainWindow(), server(), session(), apply(url)}: apply switches the
 * app to a validated server URL.
 */
export function showChangeServer(ctx) {
  if (changeServerWindow && !changeServerWindow.isDestroyed()) {
    changeServerWindow.focus();
    return changeServerWindow;
  }
  const parent = ctx.mainWindow();
  const win = new BrowserWindow({
    width: 500,
    height: 300,
    useContentSize: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    parent: parent && !parent.isDestroyed() ? parent : undefined,
    modal: !!parent && !test.enabled,
    show: false,
    title: 'Change Server',
    backgroundColor: BACKGROUND,
    autoHideMenuBar: true,
    webPreferences: uiWebPreferences(),
  });
  changeServerWindow = win;
  win.on('closed', () => {
    if (changeServerWindow === win) changeServerWindow = null;
  });

  const validate = async (input) => {
    const normalized = normalizeServerUrl(input);
    if (!normalized.ok) return normalized;
    const health = await checkHealth(ctx.session(), normalized.url);
    return health.ok ? { ok: true, url: normalized.url } : { ok: false, url: normalized.url, error: health.reason };
  };

  bindUi(win.webContents, {
    state: () => ({ current: ctx.server().base, defaultUrl: DEFAULT_SERVER_URL }),
    action: async (name, payload) => {
      if (name === 'cancel') {
        win.close();
        return null;
      }
      if (name === 'save') {
        const result = await validate(payload);
        if (result.ok && !win.isDestroyed()) {
          win.close();
          ctx.apply(result.url);
        }
        return result;
      }
      return null;
    },
  });

  win.once('ready-to-show', () => {
    if (!test.enabled) win.show();
  });
  win.loadURL(uiUrl('change-server.html'));
  return win;
}

/** The server's own pages About and the Help menu link to (apps/server/src/galley-source.ts, privacy.ts). */
export const serverSourceUrl = (server) => server.url('/source');
export const serverPrivacyUrl = (server) => server.url('/privacy');

export async function showAbout(ctx) {
  const server = ctx.server();
  const source = serverSourceUrl(server);
  const privacy = serverPrivacyUrl(server);
  const parent = ctx.mainWindow();
  const options = {
    type: 'none',
    title: 'About Laytekz',
    message: 'Laytekz',
    detail: [
      `Version ${app.getVersion()}`,
      `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
      '',
      `Connected to ${server.base}`,
      `Based on ${UPSTREAM_NAME}: ${UPSTREAM_URL}`,
      `The server runs a modified ${UPSTREAM_NAME}, licensed under the AGPL-3.0. Its source code: ${source}`,
      `Privacy: ${privacy}`,
    ].join('\n'),
    buttons: ['OK', 'Get the Source Code', 'Privacy'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const { response } = parent && !parent.isDestroyed()
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  if (response === 1) openExternal(source);
  else if (response === 2) openExternal(privacy);
}
