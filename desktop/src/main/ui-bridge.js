// The only IPC in the app: local laytekz-ui:// pages ask for their state and
// report button presses. Remote pages have no preload and cannot reach this.
// Galley: V2 desktop shell (WP09): a shell feature's page on the shared
// preload (ui.cjs) is answered by that feature (features/host.js, through
// `fallback`); a feature's own channels go through the host, never here.

import { ipcMain } from 'electron';
import { UI_ORIGIN } from './protocol.js';

const handlers = new Map();

function handlerFor(event) {
  const handler = handlers.get(event.sender.id);
  const frame = event.senderFrame;
  if (!handler || !frame || frame.parent || !frame.url.startsWith(`${UI_ORIGIN}/`)) return null;
  return handler;
}

/** opts.fallback(channel, event, args): a page with no handler here (the host checks the sender itself). */
export function installUiBridge(opts = {}) {
  const fallback = (channel, event, args) => opts.fallback?.(channel, event, args) ?? null;
  ipcMain.handle('ui:get-state', (event) => {
    const handler = handlerFor(event);
    return handler ? handler.state() ?? null : fallback('ui:get-state', event, []);
  });
  ipcMain.handle('ui:action', (event, name, payload) => {
    if (typeof name !== 'string') return null;
    const handler = handlerFor(event);
    return handler ? handler.action(name, payload) : fallback('ui:action', event, [name, payload]);
  });
}

/** Local pages never go anywhere else. */
export function lockLocalContents(contents) {
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

/** handler = {state: () => object, action: (name, payload) => any}. */
export function bindUi(contents, handler) {
  const id = contents.id;
  handlers.set(id, handler);
  contents.once('destroyed', () => handlers.delete(id));
  lockLocalContents(contents);
}

export function pushUiState(contents, state) {
  if (contents && !contents.isDestroyed()) contents.send('ui:state', state);
}
