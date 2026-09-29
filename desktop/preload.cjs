const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  platform: process.platform,
  apiBaseUrl: process.env.WUXIN_DESKTOP_API_BASE || '',
  apiTransport: process.env.WUXIN_DESKTOP_API_TRANSPORT === 'fetch' ? 'fetch' : 'bridge',
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
  // Guarded loopback API bridge (S01 layer 2): requests are validated and
  // performed in the main process so the renderer never needs cross-origin
  // fetch. The renderer-side network funnel is src/lib/api.js.
  api: {
    httpRequest: (request) => ipcRenderer.invoke('api:request', request),
    cancelHttpRequest: (requestId) => ipcRenderer.invoke('api:request:cancel', requestId),
    sseOpen: (request) => ipcRenderer.invoke('api:sse:open', request),
    sseClose: (id) => ipcRenderer.invoke('api:sse:close', id),
    onSseEvent: (id, handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on(`api:sse:${id}`, listener);
      void ipcRenderer.invoke('api:sse:listen', id).then((accepted) => {
        if (!accepted) handler({ type: 'error', message: '实时追踪连接已关闭' });
      }).catch((error) => {
        handler({ type: 'error', message: String(error?.message || error) });
      });
      return () => ipcRenderer.removeListener(`api:sse:${id}`, listener);
    },
  },
});
