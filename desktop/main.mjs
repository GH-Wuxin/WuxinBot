import { app, BrowserWindow, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProcessManager } from './process-manager.mjs';
import { desktopAllowedOrigins, isAllowedDesktopUrl } from './ipc-guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(__dirname, '..');
const packagedRoot = path.join(process.resourcesPath, 'app.asar.unpacked');
const projectRoot = process.env.WUXIN_PROJECT_ROOT || (app.isPackaged ? packagedRoot : sourceRoot);
const devUrl = process.env.WUXIN_DEV_SERVER_URL || '';
const productionApi = 'http://127.0.0.1:8787';
process.env.WUXIN_DESKTOP_API_BASE = devUrl ? '' : productionApi;
// IPC senders and top-level navigation must stay inside the app's own
// origins (S01 layer 1). External content is handed to the system browser.
const allowedOrigins = desktopAllowedOrigins({ devUrl, apiBase: productionApi });

let mainWindow = null;
let manager = null;
let quitting = false;
let shutdownPromise = null;
let diagnosticLogPath = null;

function log(message) {
  const line = `[desktop] ${message}`;
  console.log(line);
  if (!diagnosticLogPath) return;
  try { fs.appendFileSync(diagnosticLogPath, `${new Date().toISOString()} ${line}\n`); } catch { /* logging must not block startup */ }
}

function sendLog(message) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('runtime:log', message);
}

function autoLaunchState() {
  try { return Boolean(app.getLoginItemSettings().openAtLogin); } catch { return false; }
}

function setAutoLaunch(enabled) {
  const args = process.defaultApp ? [app.getAppPath()] : [];
  app.setLoginItemSettings({
    openAtLogin: Boolean(enabled),
    path: process.execPath,
    args,
    openAsHidden: false,
  });
  return autoLaunchState();
}

async function loadUrlWithRetry(url, attempts = 16) {
  let lastError = null;
  for (let index = 0; index < attempts; index += 1) {
    try {
      await mainWindow.loadURL(url);
      const title = await mainWindow.webContents.executeJavaScript('document.title', true);
      if (title === 'Error') throw new Error('服务器根路径返回了浏览器错误页');
      return true;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (lastError) log(`无法加载 ${url}：${lastError.message || lastError}`);
  return false;
}

async function loadConsole() {
  const localIndex = path.join(projectRoot, 'dist', 'index.html');
  // The browser entry is intentionally removed from the server. Packaged
  // Desktop therefore loads its bundled renderer directly and talks to the
  // loopback API through preload's apiBaseUrl. Dev mode still uses Vite so
  // hot reload remains available.
  if (!devUrl && fs.existsSync(localIndex)) {
    log(`加载本地控制台：${localIndex}`);
    try {
      await mainWindow.loadFile(localIndex);
      log(`本地控制台已加载：${localIndex}`);
      return;
    } catch (error) {
      log(`本地控制台加载失败：${error.message || error}`);
    }
  }
  const preferredUrl = devUrl || productionApi;
  log(`加载控制台：${preferredUrl}`);
  const loaded = await loadUrlWithRetry(preferredUrl, devUrl ? 12 : (manager?.settings.startOnOpen ? 20 : 3));
  if (loaded) { log(`控制台已加载：${preferredUrl}`); return; }
  log(`控制台无法加载：${preferredUrl}`);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 680,
    title: 'WuxinBot · Desktop',
    backgroundColor: '#17141f',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // The fallback file:// page still needs to reach the loopback API when
      // the bot is stopped on first launch. The renderer is local, and the
      // API base is always loopback-only.
      webSecurity: false,
    },
  });
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    log(`渲染器加载失败：code=${errorCode} description=${errorDescription} url=${validatedURL} mainFrame=${isMainFrame}`);
  });
  mainWindow.webContents.on('did-finish-load', () => log(`渲染器完成加载：${mainWindow.webContents.getURL()}`));
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log(`渲染器进程结束：reason=${details.reason} exitCode=${details.exitCode}`);
  });
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) log(`渲染器控制台：${message} (${sourceId}:${line})`);
  });
  mainWindow.on('unresponsive', () => log('窗口无响应'));
  // External content never opens inside the app: http(s) targets go to the
  // system browser (this keeps the Codex OAuth flow working through the
  // Models page's fallback), everything else is denied (S01).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      if (target.protocol === 'http:' || target.protocol === 'https:') {
        void shell.openExternal(url);
        return { action: 'deny' };
      }
    } catch { /* fall through to deny */ }
    log(`已阻止弹窗打开：${url}`);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAllowedDesktopUrl(url, allowedOrigins)) return;
    event.preventDefault();
    log(`已阻止导航到未授权页面：${url}`);
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  void loadConsole();
}

