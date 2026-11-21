// The application menu.
//
// Accelerators stay off the web UI's own chords: it uses Cmd/Ctrl + S, K, J,
// F, G, D, B, I, /, [, ], Enter, Shift+M, Shift+F, Shift+K, Shift+G, Alt+G and
// Shift+Alt+F, and CodeMirror takes Ctrl+M on Windows (Tab focus mode), so
// Minimize has no accelerator there. Edit roles share keys with the editor on
// purpose (they do the same thing), and the page sees every key first.
//
// Galley: V2 desktop shell (WP09). The full list is rules.js WEB_CHORDS
// (plan §2.3); tests/shell.spec.mjs checks every accelerator against it.
// Settings… takes Cmd/Ctrl+, (the web app skips its own handler for that
// chord in the desktop app), so Change Server… has none. Shell features
// add items through the host (features/host.js): 'app' items after Change
// Server… (in File on Windows), 'file' items in File (a File menu appears on
// macOS only when a feature has one), 'view' items after the developer
// tools, 'help' items after Privacy.

import { app, Menu } from 'electron';
import { SITE_URL } from './env.js';
import { serverPrivacyUrl, serverSourceUrl } from './dialogs.js';
import { openExternal } from './external.js';

const isMac = process.platform === 'darwin';

/**
 * ctx = {about(), settings(win), changeServer(), reload(win, ignoreCache), server(),
 * items(where) → the shell features' items for 'app' | 'file' | 'view' | 'help'}.
 */
export function buildMenu(ctx) {
  const items = (where) => ctx.items?.(where) ?? [];
  const section = (list) => (list.length ? [{ type: 'separator' }, ...list] : []);
  const settings = {
    id: 'settings',
    label: isMac ? 'Settings…' : 'Se&ttings…',
    accelerator: 'CommandOrControl+,',
    click: (_item, win) => ctx.settings(win),
  };
  const changeServer = {
    id: 'change-server',
    label: isMac ? 'Change Server…' : 'Change &Server…',
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
      ...section(items('view')),
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
      ...section(items('help')),
      ...(isMac ? [] : [{ type: 'separator' }, about]),
    ],
  };

  const fileItems = items('file');
  const template = isMac
    ? [
        {
          label: app.name,
          submenu: [
            about,
            { type: 'separator' },
            settings,
            changeServer,
            ...items('app'),
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
        ...(fileItems.length ? [{ label: 'File', submenu: fileItems }] : []),
        edit,
        view,
        windowMenu,
        help,
      ]
    : [
        { label: '&File', submenu: [settings, changeServer, ...items('app'), ...section(fileItems), { type: 'separator' }, { role: 'quit' }] },
        edit,
        view,
        windowMenu,
        help,
      ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  return menu;
}
