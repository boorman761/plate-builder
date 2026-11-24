const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const fs = require('fs'), path = require('path');
const US = fs.readFileSync(path.join(__dirname, '../../dist/addon/Send to Plate Builder.user.js'), 'utf8');
const JSZ = fs.readFileSync(path.join(__dirname, '../../web/vendor/jszip/jszip.min.js'), 'utf8');
const PB = 'https://magnificent-salamander-d85b41.netlify.app';
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME || undefined, args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errs = [];
  const cors = (r) => ({ 'access-control-allow-origin': r.request().headers()['origin'] || '*', 'access-control-allow-credentials': 'true', 'access-control-allow-headers': 'content-type' });
  await ctx.route('**/*', async (r) => {
    const req = r.request(), u = new URL(req.url());
    if (u.pathname.endsWith('jszip.min.js')) return r.fulfill({ body: JSZ, contentType: 'text/javascript' });
    if (u.origin === PB) { const f = path.join(path.join(__dirname, '../../dist/web'), u.pathname === '/' ? 'index.html' : u.pathname); return fs.existsSync(f) ? r.fulfill({ body: fs.readFileSync(f), contentType: f.endsWith('.html') ? 'text/html' : 'text/javascript' }) : r.fulfill({ status: 404, body: '' }); }
    if (u.host === 'www.printables.com') return r.fulfill({ contentType: 'text/html', body: '<html><body><h1>Printables model</h1></body></html>' });
    if (u.host === 'api.printables.com') {
      if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors(r) });
      const q = JSON.parse(req.postData());
      if (q.operationName === 'ModelFiles') return r.fulfill({ headers: cors(r), contentType: 'application/json', body: JSON.stringify({ data: { model: { stls: [{ id: 1, name: 'shapes.3mf', fileSize: 300000 }, { id: 2, name: 'star.stl', fileSize: 20000 }, { id: 3, name: 'notes.pdf' }] } } }) });
      if (q.operationName === 'GetDownloadLink') return r.fulfill({ headers: cors(r), contentType: 'application/json', body: JSON.stringify({ data: { getDownloadLink: { ok: true, output: { link: 'https://files.printables.com/f/' + (q.variables.id === '1' ? 'shapes.3mf' : 'star.stl') } } } }) });
    }
    if (u.host === 'files.printables.com') return r.fulfill({ body: fs.readFileSync(path.join(__dirname, '../fixtures/') + u.pathname.split('/').pop()) }); // no CORS: forces the GM route
    if (u.host === 'www.thingiverse.com' && u.pathname.startsWith('/thing:') && !u.pathname.endsWith('/zip')) return r.fulfill({ contentType: 'text/html', body: '<html><body><h1>Thing</h1></body></html>' });
    if (u.host === 'www.thingiverse.com' && u.pathname.endsWith('/zip')) return r.fulfill({ body: fs.readFileSync(path.join(__dirname, '../fixtures/things.zip')) });
    if (u.host === 'www.creativefabrica.com') return r.fulfill({ contentType: 'text/html', body: '<html><body><p>Product</p><a id="dl" href="https://cdn.creativefabrica.com/files/pyr.obj?sig=1">Download pyr.obj</a></body></html>' });
    if (u.host === 'cdn.creativefabrica.com') return r.fulfill({ body: fs.readFileSync(path.join(__dirname, '../fixtures/pyr.obj')) });
    return r.fulfill({ status: 404, body: '' });
  });
  const shim = () => { window.GM = { xmlHttpRequest: (o) => { window.__gm(o.url).then((b64) => { const s = atob(b64), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); o.onload({ status: 200, response: u.buffer }); }); } }; };
  async function prep(p) {
    await p.exposeFunction('__gm', async (url) => { const r = await ctx.request.get(url); return (await r.body()).toString('base64'); }).catch(() => {});
    p.on('pageerror', (e) => errs.push(p.url().slice(8, 30) + ': ' + e.message));
  }
  async function inject(p) { await p.evaluate(shim); await p.addScriptTag({ content: JSZ }); await p.addScriptTag({ content: US }); }
  ctx.on('page', async (p) => { await prep(p); p.on('load', async () => { if (p.url().startsWith(PB)) { await inject(p); } }); });
  async function run(url, steps) {
    const pg = await ctx.newPage(); await prep(pg);
    await pg.goto(url); await inject(pg);
    const pbP = ctx.waitForEvent('page', { timeout: 30000 });
    await steps(pg);
    await pg.waitForSelector('.pb-sheet .go', { timeout: 15000 });
    console.log('  sheet:', (await pg.textContent('.pb-sheet h3')));
    await pg.click('.pb-sheet .go');
    const pb = await pbP; await pb.waitForTimeout(5000);
    console.log('  PB status:', await pb.textContent('#status'));
    console.log('  PB models:', await pb.$$eval('#models .t, #models h3, #models .title', (a) => a.map((x) => x.textContent.trim()).slice(0, 6)).catch(() => []));
    await pb.screenshot({ path: require('path').join(require('os').tmpdir(), 'site_') + new URL(url).host + '.png' });
    await pb.close(); await pg.close();
  }
  console.log('Printables:');
  await run('https://www.printables.com/model/123-test', async (pg) => {
    await pg.waitForSelector('#pb-send'); await pg.click('#pb-send');
    await pg.waitForSelector('.pb-sheet label.f'); console.log('  files listed:', await pg.$$eval('.pb-sheet label.f span', (a) => a.map((x) => x.textContent)));
    await pg.check('.pb-sheet label.f:nth-of-type(2) input'); await pg.click('.pb-sheet .go');
  });
  console.log('Thingiverse:');
  await run('https://www.thingiverse.com/thing:555', async (pg) => {
    await pg.waitForSelector('#pb-send'); await pg.click('#pb-send');
    await pg.waitForSelector('.pb-sheet label.f'); console.log('  zip contents:', await pg.$$eval('.pb-sheet label.f span', (a) => a.map((x) => x.textContent)));
    await pg.check('.pb-sheet label.f:nth-of-type(1) input'); await pg.check('.pb-sheet label.f:nth-of-type(2) input'); await pg.click('.pb-sheet .go');
  });
  console.log('Creative Fabrica link:');
  await run('https://www.creativefabrica.com/product/x', async (pg) => {
    await pg.waitForSelector('#pb-send'); await pg.click('#dl'); await pg.waitForSelector('.pb-sheet .go'); await pg.click('.pb-sheet .go');
  });
  console.log('errors:', errs);
  await b.close();
})();
