"use strict";

/* =====================================================================
 * Ice Thickness Measurement Tool — client-side web port of
 * LocalApp/roi_gui_tool.py
 *
 *     thickness = lambda * ln(I0 / Im)
 *
 * Lambda defaults to 350 (300 kV) and 300 (200 kV).
 *
 * Supports a library of images (left rail): every image keeps its own
 * ROIs, reference I0, results and view transform; the CSV export covers
 * all images at once. Hole detection lives in detect.js (pure, testable).
 * Everything runs in the browser; no image data is uploaded.
 * ===================================================================== */

const $ = (id) => document.getElementById(id);
const HD = window.HoleDetect;

const canvas = $("canvas");
const ctx = canvas.getContext("2d");

const state = {
  images: [],       // library records (see createRecordFromFile)
  activeId: null,
  // working view of the *active* record:
  gray: null,       // Float32Array at full precision
  width: 0,
  height: 0,
  display: null,    // <canvas> 8-bit render
  rois: [],         // SAME array object as the active record's rois
  i0: null,
  scale: 1,
  panX: 0,
  panY: 0,
  thicknesses: [],
  draw: null,       // ROI being drawn
  pan: null,        // pan gesture
  lam300: 350,
  lam200: 300,
  voltage: 300,
};

const MIN_SCALE = 0.02;
const MAX_SCALE = 100;
const ROI_COLOR = "#00bfff";
const I0_COLOR = "#e11d48";

let idSeq = 0;

/* ---------------------------------------------------------------- */
/* Helpers                                                          */
/* ---------------------------------------------------------------- */

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function currentLambda() {
  return state.voltage === 300 ? state.lam300 : state.lam200;
}

function setStatus(text, kind) {
  const el = $("statusLine");
  el.textContent = text;
  el.classList.toggle("error", kind === "error");
  el.classList.toggle("good", kind === "good");
}

