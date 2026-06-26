// KevFin desktop (Electron main process).
//
// Wraps the existing Express server + built client: it spawns the server as a
// child process with the user's chosen storage paths, waits for it to come up,
// then opens a native window pointed at it. A small config file in userData
// remembers where the database and keys file live so they can be relocated to a
// Dropbox/NAS folder (see the Storage panel in the app's Setup).

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { spawn, fork } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');

const isPackaged = app.isPackaged;

// --- where the built server + client live ---------------------------------
// Dev: desktop/ is a sibling of server/ and client/ in the repo.
// Packaged: extraResources keeps the same server/ + client/ sibling layout, so
// the server's `path.join(__dirname, '../../client/dist')` still resolves.
function resourcesRoot() {
  return isPackaged ? process.resourcesPath : path.join(__dirname, '..');
}
function serverEntry() {
  return path.join(resourcesRoot(), 'server', 'dist', 'index.js');
}

// If a claude binary is bundled at resources/claude/, point the assistant at it
// (the server resolves CLAUDE_BIN first). When absent, the assistant degrades to
// its sign-in gate and the rest of the app is unaffected.
function bundledClaudeBin() {
  const dir = path.join(resourcesRoot(), 'claude');
  const candidates = process.platform === 'win32'
    ? [path.join(dir, 'claude.exe'), path.join(dir, 'claude.cmd')]
    : [path.join(dir, 'claude')];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch { /* ignore */ } }
  return null;
}

// --- tiny config store (userData/kevfin-desktop.json) ---------------------
function configPath() {
  return path.join(app.getPath('userData'), 'kevfin-desktop.json');
}
function defaultConfig() {
  const dir = app.getPath('userData');
  return { dbPath: path.join(dir, 'kevfin.db'), keysPath: path.join(dir, 'kevfin.env'), port: 3001 };
}
function loadConfig() {
  try { return { ...defaultConfig(), ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) }; }
  catch { return defaultConfig(); }
}
function saveConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
  } catch (e) { console.error('[desktop] saveConfig failed:', e); }
}

// --- pick a free port (preferred first, else any) -------------------------
function getFreePort(preferred) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(getFreePort(0)));
    // Bind the same way the server does (all interfaces, no explicit host) so a
    // port already taken on :: / 0.0.0.0 is correctly detected as busy.
    srv.listen(preferred || 0, () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

// --- wait until the server answers ----------------------------------------
function waitForServer(port, timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/meta/assumptions', timeout: 1500 }, (res) => {
        res.resume(); resolve();
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) reject(new Error('Server did not start in time.'));
        else setTimeout(tick, 300);
      });
      req.on('timeout', () => req.destroy());
    };
    tick();
  });
}

let serverChild = null;
let mainWindow = null;
let currentPort = 0;

async function startServer() {
  const cfg = loadConfig();
  currentPort = await getFreePort(cfg.port || 3001);

  // Make sure the chosen folders exist before the server opens files there.
  for (const p of [cfg.dbPath, cfg.keysPath]) {
    try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch { /* ignore */ }
  }

  const claudeBin = bundledClaudeBin();
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(currentPort),
    DB_PATH: cfg.dbPath,
    KEVFIN_ENV_PATH: cfg.keysPath,
    ...(claudeBin ? { CLAUDE_BIN: claudeBin } : {}),
  };

  // Dev: run the server with the system Node so the existing better-sqlite3
  // build (system ABI) loads. Packaged: run under Electron's bundled Node
  // (ELECTRON_RUN_AS_NODE) with the native module rebuilt for Electron's ABI.
  if (isPackaged) {
    serverChild = fork(serverEntry(), [], {
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
  } else {
    serverChild = spawn('node', [serverEntry()], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  }

  serverChild.stdout.on('data', d => process.stdout.write(`[server] ${d}`));
  serverChild.stderr.on('data', d => process.stderr.write(`[server] ${d}`));
  serverChild.on('exit', (code) => { console.log('[desktop] server exited', code); serverChild = null; });

  await waitForServer(currentPort);
  return currentPort;
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1320, height: 900, minWidth: 900, minHeight: 600,
    title: 'KevFin',
    backgroundColor: '#0b0d12',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadURL(`http://127.0.0.1:${port}`);
  mainWindow.on('closed', () => { mainWindow = null; });
}

function stopServer() {
  if (serverChild) { try { serverChild.kill(); } catch { /* ignore */ } serverChild = null; }
}

app.whenReady().then(async () => {
  try {
    const port = await startServer();
    createWindow(port);
  } catch (e) {
    dialog.showErrorBox('KevFin failed to start', String((e && e.stack) || e));
    app.quit();
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && currentPort) createWindow(currentPort);
  });
});

app.on('window-all-closed', () => { stopServer(); if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', stopServer);

// --- IPC: storage location (used by the Setup → Storage panel) ------------
ipcMain.handle('kevfin:getPaths', () => {
  const c = loadConfig();
  return { dbPath: c.dbPath, keysPath: c.keysPath, port: currentPort };
});

ipcMain.handle('kevfin:chooseDir', async (_e, which) => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: which === 'keys' ? 'Choose a folder for the keys file' : 'Choose a folder for the database',
    message: 'Pick a folder — a Dropbox or NAS folder works for syncing across machines.',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return r.filePaths[0];
});

// Move/point the DB and/or keys file to the chosen folder(s), persist, relaunch.
ipcMain.handle('kevfin:applyAndRelaunch', async (_e, next) => {
  const cfg = loadConfig();
  const updated = { ...cfg };

  const relocate = (curPath, dir, filename) => {
    const dest = path.join(dir, filename);
    if (dest === curPath) return dest;
    try {
      fs.mkdirSync(dir, { recursive: true });
      // Use the file already at the destination if there is one; otherwise carry
      // the current file over so we don't start from an empty database.
      if (!fs.existsSync(dest) && fs.existsSync(curPath)) fs.copyFileSync(curPath, dest);
    } catch (e) {
      throw new Error(`Could not write to ${dir}: ${e.message}`);
    }
    return dest;
  };

  try {
    if (next.dbDir) updated.dbPath = relocate(cfg.dbPath, next.dbDir, 'kevfin.db');
    if (next.keysDir) updated.keysPath = relocate(cfg.keysPath, next.keysDir, 'kevfin.env');
  } catch (e) {
    return { ok: false, error: e.message };
  }

  saveConfig(updated);
  app.relaunch();
  app.exit(0);
  return { ok: true };
});
