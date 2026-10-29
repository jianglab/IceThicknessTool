/* Integration smoke test for webapp/app.js without a browser.
 *
 * A minimal DOM stub is built from the REAL ids in webapp/index.html, then
 * app.js is executed in a vm context and driven through the full workflow:
 *
 *   load TIFF -> detect holes -> accept ROIs -> add a 2nd image
 *   -> per-image ROI isolation -> lambda/voltage change -> CSV export
 *
 * This catches wiring/logic errors (missing element, bad state flow) that
 * syntax checks cannot. Canvas drawing is stubbed: pixels are not verified.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const WEB = path.join(__dirname, "..", "webapp");
const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("  PASS " + name);
  } else {
    failures++;
    console.log("  FAIL " + name + (detail ? " — " + detail : ""));
  }
}

/* ---------------------------------------------------------------- */
/* DOM stub                                                         */
/* ---------------------------------------------------------------- */

function makeClassList() {
  const set = new Set();
  return {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    contains: (c) => set.has(c),
    toggle: (c, force) => {
      const on = force === undefined ? !set.has(c) : !!force;
      if (on) set.add(c); else set.delete(c);
      return on;
    },
  };
}

function ctxStub() {
  return new Proxy({}, {
    get: (t, p) => (p in t ? t[p] : () => {}),
    set: (t, p, v) => { t[p] = v; return true; },
  });
}

function makeEl(tag, id) {
  const el = {
    tagName: (tag || "div").toUpperCase(),
    id: id || "",
    className: "",
    classList: makeClassList(),
    style: {},
    children: [],
    handlers: {},
    textContent: "",
    title: "",
    value: "",
    href: "",
    download: "",
    disabled: false,
    checked: false,
    clientWidth: 800,
    clientHeight: 600,
    width: 0,
    height: 0,
    addEventListener(type, fn) {
      (this.handlers[type] = this.handlers[type] || []).push(fn);
    },
    dispatch(type, ev) {
      (this.handlers[type] || []).forEach((fn) => fn(ev || {}));
    },
    appendChild(child) { this.children.push(child); return child; },
    append(...nodes) { nodes.forEach((n) => this.children.push(n)); },
    remove() {},
    click() { this.dispatch("click"); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; },
    getContext() { return (this._ctx = this._ctx || ctxStub()); },
    get innerHTML() { return this._html || ""; },
    set innerHTML(v) { this._html = v; this.children = []; },
  };
  return el;
}

