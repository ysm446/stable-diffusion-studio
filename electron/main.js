'use strict';

const { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu } = require('electron');
const path = require('path');
const http = require('http');

const PORT = 8785;
const SERVER_URL = `http://127.0.0.1:${PORT}`;

let mainWindow = null;
let snippetManagerWindow = null;
const iconPath = process.platform === 'win32'
  ? path.join(__dirname, '..', 'assets', 'app_icon.ico')
  : path.join(__dirname, '..', 'assets', 'app_icon.png');

// ---------------------------------------------------------------------------
// Python サーバーが起動するまで待機
// (サーバーは start.bat がプロジェクト venv 有効化後に起動済み)
// ---------------------------------------------------------------------------

function waitForServer(retries = 60) {
  return new Promise((resolve, reject) => {
    const check = remaining => {
      if (remaining <= 0) {
        reject(new Error('Server did not start within 60 seconds.'));
        return;
      }
      const req = http.get(`${SERVER_URL}/api/settings`, res => {
        if (res.statusCode === 200) {
          resolve();
        } else {
          setTimeout(() => check(remaining - 1), 1000);
        }
        res.resume();
      });
      req.on('error', () => setTimeout(() => check(remaining - 1), 1000));
      req.setTimeout(800, () => {
        req.destroy();
        setTimeout(() => check(remaining - 1), 500);
      });
    };
    check(retries);
  });
}

// ---------------------------------------------------------------------------
// ウィンドウ作成
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1200,
    minWidth: 900,
    minHeight: 600,
    title: 'Stable Diffusion Studio',
    icon: iconPath,
    backgroundColor: '#1c1c1c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(SERVER_URL);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createSnippetManagerWindow() {
  if (snippetManagerWindow && !snippetManagerWindow.isDestroyed()) {
    snippetManagerWindow.focus();
    return snippetManagerWindow;
  }

  snippetManagerWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: 'Snippet Manager',
    icon: iconPath,
    backgroundColor: '#1c1c1c',
    parent: mainWindow || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  snippetManagerWindow.loadURL(`${SERVER_URL}/frontend/snippet-manager.html`);
  snippetManagerWindow.on('closed', () => {
    snippetManagerWindow = null;
  });

  return snippetManagerWindow;
}

// ---------------------------------------------------------------------------
// アプリライフサイクル
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  // メニューバーを完全に削除
  Menu.setApplicationMenu(null);

  // ディスクキャッシュを無効化（開発中のデザイン変更を即時反映）
  app.commandLine.appendSwitch('disable-http-cache');
  try {
    await waitForServer();
  } catch (err) {
    dialog.showErrorBox(
      'Server not found',
      `Could not connect to Python server at ${SERVER_URL}.\n\nMake sure to launch via start.bat which starts the server first.\n\n${err.message}`
    );
    app.quit();
    return;
  }

  createWindow();

  globalShortcut.register('F5', () => mainWindow?.webContents.reload());
  globalShortcut.register('CommandOrControl+R', () => mainWindow?.webContents.reload());
  globalShortcut.register('CommandOrControl+Shift+R', () => mainWindow?.webContents.reloadIgnoringCache());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

ipcMain.handle('open-snippet-manager', () => {
  createSnippetManagerWindow();
});

ipcMain.handle('select-folder', async (event, defaultPath) => {
  const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  const options = {
    title: 'フォルダを選択',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: defaultPath || undefined,
  };
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

let shuttingDown = false;

function notifyServerShutdown() {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: '/api/shutdown', method: 'POST', timeout: 4000 },
      (res) => {
        res.on('data', () => {});
        res.on('end', resolve);
      }
    );
    req.on('error', resolve);
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.end();
  });
}

app.on('window-all-closed', async () => {
  // Python サーバーに VRAM 解放＋シャットダウンを通知してから終了
  if (!shuttingDown) {
    shuttingDown = true;
    await notifyServerShutdown();
  }
  if (process.platform !== 'darwin') app.quit();
});
