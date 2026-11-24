const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const fs = require('fs'), path = require('path');
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME || undefined, args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route('**/*', (r) => { const u = new URL(r.request().url());
    if (u.pathname.endsWith('jszip.min.js')) return r.fulfill({ body: fs.readFileSync(path.join(__dirname, '../../web/vendor/jszip/jszip.min.js')), contentType: 'text/javascript' });
    if (u.host === 'magnificent-salamander-d85b41.netlify.app') { const f = path.join(path.join(__dirname, '../../dist/web'), u.pathname === '/' ? 'index.html' : u.pathname); return r.fulfill({ body: fs.readFileSync(f), contentType: 'text/html' }); }
    return r.abort(); });
  const pg = await ctx.newPage(); const errs = []; pg.on('pageerror', (e) => errs.push(e.message));
  await pg.goto('https://magnificent-salamander-d85b41.netlify.app/');
  await pg.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../../web/vendor/jszip/jszip.min.js'), 'utf8') });
  await pg.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../../dist/addon/Send to Plate Builder.user.js'), 'utf8') });
  console.log('accept:', await pg.getAttribute('#pick', 'accept'));
  await pg.setInputFiles('#pick', [path.join(__dirname, '../fixtures/things.zip'), path.join(__dirname, '../fixtures/shapes.3mf')]);
  await pg.waitForTimeout(1500);
  console.log('parts:', await pg.textContent('#layoutMsg').catch(() => ''), '|', await pg.textContent('#status'));
  await pg.screenshot({ path: require('path').join(require('os').tmpdir(), 'zip.png') });
  console.log(errs); await b.close();
})();