const ids = [...html.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
const registry = {};
ids.forEach((id) => { registry[id] = makeEl("div", id); });

const radio300 = makeEl("input");
radio300.value = "300";
radio300.checked = true;
const radio200 = makeEl("input");
radio200.value = "200";

const createdBlobs = [];

class BlobStub {
  constructor(parts, opts) {
    this.parts = parts;
    this.type = opts && opts.type;
    this.text = parts.join("");
    createdBlobs.push(this);
  }
}
class ImageDataStub {
  constructor(data, w, h) { this.data = data; this.width = w; this.height = h; }
}

const documentStub = {
  body: makeEl("body"),
  getElementById: (id) => registry[id] || null,
  createElement: (tag) => makeEl(tag),
  querySelectorAll: (sel) => (sel.indexOf("voltage") >= 0 ? [radio300, radio200] : []),
  addEventListener: () => {},
};

const windowStub = {
  devicePixelRatio: 1,
  addEventListener: () => {},
  HoleDetect: require(path.join(WEB, "detect.js")),
};

const sandbox = {
  console,
  document: documentStub,
  window: windowStub,
  self: windowStub,
  UTIF: require(path.join(WEB, "vendor", "utif.js")),
  HoleDetect: windowStub.HoleDetect,
  ImageData: ImageDataStub,
  Blob: BlobStub,
  URL: { createObjectURL: () => "blob:stub", revokeObjectURL: () => {} },
  performance: { now: () => Date.now() },
  requestAnimationFrame: (fn) => { fn(); return 1; },
  setTimeout: (fn) => { fn(); return 1; },
  Math, JSON, Array, Object, Number, String, Boolean, Error, Promise,
  Float32Array, Float64Array, Int32Array, Uint32Array,
  Uint8Array, Uint8ClampedArray, Set, Map, Infinity, NaN, isFinite, parseFloat,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

/* ---------------------------------------------------------------- */
/* Run app.js and drive the workflow                                */
/* ---------------------------------------------------------------- */

const appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");

(async function () {
  console.log("Loading app.js in stub DOM (" + ids.length + " ids from index.html)");
  vm.runInContext(appCode, sandbox, { filename: "app.js" });
  check("app.js boots without throwing", true);

  const run = (code) => vm.runInContext(code, sandbox);

  const fileFor = (name) => ({
    name,
    arrayBuffer: async () => {
      const b = fs.readFileSync(path.join(__dirname, name));
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
  });

  // ROIs are drawn by hand on the canvas; the stub cannot drag, so the same
  // state changes are applied directly (the drawing path is exercised in the
  // browser, and roiMeanIn is the shipped function either way).
  const addRois = (count, r) => {
    run("(function(){var R=" + r + ";var c=" + count + ";" +
      "for(var i=0;i<c;i++){" +
      "var cx=Math.round(state.width*(0.15+0.10*i));" +
      "var cy=Math.round(state.height*(i%2?0.62:0.38));" +
      "state.rois.push({cx:cx,cy:cy,r:R,mean:HD.roiMeanIn(state.gray,state.width,state.height,cx,cy,R)});}" +
      "if(state.i0===null&&state.rois.length)state.i0=0;recompute();})()");
  };

  // ---- load image 1 (the real grid image) ----
  await run("addFiles")([fileFor("real_3ice.tif")]);
  check("image 1 loaded", run("state.images.length") === 1, "got " + run("state.images.length"));
  check("active image is 2048x2048",
    run("state.width") === 2048 && run("state.height") === 2048);
  check("thumbnail rail has 1 entry",
    registry.thumbList.children.length === 1);
  check("clipping is detected on load (> 1%)", run("activeRec().clippedFrac") > 0.01,
    String(run("activeRec().clippedFrac")));
  check("clipping warning is visible",
    registry.clipWarning.textContent.indexOf("clipped") >= 0 &&
    !registry.clipWarning.classList.contains("hidden"),
    registry.clipWarning.textContent);

  // ---- draw 5 ROIs by hand ----
  addRois(5, 60);
  check("5 ROIs created", run("state.rois.length") === 5, "got " + run("state.rois.length"));
  check("I0 set to the first ROI", run("state.i0") === 0);
  const th1 = JSON.parse(run("JSON.stringify(state.thicknesses)"));
  check("4 thickness values computed", th1.filter((t) => t !== null).length === 4);
  check("all thicknesses finite", th1.filter((t) => t !== null).every((t) => isFinite(t)),
    JSON.stringify(th1));
  check("no detection UI remains in the page",
    !("detectBtn" in registry) && !("lowMagToggle" in registry) &&
    !("ratioSlider" in registry) && !("detectStatus" in registry));

  // ---- load image 2: ROIs must stay independent ----
  await run("addFiles")([fileFor("synth_holes.tif")]);
  check("2 images in the library", run("state.images.length") === 2);
  check("new image is active and has no ROIs", run("state.rois.length") === 0);
  check("image 1 kept its 5 ROIs", run("state.images[0].rois.length") === 5);
  check("thumbnail rail has 2 entries", registry.thumbList.children.length === 2);

  addRois(7, 80);
  check("7 ROIs created on image 2", run("state.rois.length") === 7, "got " + run("state.rois.length"));
  check("image 1 still has 5 ROIs", run("state.images[0].rois.length") === 5);

  // ---- switch back to image 1 ----
  run("setActive(state.images[0].id)");
  check("switching restores image 1 ROIs", run("state.rois.length") === 5);
  check("switching restores image 1 I0", run("state.i0") === 0);
  check("roi scope label names the image",
    registry.roiScope.textContent.indexOf("real_3ice.tif") >= 0,
    registry.roiScope.textContent);

  // ---- manually change the reference ----
  const before = JSON.parse(run("JSON.stringify(state.thicknesses)"));
  run("setI0(2)");
  const after = JSON.parse(run("JSON.stringify(state.thicknesses)"));
  check("changing I0 recomputes thicknesses",
    JSON.stringify(before) !== JSON.stringify(after));
  check("I0 slot itself has no thickness", after[2] === null);
  run("setI0(0)");

  // ---- voltage switch scales lambda globally (350 -> 300) ----
  const t350 = JSON.parse(run("JSON.stringify(state.thicknesses)"))[1];
  radio300.checked = false;
  radio200.checked = true;
  radio200.dispatch("change", {});
  const t300 = JSON.parse(run("JSON.stringify(state.thicknesses)"))[1];
  const ratio = t300 / t350;
  check("200 kV rescales thickness by 300/350",
    Math.abs(ratio - 300 / 350) < 1e-9, "ratio " + ratio);
  radio200.checked = false;
  radio300.checked = true;
  radio300.dispatch("change", {});

  // ---- CSV export covers both images ----
  registry.exportBtn.dispatch("click", {});
  check("a CSV blob was produced", createdBlobs.length === 1);
  const csv = createdBlobs[0] ? createdBlobs[0].text : "";
  const SUMMARY_HEADER = "image,measured ROIs,average thickness (nm)";
  const blocks = csv.split(SUMMARY_HEADER);
  const lines = blocks[0].split("\r\n");
  const dataRows = lines.filter((l) => /^(real_3ice|synth_holes)\.tif,/.test(l));
  check("CSV has 12 data rows (5 + 7)", dataRows.length === 12, "got " + dataRows.length);
  check("CSV header has an image column", lines[0].indexOf("image,ROI index") === 0, lines[0]);
  check("CSV rows carry the file name", dataRows[0].indexOf("real_3ice.tif") === 0);
  check("CSV has a per-image summary block", blocks.length === 2);
  check("CSV summary lists both images",
    /real_3ice\.tif,4,/.test(blocks[1]) && /synth_holes\.tif,6,/.test(blocks[1]),
    (blocks[1] || "").trim());
  check("export status reports both images",
    registry.exportStatus.textContent.indexOf("2 image") >= 0,
    registry.exportStatus.textContent);

  // ---- removing images ----
  run("removeImage(state.images[0].id)");
  check("removing an image leaves 1", run("state.images.length") === 1);
  check("the remaining image keeps its ROIs", run("state.rois.length") === 7,
    "got " + run("state.rois.length"));
  run("removeImage(state.images[0].id)");
  check("removing every image resets the workspace",
    run("state.images.length") === 0 && run("state.gray") === null);
  check("empty-state hint is visible", !registry.thumbsEmpty.classList.contains("hidden"));
  check("clipping warning cleared with no image",
    registry.clipWarning.classList.contains("hidden"));

  console.log(failures === 0 ? "\nALL APP SMOKE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("SMOKE TEST THREW:", err && err.stack ? err.stack : err);
  process.exit(1);
});
