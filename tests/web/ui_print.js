const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const fs = require('fs'), path = require('path');
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME || undefined, args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errs = []; const seen = [];
  await ctx.route('**/*', async (r) => {
    const u = new URL(r.request().url());
    if (u.pathname.endsWith('jszip.min.js')) return r.fulfill({ body: fs.readFileSync(path.join(__dirname, '../../web/vendor/jszip/jszip.min.js')), contentType: 'text/javascript' });
    if (u.host === 'magnificent-salamander-d85b41.netlify.app') {
      const f = path.join(path.join(__dirname, '../../dist/web'), u.pathname === '/' ? 'index.html' : u.pathname);
      const ct = f.endsWith('.html') ? 'text/html' : f.endsWith('.wasm') ? 'application/wasm' : 'text/javascript';
      return fs.existsSync(f) ? r.fulfill({ body: fs.readFileSync(f), contentType: ct }) : r.fulfill({ status: 404, body: '' });
    }
    return r.abort();
  });
  const pg = await ctx.newPage();
  pg.on('pageerror', e => errs.push(e.message)); pg.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  const mode = process.argv[3] || 'ok';
  await pg.exposeFunction('__printer', (o) => {
    seen.push({ url: o.url, headers: o.headers, len: o.data ? o.data.length : 0, head: o.data ? o.data.slice(0, 200) : '' , tail: o.data ? o.data.slice(-60) : ''});
    if (!o.url.startsWith('http://192.168.1.50:8898')) return { status: 0, err: true };
    if (o.url.endsWith('/detail')) {
      const body = JSON.parse(o.data);
      if (body.checkCode !== '12345') return { status: 200, responseText: JSON.stringify({ code: 1, message: 'check code error' }) };
      return { status: 200, responseText: JSON.stringify({ code: 0, message: 'Success', detail: { name: 'Big Printer', model: 'Creator 5 Pro', status: mode === 'busy' ? 'printing' : 'ready', matlStationInfo: { slotInfos: [ { slotId: 2, hasFilament: true, materialColor: '#1E88E5', materialName: 'PETG' }, { slotId: 1, hasFilament: true, materialColor: '#FF0000', materialName: 'PLA' }, { slotId: 3, hasFilament: false, materialColor: '#000000', materialName: '?' }, { slotId: 4, hasFilament: true, materialColor: '#FFFFFF', materialName: 'PLA' } ] } } }) };
    }
    if (o.url.endsWith('/uploadGcode')) return { status: 200, responseText: JSON.stringify({ code: 0, message: 'Success' }) };
    return { status: 404, responseText: '' };
  });
  await pg.addInitScript(() => { window.GM = { xmlHttpRequest: (o) => { window.__printer({ url: o.url, headers: o.headers, data: o.data }).then((r) => r.err ? o.onerror && o.onerror({}) : o.onload(r)); } }; });
  await pg.goto('https://magnificent-salamander-d85b41.netlify.app/');
  await pg.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../../dist/addon/Send to Plate Builder.user.js'), 'utf8') });
  console.log('bridge:', await pg.evaluate(() => document.documentElement.dataset.pbBridge));
  await pg.selectOption('#model', process.argv[2] || 'Creator 5 Pro');
  await pg.setInputFiles('#pick', path.join(__dirname, '../fixtures/shapes.3mf'));
  await pg.waitForTimeout(800);
  // read loaded
  if (await pg.$('#useLoaded')) {
    await pg.check('#useLoaded'); await pg.waitForTimeout(200);
    await pg.click('#readLoaded');
    await pg.waitForSelector('#pbp'); await pg.screenshot({ path: require('path').join(require('os').tmpdir(), 'pr1.png') });
    await pg.fill('#pbp-ip', '192.168.1.50'); await pg.fill('#pbp-serial', 'SN1'); await pg.fill('#pbp-code', '999');
    await pg.click('#pbp .go'); await pg.waitForTimeout(300); console.log('bad code msg:', await pg.textContent('#pbp .msg'));
    await pg.fill('#pbp-code', '12345'); await pg.click('#pbp .go'); await pg.waitForTimeout(1500);
    console.log('read:', await pg.textContent('#status'));
    console.log('slot colours:', await pg.$$eval('#slots input[type=color]', (a) => a.map((x) => x.value)));
    await pg.locator('#slots').screenshot({ path: require('path').join(require('os').tmpdir(), 'pr2.png') });
  }
  await pg.click('#slice');
  await pg.waitForFunction(() => !document.getElementById('sliced').hidden || /Could not/.test(document.getElementById('status').textContent), null, { timeout: 240000 });
  if (!(await pg.$('#pbp'))) {} 
  await pg.click('#sendPrinter');
  if (await pg.waitForSelector('#pbp', { timeout: 1500 }).catch(() => null)) { await pg.fill('#pbp-ip', '192.168.1.50'); await pg.fill('#pbp-serial', 'SN1'); await pg.fill('#pbp-code', '12345'); await pg.click('#pbp .go'); }
  await pg.waitForTimeout(3000);
  console.log('send:', await pg.textContent('#status'));
  const up = seen.find((x) => x.url.endsWith('/uploadGcode'));
  if (up) { const h = Object.assign({}, up.headers); h.materialMappings = Buffer.from(h.materialMappings || '', 'base64').toString(); console.log('upload headers:', h, 'body len', up.len, '\nhead:', up.head.slice(0, 180), '\ntail:', JSON.stringify(up.tail)); }
  console.log('errors:', errs);
  await b.close();
})();
