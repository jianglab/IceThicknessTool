/* Diagnostic runner for the SHIPPED detector (webapp/detect.js).
 *
 *   node tests/detect_on_image.js <image.tif> [opt=value ...]
 *
 * options
 *   crop=auto|none     restrict analysis to the illuminated square
 *   bgsub=box:R        subtract a local box-blur background of radius R
 *   lin=1              linear percentile stretch before detection
 *   maxWork=512        analysis resolution cap
 *   minAreaFrac=0.004  smallest accepted component (fraction of frame)
 *   minFill/maxFill, minAspect/maxAspect, rejectBorder=1|0
 *
 * Prints the Otsu threshold, a rejection breakdown and the final holes, so
 * it shows WHY detection does or does not work on a given image.
 */
"use strict";

const HD = require("../webapp/detect.js");
const { loadGray } = require("./lib_tiff.js");

const args = process.argv.slice(2);
const file = args[0];
const opt = { crop: "none", bgsub: "none", lin: "0", maxWork: "512", minAreaFrac: "0.004" };
args.slice(1).forEach((a) => {
  const [k, v] = a.split("=");
  opt[k] = v;
});

const { gray: src, w: W0, h: H0 } = loadGray(file);
let gray = src, W = W0, H = H0;

/* ---- optional crop to the illuminated square ---------------------- */
if (opt.crop === "auto") {
  let mx = -Infinity;
  for (let i = 0; i < gray.length; i++) if (gray[i] > mx) mx = gray[i];
  const thr = Math.max(4, 0.06 * mx);
  const rowFrac = new Float64Array(H), colFrac = new Float64Array(W);
  for (let y = 0; y < H; y++) {
    let c = 0;
    for (let x = 0; x < W; x++) if (gray[y * W + x] > thr) c++;
    rowFrac[y] = c / W;
  }
  for (let x = 0; x < W; x++) {
    let c = 0;
    for (let y = 0; y < H; y++) if (gray[y * W + x] > thr) c++;
    colFrac[x] = c / H;
  }
  const need = 0.05;
  let y0 = 0, y1 = H - 1, x0 = 0, x1 = W - 1;
  while (y0 < H && rowFrac[y0] < need) y0++;
  while (y1 > y0 && rowFrac[y1] < need) y1--;
  while (x0 < W && colFrac[x0] < need) x0++;
  while (x1 > x0 && colFrac[x1] < need) x1--;
  const nw = x1 - x0 + 1, nh = y1 - y0 + 1;
  const crop = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) crop[y * nw + x] = gray[(y + y0) * W + (x + x0)];
  }
  console.log(`  crop=auto -> x ${x0}..${x1}, y ${y0}..${y1}  (${nw}x${nh}, ` +
    `${(100 * nw * nh / (W * H)).toFixed(0)}% of frame)`);
  gray = crop; W = nw; H = nh;
}

/* ---- optional linear percentile stretch (should NOT change anything) */
if (opt.lin === "1") {
  const sorted = Float32Array.from(gray).sort();
  const lo = sorted[Math.floor(0.005 * sorted.length)];
  const hi = sorted[Math.floor(0.995 * sorted.length)];
  const s = 255 / Math.max(1e-9, hi - lo);
  for (let i = 0; i < gray.length; i++) gray[i] = Math.max(0, Math.min(255, (gray[i] - lo) * s));
}

/* ---- optional local background subtraction (box blur) ------------- */
if (opt.bgsub.startsWith("box:")) {
  const r = Math.max(1, parseInt(opt.bgsub.split(":")[1], 10));
  const blur = boxBlur(gray, W, H, r);
  const res = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i++) res[i] = gray[i] - blur[i];
  gray = res;
}

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[row + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / n;
      sum -= src[row + Math.min(w - 1, Math.max(0, x - r))];
      sum += src[row + Math.min(w - 1, Math.max(0, x + r + 1))];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / n;
      sum -= tmp[Math.min(h - 1, Math.max(0, y - r)) * w + x];
      sum += tmp[Math.min(h - 1, Math.max(0, y + r + 1)) * w + x];
    }
  }
  return out;
}

