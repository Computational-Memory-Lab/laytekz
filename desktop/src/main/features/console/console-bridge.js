// The console's IPC (V2, WP17). Every channel goes through ShellCtx.ipc.handle,
// which answers only the top frame of a console page this feature opened
// (laytekz-ui://app/console.html or console-settings.html, in the
// laytekz-console partition). The remote page has no preload and no IPC at
// all; the toast, offline and other feature pages are refused by the host.
//
// Output and events go the other way with webContents.send, only ever to the
// one console page that last said hello.

import { checkSetting, linkAllowed } from './shell-env.js';

const str = (v, max = 64) => (typeof v === 'string' && v.length <= max ? v : null);

/**
 * deps = {
 *   ctx, sessions, panel,
 *   settings(): object, setSetting(key, value): object,   // returns the new settings
 *   openSettingsWindow(): void, openExternal(url): void,
 *   attach(contents): void,                                // the page that receives output from now on
 *   platform: string,
 * }
 */
export function installBridge(deps) {
  const { ctx, sessions, panel } = deps;
  const CONSOLE = { pages: ['console.html'] };
  const BOTH = { pages: ['console.html', 'console-settings.html'] };
  const SETTINGS_ONLY = { pages: ['console-settings.html'] };
  const off = [];
  const on = (channel, fn, opts) => off.push(ctx.ipc.handle(channel, fn, opts));
  const enabled = () => deps.settings().enabled;

  on('console:hello', (event) => {
    if (!enabled()) return null;
    deps.attach(event.sender);
    return { settings: deps.settings(), sessions: sessions.list(), mode: panel.mode, platform: deps.platform };
  }, CONSOLE);

  on('console:create', (_event, size) => {
    if (!enabled()) return null;
    const cols = Number.isInteger(size?.cols) ? size.cols : undefined;
    const rows = Number.isInteger(size?.rows) ? size.rows : undefined;
    return sessions.create({ cols, rows });
  }, CONSOLE);

  on('console:replay', (_event, id) => (str(id) ? sessions.replay(id) : null), CONSOLE);
  on('console:input', (_event, id, data) => (str(id) && typeof data === 'string' ? sessions.input(id, data) : false), CONSOLE);
  on('console:resize', (_event, id, cols, rows) => (str(id) ? sessions.resize(id, cols, rows) : false), CONSOLE);
  on('console:ack', (_event, id, chars) => {
    if (str(id)) sessions.ack(id, Number(chars));
    return null;
  }, CONSOLE);
  on('console:close', (_event, id) => (str(id) ? sessions.close(id) : false), CONSOLE);
  on('console:restart', (_event, id) => (str(id) ? sessions.restart(id) : false), CONSOLE);

  on('console:panel', (_event, action, value) => {
    switch (action) {
      case 'hide': panel.hide(); break;
      case 'popout': panel.popOut(); break;
      case 'dock': panel.dock(); break;
      case 'drag-start': panel.dragStart(Number(value)); break;
      case 'drag-move': panel.dragMove(Number(value)); break;
      case 'drag-end': panel.dragEnd(); break;
      case 'settings': deps.openSettingsWindow(); break;
      default: return false;
    }
    return true;
  }, CONSOLE);

  on('console:open-link', (_event, url) => {
    if (typeof url !== 'string' || url.length > 4096 || !linkAllowed(url)) return false;
    deps.openExternal(url);
    return true;
  }, CONSOLE);

  on('console:get-settings', () => deps.settings(), BOTH);

  on('console:set-setting', (_event, key, value) => {
    if (typeof key !== 'string' || key === 'panelHeight' || checkSetting(key, value) === null) return null;
    return deps.setSetting(key, value);
  }, SETTINGS_ONLY);

  return () => {
    for (const dispose of off.splice(0)) dispose();
  };
}