function activeRec() {
  for (let i = 0; i < state.images.length; i++) {
    if (state.images[i].id === state.activeId) return state.images[i];
  }
  return null;
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function isImageFile(name) {
  return /\.(png|jpe?g|bmp|webp|tiff?)$/i.test(name || "");
}

/* ---------------------------------------------------------------- */
/* Decoding                                                         */
/* ---------------------------------------------------------------- */

/* PNG / JPG / BMP / WebP — decoded by the browser itself */
async function decodeRaster(file) {
  const bmp = await createImageBitmap(file);
  const w = bmp.width;
  const h = bmp.height;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const cc = c.getContext("2d", { willReadFrequently: true });
  cc.drawImage(bmp, 0, 0);
  bmp.close();
  const rgba = cc.getImageData(0, 0, w, h).data;
  const gray = new Float32Array(w * h);
  // Same grayscale coefficients as PIL's .convert("L")
  for (let i = 0; i < gray.length; i++) {
    gray[i] = 0.299 * rgba[4 * i] + 0.587 * rgba[4 * i + 1] + 0.114 * rgba[4 * i + 2];
  }
  return { gray, w, h, needsNorm: false };
}

/* TIFF — decoded by vendored UTIF.js. Means are computed from the RAW
 * samples (8/16/32-bit, integer or float), so the I0/Im ratio keeps full
 * precision instead of being squeezed through an 8-bit render. */
function decodeTiff(buf) {
  const ifds = UTIF.decode(buf);
  if (!ifds || !ifds.length) throw new Error("no image directory found in TIFF");
  const ifd = ifds[0];
  UTIF.decodeImage(buf, ifd);
  const w = ifd.width;
  const h = ifd.height;
  if (!w || !h) throw new Error("could not decode TIFF pixels");
  const data = ifd.data;
  if (!data || data.length < w * h) throw new Error("TIFF contains no pixel data");

  const bpsTag = ifd["t258"];                                  // bits per sample
  const bps = Math.min(32, bpsTag ? bpsTag[0] : 8);
  const smpls = ifd["t277"] ? ifd["t277"][0] : (bpsTag ? bpsTag.length : 1);
  const sfmt = ifd["t339"] ? ifd["t339"][0] : null;            // 3 = IEEE float
  const intp = ifd["t262"] ? ifd["t262"][0] : 2;               // photometric
  const area = w * h;
  const gray = new Float32Array(area);

  // Palette-color TIFF: fall back to UTIF's own 8-bit render
  if (intp === 3) {
    const rgba = UTIF.toRGBA8(ifd);
    for (let i = 0; i < area; i++) {
      gray[i] = 0.299 * rgba[4 * i] + 0.587 * rgba[4 * i + 1] + 0.114 * rgba[4 * i + 2];
    }
    return { gray, w, h, needsNorm: false };
  }

  const whiteIsZero = intp === 0;
  const n = smpls;

  if (bps <= 8 || bps === 24) {
    // 1–8 bits per sample (24 = 3×8-bit RGB): raw bytes
    for (let i = 0; i < area; i++) {
      let s = 0;
      for (let c = 0; c < n; c++) s += data[i * n + c];
      gray[i] = s / n;
      if (whiteIsZero) gray[i] = 255 - gray[i];
    }
  } else if (bps === 16) {
    // 16-bit integer; decodeImage already normalised the byte order to LE
    for (let i = 0; i < area; i++) {
      let s = 0;
      for (let c = 0; c < n; c++) {
        const o = (i * n + c) * 2;
        s += data[o] | (data[o + 1] << 8);
      }
      gray[i] = s / n;
      if (whiteIsZero) gray[i] = 65535 - gray[i];
    }
  } else if (bps === 32) {
    // 32-bit float (SampleFormat 3) or 32-bit integer
    if (ifd.isLE === false) {
      for (let i = 0; i + 3 < data.length; i += 4) {
        const t = data[i]; data[i] = data[i + 3]; data[i + 3] = t;
        const u = data[i + 1]; data[i + 1] = data[i + 2]; data[i + 2] = u;
      }
    }
    if (sfmt === 3) {
      const f32 = new Float32Array(data.buffer, data.byteOffset, data.byteLength >> 2);
      for (let i = 0; i < area; i++) {
        let s = 0;
        for (let c = 0; c < n; c++) s += f32[i * n + c];
        gray[i] = s / n;
      }
    } else {
      const u32 = new Uint32Array(data.buffer, data.byteOffset, data.byteLength >> 2);
      for (let i = 0; i < area; i++) {
        let s = 0;
        for (let c = 0; c < n; c++) s += u32[i * n + c];
        gray[i] = s / n;
        if (whiteIsZero) gray[i] = 4294967295 - gray[i];
      }
    }
  } else {
    throw new Error("unsupported TIFF bit depth: " + bps);
  }

  return { gray, w, h, needsNorm: true };
}

/* Render grayscale data to an 8-bit canvas for display. TIFF data (often
 * 16-bit/float with outliers) gets a 0.5–99.5 percentile stretch; plain
 * 8-bit sources pass through so the display matches the raw data. */
function buildDisplay(gray, w, h, doNorm) {
  const N = w * h;
  let lo = 0, hi = 255;
  if (doNorm) {
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < N; i++) {
      const v = gray[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (!(mx > mn)) { mn = 0; mx = 1; }
    const BINS = 4096;
    const hist = new Uint32Array(BINS);
    const s = BINS / (mx - mn);
    for (let i = 0; i < N; i++) hist[clamp(((gray[i] - mn) * s) | 0, 0, BINS - 1)]++;
    let acc = 0;
    const loTarget = N * 0.005;
    for (let b = 0; b < BINS; b++) {
      acc += hist[b];
      if (acc >= loTarget) { lo = mn + (b / BINS) * (mx - mn); break; }
    }
    acc = 0;
    for (let b = BINS - 1; b >= 0; b--) {
      acc += hist[b];
      if (acc >= loTarget) { hi = mn + (b / BINS) * (mx - mn); break; }
    }
    if (!(hi > lo)) hi = lo + 1;
  }

  const data = new Uint8ClampedArray(N * 4);
  const s = 255 / (hi - lo);
  for (let i = 0; i < N; i++) {
    const v = clamp(((gray[i] - lo) * s) | 0, 0, 255);
    data[4 * i] = v;
    data[4 * i + 1] = v;
    data[4 * i + 2] = v;
    data[4 * i + 3] = 255;
  }
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d").putImageData(new ImageData(data, w, h), 0, 0);
  return c;
}

/* ---------------------------------------------------------------- */
/* Image library                                                    */
/* ---------------------------------------------------------------- */

function fitRecord(rec) {
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  if (cw < 10 || ch < 10) { rec.scale = 1; rec.panX = 0; rec.panY = 0; return; }
  rec.scale = 0.8 * Math.min(cw / rec.width, ch / rec.height);
  rec.panX = (cw - rec.width * rec.scale) / 2;
  rec.panY = (ch - rec.height * rec.scale) / 2;
}

async function createRecordFromFile(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const data = (ext === "tif" || ext === "tiff")
    ? decodeTiff(await file.arrayBuffer())
    : await decodeRaster(file);
  const rec = {
    id: ++idSeq,
    name: file.name,
    gray: data.gray,
    width: data.w,
    height: data.h,
    display: buildDisplay(data.gray, data.w, data.h, data.needsNorm),
    rois: [],
    i0: null,
    thicknesses: [],
    scale: 1, panX: 0, panY: 0,
  };
  // Clipping statistics: pixels pinned at the maximum cannot be measured and
  // a saturated hole can never be a valid reference I0.
  let maxVal = -Infinity;
  let clipped = 0;
  for (let i = 0; i < data.gray.length; i++) {
    if (data.gray[i] > maxVal) maxVal = data.gray[i];
  }
  if (maxVal > 0) {
    for (let i = 0; i < data.gray.length; i++) {
      if (data.gray[i] >= maxVal) clipped++;
    }
  }
  rec.maxVal = maxVal;
  rec.clippedFrac = data.gray.length ? clipped / data.gray.length : 0;
  fitRecord(rec);
  return rec;
}

async function addFiles(fileList) {
  const files = Array.from(fileList || []).filter((f) => isImageFile(f.name));
  if (!files.length) {
    setStatus("No supported image files in that selection.", "error");
    return;
  }
  let firstAdded = null;
  let failed = 0;
  for (let i = 0; i < files.length; i++) {
    if (files.length > 1) {
      setStatus("Loading " + (i + 1) + " / " + files.length + ": " + files[i].name + " …");
      await nextFrame();
    } else {
      setStatus("Loading " + files[i].name + " …");
      await nextFrame();
    }
    try {
      const rec = await createRecordFromFile(files[i]);
      state.images.push(rec);
      if (!firstAdded) firstAdded = rec;
    } catch (err) {
      failed++;
      setStatus("Failed to load " + files[i].name + ": " +
        (err && err.message ? err.message : err), "error");
      await nextFrame();
    }
  }
  if (firstAdded) setActive(firstAdded.id);
  updateThumbs();
  if (!failed) {
    setStatus("Loaded " + (files.length === 1 ? files[0].name : files.length + " images") +
      " — " + state.width + " × " + state.height + " px", "good");
  }
}

function setActive(id) {
  const rec = state.images.find((r) => r.id === id);
  if (!rec) return;
  syncActive();
  state.activeId = rec.id;
  state.gray = rec.gray;
  state.width = rec.width;
  state.height = rec.height;
  state.display = rec.display;
  state.rois = rec.rois;            // shared reference: mutate in place only
  state.i0 = rec.i0;
  state.scale = rec.scale;
  state.panX = rec.panX;
  state.panY = rec.panY;
  state.draw = null;
  state.pan = null;
  canvas.style.cursor = "crosshair";
  recompute();
  updateThumbs();
}

function removeImage(id) {
  const idx = state.images.findIndex((r) => r.id === id);
  if (idx < 0) return;
  const wasActive = state.activeId === id;
  state.images.splice(idx, 1);
  if (wasActive) {
    const next = state.images[idx] || state.images[idx - 1] || null;
    if (next) {
      state.activeId = null;   // force a full reload of the view
      setActive(next.id);
    } else {
      resetWorkspace();
    }
  }
  updateThumbs();
}

function resetWorkspace() {
  state.activeId = null;
  state.gray = null;
  state.width = 0;
  state.height = 0;
  state.display = null;
  state.rois = [];
  state.i0 = null;
  state.thicknesses = [];
  state.draw = null;
  state.pan = null;
  canvas.style.cursor = "default";
  recompute();
  updateThumbs();
  setStatus("No image loaded. Upload an image to begin.");
}

function syncActive() {
  const rec = activeRec();
  if (!rec) return;
  rec.i0 = state.i0;
  rec.thicknesses = state.thicknesses;
  rec.scale = state.scale;
  rec.panX = state.panX;
  rec.panY = state.panY;
  // rec.rois === state.rois (same array object, mutated in place)
}

/* ---------------------------------------------------------------- */
/* View transform                                                   */
/* ---------------------------------------------------------------- */

function fitView() {
  const rec = activeRec();
  if (!rec) return;
  fitRecord(rec);
  state.scale = rec.scale;
  state.panX = rec.panX;
  state.panY = rec.panY;
  syncActive();
  requestRender();
}

function zoomAt(sx, sy, factor) {
  const ns = clamp(state.scale * factor, MIN_SCALE, MAX_SCALE);
  const f = ns / state.scale;
  state.scale = ns;
  state.panX = sx - (sx - state.panX) * f;
  state.panY = sy - (sy - state.panY) * f;
  syncActive();
  requestRender();
}

function toImage(sx, sy) {
  return [(sx - state.panX) / state.scale, (sy - state.panY) / state.scale];
}

function toScreen(ix, iy) {
  return [ix * state.scale + state.panX, iy * state.scale + state.panY];
}

/* ---------------------------------------------------------------- */
/* Rendering                                                        */
/* ---------------------------------------------------------------- */

let rafPending = false;
function requestRender() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    render();
  });
}

