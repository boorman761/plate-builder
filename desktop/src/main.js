// Plate Builder for Windows: the same app as the phone version, plus what a computer can do.
//  - Sends prints straight to Flashforge printers on your network (no add-on needed).
//  - Watches your Downloads folder and puts new 3MF, STL, OBJ and zip files on the plate.
//  - A built-in browser for the model sites: downloads from it go straight onto the plate.
//  - Built files are saved to Documents\Plate Builder, ready to open in Flash Studio.
const { app, BrowserWindow, protocol, ipcMain, session, shell, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const DEV = !app.isPackaged;
const WEB = DEV ? path.join(__dirname, '..', '..', 'dist', 'web') : path.join(process.resourcesPath, 'web');
const BRIDGE = DEV ? path.join(__dirname, '..', '..', 'addon', 'src', 'bridge.js') : path.join(process.resourcesPath, 'bridge.js');
const MODEL = /\.(3mf|stl|obj|zip)$/i;
const SITES = [
  ['MakerWorld', 'https://makerworld.com/'],
  ['Printables', 'https://www.printables.com/'],
  ['Thingiverse', 'https://www.thingiverse.com/'],
  ['Creality Cloud', 'https://www.crealitycloud.com/'],
  ['makeronline', 'https://www.makeronline.com/'],
  ['Snapmaker Space', 'https://space.snapmaker.com/'],
  ['MyMiniFactory', 'https://www.myminifactory.com/'],
  ['Thangs', 'https://thangs.com/'],
  ['Creative Fabrica', 'https://www.creativefabrica.com/3d-models/'],
];

// ---------- settings ----------
const SETTINGS = path.join(app.getPath('userData'), 'settings.json');
let settings = { watchDownloads: true };
try { settings = Object.assign(settings, JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))); } catch (e) { /* first run */ }
const saveSettings = () => { try { fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2)); } catch (e) {} };
const OUT_DIR = path.join(app.getPath('documents'), 'Plate Builder');

// ---------- serving the app ----------
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.txt': 'text/plain' };
function serveApp() {
  protocol.handle('app', (req) => {
    let p = decodeURIComponent(new URL(req.url).pathname);
    if (!p || p === '/') p = '/index.html';
    const file = path.join(WEB, path.normalize(p));
    if (!file.startsWith(WEB) || !fs.existsSync(file)) return new Response('Not found', { status: 404 });
    return new Response(fs.readFileSync(file), { headers: { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' } });
  });
}

// ---------- windows ----------
let main = null, browse = null;
function createMain() {
  main = new BrowserWindow({
    width: 1280, height: 900, minWidth: 420, title: 'Plate Builder', backgroundColor: '#E9EBEE',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false, nodeIntegration: false },
  });
  main.loadURL('app://plate-builder/index.html');
  // links in the app (Find models and so on) open in the built-in browser; anything else in the normal browser
  main.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) (SITES.some(([, s]) => new URL(s).hostname.replace(/^www\./, '') === new URL(url).hostname.replace(/^www\./, '')) ? openBrowse(url) : shell.openExternal(url));
    return { action: 'deny' };
  });
  main.on('closed', () => { main = null; });
}

// The model sites, in their own window with its own saved logins. Model downloads go to the plate.
function openBrowse(url) {
  if (browse && !browse.isDestroyed()) { browse.loadURL(url); browse.show(); browse.focus(); return; }
  browse = new BrowserWindow({ width: 1200, height: 900, title: 'Find models', webPreferences: { partition: 'persist:sites', contextIsolation: true, sandbox: true } });
  browse.loadURL(url);
  browse.on('page-title-updated', (e, t) => { e.preventDefault(); browse.setTitle('Find models – ' + t); });
  browse.on('closed', () => { browse = null; });
}
function setUpSitesSession() {
  const ses = session.fromPartition('persist:sites');
  // look like normal Chrome, so sites (and Cloudflare) treat it like a browser
  ses.setUserAgent(ses.getUserAgent().replace(/\s(Electron|plate-builder-desktop|Plate Builder)\/\S+/gi, ''));
  ses.on('will-download', (event, item) => {
    const name = item.getFilename();
    if (!MODEL.test(name)) return; // anything else: the normal save dialog
    const dir = path.join(os.tmpdir(), 'plate-builder'); fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, Date.now() + '-' + name);
    item.setSavePath(tmp);
    item.once('done', (e, state) => {
      if (state !== 'completed') return;
      sendFiles([{ name, data: fs.readFileSync(tmp) }], 'from ' + (browse ? new URL(browse.webContents.getURL()).hostname.replace(/^www\./, '') : 'the web'));
      fs.unlink(tmp, () => {});
    });
  });
}
function sendFiles(files, from) {
  if (!main) createMain();
  const go = () => { main.webContents.send('pb-incoming', files, from); if (main.isMinimized()) main.restore(); main.show(); main.focus(); };
  if (main.webContents.isLoading()) main.webContents.once('did-finish-load', () => setTimeout(go, 500)); else go();
}

