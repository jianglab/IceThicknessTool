/* Node verification of the web app's TIFF decoding + ROI math.
 *
 * Loads the *vendored* UTIF.js and pako exactly as the browser would,
 * decodes the synthetic TIFFs from tests/, runs the same roiMean /
 * thickness code as webapp/app.js, and compares against the Python
 * ground truth in tests/ref_means.json.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const UTIF = require("../webapp/vendor/utif.js");
const HD = require("../webapp/detect.js");   // shipped module: same math as the browser

// --- ROI mean comes from the shipped detect.js (no duplicated copy) -----

function loadTiffGray(filePath) {
  const buf = fs.readFileSync(filePath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const ifds = UTIF.decode(ab);
  if (!ifds || !ifds.length) throw new Error("no IFD: " + filePath);
  const ifd = ifds[0];
  UTIF.decodeImage(ab, ifd);
  const w = ifd.width;
  const h = ifd.height;
  if (!w || !h) throw new Error("no dimensions: " + filePath);
  const data = ifd.data;
  if (!data || data.length < w * h) throw new Error("no pixel data: " + filePath);

  const bpsTag = ifd["t258"];
  const bps = Math.min(32, bpsTag ? bpsTag[0] : 8);
  const smpls = ifd["t277"] ? ifd["t277"][0] : (bpsTag ? bpsTag.length : 1);
  const sfmt = ifd["t339"] ? ifd["t339"][0] : null;
  const intp = ifd["t262"] ? ifd["t262"][0] : 2;
  const area = w * h;
  const gray = new Float32Array(area);

  if (intp === 3) {
    const rgba = UTIF.toRGBA8(ifd);
    for (let i = 0; i < area; i++) {
      gray[i] = 0.299 * rgba[4 * i] + 0.587 * rgba[4 * i + 1] + 0.114 * rgba[4 * i + 2];
    }
    return { gray, w, h };
  }

  const whiteIsZero = intp === 0;
  const n = smpls;

  if (bps <= 8 || bps === 24) {
    for (let i = 0; i < area; i++) {
      let s = 0;
      for (let c = 0; c < n; c++) s += data[i * n + c];
      gray[i] = s / n;
      if (whiteIsZero) gray[i] = 255 - gray[i];
    }
  } else if (bps === 16) {
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
    throw new Error("unsupported bit depth: " + bps);
  }
  return { gray, w, h };
}

function roiMean(gray, w, h, cx, cy, r) {
  return HD.roiMeanIn(gray, w, h, cx, cy, r);
}

// --- run ---------------------------------------------------------------

const ref = JSON.parse(fs.readFileSync(path.join(__dirname, "ref_means.json"), "utf8"));
const ROIS = [[60, 80, 20], [150, 140, 35], [200, 60, 15]];
const LAM = 350;
const TOL = 1e-5; // relative tolerance (different summation order)

let failures = 0;
for (const [name, expected] of Object.entries(ref)) {
  const { gray, w, h } = loadTiffGray(path.join(__dirname, name));
  if (w !== 256 || h !== 256) {
    console.log(`FAIL ${name}: wrong size ${w}x${h}`);
    failures++;
    continue;
  }
  const means = ROIS.map(([cx, cy, r]) => roiMean(gray, w, h, cx, cy, r));
  let ok = true;
  means.forEach((m, i) => {
    const e = expected.means[i];
    const rel = Math.abs(m - e) / Math.max(1, Math.abs(e));
    if (rel > TOL) { ok = false; console.log(`FAIL ${name} ROI${i + 1}: js=${m} py=${e}`); }
  });
  // thickness from ROI 0 as reference
  const I0 = means[0];
  const th = means.map((m, i) => (i === 0 ? null : LAM * Math.log(I0 / m)));
  th.forEach((t, i) => {
    const e = expected.thickness[i];
    if (e === null || t === null) return;
    const rel = Math.abs(t - e) / Math.max(1, Math.abs(e));
    if (rel > TOL) { ok = false; console.log(`FAIL ${name} thickness${i + 1}: js=${t} py=${e}`); }
  });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: means=[${means.map((v) => v.toFixed(3)).join(", ")}]`);
  if (!ok) failures++;
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