function render() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const pw = Math.max(1, Math.round(w * dpr));
  const ph = Math.max(1, Math.round(h * dpr));
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, pw, ph);

  if (!state.gray) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#9aa3ad";
    ctx.font = "15px 'Segoe UI', system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(state.images.length ? "Select an image" : "Upload an image to begin",
      w / 2, h / 2);
    return;
  }

  ctx.imageSmoothingEnabled = state.scale < 1;
  ctx.setTransform(dpr * state.scale, 0, 0, dpr * state.scale,
    dpr * state.panX, dpr * state.panY);
  ctx.drawImage(state.display, 0, 0);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.textBaseline = "alphabetic";

  // committed ROIs
  for (let i = 0; i < state.rois.length; i++) {
    drawCircle(state.rois[i], i, i === state.i0, false);
  }
  // ROI being dragged
  if (state.draw) drawCircle(state.draw, -1, false, true);
}

function drawCircle(roi, idx, isI0, isTemp) {
  const cx = roi.cx * state.scale + state.panX;
  const cy = roi.cy * state.scale + state.panY;
  const r = Math.max(roi.r * state.scale, 0.5);

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = isI0 ? I0_COLOR : ROI_COLOR;
  ctx.lineWidth = isTemp ? 1.5 : isI0 ? 2.2 : 1.5;
  ctx.setLineDash(isTemp ? [6, 4] : []);
  ctx.stroke();
  ctx.setLineDash([]);

  if (!isTemp && !isI0 && idx >= 0 && state.i0 !== null && state.thicknesses.length) {
    const t = state.thicknesses[idx];
    if (t !== undefined && t !== null) {
      ctx.font = "bold 12px 'Segoe UI', system-ui, sans-serif";
      ctx.fillStyle = ROI_COLOR;
      ctx.textAlign = "left";
      ctx.fillText(t === Infinity ? "∞ nm" : t.toFixed(1) + " nm", cx + r + 6, cy - r - 6);
    }
  }
}

