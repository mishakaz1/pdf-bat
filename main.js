'use strict';
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const tex = require('./tex');

if (process.env.PDFBAT_USERDATA) app.setPath('userData', process.env.PDFBAT_USERDATA);

// ---------- persistent store (JSON in userData) ----------
const storePath = () => path.join(app.getPath('userData'), 'pdfbat-store.json');
let store = { docs: {}, settings: {}, session: null, recent: [] };
let saveTimer = null;

function loadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    store = Object.assign(store, raw);
  } catch (_) { /* first launch */ }
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushStore, 400);
}
function flushStore() {
  clearTimeout(saveTimer);
  try {
    const tmp = storePath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store));
    fs.renameSync(tmp, storePath());
  } catch (e) { console.error('store save failed', e); }
}


// ---------- window ----------
let win = null;
let forceClose = false;
let quitting = false;
const pendingPaths = [];

function pdfArgs(argv) {
  return argv.slice(1).filter(a => /\.pdf$/i.test(a) && fs.existsSync(a));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    title: 'PDF-Bat',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16171a' : '#f6f6f4',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) { e.preventDefault(); shell.openExternal(url); }
  });
  win.on('close', (e) => {
    if (forceClose || win.webContents.isCrashed()) return;
    e.preventDefault();
    send('close-request');
  });
  win.on('closed', () => { win = null; forceClose = false; });
  buildMenu();
}

function send(ch, ...args) { if (win) win.webContents.send(ch, ...args); }

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => send('menu', 'open') },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('menu', 'save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('menu', 'saveAs') },
        { label: 'Open LaTeX file…', click: () => send('menu', 'openTex') },
        { label: 'New LaTeX document', accelerator: 'CmdOrCtrl+N', click: () => send('menu', 'newTex') },
        { type: 'separator' },
        { label: 'Close pane', accelerator: 'CmdOrCtrl+W', click: () => send('menu', 'closePane') },
        ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit' }])
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Read mode', accelerator: 'CmdOrCtrl+1', click: () => send('menu', 'modeRead') },
        { label: 'Edit mode', accelerator: 'CmdOrCtrl+2', click: () => send('menu', 'modeEdit') },
        { type: 'separator' },
        { label: 'Split: same file side by side', accelerator: 'CmdOrCtrl+J', registerAccelerator: false, click: () => send('menu', 'duplicate') },
        { label: 'Find', accelerator: 'CmdOrCtrl+F', registerAccelerator: false, click: () => send('menu', 'find') },
        { label: 'Toggle sidebar', accelerator: 'CmdOrCtrl+B', click: () => send('menu', 'sidebar') },
        { label: 'Toggle theme', accelerator: 'CmdOrCtrl+Shift+L', click: () => send('menu', 'theme') },
        { type: 'separator' },
        { label: 'Zoom in', accelerator: 'CmdOrCtrl+=', click: () => send('menu', 'zoomIn') },
        { label: 'Zoom out', accelerator: 'CmdOrCtrl+-', click: () => send('menu', 'zoomOut') },
        { label: 'Fit width', accelerator: 'CmdOrCtrl+0', click: () => send('menu', 'fitWidth') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' }
      ]
    },
    { role: 'windowMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- IPC ----------
ipcMain.handle('dialog:open', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('dialog:save', async (_e, defaultPath) => {
  const r = await dialog.showSaveDialog(win, {
    defaultPath,
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  return r.canceled ? null : r.filePath;
});

ipcMain.handle('dialog:openImage', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }]
  });
  if (r.canceled) return null;
  const p = r.filePaths[0];
  return { name: path.basename(p), type: /\.png$/i.test(p) ? 'png' : 'jpg', data: fs.readFileSync(p) };
});

ipcMain.handle('file:read', async (_e, p) => {
  const data = fs.readFileSync(p);
  const key = path.resolve(p);
  store.recent = [p, ...store.recent.filter(x => x !== p)].slice(0, 20);
  scheduleSave();
  return { path: p, name: path.basename(p), key, data };
});

