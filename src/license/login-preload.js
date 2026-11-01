'use strict';
// Preload for the login window. Narrow surface: just activate + a couple of helpers.

const { contextBridge, ipcRenderer, shell } = require('electron');

contextBridge.exposeInMainWorld('licenseApi', {
  deviceInfo: () => ipcRenderer.invoke('license:device-info'),
  activate: (key) => ipcRenderer.invoke('license:activate', key),
  proceed: () => ipcRenderer.send('license:proceed'),
  openExternal: (url) => shell.openExternal(url),
});
