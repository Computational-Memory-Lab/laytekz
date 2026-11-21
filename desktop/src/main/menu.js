// The application menu.
//
// Accelerators stay off the web UI's own chords: it uses Cmd/Ctrl + S, K, J,
// F, G, D, B, I, /, [, ], Enter, Shift+M, Shift+F, Shift+K, Shift+G, Alt+G and
// Shift+Alt+F, and CodeMirror takes Ctrl+M on Windows (Tab focus mode), so
// Minimize has no accelerator there. Edit roles share keys with the editor on
// purpose (they do the same thing), and the page sees every key first.

import { app, Menu } from 'electron';
import { SITE_URL } from './env.js';
import { serverPrivacyUrl, serverSourceUrl } from './dialogs.js';
import { openExternal } from './external.js';

const isMac = process.platform === 'darwin';

/** ctx = {about(), changeServer(), reload(win, ignoreCache), server()}. */
export function buildMenu(ctx) {
  const changeServer = {
    id: 'change-server',
    label: isMac ? 'Change Server…' : 'Change &Server…',
    accelerator: 'CommandOrControl+,',
    click: () => ctx.changeServer(),
  };
  const about = { id: 'about', label: 'About Laytekz', click: () => ctx.about() };

  const edit = {
    label: isMac ? 'Edit' : '&Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(isMac ? [{ role: 'pasteAndMatchStyle' }] : []),
      { role: 'delete' },
      { type: 'separator' },
      { role: 'selectAll' },
    ],
  };

  const view = {
    label: isMac ? 'View' : '&View',
    submenu: [
      { id: 'reload', label: 'Reload', accelerator: 'CommandOrControl+R', click: (_item, win) => ctx.reload(win, false) },
      { id: 'force-reload', label: 'Force Reload', accelerator: 'Shift+CommandOrControl+R', click: (_item, win) => ctx.reload(win, true) },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      // The Plus accelerator needs Shift on most layouts; this makes Cmd/Ctrl+= work too.
      { role: 'zoomIn', accelerator: 'CommandOrControl+=', visible: false },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  };

  const windowMenu = isMac
    ? {
        role: 'windowMenu',
        submenu: [
          { role: 'minimize' },
          { role: 'zoom' },
          { role: 'close' },
          { type: 'separator' },
          { role: 'front' },
        ],
      }
    : {
        label: '&Window',
        submenu: [
          { label: 'Minimize', click: (_item, win) => win?.minimize() },
          { role: 'close' },
        ],
      };

  const help = {
    role: 'help',
    label: isMac ? 'Help' : '&Help',
    submenu: [
      { id: 'help-site', label: 'Laytekz Website', click: () => openExternal(SITE_URL) },
      { id: 'help-source', label: 'Server Source Code (AGPL-3.0)', click: () => openExternal(serverSourceUrl(ctx.server())) },
      { id: 'help-privacy', label: 'Privacy', click: () => openExternal(serverPrivacyUrl(ctx.server())) },
      ...(isMac ? [] : [{ type: 'separator' }, about]),
    ],
  };

  const template = isMac
    ? [
        {
          label: app.name,
          submenu: [
            about,
            { type: 'separator' },
            changeServer,
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        },
        edit,
        view,
        windowMenu,
        help,
      ]
    : [
        { label: '&File', submenu: [changeServer, { type: 'separator' }, { role: 'quit' }] },
        edit,
        view,
        windowMenu,
        help,
      ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  return menu;
}