/* ---------------------------------------------------------------- */
/* ROI math                                                         */
/* ---------------------------------------------------------------- */

function roiMean(cx, cy, r) {
  return HD.roiMeanIn(state.gray, state.width, state.height, cx, cy, r);
}

function thicknessesFor(rec) {
  const rois = rec.rois;
  const i0 = rec.i0;
  if (i0 === null || i0 === undefined || !rois[i0]) {
    return new Array(rois.length).fill(null);
  }
  const I0 = rois[i0].mean;
  const lam = currentLambda();
  return rois.map((roi, idx) => {
    if (idx === i0) return null;
    if (!(I0 > 0)) return null;
    if (roi.mean > 0) return lam * Math.log(I0 / roi.mean);
    if (roi.mean === 0) return Infinity;
    return null;
  });
}

/* Always computed fresh from the stored ROI means, so the per-image summary
 * stays correct when lambda/voltage changes (including for images that are
 * not currently active). */
function averageThickness(rec) {
  if (!rec || rec.i0 === null || rec.i0 === undefined) return null;
  const th = thicknessesFor(rec);
  let sum = 0, n = 0;
  th.forEach((t, i) => {
    if (i !== rec.i0 && t !== null && t !== undefined && t !== Infinity && isFinite(t)) {
      sum += t;
      n++;
    }
  });
  return n ? sum / n : null;
}