async function shutdownManagedProcesses() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    if (!manager) return;
    const settings = manager.settings;
    if (settings.stopOnClose !== false) {
      log('窗口关闭，停止本窗口启动的进程');
    }
    await manager.shutdown();
  })();
  return shutdownPromise;
}

function isTrustedIpcSender(event) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (event?.sender !== mainWindow.webContents) return false;
  const frameUrl = String(event?.senderFrame?.url || '');
  return isAllowedDesktopUrl(frameUrl, allowedOrigins);
}

// Every runtime IPC handler goes through this guard: a compromised or foreign
// renderer (other origins, iframes, foreign windows) must not reach process
// management (S01 layer 1).
function guardIpc(handler) {
  return (event, ...args) => {
    if (!isTrustedIpcSender(event)) {
      log(`已拒绝未授权来源的 IPC 调用：${event?.senderFrame?.url || 'unknown'}`);
      throw new Error('DESKTOP_IPC_UNTRUSTED_SENDER');
    }
    return handler(event, ...args);
  };
}

function registerIpc() {
  ipcMain.handle('runtime:state', guardIpc(() => manager.state()));
  ipcMain.handle('runtime:start', guardIpc((_event, id) => manager.start(String(id))));
  ipcMain.handle('runtime:stop', guardIpc((_event, id) => manager.stop(String(id))));
  ipcMain.handle('runtime:restart', guardIpc((_event, id) => manager.restart(String(id))));
  ipcMain.handle('runtime:start-all', guardIpc(() => manager.startAll()));
  ipcMain.handle('runtime:stop-all', guardIpc(() => manager.stopAll()));
  ipcMain.handle('runtime:restart-all', guardIpc(() => manager.restartAll()));
  ipcMain.handle('runtime:update-settings', guardIpc((_event, patch) => manager.updateSettings(patch)));
  ipcMain.handle('runtime:update-process', guardIpc((_event, id, patch) => manager.updateProcess(String(id), patch || {})));
  ipcMain.handle('runtime:get-auto-launch', guardIpc(() => autoLaunchState()));
  ipcMain.handle('runtime:set-auto-launch', guardIpc(async (_event, enabled) => {
    const value = setAutoLaunch(Boolean(enabled));
    await manager.updateSettings({ autoLaunch: value });
    return value;
  }));
  ipcMain.handle('window:minimize', guardIpc(() => mainWindow?.minimize()));
  ipcMain.handle('window:close', guardIpc(() => mainWindow?.close()));
}

async function boot() {
  await app.whenReady();
  diagnosticLogPath = path.join(app.getPath('userData'), 'desktop-main.log');
  try { fs.writeFileSync(diagnosticLogPath, ''); } catch { /* continue without file logging */ }
  log(`启动：isPackaged=${app.isPackaged} appPath=${app.getAppPath()} projectRoot=${projectRoot}`);
  manager = new ProcessManager({
    projectRoot,
    configDir: app.getPath('userData'),
    onLog: sendLog,
  });
  await manager.initialize();
  registerIpc();
  const storedAutoLaunch = autoLaunchState();
  if (storedAutoLaunch !== manager.settings.autoLaunch) await manager.updateSettings({ autoLaunch: storedAutoLaunch });

  createWindow();
  if (manager.settings.startOnOpen) {
    log('按设置启动已启用组件');
    void manager.startAll({ onlyAutoStart: true });
  }
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void shutdownManagedProcesses().catch((error) => log(`进程清理失败：${error.message || error}`)).finally(() => app.exit(0));
  });
  app.on('window-all-closed', () => app.quit());
  void boot().catch((error) => {
    log(`Desktop 启动失败：${error?.stack || error}`);
    app.quit();
  });
}
