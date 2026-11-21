// Local pages laid over the main window: the offline screen and a small toast.
// They are separate WebContentsViews, so the remote page never gets a preload.

import { WebContentsView } from 'electron';
import { BACKGROUND } from './env.js';
import { uiWebPreferences } from './hardening.js';
import { uiUrl } from './protocol.js';
import { bindUi, pushUiState } from './ui-bridge.js';

class Overlay {
  constructor(win, page, background) {
    this.win = win;
    this.page = page;
    this.background = background;
    this.view = null;
    this.state = null;
    this.shown = false;
    win.on('resize', () => this.layout());
    win.on('closed', () => this.destroy());
  }

  /** Subclasses: where the view sits inside a content area of width × height. */
  bounds(width, height) {
    return { x: 0, y: 0, width, height };
  }

  /** Subclasses: a button or report from the page. */
  handle() {}

  get contents() {
    return this.view?.webContents ?? null;
  }

  get visible() {
    return this.shown;
  }

  show(state) {
    if (this.win.isDestroyed()) return;
    this.state = state;
    if (!this.view) {
      this.view = new WebContentsView({ webPreferences: uiWebPreferences() });
      this.view.setBackgroundColor(this.background);
      bindUi(this.view.webContents, { state: () => this.state, action: (n, p) => this.handle(n, p) });
      this.view.webContents.loadURL(uiUrl(this.page));
    }
    // Adding a view that is already a child moves it to the top.
    this.win.contentView.addChildView(this.view);
    this.shown = true;
    this.layout();
    pushUiState(this.view.webContents, state);
  }

  hide() {
    if (!this.shown || this.win.isDestroyed()) return;
    this.shown = false;
    this.win.contentView.removeChildView(this.view);
  }

  raise() {
    if (this.shown && !this.win.isDestroyed()) this.win.contentView.addChildView(this.view);
  }

  layout() {
    if (!this.view || this.win.isDestroyed()) return;
    const [width, height] = this.win.getContentSize();
    this.view.setBounds(this.bounds(width, height));
  }

  destroy() {
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.close();
    this.view = null;
    this.shown = false;
  }
}

/** Full-window page: why the server cannot be reached, with Retry and Change server. */
export class OfflineScreen extends Overlay {
  constructor(win, onAction) {
    super(win, 'offline.html', BACKGROUND);
    this.onAction = onAction;
  }

  handle(name, payload) {
    return this.onAction(name, payload);
  }
}

const TOAST_WIDTH = 560;
const TOAST_MARGIN = 20;

/**
 * A card at the bottom of the window. show({message, tone, actions: [{label,
 * run, primary, keepOpen}], dismissible, timeoutMs, key}); hide(key) hides it
 * only while it still shows the toast with that key.
 */
export class Toast extends Overlay {
  constructor(win) {
    super(win, 'toast.html', '#2c2c30');
    this.height = 56;
    this.actions = [];
    this.key = null;
    this.timer = null;
  }

  bounds(width, height) {
    const w = Math.max(240, Math.min(TOAST_WIDTH, width - 2 * TOAST_MARGIN));
    return { x: Math.round((width - w) / 2), y: Math.max(0, height - this.height - TOAST_MARGIN), width: w, height: this.height };
  }

  show({ message, tone = 'info', actions = [], dismissible = true, timeoutMs = 0, key = null }) {
    clearTimeout(this.timer);
    this.actions = actions;
    this.key = key;
    super.show({
      message,
      tone,
      dismissible,
      actions: actions.map((a, i) => ({ id: i, label: a.label, primary: !!a.primary })),
    });
    this.view?.setBorderRadius(12);
    if (timeoutMs) this.timer = setTimeout(() => this.hide(key), timeoutMs);
  }

  hide(key) {
    if (key !== undefined && key !== this.key) return;
    clearTimeout(this.timer);
    this.key = null;
    this.actions = [];
    super.hide();
  }

  handle(name, payload) {
    if (name === 'resize') {
      const h = Math.round(Number(payload));
      if (Number.isFinite(h)) this.height = Math.max(44, Math.min(160, h));
      this.layout();
    } else if (name === 'dismiss') {
      this.hide();
    } else if (name === 'action') {
      const action = this.actions[Number(payload)];
      if (!action) return;
      if (!action.keepOpen) this.hide();
      action.run?.();
    }
  }
}
