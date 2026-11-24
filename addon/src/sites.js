(() => {
  'use strict';
  const PLATE_BUILDER = 'https://magnificent-salamander-d85b41.netlify.app/';
  const PB_ORIGIN = new URL(PLATE_BUILDER).origin;
  // the model sites this add-on works on (Plate Builder only takes files from these)
  const SITE_ORIGINS = /^https:\/\/([a-z0-9-]+\.)*(makerworld\.com|printables\.com|thingiverse\.com|crealitycloud\.com|makeronline\.com|snapmaker\.com|myminifactory\.com|thangs\.com|creativefabrica\.com)$/i;
  if (location.origin === PB_ORIGIN) { printerBridge(SITE_ORIGINS, typeof GM !== 'undefined' ? GM : undefined, typeof JSZip !== 'undefined' ? JSZip : undefined); return; }
  const host = location.hostname.replace(/^www\./, '');
  const isMW = /(^|\.)makerworld\.com$/.test(host);
  const MODEL_EXT = /\.(3mf|stl|obj)$/i;
  let pbWin = null, pbReady = false;

  const API = '/api/v1/design-service';

  // ---------- which model and print profile is on screen ----------
  const modelId = () => (location.pathname.match(/\/models\/(\d+)/) || [])[1] || null;
  const hashProfile = () => (location.hash.match(/profileId-(\d+)/) || [])[1] || null;

  async function getJson(url) {
    const r = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
    if (r.status === 401 || r.status === 403) throw new Error('Log in to MakerWorld first, then try again.');
    if (!r.ok) throw new Error('MakerWorld said ' + r.status + '.');
    return r.json();
  }
  async function getDesign(id) {
    // the page's own data, if it's for this model; otherwise ask MakerWorld
    try {
      const nd = JSON.parse(document.getElementById('__NEXT_DATA__').textContent);
      const d = nd && nd.props && nd.props.pageProps && nd.props.pageProps.design;
      if (d && String(d.id) === String(id)) return d;
    } catch (e) { /* fall through */ }
    return getJson(`${API}/design/${id}`);
  }
  const profileLabel = (p) => { const t = p.title || p.name || ('Profile ' + p.id), m = p.machineName || p.printerName || ''; return m ? t + ' (' + m + ')' : t; };

  // ---------- downloading ----------
  const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
  const timeout = (ms, what) => new Promise((_, rej) => setTimeout(() => rej(new Error(what)), ms));
  // 1st try: an ordinary fetch (works if the file server allows it).
  async function viaFetch(url) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 25000);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.arrayBuffer();
    } finally { clearTimeout(t); }
  }
  // 2nd try: the Userscripts app's own downloader, using callbacks (works on every version).
  function viaGM(url) {
    const x = (typeof GM !== 'undefined' && GM.xmlHttpRequest) || (typeof GM_xmlhttpRequest !== 'undefined' && GM_xmlhttpRequest);
    if (!x) return Promise.reject(new Error('no downloader'));
    return Promise.race([new Promise((res, rej) => {
      const ret = x({
        url, method: 'GET', responseType: 'arraybuffer', timeout: 90000,
        onprogress: (e) => { if (e && e.loaded) toast('Downloading the 3MF… ' + mb(e.loaded)); },
        onload: (r) => (r.status && r.status >= 400) ? rej(new Error('HTTP ' + r.status)) : res(r.response),
        onerror: () => rej(new Error('download error')), ontimeout: () => rej(new Error('download timed out')),
      });
      if (ret && typeof ret.then === 'function') ret.then((r) => r && r.response && res(r.response), () => {});
    }), timeout(95000, 'download timed out')]);
  }
  async function binary(url) {
    let firstErr;
    try { const d = await viaFetch(url); if (d && d.byteLength) return d; } catch (e) { firstErr = e; }
    toast('Downloading the 3MF (second way)…');
    try {
      let d = await viaGM(url);
      if (typeof d === 'string') { const u = new Uint8Array(d.length); for (let i = 0; i < d.length; i++) u[i] = d.charCodeAt(i) & 255; d = u.buffer; }
      if (d && d.buffer && !(d instanceof ArrayBuffer)) d = d.buffer;
      if (d && d.byteLength) return d;
      throw new Error('empty file');
    } catch (e) {
      const err = new Error('Couldn’t download the file (' + (firstErr ? firstErr.message + ' / ' : '') + e.message + ').');
      err.url = url; throw err;
    }
  }
  const findUrl = (o) => {
    if (!o || typeof o !== 'object') return null;
    for (const k of ['url', 'downloadUrl', 'download_url', 'fileUrl']) if (typeof o[k] === 'string' && /^https?:/.test(o[k])) return o[k];
    for (const v of Object.values(o)) { const u = findUrl(v); if (u) return u; }
    return null;
  };
  async function fetch3mf(instanceId, fallbackName) {
    toast('Asking MakerWorld for the file…');
    const r = await Promise.race([fetch(`${API}/instance/${instanceId}/f3mf?type=download`, { credentials: 'include' }), timeout(25000, 'MakerWorld didn’t answer')]);
    if (r.status === 401 || r.status === 403) throw new Error('Log in to MakerWorld first, then try again.');
    if (!r.ok) throw new Error('MakerWorld wouldn’t give the file (' + r.status + ').');
    const type = r.headers.get('content-type') || '';
    if (/json/.test(type)) {
      const j = await r.json();
      const url = findUrl(j);
      if (!url) throw new Error('MakerWorld didn’t return a download link.');
      const name = (j.name || (j.data && j.data.name) || fallbackName || 'model').replace(/\.3mf$/i, '') + '.3mf';
      toast('Downloading the 3MF…');
      return { data: await binary(url), name };
    }
    return { data: await r.arrayBuffer(), name: (fallbackName || 'model') + '.3mf' };
  }

  // ---------- zips: pull the model files out ----------
  async function unpack(file) {
    const b = new Uint8Array(file.data.slice(0, 2)), pk = b[0] === 0x50 && b[1] === 0x4b;
    if (!(/\.zip$/i.test(file.name) || (pk && !/\.3mf$/i.test(file.name)))) return [file];
    if (typeof JSZip === 'undefined') throw new Error('this needs the zip reader, which didn’t load. Close and reopen Safari, then try again');
    const z = await JSZip.loadAsync(file.data);
    const out = [];
    for (const e of Object.values(z.files)) {
      if (e.dir || /(^|\/)(__MACOSX|\.)/.test(e.name) || !MODEL_EXT.test(e.name)) continue;
      out.push({ name: e.name.split('/').pop(), data: await e.async('arraybuffer') });
    }
    if (!out.length) throw new Error('the zip has no 3MF, STL or OBJ files in it');
    return out;
  }

  // ---------- each site: what files can be sent from this page ----------
  // An item is { name, size?, get: async () => { name, data } }.
  const fmtSize = (n) => n ? (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB') : '';
  const fileFromUrl = (url, name) => ({ name, get: async () => ({ name, data: await binary(url) }) });
  const nameFromUrl = (u) => { try { return decodeURIComponent(new URL(u, location.href).pathname.split('/').pop()) || 'model'; } catch (e) { return 'model'; } };

  const Sites = {
    makerworld: {
      here: () => !!modelId(),
      async items() {
        const design = await getDesign(modelId());
        const profiles = (design && design.instances) || [];
        if (!profiles.length) throw new Error('this model has no 3MF print profile to send');
        let pick = profiles.find((p) => String(p.id) === hashProfile());
        if (!pick && profiles.length === 1) pick = profiles[0];
        const title = (design.title || 'model').replace(/[\\/:*?"<>|]+/g, ' ').trim();
        const mk = (p) => ({ name: profileLabel(p), get: () => fetch3mf(p.id, title) });
        return { items: pick ? [mk(pick)] : profiles.map(mk), single: true, title: 'Which print profile?' };
      },
    },
    printables: {
      id: () => (location.pathname.match(/\/model\/(\d+)/) || [])[1],
      here() { return !!this.id(); },
      async items() {
        const id = this.id();
        const r = await fetch('https://api.printables.com/graphql/', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operationName: 'ModelFiles', query: 'query ModelFiles($id: ID!) { model: print(id: $id) { stls { id name fileSize folder } } }', variables: { id } }) });
        const j = await r.json();
        const files = ((j.data && j.data.model && j.data.model.stls) || []).filter((f) => MODEL_EXT.test(f.name || '') || /\.zip$/i.test(f.name || ''));
        if (!files.length) throw new Error('couldn’t find any 3MF, STL or OBJ files on this model');
        return { items: files.map((f) => ({ name: f.name, size: f.fileSize, get: async () => ({ name: f.name, data: await binary(await printablesLink(f, id)) }) })) };
      },
    },
    thingiverse: {
      id: () => (location.pathname.match(/thing:(\d+)/) || [])[1],
      here() { return !!this.id(); },
      async items() {
        const id = this.id(); const list = [];
        document.querySelectorAll('[data-item-id]').forEach((row) => {
          const m = (row.textContent || '').match(/[\w .()\-]+\.(3mf|stl|obj)\b/i);
          if (m) list.push(fileFromUrl('https://www.thingiverse.com/download:' + row.getAttribute('data-item-id'), m[0].trim()));
        });
        list.push(fileFromUrl('https://www.thingiverse.com/thing:' + id + '/zip', 'All files (zip)'));
        return { items: list };
      },
    },
    // any other site: plain links to model files on the page
    generic: {
      links() {
        const seen = new Map();
        document.querySelectorAll('a[href]').forEach((a) => {
          const href = a.href; if (!/^https?:/.test(href)) return;
          const path = href.split(/[?#]/)[0];
          if (MODEL_EXT.test(path) || /\.zip$/i.test(path)) seen.set(href, (a.getAttribute('download') || '').trim() || nameFromUrl(path));
        });
        return [...seen].map(([href, name]) => fileFromUrl(href, name));
      },
      here() { return this.links().length > 0; },
      async items() { const l = this.links(); if (!l.length) throw new Error('no model file links on this page'); return { items: l }; },
    },
  };
  async function printablesLink(f, modelId) {
    const ext = (f.name || '').toLowerCase().split('.').pop();
    const first = ext === '3mf' ? 'project' : ['stl', 'obj'].includes(ext) ? 'stl' : 'other';
    for (const t of [...new Set([first, 'stl', 'project', 'other'])]) {
      try {
        const r = await fetch('https://api.printables.com/graphql/', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operationName: 'GetDownloadLink',
            query: 'mutation GetDownloadLink($id: ID!, $modelId: ID!, $fileType: DownloadFileTypeEnum!, $source: DownloadSourceEnum!) { getDownloadLink(id: $id, printId: $modelId, fileType: $fileType, source: $source) { ok output { link } } }',
            variables: { id: String(f.id), modelId: String(modelId), fileType: t, source: 'model_detail' } }) });
        const j = await r.json(); const link = j && j.data && j.data.getDownloadLink && j.data.getDownloadLink.output && j.data.getDownloadLink.output.link;
        if (link) return link;
      } catch (e) { /* try the next type */ }
    }
    throw new Error('Printables didn’t give a download link. Are you logged in?');
  }
  const site = () => isMW ? Sites.makerworld : /printables\.com$/.test(host) ? Sites.printables : /thingiverse\.com$/.test(host) && Sites.thingiverse.here() ? Sites.thingiverse : Sites.generic;

  // ---------- handing files to Plate Builder ----------
  window.addEventListener('message', (ev) => {
    if (ev.origin !== PB_ORIGIN || !ev.data) return;
    if (ev.data.type === 'pb-ready') pbReady = true;
    if (ev.data.type === 'pb-got') toast('Added to Plate Builder ✓', 'ok');
  });
  const wait = (test, ms) => new Promise((res) => { const t0 = Date.now(); (function loop() { if (test()) return res(true); if (Date.now() - t0 > ms) return res(false); setTimeout(loop, 150); })(); });
  // MakerWorld files go to Plate Builder itself; files from other sites go through this add-on on the Plate Builder page.
  const post = (w, files) => isMW
    ? files.forEach((f) => w.postMessage({ type: 'pb-file', name: f.name, data: f.data }, PB_ORIGIN))
    : w.postMessage({ type: 'pb-files', files }, PB_ORIGIN);
  function handOver(files) {
    if (pbWin && !pbWin.closed && pbReady) { post(pbWin, files); toast('Added to Plate Builder ✓ Switch tabs to see it.', 'ok'); return; }
    readySheet(files);
  }
  // Safari only opens a new tab straight after a tap, so ask for one more tap.
  function readySheet(files) {
    const s = sheet(files.length === 1 ? 'Ready' : files.length + ' files ready', files.map((f) => f.name).join(', ') + (files.length === 1 ? ' is downloaded.' : ' are downloaded.'));
    s.add('Open in Plate Builder', 'go', () => viaTab(files));
    if (files.length === 1) s.add('Save to Downloads instead', 'cancel', () => saveInstead(files[0]));
    else s.add('Cancel', 'cancel', () => {});
  }
  async function viaTab(files) {
    if (!pbWin || pbWin.closed) { pbReady = false; pbWin = window.open(PLATE_BUILDER + '#from-' + host, 'plate-builder'); }
    else try { pbWin.focus(); } catch (e) {}
    if (!pbWin) return toast('Safari blocked the new tab. Allow pop-ups for ' + host + '.', 'err');
    if (await wait(() => pbReady, 15000)) post(pbWin, files);
    else { toast('Plate Builder didn’t answer. Is the add-on switched on for it?', 'err'); if (files.length === 1) saveInstead(files[0]); }
  }
  function saveInstead(file) {
    const url = URL.createObjectURL(new Blob([file.data], { type: 'application/octet-stream' }));
    const s = sheet('Save the file', 'Save it, then in Plate Builder tap Add files and pick it from Downloads.');
    const a = document.createElement('a'); a.href = url; a.download = file.name; a.textContent = 'Save ' + file.name; a.className = 'go';
    a.onclick = () => setTimeout(() => s.close(), 800);
    s.box.insertBefore(a, s.row); s.add('Close', 'cancel', () => {});
  }
  // Last resort: let Safari download it the normal way.
  function downloadNormally(url, msg) {
    const s = sheet('Couldn’t fetch it automatically', msg + ' Download it the normal way, then add it in Plate Builder from Downloads.');
    const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.textContent = 'Download the file'; a.className = 'go';
    a.onclick = () => setTimeout(() => s.close(), 800);
    s.box.insertBefore(a, s.row); s.add('Close', 'cancel', () => {});
  }

  // ---------- looks ----------
  const css = `
    #pb-send{position:fixed;right:14px;bottom:calc(18px + env(safe-area-inset-bottom));z-index:2147483644;font:700 16px/1 -apple-system,system-ui,sans-serif;
      background:#F5C518;color:#22262B;border:0;border-radius:14px;padding:14px 16px;box-shadow:0 8px 20px -8px rgba(0,0,0,.5)}
    .pb-sheet{position:fixed;inset:0;z-index:2147483647;background:rgba(10,12,15,.5);display:flex;align-items:flex-end;justify-content:center}
    .pb-sheet .in{background:#fff;color:#22262B;width:100%;max-width:560px;max-height:80vh;overflow:auto;border-radius:18px 18px 0 0;padding:16px 14px calc(16px + env(safe-area-inset-bottom));font:15px/1.4 -apple-system,system-ui,sans-serif;box-sizing:border-box}
    .pb-sheet h3{margin:0 0 6px;font-size:17px} .pb-sheet p{margin:0 0 10px;color:#5B636D}
    .pb-sheet button,.pb-sheet a.go{display:block;box-sizing:border-box;width:100%;text-align:center;margin:6px 0;padding:13px;border:1px solid #D3D7DC;border-radius:12px;background:#F4F5F7;color:#22262B;font:700 15px -apple-system,system-ui,sans-serif;text-decoration:none}
    .pb-sheet .go{background:#F5C518;border-color:#F5C518} .pb-sheet .cancel{background:none;font-weight:600}
    .pb-sheet .pick{text-align:left;font-weight:500}
    .pb-sheet label.f{display:flex;gap:10px;align-items:center;padding:11px 4px;border-bottom:1px solid #EEF0F2;font-size:15px}
    .pb-sheet label.f input{width:22px;height:22px;flex:none} .pb-sheet label.f small{color:#5B636D;margin-left:auto;flex:none}
    #pb-toast{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(80px + env(safe-area-inset-bottom));z-index:2147483647;background:#22262B;color:#fff;padding:10px 14px;border-radius:10px;font:600 14px/1.3 -apple-system,system-ui,sans-serif;max-width:86vw}
    #pb-toast.err{background:#B42318} #pb-toast.ok{background:#2F7D4F}`;
  const style = document.createElement('style'); style.textContent = css; document.documentElement.appendChild(style);
  let toastTimer = null;
  function toast(text, kind) {
    let t = document.getElementById('pb-toast'); if (!t) { t = document.createElement('div'); t.id = 'pb-toast'; document.body.appendChild(t); }
    t.textContent = text; t.className = kind || ''; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), kind === 'err' ? 7000 : 3500);
  }
  function sheet(title, text) {
    const s = document.createElement('div'); s.className = 'pb-sheet';
    s.innerHTML = '<div class="in"><h3></h3><p></p><div class="row"></div></div>';
    s.querySelector('h3').textContent = title; const p = s.querySelector('p'); if (text) p.textContent = text; else p.remove();
    const api = { el: s, box: s.firstChild, row: s.querySelector('.row'), close: () => s.remove(),
      add(label, cls, fn) { const b = document.createElement('button'); b.type = 'button'; b.className = cls || ''; b.textContent = label; b.onclick = () => { s.remove(); fn(); }; this.row.appendChild(b); return b; } };
    document.body.appendChild(s); return api;
  }
  // choose one (MakerWorld profiles) or several (files)
  function choose(list, opts) {
    return new Promise((resolve) => {
      const s = sheet(opts.title || 'Which files?', opts.single ? '' : 'Tick the ones to send.');
      if (opts.single) {
        list.forEach((it) => { const b = s.add(it.name, 'pick', () => resolve([it])); });
        s.add('Cancel', 'cancel', () => resolve(null));
        return;
      }
      const boxes = list.map((it, i) => {
        const l = document.createElement('label'); l.className = 'f';
        const c = document.createElement('input'); c.type = 'checkbox'; c.checked = list.length === 1 || (i === 0 && /3mf$/i.test(it.name));
        const t = document.createElement('span'); t.textContent = it.name; const z = document.createElement('small'); z.textContent = fmtSize(it.size);
        l.append(c, t, z); s.box.insertBefore(l, s.row); return c;
      });
      const go = s.add('Send to Plate Builder', 'go', () => resolve(list.filter((_, i) => boxes[i].checked)));
      s.add('Cancel', 'cancel', () => resolve(null));
      const upd = () => { const n = boxes.filter((b) => b.checked).length; go.disabled = !n; go.textContent = n > 1 ? `Send ${n} to Plate Builder` : 'Send to Plate Builder'; };
      boxes.forEach((b) => b.addEventListener('change', upd)); upd();
    });
  }

  // ---------- the main flow ----------
  let running = false;
  async function sendItems(items) {
    const files = []; let fromZip = false;
    for (let i = 0; i < items.length; i++) {
      toast(items.length > 1 ? `Downloading ${i + 1} of ${items.length}…` : 'Downloading…');
      const f = await items[i].get(), got = await unpack(f);
      if (got.length !== 1 || got[0] !== f) fromZip = true;
      files.push(...got);
    }
    if (fromZip && files.length > 1) {
      const pick = await choose(files.map((f) => ({ name: f.name, size: f.data.byteLength, f })), { title: 'Which files from the zip?' });
      if (!pick || !pick.length) return toast('Cancelled.');
      return handOver(pick.map((x) => x.f));
    }
    handOver(files);
  }
  async function send() {
    if (running) return; running = true;
    try {
      toast('Looking for files…');
      const s = site(), { items, single, title } = await s.items();
      const pick = items.length === 1 ? items : await choose(items, { single, title });
      if (!pick || !pick.length) return toast('Cancelled.');
      await sendItems(pick);
    } catch (e) {
      if (e.url) downloadNormally(e.url, e.message);
      toast('Couldn’t send: ' + (e.message || e), 'err');
    } finally { running = false; }
  }
  // On sites other than MakerWorld, a tap on a plain link to a model file offers to send it here instead.
  document.addEventListener('click', (ev) => {
    if (isMW || ev.defaultPrevented) return;
    const a = ev.target.closest && ev.target.closest('a[href]'); if (!a || a.dataset.pbPass) return;
    const path = a.href.split(/[?#]/)[0];
    if (!(MODEL_EXT.test(path) || /\.zip$/i.test(path) || /thingiverse\.com\/download:\d+/.test(a.href))) return;
    ev.preventDefault(); ev.stopPropagation();
    const name = (a.getAttribute('download') || '').trim() || nameFromUrl(path);
    const s = sheet(name, '');
    s.add('Send to Plate Builder', 'go', () => { if (!running) { running = true; sendItems([fileFromUrl(a.href, name)]).catch((e) => { if (e.url) downloadNormally(e.url, e.message); toast('Couldn’t send: ' + (e.message || e), 'err'); }).finally(() => { running = false; }); } });
    s.add('Download normally', '', () => { a.dataset.pbPass = '1'; a.click(); setTimeout(() => delete a.dataset.pbPass, 1000); });
    s.add('Cancel', 'cancel', () => {});
  }, true);

  function ensureButton() {
    let want = false; try { want = site().here(); } catch (e) {}
    let b = document.getElementById('pb-send');
    if (want && !b) { b = document.createElement('button'); b.id = 'pb-send'; b.type = 'button'; b.textContent = 'Send to Plate Builder'; b.onclick = send; document.body.appendChild(b); }
    if (!want && b) b.remove();
  }
  // these sites change pages without reloading, so keep checking
  ensureButton();
  setInterval(ensureButton, 1500);
