const { app, BrowserWindow, shell, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const SYNC_PORT = 32145;
const MAX_BODY_SIZE = 1024 * 1024;
let syncServer;
let syncInfo;
let syncServerStarting;
let updateState = { status: 'idle', currentVersion: app.getVersion() };

function publishUpdateState(nextState) {
  updateState = { ...updateState, ...nextState };
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('updater:status', updateState);
  }
}

function configureAutoUpdater() {
  // Updates are only available from an installed, packaged application.
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on('checking-for-update', () => publishUpdateState({ status: 'checking', message: 'Проверяем обновления…' }));
  autoUpdater.on('update-available', (info) => publishUpdateState({ status: 'available', availableVersion: info.version, message: `Доступна версия ${info.version}.` }));
  autoUpdater.on('update-not-available', () => publishUpdateState({ status: 'not-available', message: 'Установлена последняя версия.' }));
  autoUpdater.on('download-progress', (progress) => publishUpdateState({ status: 'downloading', percent: Math.round(progress.percent), message: `Скачивание: ${Math.round(progress.percent)}%.` }));
  autoUpdater.on('update-downloaded', (info) => publishUpdateState({ status: 'downloaded', availableVersion: info.version, percent: 100, message: `Версия ${info.version} готова к установке.` }));
  autoUpdater.on('error', (error) => {
    console.error(`Ошибка обновления: ${error.message}`);
    publishUpdateState({ status: 'error', message: 'Не удалось проверить или скачать обновление. Повторите позже.' });
  });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  const temporaryFile = `${file}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporaryFile, file);
}

function localAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((address) => address && address.family === 'IPv4' && !address.internal)
    .map((address) => address.address);
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Our-Home-Key',
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(body));
}

function startSyncServer() {
  if (syncServerStarting) return syncServerStarting;
  const configFile = path.join(app.getPath('userData'), 'sync-server-config.json');
  const stateFile = path.join(app.getPath('userData'), 'shared-home-state.json');
  const config = readJson(configFile, {});
  const accessKey = config.accessKey || crypto.randomBytes(24).toString('base64url');
  if (!config.accessKey) writeJson(configFile, { accessKey });

  let record = readJson(stateFile, { revision: 0, state: null, updatedAt: null });
  syncInfo = { port: SYNC_PORT, accessKey, addresses: localAddresses(), hasState: Boolean(record.state) };

  syncServer = http.createServer((request, response) => {
    if (request.method === 'OPTIONS') {
      sendJson(response, 204, {});
      return;
    }
    if (request.url !== '/api/state') {
      sendJson(response, 404, { error: 'Не найдено.' });
      return;
    }
    if (request.headers['x-our-home-key'] !== accessKey) {
      sendJson(response, 401, { error: 'Неверный код подключения.' });
      return;
    }
    if (request.method === 'GET') {
      sendJson(response, 200, record);
      return;
    }
    if (request.method !== 'PUT') {
      sendJson(response, 405, { error: 'Метод не поддерживается.' });
      return;
    }

    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_SIZE) request.destroy();
    });
    request.on('end', () => {
      try {
        const payload = JSON.parse(body);
        if (!payload || typeof payload.state !== 'object' || Array.isArray(payload.state)) throw new Error('bad state');
        if (Number.isInteger(payload.revision) && payload.revision !== record.revision) {
          sendJson(response, 409, record);
          return;
        }
        record = { revision: record.revision + 1, state: payload.state, updatedAt: new Date().toISOString() };
        writeJson(stateFile, record);
        syncInfo.hasState = true;
        sendJson(response, 200, record);
      } catch {
        sendJson(response, 400, { error: 'Не удалось прочитать данные синхронизации.' });
      }
    });
  });

  syncServer.on('error', (error) => {
    console.error(`Сервер синхронизации не запущен: ${error.message}`);
  });
  syncServerStarting = new Promise((resolve, reject) => {
    syncServer.once('listening', () => resolve(syncInfo));
    syncServer.once('error', reject);
  });
  syncServer.listen(SYNC_PORT, '0.0.0.0');
  return syncServerStarting;
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 390,
    minHeight: 650,
    title: 'Наш дом',
    backgroundColor: '#f7f3ec',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  window.loadFile(path.join(__dirname, 'dist', 'index.html'));

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  configureAutoUpdater();
  ipcMain.handle('sync:server-info', () => startSyncServer());
  ipcMain.handle('updater:state', () => ({ ...updateState, supported: app.isPackaged }));
  ipcMain.handle('updater:check', async () => {
    if (!app.isPackaged) return { ...updateState, supported: false };
    await autoUpdater.checkForUpdates();
    return { ...updateState, supported: true };
  });
  ipcMain.handle('updater:download', async () => {
    if (!app.isPackaged) return { ...updateState, supported: false };
    await autoUpdater.downloadUpdate();
    return { ...updateState, supported: true };
  });
  ipcMain.handle('updater:install', () => {
    if (app.isPackaged && updateState.status === 'downloaded') autoUpdater.quitAndInstall();
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  syncServer?.close();
});
