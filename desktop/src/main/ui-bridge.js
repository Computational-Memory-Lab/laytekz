// The only IPC in the app: local laytekz-ui:// pages ask for their state and
// report button presses. Remote pages have no preload and cannot reach this.

import { ipcMain } from 'electron';
import { UI_ORIGIN } from './protocol.js';

const handlers = new Map();

function handlerFor(event) {
  const handler = handlers.get(event.sender.id);
  const frame = event.senderFrame;
  if (!handler || !frame || frame.parent || !frame.url.startsWith(`${UI_ORIGIN}/`)) return null;
  return handler;
}

export function installUiBridge() {
  ipcMain.handle('ui:get-state', (event) => handlerFor(event)?.state() ?? null);
  ipcMain.handle('ui:action', (event, name, payload) => {
    const handler = handlerFor(event);
    if (!handler || typeof name !== 'string') return null;
    return handler.action(name, payload);
  });
}

/** handler = {state: () => object, action: (name, payload) => any}. */
export function bindUi(contents, handler) {
  const id = contents.id;
  handlers.set(id, handler);
  contents.once('destroyed', () => handlers.delete(id));
  // Local pages never go anywhere else.
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

export function pushUiState(contents, state) {
  if (contents && !contents.isDestroyed()) contents.send('ui:state', state);
}
