/* =====================================================================
 * detect.js — automatic grid-hole detection for cryo-EM images.
 *
 * Pure computation over a Float32Array grayscale buffer: no DOM, no
 * canvas, no third-party library. The same file runs in the browser
 * (<script src="detect.js"> exposes window.HoleDetect) and in Node
 * (require("./detect.js")), so tests/ verifies the shipped code itself.
 *
 * Pipeline
 *   1. box downsample to <= 512 px (keeps it fast and noise-tolerant)
 *   2. separable binomial blur, twice (smooths film texture)
 *   3. Otsu threshold -> bright regions
 *   4. 8-connected component labelling
 *   5. circle filters: area, bbox fill ratio (~pi/4), aspect ratio,
 *      border rejection, lattice size consistency
 *   6. per-circle mean intensity at full precision (original samples)
 * ===================================================================== */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HoleDetect = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var MAX_WORK = 512;

  /* ---------------------------------------------------------------- */
  /* Primitives                                                       */
  /* ---------------------------------------------------------------- */

  /** Box-average downsample of `gray` (W x H) into a w x h Float32Array. */
  function boxDownsample(gray, W, H, w, h) {
    if (w === W && h === H) return Float32Array.from(gray);
    var out = new Float32Array(w * h);
    for (var y = 0; y < h; y++) {
      var sy0 = Math.floor((y * H) / h);
      var sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * H) / h));
      if (sy1 > H) sy1 = H;
      for (var x = 0; x < w; x++) {
        var sx0 = Math.floor((x * W) / w);
        var sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * W) / w));
        if (sx1 > W) sx1 = W;
        var s = 0, n = 0;
        for (var sy = sy0; sy < sy1; sy++) {
          var row = sy * W;
          for (var sx = sx0; sx < sx1; sx++) { s += gray[row + sx]; n++; }
        }
        out[y * w + x] = n ? s / n : 0;
      }
    }
    return out;
  }

  /** In-place separable binomial (1 4 6 4 1)/16 blur. */
  function blurBinomial(vals, w, h) {
    var tmp = new Float32Array(vals.length);
    var x, y, row;
    for (y = 0; y < h; y++) {
      row = y * w;
      for (x = 0; x < w; x++) {
        var a = x - 2 < 0 ? 0 : x - 2;
        var b = x - 1 < 0 ? 0 : x - 1;
        var c = x + 1 >= w ? w - 1 : x + 1;
        var d = x + 2 >= w ? w - 1 : x + 2;
        tmp[row + x] = (vals[row + a] + 4 * vals[row + b] + 6 * vals[row + x] +
                        4 * vals[row + c] + vals[row + d]) / 16;
      }
    }
    for (y = 0; y < h; y++) {
      var y0 = y - 2 < 0 ? 0 : y - 2;
      var y1 = y - 1 < 0 ? 0 : y - 1;
      var y3 = y + 1 >= h ? h - 1 : y + 1;
      var y4 = y + 2 >= h ? h - 1 : y + 2;
      var r0 = y0 * w, r1 = y1 * w, r2 = y * w, r3 = y3 * w, r4 = y4 * w;
      for (x = 0; x < w; x++) {
        vals[r2 + x] = (tmp[r0 + x] + 4 * tmp[r1 + x] + 6 * tmp[r2 + x] +
                        4 * tmp[r3 + x] + tmp[r4 + x]) / 16;
      }
    }
  }

  /** Otsu threshold over the values, returned in the original units. */
  function otsu(values, n) {
    var mn = Infinity, mx = -Infinity, i;
    for (i = 0; i < n; i++) {
      var v = values[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (!(mx > mn)) return mn;
    var BINS = 256;
    var hist = new Float64Array(BINS);
    var s = BINS / (mx - mn);
    for (i = 0; i < n; i++) {
      var b = ((values[i] - mn) * s) | 0;
      if (b < 0) b = 0; else if (b > BINS - 1) b = BINS - 1;
      hist[b]++;
    }
    var total = n, sum = 0;
    for (b = 0; b < BINS; b++) sum += b * hist[b];
    var sumB = 0, wB = 0, best = 0, bestVar = -1;
    for (b = 0; b < BINS; b++) {
      wB += hist[b];
      if (wB === 0) continue;
      var wF = total - wB;
      if (wF === 0) break;
      sumB += b * hist[b];
      var mB = sumB / wB;
      var mF = (sum - sumB) / wF;
      var v2 = wB * wF * (mB - mF) * (mB - mF);
      if (v2 > bestVar) { bestVar = v2; best = b; }
    }
    return mn + ((best + 0.5) / BINS) * (mx - mn);
  }

  /** 8-connected components of `values > thr`. Returns labels + count. */
  function labelComponents(values, w, h, thr) {
    var n = w * h;
    var labels = new Int32Array(n);
    var stack = new Int32Array(n);
    var count = 0;
    for (var i = 0; i < n; i++) {
      if (labels[i] || !(values[i] > thr)) continue;
      count++;
      var sp = 0;
      stack[sp++] = i;
      labels[i] = count;
      while (sp > 0) {
        var p = stack[--sp];
        var x = p % w;
        var y = (p - x) / w;
        for (var dy = -1; dy <= 1; dy++) {
          var ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          var nrow = ny * w;
          for (var dx = -1; dx <= 1; dx++) {
            var nx = x + dx;
            if (nx < 0 || nx >= w) continue;
            var q = nrow + nx;
            if (!labels[q] && values[q] > thr) { labels[q] = count; stack[sp++] = q; }
          }
        }
      }
    }
    return { labels: labels, count: count };
  }

  function measureComponents(labels, count, w, h) {
    var area = new Int32Array(count + 1);
    var minX = new Int32Array(count + 1);
    var maxX = new Int32Array(count + 1);
    var minY = new Int32Array(count + 1);
    var maxY = new Int32Array(count + 1);
    for (var L = 0; L <= count; L++) { minX[L] = w; maxX[L] = -1; minY[L] = h; maxY[L] = -1; }
    for (var i = 0; i < labels.length; i++) {
      var L2 = labels[i];
      if (!L2) continue;
      var x = i % w;
      var y = (i - x) / w;
      area[L2]++;
      if (x < minX[L2]) minX[L2] = x;
      if (x > maxX[L2]) maxX[L2] = x;
      if (y < minY[L2]) minY[L2] = y;
      if (y > maxY[L2]) maxY[L2] = y;
    }
    return { area: area, minX: minX, maxX: maxX, minY: minY, maxY: maxY };
  }

  /** Mean intensity inside a circular mask, from the full-precision data. */
  function roiMeanIn(gray, width, height, cx, cy, r) {
    var r2 = r * r;
    var x0 = Math.max(0, Math.ceil(cx - r));
    var x1 = Math.min(width - 1, Math.floor(cx + r));
    var y0 = Math.max(0, Math.ceil(cy - r));
    var y1 = Math.min(height - 1, Math.floor(cy + r));
    if (x0 > x1 || y0 > y1) return NaN;
    var sum = 0, n = 0;
    for (var y = y0; y <= y1; y++) {
      var dy = y - cy;
      var dy2 = dy * dy;
      var row = y * width;
      for (var x = x0; x <= x1; x++) {
        var dx = x - cx;
        if (dx * dx + dy2 <= r2) { sum += gray[row + x]; n++; }
      }
    }
    return n ? sum / n : NaN;
  }

  /* ---------------------------------------------------------------- */
  /* Detection                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Find bright circular holes.
   *
   * @param {Float32Array} gray  grayscale samples, row-major
   * @param {number} width
   * @param {number} height
   * @param {object} [opts] tuning (defaults are tuned for holey-carbon grids)
   * @returns {Array<{cx,cy,r,mean,fill,aspect}>} full-resolution circles,
   *          sorted top-to-bottom then left-to-right
   */
  function detectHoles(gray, width, height, opts) {
    opts = opts || {};
    var maxWork = opts.maxWork || MAX_WORK;
    var maxDim = Math.max(width, height);
    var factor = maxDim > maxWork ? maxWork / maxDim : 1;
    var w = Math.max(1, Math.round(width * factor));
    var h = Math.max(1, Math.round(height * factor));

    var work = boxDownsample(gray, width, height, w, h);
    blurBinomial(work, w, h);
    blurBinomial(work, w, h);

    var thr = otsu(work, w * h);
    var lab = labelComponents(work, w, h, thr);
    var m = measureComponents(lab.labels, lab.count, w, h);

    var nArea = w * h;
    var minArea = opts.minAreaFrac === undefined ? 0.004 * nArea : opts.minAreaFrac * nArea;
    var maxArea = opts.maxAreaFrac === undefined ? 0.25 * nArea : opts.maxAreaFrac * nArea;
    var minFill = opts.minFill === undefined ? 0.55 : opts.minFill;
    var maxFill = opts.maxFill === undefined ? 0.92 : opts.maxFill;
    var minAspect = opts.minAspect === undefined ? 0.65 : opts.minAspect;
    var maxAspect = opts.maxAspect === undefined ? 1.55 : opts.maxAspect;
    if (minArea < 9) minArea = 9;

    var out = [];
    for (var L = 1; L <= lab.count; L++) {
      var area = m.area[L];
      if (area < minArea || area > maxArea) continue;
      var x0 = m.minX[L], x1 = m.maxX[L], y0 = m.minY[L], y1 = m.maxY[L];
      // a hole running off the frame is clipped: its centroid is unreliable
      if (opts.rejectBorder === false ? false : (x0 <= 0 || y0 <= 0 || x1 >= w - 1 || y1 >= h - 1)) continue;
      var bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      var fill = area / (bw * bh);           // ~pi/4 = 0.785 for a filled circle
      var aspect = bw / bh;
      if (fill < minFill || fill > maxFill || aspect < minAspect || aspect > maxAspect) continue;
      out.push({
        cx: ((x0 + x1) / 2 + 0.5) / factor,
        cy: ((y0 + y1) / 2 + 0.5) / factor,
        r: Math.sqrt(area / Math.PI) / factor,
        fill: fill,
        aspect: aspect,
      });
    }

    // Regular grids have a consistent hole size: drop size outliers.
    if (out.length >= 5) {
      var rs = out.map(function (d) { return d.r; }).sort(function (a, b) { return a - b; });
      var med = rs[rs.length >> 1];
      if (med > 0) {
        var kept = out.filter(function (d) { return d.r >= 0.5 * med && d.r <= 2 * med; });
        if (kept.length >= 3 && kept.length < out.length) out = kept;
      }
    }

    // Measure each hole on the original, full-precision samples
    for (var i = 0; i < out.length; i++) {
      out[i].mean = roiMeanIn(gray, width, height, out[i].cx, out[i].cy, out[i].r);
    }
    out.sort(function (a, b) { return (a.cy - b.cy) || (a.cx - b.cx); });
    return out;
  }


  return {
    detectHoles: detectHoles,
    roiMeanIn: roiMeanIn,
    boxDownsample: boxDownsample,
    blurBinomial: blurBinomial,
    otsu: otsu,
    labelComponents: labelComponents,
  };
});
