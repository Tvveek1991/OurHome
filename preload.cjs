const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('homeSync', {
  serverInfo: () => ipcRenderer.invoke('sync:server-info')
});
