const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  platform: process.platform,
  apiBaseUrl: process.env.WUXIN_DESKTOP_API_BASE || '',
  runtime: {
    getState: () => ipcRenderer.invoke('runtime:state'),
    start: (id) => ipcRenderer.invoke('runtime:start', id),
    stop: (id) => ipcRenderer.invoke('runtime:stop', id),
    restart: (id) => ipcRenderer.invoke('runtime:restart', id),
    startAll: () => ipcRenderer.invoke('runtime:start-all'),
    stopAll: () => ipcRenderer.invoke('runtime:stop-all'),
    restartAll: () => ipcRenderer.invoke('runtime:restart-all'),
    updateSettings: (patch) => ipcRenderer.invoke('runtime:update-settings', patch),
    updateProcess: (id, patch) => ipcRenderer.invoke('runtime:update-process', id, patch),
    setAutoLaunch: (enabled) => ipcRenderer.invoke('runtime:set-auto-launch', Boolean(enabled)),
    getAutoLaunch: () => ipcRenderer.invoke('runtime:get-auto-launch'),
    onLog: (handler) => {
      const listener = (_event, message) => handler(message);
      ipcRenderer.on('runtime:log', listener);
      return () => ipcRenderer.removeListener('runtime:log', listener);
    },
  },
  window: {
    close: () => ipcRenderer.invoke('window:close'),
    minimize: () => ipcRenderer.invoke('window:minimize'),
  },
});