/* Warn when the image is clipped: saturated pixels destroy the I0/Im ratio,
 * and a saturated hole must never be used as the reference. */
function updateClipWarning() {
  const el = $("clipWarning");
  const rec = activeRec();
  if (!rec || !(rec.clippedFrac > 0.005)) {
    el.textContent = "";
    el.classList.add("hidden");
    return;
  }
  const shown = rec.maxVal >= 1 ? rec.maxVal.toFixed(0) : String(rec.maxVal);
  el.classList.remove("hidden");
  el.textContent = "\u26a0 " + (100 * rec.clippedFrac).toFixed(1) +
    "% of pixels are clipped at the maximum (" + shown + "). Saturated areas cannot " +
    "serve as reference I\u2080 \u2014 thickness may be biased.";
}


/* ---------------------------------------------------------------- */
/* UI updates                                                       */
/* ---------------------------------------------------------------- */

function recompute() {
  state.thicknesses = activeRec()
    ? thicknessesFor({ rois: state.rois, i0: state.i0 })
    : [];
  syncActive();
  updateRoiList();
  updateAverage();
  updateAllImages();
  updateThumbs();
  updateInfoLine();
  updateClipWarning();
  requestRender();
}

function updateInfoLine() {
  const rec = activeRec();
  const el = $("infoLine");
  if (!rec) { el.textContent = ""; return; }
  const idx = state.images.findIndex((r) => r.id === rec.id) + 1;
  el.textContent = rec.width + " × " + rec.height + " px · image " + idx +
    " of " + state.images.length;
}