ipcMain.handle('file:write', async (_e, p, bytes) => {
  // atomic write: temp file + rename, so a crash never leaves a half-written PDF
  const tmp = p + '.pdfbat-tmp';
  fs.writeFileSync(tmp, Buffer.from(bytes));
  fs.renameSync(tmp, p);
  return true;
});
ipcMain.handle('file:writeText', async (_e, p, text) => { fs.writeFileSync(p, text, 'utf8'); return true; });
ipcMain.handle('file:readText', async (_e, p) => fs.readFileSync(p, 'utf8'));
ipcMain.handle('dialog:openTex', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'LaTeX', extensions: ['tex'] }] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog:saveTex', async (_e, defaultPath) => {
  const r = await dialog.showSaveDialog(win, { defaultPath, filters: [{ name: 'LaTeX', extensions: ['tex'] }] });
  return r.canceled ? null : r.filePath;
});
ipcMain.handle('dialog:confirm', async (_e, message, detail, buttons) => {
  const r = await dialog.showMessageBox(win, { type: 'question', message, detail, buttons: buttons || ['OK', 'Cancel'], defaultId: 0, cancelId: (buttons || ['OK', 'Cancel']).length - 1 });
  return r.response;
});

// ---------- LaTeX (Edit mode only) ----------
ipcMain.handle('tex:engines', () => tex.detectEngines());
ipcMain.handle('tex:install', async () => {
  try {
    const p = await tex.installTectonic((got, total) => send('tex-progress', got, total));
    return { ok: true, path: p };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});
ipcMain.handle('tex:scratchDir', (_e, id) => tex.scratchDir(id));
ipcMain.handle('tex:compile', async (_e, source, opts) => {
  const r = await tex.compile(source, opts || {});
  return r;
});

ipcMain.handle('file:exists', (_e, p) => fs.existsSync(p));

ipcMain.handle('store:getDoc', (_e, key) => store.docs[key] || null);
ipcMain.handle('store:setDoc', (_e, key, patch) => {
  store.docs[key] = Object.assign(store.docs[key] || {}, patch, { updated: Date.now() });
  scheduleSave();
  return true;
});
ipcMain.handle('store:getSettings', () => store.settings);
ipcMain.handle('store:setSettings', (_e, patch) => {
  Object.assign(store.settings, patch);
  scheduleSave();
  return store.settings;
});
ipcMain.handle('store:getSession', () => store.session);
ipcMain.handle('store:setSession', (_e, s) => { store.session = s; scheduleSave(); return true; });
ipcMain.handle('store:getRecent', () => store.recent.filter(p => fs.existsSync(p)));

ipcMain.handle('app:asset', (_e, rel) => {
  const p = path.join(__dirname, 'assets', path.normalize(rel).replace(/^(\.\.[\/\\])+/, ''));
  return fs.readFileSync(p);
});
ipcMain.handle('app:cancelClose', () => { quitting = false; });
ipcMain.handle('app:forceClose', () => { forceClose = true; if (win) win.close(); if (quitting) app.quit(); });
ipcMain.handle('app:pendingPaths', () => pendingPaths.splice(0));
ipcMain.handle('app:systemDark', () => nativeTheme.shouldUseDarkColors);

// ---------- app lifecycle ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const ps = pdfArgs(argv);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      if (ps.length) send('open-paths', ps);
    }
  });

  // macOS "Open with…" / double-click on a .pdf
  app.on('open-file', (e, p) => {
    e.preventDefault();
    if (win && win.webContents && !win.webContents.isLoading()) send('open-paths', [p]);
    else pendingPaths.push(p);
  });

  app.whenReady().then(() => {
    loadStore();
    pendingPaths.push(...pdfArgs(process.argv));
    createWindow();
    app.on('activate', () => { if (!win) createWindow(); });
  });

  app.on('before-quit', () => { quitting = true; flushStore(); });
  app.on('window-all-closed', () => {
    flushStore();
    if (process.platform !== 'darwin') app.quit();
  });
}
