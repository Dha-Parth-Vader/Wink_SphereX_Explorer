(function () {
  "use strict";

  const G = SkyData.geometry;
  const $ = (id) => document.getElementById(id);
  const { el } = window.Wink;

  const MAX_SWAPS_PER_S = 3;
  const SR_UJY = (6.15 / 206264.806) ** 2 * 1e12;   // µJy per (MJy/sr x one pixel)
  const PSF_SIGMA = 0.85;                            // px; about 12″ FWHM
  const NEA = 4 * Math.PI * PSF_SIGMA ** 2;          // noise-equivalent area of a point source, px
  const DET_RANGE = { 1: [0.75, 1.09], 2: [1.10, 1.62], 3: [1.63, 2.41], 4: [2.42, 3.82], 5: [3.83, 4.41], 6: [4.42, 5.00] };
  const DETS = ["1", "2", "3", "4", "5", "6"];

  // Sunlight at 1 AU in each detector (µJy): a 5772 K blackbody filling the Sun's disc
  const SUN_UJY = {};
  (function () {
    const h = 6.62607e-34, c = 2.99792e8, k = 1.380649e-23;
    const omega = Math.PI * (6.957e8 / 1.495979e11) ** 2;
    for (const d of DETS) {
      const um = Math.sqrt(DET_RANGE[d][0] * DET_RANGE[d][1]);
      const nu = c / (um * 1e-6);
      const b = 2 * h * nu ** 3 / c ** 2 / Math.expm1(h * nu / (k * 5772));
      SUN_UJY[d] = b * omega * 1e32;
    }
  })();
  const EARTH_RADIUS_AU = 6.371e6 / 1.495979e11;

  // Real cold worlds measured by our own pipeline (median µJy per detector). Below our noise counts as 0.
  const TWINS = {
    y: { name: "WISE 1405+5534", ly: 20.6, flux: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 321, 6: 338 } },
    t: { name: "Gliese 570 D", ly: 19.2, flux: { 1: 0, 2: 304, 3: 139, 4: 162, 5: 3030, 6: 1907 } },
  };

  const S = {
    mode: "planet", au: 300, re: 4, albedo: 0.3, twin: "y", ly: 20, pm: 1, pa: 60,
    field: null, det: "2", res: null, frames: [], i: 0, base: new Map(),
    anchor: null, hidden: false, reveal: true, found: false,
    playing: false, timer: null, lastSwap: -Infinity, token: 0,
  };

  // ---- sliders on a log scale ----
  const logSlider = (lo, hi) => ({
    to: (v) => Math.round(Math.log(v / lo) / Math.log(hi / lo) * 100),
    from: (s) => lo * (hi / lo) ** (s / 100),
  });
  const AU_SCALE = logSlider(30, 3000);
  const LY_SCALE = logSlider(4, 200);

  function fmt(v) {
    if (!isFinite(v)) return "–";
    if (v >= 1e6) return (v / 1e6).toLocaleString("en-US", { maximumFractionDigits: 1 }) + " million";
    if (v > 0 && v < 0.1) return v < 0.001 ? "less than 0.001" : String(+v.toPrecision(1));
    return v.toLocaleString("en-US", { maximumFractionDigits: v >= 100 ? 0 : v >= 10 ? 1 : 2 });
  }
  function mjdYear(mjd) { return 2000 + (mjd - 51544.5) / 365.25; }
  function mjdDate(mjd) { return new Date(Math.round((mjd - 40587) * 864e5)).toISOString().slice(0, 10); }

  // ---- geometry: ecliptic vectors (AU) ----
  const EPS = 23.4393 * Math.PI / 180;
  const D2R = Math.PI / 180;

  function earthAt(mjd) {
    const n = mjd + 2400000.5 - 2451545.0;
    const g = (357.528 + 0.9856003 * n) * D2R;
    const lamSun = (280.460 + 0.9856474 * n) * D2R + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R;
    const r = 1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g);
    return [-r * Math.cos(lamSun), -r * Math.sin(lamSun), 0];
  }

  function eqToEcl(ra, dec) {
    const a = ra * D2R, d = dec * D2R;
    const x = Math.cos(d) * Math.cos(a), y = Math.cos(d) * Math.sin(a), z = Math.sin(d);
    return [x, y * Math.cos(EPS) + z * Math.sin(EPS), -y * Math.sin(EPS) + z * Math.cos(EPS)];
  }

  function eclToEq(v) {
    const [x, y0, z0] = v;
    const y = y0 * Math.cos(EPS) - z0 * Math.sin(EPS), z = y0 * Math.sin(EPS) + z0 * Math.cos(EPS);
    const r = Math.hypot(x, y, z);
    let ra = Math.atan2(y, x) / D2R;
    if (ra < 0) ra += 360;
    return [ra, Math.asin(z / r) / D2R];
  }

  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  // A planet on a circular orbit that is seen at the anchor position on the first date
  function planetOrbit() {
    const t0 = S.frames[0].mjd;
    const u = eqToEcl(S.anchor.ra, S.anchor.dec);
    const e0 = earthAt(t0);
    const eu = dot(e0, u);
    const along = -eu + Math.sqrt(eu * eu - dot(e0, e0) + S.au * S.au);
    const p0 = [e0[0] + along * u[0], e0[1] + along * u[1], e0[2] + along * u[2]];
    const lon0 = Math.atan2(p0[1], p0[0]), lat = Math.asin(p0[2] / S.au);
    const rate = 2 * Math.PI / S.au ** 1.5 / 365.25;   // radians per day, prograde
    return (mjd) => {
      const lon = lon0 + rate * (mjd - t0);
      const p = [S.au * Math.cos(lat) * Math.cos(lon), S.au * Math.cos(lat) * Math.sin(lon), S.au * Math.sin(lat)];
      const e = earthAt(mjd);
      const g = [p[0] - e[0], p[1] - e[1], p[2] - e[2]];
      const [ra, dec] = eclToEq(g);
      return { ra, dec, delta: Math.hypot(...g) };
    };
  }

  // Where the object is and how bright it is (µJy per detector) on a given date
  function objectAt(mjd, orbit) {
    if (S.mode === "planet") {
      const o = orbit(mjd);
      const flux = {};
      const area = (S.re * EARTH_RADIUS_AU) ** 2;
      for (const d of DETS) flux[d] = SUN_UJY[d] * S.albedo * area / (S.au ** 2 * o.delta ** 2);
      return { ra: o.ra, dec: o.dec, flux };
    }
    const dt = mjdYear(mjd) - mjdYear(S.frames[0].mjd);
    const pa = S.pa * D2R;
    const dec = S.anchor.dec + S.pm * Math.cos(pa) * dt / 3600;
    const ra = S.anchor.ra + S.pm * Math.sin(pa) * dt / 3600 / Math.cos(S.anchor.dec * D2R);
    const twin = TWINS[S.twin];
    const scale = (twin.ly / S.ly) ** 2;
    const flux = {};
    for (const d of DETS) flux[d] = twin.flux[d] * scale;
    return { ra, dec, flux };
  }

  // the "all detectors" picture is the mean of the six detector pictures
  function fluxIn(flux, det) {
    if (det !== "all") return flux[det];
    return DETS.reduce((s, d) => s + flux[d], 0) / DETS.length;
  }

  function noiseOf(f) {
    return (f.stretch && f.stretch.knee > 0 ? f.stretch.knee / 4 : NaN);   // R18: knee = 4 x sky noise
  }
  function limitOf(f) {
    return 5 * noiseOf(f) * Math.sqrt(NEA) * SR_UJY;
  }

  // ---- pixels ----
  const scratch = document.createElement("canvas");
  const sctx = scratch.getContext("2d", { willReadFrequently: true });

  function baseOf(f) {
    if (S.base.has(f.url)) return S.base.get(f.url);
    const img = S.res.images[f.url];
    scratch.width = img.naturalWidth;
    scratch.height = img.naturalHeight;
    sctx.drawImage(img, 0, 0);
    const d = sctx.getImageData(0, 0, scratch.width, scratch.height).data;
    const g = new Uint8Array(scratch.width * scratch.height);
    for (let i = 0; i < g.length; i++) g[i] = d[i * 4];
    const out = { w: scratch.width, h: scratch.height, g };
    S.base.set(f.url, out);
    return out;
  }

  function stretchFns(st) {
    const knee = st.knee || 1, span = Math.asinh(Math.max(st.top - st.black, knee) / knee);
    return {
      toPhys: (g) => st.black + knee * Math.sinh(g / 255 * span),
      toGrey: (v) => Math.max(0, Math.min(255, Math.round(255 * Math.asinh(Math.max(0, v - st.black) / knee) / span))),
    };
  }

  function erf(x) {
    const t = 1 / (1 + 0.3275911 * Math.abs(x));
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return x >= 0 ? y : -y;
  }
  const cdf = (x) => 0.5 * (1 + erf(x / (PSF_SIGMA * Math.SQRT2)));

  // The frame with the object added: its light spread over nearby pixels, re-stretched like the real data
  function injected(f, pos, fluxUjy) {
    const b = baseOf(f);
    const g = new Uint8Array(b.g);
    if (pos && fluxUjy > 0) {
      const { toPhys, toGrey } = stretchFns(f.stretch);
      const total = fluxUjy / SR_UJY;
      const cx = Math.round(pos[0]), cy = Math.round(pos[1]);
      for (let y = cy - 4; y <= cy + 4; y++) {
        if (y < 0 || y >= b.h) continue;
        const fy = cdf(y + 0.5 - pos[1]) - cdf(y - 0.5 - pos[1]);
        for (let x = cx - 4; x <= cx + 4; x++) {
          if (x < 0 || x >= b.w) continue;
          const fx = cdf(x + 0.5 - pos[0]) - cdf(x - 0.5 - pos[0]);
          const k = y * b.w + x;
          g[k] = toGrey(toPhys(b.g[k]) + total * fx * fy);
        }
      }
    }
    return { w: b.w, h: b.h, g };
  }

  // An empty patch of sky on the first date, so the object isn't drawn on top of a real star
  function quietSpot(random) {
    const b = baseOf(S.frames[0]);
    const local = (cx, cy) => {
      let sum = 0, peak = 0;
      for (let y = cy - 3; y <= cy + 3; y++) for (let x = cx - 3; x <= cx + 3; x++) {
        const g = b.g[y * b.w + x];
        sum += g;
        peak = Math.max(peak, g);
      }
      return sum / 49 + peak;
    };
    const lo = Math.round(b.w * 0.2), hi = Math.round(b.w * 0.8);
    const spots = [];
    for (let y = lo; y < hi; y += 3) for (let x = lo; x < hi; x += 3) spots.push([x, y, local(x, y)]);
    spots.sort((a, c) => a[2] - c[2]);
    const pool = spots.slice(0, Math.max(1, Math.round(spots.length * (random ? 0.25 : 0.02))));
    const [x, y] = pool[random ? Math.floor(Math.random() * pool.length) : 0];
    return [x, y];
  }

  // ---- model for every date ----
  function model() {
    if (!S.res || !S.frames.length || !S.anchor) return [];
    const orbit = S.mode === "planet" ? planetOrbit() : null;
    const P = S.res.patch;
    return S.frames.map((f) => {
      const o = objectAt(f.mjd, orbit);
      const [x, y] = G.skyToPix(P, o.ra, o.dec);
      const inside = x >= -1 && y >= -1 && x <= P.width_px && y <= P.height_px;
      const flux = fluxIn(o.flux, S.det);
      const limit = limitOf(f);
      const snr = 5 * flux / limit;
      const offBy = inside ? 0 : Math.max(Math.abs(x - P.width_px / 2) - P.width_px / 2, Math.abs(y - P.height_px / 2) - P.height_px / 2) * P.pixel_scale_arcsec / 60;
      return { f, ra: o.ra, dec: o.dec, x, y, inside, flux, limit, snr, offBy };
    });
  }

  // ---- drawing ----
  const canvas = $("sim-canvas");
  const ctx = canvas.getContext("2d");
  const frameCanvas = document.createElement("canvas");
  const frameCtx = frameCanvas.getContext("2d");

  function render() {
    const rows = model();
    renderCanvas(rows);
    renderReadout(rows);
  }

  function renderCanvas(rows) {
    const size = Math.max(200, Math.min($("sim-stage").clientWidth, 640));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.style.width = canvas.style.height = size + "px";
    canvas.width = canvas.height = Math.round(size * dpr);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const f = S.frames[S.i];
    if (!f || !S.res.images[f.url]) return;
    const row = rows[S.i];
    const img = injected(f, row && row.inside ? [row.x, row.y] : null, row ? row.flux : 0);
    frameCanvas.width = img.w;
    frameCanvas.height = img.h;
    const id = frameCtx.createImageData(img.w, img.h);
    for (let i = 0; i < img.g.length; i++) {
      id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = img.g[i];
      id.data[i * 4 + 3] = 255;
    }
    frameCtx.putImageData(id, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(frameCanvas, 0, 0, canvas.width, canvas.height);

    if (row && row.inside && S.reveal && !S.hidden) {
      const s = canvas.width / img.w;
      ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--track").trim() || "#f5f56b";
      ctx.lineWidth = 1.5 * dpr;
      ctx.setLineDash([4 * dpr, 3 * dpr]);
      ctx.beginPath();
      ctx.arc((row.x + 0.5) * s, (row.y + 0.5) * s, Math.max(10 * dpr, 2.5 * s), 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    canvas.setAttribute("aria-label", "SPHEREx picture from " + f.date + (S.hidden ? " with a hidden simulated object" : " with a simulated object added") + ". Use the arrow keys to change date.");
    $("sim-caption").textContent = f.date + " · " + (S.det === "all" ? "all detectors" : "detector " + S.det) +
      " · date " + (S.i + 1) + " of " + S.frames.length + (row && !row.inside ? " · the object is outside this picture today" : "");
  }

  function verdictOf(r) {
    if (!r.inside) return ["out", "Not in this picture: it's about " + fmt(r.offBy) + "′ outside"];
    if (r.snr >= 5) return ["yes", "Should stand out"];
    if (r.snr >= 3) return ["maybe", "Barely, if you know where to look"];
    return ["no", "Too faint to see"];
  }

  function renderReadout(rows) {
    const box = $("sim-verdict"), tbody = $("sim-rows");
    tbody.textContent = "";
    if (!rows.length) {
      box.textContent = S.res ? "Click the picture to place the object, or press “Hide it somewhere”." : "Loading the pictures…";
      return;
    }
    for (const r of rows) {
      const [kind, text] = verdictOf(r);
      const tr = el("tr", { class: "v-" + kind });
      [r.f.date, fmt(r.flux), fmt(r.limit), r.inside ? fmt(r.snr) : "–", text].forEach((c) => tr.append(el("td", {}, c)));
      tbody.append(tr);
    }

    const inside = rows.filter((r) => r.inside);
    const best = inside.reduce((a, r) => (!a || r.snr > a.snr ? r : a), null);
    const where = S.det === "all" ? "all detectors" : "detector " + S.det + " (" + DET_RANGE[S.det][0] + "–" + DET_RANGE[S.det][1] + " µm)";
    const what = S.mode === "planet"
      ? "A planet " + fmt(S.re) + " times Earth's width, " + fmt(S.au) + " times farther from the Sun than Earth"
      : "A " + (S.twin === "y" ? "Y dwarf" : "T dwarf") + " like " + TWINS[S.twin].name + " at " + fmt(S.ly) + " light-years";
    const parts = [what + " would be about " + fmt(rows[0].flux) + " µJy in " + where + "."];
    if (!best) {
      parts.push("On every date it's outside this picture, so blinking these pictures can't show it.");
    } else {
      parts.push("These pictures can pick out about " + fmt(best.limit) + " µJy (5 times their own noise).");
      if (best.snr >= 5) parts.push("SPHEREx should see it.");
      else if (best.snr >= 3) parts.push("It's right at the edge: you could only pick it out if you knew where to look.");
      else {
        const need = best.limit / Math.max(best.flux, 1e-12);
        parts.push(S.mode === "planet"
          ? "SPHEREx couldn't see it here. It would need to be " + fmt(need ** 0.25) + " times closer, or " + fmt(need ** 0.5) + " times wider."
          : "SPHEREx couldn't see it here. It would need to be " + fmt(need ** 0.5) + " times closer.");
      }
      if (S.det !== "all" && S.mode === "cold" && rows[0].flux === 0) parts.push("Cold worlds give off almost no light at these short wavelengths. Try detector 5 or 6.");
      if (S.mode === "planet" && rows[0].flux > 0 && fluxIn(objectAt(S.frames[0].mjd, planetOrbit()).flux, "1") > rows[0].flux && S.det !== "1") {
        parts.push("Reflected sunlight is brightest in detector 1.");
      }
    }
    if (rows.length === 1) parts.push("This detector has only one date in this field, so there's nothing to blink. Try another detector or field.");
    if (rows.length > 1) {
      let jump = 0;
      for (let j = 1; j < rows.length; j++) jump = Math.max(jump, G.separation(rows[j - 1].ra, rows[j - 1].dec, rows[j].ra, rows[j].dec) * 60);
      parts.push(S.mode === "planet"
        ? "Between dates it jumps up to " + fmt(jump) + "′, mostly because Earth has moved around its orbit, not the planet."
        : "It moves " + fmt(S.pm) + "″ a year, about " + fmt(jump * 60 / 6.15) + " pixels between dates at most.");
    }
    box.textContent = parts.join(" ");
  }

  // ---- loading ----
  async function loadField() {
    const token = ++S.token;
    const entry = S.fields.find((p) => p.id === S.field);
    stopPlay();
    $("sim-verdict").textContent = "Loading the pictures…";
    try {
      const res = await SkyData.getPatch({ ra: entry.ra, dec: entry.dec, fov: entry.fov_deg, det: S.det, layers: [], source: "static" });
      if (token !== S.token) return;
      if (res.status !== "ok") throw new Error("no pictures for this field");
      await SkyData.loadImages(res, S.det);
      if (token !== S.token) return;
      S.res = res;
      S.base = new Map();
      S.frames = res.frames.filter((f) => String(f.detector) === S.det).sort((a, b) => a.mjd - b.mjd);
      S.i = 0;
      if (!S.anchor && S.frames.length) placeAt(...quietSpot(false), false);
      setupPlayer();
      render();
    } catch (e) {
      if (token === S.token) $("sim-verdict").textContent = "Couldn't load the pictures for this field. Check your connection and try again.";
    }
  }

  function placeAt(x, y, hidden) {
    const [ra, dec] = G.pixToSky(S.res.patch, x, y);
    S.anchor = { ra, dec };
    S.hidden = hidden;
    S.found = false;
    S.reveal = !hidden;
    S.i = 0;
    $("btn-reveal").setAttribute("aria-pressed", String(S.reveal));
    $("btn-reveal").textContent = S.hidden ? "Show where it is" : S.reveal ? "Hide the circle" : "Show where it is";
    $("sim-guess").textContent = hidden ? "It's hidden. Blink through the dates, then click where you think it is." : "";
  }

  // ---- player (R20: never autoplay, at most 3 swaps a second) ----
  function setupPlayer() {
    const one = S.frames.length < 2;
    for (const id of ["btn-prev", "btn-play", "btn-next"]) $(id).disabled = one;
  }
  function show(i) {
    const now = performance.now();
    if (now - S.lastSwap < 1000 / MAX_SWAPS_PER_S) return;
    S.lastSwap = now;
    S.i = (i + S.frames.length) % S.frames.length;
    render();
  }
  function startPlay() {
    if (S.frames.length < 2) return;
    S.playing = true;
    $("btn-play").textContent = "❚❚ Pause";
    $("btn-play").setAttribute("aria-pressed", "true");
    S.timer = setInterval(() => show(S.i + 1), 1000 / 2);
  }
  function stopPlay() {
    S.playing = false;
    clearInterval(S.timer);
    $("btn-play").textContent = "▶ Play";
    $("btn-play").setAttribute("aria-pressed", "false");
  }

  // ---- controls ----
  function readControls() {
    S.mode = document.querySelector("input[name=sim-mode]:checked").value;
    S.au = AU_SCALE.from(+$("in-au").value);
    S.re = +$("in-re").value;
    S.albedo = +$("in-albedo").value;
    S.twin = $("in-twin").value;
    S.ly = LY_SCALE.from(+$("in-ly").value);
    S.pm = +$("in-pm").value;
    S.pa = +$("in-pa").value;
    $("planet-opts").hidden = S.mode !== "planet";
    $("cold-opts").hidden = S.mode !== "cold";
    $("out-au").textContent = fmt(S.au) + " AU" + (S.au >= 1000 ? " (" + fmt(S.au / 63241) + " light-years)" : "");
    $("out-re").textContent = fmt(S.re) + " × Earth";
    $("out-albedo").textContent = fmt(S.albedo);
    $("out-ly").textContent = fmt(S.ly) + " light-years";
    $("out-pm").textContent = fmt(S.pm) + "″ per year";
    $("out-pa").textContent = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][Math.round(S.pa / 45) % 8];
  }

  function bind() {
    for (const id of ["in-au", "in-re", "in-albedo", "in-twin", "in-ly", "in-pm", "in-pa"]) {
      $(id).addEventListener("input", () => { readControls(); render(); });
    }
    for (const r of document.querySelectorAll("input[name=sim-mode]")) {
      r.addEventListener("change", () => {
        readControls();
        const want = S.mode === "cold" ? "6" : "1";
        if ($("in-det").value !== want) { $("in-det").value = want; S.det = want; loadField(); } else render();
      });
    }
    $("in-field").addEventListener("change", () => { S.field = $("in-field").value; S.anchor = null; loadField(); });
    $("in-det").addEventListener("change", () => { S.det = $("in-det").value; loadField(); });
    $("btn-hide").addEventListener("click", () => {
      if (!S.res) return;
      placeAt(...quietSpot(true), true);
      render();
    });
    $("btn-reveal").addEventListener("click", () => {
      S.hidden = false;
      S.reveal = !S.reveal;
      $("btn-reveal").setAttribute("aria-pressed", String(S.reveal));
      $("btn-reveal").textContent = S.reveal ? "Hide the circle" : "Show where it is";
      render();
    });
    canvas.addEventListener("click", (ev) => {
      if (!S.res) return;
      const r = canvas.getBoundingClientRect();
      const P = S.res.patch;
      const x = (ev.clientX - r.left) / r.width * P.width_px - 0.5, y = (ev.clientY - r.top) / r.height * P.height_px - 0.5;
      if (S.hidden) {
        const row = model()[S.i];
        const hit = row && row.inside && Math.hypot(row.x - x, row.y - y) <= 2.5;
        $("sim-guess").textContent = hit
          ? (row.snr >= 3 ? "Found it! That's the simulated object." : "That's where it is, but it's too faint to really see. Lucky guess!")
          : "Not there. " + (row && row.inside && row.snr < 3 ? "(Honestly, it's too faint to find on this date.)" : "Keep blinking.");
        if (hit) { S.hidden = false; S.reveal = true; render(); }
        return;
      }
      placeAt(x, y, false);
      render();
    });
    $("btn-play").addEventListener("click", () => (S.playing ? stopPlay() : startPlay()));
    $("btn-prev").addEventListener("click", () => show(S.i - 1));
    $("btn-next").addEventListener("click", () => show(S.i + 1));
    canvas.addEventListener("keydown", (e) => {
      if (e.key === " ") { e.preventDefault(); S.playing ? stopPlay() : startPlay(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); show(S.i - 1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); show(S.i + 1); }
    });
    if ("ResizeObserver" in window) new ResizeObserver(() => render()).observe($("sim-stage"));
  }

  async function init() {
    $("in-au").value = AU_SCALE.to(S.au);
    $("in-ly").value = LY_SCALE.to(S.ly);
    readControls();
    bind();
    try {
      S.fields = (await SkyData.patchList()).filter((p) => !p.simulated);
    } catch (e) {
      $("sim-verdict").textContent = "Couldn't load the list of fields.";
      return;
    }
    const sel = $("in-field");
    for (const p of S.fields) sel.append(el("option", { value: p.id }, p.title));
    S.field = S.fields.some((p) => p.id === "wise0855") ? "wise0855" : S.fields[0].id;
    sel.value = S.field;
    S.det = $("in-det").value;
    loadField();
  }

  init();
})();
