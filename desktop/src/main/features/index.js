// Laytekz V2 shell features (WP01, frozen). The shell host (features/host.js,
// WP09) starts them; main.js and the other src/main/*.js files never import a
// feature directly. Only the integrator edits this list; a package fills its
// own features/<id>/. Nothing imports this file until WP09's host does, and
// no feature module may import 'electron' at its top level, so this list
// loads in plain Node (the unit tests).

import consoleFeature from './console/index.js';
import desktopSettingsFeature from './desktopSettings/index.js';
import bibwatchFeature from './bibwatch/index.js';

/**
 * @typedef {object} ShellPage A local page under src/ui, served as laytekz-ui://app/<name>.
 * @property {string} [csp] Replaces protocol.js UI_CSP for this page only.
 * @property {string} [preload] A file under src/preload; pages without one get none.
 * @property {string} [partition] Its own session partition ('persist:laytekz-console'); default the UI session.
 */

/**
 * @typedef {object} ShellFeature
 * @property {'console'|'desktopSettings'|'bibwatch'} id
 * @property {{ where: 'app'|'file'|'view'|'help', item: import('electron').MenuItemConstructorOptions }[]} [menu]
 *   Items the menu builder (menu.js) places in that menu. An accelerator must
 *   not shadow a web chord (plan §2.3; WP09's shell.spec.mjs checks).
 * @property {Record<string, ShellPage>} [pages] Keyed by the file name under src/ui ('console.html').
 * @property {string[]} [vetoPermissions] Permissions refused to the remote page while this feature runs ('clipboard-read').
 * @property {string} [settingsPage] The page opened for <base>/settings/desktop-app. Only desktopSettings sets it.
 * @property {(ctx: ShellCtx) => void | (() => void)} [start] After the main window exists; the returned function runs at quit.
 */

/**
 * @typedef {object} ShellCtx What the host (WP09) hands a feature's start().
 * @property {() => string | null} server The server base URL in use, or null before one is chosen.
 * @property {() => import('electron').BrowserWindow | null} mainWindow
 * @property {{ get: (key: string, fallback?: unknown) => unknown, set: (key: string, value: unknown) => void }} settings
 *   This feature's own namespace in settings.json ('features.<id>.<key>').
 * @property {(url: string) => { id: string, branch: string } | null} projectFromUrl A /p/<id> URL of the current server.
 * @property {(path: string, init?: RequestInit) => Promise<Response>} sessionFetch
 *   A request to the current server in the main window's session (its cookie, no Origin header).
 * @property {{ handle: (channel: string, fn: (event: import('electron').IpcMainInvokeEvent, ...args: unknown[]) => unknown, opts: { pages: string[] }) => () => void }} ipc
 *   ipcMain.handle that refuses every sender frame not on one of `pages` (laytekz-ui://app/<page>).
 * @property {(page: string, opts?: object) => import('electron').BrowserWindow} openLocalWindow A window on one of this feature's pages.
 * @property {(page: string, opts?: object) => unknown} overlay A view over the main window (overlays.js) on one of this feature's pages.
 * @property {() => void} rebuildMenu Rebuilds the app menu, re-reading each item's `visible` when it is a function.
 */

/** @type {readonly ShellFeature[]} */
export const SHELL_FEATURES = Object.freeze([consoleFeature, desktopSettingsFeature, bibwatchFeature]);
