# Ice Thickness Measurement Tool

Measure ice thickness in cryo-EM grid images. Draw circular ROIs over the
holes, pick an empty hole (or a broken-grid area) as the reference I₀, and the
tool computes

```
thickness = λ · ln(I₀ / I)
```

for every other ROI (λ = 350 at 300 kV, 300 at 200 kV, both adjustable).

It runs entirely in your browser: **no installation, no backend, and images
never leave your computer.**

## Features

- Load many images at once (button or drag & drop); each keeps its own ROIs,
  reference I₀, results and zoom/pan
- **Right-drag** draws an ROI · **left-drag** pans · **wheel** zooms ·
  **click a circle** to make it the reference I₀
- PNG / JPG / BMP / WebP / TIFF (8/16/32-bit, integer or float, LZW, deflate,
  PackBits); TIFF ROI means are computed from the raw 16-bit/float data
- Warns when the image is clipped at its maximum (a saturated hole is not a
  valid I₀)
- One CSV export for all images, with a per-image summary

## Getting started

### Windows: download the .exe

Download **`IceThickness.exe`** from the
[latest release](https://github.com/jianglab/IceThicknessTool/releases/latest)
and double-click it. It opens the tool in your default browser; close the
small console window to stop it. No Python needed.

Options: `IceThickness.exe --port 9000`, `IceThickness.exe --no-browser`.

> Windows SmartScreen may warn about an unsigned app the first time —
> choose *More info → Run anyway*.

### Windows, Linux or macOS: run from source

Needs only Python 3 (standard library):

```sh
git clone --recurse-submodules https://github.com/jianglab/IceThicknessTool.git
cd IceThicknessTool
python launcher.py          # opens http://127.0.0.1:8765/ in your browser
```

Or simply open `webapp/index.html` in a browser, or run `python webapp/serve.py`
to share it on your lab network at `http://<your-pc-name>:8000`.

## Repository layout

| Path | What it is |
|---|---|
| [`webapp/`](webapp) | The web app (HTML/CSS/JS, vendored UTIF.js + pako). Full docs and accuracy notes: [`webapp/README.md`](webapp/README.md) |
| [`launcher.py`](launcher.py) | Serves `webapp/` on localhost and opens the browser |
| [`build_exe.bat`](build_exe.bat) | Builds `dist/IceThickness.exe` with PyInstaller |
| [`tests/`](tests) | Node tests and TIFF fixtures |
| [`test-image/`](test-image) | Sample grid images to try the tool on |
| [`LocalApp/`](LocalApp) | The original Tkinter desktop tool (git submodule) |

## Development

Run the tests (Node.js):

```sh
node tests/node_tiff_test.js     # TIFF decoding + ROI math vs NumPy reference
node tests/node_detect_test.js   # hole-detector module
node tests/node_app_smoke.js     # full app workflow in a stub DOM
```

Rebuild the Windows executable after changing the app: run `build_exe.bat`
(Python 3 required; PyInstaller is installed automatically), then attach
`dist/IceThickness.exe` to a new GitHub release.

## Accuracy

λ dominates the error budget, the reference must be genuinely ice-free, and
clipped or JPEG-compressed images bias the result. Treat absolute values as
±tens of percent; comparisons between holes in the same image are much more
reliable. See [`webapp/README.md`](webapp/README.md#accuracy-notes-read-before-publishing-numbers)
for details.
