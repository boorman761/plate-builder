# Plate Builder

Combine 3D model files (MakerWorld / Bambu 3MF, Orca and Prusa 3MF, STL, OBJ, zips of them) onto one build plate and convert them for Flashforge printers: AD5X, Adventurer 5M / 5M Pro, Creator 5 / 5 Pro. No accounts, no server: everything runs on your device.

There are three ways to use it, all built from this one repository:

| | What it is | Where it runs |
|---|---|---|
| **Web app** | `dist/web/`, hosted on Netlify | iPhone (Safari), any browser |
| **Add-on** | `dist/addon/Send to Plate Builder.user.js` | Safari on iPhone with the free *Userscripts* app, or Chrome/Edge with *Tampermonkey* |
| **Desktop app** | `desktop/` (Electron) | Windows |

## What's where

```
core/         the engine, shared by everything
  core.js           reads 3MF/STL/OBJ, lays out the plate, writes Flashforge 3MF projects
  profiles.json     Flashforge printer, process and filament settings (generated)
  build_profiles.py regenerates profiles.json from the slicer repos (see the file for usage)
web/          the app's page
  app.html          UI (template: __PROFILES__ and __CORE__ are filled in by the build)
  slice-worker.js   runs the phone slicer (three-slicer, WebAssembly) off the main thread
  vendor/           three-slicer (AGPL-3.0) and JSZip (MIT)
addon/src/    the add-on, in parts
  header.txt        userscript header (@match list: the sites it works on)
  sites.js          the "Send to Plate Builder" button on model sites
  bridge.js         runs on Plate Builder itself: printer sending, zips, files from other sites.
                    The desktop app uses this same file.
desktop/      the Windows app (Electron)
  src/main.js       serves the web app, Find models window, Downloads watching, printer requests
  src/preload.js    plugs bridge.js into the app
scripts/build.py  builds dist/web and dist/addon
tests/        fixtures and Playwright tests (web, add-on, desktop)
```

## Building

```
python scripts/build.py          # dist/web and dist/addon
cd desktop && npm ci && npm start   # run the desktop app
cd desktop && npm run dist          # Windows installer in desktop/dist (on Windows)
```

GitHub Actions builds the Windows installer on every push to `main` (download it from the run's *Artifacts*), and publishes a Release when you push a tag such as `v0.2.0`.

## Updating each version

- **Web app:** run the build, then drag `dist/web` (zipped) onto the Netlify site's Deploys page. Each deploy uses Netlify credits, so batch changes.
- **Add-on:** send yourself `dist/addon/Send to Plate Builder.user.js` and save it into the *Userscripts* folder in Files (Replace). No deploy needed.
- **Desktop app:** install the new `Plate Builder Setup.exe` from the latest Actions run or Release.

## Tests

```
python scripts/build.py
(cd dist/web && python -m http.server 8765 &)
node tests/web/ui_sites.js        # add-on on Printables / Thingiverse / direct links (mock sites)
node tests/web/ui_makerworld.js   # add-on on MakerWorld (mock)
node tests/web/ui_print.js "Creator 5 Pro"   # send to printer (mock printer)
node tests/web/ui_zip.js          # zips in Add files
node tests/web/ui_slice.js "Creator 5 Pro"   # phone slicer
xvfb-run -a node tests/desktop/smoke.js     # desktop app (Linux)
```

Set `CHROME` to a Chrome binary and `PLAYWRIGHT` to a Playwright install if they aren't on the default paths.
