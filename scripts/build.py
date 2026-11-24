"""Builds everything into dist/.

  dist/web/     the Plate Builder web app (what goes on Netlify, and what the desktop app shows)
  dist/addon/   the Safari / Tampermonkey add-on, "Send to Plate Builder.user.js"

Usage: python scripts/build.py
"""
import os, shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
P = lambda *a: os.path.join(ROOT, *a)
read = lambda *a: open(P(*a), encoding='utf-8').read()

def build_addon():
    header = read('addon', 'src', 'header.txt')
    sites = read('addon', 'src', 'sites.js')
    bridge = read('addon', 'src', 'bridge.js')
    bridge = '\n'.join('  ' + l if l else l for l in bridge.split('\n'))
    return header + sites + bridge.rstrip() + '\n})();\n'

def build_web(addon):
    out = P('dist', 'web')
    shutil.rmtree(out, ignore_errors=True); os.makedirs(out)
    profiles = read('core', 'profiles.json').replace('</', '<\\/')
    html = read('web', 'app.html').replace('__PROFILES__', profiles).replace('__CORE__', read('core', 'core.js'))
    open(os.path.join(out, 'index.html'), 'w', encoding='utf-8').write(html)
    shutil.copy(P('web', 'slice-worker.js'), out)
    for lib in os.listdir(P('web', 'vendor')):
        for f in os.listdir(P('web', 'vendor', lib)):
            shutil.copy(P('web', 'vendor', lib, f), out)
    open(os.path.join(out, 'plate-builder.user.js'), 'w', encoding='utf-8').write(addon)

if __name__ == '__main__':
    addon = build_addon()
    os.makedirs(P('dist', 'addon'), exist_ok=True)
    open(P('dist', 'addon', 'Send to Plate Builder.user.js'), 'w', encoding='utf-8').write(addon)
    build_web(addon)
    print('Built dist/web and dist/addon')
