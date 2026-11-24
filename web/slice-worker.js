// Slicing worker for Plate Builder. Runs the three-slicer WASM kernel (AGPL-3.0, derived from OrcaSlicer)
// off the main thread so the page stays responsive while a plate slices.
import createKernel from './slicer_core.js'
import { deriveKernelParams } from './derive.js'

let kernel = null
async function getKernel() {
  if (!kernel) kernel = await createKernel()
  return kernel
}

self.onmessage = async (ev) => {
  const d = ev.data
  if (d.cmd === 'warmup') { try { await getKernel(); self.postMessage({ type: 'warm' }) } catch (e) { self.postMessage({ type: 'error', error: String(e && e.message || e) }) } return }
  if (d.cmd !== 'slice') return
  try {
    const M = await getKernel()
    const params = Object.assign(deriveKernelParams(d.settings), d.extra || {})
    const stl = new Uint8Array(d.stl)
    M.selector_prepare(stl)
    if (d.paint && d.paint.facets.length && M.selector_import_paint) M.selector_import_paint(Int32Array.from(d.paint.facets), d.paint.hex)
    const chunks = [], layers = []
    // keep a light copy for the preview: segment end points in 0.1 mm steps, plus the tool, travel moves dropped
    const keep = (z, paths) => {
      const n = paths.length / 8, seg = new Int16Array(n * 4), tool = new Uint8Array(n); let k = 0
      for (let i = 0; i < n; i++) {
        const o = i * 8, code = paths[o + 3] | 0, role = code & 15
        if (role === 0) continue
        seg[k * 4] = Math.round(paths[o] * 10); seg[k * 4 + 1] = Math.round(paths[o + 1] * 10)
        seg[k * 4 + 2] = Math.round(paths[o + 4] * 10); seg[k * 4 + 3] = Math.round(paths[o + 5] * 10)
        tool[k] = code >>> 4; k++
      }
      layers.push({ z, seg: seg.slice(0, k * 4), tool: tool.slice(0, k) })
    }
    M.set_layer_sink((z, idx, gcode, paths) => { chunks.push(gcode); keep(z, paths) })
    let last = 0, res, dropped = []
    // a printer profile's custom G-code can use placeholders this engine can't expand; leave that block out and say so
    for (let attempt = 0; attempt < 4; attempt++) {
      chunks.length = 0; layers.length = 0
      res = M.slice(stl, JSON.stringify(params), (done, total) => {
        const now = Date.now(); if (now - last > 150 || done === total) { last = now; self.postMessage({ type: 'progress', done, total }) }
      })
      const m = /CUSTOM_GCODE_ERROR:\s*([a-z_]+)/.exec(res.error || '')
      if (!m || !(m[1] in params) && !(m[1] in d.settings)) break
      dropped.push(m[1]); params[m[1]] = ''
      if (dropped.length === 1) Object.assign(params, deriveKernelParams(Object.assign({}, d.settings, Object.fromEntries(dropped.map((k) => [k, ''])))), d.extra || {})
      for (const k of dropped) params[k] = ''
    }
    M.clear_layer_sink()
    if (res.stats) res.stats.dropped_gcode = dropped
    if (res.error) { self.postMessage({ type: 'error', error: res.error }); return }
    // multi-colour slices don't stream: everything comes back on the result instead
    if (!chunks.length && res.gcode) { chunks.push(res.gcode); for (const l of res.layers || []) keep(l.z, l.paths) }
    // multi-colour results carry no time estimate: work one out from the moves, plus the colour changes
    if (!res.stats.time_estimate) res.stats.time_rough = roughTime(chunks.join(''), d.changeSeconds || 0)
    const transfer = []; for (const l of layers) transfer.push(l.seg.buffer, l.tool.buffer)
    self.postMessage({ type: 'done', gcode: chunks.join(''), stats: res.stats, layers, params: { extruder_count: params.extruder_count } }, transfer)
  } catch (e) {
    self.postMessage({ type: 'error', error: String(e && e.message || e) })
  }
}

function roughTime(g, changeSeconds) {
  let x = 0, y = 0, z = 0, f = 3000, t = 0, changes = 0, pos = 0
  while (pos < g.length) {
    let end = g.indexOf('\n', pos); if (end < 0) end = g.length
    const c0 = g.charCodeAt(pos), c1 = g.charCodeAt(pos + 1)
    if (c0 === 71 && (c1 === 48 || c1 === 49) && g.charCodeAt(pos + 2) === 32) { // "G0 " / "G1 "
      let nx = x, ny = y, nz = z, e = 0, i = pos + 3
      const line = g.slice(i, end).split(';')[0].split(' ')
      for (const w of line) {
        const v = +w.slice(1)
        switch (w[0]) { case 'X': nx = v; break; case 'Y': ny = v; break; case 'Z': nz = v; break; case 'F': f = v || f; break; case 'E': e = v; break }
      }
      const dist = Math.hypot(nx - x, ny - y, nz - z) || Math.abs(e)
      if (dist) t += dist / Math.max(1, f / 60)
      x = nx; y = ny; z = nz
    } else if (c0 === 84 && c1 >= 48 && c1 <= 57) changes++ // "T<n>"
    pos = end + 1
  }
  return t * 1.15 + Math.max(0, changes - 1) * changeSeconds // allowance for acceleration
}