function updateRoiList() {
  const list = $("roiList");
  const rec = activeRec();
  $("roiScope").textContent = (rec && state.images.length > 1) ? "· " + rec.name : "";
  list.innerHTML = "";
  if (!rec) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No image loaded.";
    list.appendChild(empty);
    return;
  }
  if (!state.rois.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No ROIs yet — right-drag on the image.";
    list.appendChild(empty);
    return;
  }
  state.rois.forEach((roi, idx) => {
    const row = document.createElement("div");
    row.className = "roi-row" + (idx === state.i0 ? " is-i0" : "");
    row.title = "Click to set as reference I\u2080";

    const name = document.createElement("span");
    name.className = "roi-name";
    name.textContent = "ROI " + (idx + 1) + (idx === state.i0 ? " (I\u2080)" : "");

    const mean = document.createElement("span");
    mean.className = "roi-mean";
    mean.textContent = "mean " + roi.mean.toFixed(2);

    const th = document.createElement("span");
    th.className = "roi-th";
    if (idx !== state.i0 && state.thicknesses[idx] !== undefined) {
      const t = state.thicknesses[idx];
      th.textContent = t === null ? "—" : t === Infinity ? "∞" : t.toFixed(1) + " nm";
    }

    const del = document.createElement("button");
    del.className = "roi-del";
    del.textContent = "×";
    del.title = "Delete this ROI";
    del.addEventListener("click", (ev) => {
      ev.stopPropagation();
      deleteRoi(idx);
    });

    row.addEventListener("click", () => setI0(idx));
    row.append(name, mean, th, del);
    list.appendChild(row);
  });
}

function updateAverage() {
  const el = $("avgValue");
  const rec = activeRec();
  if (!rec || state.i0 === null) { el.textContent = "—"; return; }
  const avg = averageThickness(rec);
  el.textContent = avg === null ? "—" : avg.toFixed(2) + " nm";
}

function updateAllImages() {
  const box = $("allImages");
  box.innerHTML = "";
  if (state.images.length < 2) return;
  state.images.forEach((rec) => {
    const row = document.createElement("div");
    row.className = "row";
    const name = document.createElement("span");
    name.textContent = rec.name;
    name.title = rec.name;
    const val = document.createElement("b");
    const avg = averageThickness(rec);
    val.textContent = rec.i0 === null || rec.i0 === undefined
      ? rec.rois.length + " ROI"
      : (avg === null ? "no result" : avg.toFixed(2) + " nm");
    row.append(name, val);
    box.appendChild(row);
  });
}

function updateThumbs() {
  const box = $("thumbList");
  const empty = $("thumbsEmpty");
  box.innerHTML = "";
  empty.classList.toggle("hidden", state.images.length > 0);
  state.images.forEach((rec) => {
    const el = document.createElement("div");
    el.className = "thumb" + (rec.id === state.activeId ? " active" : "");
    el.title = rec.name;

    const cv = document.createElement("canvas");
    cv.width = 120;
    cv.height = 90;
    drawThumb(cv, rec);

    const name = document.createElement("span");
    name.className = "thumb-name";
    name.textContent = rec.name;

    const badge = document.createElement("span");
    badge.className = "thumb-badge";
    badge.textContent = rec.rois.length ? rec.rois.length + " ROI" : "";

    const del = document.createElement("button");
    del.className = "thumb-del";
    del.textContent = "×";
    del.title = "Remove this image";
    del.addEventListener("click", (ev) => {
      ev.stopPropagation();
      removeImage(rec.id);
    });

    el.append(del, cv, name, badge);
    el.addEventListener("click", () => setActive(rec.id));
    box.appendChild(el);
  });
}

function drawThumb(cv, rec) {
  const c = cv.getContext("2d");
  c.fillStyle = "#26292e";
  c.fillRect(0, 0, cv.width, cv.height);
  const s = Math.min(cv.width / rec.width, cv.height / rec.height);
  const dw = rec.width * s, dh = rec.height * s;
  const dx = (cv.width - dw) / 2, dy = (cv.height - dh) / 2;
  c.imageSmoothingEnabled = true;
  c.drawImage(rec.display, dx, dy, dw, dh);
  rec.rois.forEach((roi, i) => {
    c.beginPath();
    c.arc(dx + roi.cx * s, dy + roi.cy * s, Math.max(roi.r * s, 1.5), 0, Math.PI * 2);
    c.strokeStyle = i === rec.i0 ? I0_COLOR : ROI_COLOR;
    c.lineWidth = 1.5;
    c.stroke();
  });
}

/* ---------------------------------------------------------------- */
/* ROI management                                                   */
/* ---------------------------------------------------------------- */

