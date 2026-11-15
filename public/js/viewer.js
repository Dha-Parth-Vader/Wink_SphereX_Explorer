(function () {
  "use strict";

  const G = SkyData.geometry;
  const $ = (id) => document.getElementById(id);

  // R20: never more than 3 frame swaps per second, whatever the URL or the keyboard asks for
  const MAX_SWAPS_PER_S = 3;
  const MIN_SWAP_MS = 1000 / MAX_SWAPS_PER_S;
  const SR_PER_PX = (6.15 / 206264.806) ** 2;
  const MARKS_KEY = "wink.marks";

  const FOV_OPTIONS = [
    { deg: 2 / 60, label: "2′ (zoom)" },
    { deg: 5 / 60, label: "5′" },
    { deg: 10 / 60, label: "10′" },
    { deg: 15 / 60, label: "15′" },
    { deg: 30 / 60, label: "30′" },
    { deg: 1, label: "1°" },
  ];

  // 2026.0 positions and Gaia/CatWISE proper motions (mas/yr) from pipeline/out/targets.json
  const TARGETS = [
    { id: "barnard", name: "Barnard's Star", ra: 269.446268, dec: 4.768204, pmra: -801.55, pmdec: 10362.39, fov: 15 / 60, tag: "moves" },
    { id: "epsindib", name: "Epsilon Indi B", ra: 331.09665, dec: -56.800664, pmra: 3981.98, pmdec: -2466.83, fov: 10 / 60, tag: "moves" },
    { id: "wise0855", name: "WISE 0855-0714", ra: 133.75947, dec: -7.242557, pmra: -7919.9, pmdec: 493.9, fov: 10 / 60, tag: "moves", det: "6" },
    { id: "rwaur", name: "RW Aurigae", ra: 76.95609, dec: 30.401128, pmra: 2.64, pmdec: -27.4, fov: 10 / 60, tag: "varies" },
    { id: "rdra", name: "R Draconis", ra: 248.167233, dec: 66.755024, pmra: -20.64, pmdec: 6.15, fov: 10 / 60, tag: "varies" },
  ];

  const LAYER_ORDER = ["gaia", "wise", "tmass"];
  const LAYER_NAMES = { gaia: "Gaia DR3", wise: "CatWISE2020", tmass: "2MASS" };
  const LAYER_EPOCH = { gaia: 2016.0, wise: 2015.4, tmass: 1999.0 };
  // 2MASS bands: centre wavelength (µm) and zero-magnitude flux (Jy), Cohen et al. 2003
  const TMASS_BANDS = [
    { key: "j", name: "J", um: 1.235, zp: 1594 },
    { key: "h", name: "H", um: 1.662, zp: 1024 },
    { key: "k", name: "Ks", um: 2.159, zp: 666.7 },
  ];

  const MODE_HINTS = {
    each: "Blink through the dates. Something that jumps is moving; something that pulses is changing brightness.",
    add: "All dates added together: faint things show up better, and movers smear into a short streak.",
    sub: "Blue = was here, red = is here now. A mover leaves a blue and red pair; a changing star leaves one blob.",
  };

  const S = {
    ra: null, dec: null, fov: 10 / 60, name: "", det: "all", mode: "each", ref: "first",
    flags: false, gaia: true, wise: true, tmass: true, track: true, community: true, embed: false, speed: 2,
    communityMarks: [], communityState: "loading",
    layers: ["gaia", "wise"], passthrough: {},
    res: null, frames: [], i: 0, pix: new Map(),
    playing: false, playTimer: null, lastSwap: -Infinity, wantFrame: 0, swapTimer: null,
    measure: null, hover: null, target: null,
    marking: false, pendingMark: null, marks: [],
    selectedPred: null, circleAll: false,
    adj: { bright: 0, contrast: 1, invert: false, cross: false },
    chartTable: false,
    token: 0, controller: null, ticker: null, loadStarted: 0,
  };

  // ---- small helpers ----

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function pad(n, w) { return String(n).padStart(w, "0"); }
  function el(tag, attrs, text) {
    const e = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") e.className = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v);
    }
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function storageGet(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
  }
  function storageSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode or full */ }
  }

  function parseRA(text) {
    const s = String(text || "").trim();
    if (!s) return NaN;
    if (/^[+]?\d+(\.\d+)?\s*(°|d|deg)?$/i.test(s)) return parseFloat(s);
    if (/^\d+(\.\d+)?\s*h$/i.test(s)) return parseFloat(s) * 15;
    const parts = s.replace(/[hms:'"′″]/gi, " ").trim().split(/\s+/).map(Number);
    if (parts.length < 2 || parts.length > 3 || parts.some((p) => !isFinite(p))) return NaN;
    const [h, m, sec = 0] = parts;
    if (h >= 24 || m >= 60 || sec >= 60) return NaN;
    return (h + m / 60 + sec / 3600) * 15;
  }

  function parseDec(text) {
    const s = String(text || "").trim().replace(/−/g, "-");
    if (!s) return NaN;
    if (/^[+-]?\d+(\.\d+)?\s*(°|d|deg)?$/i.test(s)) return parseFloat(s);
    const neg = s.startsWith("-");
    const parts = s.replace(/^[+-]/, "").replace(/[d°m:'"′″s]/gi, " ").trim().split(/\s+/).map(Number);
    if (parts.length < 2 || parts.length > 3 || parts.some((p) => !isFinite(p))) return NaN;
    const [d, m, sec = 0] = parts;
    if (m >= 60 || sec >= 60) return NaN;
    const v = d + m / 60 + sec / 3600;
    return neg ? -v : v;
  }

  function fmtRA(deg) {
    let t = (((deg % 360) + 360) % 360) / 15;
    let h = Math.floor(t), m = Math.floor((t - h) * 60), s = ((t - h) * 60 - m) * 60;
    if (s >= 59.995) { s = 0; m += 1; }
    if (m >= 60) { m = 0; h = (h + 1) % 24; }
    return pad(h, 2) + "h" + pad(m, 2) + "m" + s.toFixed(2).padStart(5, "0") + "s";
  }

  function fmtDec(deg) {
    const sign = deg < 0 ? "−" : "+";
    const a = Math.abs(deg);
    let d = Math.floor(a), m = Math.floor((a - d) * 60), s = ((a - d) * 60 - m) * 60;
    if (s >= 59.95) { s = 0; m += 1; }
    if (m >= 60) { m = 0; d += 1; }
    return sign + pad(d, 2) + "°" + pad(m, 2) + "′" + s.toFixed(1).padStart(4, "0") + "″";
  }

  function fmtFov(deg) {
    const m = deg * 60;
    if (Math.abs(m - 60) < 0.01) return "1°";
    return (Math.abs(m - Math.round(m)) < 0.05 ? Math.round(m) : m.toFixed(1)) + "′";
  }

  function fmtNum(v) {
    if (!isFinite(v)) return "–";
    const a = Math.abs(v);
    if (a >= 1e5 || (a > 0 && a < 1e-2)) return v.toExponential(2);
    return v.toLocaleString("en-US", { maximumFractionDigits: a >= 100 ? 0 : a >= 10 ? 1 : 2 });
  }

  function mjdYear(mjd) { return 2000 + (mjd - 51544.5) / 365.25; }

  function propagate(obj, epoch, year) {
    const dt = year - epoch;
    const dec = obj.dec + (obj.pmdec || 0) / 3.6e6 * dt;
    const ra = obj.ra + (obj.pmra || 0) / 3.6e6 / Math.cos(obj.dec * Math.PI / 180) * dt;
    return [ra, dec];
  }

  function wavelengthText(w) {
    return w && w.length === 2 ? w[0].toFixed(2) + "–" + w[1].toFixed(2) + " µm" : "–";
  }

  // SPHEREx: 6 detectors x 17 bands; detector d holds bands 17(d-1)+1 .. 17d
  function bandRange(det) {
    return det === "all" ? "bands 1–102" : "bands " + (17 * (det - 1) + 1) + "–" + 17 * det;
  }

  function detLabel(det, frames) {
    const f = frames.find((x) => String(x.detector) === det);
    const w = f ? " · " + wavelengthText(f.wavelength_um) : "";
    return (det === "all" ? "All detectors" : "Detector " + det) + " · " + bandRange(det === "all" ? "all" : +det) + w;
  }

  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 2200);
  }

  async function copyText(text, what) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = el("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch (e2) { /* nothing else to try */ }
      ta.remove();
    }
    toast(what + " copied");
  }

  function download(name, blob) {
    const a = el("a", { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ---- URL state (R25) ----

  function readURL() {
    const q = new URLSearchParams(location.search);
    const ra = parseRA(q.get("ra")), dec = parseDec(q.get("dec"));
    if (isFinite(ra) && isFinite(dec) && dec >= -90 && dec <= 90) { S.ra = ra; S.dec = dec; }
    const fov = parseFloat(q.get("fov"));
    if (isFinite(fov) && fov > 0) S.fov = clamp(fov, 1 / 60, 2);
    S.name = (q.get("name") || "").slice(0, 80);
    const det = q.get("det");
    if (det && /^(all|[1-6])$/.test(det)) S.det = det;
    const mode = q.get("mode");
    if (mode === "each" || mode === "add" || mode === "sub") S.mode = mode;
    const ref = q.get("ref");
    if (ref === "first" || ref === "prev" || ref === "all") S.ref = ref;
    S.flags = q.get("flags") === "1";
    S.gaia = q.get("gaia") !== "0";
    S.wise = q.get("wise") !== "0";
    S.tmass = q.get("tmass") !== "0";
    S.track = q.get("track") !== "0";
    S.community = q.get("community") !== "0";
    S.embed = q.get("embed") === "1";
    const speed = parseInt(q.get("speed"), 10);
    if (isFinite(speed)) S.speed = clamp(speed, 1, MAX_SWAPS_PER_S);
    if (q.has("layers")) {
      const l = q.get("layers").toLowerCase();
      S.layers = l === "" || l === "none" ? [] : l.split(",").map((s) => s.trim()).filter((s) => LAYER_ORDER.includes(s));
    }
    for (const k of ["source", "api"]) if (q.get(k)) S.passthrough[k] = q.get(k);
  }

  function stateParams() {
    const q = new URLSearchParams();
    if (S.ra === null) return q;
    q.set("ra", S.ra.toFixed(6));
    q.set("dec", S.dec.toFixed(6));
    q.set("fov", String(+S.fov.toFixed(4)));
    if (S.name) q.set("name", S.name);
    if (S.det !== "all") q.set("det", S.det);
    if (S.mode !== "each") q.set("mode", S.mode);
    if (S.mode === "sub") q.set("ref", S.ref);
    if (S.flags) q.set("flags", "1");
    if (!S.gaia) q.set("gaia", "0");
    if (!S.wise) q.set("wise", "0");
    if (!S.tmass) q.set("tmass", "0");
    if (!S.track) q.set("track", "0");
    if (!S.community) q.set("community", "0");
    if (S.layers.join(",") !== "gaia,wise") q.set("layers", S.layers.length ? S.layers.join(",") : "none");
    if (S.speed !== 2) q.set("speed", String(S.speed));
    for (const [k, v] of Object.entries(S.passthrough)) q.set(k, v);
    return q;
  }

  function shareURL(extra) {
    const q = stateParams();
    if (extra) for (const [k, v] of Object.entries(extra)) q.set(k, v);
    const s = q.toString();
    return location.origin + location.pathname + (s ? "?" + s : "");
  }

  function writeURL() {
    const q = stateParams();
    if (S.embed) q.set("embed", "1");
    const s = q.toString();
    history.replaceState(null, "", location.pathname + (s ? "?" + s : ""));
    $("link-full").href = shareURL();
    $("link-wiseview").href = wiseviewURL(S.ra, S.dec);
    const dq = new URLSearchParams();
    if (S.ra !== null) { dq.set("ra", S.ra.toFixed(6)); dq.set("dec", S.dec.toFixed(6)); }
    if (S.name) dq.set("name", S.name);
    $("link-dome").href = "dome.html" + (dq.toString() ? "?" + dq : "");
  }

  function wiseviewURL(ra, dec) {
    if (ra === null || ra === undefined) return "https://byw.tools/wiseview";
    const size = Math.min(1000, Math.round(S.fov * 3600));
    const gaia = S.layers.includes("gaia") && S.gaia ? 1 : 0;
    return "https://byw.tools/wiseview#ra=" + ra.toFixed(6) + "&dec=" + dec.toFixed(6) + "&size=" + size +
      "&band=3&speed=164&minbright=-50.0000&maxbright=500.0000&window=0.5&diff_window=1&linear=1&color=&zoom=9" +
      "&border=1&gaia=" + gaia + "&invert=1&maxdyr=0&scandir=0&neowise=0&diff=0&outer_epochs=0&unique=1&smooth=0" +
      "&shift=0&pmra=0&pmdec=0";
  }

  // ---- status panel ----

  function showStatus(o) {
    $("status").hidden = false;
    $("status-msg").textContent = o.msg || "";
    $("status-detail").textContent = o.detail || "";
    const hasBar = typeof o.progress === "number";
    $("status-progress").hidden = !hasBar && !o.indeterminate;
    $("status-progress").classList.toggle("indeterminate", !hasBar && !!o.indeterminate);
    $("status-bar").style.width = hasBar ? Math.round(clamp(o.progress, 0, 1) * 100) + "%" : "";
    const box = $("status-actions");
    box.textContent = "";
    for (const a of o.actions || []) {
      box.appendChild(el(a.href ? "a" : "button", Object.assign({
        class: "btn" + (a.primary ? " btn-primary" : ""),
      }, a.href ? { href: a.href } : { type: "button", onclick: a.onClick }), a.label));
    }
    $("stage").classList.toggle("dim", !!o.dim);
  }

  function hideStatus() {
    $("status").hidden = true;
    $("stage").classList.remove("dim");
  }

  function elapsedText() {
    return Math.round((Date.now() - S.loadStarted) / 1000) + " s";
  }

  let lastStage = null;
  function onStage(st) {
    lastStage = st;
    const cancel = { label: "Cancel", onClick: cancelLoad };
    if (st.stage === "waking") {
      showStatus({
        msg: "Waking up the live SPHEREx server…",
        detail: "The free server sleeps when nobody uses it. Waking takes up to a minute, then a new spot takes 1 to 4 minutes. Elapsed " + elapsedText() + ".",
        indeterminate: true, actions: [cancel], dim: true,
      });
    } else if (st.stage === "queued") {
      showStatus({
        msg: "Waiting for another search on this server to finish",
        detail: "Your search starts as soon as the server is free. Elapsed " + elapsedText() + ".",
        indeterminate: true, actions: [cancel], dim: true,
      });
    } else if (st.stage === "working") {
      const steps = st.steps || 4, step = st.step || 1;
      const counts = st.total ? " (" + (st.done || 0) + " of " + st.total + ")" : "";
      const frac = st.total ? (step - 1 + (st.done || 0) / st.total) / steps : (step - 1) / steps;
      showStatus({
        msg: "Step " + step + " of " + steps + " · " + (st.message || "Working") + counts,
        detail: "Elapsed " + elapsedText() + ". A new spot takes 1 to 4 minutes; next time it opens at once.",
        progress: frac, actions: [cancel], dim: true,
      });
    } else if (st.stage === "images") {
      showStatus({
        msg: "Loading images (" + st.done + " of " + st.total + ")",
        progress: st.total ? st.done / st.total : 0, actions: [cancel], dim: true,
      });
    } else {
      showStatus({ msg: st.message || "Loading…", indeterminate: true, actions: [cancel], dim: true });
    }
  }

  function startTicker() {
    S.loadStarted = Date.now();
    lastStage = null;
    clearInterval(S.ticker);
    S.ticker = setInterval(() => {
      if (lastStage && /waking|queued|working/.test(lastStage.stage)) onStage(lastStage);
    }, 1000);
  }

  function stopTicker() { clearInterval(S.ticker); S.ticker = null; }

  function cancelLoad() {
    if (S.controller) S.controller.abort();
    S.token += 1;
    stopTicker();
    showStatus({
      msg: "Search cancelled.",
      actions: [{ label: "Try again", primary: true, onClick: load }],
    });
  }

  function nearestAction(nearest) {
    if (!nearest) return [];
    const t = TARGETS.find((x) => x.id === nearest.id);
    const fov = t ? t.fov : S.fov;
    const href = "viewer.html?ra=" + nearest.ra.toFixed(6) + "&dec=" + nearest.dec.toFixed(6) + "&fov=" + +fov.toFixed(4) +
      "&name=" + encodeURIComponent(nearest.name);
    return [{ label: "Open " + nearest.name, href }];
  }

  function nearestText(nearest) {
    if (!nearest) return "";
    const d = nearest.sep_deg;
    return " The nearest pre-built target is " + nearest.name + ", " + (d < 1 ? Math.round(d * 60) + "′" : d.toFixed(1) + "°") + " away.";
  }

  // ---- loading ----

  function knownTarget() {
    for (const t of TARGETS) if (G.separation(S.ra, S.dec, t.ra, t.dec) < 60 / 3600) return t;
    return null;
  }

  async function load() {
    if (S.ra === null) return showEmpty();
    if (S.controller) S.controller.abort();
    const ctl = new AbortController();
    S.controller = ctl;
    const token = ++S.token;
    stopPlay();
    releaseLeftHeight();
    startTicker();
    showStatus({ msg: "Looking for SPHEREx images…", indeterminate: true, actions: [{ label: "Cancel", onClick: cancelLoad }], dim: true });
    writeURL();
    try {
      const res = await SkyData.getPatch({ ra: S.ra, dec: S.dec, fov: S.fov, det: S.det, layers: S.layers, onStage, signal: ctl.signal });
      if (token !== S.token) return;
      if (res.status === "no-coverage") return showNoCoverage(res);
      if (S.res && S.res.patch.id === res.patch.id && S.res.source === res.source) {
        res.images = S.res.images;
      } else {
        S.pix = new Map();
      }
      const dets = detectorsIn(res.frames);
      if (!dets.length) return showNoCoverage({ nearest: null });
      if (!dets.includes(S.det)) S.det = dets.includes("all") ? "all" : dets[0];
      await SkyData.loadImages(res, S.det, onStage, ctl.signal);
      if (token !== S.token) return;
      S.res = res;
      S.target = knownTarget();
      setupFrames();
      hideStatus();
      renderAll();
      renderLearnLinks();
    } catch (e) {
      if (token !== S.token || e.code === "cancelled") return;
      showError(e);
    } finally {
      if (token === S.token) stopTicker();
    }
  }

  function clearView() {
    S.res = null;
    S.frames = [];
    renderAll();
    renderLearnLinks();
  }

  // hands-on Education lessons that fit what this patch shows
  function renderLearnLinks() {
    const box = $("learn-links");
    if (!box) return;
    box.textContent = "";
    const r = S.res;
    if (!r) { box.hidden = true; return; }
    const v = r.verdicts || {}, kind = r.patch && r.patch.kind;
    const links = [];
    if (v.motion === "moves") links.push(["lesson-mover", "Find the mover"], ["lesson-moved", "How we know it moved"]);
    if (kind === "brown-dwarf") links.push(["lesson-wavelength", "Colours you can't see"]);
    if (v.variability === "changing" || v.variability === "possible change") links.push(["lesson-colour", "A star that changes colour"]);
    if (!links.length || r.source === "live") links.push(["lesson-planetx", "Could SPHEREx catch Planet X?"]);
    box.append(el("span", { class: "muted" }, "Learn: "));
    for (const [id, label] of links) box.append(el("a", { href: "learn.html#" + id }, label));
    box.hidden = false;
  }

  function showEmpty() {
    clearView();
    showStatus({ msg: "Type a sky position above, or pick one of the test targets.", detail: "RA and Dec can be degrees (269.4463) or hours and degrees (17h57m47s, +04d46m06s)." });
  }

  function showNoCoverage(res) {
    clearView();
    showStatus({
      msg: "No SPHEREx images here yet.",
      detail: (res.needsLive
        ? "This spot isn't one of our pre-built targets, and this copy of the site only has those."
        : "SPHEREx hasn't covered this spot, or the archive doesn't have it yet.") + nearestText(res.nearest),
      actions: nearestAction(res.nearest),
    });
  }

  function showError(e) {
    clearView();
    if (e.code === "needs-live") {
      showStatus({
        msg: "This spot needs the live server.",
        detail: "Spots that aren't pre-built are processed by our live SPHEREx server, and it isn't answering right now. The 100 pre-built targets still work." + nearestText(e.nearest),
        actions: [{ label: "Retry", primary: true, onClick: load }].concat(nearestAction(e.nearest)),
      });
    } else if (e.code === "input") {
      showStatus({ msg: e.message });
    } else {
      showStatus({ msg: e.message || "Something went wrong loading this spot.", actions: [{ label: "Retry", primary: true, onClick: load }] });
    }
  }

  function detectorsIn(frames) {
    const order = ["all", "1", "2", "3", "4", "5", "6"];
    const have = new Set(frames.map((f) => String(f.detector)));
    return order.filter((d) => have.has(d));
  }

  function setupFrames() {
    const prevVisit = S.frames[S.i] ? S.frames[S.i].visit : null;
    S.frames = S.res.frames.filter((f) => String(f.detector) === S.det).sort((a, b) => a.mjd - b.mjd);
    const keep = S.frames.findIndex((f) => f.visit === prevVisit);
    S.i = keep >= 0 ? keep : clamp(S.i, 0, Math.max(0, S.frames.length - 1));
    S.wantFrame = S.i;

    const det = $("in-det");
    det.textContent = "";
    for (const d of detectorsIn(S.res.frames)) det.appendChild(el("option", { value: d }, detLabel(d, S.res.frames)));
    det.value = S.det;

    const range = $("in-time");
    range.max = String(Math.max(0, S.frames.length - 1));
    range.value = String(S.i);
    const ticks = $("ticks");
    ticks.textContent = "";
    S.frames.forEach((f) => ticks.appendChild(el("span", null, f.date)));

    const one = S.frames.length < 2;
    for (const id of ["btn-prev", "btn-play", "btn-next", "in-time"]) $(id).disabled = one || S.mode === "add";
    renderLayersPanel();
    renderPredictions();
  }

  async function setDetector(det) {
    if (!S.res) { S.det = det; return; }
    S.det = det;
    const token = S.token;
    try {
      await SkyData.loadImages(S.res, det, onStage);
    } catch (e) {
      showError(e);
      return;
    }
    if (token !== S.token) return;
    hideStatus();
    setupFrames();
    renderAll();
  }

  // ---- pixels ----

  const scratch = document.createElement("canvas");
  const scratchCtx = scratch.getContext("2d", { willReadFrequently: true });

  function pixOf(url) {
    if (!url) return null;
    if (S.pix.has(url)) return S.pix.get(url);
    const img = S.res && S.res.images[url];
    if (!img) return null;
    const w = img.naturalWidth, h = img.naturalHeight;
    scratch.width = w;
    scratch.height = h;
    scratchCtx.clearRect(0, 0, w, h);
    scratchCtx.drawImage(img, 0, 0);
    const data = scratchCtx.getImageData(0, 0, w, h).data;
    const out = new Uint8Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = data[i * 4];
    const entry = { w, h, data: out };
    S.pix.set(url, entry);
    return entry;
  }

  // Inverse of the export stretch (R18): 8-bit value back to image units.
  const lutCache = new Map();
  function physLUT(st) {
    const key = st.black + "|" + st.knee + "|" + st.top;
    if (lutCache.has(key)) return lutCache.get(key);
    const a = Math.asinh((st.top - st.black) / st.knee);
    const lut = new Float32Array(256);
    for (let g = 0; g < 256; g++) lut[g] = st.black + st.knee * Math.sinh(g / 255 * a);
    lutCache.set(key, lut);
    return lut;
  }

  function toGrey(v, st) {
    const a = Math.asinh((st.top - st.black) / st.knee);
    return 255 * Math.asinh(Math.max(0, v - st.black) / st.knee) / a;
  }

  function stretchOf(f) {
    return f.stretch && f.stretch.knee > 0 ? f.stretch : { black: 0, knee: 1, top: Math.sinh(1) };
  }

  // ---- canvas ----

  const canvas = $("sky-canvas");
  const ctx = canvas.getContext("2d");
  const frameCanvas = document.createElement("canvas");
  const frameCtx = frameCanvas.getContext("2d");
  let dpr = 1;

  function view() {
    const c = S.res.crop;
    return { x0: Math.round(c.x0), y0: Math.round(c.y0), n: c.w };
  }

  function patchToCanvas(x, y) {
    const v = view();
    const s = canvas.width / v.n;
    return [(x - v.x0 + 0.5) * s, (y - v.y0 + 0.5) * s];
  }

  function canvasToPatch(cx, cy) {
    const v = view();
    const s = canvas.width / v.n;
    return [cx / s + v.x0 - 0.5, cy / s + v.y0 - 0.5];
  }

  function resizeCanvas() {
    const box = $("stage");
    const size = Math.max(200, Math.floor(Math.min(box.clientWidth, 720)));
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.style.width = size + "px";
    canvas.style.height = size + "px";
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    renderCanvas();
  }

  function refFrames() {
    if (S.ref === "first") return [S.frames[0]];
    if (S.ref === "prev") return S.i > 0 ? [S.frames[S.i - 1]] : null;
    return S.frames;
  }

  function meanPhys(frames, k, cache) {
    let sum = 0;
    for (const f of frames) {
      const p = cache.get(f);
      sum += p.lut[p.px.data[k]];
    }
    return sum / frames.length;
  }

  function renderCanvas() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!S.res || !S.frames.length) return;

    const P = S.res.patch;
    const v = view();
    const n = v.n;
    const cur = S.frames[S.i];
    const st = stretchOf(cur);
    const cache = new Map();
    const need = S.mode === "each" ? [cur] : S.frames;
    for (const f of need.concat(S.mode === "sub" ? (refFrames() || []) : [])) {
      if (!cache.has(f)) {
        const px = pixOf(f.url);
        if (!px) return;
        cache.set(f, { px, lut: physLUT(stretchOf(f)) });
      }
    }
    const flagPx = S.flags ? pixOf(cur.flags_url) : null;
    const refs = S.mode === "sub" ? refFrames() : null;
    const W = cache.get(cur).px.w, H = cache.get(cur).px.h;

    frameCanvas.width = n;
    frameCanvas.height = n;
    const img = frameCtx.createImageData(n, n);
    const out = img.data;
    const { bright, contrast, invert } = S.adj;
    const diffScale = Math.asinh(0.25 * (st.top - st.black) / st.knee);
    const z = [14, 16, 24], red = [255, 86, 64], blue = [74, 156, 255];

    for (let yy = 0; yy < n; yy++) {
      const py = v.y0 + yy;
      for (let xx = 0; xx < n; xx++) {
        const px = v.x0 + xx;
        const o = (yy * n + xx) * 4;
        out[o + 3] = 255;
        if (px < 0 || py < 0 || px >= W || py >= H) { out[o] = out[o + 1] = out[o + 2] = 0; continue; }
        const k = py * W + px;
        let r, g, b;
        if (S.mode === "sub") {
          if (!refs) { r = z[0]; g = z[1]; b = z[2]; } else {
            const d = cache.get(cur).lut[cache.get(cur).px.data[k]] - meanPhys(refs, k, cache);
            const m = clamp(Math.asinh(d / st.knee) / diffScale * contrast, -1, 1);
            const c = m >= 0 ? red : blue, t = Math.abs(m);
            r = z[0] + (c[0] - z[0]) * t; g = z[1] + (c[1] - z[1]) * t; b = z[2] + (c[2] - z[2]) * t;
          }
        } else {
          let grey = S.mode === "add" ? toGrey(meanPhys(S.frames, k, cache), st) : cache.get(cur).px.data[k];
          grey = clamp((grey - 128) * contrast + 128 + bright * 1.28, 0, 255);
          if (invert) grey = 255 - grey;
          r = g = b = grey;
        }
        if (flagPx && flagPx.data[k] > 0) { r = r * 0.3 + 255 * 0.7; g = g * 0.3 + 40 * 0.7; b = b * 0.3 + 40 * 0.7; }
        out[o] = r; out[o + 1] = g; out[o + 2] = b;
      }
    }
    frameCtx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(frameCanvas, 0, 0, n, n, 0, 0, canvas.width, canvas.height);
    drawOverlays(P, cur);
  }

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function drawOverlays(P, cur) {
    const year = mjdYear(cur.mjd);
    const u = dpr;
    ctx.lineWidth = 1.5 * u;
    const inView = (x, y) => x > -20 * u && y > -20 * u && x < canvas.width + 20 * u && y < canvas.height + 20 * u;

    const drawCat = (list, epochDefault, colour, shape) => {
      ctx.strokeStyle = colour;
      const r = 6 * u;
      for (const s of list) {
        const [ra, dec] = propagate(s, s.epoch || epochDefault, year);
        const [x, y] = patchToCanvas(...G.skyToPix(P, ra, dec));
        if (!inView(x, y)) continue;
        ctx.beginPath();
        if (shape === "diamond") {
          ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath();
        } else if (shape === "triangle") {
          ctx.moveTo(x, y - r); ctx.lineTo(x + r * 0.9, y + r * 0.6); ctx.lineTo(x - r * 0.9, y + r * 0.6); ctx.closePath();
        } else {
          ctx.rect(x - r * 0.8, y - r * 0.8, r * 1.6, r * 1.6);
        }
        ctx.stroke();
      }
    };
    if (S.gaia && S.res.overlays.gaia) drawCat(S.res.overlays.gaia, 2016.0, cssVar("--gaia", "#5ce1e6"), "diamond");
    if (S.wise && S.res.overlays.wise) drawCat(S.res.overlays.wise, 2015.4, cssVar("--wise", "#ffb347"), "square");
    if (S.tmass && S.res.overlays.tmass) drawCat(S.res.overlays.tmass, 1999.0, cssVar("--tmass", "#c3a6ff"), "triangle");

    const pxPerArcsec = canvas.width / view().n / P.pixel_scale_arcsec;

    if (S.track) {
      const t = S.target || { ra: S.ra, dec: S.dec, pmra: 0, pmdec: 0 };
      const [ra, dec] = propagate(t, 2026.0, year);
      const [x, y] = patchToCanvas(...G.skyToPix(P, ra, dec));
      ctx.save();
      ctx.strokeStyle = cssVar("--track", "#f5f56b");
      ctx.setLineDash([4 * u, 3 * u]);
      ctx.beginPath();
      ctx.arc(x, y, Math.max(9 * u, 15 * pxPerArcsec), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    const visitIndex = S.i;
    const trackPoint = (p) => {
      const tr = p.track || [];
      return tr.find((q) => q.epoch === cur.visit) || tr.find((q) => q.epoch === visitIndex) || null;
    };
    for (const p of S.res.predictions) {
      const selected = S.selectedPred === p.id;
      if (!selected && !S.circleAll) continue;
      ctx.strokeStyle = p.kind === "mover" ? cssVar("--mover", "#ff6bd5") : cssVar("--variable", "#9cff6b");
      if (selected && p.track && p.track.length > 1) {
        ctx.beginPath();
        p.track.forEach((q, j) => {
          const [x, y] = patchToCanvas(q.x, q.y);
          if (j) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        });
        ctx.stroke();
      }
      const tp = trackPoint(p);
      if (tp) {
        const [x, y] = patchToCanvas(tp.x, tp.y);
        ctx.lineWidth = (selected ? 2.5 : 1.5) * u;
        ctx.beginPath();
        ctx.arc(x, y, (selected ? 14 : 11) * u, 0, Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 1.5 * u;
      }
    }

    if (S.community && window.WinkHunt) {
      ctx.save();
      ctx.lineWidth = 1.5 * u;
      for (const m of communityInView(P)) {
        const [x, y] = patchToCanvas(...G.skyToPix(P, m.ra, m.dec));
        const r = 6 * u;
        ctx.strokeStyle = cssVar(WinkHunt.LABELS[m.label].colour, "#ffffff");
        ctx.beginPath();
        if (m.label === "mover") {
          ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath();
        } else if (m.label === "variable") {
          ctx.arc(x, y, r, 0, Math.PI * 2);
        } else {
          ctx.moveTo(x - r * 0.7, y - r * 0.7); ctx.lineTo(x + r * 0.7, y + r * 0.7);
          ctx.moveTo(x + r * 0.7, y - r * 0.7); ctx.lineTo(x - r * 0.7, y + r * 0.7);
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    ctx.strokeStyle = cssVar("--mark", "#7dff9b");
    for (const m of S.marks) {
      if (G.separation(m.ra, m.dec, P.ra, P.dec) > P.fov_deg) continue;
      const [x, y] = patchToCanvas(...G.skyToPix(P, m.ra, m.dec));
      if (!inView(x, y)) continue;
      ctx.beginPath();
      ctx.moveTo(x - 7 * u, y); ctx.lineTo(x + 7 * u, y); ctx.moveTo(x, y - 7 * u); ctx.lineTo(x, y + 7 * u);
      ctx.stroke();
    }

    if (S.measure) {
      const [x, y] = patchToCanvas(S.measure.x, S.measure.y);
      ctx.strokeStyle = cssVar("--measure", "#ffe066");
      ctx.beginPath();
      ctx.arc(x, y, 2.5 * canvas.width / view().n + 2 * u, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (S.adj.cross) {
      ctx.save();
      ctx.strokeStyle = "rgba(255,255,255,0.45)";
      ctx.lineWidth = u;
      const c = canvas.width / 2, gap = 12 * u;
      ctx.beginPath();
      ctx.moveTo(0, c); ctx.lineTo(c - gap, c); ctx.moveTo(c + gap, c); ctx.lineTo(canvas.width, c);
      ctx.moveTo(c, 0); ctx.lineTo(c, c - gap); ctx.moveTo(c, c + gap); ctx.lineTo(c, canvas.height);
      ctx.stroke();
      ctx.restore();
    }
  }

  // ---- measuring (R24) ----

  // Aperture photometry on the 8-bit picture, undoing the stretch. Approximate: the PNG is quantised
  // and clipped at the sky level. The pipeline's light curve is the accurate one.
  function measureFrame(f, x, y) {
    const px = pixOf(f.url);
    if (!px) return null;
    const fl = pixOf(f.flags_url);
    const lut = physLUT(stretchOf(f));
    const xi = Math.round(x), yi = Math.round(y);
    let sum = 0, n = 0, flagged = false, outside = false;
    const sky = [];
    for (let dy = -7; dy <= 7; dy++) {
      for (let dx = -7; dx <= 7; dx++) {
        const r = Math.hypot(dx, dy);
        if (r > 7) continue;
        const X = xi + dx, Y = yi + dy;
        if (X < 0 || Y < 0 || X >= px.w || Y >= px.h) { if (r <= 2.5) outside = true; continue; }
        const k = Y * px.w + X;
        const val = lut[px.data[k]];
        if (r <= 2.5) {
          sum += val; n += 1;
          if (fl && fl.data[k] > 0) flagged = true;
        } else if (r >= 4) {
          sky.push(val);
        }
      }
    }
    if (!n || outside) return { mjd: f.mjd, date: f.date, value: NaN, err: NaN, flagged, outside: true };
    sky.sort((a, b) => a - b);
    const med = sky.length ? sky[sky.length >> 1] : 0;
    const dev = sky.map((s) => Math.abs(s - med)).sort((a, b) => a - b);
    const mad = dev.length ? 1.4826 * dev[dev.length >> 1] : 0;
    const k = SR_PER_PX * 1e12;
    return { mjd: f.mjd, date: f.date, value: (sum - n * med) * k, err: mad * Math.sqrt(n) * k, flagged, outside: false };
  }

  function targetPositionPix(f) {
    const t = S.target || { ra: S.ra, dec: S.dec, pmra: 0, pmdec: 0 };
    const [ra, dec] = propagate(t, 2026.0, mjdYear(f.mjd));
    return G.skyToPix(S.res.patch, ra, dec);
  }

  const DET_COLOURS = ["--det1", "--det2", "--det3", "--det4", "--det5", "--det6"];

  function chartSeries() {
    if (!S.res) return null;
    const relative = S.det === "all";
    if (!S.measure && S.res.light_curve.length) {
      const pts = S.res.light_curve.filter((p) => relative || String(p.detector) === S.det);
      if (pts.length) {
        const byDet = new Map();
        for (const p of pts) {
          const d = String(p.detector);
          if (!byDet.has(d)) byDet.set(d, []);
          byDet.get(d).push(p);
        }
        const series = [];
        for (const [d, list] of byDet) {
          list.sort((a, b) => a.mjd - b.mjd);
          const norm = relative ? median(list.map((p) => p.flux_ujy)) || 1 : 1;
          series.push({
            name: "Detector " + d, colour: cssVar(DET_COLOURS[(+d || 1) - 1], "#8ab4ff"),
            points: list.map((p) => ({
              mjd: p.mjd, value: p.flux_ujy / norm, err: (p.err || 0) / norm, flagged: !!p.flagged,
              note: [p.approximate ? "approximate" : "", p.flagged ? "flagged" : ""].filter(Boolean).join(", "),
              wavelength: p.wavelength_um, det: d,
            })),
          });
        }
        return {
          title: "Target brightness" + (relative ? " (relative, each detector)" : " · detector " + S.det),
          unit: relative ? "relative to its median" : "µJy",
          source: "From the pipeline's photometry.",
          series,
        };
      }
    }
    const pos = S.measure ? () => [S.measure.x, S.measure.y] : targetPositionPix;
    const raw = S.frames.map((f) => {
      const [x, y] = pos(f);
      const m = measureFrame(f, x, y);
      return m && Object.assign(m, { det: S.det, wavelength: f.wavelength_um });
    }).filter(Boolean);
    const good = raw.filter((p) => isFinite(p.value));
    const norm = relative ? median(good.map((p) => p.value)) || 1 : 1;
    return {
      title: (S.measure ? "Spot at " + fmtRA(S.measure.ra) + " " + fmtDec(S.measure.dec) : "Target brightness") +
        (relative ? " (relative)" : " · detector " + S.det),
      unit: relative ? "relative to its median" : "µJy (approx.)",
      source: S.measure
        ? "Measured from the picture, so it's approximate. Flagged dates are triangles."
        : "Measured from the picture along the target's expected track, so it's approximate.",
      series: [{
        name: S.measure ? "Clicked spot" : "Target",
        colour: cssVar("--measure", "#ffe066"),
        points: raw.map((p) => ({
          mjd: p.mjd, value: p.value / norm, err: p.err / Math.abs(norm), flagged: p.flagged,
          note: p.outside ? "off the edge" : p.flagged ? "flagged" : "",
          wavelength: p.wavelength, det: p.det,
        })),
      }],
    };
  }

  function median(a) {
    const s = a.filter(isFinite).sort((x, y) => x - y);
    return s.length ? s[s.length >> 1] : NaN;
  }

  const SVGNS = "http://www.w3.org/2000/svg";
  function svg(tag, attrs, text) {
    const e = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function renderChart() {
    const box = $("chart"), tbox = $("chart-table");
    box.textContent = "";
    tbox.textContent = "";
    $("btn-back-target").hidden = !S.measure;
    const data = chartSeries();
    if (!data) {
      $("chart-title").textContent = "Brightness over time";
      box.appendChild(el("p", { class: "muted" }, "Load a patch to see how bright things are on each date."));
      return;
    }
    $("chart-title").textContent = data.title;
    $("chart-hint").textContent = data.source + " Click anywhere on the image to measure that spot.";

    const all = data.series.flatMap((s) => s.points).filter((p) => isFinite(p.value));
    const W = box.clientWidth && box.clientWidth < 520 ? 380 : 600, H = 230, L = 64, R = 14, T = 14, B = 34;
    const root = svg("svg", { viewBox: "0 0 " + W + " " + H, class: "chart-svg", role: "img" });
    root.setAttribute("aria-label", data.title + ": " + all.length + " points. Use Table view for the numbers.");
    if (!all.length) {
      root.appendChild(svg("text", { x: W / 2, y: H / 2, "text-anchor": "middle", class: "chart-empty" }, "Nothing measurable here."));
      box.appendChild(root);
      return;
    }
    const mjds = S.frames.map((f) => f.mjd).concat(all.map((p) => p.mjd));
    let x0 = Math.min(...mjds), x1 = Math.max(...mjds);
    if (x1 - x0 < 1) { x0 -= 15; x1 += 15; }
    const padX = (x1 - x0) * 0.06;
    x0 -= padX; x1 += padX;
    let y0 = Math.min(...all.map((p) => p.value - (isFinite(p.err) ? p.err : 0)));
    let y1 = Math.max(...all.map((p) => p.value + (isFinite(p.err) ? p.err : 0)));
    if (y1 - y0 < 1e-9) { y0 -= Math.abs(y0) * 0.1 + 1; y1 += Math.abs(y1) * 0.1 + 1; }
    const padY = (y1 - y0) * 0.1;
    y0 -= padY; y1 += padY;
    const X = (m) => L + (m - x0) / (x1 - x0) * (W - L - R);
    const Y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);

    const axis = svg("g", { class: "chart-axis" });
    for (let j = 0; j <= 4; j++) {
      const v = y0 + (y1 - y0) * j / 4;
      axis.appendChild(svg("line", { x1: L, x2: W - R, y1: Y(v), y2: Y(v), class: "grid" }));
      axis.appendChild(svg("text", { x: L - 6, y: Y(v) + 4, "text-anchor": "end" }, fmtNum(v)));
    }
    S.frames.forEach((f, j) => {
      if (W < 500 && S.frames.length > 4 && j % 2) return;
      axis.appendChild(svg("text", { x: X(f.mjd), y: H - 12, "text-anchor": "middle" }, f.date.slice(0, 7)));
    });
    axis.appendChild(svg("text", { x: 12, y: T + (H - T - B) / 2, transform: "rotate(-90 12 " + (T + (H - T - B) / 2) + ")", "text-anchor": "middle" }, data.unit));
    root.appendChild(axis);

    const cur = S.frames[S.i];
    if (cur) root.appendChild(svg("line", { x1: X(cur.mjd), x2: X(cur.mjd), y1: T, y2: H - B, class: "now-line" }));

    for (const s of data.series) {
      const g = svg("g", { style: "color:" + s.colour });
      const pts = s.points.filter((p) => isFinite(p.value));
      if (pts.length > 1) {
        g.appendChild(svg("polyline", { points: pts.map((p) => X(p.mjd) + "," + Y(p.value)).join(" "), class: "series-line" }));
      }
      for (const p of pts) {
        const x = X(p.mjd), y = Y(p.value);
        if (isFinite(p.err) && p.err > 0) g.appendChild(svg("line", { x1: x, x2: x, y1: Y(p.value - p.err), y2: Y(p.value + p.err), class: "err" }));
        const tip = new Date(Math.round((p.mjd - 40587) * 864e5)).toISOString().slice(0, 10) + ": " + fmtNum(p.value) + " " + data.unit + (p.note ? " (" + p.note + ")" : "");
        const mark = p.flagged
          ? svg("polygon", { points: x + "," + (y - 6) + " " + (x + 5.5) + "," + (y + 4) + " " + (x - 5.5) + "," + (y + 4), class: "pt flagged" })
          : svg("circle", { cx: x, cy: y, r: 4.5, class: "pt" });
        mark.appendChild(svg("title", null, s.name + " · " + tip));
        g.appendChild(mark);
      }
      root.appendChild(g);
    }
    if (data.series.length > 1) {
      const leg = svg("g", { class: "legend" });
      data.series.forEach((s, j) => {
        const lx = L + 8 + j * (W < 500 ? 50 : 82);
        leg.appendChild(svg("circle", { cx: lx, cy: T + 6, r: 4, style: "fill:" + s.colour }));
        leg.appendChild(svg("text", { x: lx + 8, y: T + 10 }, s.name.replace("Detector ", "D")));
      });
      root.appendChild(leg);
    }
    box.appendChild(root);

    const table = el("table", { class: "data-table" });
    table.appendChild(el("caption", { class: "sr-only" }, data.title));
    const head = el("tr");
    for (const h of ["Date", "Detector", "Wavelength", "Brightness (" + data.unit + ")", "±", "Note"]) head.appendChild(el("th", { scope: "col" }, h));
    table.appendChild(el("thead")).appendChild(head);
    const tb = el("tbody");
    for (const s of data.series) {
      for (const p of s.points) {
        const tr = el("tr", p.flagged ? { class: "flagged" } : null);
        const date = new Date(Math.round((p.mjd - 40587) * 864e5)).toISOString().slice(0, 10);
        for (const c of [date, p.det === "all" ? "all" : p.det, wavelengthText(p.wavelength), fmtNum(p.value), fmtNum(p.err), p.note || ""]) tr.appendChild(el("td", null, c));
        tb.appendChild(tr);
      }
    }
    table.appendChild(tb);
    tbox.appendChild(table);
    box.hidden = S.chartTable;
    tbox.hidden = !S.chartTable;
  }

  // ---- side panels ----

  function setKV(id, rows) {
    const dl = $(id);
    dl.textContent = "";
    for (const [k, v, title] of rows) {
      dl.appendChild(el("dt", null, k));
      const dd = el("dd", title ? { title } : null, v);
      dl.appendChild(dd);
    }
  }

  function renderInfo() {
    const cur = S.res && S.frames[S.i];
    if (!cur) {
      setKV("this-image", [["Date", "–"]]);
      $("flags-info").textContent = "";
      $("flags-info").appendChild(el("p", { class: "muted" }, "No image loaded."));
      setKV("patch-info", [["Patch", "–"]]);
      return;
    }
    setKV("this-image", [
      ["Date", cur.date + (S.mode === "add" ? " (showing all dates added)" : "")],
      ["Visit", String(cur.visit + 1) + " of " + new Set(S.res.frames.map((f) => f.visit)).size],
      ["Detector", cur.detector === "all" ? "All six, added (bands 1–102)" : cur.detector + " (" + bandRange(cur.detector) + ")"],
      ["Wavelength", wavelengthText(cur.wavelength_um)],
      ["Exposures", String(cur.n_exposures ?? "–")],
      ["Coverage", typeof cur.coverage === "number" ? Math.round(cur.coverage * 100) + "% of the patch" : "–"],
      ["Saturated", cur.saturated ? "Yes: brightness is approximate" : "No"],
    ]);

    const box = $("flags-info");
    box.textContent = "";
    const bits = Object.entries(cur.flag_bits || {}).sort((a, b) => b[1] - a[1]);
    if (bits.length) {
      const ul = el("ul", { class: "flag-bits" });
      for (const [name, count] of bits) {
        const li = el("li");
        li.appendChild(el("span", { class: "bit" }, name));
        li.appendChild(el("span", null, count.toLocaleString("en-US") + " px"));
        ul.appendChild(li);
      }
      box.appendChild(ul);
    } else {
      box.appendChild(el("p", { class: "muted" }, "No flagged pixels on this date."));
    }
    for (const note of cur.flags || []) box.appendChild(el("p", { class: "hint" }, note));
    box.appendChild(el("p", { class: "hint" }, S.flags ? "Flagged pixels are shown in red." : "Tick “Contamination flags” in Layers to see them in red."));
    const spot = S.measure ? [S.measure.x, S.measure.y] : (S.res.light_curve.length ? null : targetPositionPix(cur));
    if (spot) {
      const m = measureFrame(cur, spot[0], spot[1]);
      if (m && m.flagged) box.appendChild(el("p", { class: "warn" }, "Warning: the spot being measured is flagged on this date, so treat its brightness with care."));
    }

    const P = S.res.patch;
    const v = S.res.verdicts || {};
    const rows = [
      ["Patch", P.name || P.id],
      ["Centre", fmtRA(P.ra) + " " + fmtDec(P.dec), P.ra.toFixed(5) + "°, " + P.dec.toFixed(5) + "°"],
      ["Patch size", fmtFov(P.fov_deg) + " (" + P.width_px + " px)"],
      ["Showing", fmtFov(S.fov) + (S.res.zoomed ? " (zoomed in)" : "")],
      ["Pixel", P.pixel_scale_arcsec + "″"],
      ["Dates", String(new Set(S.res.frames.map((f) => f.visit)).size)],
      ["From", S.res.source === "live" ? "Live search (cached on our server)" : "Pre-built target"],
      ["Pipeline", P.pipeline_version || "–"],
    ];
    if (v.motion) rows.push(["Motion", v.motion]);
    if (v.variability) rows.push(["Brightness", v.variability]);
    setKV("patch-info", rows);
    if (v.notes && v.notes.length) {
      const dd = el("dd", { class: "notes" });
      for (const n of v.notes) dd.appendChild(el("p", null, n));
      $("patch-info").appendChild(el("dt", null, "Notes"));
      $("patch-info").appendChild(dd);
    }
    holdLeftHeight();
  }

  // The flag list changes length from date to date. If the left column shrank while blinking, the page
  // would get shorter and the browser would pull the scroll position up, so the whole page jumped.
  // It keeps its tallest height until the next search or a change of window width.
  let leftWidth = 0;
  function holdLeftHeight() {
    const box = document.querySelector(".v-left");
    if (!box || !box.offsetParent) return;
    if (box.offsetWidth !== leftWidth) {
      leftWidth = box.offsetWidth;
      box.style.minHeight = "";
    }
    const cs = getComputedStyle(box);
    const pad = cs.boxSizing === "border-box" ? 0 : parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) +
      parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    const h = Math.ceil(box.getBoundingClientRect().height - pad);
    if (h > (parseFloat(box.style.minHeight) || 0)) box.style.minHeight = h + "px";
  }

  function releaseLeftHeight() {
    const box = document.querySelector(".v-left");
    if (box) box.style.minHeight = "";
  }

  function communityInView(P) {
    if (!S.res || !S.communityMarks.length) return [];
    const v = view();
    return S.communityMarks.filter((m) => {
      if (!WinkHunt.LABELS[m.label] || G.separation(m.ra, m.dec, P.ra, P.dec) > P.fov_deg) return false;
      const [x, y] = G.skyToPix(P, m.ra, m.dec);
      return x >= v.x0 - 0.5 && y >= v.y0 - 0.5 && x < v.x0 + v.n - 0.5 && y < v.y0 + v.n - 0.5;
    });
  }

  function loadCommunity(force) {
    if (!window.WinkHunt || !WinkHunt.configured()) {
      S.communityState = "off";
      renderLayersPanel();
      return;
    }
    WinkHunt.list(force).then((rows) => {
      S.communityMarks = rows;
      S.communityState = "ok";
      renderLayersPanel();
      renderCanvas();
    }, () => {
      S.communityState = "error";
      renderLayersPanel();
    });
  }

  function renderLayersPanel() {
    $("ly-flags").checked = S.flags;
    $("ly-track").checked = S.track;
    $("ly-community").checked = S.community;
    $("ly-community").disabled = S.communityState === "off";
    const n = S.res ? communityInView(S.res.patch).length : 0;
    $("ly-community-hint").textContent = {
      off: "Sharing isn't set up yet.",
      error: "Couldn't load community marks.",
      loading: "Loading…",
      ok: n === 1 ? "1 shared mark in this view." : n + " shared marks in this view.",
    }[S.communityState];
    for (const k of LAYER_ORDER) {
      const box = $("ly-" + k), hint = $("ly-" + k + "-hint");
      const loaded = S.layers.includes(k);
      box.disabled = !loaded;
      box.checked = loaded && S[k];
      hint.textContent = "";
      const nice = { gaia: "Gaia", wise: "WISE", tmass: "2MASS" }[k];
      if (!loaded) {
        hint.appendChild(document.createTextNode(k === "tmass" ? "1999 positions and J, H, Ks brightness. " : "Not loaded for this search. "));
        hint.appendChild(el("button", { type: "button", class: "linklike", onclick: () => addLayer(k) }, "Load " + nice));
      } else if (S.res && !S.res.overlays[k] && k === "tmass") {
        hint.textContent = S.res.source === "live" ? "2MASS isn't available for live searches yet." : "No 2MASS data for this patch yet.";
      } else if (S.res && S.res.overlays[k] && !S.res.overlays[k].length) {
        hint.textContent = { wise: "No CatWISE sources here. Very bright stars aren't in CatWISE.", gaia: "No Gaia stars in this field.", tmass: "No 2MASS sources in this field." }[k];
      }
    }
  }

  function addLayer(k) {
    if (!S.layers.includes(k)) S.layers = LAYER_ORDER.filter((x) => x === k || S.layers.includes(x));
    S[k] = true;
    load();
  }

  function renderPredictions() {
    const ul = $("predictions");
    ul.textContent = "";
    const preds = (S.res && S.res.predictions) || [];
    if (!preds.length) {
      ul.appendChild(el("li", { class: "muted" }, S.res && S.res.source === "live"
        ? "Live searches skip mover detection to stay fast."
        : "No predictions for this patch."));
      return;
    }
    for (const p of preds) {
      const bits = [p.kind];
      if (typeof p.confidence === "number") bits.push(Math.round(p.confidence * 100) + "% sure");
      if (p.pm_arcsec_yr) bits.push(p.pm_arcsec_yr + "″/yr");
      if (p.match) bits.push(typeof p.match === "string" ? p.match : (p.match.label || p.match.name || "matched"));
      if (p.tmass_1999) bits.push(p.tmass_1999.agrees ? "2MASS " + Math.round(p.tmass_1999.epoch) + " position agrees" : "2MASS " + Math.round(p.tmass_1999.epoch) + " position doesn't fit");
      const b = el("button", {
        type: "button", class: "pred" + (S.selectedPred === p.id ? " on" : ""),
        "aria-pressed": String(S.selectedPred === p.id),
        onclick: () => { S.selectedPred = S.selectedPred === p.id ? null : p.id; renderPredictions(); renderCanvas(); },
      });
      b.appendChild(el("span", { class: "pred-kind k-" + p.kind }, p.kind === "mover" ? "◆" : "●"));
      b.appendChild(el("strong", null, p.label || p.id));
      b.appendChild(el("span", { class: "muted" }, bits.join(" · ")));
      ul.appendChild(el("li")).appendChild(b);
    }
  }

  function renderBadges() {
    const box = $("badges");
    box.textContent = "";
    if (!S.res) return;
    const cur = S.frames[S.i];
    const add = (cls, text, title) => box.appendChild(el("span", Object.assign({ class: "badge " + cls }, title ? { title } : {}), text));
    if (S.res.patch.simulated) add("b-sim", "Simulated", "Made-up data for testing. Not from SPHEREx.");
    if (S.res.source === "live") add("b-live", "Live search");
    if (S.res.zoomed) add("b-zoom", "Zoomed", "2′ fields are only about 20 pixels across, so we zoom into a 5′ patch.");
    if (cur && cur.saturated) add("b-sat", "Saturated", "The star is too bright for the detector. Its brightness is approximate.");
    if (S.res.crop.covered < 0.99) add("b-part", "Partial field");
    const info = el("button", {
      type: "button", class: "badge b-info",
      title: "Faint diagonal bands on some dates are real scattered light inside SPHEREx, not a bug in Wink.",
      onclick: () => toast("Faint diagonal bands on some dates are real scattered light inside SPHEREx, not a bug in Wink."),
    }, "Faint diagonal glow?");
    box.appendChild(info);
  }

  function renderCaption() {
    const cap = $("caption");
    const cur = S.res && S.frames[S.i];
    if (!cur) { cap.textContent = ""; return; }
    const bits = [];
    if (S.mode === "add") bits.push("All " + S.frames.length + " dates added");
    else bits.push(cur.date + " · " + (cur.detector === "all" ? "all detectors" : "detector " + cur.detector) + " · " + wavelengthText(cur.wavelength_um));
    if (S.mode === "sub") {
      if (S.ref === "prev" && S.i === 0) bits.push("No earlier date to subtract: pick a later date");
      else bits.push("minus " + (S.ref === "first" ? "the first date" : S.ref === "prev" ? "the previous date" : "all dates added"));
    }
    if (S.mode !== "add" && typeof cur.coverage === "number" && cur.coverage < 0.995) {
      bits.push("This date covers " + Math.round(cur.coverage * 100) + "% of the field");
    }
    if (S.res.crop.covered < 0.99) bits.push("The data covers only " + Math.round(S.res.crop.covered * 100) + "% of the field you asked for");
    cap.textContent = bits.join(". ") + ".";
  }

  function renderPlayer() {
    $("frame-label").textContent = S.frames.length ? "Date " + (S.i + 1) + " of " + S.frames.length : "–";
    $("in-time").value = String(S.i);
    [...$("ticks").children].forEach((t, j) => t.classList.toggle("on", j === S.i));
    const play = $("btn-play");
    play.textContent = S.playing ? "❚❚ Pause" : "▶ Play";
    play.setAttribute("aria-pressed", String(S.playing));
    $("ref-wrap").hidden = S.mode !== "sub";
    $("mode-hint").textContent = MODE_HINTS[S.mode];
    const one = S.frames.length < 2 || S.mode === "add";
    for (const id of ["btn-prev", "btn-play", "btn-next", "in-time"]) $(id).disabled = one;
  }

  function renderTitle() {
    const P = S.res && S.res.patch;
    const name = S.name || (P && !/^live/.test(P.id) ? P.name : "") ||
      (S.ra !== null ? fmtRA(S.ra) + " " + fmtDec(S.dec) : "SPHEREx viewer");
    $("view-title").textContent = name;
    document.title = name + " · Wink";
    const cur = S.res && S.frames[S.i];
    canvas.setAttribute("aria-label", cur
      ? "SPHEREx image of " + name + ", " + (S.mode === "add" ? "all dates added" : cur.date) + ", " +
        (cur.detector === "all" ? "all detectors" : "detector " + cur.detector) + ", date " + (S.i + 1) + " of " + S.frames.length +
        (S.mode === "sub" ? ", difference image" : "")
      : "No image loaded yet");
    canvas.dataset.frame = String(S.i);
  }

  function renderAll() {
    renderTitle();
    renderBadges();
    renderCanvas();
    renderCaption();
    renderPlayer();
    renderInfo();
    renderStarInfo();
    renderChart();
    renderLayersPanel();
    renderMarks();
    writeURL();
  }

  function renderFrameChange() {
    renderTitle();
    renderBadges();
    renderCanvas();
    renderCaption();
    renderPlayer();
    renderInfo();
    renderStarInfo();
    renderChart();
  }

  // ---- player (R20) ----

  function requestFrame(i) {
    if (!S.frames.length) return;
    S.wantFrame = ((i % S.frames.length) + S.frames.length) % S.frames.length;
    if (S.swapTimer) return;
    const wait = S.lastSwap + MIN_SWAP_MS - performance.now();
    if (wait <= 0) applyFrame();
    else S.swapTimer = setTimeout(() => { S.swapTimer = null; applyFrame(); }, wait);
  }

  function applyFrame() {
    if (S.wantFrame === S.i) return;
    S.i = S.wantFrame;
    S.lastSwap = performance.now();
    renderFrameChange();
  }

  function step(d) { requestFrame((S.swapTimer ? S.wantFrame : S.i) + d); }

  function togglePlay() { if (S.playing) stopPlay(); else startPlay(); }

  function startPlay() {
    if (S.frames.length < 2 || S.mode === "add") return;
    S.playing = true;
    const tick = () => {
      if (!S.playing) return;
      requestFrame(S.i + 1);
      S.playTimer = setTimeout(tick, Math.max(1000 / clamp(S.speed, 1, MAX_SWAPS_PER_S), MIN_SWAP_MS));
    };
    S.playTimer = setTimeout(tick, Math.max(1000 / S.speed, MIN_SWAP_MS));
    renderPlayer();
  }

  function stopPlay() {
    S.playing = false;
    clearTimeout(S.playTimer);
    renderPlayer();
  }

  // ---- star info: catalogue matches at the target or clicked spot, 2MASS J/H/Ks next to SPHEREx ----

  const detLoading = new Set();

  function ensureDetector(det) {
    if (detLoading.has(det)) return;
    detLoading.add(det);
    const token = S.token;
    SkyData.loadImages(S.res, det).then(() => {
      detLoading.delete(det);
      if (token === S.token) renderStarInfo();
    }, () => detLoading.delete(det));
  }

  // SPHEREx detector wavelength ranges (µm), as in pipeline/stackfile.py. One date's stack can cover only part
  // of its detector's range, so pick the detector by these and show the range that was actually measured.
  const DETECTOR_UM = { 1: [0.75, 1.09], 2: [1.10, 1.62], 3: [1.63, 2.41], 4: [2.42, 3.82], 5: [3.83, 4.41], 6: [4.42, 5.00] };

  function detectorFrameAt(um, visit) {
    const det = Object.keys(DETECTOR_UM).find((d) => um >= DETECTOR_UM[d][0] && um <= DETECTOR_UM[d][1]);
    return S.res.frames.find((f) => f.visit === visit && String(f.detector) === det) || null;
  }

  function renderStarInfo() {
    const box = $("star-info");
    box.textContent = "";
    const cur = S.res && S.frames[S.i];
    if (!cur) {
      box.appendChild(el("p", { class: "muted" }, "No image loaded."));
      return;
    }
    const posFor = (f) => (S.measure ? [S.measure.x, S.measure.y] : targetPositionPix(f));
    const [x, y] = posFor(cur);
    const [ra, dec] = G.pixToSky(S.res.patch, x, y);
    const year = mjdYear(cur.mjd);
    box.appendChild(el("p", { class: "hint" }, (S.measure ? "Clicked spot" : "Target") + " · " + fmtRA(ra) + " " + fmtDec(dec)));

    const near = {};
    for (const k of S.layers) {
      for (const s of (S.res.overlays && S.res.overlays[k]) || []) {
        const [sra, sdec] = propagate(s, s.epoch || LAYER_EPOCH[k], year);
        const sep = G.separation(ra, dec, sra, sdec) * 3600;
        if (sep <= 6 && (!near[k] || sep < near[k].sep)) near[k] = { s, sep };
      }
    }
    const rows = [];
    if (near.gaia) rows.push(["Gaia DR3", "G " + fmtNum(near.gaia.s.mag) + " · " + near.gaia.sep.toFixed(1) + "″ away", near.gaia.s.label]);
    if (near.wise) rows.push(["CatWISE", "W1 " + fmtNum(near.wise.s.mag) + " · " + near.wise.sep.toFixed(1) + "″ away", near.wise.s.label]);
    if (near.tmass) rows.push(["2MASS", near.tmass.s.label.replace("2MASS ", "") + " · " + near.tmass.sep.toFixed(1) + "″ away", near.tmass.s.label]);
    if (rows.length) {
      const dl = el("dl", { class: "kv" });
      for (const [k, v, title] of rows) {
        dl.appendChild(el("dt", null, k));
        dl.appendChild(el("dd", { title }, v));
      }
      box.appendChild(dl);
    } else if (S.layers.length) {
      box.appendChild(el("p", { class: "muted" }, "No catalogue star within 6″ of this spot."));
    }

    if (!S.layers.includes("tmass")) {
      const p = el("p", { class: "hint" }, "Compare this star's 2MASS J, H and Ks brightness with SPHEREx. ");
      p.appendChild(el("button", { type: "button", class: "linklike", onclick: () => addLayer("tmass") }, "Load 2MASS"));
      box.appendChild(p);
      return;
    }
    if (!near.tmass) {
      if (S.res.overlays.tmass) box.appendChild(el("p", { class: "muted" }, "No 2MASS source within 6″, so there's nothing to compare."));
      return;
    }

    const t = near.tmass.s;
    const table = el("table", { class: "data-table star-table" });
    table.appendChild(el("caption", { class: "sr-only" }, "2MASS brightness next to SPHEREx on " + cur.date));
    const head = el("tr");
    for (const h of ["Band", "2MASS", "SPHEREx " + cur.date]) head.appendChild(el("th", { scope: "col" }, h));
    table.appendChild(el("thead")).appendChild(head);
    const tb = el("tbody");
    let saturated = false;
    for (const b of TMASS_BANDS) {
      const mag = t[b.key];
      const two = isFinite(mag) && mag !== null ? fmtNum(mag) + " mag ≈ " + fmtNum(b.zp * 10 ** (-mag / 2.5) * 1e6) + " µJy" : "–";
      let sx = "–";
      const f = detectorFrameAt(b.um, cur.visit);
      if (f) {
        if (!S.res.images[f.url]) {
          ensureDetector(String(f.detector));
          sx = "loading…";
        } else {
          const [fx, fy] = posFor(f);
          const m = measureFrame(f, fx, fy);
          sx = "D" + f.detector + " " + wavelengthText(f.wavelength_um) + ": " +
            (m && isFinite(m.value) ? fmtNum(m.value) + " µJy" + (m.flagged ? " (flagged)" : "") : "off the edge");
          if (!S.measure && f.saturated) saturated = true;
        }
      } else {
        sx = "no SPHEREx image here on this date";
      }
      const tr = el("tr");
      for (const c of [b.name + " " + b.um.toFixed(2) + " µm", two, sx]) tr.appendChild(el("td", null, c));
      tb.appendChild(tr);
    }
    table.appendChild(tb);
    box.appendChild(table);
    const notes = ["2MASS measured this star in " + Math.round(t.epoch) + ". SPHEREx values are measured from the picture over the whole detector's wavelength range, so they're approximate."];
    if (saturated) notes.push("The target is saturated here, so SPHEREx reads too low.");
    if (S.res.patch.kind === "variable") notes.push("This star changes brightness, so the two surveys needn't agree.");
    box.appendChild(el("p", { class: "hint" }, notes.join(" ")));
  }

  // ---- marks (R41) ----

  function nearbySources(ra, dec) {
    const out = [];
    const year = S.frames[S.i] ? mjdYear(S.frames[S.i].mjd) : 2026;
    for (const k of S.layers) {
      for (const s of (S.res && S.res.overlays[k]) || []) {
        const [sra, sdec] = propagate(s, s.epoch || LAYER_EPOCH[k], year);
        const sep = G.separation(ra, dec, sra, sdec) * 3600;
        if (sep <= 15) out.push({ catalogue: LAYER_NAMES[k], label: s.label, sep_arcsec: +sep.toFixed(1), mag: s.mag ?? null });
      }
    }
    return out.sort((a, b) => a.sep_arcsec - b.sep_arcsec).slice(0, 5);
  }

  function creditsUsed() {
    const c = ["SPHEREx images: NASA/JPL-Caltech, via NASA/IPAC Infrared Science Archive (IRSA)."];
    if (S.layers.includes("gaia")) c.push("Gaia DR3: European Space Agency (ESA) mission Gaia, processed by the Gaia Data Processing and Analysis Consortium (DPAC).");
    if (S.layers.includes("wise")) c.push("CatWISE2020 catalogue (Marocco et al. 2021).");
    if (S.layers.includes("tmass")) c.push("Two Micron All Sky Survey (2MASS), a joint project of the University of Massachusetts and IPAC/Caltech, funded by NASA and the NSF.");
    c.push("WiseView (Caselden et al. 2018).");
    return c;
  }

  function startMark() {
    if (!S.res) { toast("Load an image first"); return; }
    S.marking = true;
    S.pendingMark = null;
    $("btn-mark").setAttribute("aria-pressed", "true");
    $("btn-mark").textContent = "Click the image…";
    $("mark-hint").hidden = false;
    $("mark-label").hidden = true;
    canvas.classList.add("marking");
    canvas.focus();
  }

  function cancelMark() {
    S.marking = false;
    S.pendingMark = null;
    $("btn-mark").setAttribute("aria-pressed", "false");
    $("btn-mark").textContent = "✚ Mark this";
    $("mark-hint").hidden = true;
    $("mark-label").hidden = true;
    canvas.classList.remove("marking");
  }

  function placeMark(x, y) {
    const [ra, dec] = G.pixToSky(S.res.patch, x, y);
    S.pendingMark = { x, y, ra, dec };
    S.marking = false;
    $("mark-hint").hidden = true;
    $("mark-label").hidden = false;
    $("mark-text").value = "";
    const canShare = !!(window.WinkHunt && WinkHunt.configured());
    $("mark-share").value = "";
    $("mark-share").disabled = !canShare;
    $("mark-share-hint").textContent = canShare
      ? "Only the position, date, detector and type are shared, never your label."
      : "Sharing on the community map isn't set up yet.";
    $("mark-text").focus();
  }

  function saveMark(label) {
    const p = S.pendingMark;
    if (!p) return;
    const cur = S.frames[S.i];
    const share = $("mark-share").disabled ? "" : $("mark-share").value;
    const q = stateParams();
    q.set("ra", p.ra.toFixed(6));
    q.set("dec", p.dec.toFixed(6));
    q.delete("name");
    const link = location.origin + location.pathname + "?" + q.toString();
    S.marks.push({
      id: Date.now().toString(36),
      label: label || "Unlabelled spot",
      ra: +p.ra.toFixed(6), dec: +p.dec.toFixed(6),
      date: cur.date, mjd: cur.mjd, detector: String(cur.detector),
      fov_arcmin: +(S.fov * 60).toFixed(1),
      field: S.name || S.res.patch.name || "",
      simulated: !!S.res.patch.simulated,
      link,
      wiseview: wiseviewURL(p.ra, p.dec),
      nearby: nearbySources(p.ra, p.dec),
      layers: S.layers.slice(),
      credits: creditsUsed(),
      created: new Date().toISOString(),
    });
    storageSet(MARKS_KEY, S.marks);
    cancelMark();
    renderMarks();
    renderCanvas();
    if (!share) {
      toast("Mark saved");
      return;
    }
    const mark = S.marks[S.marks.length - 1];
    toast("Saved. Sharing it… (our server can take a minute to wake up)");
    WinkHunt.share({ ra: mark.ra, dec: mark.dec, label: share, patch: S.res.patch.id, mjd: mark.mjd, detector: mark.detector })
      .then(() => {
        mark.shared = share;
        storageSet(MARKS_KEY, S.marks);
        renderMarks();
        toast("Shared on the community map. Thanks!");
        loadCommunity(true);
      }, (e) => toast(e.message));
  }

  function renderMarks() {
    const ul = $("marks");
    ul.textContent = "";
    if (!S.marks.length) {
      ul.appendChild(el("li", { class: "muted" }, "Nothing marked yet. Your marks stay in this browser."));
      return;
    }
    S.marks.forEach((m, j) => {
      const li = el("li");
      const go = el("a", { href: m.link, class: "mark-go" });
      go.appendChild(el("strong", null, m.label));
      if (m.shared && window.WinkHunt && WinkHunt.LABELS[m.shared]) {
        go.appendChild(el("span", { class: "tiny muted" }, "Shared as " + WinkHunt.LABELS[m.shared].name.toLowerCase()));
      }
      go.appendChild(el("span", { class: "muted" }, fmtRA(m.ra) + " " + fmtDec(m.dec) + " · " + m.date));
      li.appendChild(go);
      li.appendChild(el("button", {
        type: "button", class: "btn small icon", "aria-label": "Delete mark " + m.label,
        onclick: () => { S.marks.splice(j, 1); storageSet(MARKS_KEY, S.marks); renderMarks(); renderCanvas(); },
      }, "✕"));
      ul.appendChild(li);
    });
  }

  function reportText() {
    const lines = ["Wink find report", "Made " + new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC", ""];
    if (!S.marks.length) lines.push("No marks yet.");
    const credits = new Set();
    S.marks.forEach((m, j) => {
      lines.push((j + 1) + ". " + m.label + (m.simulated ? " (simulated test data)" : ""));
      lines.push("   Position: RA " + fmtRA(m.ra) + " (" + m.ra.toFixed(6) + "°), Dec " + fmtDec(m.dec) + " (" + m.dec.toFixed(6) + "°)");
      lines.push("   Date: " + m.date + " (MJD " + m.mjd.toFixed(2) + "), " + (m.detector === "all" ? "all detectors" : "detector " + m.detector));
      lines.push("   Field of view: " + m.fov_arcmin + "′" + (m.field ? " around " + m.field : ""));
      lines.push("   Wink: " + m.link);
      lines.push("   WiseView: " + m.wiseview);
      if (!m.layers.length) lines.push("   Nearby catalogue sources: no catalogues were loaded");
      else if (!m.nearby.length) lines.push("   Nearby catalogue sources: none within 15″ in " + m.layers.map((l) => LAYER_NAMES[l]).join(" or "));
      else lines.push("   Nearby catalogue sources: " + m.nearby.map((n) => n.catalogue + " " + n.label + " at " + n.sep_arcsec + "″" + (n.mag !== null ? " (mag " + n.mag + ")" : "")).join("; "));
      lines.push("");
      m.credits.forEach((c) => credits.add(c));
    });
    if (credits.size) {
      lines.push("Data used:");
      credits.forEach((c) => lines.push("- " + c));
    }
    return lines.join("\n");
  }

  // ---- events ----

  function fillForm() {
    $("in-ra").value = S.ra !== null ? (+S.ra.toFixed(6)).toString() : "";
    $("in-dec").value = S.dec !== null ? (+S.dec.toFixed(6)).toString() : "";
    const sel = $("in-fov");
    sel.textContent = "";
    let matched = false;
    for (const o of FOV_OPTIONS) {
      const opt = el("option", { value: String(+o.deg.toFixed(6)) }, o.label);
      if (Math.abs(o.deg - S.fov) / o.deg < 0.02) { opt.selected = true; matched = true; S.fov = o.deg; }
      sel.appendChild(opt);
    }
    if (!matched) sel.appendChild(el("option", { value: String(S.fov), selected: "" }, fmtFov(S.fov)));
    $("in-speed").value = String(S.speed);
    $("in-ref").value = S.ref;
    for (const r of document.querySelectorAll("input[name=mode]")) r.checked = r.value === S.mode;
  }

  async function buildChips() {
    const box = $("chips");
    box.textContent = "";
    box.appendChild(el("span", { class: "chips-label" }, "Challenge targets:"));
    const add = (t, tag, simulated) => {
      const b = el("button", { type: "button", class: "chip" + (simulated ? " chip-sim" : "") });
      b.appendChild(document.createTextNode(t.name));
      b.appendChild(el("span", { class: "chip-tag" }, tag));
      b.addEventListener("click", () => {
        S.ra = t.ra; S.dec = t.dec; S.fov = t.fov; S.name = t.name;
        S.det = t.det || "all";
        S.measure = null;
        fillForm();
        load();
      });
      box.appendChild(b);
    };
    for (const t of TARGETS) add(t, t.tag, false);
    try {
      const list = await SkyData.patchList();
      for (const p of list.filter((x) => x.simulated)) {
        add({ name: p.title || p.id, ra: p.ra, dec: p.dec, fov: Math.min(p.fov_deg, 15 / 60) }, "simulated", true);
      }
    } catch (e) { /* chips for pre-built extras are optional */ }
  }

  function canvasPoint(ev) {
    const r = canvas.getBoundingClientRect();
    return canvasToPatch((ev.clientX - r.left) * canvas.width / r.width, (ev.clientY - r.top) * canvas.height / r.height);
  }

  function centrePoint() {
    return G.skyToPix(S.res.patch, S.ra, S.dec);
  }

  function measureAt(x, y) {
    const [ra, dec] = G.pixToSky(S.res.patch, x, y);
    S.measure = { x, y, ra, dec };
    renderCanvas();
    renderInfo();
    renderStarInfo();
    renderChart();
  }

  function onHover(ev) {
    if (!S.res || !S.frames.length) return;
    const [x, y] = canvasPoint(ev);
    const [ra, dec] = G.pixToSky(S.res.patch, x, y);
    const cur = S.frames[S.i];
    const px = pixOf(cur.url), fl = pixOf(cur.flags_url);
    const xi = Math.round(x), yi = Math.round(y);
    let value = "outside the data";
    if (px && xi >= 0 && yi >= 0 && xi < px.w && yi < px.h) {
      const k = yi * px.w + xi;
      const g = px.data[k];
      value = "level " + g + " of 255 · ≈ " + fmtNum(physLUT(stretchOf(cur))[g]) + " MJy/sr" + (fl && fl.data[k] ? " · flagged" : "");
    }
    setKV("cursor-info", [
      ["RA", fmtRA(ra), ra.toFixed(5) + "°"],
      ["Dec", fmtDec(dec), dec.toFixed(5) + "°"],
      ["Pixel", "x " + xi + ", y " + yi],
      ["Value", value],
    ]);
  }

  function bind() {
    $("search-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const ra = parseRA($("in-ra").value), dec = parseDec($("in-dec").value);
      $("in-ra").setCustomValidity(isFinite(ra) && ra >= 0 && ra < 360 ? "" : "RA should be 0–360 degrees, or hours like 17h57m47s.");
      $("in-dec").setCustomValidity(isFinite(dec) && dec >= -90 && dec <= 90 ? "" : "Dec should be −90 to +90 degrees, like -7d14m42s.");
      if (!e.target.reportValidity()) return;
      S.ra = ra; S.dec = dec; S.fov = parseFloat($("in-fov").value);
      S.name = "";
      S.measure = null;
      load();
    });
    for (const id of ["in-ra", "in-dec"]) $(id).addEventListener("input", () => $(id).setCustomValidity(""));
    $("in-fov").addEventListener("change", () => {
      S.fov = parseFloat($("in-fov").value);
      if (S.ra !== null) load();
    });

    $("btn-copy-link").addEventListener("click", () => copyText(shareURL(), "Link"));
    $("btn-copy-embed").addEventListener("click", () => {
      const src = shareURL({ embed: "1" }).replace(/&/g, "&amp;");
      copyText('<iframe src="' + src + '" width="640" height="720" style="border:0" title="Wink: SPHEREx blink viewer" loading="lazy"></iframe>', "Embed code");
    });

    $("btn-play").addEventListener("click", togglePlay);
    $("btn-prev").addEventListener("click", () => step(-1));
    $("btn-next").addEventListener("click", () => step(1));
    $("in-speed").addEventListener("change", () => {
      S.speed = clamp(parseInt($("in-speed").value, 10) || 2, 1, MAX_SWAPS_PER_S);
      if (S.playing) { stopPlay(); startPlay(); }
      writeURL();
    });
    $("in-time").addEventListener("input", () => requestFrame(parseInt($("in-time").value, 10)));

    for (const r of document.querySelectorAll("input[name=mode]")) {
      r.addEventListener("change", () => {
        S.mode = r.value;
        if (S.mode === "add") stopPlay();
        renderAll();
      });
    }
    $("in-ref").addEventListener("change", () => { S.ref = $("in-ref").value; renderAll(); });
    $("in-det").addEventListener("change", () => setDetector($("in-det").value));

    $("ly-flags").addEventListener("change", () => { S.flags = $("ly-flags").checked; renderCanvas(); renderInfo(); writeURL(); });
    $("ly-gaia").addEventListener("change", () => { S.gaia = $("ly-gaia").checked; renderCanvas(); writeURL(); });
    $("ly-wise").addEventListener("change", () => { S.wise = $("ly-wise").checked; renderCanvas(); writeURL(); });
    $("ly-tmass").addEventListener("change", () => { S.tmass = $("ly-tmass").checked; renderCanvas(); writeURL(); });
    $("ly-track").addEventListener("change", () => { S.track = $("ly-track").checked; renderCanvas(); writeURL(); });
    $("ly-community").addEventListener("change", () => { S.community = $("ly-community").checked; renderCanvas(); writeURL(); });

    $("adj-bright").addEventListener("input", () => { S.adj.bright = +$("adj-bright").value; renderCanvas(); });
    $("adj-contrast").addEventListener("input", () => { S.adj.contrast = +$("adj-contrast").value / 100; renderCanvas(); });
    $("adj-invert").addEventListener("change", () => { S.adj.invert = $("adj-invert").checked; renderCanvas(); });
    $("adj-cross").addEventListener("change", () => { S.adj.cross = $("adj-cross").checked; renderCanvas(); });
    $("adj-reset").addEventListener("click", () => {
      S.adj = { bright: 0, contrast: 1, invert: false, cross: false };
      $("adj-bright").value = "0"; $("adj-contrast").value = "100";
      $("adj-invert").checked = false; $("adj-cross").checked = false;
      renderCanvas();
    });

    $("pred-circle").addEventListener("change", () => { S.circleAll = $("pred-circle").checked; renderCanvas(); });

    $("btn-chart-table").addEventListener("click", () => {
      S.chartTable = !S.chartTable;
      $("btn-chart-table").setAttribute("aria-pressed", String(S.chartTable));
      $("btn-chart-table").textContent = S.chartTable ? "Chart view" : "Table view";
      renderChart();
    });
    $("btn-back-target").addEventListener("click", () => { S.measure = null; renderCanvas(); renderInfo(); renderStarInfo(); renderChart(); });

    $("btn-download").addEventListener("click", () => {
      if (!S.res) { toast("Load an image first"); return; }
      const cur = S.frames[S.i];
      const name = "wink_" + (S.res.patch.id || "patch") + "_" + (S.mode === "add" ? "all-dates" : cur.date) + "_det-" + cur.detector + (S.mode === "sub" ? "_diff" : "") + ".png";
      canvas.toBlob((b) => { if (b) download(name, b); }, "image/png");
    });

    $("btn-mark").addEventListener("click", () => (S.marking ? cancelMark() : startMark()));
    $("mark-cancel").addEventListener("click", cancelMark);
    $("mark-label").addEventListener("submit", (e) => { e.preventDefault(); saveMark($("mark-text").value.trim()); });
    $("btn-report-copy").addEventListener("click", () => copyText(reportText(), "Report"));
    $("btn-report-txt").addEventListener("click", () => download("wink_report.txt", new Blob([reportText()], { type: "text/plain" })));
    $("btn-report-json").addEventListener("click", () => {
      const body = { tool: "Wink", made: new Date().toISOString(), marks: S.marks, text: reportText() };
      download("wink_report.json", new Blob([JSON.stringify(body, null, 2)], { type: "application/json" }));
    });

    canvas.addEventListener("mousemove", onHover);
    canvas.addEventListener("click", (ev) => {
      if (!S.res || !S.frames.length) return;
      const [x, y] = canvasPoint(ev);
      if (S.marking) placeMark(x, y); else measureAt(x, y);
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && (S.marking || !$("mark-label").hidden)) { cancelMark(); return; }
      const t = e.target;
      if (t !== canvas && t.closest && t.closest("input, select, textarea, button, a, [contenteditable]")) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === " " || e.key === "Spacebar") { e.preventDefault(); togglePlay(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
      else if (e.key === "Enter" && S.res) {
        e.preventDefault();
        const [x, y] = centrePoint();
        if (S.marking) placeMark(x, y); else measureAt(x, y);
      }
    });

    if ("ResizeObserver" in window) new ResizeObserver(() => resizeCanvas()).observe($("stage"));
    else window.addEventListener("resize", resizeCanvas);
  }

  function init() {
    readURL();
    S.marks = storageGet(MARKS_KEY, []);
    if (!Array.isArray(S.marks)) S.marks = [];
    if (S.embed) {
      document.body.classList.add("embed");
      $("embed-link").hidden = false;
    }
    fillForm();
    bind();
    buildChips();
    $("pred-circle").checked = false;
    resizeCanvas();
    renderAll();
    load();
    loadCommunity();
  }

  init();
})();
