// Runs alongside Plate Builder in the desktop app. It uses the same code as the Safari add-on's
// Plate Builder part (addon/src/bridge.js), but reaches the printer through the app instead of the add-on.
const { ipcRenderer, webFrame } = require('electron');
// Windows' share panel isn't useful here: built files are saved to Documents\Plate Builder instead.
webFrame.executeJavaScript('try { delete Navigator.prototype.share; delete Navigator.prototype.canShare; } catch (e) {}');
const JSZip = require('jszip');
const printerBridge = require(ipcRenderer.sendSync('pb-bridge-path'));

// The add-on's request function, done by the desktop app.
const GM = {
  xmlHttpRequest(o) {
    ipcRenderer.invoke('pb-http', { method: o.method, url: o.url, headers: o.headers, data: o.data, timeout: o.timeout }).then((r) => {
      if (r.error) return r.timeout ? (o.ontimeout && o.ontimeout()) : (o.onerror && o.onerror(r));
      o.onload(r);
    });
  },
};
const toArrayBuffer = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.pbDesktop = '1';
  // no website hands files over by message here: they come from the app (Downloads folder, Find models window)
  const bridge = printerBridge(/^$/, GM, JSZip);
  ipcRenderer.on('pb-incoming', (e, files) => {
    bridge.injectFiles(files.map((f) => ({ name: f.name, data: toArrayBuffer(f.data) })));
  });
});
