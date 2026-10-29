# Ice Thickness Measurement Tool (Web)

Browser-based port of the desktop tool in [`../LocalApp`](../LocalApp). Same
science, same workflow — plus multi-image handling. It runs 100% in the
browser: **no server, no backend, no API keys, and your microscopy images
never leave the machine.**

For each circular ROI the mean pixel intensity *I* is computed, and the ice
thickness is derived from a reference region *I₀* (an empty hole or
broken-grid area):

```
thickness = λ · ln(I₀ / I)
```

λ defaults to **350** (300 kV) and **300** (200 kV), folded away under
*λ settings (advanced)* in the panel.

## Features

- Load many images at once (button or drag & drop); thumbnails in the left
  rail, remove one with the × on its thumbnail
- Every image keeps its **own ROIs, reference I₀, results and zoom/pan**
- **Right-drag** draws a circular ROI · **left-drag** pans · **wheel** zooms ·
  **Esc** cancels
- **Click a circle** (or its row in the list) to set the reference I₀; I₀ is
  red, measured ROIs light blue, with live thickness labels
- Per-ROI delete (×), delete last, delete all
- Average ice thickness for the current image plus a per-image summary
- One CSV for all images: `image, ROI index, I0/I label, lambda value,
  ice thickness value, mean intensity, center x, center y, radius`, followed
  by a per-image summary block
- PNG / JPG / BMP / WebP / TIFF (8/16/32-bit, integer or float, little- or
  big-endian, uncompressed, LZW, PackBits, deflate — via vendored
  [UTIF.js] + [pako], fully offline)
- ROI means come from the raw samples (16-bit / float) for TIFF, never from
  the 8-bit screen render, so the *I₀/I* ratio is exact
- **Clipping warning**: on load the app measures how much of the image is
  pinned at its maximum and warns, because a saturated hole can never be a
  valid I₀

## Windows .exe (no Python, no server setup)

`dist/IceThickness.exe` is a **single self-contained file (~10 MB)**. Copy it
anywhere — USB stick, a colleague's desktop — and double-click it. It serves
the app on a free localhost port and opens it in the default browser; a small
console window shows the address and stops the tool when closed. Nothing is
installed, and no Python is needed on the target machine.

Options if you want them: `IceThickness.exe --port 9000`, `--no-browser`.

Rebuild it after changing the app with **`build_exe.bat`** (Python 3 on the
build machine; PyInstaller is installed automatically). It is built from
`launcher.py`, which serves the bundled `webapp/` folder on `127.0.0.1` — the
images still never leave the machine.

## Run it

**Option A — just open it:** double-click `index.html`. Everything is static
and works from the file system.

**Option B — local server (lab network):**

```sh
python serve.py            # http://localhost:8000
python serve.py 8080       # custom port
```

or double-click `serve.bat` on Windows. Anyone on your network can then open
`http://<your-pc-name>:8000`.

**Option C — free public hosting:** push the `webapp/` folder to GitHub and
enable **GitHub Pages**, or drag it into [Netlify Drop](https://app.netlify.com/drop).

## File structure

| File | Purpose |
|---|---|
| `index.html` | Layout: thumbnail rail, image canvas, control panel |
| `style.css` | Styling |
| `app.js` | Image library, upload, zoom/pan, ROI drawing, thickness math, CSV export |
| `detect.js` | `roiMeanIn` — the circular-mask mean, plus the (currently unused) high-mag hole detector |
| `vendor/utif.js` | TIFF decoder (utif2 v4.1.0, MIT — `UTIF.LICENSE.txt`) |
| `vendor/pako.min.js` | Deflate decompression (pako v3.0.1, MIT — `pako.LICENSE.txt`) |
| `serve.py` / `serve.bat` | One-command local server |

## Verification

Three suites live in `../tests`; all are offline and need only Node + Python:

```sh
python tests/gen_ref.py            && node tests/node_tiff_test.js   # TIFF decode + ROI math vs NumPy ground truth
python tests/gen_detect_fixture.py && node tests/node_detect_test.js # the detector module (not used by the UI)
node tests/node_app_smoke.js                                         # full app workflow in a stub DOM
```

- **`node_tiff_test.js`** — 6 synthetic TIFF variants (8/16/32-bit, LE/BE,
  deflate) decoded by the *vendored libraries*, ROI means and thicknesses
  compared against the desktop tool's NumPy math.
- **`node_app_smoke.js`** — executes `app.js` in a stub DOM built from the
  real ids in `index.html`, driving image loading → ROI creation → I₀ change →
  voltage change → CSV export → image removal, and asserting per-image ROI
  isolation and the clipping warning.
- **`detect_on_image.js`** — a diagnostic CLI for the detector module.

## Accuracy notes (read before publishing numbers)

- **λ dominates the error budget.** *t* = λ·ln(I₀/Iₘ), so every % error in λ is
  a % error in every thickness. Report the λ you used.
- **The reference must be genuinely ice-free**, otherwise all values are offset
  by the reference's own thickness.
- **Clipping is the other big one.** An 8-bit export is often
  contrast-stretched, and the brightest (thinnest-ice) hole saturates first —
  exactly the one you want as I₀. The app warns when this happens; measure
  from the original 16-bit/float data if you can.
- **Lossless vs lossy format.** TIFF (uncompressed/LZW/deflate) and PNG are
  lossless; JPEG is not, is 8-bit only, and cannot be undone. A pure linear
  gain cancels in the I₀/Iₘ ratio, but an offset or any clipping does not.
- **ROI radius matters.** Inside a hole the intensity is not flat (rim and
  contamination), and choosing 0.4r instead of 0.7r changed values by up to
  ~20% on the test images. Keep ROIs off the rim and use the same fraction
  everywhere.
- **Tilt** adds *1/cos θ* to the path length (+6% at 20°).
- Absolute values should be treated as ±tens of percent; *relative* comparisons
  between holes in the same image are much more reliable.

[UTIF.js]: https://github.com/photopea/UTIF.js
[pako]: https://github.com/nodeca/pako