/* ---- pipeline diagnostics ----------------------------------------- */
const maxWork = parseInt(opt.maxWork, 10);
const maxDim = Math.max(W, H);
const factor = maxDim > maxWork ? maxWork / maxDim : 1;
const ww = Math.max(1, Math.round(W * factor));
const hh = Math.max(1, Math.round(H * factor));
const work = HD.boxDownsample(gray, W, H, ww, hh);
HD.blurBinomial(work, ww, hh);
HD.blurBinomial(work, ww, hh);
const thr = HD.otsu(work, ww * hh);
let above = 0;
for (let i = 0; i < work.length; i++) if (work[i] > thr) above++;
const lab = HD.labelComponents(work, ww, hh, thr);

const nArea = ww * hh;
const minArea = Math.max(9, parseFloat(opt.minAreaFrac) * nArea);
const maxArea = 0.25 * nArea;
const minFill = opt.minFill === undefined ? 0.55 : parseFloat(opt.minFill);
const maxFill = opt.maxFill === undefined ? 0.92 : parseFloat(opt.maxFill);
const minAspect = opt.minAspect === undefined ? 0.65 : parseFloat(opt.minAspect);
const maxAspect = opt.maxAspect === undefined ? 1.55 : parseFloat(opt.maxAspect);
const rejectBorder = opt.rejectBorder !== "0";

const st = { area: new Int32Array(lab.count + 1), minX: new Int32Array(lab.count + 1),
  maxX: new Int32Array(lab.count + 1), minY: new Int32Array(lab.count + 1),
  maxY: new Int32Array(lab.count + 1) };
for (let i = 0; i <= lab.count; i++) { st.minX[i] = ww; st.maxX[i] = -1; st.minY[i] = hh; st.maxY[i] = -1; }
for (let i = 0; i < lab.labels.length; i++) {
  const L = lab.labels[i];
  if (!L) continue;
  const x = i % ww, y = (i - x) / ww;
  st.area[L]++;
  if (x < st.minX[L]) st.minX[L] = x;
  if (x > st.maxX[L]) st.maxX[L] = x;
  if (y < st.minY[L]) st.minY[L] = y;
  if (y > st.maxY[L]) st.maxY[L] = y;
}

let rArea = 0, rBorder = 0, rShape = 0, ok = 0;
const shapes = [];
for (let L = 1; L <= lab.count; L++) {
  const area = st.area[L];
  if (area < minArea || area > maxArea) { rArea++; continue; }
  if (rejectBorder && (st.minX[L] <= 0 || st.minY[L] <= 0 ||
      st.maxX[L] >= ww - 1 || st.maxY[L] >= hh - 1)) { rBorder++; continue; }
  const bw = st.maxX[L] - st.minX[L] + 1, bh = st.maxY[L] - st.minY[L] + 1;
  const fill = area / (bw * bh), aspect = bw / bh;
  shapes.push({ area, fill, aspect, r: Math.sqrt(area / Math.PI) / factor });
  if (fill < minFill || fill > maxFill || aspect < minAspect || aspect > maxAspect) { rShape++; continue; }
  ok++;
}

console.log(`  analysis ${ww}x${hh} (factor ${factor.toFixed(2)})  ` +
  `Otsu=${thr.toFixed(1)}  above=${(100 * above / work.length).toFixed(1)}%`);
console.log(`  components=${lab.count}  rejected: area ${rArea}, border ${rBorder}, ` +
  `fill/aspect ${rShape}  -> pass filters: ${ok}`);
if (shapes.length) {
  const big = shapes.slice().sort((a, b) => b.area - a.area).slice(0, 6);
  console.log("  largest components (full-res radius): " +
    big.map((s) => `r=${s.r.toFixed(1)} fill=${s.fill.toFixed(2)}`).join(" | "));
}

const dets = HD.detectHoles(gray, W, H, {
  maxWork,
  minAreaFrac: parseFloat(opt.minAreaFrac),
  minFill, maxFill, minAspect, maxAspect, rejectBorder,
});
console.log(`  >>> detectHoles found ${dets.length} holes`);
if (dets.length) {
  const rs = dets.map((d) => d.r).sort((a, b) => a - b);
  console.log(`      radius: min ${rs[0].toFixed(1)}  median ` +
    `${rs[rs.length >> 1].toFixed(1)}  max ${rs[rs.length - 1].toFixed(1)} px`);
  if (dets.length <= 12) {
    dets.forEach((d, i) => console.log(`      ${i + 1}: (${d.cx.toFixed(0)}, ` +
      `${d.cy.toFixed(0)}) r=${d.r.toFixed(1)} fill=${d.fill.toFixed(2)} mean=${d.mean.toFixed(1)}`));
  }
}
if (opt.json) require("fs").writeFileSync(opt.json, JSON.stringify(dets));
