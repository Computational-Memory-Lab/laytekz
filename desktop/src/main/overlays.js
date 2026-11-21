// Local pages laid over the main window: the offline screen and a small toast
// (and, Galley: V2, a shell feature's page, FeatureOverlay). They are
// separate WebContentsViews, so the remote page never gets a preload.

import { WebContentsView } from 'electron';
import { BACKGROUND } from './env.js';
import { localWebPreferences, uiWebPreferences } from './hardening.js';
import { uiUrl } from './protocol.js';
import { bindUi, lockLocalContents, pushUiState } from './ui-bridge.js';

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

  /** Galley: V2 (WP09): the view's web preferences and what it is wired to; FeatureOverlay changes both. */
  createView() {
    const view = new WebContentsView({ webPreferences: uiWebPreferences() });
    bindUi(view.webContents, { state: () => this.state, action: (n, p) => this.handle(n, p) });
    return view;
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
      this.view = this.createView();
      this.view.setBackgroundColor(this.background);
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

/**
 * Galley: V2 desktop shell (WP09). A shell feature's page laid over the main
 * window (ShellCtx.overlay): its own partition and preload (ShellPage), no
 * ui-bridge handler of its own (the feature answers through the host), and
 * the bounds the feature chooses. `onContents(webContents)` runs once the
 * view exists, so the host knows the sender; `raised()` runs after each
 * show, so the toast stays on top.
 */
export class FeatureOverlay extends Overlay {
  constructor(win, page, spec, { bounds = null, background = null, onContents = null, raised = null } = {}) {
    super(win, page, background ?? BACKGROUND);
    this.spec = spec;
    this.boundsFn = bounds;
    this.onContents = onContents;
    this.raised = raised;
  }

  createView() {
    const view = new WebContentsView({ webPreferences: localWebPreferences(this.spec) });
    lockLocalContents(view.webContents);
    this.onContents?.(view.webContents);
    return view;
  }

  bounds(width, height) {
    const b = this.boundsFn?.(width, height);
    if (b && [b.x, b.y, b.width, b.height].every(Number.isFinite)) {
      return { x: Math.round(b.x), y: Math.round(b.y), width: Math.max(0, Math.round(b.width)), height: Math.max(0, Math.round(b.height)) };
    }
    return super.bounds(width, height);
  }

  show(state = null) {
    super.show(state);
    this.raised?.();
  }

  destroy() {
    if (this.shown && this.view && !this.win.isDestroyed()) this.win.contentView.removeChildView(this.view);
    super.destroy();
  }

  /** What a feature gets back from ShellCtx.overlay: {show, hide, raise, layout, destroy, visible, contents, view, window}. */
  api() {
    const o = this;
    return Object.freeze({
      show: () => o.show(),
      hide: () => o.hide(),
      raise: () => {
        o.raise();
        o.raised?.();
      },
      layout: () => o.layout(),
      destroy: () => o.destroy(),
      get visible() { return o.visible; },
      get contents() { return o.contents; },
      get view() { return o.view; },
      get window() { return o.win; },
    });
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