function setI0(idx) {
  if (idx < 0 || idx >= state.rois.length) return;
  state.i0 = idx;
  recompute();
}

function deleteRoi(idx) {
  if (idx < 0 || idx >= state.rois.length) return;
  state.rois.splice(idx, 1);
  if (state.i0 !== null) {
    if (state.i0 === idx) state.i0 = null;
    else if (state.i0 > idx) state.i0--;
  }
  recompute();
}

/* ---------------------------------------------------------------- */
/* Mouse / keyboard                                                 */
/* ---------------------------------------------------------------- */

canvas.addEventListener("mousedown", (e) => {
  if (!state.gray) return;
  if (e.button === 0) {
    state.pan = { lx: e.offsetX, ly: e.offsetY, moved: false };
  } else if (e.button === 2) {
    e.preventDefault();
    const [ix, iy] = toImage(e.offsetX, e.offsetY);
    state.draw = { cx: ix, cy: iy, r: 0 };
    requestRender();
  }
});

window.addEventListener("mousemove", (e) => {
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;

  if (state.pan) {
    const dx = sx - state.pan.lx;
    const dy = sy - state.pan.ly;
    if (Math.abs(dx) + Math.abs(dy) > 3) state.pan.moved = true;
    state.panX += dx;
    state.panY += dy;
    state.pan.lx = sx;
    state.pan.ly = sy;
    syncActive();
    requestRender();
  } else if (state.draw) {
    const [ix, iy] = toImage(sx, sy);
    state.draw.r = Math.max(0, Math.hypot(ix - state.draw.cx, iy - state.draw.cy));
    requestRender();
  }
});

window.addEventListener("mouseup", (e) => {
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;

  if (state.pan && e.button === 0) {
    if (!state.pan.moved) pickI0At(sx, sy);
    state.pan = null;
  } else if (state.draw && e.button === 2) {
    const [ix, iy] = toImage(sx, sy);
    const r = Math.round(Math.hypot(ix - state.draw.cx, iy - state.draw.cy));
    if (r >= 2) {
      const cx = Math.round(state.draw.cx);
      const cy = Math.round(state.draw.cy);
      state.rois.push({ cx, cy, r, mean: roiMean(cx, cy, r) });
      if (state.rois.length === 1) state.i0 = 0;
    }
    state.draw = null;
    recompute();
  }
});

canvas.addEventListener("contextmenu", (e) => e.preventDefault());

canvas.addEventListener("wheel", (e) => {
  if (!state.gray) return;
  e.preventDefault();
  zoomAt(e.offsetX, e.offsetY, e.deltaY < 0 ? 1.1 : 1 / 1.1);
}, { passive: false });

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.draw) {
    state.draw = null;
    requestRender();
  }
});

canvas.addEventListener("mouseleave", () => {
  if (state.draw && state.draw.r >= 2) {
    const { cx, cy, r } = state.draw;
    const rx = Math.round(cx), ry = Math.round(cy), rr = Math.round(r);
    state.rois.push({ cx: rx, cy: ry, r: rr, mean: roiMean(rx, ry, rr) });
    if (state.rois.length === 1) state.i0 = 0;
    state.draw = null;
    recompute();
  } else if (state.draw) {
    state.draw = null;
    requestRender();
  }
});

window.addEventListener("resize", () => requestRender());

function pickI0At(sx, sy) {
  let best = -1, bestD = Infinity;
  for (let i = 0; i < state.rois.length; i++) {
    const roi = state.rois[i];
    const [cx, cy] = toScreen(roi.cx, roi.cy);
    const r = roi.r * state.scale;
    const d = Math.abs(Math.hypot(sx - cx, sy - cy) - r);
    if (d <= Math.max(8, r * 0.15) && d < bestD) { bestD = d; best = i; }
  }
  if (best >= 0) setI0(best);
}

/* ---------------------------------------------------------------- */
/* Panel controls                                                   */
/* ---------------------------------------------------------------- */

