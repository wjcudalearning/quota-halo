'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codenotch', {
  onSnapshot: (cb) => ipcRenderer.on('snapshot', (_e, payload) => cb(payload)),
  onMode: (cb) => ipcRenderer.on('mode', (_e, mode) => cb(mode)),
  action: (type) => ipcRenderer.send('ui:action', type),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  probeCredentials: () => ipcRenderer.invoke('settings:probe'),
  pickCredentials: () => ipcRenderer.invoke('settings:pickCredentials'),
  openExternal: (url) => ipcRenderer.invoke('dialog:openExternal', url),
});
