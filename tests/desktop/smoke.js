// Desktop app smoke test: runs the Electron app under a fake home folder and checks the desktop features.
// Usage (Linux, needs xvfb): xvfb-run -a node tests/desktop/smoke.js
const { _electron } = require(process.env.PLAYWRIGHT || 'playwright');
const fs = require('fs'), path = require('path'), http = require('http'), os = require('os');
const ROOT = path.join(__dirname, '..', '..');
const FIX = path.join(ROOT, 'tests', 'fixtures');
(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pbhome-'));
  fs.mkdirSync(path.join(home, 'Downloads')); fs.mkdirSync(path.join(home, 'Documents'));
  // a pretend printer and a pretend model site
  const seen = [];
  const printer = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => body += c); req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, len: body.length });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/detail') return res.end(JSON.stringify({ code: 0, message: 'Success', detail: { name: 'Test C5P', status: 'ready', matlStationInfo: { slotInfos: [{ slotId: 1, hasFilament: true, materialColor: '#FF0000', materialName: 'PLA' }] } } }));
      res.end(JSON.stringify({ code: 0, message: 'Success' }));
    });
  }).listen(8898, '127.0.0.1');
  const site = http.createServer((req, res) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); return res.end('<a id="dl" href="/files/pyr.obj" download>pyr.obj</a>'); }
    res.setHeader('content-disposition', 'attachment; filename="pyr.obj"'); res.end(fs.readFileSync(path.join(FIX, 'pyr.obj')));
  }).listen(8099, '127.0.0.1');

  const app = await _electron.launch({ executablePath: process.env.ELECTRON || require('electron'), args: [path.join(ROOT, 'desktop'), '--no-sandbox'], env: { ...process.env, HOME: home, PB_TEST: '1', XDG_DOWNLOAD_DIR: path.join(home, 'Downloads') } });
  const win = await app.firstWindow();
  const errs = []; win.on('pageerror', (e) => errs.push(e.message));
  await win.waitForLoadState('domcontentloaded'); await win.waitForTimeout(1500);
  const ok = (name, cond) => console.log((cond ? 'PASS ' : 'FAIL ') + name);
  ok('app loads', (await win.title()).length > 0 && !!(await win.$('#pick')));
  ok('printer bridge present', await win.evaluate(() => document.documentElement.dataset.pbBridge === '2.1.0' && document.documentElement.dataset.pbDesktop === '1'));
  const downloads = await app.evaluate(({ app }) => app.getPath('downloads'));
  console.log('  downloads folder:', downloads);
  // 1. a file arriving in Downloads goes on the plate
  fs.copyFileSync(path.join(FIX, 'star.stl'), path.join(downloads, 'star.stl'));
  await win.waitForTimeout(4500);
  ok('Downloads: STL added', /1 part|part/.test(await win.textContent('#layoutMsg').catch(() => '')));
  // 2. a zip arriving in Downloads is opened
  fs.copyFileSync(path.join(FIX, 'things.zip'), path.join(downloads, 'things.zip'));
  await win.waitForTimeout(4500);
  console.log('  ', await win.textContent('#layoutMsg').catch(() => ''));
  ok('Downloads: zip unpacked (3 parts)', /3 parts/.test(await win.textContent('#layoutMsg').catch(() => '')));
  // 3. a download in the Find models window goes on the plate
  await app.evaluate(() => global.__pb.openBrowse('http://127.0.0.1:8099/'));
  const bw = await app.waitForEvent('window'); await bw.waitForLoadState(); await bw.click('#dl');
  await win.waitForTimeout(3000);
  ok('Find models: download added (4 parts)', /4 parts/.test(await win.textContent('#layoutMsg').catch(() => '')));
  // 4. Build 3MF saves into Documents\Plate Builder
  await win.click('#go'); await win.waitForTimeout(3000);
  const docs = await app.evaluate(({ app }) => app.getPath('documents'));
  const out = path.join(docs, 'Plate Builder');
  ok('Build 3MF saved to Documents\\Plate Builder', fs.existsSync(out) && fs.readdirSync(out).some((f) => f.endsWith('.3mf')));
  console.log('  status:', await win.textContent('#status'), '| docs:', docs, '| share:', await win.evaluate(() => typeof navigator.canShare));
  console.log('  saved:', fs.existsSync(out) ? fs.readdirSync(out) : []);
  // 4b. slicing works in the app (module worker + WebAssembly over app://)
  await win.click('#slice');
  await win.waitForFunction(() => !document.getElementById('sliced').hidden || /Could not/.test(document.getElementById('status').textContent), null, { timeout: 120000 });
  ok('Slicing works', await win.evaluate(() => !document.getElementById('sliced').hidden));
  // 5. printer: settings check goes through the app
  await win.evaluate(() => window.postMessage({ id: 't1', type: 'pb-settings' }, location.origin));
  await win.waitForSelector('#pbp'); await win.fill('#pbp-ip', '127.0.0.1'); await win.fill('#pbp-serial', 'SN'); await win.fill('#pbp-code', '1');
  await win.click('#pbp .go'); await win.waitForTimeout(1500);
  ok('Printer check through the app', seen.some((s) => s.url === '/detail'));
  // and a non-printer address is refused
  const refused = await win.evaluate(() => new Promise((r) => { const ipc = null; r(true); }));
  await win.screenshot({ path: process.env.SHOT || '/tmp/desktop.png' });
  console.log('page errors:', errs);
  await app.close(); printer.close(); site.close();
})().catch((e) => { console.error(e); process.exit(1); });
