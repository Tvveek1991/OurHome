const { app, BrowserWindow, shell, ipcMain, Menu, Notification, Tray, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const SYNC_PORT = 32145;
const MAX_BODY_SIZE = 1024 * 1024;
let syncServer;
let syncInfo;
let syncServerStarting;
let updateState = { status: 'idle', currentVersion: app.getVersion() };
let mainWindow;
let tray;
let isQuitting = false;

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

function createTrayIcon() {
  const size = 32;
  const pixels = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    for (let x = 0; x < size; x += 1) {
      const offset = row + 1 + x * 4;
      const corner = (x < 4 || x > 27) && (y < 4 || y > 27);
      const inCorner = (x < 4 ? 4 - x : x - 27) ** 2 + (y < 4 ? 4 - y : y - 27) ** 2 <= 16;
      if (!corner || inCorner) pixels.set([112, 147, 117, 255], offset);

      const roof = y >= 8 && y <= 17 && Math.abs(x - 15.5) <= (y - 8) * 1.25;
      const house = y >= 17 && y <= 25 && x >= 8 && x <= 23;
      if (roof || house) pixels.set([247, 243, 236, 255], offset);
      if (y >= 20 && y <= 25 && x >= 13 && x <= 18) pixels.set([217, 139, 104, 255], offset);
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
  return nativeImage.createFromBuffer(png);
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (tray) return tray;

  const icon = createTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip('Наш дом');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть «Наш дом»', click: showMainWindow },
    { type: 'separator' },
    {
      label: 'Выйти',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]));
  tray.on('double-click', showMainWindow);
  return tray;
}

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
      // Keep daily rollover and notification timers running while hidden in the tray.
      backgroundThrottling: false,
      sandbox: true
    }
  });

  window.loadFile(path.join(__dirname, 'dist', 'index.html'));

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  window.on('minimize', (event) => {
    event.preventDefault();
    window.hide();
  });
  window.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    window.hide();
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined;
  });

  mainWindow = window;
  return window;
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.nashdom.organizer');
  configureAutoUpdater();
  ipcMain.handle('sync:server-info', () => startSyncServer());
  ipcMain.handle('notifications:show', (_event, payload = {}) => {
    if (!Notification.isSupported()) return { shown: false, reason: 'unsupported' };

    const title = String(payload.title || 'Наш дом').slice(0, 120);
    const body = String(payload.body || '').slice(0, 500);
    if (!body) return { shown: false, reason: 'empty' };

    const notification = new Notification({ title, body });
    notification.on('click', () => {
      showMainWindow();
    });
    notification.show();
    return { shown: true };
  });
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
    if (app.isPackaged && updateState.status === 'downloaded') {
      isQuitting = true;
      autoUpdater.quitAndInstall();
    }
  });
  createWindow();
  createTray();
  app.on('activate', () => {
    showMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (isQuitting) app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  syncServer?.close();
});
