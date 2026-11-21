// Where the console page shows (V2, WP17): docked over the bottom of the main
// window (a WebContentsView overlay from ShellCtx.overlay), or popped out into
// its own window (ShellCtx.openLocalWindow). Only one console page exists at
// a time; switching makes a new page, which re-attaches to the running tabs.
//
// No Electron import here: everything comes through the ShellCtx and `deps`.

import { clampPanel } from './shell-env.js';

export const CONSOLE_PAGE = 'console.html';
const MIN_PANEL_PX = 120;

/**
 * deps = {
 *   ctx: ShellCtx,
 *   settings(): {panelHeight, ...}, saveSetting(key, value),
 *   detached(contents): void,      // a console page went away
 * }
 */
export function createPanel(deps) {
  const { ctx } = deps;
  let overlay = null;
  let popout = null;
  let mode = 'dock';
  let fraction = clampPanel(deps.settings().panelHeight);
  let drag = null;

  function bounds(width, height) {
    const h = Math.max(Math.min(MIN_PANEL_PX, height), Math.round(height * fraction));
    return { x: 0, y: height - h, width, height: h };
  }

  function currentOverlay() {
    const win = ctx.mainWindow();
    if (!win) return null;
    if (overlay && overlay.window === win && !win.isDestroyed()) return overlay;
    // A new main window (macOS reopen): the old overlay went with the old window.
    overlay = ctx.overlay(CONSOLE_PAGE, { bounds, background: '#1c1c1e' });
    return overlay;
  }

  function popoutOpen() {
    return !!popout && !popout.isDestroyed();
  }

  /** The console page's webContents, docked or popped out, or null. */
  function contents() {
    if (mode === 'window' && popoutOpen()) return popout.webContents;
    const c = overlay?.contents;
    return c && !c.isDestroyed() ? c : null;
  }

  function visible() {
    if (mode === 'window') return popoutOpen() && popout.isVisible();
    return !!overlay && overlay.visible && overlay.window === ctx.mainWindow();
  }

  function focused() {
    const c = contents();
    return !!c && visible() && c.isFocused();
  }

  function focusPage() {
    const c = contents();
    if (!c) return;
    c.focus();
    c.send('console:focus');
  }

  function show() {
    if (mode === 'window') {
      openPopout();
      return;
    }
    const o = currentOverlay();
    if (!o) return;
    o.show();
    focusPage();
  }

  function hide() {
    if (mode === 'window') {
      if (popoutOpen()) popout.close();
      return;
    }
    if (overlay?.visible) overlay.hide();
    const win = ctx.mainWindow();
    win?.webContents.focus();
  }

  /** Ctrl+`: show and focus; hide when the console already has focus. */
  function toggle() {
    if (visible() && focused()) hide();
    else show();
  }

  function openPopout() {
    const existed = popoutOpen();
    popout = ctx.openLocalWindow(CONSOLE_PAGE, {
      title: 'Laytekz – Console', width: 900, height: 520, minWidth: 420, minHeight: 200, hash: 'window',
    });
    if (!existed) {
      const win = popout;
      const page = win.webContents;
      win.on('closed', () => {
        if (popout === win) popout = null;
        if (mode === 'window') mode = 'dock';
        deps.detached(page);
      });
    }
    focusPage();
  }

  /** Moves the console into its own window. */
  function popOut() {
    if (mode === 'window') {
      show();
      return;
    }
    mode = 'window';
    if (overlay) {
      const page = overlay.contents;
      overlay.destroy();
      overlay = null;
      if (page) deps.detached(page);
    }
    openPopout();
  }

  /** Brings the popped-out console back over the main window. */
  function dock() {
    mode = 'dock';
    if (popoutOpen()) {
      const win = popout;
      popout = null;
      deps.detached(win.webContents);
      win.close();
    }
    show();
  }

  /** The drag handle at the top of the docked panel; `screenY` is the pointer's. */
  function dragStart(screenY) {
    const win = ctx.mainWindow();
    if (!win || !Number.isFinite(screenY)) return;
    const [, height] = win.getContentSize();
    drag = { startY: screenY, startPx: bounds(0, height).height, height };
  }

  function dragMove(screenY) {
    if (!drag || !Number.isFinite(screenY) || !overlay) return;
    const px = drag.startPx - (screenY - drag.startY);
    fraction = clampPanel(px / drag.height);
    overlay.layout();
  }

  function dragEnd() {
    if (!drag) return;
    drag = null;
    deps.saveSetting('panelHeight', Math.round(fraction * 1000) / 1000);
  }

  /** The console turned off, or quit: no page stays. */
  function destroy() {
    if (overlay) {
      const page = overlay.contents;
      overlay.destroy();
      overlay = null;
      if (page) deps.detached(page);
    }
    if (popoutOpen()) {
      const win = popout;
      popout = null;
      win.close();
    }
    mode = 'dock';
  }

  return Object.freeze({
    toggle, show, hide, popOut, dock, dragStart, dragMove, dragEnd, destroy, contents, visible,
    get mode() { return mode; },
    get fraction() { return fraction; },
  });
}
