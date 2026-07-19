'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getPathForFile: (file) => webUtils.getPathForFile(file),
  openSnippetManager: () => ipcRenderer.invoke('open-snippet-manager'),
  selectFolder: (defaultPath) => ipcRenderer.invoke('select-folder', defaultPath),
});
