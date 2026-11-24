/* Flashforge Plate Builder — core (no DOM). Needs JSZip. */
const FF = (() => {
  const UNIT = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
  const RZ90 = [0, 1, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0];
  const FEATURE_KEYS = ['wall_filament', 'sparse_infill_filament', 'solid_infill_filament', 'support_filament', 'support_interface_filament'];
  // Print properties carried over from the first source project.
  const KEEP_PRINT = ['layer_height', 'initial_layer_print_height', 'wall_loops', 'top_shell_layers', 'bottom_shell_layers',
    'top_shell_thickness', 'bottom_shell_thickness', 'sparse_infill_density', 'sparse_infill_pattern', 'top_surface_pattern',
    'bottom_surface_pattern', 'internal_solid_infill_pattern', 'enable_support', 'support_type', 'support_style',
    'support_threshold_angle', 'support_on_build_plate_only', 'support_top_z_distance', 'support_bottom_z_distance',
    'support_interface_top_layers', 'support_interface_bottom_layers', 'support_object_xy_distance', 'brim_type', 'brim_width',
    'brim_object_gap', 'seam_position', 'ironing_type', 'only_one_wall_top', 'only_one_wall_first_layer', 'wall_generator',
    'detect_thin_wall', 'raft_layers', 'skirt_loops', 'infill_direction', 'elefant_foot_compensation', 'print_sequence',
    'wall_sequence', 'infill_wall_overlap', 'fuzzy_skin', 'fuzzy_skin_thickness', 'fuzzy_skin_point_distance'];

  const attrs = (tag) => { const o = {}; tag.replace(/([\w:.-]+)\s*=\s*"([^"]*)"/g, (m, k, v) => { o[k] = v; return m; }); return o; };
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const unesc = (s) => String(s).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const parseT = (s) => { if (!s) return I.slice(); const a = s.trim().split(/\s+/).map(Number); return a.length === 12 && a.every(isFinite) ? a : I.slice(); };
  function mul(A, B) { // row-vector convention: p * A * B
    const r = new Array(12);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
    for (let j = 0; j < 3; j++) r[9 + j] = A[9] * B[j] + A[10] * B[3 + j] + A[11] * B[6 + j] + B[9 + j];
    return r;
  }
  const fmtT = (M) => M.map((v) => { const x = Math.abs(v) < 1e-9 ? 0 : v; return String(+x.toFixed(6)); }).join(' ');
  const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
  const basename = (p) => p.split('/').pop();

  // ---------- paint data (Bambu/Orca/Prusa triangle selector hex strings) ----------
  function walkPaint(hex, fn) {
    const n = hex.length, nib = new Array(n);
    for (let i = 0; i < n; i++) nib[i] = parseInt(hex[n - 1 - i], 16) || 0;
    const out = []; let i = 0;
    while (i < n) {
      const code = nib[i++];
      if (code & 3) { out.push(code); continue; }
      let st;
      if ((code & 12) === 12) { const a = nib[i++] ?? 0; st = a === 15 ? (nib[i++] ?? 0) + 18 : a + 3; } else st = code >> 2;
      const ns = fn(st);
      if (ns < 3) out.push(ns << 2); else if (ns <= 17) out.push(12, ns - 3); else out.push(12, 15, ns - 18);
    }
    let s = ''; for (let k = out.length - 1; k >= 0; k--) s += out[k].toString(16).toUpperCase();
    return s;
  }

  // ---------- reading ----------
  function parseObjects(xml) {
    const out = new Map(); const re = /<object\b([^>]*)>([\s\S]*?)<\/object>/g; let m;
    while ((m = re.exec(xml))) {
      const a = attrs(m[1]); const inner = m[2]; const comps = [];
      if (inner.indexOf('<component') >= 0) inner.replace(/<component\b[^>]*>/g, (t) => { const c = attrs(t); comps.push({ path: (c['p:path'] || '').replace(/^\//, ''), objectid: +c.objectid, T: parseT(c.transform) }); return t; });
      out.set(+a.id, { id: +a.id, a, inner, comps, hasMesh: inner.indexOf('<mesh') >= 0 });
    }
    return out;
  }
  function vertices(inner) {
    const arr = []; const re = /<vertex\b([^>]*)\/?>/g; let m;
    while ((m = re.exec(inner))) {
      const s = m[1];
      const x = /\bx="([^"]+)"/.exec(s), y = /\by="([^"]+)"/.exec(s), z = /\bz="([^"]+)"/.exec(s);
      arr.push(+(x && x[1]), +(y && y[1]), +(z && z[1]));
    }
    return Float32Array.from(arr);
  }
  const metaMap = (block) => { const o = {}; block.replace(/<metadata\s+key="([^"]*)"\s+value="([^"]*)"\s*\/>/g, (m, k, v) => { o[k] = unesc(v); return m; }); return o; };
  const paintAttrRe = /\b(?:paint_color|slic3rpe:mmu_segmentation)="([0-9A-Fa-f]+)"/g;

  async function readSource(data, fileName) {
    const zip = await JSZip.loadAsync(data);
    const names = {}; zip.forEach((p, f) => { if (!f.dir) names[p.toLowerCase()] = p; });
    const has = (p) => names[p.replace(/^\//, '').toLowerCase()];
    const get = async (p, type = 'string') => { const real = has(p); return real ? zip.file(real).async(type) : null; };
    let mainPath = '3D/3dmodel.model';
    const rels = await get('_rels/.rels');
    if (rels) { const m = rels.match(/<Relationship\b[^>]*Type="[^"]*3dmodel"[^>]*>/i); if (m) { const t = attrs(m[0]).Target; if (t) mainPath = t.replace(/^\//, ''); } }
    const mainXml = await get(mainPath);
    if (!mainXml) throw new Error('No 3D model inside. If this is a sliced print file (.gcode.3mf), download the 3MF project instead.');
    const head = mainXml.slice(0, 4000);
    const unitM = /<model\b[^>]*\bunit="([^"]+)"/.exec(head); const scale = UNIT[unitM ? unitM[1] : 'millimeter'] || 1;
    const meta = {}; mainXml.replace(/<metadata\s+name="([^"]+)"\s*>([\s\S]*?)<\/metadata>/g, (m, k, v) => { if (v.length < 2000) meta[k] = unesc(v.trim()); return m; });
    const app = meta.Application || '';

    const models = new Map(); models.set(mainPath, { objects: parseObjects(mainXml) });
    // load referenced sub-models (Bambu/Orca keep meshes in 3D/Objects/*.model)
    let queue = [mainPath];
    while (queue.length) {
      const next = [];
      for (const p of queue) for (const o of models.get(p).objects.values()) for (const c of o.comps) {
        const cp = c.path || p; c.path = cp;
        if (!models.has(cp)) { const xml = await get(cp); models.set(cp, { objects: xml ? parseObjects(xml) : new Map() }); next.push(cp); }
      }
      queue = next;
    }

    // settings
    let project = null; const pj = await get('Metadata/project_settings.config');
    if (pj) { try { project = JSON.parse(pj); } catch (e) { project = null; } }
    let filaments = [];
    if (project && Array.isArray(project.filament_colour)) {
      filaments = project.filament_colour.map((c, i) => ({ colour: normColour(c), type: (project.filament_type || [])[i] || 'PLA', name: (project.filament_settings_id || [])[i] || '' }));
    } else {
      const pe = await get('Metadata/Slic3r_PE.config');
      const m = pe && /;\s*filament_colour\s*=\s*([^\n]*)/.exec(pe);
      const t = pe && /;\s*filament_type\s*=\s*([^\n]*)/.exec(pe);
      if (m) { const types = t ? t[1].split(';') : []; filaments = m[1].split(';').map((c, i) => ({ colour: normColour(c), type: (types[i] || 'PLA').trim(), name: '' })); }
    }
    if (!filaments.length) filaments = [{ colour: '#DDDDDD', type: 'PLA', name: '' }];

    const ms = await get('Metadata/model_settings.config');
    const msObjects = new Map(); const plates = [];
    if (ms) {
      ms.replace(/<object\s+id="(\d+)"[^>]*>([\s\S]*?)<\/object>/g, (m, id, body) => { msObjects.set(+id, m); return m; });
      ms.replace(/<plate>([\s\S]*?)<\/plate>/g, (m, body) => {
        const pm = metaMap(body.split('<model_instance')[0]);
        const inst = []; body.replace(/<model_instance>([\s\S]*?)<\/model_instance>/g, (mm, ib) => { const im = metaMap(ib); inst.push({ obj: +im.object_id, inst: +im.instance_id }); return mm; });
        plates.push({ id: +pm.plater_id, name: pm.plater_name || '', inst });
        return m;
      });
    }
    // build items -> instances, plate assignment
    const items = []; const counts = {};
    mainXml.replace(/<item\b[^>]*>/g, (t) => {
      const a = attrs(t); const oid = +a.objectid; const k = counts[oid] = (counts[oid] ?? -1) + 1;
      if (a.printable === '0') return t;
      let plate = plates.length ? 0 : 1;
      for (const p of plates) if (p.inst.some((x) => x.obj === oid && x.inst === k)) { plate = p.id; break; }
      items.push({ oid, T: mul(parseT(a.transform), [scale, 0, 0, 0, scale, 0, 0, 0, scale, 0, 0, 0]), plate });
      return t;
    });
    const plateIds = [...new Set(items.map((i) => i.plate))].filter((p) => p > 0).sort((a, b) => a - b);
    const thumbs = {};
    for (const p of plateIds) { const t = await get(`Metadata/plate_${p}.png`, 'base64'); if (t) thumbs[p] = 'data:image/png;base64,' + t; }

    // Which printer/slicer the file was made for
    let made = null;
    const slicer = (app.split('-')[0] || '').replace('BambuStudio', 'Bambu Studio').replace('OrcaSlicer', 'OrcaSlicer').replace('PrusaSlicer', 'PrusaSlicer');
    if (project) {
      made = { printer: project.printer_model || String(project.printer_settings_id || '').replace(/\s*\d?\.\d+\s*nozzle.*$/i, ''), nozzle: (project.nozzle_diameter || [])[0] || '', profile: String(project.print_settings_id || '').split('@')[0].trim() };
    } else {
      const pe = await get('Metadata/Slic3r_PE.config');
      if (pe) {
        const g = (k) => { const m = new RegExp(';\\s*' + k + '\\s*=\\s*([^\\n]*)').exec(pe); return m ? m[1].trim() : ''; };
        made = { printer: g('printer_model') || g('printer_settings_id'), nozzle: g('nozzle_diameter').split(',')[0], profile: g('print_settings_id').split('@')[0].trim() };
      }
    }
    if (made && !made.printer) made = null;
    // PrusaSlicer projects (common on Printables): translate the author's settings to Orca names
    if (!project) {
      const pe = await get('Metadata/Slic3r_PE.config');
      if (pe) project = fromPrusa(pe);
    }
    if (made) made.slicer = slicer;
    const src = { made, slicer, fileName, zip, mainPath, models, project, filaments, msObjects, items, plateIds, thumbs, meta, app, scale,
      title: meta.Title || fileName.replace(/\.3mf$/i, ''), leafCache: new Map(), vertCache: new Map() };
    return src;
  }

  const ORCA_INFILL = new Set(['concentric', 'zig-zag', 'grid', 'line', 'cubic', 'triangles', 'tri-hexagon', 'gyroid', 'honeycomb', 'adaptivecubic', 'alignedrectilinear', '3dhoneycomb', 'hilbertcurve', 'archimedeanchords', 'octagramspiral', 'supportcubic', 'lightning', 'crosshatch']);
  function fromPrusa(text) {
    const g = (k) => { const m = new RegExp('^;\\s*' + k + '\\s*=\\s*(.*)$', 'm').exec(text); return m ? m[1].trim() : undefined; };
    const list = (k) => { const v = g(k); return v === undefined ? undefined : v.split(/[,;]/).map((x) => x.trim()); };
    const o = { _from: 'prusa' };
    const set = (k, v) => { if (v !== undefined && v !== '') o[k] = String(v); };
    set('layer_height', g('layer_height')); set('initial_layer_print_height', g('first_layer_height'));
    set('wall_loops', g('perimeters')); set('top_shell_layers', g('top_solid_layers')); set('bottom_shell_layers', g('bottom_solid_layers'));
    set('sparse_infill_density', g('fill_density'));
    const fp = (g('fill_pattern') || '').replace('rectilinear', 'zig-zag').replace('aligned', 'alignedrectilinear').replace('stars', 'tri-hexagon');
    if (ORCA_INFILL.has(fp)) set('sparse_infill_pattern', fp);
    if (g('support_material') !== undefined) { set('enable_support', g('support_material') === '1' ? '1' : '0'); set('support_threshold_angle', g('support_material_threshold')); }
    if (g('support_material_buildplate_only') !== undefined) set('support_on_build_plate_only', g('support_material_buildplate_only'));
    const seam = { aligned: 'aligned', nearest: 'nearest', rear: 'back', random: 'random' }[g('seam_position')]; set('seam_position', seam);
    set('elefant_foot_compensation', g('elefant_foot_compensation'));
    const bw = +g('brim_width'); if (g('brim_width') !== undefined) { set('brim_type', bw > 0 ? 'outer_only' : 'no_brim'); if (bw > 0) set('brim_width', bw); }
    set('raft_layers', g('raft_layers')); set('skirt_loops', g('skirts'));
    const t = list('temperature'), t0 = list('first_layer_temperature'), b = list('bed_temperature'), b0 = list('first_layer_bed_temperature');
    if (t) o.nozzle_temperature = t; if (t0) o.nozzle_temperature_initial_layer = t0; if (b) o.hot_plate_temp = o.textured_plate_temp = b; if (b0) o.hot_plate_temp_initial_layer = o.textured_plate_temp_initial_layer = b0;
    set('print_settings_id', g('print_settings_id'));
    return Object.keys(o).length > 1 ? o : null;
  }
  // ---------- STL (and OBJ) files ----------
  // Plain meshes with no colours or settings, e.g. from Creative Fabrica or Thingiverse. They become a one-object
  // "source" shaped like a 3MF one, so the rest of the app treats them the same way.
  function meshToSource(verts, tris, fileName, title) {
    const v = [], t = [];
    for (let i = 0; i < verts.length; i += 3) v.push(`<vertex x="${+verts[i].toFixed(4)}" y="${+verts[i + 1].toFixed(4)}" z="${+verts[i + 2].toFixed(4)}"/>`);
    for (let i = 0; i < tris.length; i += 3) t.push(`<triangle v1="${tris[i]}" v2="${tris[i + 1]}" v3="${tris[i + 2]}"/>`);
    const inner = `<mesh><vertices>${v.join('')}</vertices><triangles>${t.join('')}</triangles></mesh>`;
    const mainPath = 'mesh.model';
    const obj = { id: 1, a: { id: '1', name: title, type: 'model' }, inner, comps: [], hasMesh: true };
    const src = { made: null, slicer: '', fileName, zip: null, mainPath, models: new Map([[mainPath, { objects: new Map([[1, obj]]) }]]), project: null,
      filaments: [{ colour: '#DDDDDD', type: 'PLA', name: '' }], msObjects: new Map(), items: [{ oid: 1, T: I.slice(), plate: 1 }], plateIds: [1], thumbs: {},
      meta: {}, app: '', scale: 1, title, leafCache: new Map(), vertCache: new Map(), plain: true };
    src.vertCache.set(mainPath + '|1', Float32Array.from(verts));
    return src;
  }
  // Merge vertices that share a position so the mesh stays closed.
  function weld(points) {
    const map = new Map(), verts = [], tris = new Uint32Array(points.length / 3);
    for (let i = 0; i < points.length; i += 3) {
      const k = Math.round(points[i] * 1e4) + ',' + Math.round(points[i + 1] * 1e4) + ',' + Math.round(points[i + 2] * 1e4);
      let id = map.get(k);
      if (id === undefined) { id = verts.length / 3; map.set(k, id); verts.push(points[i], points[i + 1], points[i + 2]); }
      tris[i / 3] = id;
    }
    return { verts, tris };
  }
  function readStl(data, fileName) {
    const buf = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    const dv = new DataView(buf); let points;
    const n = buf.byteLength >= 84 ? dv.getUint32(80, true) : 0;
    if (n && 84 + n * 50 === buf.byteLength) {
      points = new Float32Array(n * 9);
      for (let i = 0; i < n; i++) { const o = 84 + i * 50 + 12; for (let k = 0; k < 9; k++) points[i * 9 + k] = dv.getFloat32(o + k * 4, true); }
    } else {
      const text = new TextDecoder().decode(new Uint8Array(buf)); const arr = []; const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g; let m;
      while ((m = re.exec(text))) arr.push(+m[1], +m[2], +m[3]);
      if (!arr.length) throw new Error('This STL file has no triangles in it.');
      points = Float32Array.from(arr);
    }
    const { verts, tris } = weld(points);
    return meshToSource(verts, tris, fileName, fileName.replace(/\.stl$/i, ''));
  }
  function readObj(data, fileName) {
    const text = new TextDecoder().decode(new Uint8Array(data)); const vs = [], points = [];
    for (const line of text.split('\n')) {
      const p = line.trim().split(/\s+/);
      if (p[0] === 'v') vs.push([+p[1], +p[2], +p[3]]);
      else if (p[0] === 'f') {
        const ids = p.slice(1).map((x) => { const k = parseInt(x, 10); return k < 0 ? vs.length + k : k - 1; });
        for (let i = 1; i + 1 < ids.length; i++) for (const id of [ids[0], ids[i], ids[i + 1]]) points.push(...vs[id]);
      }
    }
    if (!points.length) throw new Error('This OBJ file has no faces in it.');
    // OBJ files are usually Y-up; printers are Z-up
    for (let i = 0; i < points.length; i += 3) { const y = points[i + 1]; points[i + 1] = -points[i + 2]; points[i + 2] = y; }
    const { verts, tris } = weld(points);
    return meshToSource(verts, tris, fileName, fileName.replace(/\.obj$/i, ''));
  }
  async function readAny(data, fileName) {
    if (/\.stl$/i.test(fileName)) return readStl(data, fileName);
    if (/\.obj$/i.test(fileName)) return readObj(data, fileName);
    // some sites serve STLs without the extension: a 3MF is a zip ("PK"), anything else is treated as STL
    const head = new Uint8Array(data.slice ? data.slice(0, 2) : data);
    if (!(head[0] === 0x50 && head[1] === 0x4b)) return readStl(data, fileName);
    return readSource(data, fileName);
  }
  function normColour(c) { c = String(c || '').trim(); if (/^#[0-9a-f]{8}$/i.test(c)) c = c.slice(0, 7); return /^#[0-9a-f]{6}$/i.test(c) ? c.toUpperCase() : '#DDDDDD'; }

  function leavesOf(src, oid) {
    if (src.leafCache.has(oid)) return src.leafCache.get(oid);
    const out = [];
    const walk = (path, id, M, d) => {
      const md = src.models.get(path); const o = md && md.objects.get(id); if (!o || d > 16) return;
      if (o.comps.length) for (const c of o.comps) walk(c.path || path, c.objectid, mul(c.T, M), d + 1);
      else if (o.hasMesh) out.push({ path, id, M, obj: o });
    };
    walk(src.mainPath, oid, I, 0);
    src.leafCache.set(oid, out); return out;
  }
  function vertsOf(src, leaf) {
    const k = leaf.path + '|' + leaf.id; let v = src.vertCache.get(k);
    if (!v) { v = vertices(leaf.obj.inner); src.vertCache.set(k, v); }
    return v;
  }
  // Parts of an object as the slicer sees them: modifiers, negative parts and support blockers aren't printed.
  function partInfo(src, oid) {
    src.partCache = src.partCache || new Map();
    if (src.partCache.has(oid)) return src.partCache.get(oid);
    const map = new Map(), block = src.msObjects.get(oid);
    if (block) block.replace(/<part\b([^>]*)>([\s\S]*?)<\/part>/g, (m, tag, body) => { const a = attrs(tag); const pm = metaMap(body); map.set(+a.id, { subtype: a.subtype || 'normal_part', extruder: +pm.extruder || 0 }); return m; });
    src.partCache.set(oid, map); return map;
  }
  const solidLeaves = (src, oid) => { const info = partInfo(src, oid); const all = leavesOf(src, oid); const solid = all.filter((l) => { const p = info.get(l.id); return !p || p.subtype === 'normal_part'; }); return solid.length ? solid : all; };
  // Triangles with their top-level painted filament (0 = the part's own filament).
  function trisOf(src, leaf) {
    src.triCache = src.triCache || new Map();
    const k = leaf.path + '|' + leaf.id; if (src.triCache.has(k)) return src.triCache.get(k);
    const idx = [], paint = [], hex = new Map(); const re = /<triangle\b([^>]*)\/?>/g; let m;
    while ((m = re.exec(leaf.obj.inner))) {
      const a = m[1];
      idx.push(+/v1="(\d+)"/.exec(a)[1], +/v2="(\d+)"/.exec(a)[1], +/v3="(\d+)"/.exec(a)[1]);
      const pc = /(?:paint_color|mmu_segmentation)="([0-9A-Fa-f]+)"/.exec(a);
      let st = 0;
      if (pc) hex.set(paint.length, pc[1].toUpperCase());
      if (pc) { const counts = {}; walkPaint(pc[1], (x) => { counts[x] = (counts[x] || 0) + 1; return x; }); st = +Object.entries(counts).sort((p, q) => q[1] - p[1])[0][0]; }
      paint.push(st);
    }
    const r = { idx: Uint32Array.from(idx), paint: Uint8Array.from(paint), hex }; src.triCache.set(k, r); return r;
  }
  function bboxOf(src, oid, T) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (const l of solidLeaves(src, oid)) {
      const W = mul(l.M, T), v = vertsOf(src, l);
      for (let i = 0; i < v.length; i += 3) {
        const x = v[i], y = v[i + 1], z = v[i + 2];
        const X = x * W[0] + y * W[3] + z * W[6] + W[9], Y = x * W[1] + y * W[4] + z * W[7] + W[10], Z = x * W[2] + y * W[5] + z * W[8] + W[11];
        if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y; if (Z < z0) z0 = Z; if (Z > z1) z1 = Z;
      }
    }
    return { x0, y0, z0, x1, y1, z1 };
  }

  // Which of the source's filaments (1-based) the chosen objects use.
  function usedFilaments(src, oids) {
    const used = new Set();
    for (const oid of oids) {
      const block = src.msObjects.get(oid);
      let objExt = 1;
      if (block) {
        const head = block.split('<part')[0]; const hm = metaMap(head);
        if (+hm.extruder > 0) objExt = +hm.extruder;
        for (const k of FEATURE_KEYS) if (+hm[k] > 0) used.add(+hm[k]);
        block.replace(/<part\b[\s\S]*?<\/part>/g, (p) => { const pm = metaMap(p); if (+pm.extruder > 0) used.add(+pm.extruder); return p; });
      }
      used.add(objExt);
      for (const l of leavesOf(src, oid)) {
        const inner = l.obj.inner; if (inner.indexOf('paint_color') < 0 && inner.indexOf('mmu_segmentation') < 0) continue;
        inner.replace(paintAttrRe, (m, hex) => { walkPaint(hex, (st) => { if (st > 0) used.add(st); return st; }); return m; });
      }
    }
    return [...used].filter((n) => n >= 1).sort((a, b) => a - b);
  }

  // entry: {src, plate: 'all' | number, copies}
  function selectedItems(entry) {
    return entry.src.items.filter((it) => entry.plate === 'all' ? true : it.plate === +entry.plate);
  }

  // ---------- packing (MaxRects, best short side fit) ----------
  function packPlates(rects, binW, binH, obstacles, allowRot) {
    const plates = []; let todo = rects.slice().sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h) || b.w * b.h - a.w * a.h);
    let guard = 0;
    while (todo.length && guard++ < 36) {
      const pi = plates.length;
      let free = [{ x: 0, y: 0, w: binW, h: binH }];
      for (const o of obstacles) free = cut(free, o);
      const placed = [], left = [];
      // parts the user moved to this plate go first; parts moved to a later plate wait
      const order = todo.filter((r) => r.force === pi).concat(todo.filter((r) => r.force !== pi));
      for (const r of order) {
        if (r.force !== undefined && r.force !== pi) { left.push(r); continue; }
        let best = null;
        for (const f of free) for (const rot of allowRot && !r.noRot ? [false, true] : [false]) {
          const w = rot ? r.h : r.w, h = rot ? r.w : r.h;
          if (w <= f.w + 1e-6 && h <= f.h + 1e-6) {
            const s1 = Math.min(f.w - w, f.h - h), s2 = Math.max(f.w - w, f.h - h);
            if (!best || s1 < best.s1 || (s1 === best.s1 && s2 < best.s2)) best = { s1, s2, x: f.x, y: f.y, w, h, rot };
          }
        }
        if (best) { placed.push({ r, x: best.x, y: best.y, w: best.w, h: best.h, rot: best.rot }); free = cut(free, best); }
        else if (r.force === pi) { left.push(Object.assign(r, { force: undefined })); } // doesn't fit there: let it go anywhere
        else left.push(r);
      }
      if (!placed.length && !left.some((r) => r.force !== undefined && r.force > pi)) { todo = left; break; }
      plates.push(placed); todo = left;
    }
    return { plates, unplaced: todo };
  }
  function cut(free, u) {
    const out = [];
    for (const f of free) {
      if (u.x >= f.x + f.w || u.x + u.w <= f.x || u.y >= f.y + f.h || u.y + u.h <= f.y) { out.push(f); continue; }
      if (u.x > f.x) out.push({ x: f.x, y: f.y, w: u.x - f.x, h: f.h });
      if (u.x + u.w < f.x + f.w) out.push({ x: u.x + u.w, y: f.y, w: f.x + f.w - u.x - u.w, h: f.h });
      if (u.y > f.y) out.push({ x: f.x, y: f.y, w: f.w, h: u.y - f.y });
      if (u.y + u.h < f.y + f.h) out.push({ x: f.x, y: u.y + u.h, w: f.w, h: f.y + f.h - u.y - u.h });
    }
    return out.filter((a, i) => a.w > 0.01 && a.h > 0.01 && !out.some((b, j) => j !== i && b.x <= a.x && b.y <= a.y && b.x + b.w >= a.x + a.w && b.y + b.h >= a.y + a.h && (j < i || !(a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h))));
  }

  /**
   * Lay out every chosen instance.
   * bed: {x0,y0,x1,y1, exclude:[{x,y,w,h}], tower:{w,h}|null}, opts: {spacing, margin, rotate}
   */
  const RZ = (k) => [RZ90, mul(RZ90, RZ90), mul(mul(RZ90, RZ90), RZ90)][((k % 4) + 3) % 4] || I;
  const scaleT = (T, f) => (f === 1 ? T : mul([f, 0, 0, 0, f, 0, 0, 0, f, 0, 0, 0], T));
  function bboxCached(src, oid, T) {
    src.bbCache = src.bbCache || new Map();
    const k = oid + '|' + T.map((v) => v.toFixed(5)).join(',');
    if (!src.bbCache.has(k)) src.bbCache.set(k, bboxOf(src, oid, T));
    return src.bbCache.get(k);
  }
  /**
   * entries: [{id, src, plate, copies, scale}]
   * opts: {spacing, margin, rotate, overrides: {key: {rot, plate, removed}}}
   */
  function layout(entries, bed, opts) {
    const sp = opts.spacing, m = opts.margin, ov = opts.overrides || {};
    const rects = [];
    entries.forEach((e, ei) => {
      const items = selectedItems(e); const f = (+e.scale || 100) / 100;
      for (let c = 0; c < Math.max(1, e.copies | 0); c++) items.forEach((it, ii) => {
        const key = (e.id ?? ei) + '|' + ii + '|' + c, o = ov[key] || {};
        if (o.removed) return;
        let T = scaleT(it.T, f);
        if (o.rot) T = mul(T, RZ(o.rot));
        const bb = bboxCached(e.src, it.oid, T);
        if (!isFinite(bb.x0)) return;
        rects.push({ key, ei, ii, c, it, T, bb, w: bb.x1 - bb.x0 + sp, h: bb.y1 - bb.y0 + sp, force: o.plate, noRot: !!o.rot });
      });
    });
    const W = bed.x1 - bed.x0, H = bed.y1 - bed.y0;
    const binW = W - 2 * m + sp, binH = H - 2 * m + sp;
    const obstacles = (bed.exclude || []).map((o) => ({ x: o.x - bed.x0 - m - sp, y: o.y - bed.y0 - m - sp, w: o.w + 2 * sp, h: o.h + 2 * sp }));
    let tower = null;
    if (bed.tower) { tower = { x: bed.x1 - m - bed.tower.w, y: bed.y1 - m - bed.tower.h, w: bed.tower.w, h: bed.tower.h }; obstacles.push({ x: tower.x - bed.x0 - m - sp, y: tower.y - bed.y0 - m - sp, w: tower.w + 2 * sp, h: tower.h + 2 * sp }); }
    const res = packPlates(rects, binW, binH, obstacles, opts.rotate);
    const placements = [];
    res.plates.forEach((pl, pi) => {
      let dx = 0, dy = 0;
      if (!obstacles.length && pl.length) { // centre the group on the bed
        const ax0 = Math.min(...pl.map((p) => p.x)), ay0 = Math.min(...pl.map((p) => p.y));
        const ax1 = Math.max(...pl.map((p) => p.x + p.w - sp)), ay1 = Math.max(...pl.map((p) => p.y + p.h - sp));
        dx = (W - 2 * m - (ax1 - ax0)) / 2 - ax0; dy = (H - 2 * m - (ay1 - ay0)) / 2 - ay0;
      }
      for (const p of pl) {
        let T = p.r.T, bb = p.r.bb;
        if (p.rot) { T = mul(T, RZ90); bb = { x0: -bb.y1, x1: -bb.y0, y0: bb.x0, y1: bb.x1, z0: bb.z0, z1: bb.z1 }; }
        const tx = bed.x0 + m + p.x + dx - bb.x0, ty = bed.y0 + m + p.y + dy - bb.y0;
        T = T.slice(); T[9] += tx; T[10] += ty; T[11] -= bb.z0;
        placements.push({ key: p.r.key, ei: p.r.ei, it: p.r.it, plate: pi, T, rect: { x: bb.x0 + tx, y: bb.y0 + ty, w: bb.x1 - bb.x0, h: bb.y1 - bb.y0 }, height: bb.z1 - bb.z0 });
      }
    });
    const tooBig = res.unplaced.map((r) => ({ ei: r.ei, w: r.w - sp, h: r.h - sp }));
    return { placements, plateCount: res.plates.length, tooBig, tower };
  }

  // ---------- filament estimate ----------
  function meshStats(src, leaf) {
    src.statCache = src.statCache || new Map();
    const k = leaf.path + '|' + leaf.id; if (src.statCache.has(k)) return src.statCache.get(k);
    const v = vertsOf(src, leaf); let vol = 0, area = 0; const re = /<triangle\b([^>]*)\/?>/g; let m;
    while ((m = re.exec(leaf.obj.inner))) {
      const a = m[1]; const i = +/v1="(\d+)"/.exec(a)[1] * 3, j = +/v2="(\d+)"/.exec(a)[1] * 3, l = +/v3="(\d+)"/.exec(a)[1] * 3;
      const ax = v[i], ay = v[i + 1], az = v[i + 2], bx = v[j], by = v[j + 1], bz = v[j + 2], cx = v[l], cy = v[l + 1], cz = v[l + 2];
      vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
      const ux = bx - ax, uy = by - ay, uz = bz - az, wx = cx - ax, wy = cy - ay, wz = cz - az;
      area += Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 2;
    }
    const r = { vol: Math.abs(vol), area }; src.statCache.set(k, r); return r;
  }
  const det3 = (M) => M[0] * (M[4] * M[8] - M[5] * M[7]) - M[1] * (M[3] * M[8] - M[5] * M[6]) + M[2] * (M[3] * M[7] - M[4] * M[6]);
  /** Rough grams of filament: shell over the surface plus infill inside. */
  function estimate(entries, placements, settings) {
    const walls = +settings.wall_loops || 2, infill = (parseFloat(settings.sparse_infill_density) || 15) / 100;
    const shell = Math.max(0.8, walls * 0.45), density = settings.density || 1.24;
    let mm3 = 0;
    for (const pl of placements) {
      const src = entries[pl.ei].src;
      for (const l of solidLeaves(src, pl.it.oid)) {
        const s = meshStats(src, l), d = Math.abs(det3(mul(l.M, pl.T)));
        const vol = s.vol * d, area = s.area * Math.pow(d, 2 / 3);
        const shellVol = Math.min(vol, area * shell);
        mm3 += shellVol + (vol - shellVol) * infill;
      }
    }
    return { grams: mm3 / 1000 * density };
  }
  // ---------- profiles ----------
  function preset(profiles, type, name) {
    const p = profiles[type][name]; if (!p) return null;
    return Object.assign({}, profiles[type + '_base'], p);
  }
  // Pick the closest Flashforge filament preset for a source filament.
  function matchFilament(profiles, printer, f) {
    const list = printer.filaments; if (!list.length) return null;
    const type = String(f.type || 'PLA').toUpperCase().replace(/\s+/g, '');
    const name = String(f.name || '').toLowerCase();
    const typed = list.filter((n) => { const t = String((preset(profiles, 'filament', n).filament_type || [''])[0]).toUpperCase(); return t === type; });
    const pool = typed.length ? typed : list.filter((n) => /PLA/.test(String((preset(profiles, 'filament', n).filament_type || [''])[0]).toUpperCase()));
    const words = ['matte', 'silk', 'galaxy', 'sparkle', 'metal', 'luminous', 'glow', 'transparent', 'translucent', 'pro', 'basic', 'hs', 'cf'];
    const want = words.filter((w) => name.includes(w)).map((w) => (w === 'glow' ? 'luminous' : w === 'translucent' ? 'transparent' : w));
    const baseName = name.split('@')[0].trim();
    const score = (n) => { const l = n.toLowerCase(); let s = 0; if (baseName && l.split('@')[0].trim() === baseName) s += 20; for (const w of want) if (l.includes(w)) s += 3; if (!want.length && l.includes('basic')) s += 2; if (l.startsWith('flashforge')) s += 1; if (l.includes('color change')) s -= 2; return s; };
    return (pool.length ? pool : list).slice().sort((a, b) => score(b) - score(a) || a.localeCompare(b))[0];
  }
  function lum(hex) { const n = parseInt(hex.slice(1), 16); const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255; return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; }

  const TEMP_KEYS = ['nozzle_temperature', 'nozzle_temperature_initial_layer', 'hot_plate_temp', 'hot_plate_temp_initial_layer', 'textured_plate_temp', 'textured_plate_temp_initial_layer', 'cool_plate_temp', 'cool_plate_temp_initial_layer', 'eng_plate_temp', 'eng_plate_temp_initial_layer'];
  function buildProject(profiles, printer, processName, slots, baseProject, layoutRes, opts = {}) {
    const M = preset(profiles, 'machine', printer.machine);
    const P = preset(profiles, 'process', processName);
    const Fs = slots.map((s) => preset(profiles, 'filament', s.preset));
    const cfg = Object.assign({}, M, P);
    const keys = new Set(); Fs.forEach((f) => Object.keys(f).forEach((k) => keys.add(k)));
    // Same as the slicers: every list option is the filaments' lists joined end to end.
    for (const k of keys) {
      const vals = Fs.map((f) => f[k]);
      const sample = vals.find((v) => v !== undefined);
      if (Array.isArray(sample)) cfg[k] = [].concat(...vals.map((v) => (v === undefined ? sample : v)));
      else cfg[k] = sample;
    }
    if (Fs.some((f) => Array.isArray(f.filament_extruder_variant))) {
      cfg.filament_self_index = [].concat(...Fs.map((f, i) => Array((f.filament_extruder_variant || ['']).length).fill(String(i + 1))));
    }
    if (printer.vendor === 'bbl') cfg.filament_map = slots.map(() => '1');
    cfg.filament_colour = slots.map((s) => s.colour);
    // keep the original model's print properties
    const changed = [], clamped = [];
    // Only carry what the author actually changed from their own printer's defaults (listed in the
    // project), so another printer's defaults don't override Flashforge's. Layer height always comes across.
    const diff = baseProject && Array.isArray(baseProject.different_settings_to_system) ? String(baseProject.different_settings_to_system[0] || '') : null;
    const authored = diff !== null && !baseProject._from ? new Set(diff.split(';').map((x) => x.trim()).filter(Boolean)) : null;
    if (baseProject) for (const k of KEEP_PRINT) {
      if (authored && !authored.has(k) && k !== 'layer_height' && k !== 'initial_layer_print_height') continue;
      if (baseProject[k] === undefined || P[k] === undefined) continue;
      if (Array.isArray(baseProject[k]) !== Array.isArray(P[k]) || typeof baseProject[k] !== typeof P[k]) continue;
      if (Array.isArray(P[k]) && baseProject[k].length !== P[k].length) continue;
      let val = baseProject[k];
      if (!Array.isArray(val) && +val < 0 && +P[k] >= 0) continue; // -1 means "auto" in Bambu; Orca/Flash Studio want >= 0
      if (k === 'layer_height' || k === 'initial_layer_print_height') {
        const v = +val, lo = +(M.min_layer_height || ['0.04'])[0], hi = +(M.max_layer_height || ['1'])[0];
        if (!(v > 0)) continue;
        const c = Math.min(hi, Math.max(lo, v));
        if (c !== v) { clamped.push({ key: k, from: v, to: c, why: `limit for a ${M.nozzle_diameter[0]} mm nozzle` }); val = String(c); }
      }
      if (JSON.stringify(val) !== JSON.stringify(P[k])) { cfg[k] = val; changed.push(k); }
    }
    const n = slots.length;
    // flush volumes (single-nozzle colour changers): estimate from colour lightness
    const mat = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if (i === j) { mat.push('0'); continue; }
      const d = Math.max(0, lum(slots[j].colour) - lum(slots[i].colour));
      mat.push(String(Math.round(280 + 320 * d)));
    }
    cfg.flush_volumes_matrix = mat;
    cfg.flush_volumes_vector = Array(n * 2).fill('140');
    const plates = Math.max(1, layoutRes.plateCount);
    if (layoutRes.tower) {
      cfg.wipe_tower_x = Array(plates).fill(String(+layoutRes.tower.x.toFixed(2)));
      cfg.wipe_tower_y = Array(plates).fill(String(+layoutRes.tower.y.toFixed(2)));
    }
    if (n < 2 || (opts.usedCount !== undefined && opts.usedCount < 2)) cfg.enable_prime_tower = '0';
    // the author's temperatures, per filament
    const temps = [];
    if (opts.keepTemps) slots.forEach((s, i) => {
      const src = s.from && s.from.project; if (!src) return;
      const f = s.from.f - 1;
      for (const k of TEMP_KEYS) {
        const sv = Array.isArray(src[k]) ? src[k][Math.min(f, src[k].length - 1)] : undefined;
        if (sv === undefined || !Array.isArray(cfg[k]) || cfg[k].length !== n || !(+sv > 0)) continue;
        // stay inside the Flashforge filament's safe range
        let v = +sv;
        const lo = /^nozzle/.test(k) ? +(cfg.nozzle_temperature_range_low || [])[i] || 170 : 0;
        const hi = /^nozzle/.test(k) ? +(cfg.nozzle_temperature_range_high || [])[i] || 300 : 120;
        const c = Math.min(hi, Math.max(lo, v));
        if (String(c) !== String(cfg[k][i])) temps.push({ slot: i + 1, key: k, from: cfg[k][i], to: String(c), asked: c !== v ? String(v) : null });
        cfg[k][i] = String(c);
      }
    });
    for (const k of ['support_filament', 'support_interface_filament', 'wall_filament', 'sparse_infill_filament', 'solid_infill_filament']) if (cfg[k] !== undefined) cfg[k] = '0';
    cfg.print_settings_id = processName;
    cfg.printer_settings_id = printer.machine;
    cfg.filament_settings_id = slots.map((s) => s.preset);
    cfg.inherits_group = Array(n + 2).fill('');
    cfg.different_settings_to_system = [changed.join(';')].concat(Array(n + 1).fill(''));
    cfg.name = 'project_settings'; cfg.from = 'project'; cfg.version = printer.cfgVersion || '2.3.1.0';
    return { cfg, changed, temps, clamped, authoredOnly: !!authored, kept: changed.map((k) => ({ key: k, value: cfg[k] })) };
  }


  // ---------- keep the original Bambu project settings (no conversion) ----------
  function filamentCountOf(p) { return Array.isArray(p.filament_colour) ? p.filament_colour.length : 1; }
  /**
   * slots: [{colour, baseIdx}] — baseIdx is the 1-based filament of the base project whose settings the slot copies.
   */
  function buildKeepProject(base, slots, layoutRes) {
    const cfg = JSON.parse(JSON.stringify(base));
    const N = filamentCountOf(base), M = slots.length;
    const self = Array.isArray(base.filament_self_index) ? base.filament_self_index.map(Number) : null;
    const pick = (arr, chunk) => [].concat(...slots.map((s) => arr.slice((s.baseIdx - 1) * chunk, s.baseIdx * chunk)));
    const special = new Set(['filament_colour', 'filament_self_index', 'flush_volumes_matrix', 'flush_volumes_vector', 'different_settings_to_system', 'inherits_group', 'wipe_tower_x', 'wipe_tower_y']);
    for (const [k, v] of Object.entries(base)) {
      if (!Array.isArray(v) || special.has(k)) continue;
      const isFil = k.startsWith('filament_') || FIL_KEYS.has(k);
      if (!isFil) continue;
      if (self && v.length === self.length && self.length !== N) {
        cfg[k] = [].concat(...slots.map((s) => v.filter((_, i) => self[i] === s.baseIdx)));
      } else if (v.length === N) cfg[k] = pick(v, 1);
      else if (v.length % N === 0 && v.length > N) cfg[k] = pick(v, v.length / N);
    }
    if (self) cfg.filament_self_index = [].concat(...slots.map((s, j) => self.filter((x) => x === s.baseIdx).map(() => String(j + 1))));
    cfg.filament_colour = slots.map((s) => s.colour);
    if (Array.isArray(base.different_settings_to_system) && base.different_settings_to_system.length === N + 2) {
      const d = base.different_settings_to_system; cfg.different_settings_to_system = [d[0], ...slots.map((s) => d[s.baseIdx]), d[N + 1]];
    }
    if (Array.isArray(base.inherits_group) && base.inherits_group.length === N + 2) {
      const d = base.inherits_group; cfg.inherits_group = [d[0], ...slots.map((s) => d[s.baseIdx]), d[N + 1]];
    }
    const E = Math.max(1, (base.nozzle_diameter || ['0.4']).length);
    const fm = base.flush_volumes_matrix;
    const per = Array.isArray(fm) && fm.length % (N * N) === 0 ? fm.length / (N * N) : 0;
    const mat = [];
    for (let e = 0; e < Math.max(E, per || 1); e++) for (let i = 0; i < M; i++) for (let j = 0; j < M; j++) {
      if (i === j) { mat.push('0'); continue; }
      const a = slots[i].baseIdx - 1, b = slots[j].baseIdx - 1;
      if (per && slots[i].colour === base.filament_colour[a] && slots[j].colour === base.filament_colour[b] && a !== b) mat.push(fm[e * N * N + a * N + b]);
      else mat.push(String(Math.round(140 + 460 * Math.max(0, lum(slots[j].colour) - lum(slots[i].colour)))));
    }
    cfg.flush_volumes_matrix = mat;
    if (Array.isArray(base.flush_volumes_vector)) cfg.flush_volumes_vector = Array(M * 2).fill(base.flush_volumes_vector[0] || '140');
    for (const k of ['support_filament', 'support_interface_filament', 'wipe_tower_filament', 'wall_filament', 'sparse_infill_filament', 'solid_infill_filament']) {
      if (cfg[k] === undefined) continue; const old = +cfg[k];
      const j = slots.findIndex((s) => s.baseIdx === old); cfg[k] = old > 0 && j >= 0 ? String(j + 1) : '0';
    }
    const plates = Math.max(1, layoutRes.plateCount);
    if (layoutRes.tower) { cfg.wipe_tower_x = Array(plates).fill(String(+layoutRes.tower.x.toFixed(2))); cfg.wipe_tower_y = Array(plates).fill(String(+layoutRes.tower.y.toFixed(2))); }
    if (M < 2 && cfg.enable_prime_tower !== undefined) cfg.enable_prime_tower = '0';
    return { cfg, changed: [] };
  }
  // Per-filament list options that don't start with "filament_".
  const FIL_KEYS = new Set(['nozzle_temperature', 'nozzle_temperature_initial_layer', 'nozzle_temperature_range_low', 'nozzle_temperature_range_high',
    'hot_plate_temp', 'hot_plate_temp_initial_layer', 'cool_plate_temp', 'cool_plate_temp_initial_layer', 'eng_plate_temp', 'eng_plate_temp_initial_layer',
    'textured_plate_temp', 'textured_plate_temp_initial_layer', 'supertack_plate_temp', 'supertack_plate_temp_initial_layer', 'textured_cool_plate_temp',
    'textured_cool_plate_temp_initial_layer', 'temperature_vitrification', 'fan_cooling_layer_time', 'fan_max_speed', 'fan_min_speed', 'slow_down_layer_time',
    'slow_down_min_speed', 'close_fan_the_first_x_layers', 'full_fan_speed_layer', 'overhang_fan_speed', 'overhang_fan_threshold', 'reduce_fan_stop_start_freq',
    'additional_cooling_fan_speed', 'during_print_exhaust_fan_speed', 'complete_print_exhaust_fan_speed', 'activate_air_filtration', 'required_nozzle_HRC',
    'default_filament_colour', 'chamber_temperatures', 'activate_chamber_temp_control', 'volumetric_speed_coefficients', 'long_retractions_when_ec',
    'retraction_distances_when_ec', 'enable_pressure_advance', 'pressure_advance', 'dont_slow_down_outer_wall', 'impact_strength_z', 'idle_temperature',
    'circle_compensation_speed', 'counter_coef_1', 'counter_coef_2', 'counter_coef_3', 'counter_limit_max', 'counter_limit_min', 'diameter_limit',
    'hole_coef_1', 'hole_coef_2', 'hole_coef_3', 'hole_limit_max', 'hole_limit_min', 'enable_overhang_bridge_fan', 'overhang_fan_speed', 'cooling_slowdown_logic',
    'cooling_perimeter_transition_distance', 'adaptive_pressure_advance', 'adaptive_pressure_advance_model', 'adaptive_pressure_advance_bridges',
    'adaptive_pressure_advance_overhangs', 'internal_bridge_fan_speed', 'ironing_fan_speed', 'support_material_interface_fan_speed', 'dont_slow_down_outer_wall']);

  // ---------- writing ----------
  /**
   * entries: [{src, plate, copies}]
   * slotOf: function(entryIndex, filamentNo) -> slot number (1-based)
   * slots: [{colour, preset}]
   */
  async function build({ entries, profiles, printer, processName, slots, slotOf, layoutRes, keepTemps, usedCount }) {
    const out = new JSZip();
    let nextId = 1; const nid = () => nextId++;
    const subFiles = new Map();   // outPath -> {objects: [...strings]}
    const mainObjs = [], items = [], msObjs = [], plateInst = [];
    const objKey = new Map();     // `${ei}|${oid}` -> {newId, instCount}
    const subIdMap = new Map();   // `${ei}|${path}|${id}` -> new id
    let identify = 100;
    const base = entries.find((e) => e.src.project);
    const targetProcess = printer.keep ? null : preset(profiles, 'process', processName);
    const filMapFor = (ei) => (k) => (k > 0 ? slotOf(ei, k) : k);

    for (const pl of layoutRes.placements) {
      // every part on the plate is its own object with its own copy of the mesh: some slicers (Flash Studio) stack
      // several instances of one object on top of each other when they load the file
      const e = entries[pl.ei], src = e.src, oid = pl.it.oid, key = pl.ei + '|' + oid + '|' + (pl.key || Math.random());
      let rec = objKey.get(key);
      if (!rec) {
        rec = { newId: 0, inst: 0 };
        const leaves = leavesOf(src, oid);
        const map = filMapFor(pl.ei);
        const comps = [];
        for (const l of leaves) {
          const sk = key + '|' + l.path + '|' + l.id;
          let sid = subIdMap.get(sk);
          const outPath = `3D/Objects/s${pl.ei + 1}_${basename(l.path).replace(/[^\w.-]/g, '_')}`;
          if (!sid) {
            sid = nid(); subIdMap.set(sk, sid);
            let mesh = l.obj.inner;
            if (/\b(pid|pindex|p1|p2|p3)="/.test(mesh)) mesh = mesh.replace(/\s(?:pid|pindex|p1|p2|p3)="[^"]*"/g, '');
            mesh = mesh.replace(/\sslic3rpe:custom_supports="/g, ' paint_supports="').replace(/\sslic3rpe:custom_seam="/g, ' paint_seam="');
            mesh = mesh.replace(paintAttrRe, (m, hex) => 'paint_color="' + walkPaint(hex, (st) => (st > 0 ? map(st) : 0)) + '"');
            mesh = mesh.replace(/\s[\w]+:(?!UUID)[\w-]+="[^"]*"/g, (m) => (/^\s(?:paint_|p:)/.test(m) ? m : ''));
            if (!subFiles.has(outPath)) subFiles.set(outPath, []);
            subFiles.get(outPath).push(`  <object id="${sid}" p:UUID="${uuid()}" type="model">\n${mesh.trim()}\n  </object>`);
          }
          comps.push(`    <component p:path="/${outPath}" objectid="${sid}" p:UUID="${uuid()}" transform="${fmtT(l.M)}"/>`);
        }
        rec.newId = nid();
        mainObjs.push(`  <object id="${rec.newId}" p:UUID="${uuid()}" type="model">\n   <components>\n${comps.join('\n')}\n   </components>\n  </object>`);
        msObjs.push(cleanObjectSettings(modelSettingsObject(src, oid, rec.newId, leaves, (l) => subIdMap.get(key + '|' + l.path + '|' + l.id), map, pl.ei), targetProcess));
        objKey.set(key, rec);
      }
      items.push(`  <item objectid="${rec.newId}" p:UUID="${uuid()}" transform="${fmtT(pl.T)}" printable="1"/>`);
      plateInst.push({ plate: pl.plate, obj: rec.newId, inst: rec.inst++, identify: identify++ });
    }

    const sources = entries.map((e) => e.src.title + (e.src.meta.Designer ? ' by ' + e.src.meta.Designer : '') + (e.src.meta.License ? ' (' + e.src.meta.License + ')' : ''));
    const title = entries.length === 1 ? entries[0].src.title : 'Combined plate (' + entries.length + ' models)';
    const mainXml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
 <metadata name="Application">${esc(printer.keep ? (base && base.src.app) || 'BambuStudio-02.03.00.70' : printer.app || 'OrcaSlicer-2.3.1')}</metadata>
 <metadata name="BambuStudio:3mfVersion">1</metadata>${!printer.keep && printer.orcaTag ? `\n <metadata name="OrcaSlicer">${esc(printer.orcaTag)}</metadata>` : ''}
 <metadata name="Title">${esc(title)}</metadata>
 <metadata name="Description">${esc('Made with 3MF Plate Builder from: ' + sources.join('; '))}</metadata>
 <metadata name="CreationDate">${new Date().toISOString().slice(0, 10)}</metadata>
 <resources>
${mainObjs.join('\n')}
 </resources>
 <build p:UUID="${uuid()}">
${items.join('\n')}
 </build>
</model>
`;
    out.file('3D/3dmodel.model', mainXml);
    const relLines = [];
    let r = 1;
    for (const [p, objs] of subFiles) {
      out.file(p, `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <resources>
${objs.join('\n')}
 </resources>
 <build/>
</model>
`);
      relLines.push(` <Relationship Target="/${p}" Id="rel-${r++}" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>`);
    }
    out.file('3D/_rels/3dmodel.model.rels', `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n${relLines.join('\n')}\n</Relationships>\n`);
    out.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n</Relationships>\n`);
    out.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n <Default Extension="png" ContentType="image/png"/>\n <Default Extension="gcode" ContentType="text/x.gcode"/>\n</Types>\n`);

    const plateBlocks = [];
    for (let p = 0; p < Math.max(1, layoutRes.plateCount); p++) {
      const inst = plateInst.filter((x) => x.plate === p).map((x) => `    <model_instance>\n      <metadata key="object_id" value="${x.obj}"/>\n      <metadata key="instance_id" value="${x.inst}"/>\n      <metadata key="identify_id" value="${x.identify}"/>\n    </model_instance>`);
      plateBlocks.push(`  <plate>\n    <metadata key="plater_id" value="${p + 1}"/>\n    <metadata key="plater_name" value=""/>\n    <metadata key="locked" value="false"/>\n${inst.join('\n')}\n  </plate>`);
    }
    out.file('Metadata/model_settings.config', `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n${msObjs.join('\n')}\n${plateBlocks.join('\n')}\n</config>\n`);

    const proj = printer.keep ? buildKeepProject(base.src.project, slots, layoutRes) : buildProject(profiles, printer, processName, slots, base && base.src.project, layoutRes, { keepTemps, usedCount });
    const { cfg, changed } = proj;
    out.file('Metadata/project_settings.config', JSON.stringify(cfg, null, 4));
    const blob = await out.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 }, mimeType: 'model/3mf' });
    return { blob, changed, report: Object.assign({ base: base ? base.src.title : '', baseMade: base ? base.src.made : null }, proj) };
  }

  // Per-object/per-part overrides: keep only settings the Flashforge print profile has, and drop
  // Bambu's "-1 = auto" values, which Orca-based slicers (Flash Studio) reject.
  const STRUCT_KEYS = new Set(['name', 'extruder', 'matrix', 'mesh_shared', 'source_file', 'source_object_id', 'source_volume_id',
    'source_offset_x', 'source_offset_y', 'source_offset_z', 'source_in_inches', 'source_in_meters', 'volume_type', 'support_blocker', 'support_enforcer']);
  function cleanObjectSettings(block, P) {
    if (!P) return block;
    return block.replace(/\s*<metadata\s+key="([^"]*)"\s+value="([^"]*)"\s*\/>/g, (m, k, v) => {
      if (STRUCT_KEYS.has(k)) return m;
      if (P[k] === undefined) return '';
      if (!Array.isArray(P[k]) && v.trim() !== '' && +v < 0 && +P[k] >= 0) return '';
      return m;
    });
  }
  function modelSettingsObject(src, oid, newId, leaves, newSubId, map, ei) {
    const block = src.msObjects.get(oid);
    const fixMeta = (s, key, fn) => s.replace(new RegExp(`(<metadata\\s+key="${key}"\\s+value=")([^"]*)(")`, 'g'), (m, a, v, b) => a + fn(v) + b);
    const remap = (v) => { const k = +v; return k > 0 ? String(map(k)) : v; };
    if (block) {
      const cut = block.indexOf('<part');
      let head = cut >= 0 ? block.slice(0, cut) : block.replace(/<\/object>\s*$/, '');
      let rest = cut >= 0 ? block.slice(cut) : '</object>';
      head = head.replace(/^<object\s+id="\d+"/, `<object id="${newId}"`);
      if (/<metadata\s+key="extruder"/.test(head)) head = fixMeta(head, 'extruder', (v) => (+v > 0 ? String(map(+v)) : String(map(1))));
      else head = head.replace(/^(<object[^>]*>)/, `$1\n    <metadata key="extruder" value="${map(1)}"/>`);
      for (const k of FEATURE_KEYS) head = fixMeta(head, k, remap);
      rest = rest.replace(/<part\s+id="(\d+)"/g, (m, pid) => {
        const l = leaves.find((x) => x.id === +pid); return `<part id="${l ? newSubId(l) : pid}"`;
      });
      rest = fixMeta(rest, 'extruder', remap);
      rest = rest.replace(/\s*<metadata\s+key="mesh_shared"[^>]*\/>/g, ''); // each part now has its own mesh
      rest = rest.replace(/\s*<metadata\s+key="source_object_id"[^>]*\/>/g, '').replace(/\s*<metadata\s+key="source_volume_id"[^>]*\/>/g, '').replace(/\s*<metadata\s+key="source_file"[^>]*\/>/g, '');
      return '  ' + head + rest;
    }
    const name = esc((leaves[0] && leaves[0].obj.a.name) || src.title);
    const parts = leaves.map((l, i) => `    <part id="${newSubId(l)}" subtype="normal_part">\n      <metadata key="name" value="${esc(l.obj.a.name || name + (leaves.length > 1 ? ' ' + (i + 1) : ''))}"/>\n      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n    </part>`);
    return `  <object id="${newId}">\n    <metadata key="name" value="${name}"/>\n    <metadata key="extruder" value="${map(1)}"/>\n${parts.join('\n')}\n  </object>`;
  }

  return { readAny, readStl, buildProject, buildKeepProject, mul, vertsOf, trisOf, partInfo, solidLeaves, estimate, readSource, usedFilaments, selectedItems, layout, build, matchFilament, preset, normColour, lum, walkPaint, bboxOf };
})();
if (typeof module !== 'undefined') module.exports = FF;
