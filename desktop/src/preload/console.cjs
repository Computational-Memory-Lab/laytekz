// Preload for the console's own pages (laytekz-ui://app/console.html and
// console-settings.html, in the laytekz-console partition). The remote
// Laytekz page never runs this; the main process checks every call's sender
// (features/host.js) before the console answers it. V2, WP17.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

/** A subscription to one event from main; returns the unsubscribe function. */
const listen = (channel) => (callback) => {
  if (typeof callback !== 'function') return () => {};
  const fn = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld('laytekzConsole', {
  hello: () => invoke('console:hello'),
  create: (cols, rows) => invoke('console:create', { cols: Number(cols) | 0, rows: Number(rows) | 0 }),
  replay: (id) => invoke('console:replay', String(id)),
  input: (id, data) => invoke('console:input', String(id), String(data)),
  resize: (id, cols, rows) => invoke('console:resize', String(id), Number(cols) | 0, Number(rows) | 0),
  ack: (id, chars) => invoke('console:ack', String(id), Number(chars) || 0),
  close: (id) => invoke('console:close', String(id)),
  restart: (id) => invoke('console:restart', String(id)),
  panel: (action, value) => invoke('console:panel', String(action), value === undefined ? null : Number(value)),
  openLink: (url) => invoke('console:open-link', String(url)),
  getSettings: () => invoke('console:get-settings'),
  setSetting: (key, value) => invoke('console:set-setting', String(key), value),
  // V2, WP25: the agent buttons.
  agentStatus: () => invoke('console:agent-status'),
  launchAgent: (kind, cols, rows) => invoke('console:agent-launch', String(kind), { cols: Number(cols) | 0, rows: Number(rows) | 0 }),
  copy: (text) => invoke('console:copy', String(text)),
  onData: listen('console:data'),
  onExit: listen('console:exit'),
  onTitle: listen('console:title'),
  onSettings: listen('console:settings'),
  onFocus: listen('console:focus'),
});
