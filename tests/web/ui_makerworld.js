const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const path = require('path');
const fs = require('fs');
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME || undefined, args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errs = [];
  await ctx.route('**/*', async (r) => {
    const u = new URL(r.request().url());
    if (u.pathname.endsWith('jszip.min.js')) return r.fulfill({ body: fs.readFileSync(path.join(__dirname, '../../web/vendor/jszip/jszip.min.js')), contentType: 'text/javascript' });
    if (u.host === 'magnificent-salamander-d85b41.netlify.app') return r.fulfill({ body: fs.readFileSync(path.join(__dirname, '../../dist/web/index.html')), contentType: 'text/html' });
    if (u.host === 'makerworld.com' && u.pathname.startsWith('/en/models/')) return r.fulfill({ headers: { 'content-security-policy': "frame-src 'self'" }, contentType: 'text/html', body: `<html><body><h1>Model</h1><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { design: { id: 3541664, title: 'Shapes test', instances: [{ id: 11, title: 'PLA 0.2', machineName: 'P1S' }, { id: 12, title: 'PETG 0.16', machineName: 'X1C' }] } } } })}</script></body></html>` });
    if (u.host === 'makerworld.com' && /instance\/12\/f3mf/.test(u.pathname)) return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ name: 'Shapes test.3mf', url: 'https://cdn.example.com/f/x.3mf' }) });
    if (u.host === 'cdn.example.com') return r.fulfill({ body: fs.readFileSync(path.join(__dirname, '../fixtures/bambu_real.3mf')), contentType: 'application/octet-stream' });
    return r.fulfill({ status: 404, body: '' });
  });
  const pg = await ctx.newPage();
  pg.on('pageerror', e => errs.push('mw: ' + e.message));
  ctx.on('page', p => { p.on('pageerror', e => errs.push('pb: ' + e.message)); p.on('console', m => { if (m.type() === 'error') errs.push('pb: ' + m.text()); }); });
  // GM shim, as the Userscripts app would provide
  await pg.addInitScript(() => { window.GM = { xmlHttpRequest: async (o) => { const r = await fetch(o.url); return { status: r.status, response: await r.arrayBuffer() }; } }; });
  await pg.goto('https://makerworld.com/en/models/3541664-shapes#profileId-12');
  await pg.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../../dist/addon/Send to Plate Builder.user.js'), 'utf8') });
  await pg.waitForSelector('#pb-send');
  await pg.screenshot({ path: require('path').join(require('os').tmpdir(), 'mw1.png') });
  await pg.click('#pb-send'); await pg.waitForTimeout(4000); await pg.screenshot({ path: require('path').join(require('os').tmpdir(), 'mwc.png') }); const [tab] = await Promise.all([ctx.waitForEvent('page'), pg.click('.pb-sheet .go')]); await tab.waitForTimeout(4000); console.log('tab:', await tab.locator('#status').textContent()); await b.close(); return;
  const pb = pg.frames().find(f => f.url().includes('netlify'));
  console.log('toast:', await pg.locator('#pb-toast').textContent().catch(() => '(gone)'));
  console.log('pb status:', await pb.locator('#status').textContent());
  console.log('models:', await pb.evaluate(() => document.querySelectorAll('#models .model, #models [data-entry], #models > *').length));
  await pg.screenshot({ path: require('path').join(require('os').tmpdir(), 'mw2.png') });
  // second: no hash -> profile chooser
  await pg.goto('https://makerworld.com/en/models/3541664-shapes');
  await pg.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../../dist/addon/Send to Plate Builder.user.js'), 'utf8') });
  await pg.click('#pb-send'); await pg.waitForSelector('#pb-sheet'); await pg.screenshot({ path: require('path').join(require('os').tmpdir(), 'mw3.png') });
  console.log('errors:', errs);
  await b.close();
})();