$("uploadBtn").addEventListener("click", () => $("fileInput").click());
$("addImagesBtn").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", (e) => {
  if (e.target.files && e.target.files.length) addFiles(e.target.files);
  e.target.value = "";
});
$("fitBtn").addEventListener("click", () => fitView());

$("deleteLastBtn").addEventListener("click", () => {
  if (!state.rois.length) return;
  state.rois.pop();
  if (state.i0 !== null && state.i0 >= state.rois.length) state.i0 = null;
  recompute();
});
$("deleteAllBtn").addEventListener("click", () => {
  state.rois.length = 0;      // in place: keeps the record's array identity
  state.i0 = null;
  recompute();
});

document.querySelectorAll('input[name="voltage"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    if (!radio.checked) return;
    state.voltage = Number(radio.value);
    recompute();
  });
});

[["lamInput300", "lam300"], ["lamInput200", "lam200"]].forEach(([id, key]) => {
  $(id).addEventListener("input", () => {
    const v = parseFloat($(id).value);
    if (Number.isFinite(v) && v >= 0) {
      state[key] = v;
      recompute();
    }
  });
});

/* Drag & drop upload */
(function () {
  let depth = 0;
  const wrap = $("canvasWrap");
  const overlay = $("dropOverlay");
  wrap.addEventListener("dragenter", (e) => {
    e.preventDefault();
    depth++;
    overlay.classList.remove("hidden");
  });
  wrap.addEventListener("dragover", (e) => e.preventDefault());
  wrap.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (!depth) overlay.classList.add("hidden");
  });
  wrap.addEventListener("drop", (e) => {
    e.preventDefault();
    depth = 0;
    overlay.classList.add("hidden");
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      addFiles(e.dataTransfer.files);
    }
  });
})();

/* ---------------------------------------------------------------- */
/* CSV export — every image in one file                             */
/* ---------------------------------------------------------------- */

function csvField(v) {
  const s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

$("exportBtn").addEventListener("click", () => {
  const statusEl = $("exportStatus");
  statusEl.classList.remove("error", "good");
  const lam = currentLambda();

  const rows = [[
    "image", "ROI index", "I0/I label", "lambda value", "ice thickness value",
    "mean intensity", "center x", "center y", "radius",
  ]];
  const summary = [];
  let exported = 0;

  state.images.forEach((rec) => {
    if (!rec.rois.length || rec.i0 === null || rec.i0 === undefined) return;
    const th = thicknessesFor(rec);
    rec.rois.forEach((roi, idx) => {
      const isI0 = idx === rec.i0;
      const t = th[idx];
      const thickness = !isI0 && t !== null && t !== undefined && t !== Infinity && isFinite(t)
        ? t.toFixed(4) : "";
      rows.push([
        rec.name, idx + 1, isI0 ? "I0" : "I", lam, thickness,
        roi.mean.toFixed(2), roi.cx, roi.cy, roi.r,
      ]);
    });
    const avg = averageThickness(rec);
    const measured = thicknessesFor(rec).filter((t, i) => i !== rec.i0 && t !== null &&
      t !== undefined && t !== Infinity && isFinite(t)).length;
    summary.push([rec.name, measured, avg === null ? "" : avg.toFixed(2)]);
    exported++;
  });

  if (!exported) {
    statusEl.textContent = "No ROI data to export (need ROIs and an I\u2080).";
    statusEl.classList.add("error");
    return;
  }

  const lines = rows.map((r) => r.map(csvField).join(","));
  lines.push("");
  lines.push(["image", "measured ROIs", "average thickness (nm)"].map(csvField).join(","));
  summary.forEach((r) => lines.push(r.map(csvField).join(",")));

  const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "ice_thickness_results.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  statusEl.textContent = "Exported " + exported + " image(s) to ice_thickness_results.csv";
  statusEl.classList.add("good");
});

/* ---------------------------------------------------------------- */
/* Boot                                                             */
/* ---------------------------------------------------------------- */

resetWorkspace();
