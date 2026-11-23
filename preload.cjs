const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('homeSync', {
  serverInfo: () => ipcRenderer.invoke('sync:server-info')
});

contextBridge.exposeInMainWorld('homeNotifications', {
  show: (payload) => ipcRenderer.invoke('notifications:show', payload)
});

contextBridge.exposeInMainWorld('homeUpdater', {
  state: () => ipcRenderer.invoke('updater:state'),
  check: () => ipcRenderer.invoke('updater:check'),
  download: () => ipcRenderer.invoke('updater:download'),
  install: () => ipcRenderer.invoke('updater:install'),
  onStatus: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('updater:status', listener);
    return () => ipcRenderer.removeListener('updater:status', listener);
  }
});
