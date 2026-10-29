/* Shared TIFF -> grayscale loader for the Node test/diagnostic scripts.
 * Mirrors the decode path in webapp/app.js. */
"use strict";

const fs = require("fs");
const path = require("path");
const UTIF = require("../webapp/vendor/utif.js");

function loadGray(filePath) {
  const buf = fs.readFileSync(filePath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const ifds = UTIF.decode(ab);
  if (!ifds || !ifds.length) throw new Error("no IFD: " + filePath);
  const ifd = ifds[0];
  UTIF.decodeImage(ab, ifd);
  const w = ifd.width, h = ifd.height;
  if (!w || !h) throw new Error("no dimensions: " + filePath);
  const data = ifd.data;
  if (!data || data.length < w * h) throw new Error("no pixel data: " + filePath);

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
    throw new Error("unsupported bit depth " + bps);
  }
  return { gray, w, h };
}

module.exports = { loadGray, path };
