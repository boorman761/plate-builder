# Notes for working on Plate Builder

Read README.md for the layout. This file holds what was learned the hard way.

## Who uses it and how
- Phil and his wife. Mainly iPhone: Safari → Plate Builder (Netlify) → share the 3MF to Flash Studio, or send to the printer.
- Printers: Creator 5 Pro (main), plus an AD5X and an Adventurer 5M. No logins, no accounts, ever.
- Netlify deploys cost credits: batch web changes into one deploy. Add-on and desktop changes don't need Netlify.
- Plain English in the UI, sentence case, no jargon.

## Formats and profiles
- Bambu/Orca 3MF: sub-object ids must be globally unique; each placed copy needs its own object and mesh copy (or copies stack when opened).
- Paint (paint_color / mmu_segmentation): hex nibbles reversed, low 2 bits = split sides, output uppercase.
- AD5X / 5M / 5M Pro profiles come from FlashForge/Orca-Flashforge (Application "OrcaSlicer-2.3.0"). The plain Orca ones lack Flashforge's start G-code and sends fail at 34 %.
- Creator 5 / 5 Pro profiles come from OrcaSlicer (Application "BambuStudio-02.06.00.51", metadata tag 2.4.2).
- Keep only the author's overrides (different_settings_to_system[0]) plus layer height; clamp temperatures and layer height to the Flashforge preset's limits.

## Phone slicer (three-slicer, beta)
- Multi-colour slices don't stream: read gcode and layers from the result.
- Blank file_start_gcode (placeholder parse errors). printable_area must be [x, y] pairs. Centre the STL on the plate.
- Creator 5 (a toolhead per colour): flush volumes 0 (purge_in_prime_tower = 0); the engine's real wipe tower prints at ~20 mm/s, so tower moves are raised to 80 mm/s; parked toolheads go to standby (−80 °C) and are heated ~45 s before use (toolheadGcode in app.html).
- **Still broken:** multi-colour Creator 5 prints from the phone slicer make a mess at colour changes (grey blobs/strings). Suspects: no Z lift on the travel to the tower after a toolchange; only 0.8 mm unretract after the printer's own toolchange. Next step: compare with a sliced 3MF exported from Flash Studio Desktop for the same plate. Until then, multi-colour Creator 5 prints go through Flash Studio.

## Printer API (Flashforge, port 8898)
- POST /detail {serialNumber, checkCode} → status, name, matlStationInfo.slotInfos.
- POST /uploadGcode multipart (gcodeFile) with headers serialNumber, checkCode, fileSize, printNow, levelingBeforePrint, flowCalibration, timeLapseVideo, useMatlStation, gcodeToolCnt, materialMappings (base64 JSON of {toolId, slotId, materialName, toolMaterialColor, slotMaterialColor}); no firstLayerInspection header for Creator 5. Mappings only apply to .3mf uploads on Creator 5.
- The check code is on the printer: ⚙ → Network → LAN Only.

## iPhone limits
- Web pages can't reach the printer, open MakerWorld in a frame (it blocks it), or intercept downloads. The Userscripts add-on does what's possible: a button on model sites, printer requests, zips.
- Safari only opens a new tab straight after a tap, so the add-on asks for one more tap ("Open in Plate Builder").
- Creative Fabrica, MyMiniFactory and Thangs download through their own scripts: download normally, then pick the zip in Add files.

## Desktop app
- Serves dist/web over app://plate-builder so module workers and WebAssembly work.
- The Find models window uses a persistent session ('persist:sites'); downloads of 3MF/STL/OBJ/zip go straight onto the plate.
- Watches the Downloads folder for new model files (File menu toggle).
- Phil doesn't want direct printer sending on the desktop: Flash Studio slices and sends. The main button is "Open in Flash Studio": it saves the plate to Documents\Plate Builder and launches Flash Studio with it (found in Program Files / LocalAppData\Programs, or chosen once via File → Choose Flash Studio…). Slice and Read-from-printer are hidden (html[data-pb-desktop]).
- With the printer set to "Bambu (keep original settings)" the button becomes "Open in Bambu Studio" and launches Bambu Studio instead (File → Choose Bambu Studio… if it isn't found). The preload tells main which slicer via the 'pb-target' message.
- Updates: electron-updater checks GitHub releases at start-up and every 4 hours, downloads in the background and offers a restart (Help → Check for updates too). To ship a new version, bump "version" in desktop/package.json (and package-lock.json) and push to main: the workflow publishes release v<version> with the installer and latest.yml. This session can't push tags or create releases itself; the workflow does it. The repo must be public for the app to read releases.
- The printer bridge code is still loaded (shared with the add-on); its requests are limited to private addresses on port 8898.
