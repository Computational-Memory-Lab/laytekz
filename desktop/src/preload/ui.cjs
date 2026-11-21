// Preload for the app's own laytekz-ui:// pages only (offline screen, toast,
// Change server). The remote Laytekz page never runs this.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('laytekz', {
  state: () => ipcRenderer.invoke('ui:get-state'),
  action: (name, payload) => ipcRenderer.invoke('ui:action', String(name), payload ?? null),
  onState: (callback) => {
    ipcRenderer.on('ui:state', (_event, state) => callback(state));
  },
});
