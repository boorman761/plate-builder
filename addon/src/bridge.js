// =====================================================================================
// On Plate Builder itself: talk to the Flashforge printer over the home Wi-Fi.
// Uses the printer's own network API (port 8898), as Flashforge's apps and Orca do.
// =====================================================================================
function printerBridge(SITE_ORIGINS, GM, JSZip) {
  const KEY = 'pb.printer';
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } };
  const save = (c) => localStorage.setItem(KEY, JSON.stringify(c));
  const reply = (id, data) => window.postMessage(Object.assign({ id, type: 'pb-answer' }, data), location.origin);
  const progress = (id, text) => window.postMessage({ id, type: 'pb-progress', text }, location.origin);

  function req(o) {
    const x = (typeof GM !== 'undefined' && GM.xmlHttpRequest) || (typeof GM_xmlhttpRequest !== 'undefined' && GM_xmlhttpRequest);
    if (!x) return Promise.reject(new Error('the Userscripts app isn’t letting the add-on make requests'));
    return new Promise((res, rej) => {
      let settled = false; const ok = (v) => { if (!settled) { settled = true; res(v); } }, bad = (e) => { if (!settled) { settled = true; rej(e); } };
      const t = setTimeout(() => bad(new Error('the printer didn’t answer')), (o.timeout || 15000) + 2000);
      const ret = x({
        method: o.method || 'GET', url: o.url, headers: o.headers || {}, data: o.data, timeout: o.timeout || 15000,
        onload: (r) => { clearTimeout(t); ok(r); },
        onerror: () => { clearTimeout(t); bad(new Error('couldn’t reach the printer. Check the IP address, and that the phone is on the same Wi-Fi')); },
        ontimeout: () => { clearTimeout(t); bad(new Error('the printer didn’t answer')); },
      });
      if (ret && typeof ret.then === 'function') ret.then((r) => { if (r && r.status !== undefined) { clearTimeout(t); ok(r); } }, () => {});
    });
  }
  const json = (r) => { try { return typeof r.response === 'object' && r.response ? r.response : JSON.parse(r.responseText || r.response || 'null'); } catch (e) { return null; } };
  const base = (c) => 'http://' + c.ip.trim().replace(/^https?:\/\//, '').replace(/[:/].*$/, '') + ':8898';

  async function detail(c) {
    const r = await req({ method: 'POST', url: base(c) + '/detail', headers: { 'Content-Type': 'application/json' }, data: JSON.stringify({ serialNumber: c.serial.trim(), checkCode: c.code.trim() }) });
    const j = json(r);
    if (!j) throw new Error('the printer gave an answer this add-on doesn’t understand (HTTP ' + r.status + ')');
    if (j.code !== 0) throw new Error(/check|code|serial|auth/i.test(j.message || '') ? 'the printer turned down the serial number or check code' : 'the printer said: ' + (j.message || ('code ' + j.code)));
    return j.detail || {};
  }
  // filaments the printer reports as loaded, in slot order
  function loadedOf(d) {
    let list = d.matlStationInfo && d.matlStationInfo.slotInfos;
    if (!list || !list.length) {
      const seen = []; (function walk(o) { if (!o || typeof o !== 'object') return; if (Array.isArray(o) && o.length && o.every((x) => x && typeof x === 'object' && 'materialColor' in x)) { seen.push(o); return; } for (const v of Object.values(o)) walk(v); })(d);
      list = seen[0];
    }
    if (list && list.length) return list.slice().sort((a, b) => (a.slotId || 0) - (b.slotId || 0)).map((x) => (x.hasFilament === false || !/^#?[0-9a-f]{6}$/i.test(x.materialColor || '')) ? null : { colour: '#' + x.materialColor.replace('#', ''), material: x.materialName && x.materialName !== '?' ? x.materialName : 'PLA' });
    const one = d.indepMatlInfo;
    if (one && /^#?[0-9a-f]{6}$/i.test(one.materialColor || '')) return [{ colour: '#' + one.materialColor.replace('#', ''), material: one.materialName && one.materialName !== '?' ? one.materialName : 'PLA' }];
    return [];
  }
  const busy = (st) => /print|pause|busy|heat|calibrat/i.test(st || '') && !/complete|finish|cancel|ready/i.test(st || '');

  async function upload(c, msg, id) {
    const isC5 = /creator\s*5/i.test(msg.model || '');
    const B = '----PlateBuilder' + Math.random().toString(16).slice(2);
    const fname = msg.name.replace(/["\r\n]/g, '');
    const body = `--${B}\r\nContent-Disposition: form-data; name="gcodeFile"; filename="${fname}"\r\nContent-Type: application/octet-stream\r\n\r\n` + msg.gcode + `\r\n--${B}--\r\n`;
    const j = msg.job;
    const h = {
      'Content-Type': 'multipart/form-data; boundary=' + B,
      serialNumber: c.serial.trim(), checkCode: c.code.trim(), fileSize: String(j.fileSize),
      printNow: 'true', levelingBeforePrint: j.levelingBeforePrint, flowCalibration: j.flowCalibration, timeLapseVideo: j.timeLapseVideo,
      useMatlStation: j.useMatlStation, gcodeToolCnt: j.gcodeToolCnt, materialMappings: j.materialMappings,
    };
    if (!isC5) h.firstLayerInspection = j.firstLayerInspection;
    progress(id, 'Uploading ' + (Number(j.fileSize) / 1048576).toFixed(1) + ' MB to ' + (c.name || 'the printer') + '…');
    const r = await req({ method: 'POST', url: base(c) + '/uploadGcode', headers: h, data: body, timeout: 600000 });
    const a = json(r);
    if (a && a.code === 0) return { ok: true, message: 'Sent. ' + (c.name || 'The printer') + ' is starting the print.' };
    return { ok: false, message: 'The printer didn’t accept it: ' + ((a && a.message) || ('HTTP ' + r.status)) };
  }

  // ---- settings sheet ----
  const css = `#pbp{position:fixed;inset:0;z-index:2147483647;background:rgba(10,12,15,.5);display:flex;align-items:flex-end;justify-content:center;font:15px/1.4 -apple-system,system-ui,sans-serif}
    #pbp .in{background:#fff;color:#22262B;width:100%;max-width:560px;border-radius:18px 18px 0 0;padding:16px 14px calc(16px + env(safe-area-inset-bottom))}
    #pbp h3{margin:0 0 6px;font-size:17px} #pbp p{margin:0 0 10px;color:#5B636D} #pbp label{display:block;font-size:13px;color:#5B636D;margin:8px 0 3px}
    #pbp input{width:100%;box-sizing:border-box;font:16px -apple-system,system-ui,sans-serif;padding:11px;border:1px solid #D3D7DC;border-radius:10px}
    #pbp .row{display:flex;gap:8px;margin-top:14px} #pbp button{flex:1;padding:13px;border-radius:12px;border:1px solid #D3D7DC;background:#F4F5F7;font:700 15px -apple-system,system-ui,sans-serif;color:#22262B}
    #pbp button.go{background:#F5C518;border-color:#F5C518} #pbp .msg{margin-top:10px;font-weight:600} #pbp .msg.err{color:#B42318} #pbp .msg.ok{color:#2F7D4F}`;
  function settingsSheet() {
    return new Promise((resolve) => {
      if (!document.getElementById('pbp-css')) { const st = document.createElement('style'); st.id = 'pbp-css'; st.textContent = css; document.head.appendChild(st); }
      const c = load() || { name: '', ip: '', serial: '', code: '' };
      const s = document.createElement('div'); s.id = 'pbp';
      s.innerHTML = `<div class="in"><h3>Your printer</h3><p>Find these on the printer’s screen, in its network settings.</p>
        <label for="pbp-ip">IP address</label><input id="pbp-ip" inputmode="decimal" autocomplete="off" placeholder="192.168.1.50">
        <label for="pbp-serial">Serial number</label><input id="pbp-serial" autocomplete="off" autocapitalize="characters">
        <label for="pbp-code">Check code</label><input id="pbp-code" autocomplete="off">
        <div class="msg" role="status"></div>
        <div class="row"><button type="button" class="cancel">Cancel</button><button type="button" class="go">Check and save</button></div></div>`;
      const $ = (q) => s.querySelector(q);
      $('#pbp-ip').value = c.ip; $('#pbp-serial').value = c.serial; $('#pbp-code').value = c.code;
      const msg = (t, k) => { $('.msg').textContent = t; $('.msg').className = 'msg ' + (k || ''); };
      $('.cancel').onclick = () => { s.remove(); resolve(null); };
      $('.go').onclick = async () => {
        const n = { ip: $('#pbp-ip').value.trim(), serial: $('#pbp-serial').value.trim(), code: $('#pbp-code').value.trim() };
        if (!n.ip || !n.serial || !n.code) return msg('Fill in all three.', 'err');
        msg('Checking…'); $('.go').disabled = true;
        try {
          const d = await detail(n);
          n.name = d.name || 'Printer'; n.model = d.model || '';
          save(n); msg('Connected to ' + n.name + (d.status ? ' (' + d.status + ')' : '') + '.', 'ok');
          setTimeout(() => { s.remove(); resolve(n); }, 900);
        } catch (e) { msg('Not saved: ' + e.message + '.', 'err'); $('.go').disabled = false; }
      };
      document.body.appendChild(s);
    });
  }
  async function ensure() { const c = load(); return c && c.ip && c.serial && c.code ? c : settingsSheet(); }

  window.addEventListener('message', async (ev) => {
    const m = ev.data;
    if (ev.origin !== location.origin || !m || !m.id || !/^pb-(print|read-loaded|settings)$/.test(m.type)) return;
    try {
      if (m.type === 'pb-settings') { const c = await settingsSheet(); return reply(m.id, c ? { ok: true, message: 'Printer saved: ' + c.name + '.' } : { ok: false }); }
      const c = await ensure();
      if (!c) return reply(m.id, { ok: false, message: 'Cancelled.' });
      progress(m.id, 'Checking ' + (c.name || 'the printer') + '…');
      const d = await detail(c);
      if (m.type === 'pb-read-loaded') return reply(m.id, { ok: true, printer: d.name || c.name, slots: loadedOf(d) });
      if (busy(d.status)) return reply(m.id, { ok: false, message: (d.name || 'The printer') + ' is busy (' + d.status + '). Try again when it’s finished.' });
      reply(m.id, await upload(c, m, m.id));
    } catch (e) { reply(m.id, { ok: false, message: 'Couldn’t send: ' + e.message + '.' }); }
  });

  // Files sent from model sites other than MakerWorld (Plate Builder itself only listens to MakerWorld):
  // put them in the Add files picker, as if picked from Files.
  if (window.opener) {
    let n = 0; const hello = () => { try { window.opener.postMessage({ type: 'pb-ready' }, '*'); } catch (e) {} if (++n < 40) setTimeout(hello, 500); };
    setTimeout(hello, 300);
  }
  window.addEventListener('message', (ev) => {
    if (!SITE_ORIGINS.test(ev.origin) || /makerworld\.com$/i.test(ev.origin) || !ev.data || ev.data.type !== 'pb-files') return;
    const list = (ev.data.files || []).filter((f) => f && f.data instanceof ArrayBuffer);
    if (!list.length) return;
    try { ev.source && ev.source.postMessage({ type: 'pb-got' }, ev.origin); } catch (e) {}
    injectFiles(list);
    window.focus();
  });
  // Put files into Plate Builder's Add files picker, as if picked from Files (zips are opened by the handler below).
  function injectFiles(list) {
    const dt = new DataTransfer();
    for (const f of list) dt.items.add(new File([f.data], f.name || 'model.stl'));
    const input = document.getElementById('pick'); if (!input) return false;
    input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  // Zips: let Add files pick them, then hand Plate Builder the 3MF, STL and OBJ files from inside.
  // Most sites (Creative Fabrica, MyMiniFactory, Thingiverse's "all files") download models as a zip.
  const pickIn = document.getElementById('pick');
  if (pickIn && !/zip/.test(pickIn.accept)) pickIn.accept += ',.zip,application/zip,application/x-zip-compressed';
  document.addEventListener('change', async (ev) => {
    const input = ev.target;
    if (!input || input.id !== 'pick' || input.dataset.pbUnzipped) return;
    const picked = [...(input.files || [])];
    const isZip = (f) => /\.zip$/i.test(f.name) || /zip/.test(f.type);
    if (!picked.some(isZip)) return;
    ev.stopImmediatePropagation(); ev.stopPropagation();
    const out = [], skipped = [];
    try {
      if (typeof JSZip === 'undefined') throw new Error('the zip reader didn’t load. Close and reopen Safari, then try again');
      for (const f of picked) {
        if (!isZip(f)) { out.push(f); continue; }
        const z = await JSZip.loadAsync(await f.arrayBuffer()); let n = 0;
        for (const e of Object.values(z.files)) {
          if (e.dir || /(^|\/)(__MACOSX|\.)/.test(e.name) || !/\.(3mf|stl|obj)$/i.test(e.name)) continue;
          out.push(new File([await e.async('arraybuffer')], e.name.split('/').pop())); n++;
        }
        if (!n) skipped.push(f.name);
      }
    } catch (e) { setStatus('Couldn’t open the zip: ' + (e.message || e)); return; }
    if (!out.length) { setStatus(skipped.join(', ') + ' has no 3MF, STL or OBJ files in it.'); return; }
    const dt = new DataTransfer(); out.forEach((f) => dt.items.add(f));
    input.dataset.pbUnzipped = '1'; input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    delete input.dataset.pbUnzipped;
  }, true);
  function setStatus(t) { const el = document.getElementById('status'); if (el) { el.textContent = t; el.className = 'status err'; } }
  document.documentElement.dataset.pbBridge = '2.1.0';
  window.dispatchEvent(new Event('pb-bridge'));
  return { injectFiles };
}
if (typeof module === 'object' && module.exports) module.exports = printerBridge;