// Built files (Build 3MF, Save G-code) go to Documents\Plate Builder.
function setUpAppSession() {
  session.defaultSession.on('will-download', (event, item) => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const base = item.getFilename();
    let file = path.join(OUT_DIR, base), n = 1;
    while (fs.existsSync(file)) file = path.join(OUT_DIR, base.replace(/(\.[^.]+(\.txt|\.zip)?)$/, ` (${n++})$1`));
    item.setSavePath(file);
    item.once('done', async (e, state) => {
      if (state !== 'completed' || !main) return;
      const is3mf = /\.3mf$/i.test(file);
      const r = await dialog.showMessageBox(main, {
        type: 'info', title: 'Saved', message: 'Saved ' + path.basename(file),
        detail: 'In Documents\\Plate Builder.' + (is3mf ? ' Open it in Flash Studio to slice and print.' : ''),
        buttons: is3mf ? ['Open in Flash Studio', 'Show in folder', 'OK'] : ['Show in folder', 'OK'], defaultId: 0, cancelId: is3mf ? 2 : 1,
      });
      if (is3mf && r.response === 0) { const err = await shell.openPath(file); if (err) dialog.showErrorBox('Couldn’t open it', err + '\n\nOpen Flash Studio and use File → Import instead.'); }
      else if ((is3mf && r.response === 1) || (!is3mf && r.response === 0)) shell.showItemInFolder(file);
    });
  });
}

// ---------- the Downloads folder ----------
let watcher = null;
const seen = new Map();
const startedAt = Date.now();
function watchDownloads(on) {
  if (watcher) { watcher.close(); watcher = null; }
  if (!on) return;
  const dir = app.getPath('downloads');
  try {
    watcher = fs.watch(dir, (evt, name) => {
      if (!name || !MODEL.test(name)) return;
      const file = path.join(dir, name);
      clearTimeout(seen.get(file + ':t'));
      seen.set(file + ':t', setTimeout(() => pickUp(file), 1500));
    });
  } catch (e) { console.error('Downloads watch failed', e); }
}
function pickUp(file) {
  let st; try { st = fs.statSync(file); } catch (e) { return; }
  if (!st.isFile() || st.mtimeMs < startedAt || !st.size) return;
  const key = file + '|' + st.size + '|' + st.mtimeMs;
  if (seen.get(file) === key) return;
  // wait until the browser has finished writing it
  setTimeout(() => {
    let st2; try { st2 = fs.statSync(file); } catch (e) { return; }
    if (st2.size !== st.size) return pickUp(file);
    seen.set(file, key);
    sendFiles([{ name: path.basename(file), data: fs.readFileSync(file) }], 'from your Downloads folder');
  }, 800);
}

// ---------- talking to printers (for the add-on code running in the app) ----------
// Only Flashforge's network API on your own network: private addresses, port 8898.
function allowed(url) {
  try {
    const u = new URL(url);
    const local = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(u.hostname) || (process.env.PB_TEST && u.hostname === '127.0.0.1');
    return u.protocol === 'http:' && u.port === '8898' && local;
  } catch (e) { return false; }
}
ipcMain.handle('pb-http', async (e, o) => {
  if (!allowed(o.url)) return { error: 'not a printer address on your network' };
  try {
    const r = await fetch(o.url, { method: o.method || 'GET', headers: o.headers || {}, body: o.data, signal: AbortSignal.timeout(o.timeout || 15000) });
    return { status: r.status, responseText: await r.text() };
  } catch (err) {
    return { error: String(err && err.message || err), timeout: err && err.name === 'TimeoutError' };
  }
});
ipcMain.on('pb-bridge-path', (e) => { e.returnValue = BRIDGE; });

// ---------- menu ----------
function buildMenu() {
  const t = [
    { label: 'File', submenu: [
      { label: 'Watch Downloads folder', type: 'checkbox', checked: settings.watchDownloads, click: (m) => { settings.watchDownloads = m.checked; saveSettings(); watchDownloads(m.checked); } },
      { label: 'Open Downloads folder', click: () => shell.openPath(app.getPath('downloads')) },
      { label: 'Open saved files (Documents\\Plate Builder)', click: () => { fs.mkdirSync(OUT_DIR, { recursive: true }); shell.openPath(OUT_DIR); } },
      { type: 'separator' }, { role: 'quit' },
    ] },
    { label: 'Find models', submenu: [
      ...SITES.map(([label, url]) => ({ label, click: () => openBrowse(url) })),
      { type: 'separator' },
      { label: 'Back', accelerator: 'Alt+Left', click: () => browse && browse.webContents.navigationHistory.canGoBack() && browse.webContents.navigationHistory.goBack() },
      { label: 'Forward', accelerator: 'Alt+Right', click: () => browse && browse.webContents.navigationHistory.canGoForward() && browse.webContents.navigationHistory.goForward() },
      { label: 'Reload page', accelerator: 'F5', click: () => { const w = BrowserWindow.getFocusedWindow(); if (w) w.webContents.reload(); } },
      { label: 'Open this page in your browser', click: () => browse && shell.openExternal(browse.webContents.getURL()) },
    ] },
    { label: 'View', submenu: [{ role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { type: 'separator' }, { role: 'togglefullscreen' }, { role: 'toggleDevTools' }] },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(t));
}

app.whenReady().then(() => {
  serveApp();
  setUpSitesSession();
  setUpAppSession();
  buildMenu();
  createMain();
  watchDownloads(settings.watchDownloads);
  app.on('activate', () => { if (!main) createMain(); });
});
app.on('window-all-closed', () => app.quit());
if (process.env.PB_TEST) global.__pb = { openBrowse, sendFiles };
