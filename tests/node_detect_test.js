/* Node verification of the SHIPPED hole-detection module (webapp/detect.js)
 * plus the vendored TIFF decoder — i.e. exactly what the browser runs.
 *
 *   node tests/node_detect_test.js
 *
 * Cases:
 *   1. synthetic lattice with known circles + decoys  -> exact count match
 *   2. the real test-image/3-ice.png (as an 8-bit TIFF) -> matches the
 *      NumPy reference prototype (tests/prototype_detect.py)
 */
"use strict";

const fs = require("fs");
const path = require("path");
const UTIF = require("../webapp/vendor/utif.js");
const HD = require("../webapp/detect.js");

/* TIFF decoding — mirrors webapp/app.js decodeTiff() */
function loadGray(filePath) {
  const buf = fs.readFileSync(filePath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const ifds = UTIF.decode(ab);
  const ifd = ifds[0];
  UTIF.decodeImage(ab, ifd);
  const w = ifd.width, h = ifd.height;
  const data = ifd.data;
  const bpsTag = ifd["t258"];
  const bps = Math.min(32, bpsTag ? bpsTag[0] : 8);
  const smpls = ifd["t277"] ? ifd["t277"][0] : (bpsTag ? bpsTag.length : 1);
  const intp = ifd["t262"] ? ifd["t262"][0] : 2;
  const area = w * h;
  const gray = new Float32Array(area);
  const whiteIsZero = intp === 0;
  if (bps <= 8 || bps === 24) {
    for (let i = 0; i < area; i++) {
      let s = 0;
      for (let c = 0; c < smpls; c++) s += data[i * smpls + c];
      gray[i] = s / smpls;
      if (whiteIsZero) gray[i] = 255 - gray[i];
    }
  } else if (bps === 16) {
    for (let i = 0; i < area; i++) {
      let s = 0;
      for (let c = 0; c < smpls; c++) {
        const o = (i * smpls + c) * 2;
        s += data[o] | (data[o + 1] << 8);
      }
      gray[i] = s / smpls;
      if (whiteIsZero) gray[i] = 65535 - gray[i];
    }
  } else {
    throw new Error("unexpected bit depth " + bps);
  }
  return { gray, w, h };
}

const truth = JSON.parse(fs.readFileSync(path.join(__dirname, "detect_truth.json"), "utf8"));
let failures = 0;

function matchAll(dets, expected, centerTol, radiusTolFrac) {
  // every expected hole must be found by exactly one detection
  let ok = true;
  expected.forEach(([ex, ey, er], i) => {
    let best = null, bestD = Infinity;
    dets.forEach((d) => {
      const dist = Math.hypot(d.cx - ex, d.cy - ey);
      if (dist < bestD) { bestD = dist; best = d; }
    });
    if (!best || bestD > centerTol) {
      ok = false;
      console.log(`  FAIL hole ${i + 1} @(${ex},${ey}): nearest detection ` +
        (best ? `${bestD.toFixed(1)} px away (tol ${centerTol})` : "none"));
      return;
    }
    const relR = Math.abs(best.r - er) / er;
    if (relR > radiusTolFrac) {
      ok = false;
      console.log(`  FAIL hole ${i + 1}: radius ${best.r.toFixed(1)} vs ${er} ` +
        `(${(relR * 100).toFixed(1)}% off, tol ${(radiusTolFrac * 100).toFixed(0)}%)`);
    }
  });
  return ok;
}

/* ---------------- case 1: synthetic lattice ---------------- */
{
  const { gray, w, h } = loadGray(path.join(__dirname, "synth_holes.tif"));
  const t0 = Date.now();
  const dets = HD.detectHoles(gray, w, h);
  const ms = Date.now() - t0;
  const exp = truth["synth_holes.tif"];
  console.log(`synthetic ${w}x${h}: detected ${dets.length} (expected ${exp.holes.length}) in ${ms} ms`);
  dets.forEach((d) => console.log(`  (${d.cx.toFixed(1)}, ${d.cy.toFixed(1)}) r=${d.r.toFixed(1)} fill=${d.fill.toFixed(3)}`));
  let ok = dets.length === exp.holes.length;
  if (!ok) console.log(`  FAIL count: ${dets.length} != ${exp.holes.length}`);
  if (!matchAll(dets, exp.holes, 8, 0.10)) ok = false;
  console.log(ok ? "PASS synthetic lattice (exact count, centers, radii)" : "FAIL synthetic lattice");
  if (!ok) failures++;
}

/* ---------------- case 2: the real grid image ---------------- */
{
  const { gray, w, h } = loadGray(path.join(__dirname, "real_3ice.tif"));
  const t0 = Date.now();
  const dets = HD.detectHoles(gray, w, h);
  const ms = Date.now() - t0;
  const exp = truth["real_3ice.tif"];
  console.log(`\nreal 3-ice ${w}x${h}: detected ${dets.length} (expected ${exp.holes.length}) in ${ms} ms`);
  dets.forEach((d) => console.log(`  (${d.cx.toFixed(1)}, ${d.cy.toFixed(1)}) r=${d.r.toFixed(1)} fill=${d.fill.toFixed(3)} mean=${d.mean.toFixed(1)}`));
  let ok = dets.length === exp.holes.length;
  if (!ok) console.log(`  FAIL count: ${dets.length} != ${exp.holes.length}`);
  if (!matchAll(dets, exp.holes, 15, 0.08)) ok = false;
  // brightness ordering: the near-vacuum hole must be the brightest -> I0 candidate
  const brightest = dets.reduce((a, b) => (b.mean > a.mean ? b : a));
  const centerHole = exp.holes.find(([x, y]) => Math.hypot(x - 1006, y - 1008) < 15);
  if (centerHole) {
    const isCenter = Math.hypot(brightest.cx - centerHole[0], brightest.cy - centerHole[1]) < 15;
    console.log(`  brightest detection is the central (thin-ice) hole: ${isCenter}`);
    if (!isCenter) ok = false;
  }
  console.log(ok ? "PASS real grid image (matches NumPy reference prototype)" : "FAIL real grid image");
  if (!ok) failures++;
}

console.log(failures === 0 ? "\nALL DETECTION CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
