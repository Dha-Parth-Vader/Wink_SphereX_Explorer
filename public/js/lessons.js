// Hands-on lessons for the Education page. Every picture and number comes from our pre-built targets via
// data-source.js; nothing plays by itself, and blinking is capped at 3 swaps a second like the viewer.
(function () {
  "use strict";
  const { el } = window.Wink;
  const G = window.SkyData.geometry;
  const holder = document.getElementById("chapters");
  const navList = document.getElementById("chapter-nav");
  if (!holder || !window.SkyData) return;

  const SCALE = 6.15;
  const MIN_SWAP_MS = 1000 / 3;
  const DET_RANGE = { 1: [0.75, 1.09], 2: [1.10, 1.62], 3: [1.63, 2.41], 4: [2.42, 3.82], 5: [3.83, 4.41], 6: [4.42, 5.00] };
  const DET_COLOURS = ["--det1", "--det2", "--det3", "--det4", "--det5", "--det6"];
  const CREDIT = "Images: NASA/JPL-Caltech SPHEREx via IRSA.";

  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#fff"; }
  function mjdYear(mjd) { return 2000 + (mjd - 51544.5) / 365.25; }
  function propagate(s, epoch, year) {
    const dt = year - epoch;
    return [s.ra + (s.pmra || 0) / 3.6e6 / Math.cos(s.dec * Math.PI / 180) * dt, s.dec + (s.pmdec || 0) / 3.6e6 * dt];
  }
  function median(a) {
    const s = a.filter(isFinite).sort((x, y) => x - y);
    return s.length ? s[s.length >> 1] : NaN;
  }
  function fmt(v, digits) { return v.toLocaleString("en-US", { maximumFractionDigits: digits ?? 1 }); }

  const patchCache = new Map();
  function loadPatch(id, det) {
    const key = id + "|" + det;
    if (!patchCache.has(key)) {
      patchCache.set(key, (async () => {
        const entry = (await window.SkyData.patchList()).find((p) => p.id === id);
        if (!entry) throw new Error("missing " + id);
        const res = await window.SkyData.getPatch({ ra: entry.ra, dec: entry.dec, fov: entry.fov_deg, source: "static", layers: ["gaia"] });
        const dets = Array.isArray(det) ? det : [det];
        for (const d of dets) await window.SkyData.loadImages(res, d);
        return res;
      })());
    }
    return patchCache.get(key);
  }

  const grayCache = new WeakMap();
  function grayOf(img) {
    if (grayCache.has(img)) return grayCache.get(img);
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const out = new Float32Array(c.width * c.height);
    for (let i = 0; i < out.length; i++) out[i] = d[i * 4];
    const res = { w: c.width, h: c.height, v: out };
    grayCache.set(img, res);
    return res;
  }

  // the PNGs hold an asinh stretch that differs per detector; undo it to get MJy/sr back
  function physical(frame, img) {
    const g = grayOf(img), st = frame.stretch;
    const knee = st.knee || 1, span = Math.asinh(Math.max(st.top - st.black, knee) / knee);
    const v = new Float32Array(g.v.length);
    for (let i = 0; i < v.length; i++) v[i] = st.black + knee * Math.sinh(g.v[i] / 255 * span);
    return { w: g.w, h: g.h, v };
  }

  // draws an n x n crop starting at (x0, y0) from a {w, h, v} image; tone(v) returns 0..255
  function drawCrop(canvas, img, x0, y0, n, tone, rgb) {
    const ctx = canvas.getContext("2d");
    const small = document.createElement("canvas");
    small.width = n; small.height = n;
    const sc = small.getContext("2d");
    const data = sc.createImageData(n, n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const sx = x0 + x, sy = y0 + y, o = (y * n + x) * 4;
        const inside = sx >= 0 && sy >= 0 && sx < img.w && sy < img.h;
        const t = inside ? tone(img.v[sy * img.w + sx]) : 0;
        data.data[o] = rgb ? rgb[0] * t / 255 : t;
        data.data[o + 1] = rgb ? rgb[1] * t / 255 : t;
        data.data[o + 2] = rgb ? rgb[2] * t / 255 : t;
        data.data[o + 3] = 255;
      }
    }
    sc.putImageData(data, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(small, 0, 0, n, n, 0, 0, canvas.width, canvas.height);
  }

  // Prev / Play / Next for a short list of frames. Play is a toggle, never starts by itself, ≤ 3 swaps/s.
  function blinker(count, show, label) {
    let i = 0, timer = null;
    const play = el("button", { type: "button", class: "btn btn-sm", "aria-pressed": "false" }, "▶ Blink");
    const status = el("span", { class: "muted lesson-status", "aria-live": "polite" });
    const go = (k) => { i = (k + count()) % count(); show(i); status.textContent = label(i); };
    const stop = () => {
      clearInterval(timer); timer = null;
      play.setAttribute("aria-pressed", "false"); play.textContent = "▶ Blink";
    };
    const toggle = () => {
      if (timer) return stop();
      timer = setInterval(() => go(i + 1), Math.max(MIN_SWAP_MS, 500));
      play.setAttribute("aria-pressed", "true"); play.textContent = "❚❚ Pause";
    };
    play.addEventListener("click", toggle);
    const prev = el("button", { type: "button", class: "btn btn-sm", "aria-label": "Previous date" }, "◀");
    const next = el("button", { type: "button", class: "btn btn-sm", "aria-label": "Next date" }, "▶");
    prev.addEventListener("click", () => { stop(); go(i - 1); });
    next.addEventListener("click", () => { stop(); go(i + 1); });
    return {
      node: el("div", { class: "lesson-controls" }, [prev, play, next, status]),
      go, stop, toggle, get index() { return i; },
    };
  }

  function card(id, title, goal, paras, body) {
    return el("article", { class: "card lesson lesson-try", id, "aria-labelledby": id + "-title" }, [
      el("h3", { id: id + "-title" }, title),
      el("p", { class: "lesson-goal" }, [el("span", { class: "kicker" }, "Goal"), " " + goal]),
      ...paras.map((p) => el("p", {}, p)),
      body,
    ]);
  }

  function loading(box, promise, build) {
    box.textContent = "";
    box.append(el("p", { class: "muted" }, "Loading SPHEREx images…"));
    promise.then((res) => { box.textContent = ""; build(res); }, () => {
      box.textContent = "";
      box.append(el("p", { class: "muted" }, "Couldn't load the images for this lesson. Check your connection and reload."));
    });
  }

  function lazy(node, start) {
    if (!("IntersectionObserver" in window)) return start();
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { io.disconnect(); start(); }
    }, { rootMargin: "300px 0px" });
    io.observe(node);
  }

  function skyCanvas(label, size) {
    const c = el("canvas", { class: "lesson-canvas", width: String(size), height: String(size), role: "img", "aria-label": label });
    return c;
  }

  // ---- 1. Find the mover ----
  const ROUNDS = [
    { id: "barnard", pred: "m9", shift: [9, -7], name: "Barnard's Star", note: "the fastest-moving star in our sky" },
    { id: "epsindib", pred: "m15", shift: [-8, 6], name: "Epsilon Indi A", note: "a nearby sun-like star with a brown-dwarf companion" },
    { id: "gaia73009792", pred: "m6", shift: [7, 9], name: "Gaia DR3 1711005951573009792", note: "a faint nearby star most people have never heard of" },
  ];
  const N1 = 33;

  function moverLesson() {
    const box = el("div", { class: "lesson-body" });
    const node = card("lesson-mover", "Find the mover",
      "Spot a star that moves by blinking two real SPHEREx images, then check yourself against Gaia.",
      ["One star in this patch has crept across the sky between the two dates. Press Blink (or Space) and watch for a dot that jumps while the others stay still.",
        "Click it, or move the cross with the arrow keys and press Enter. Stuck? Tick Difference: a moving star leaves a dark spot where it was and a bright spot where it went."],
      box);
    lazy(node, () => startMover(box));
    return node;
  }

  function startMover(box) {
    let round = 0, score = 0;
    const canvas = skyCanvas("Zoomed SPHEREx patch. Arrow keys move the cross, Enter places your guess, Space blinks.", N1 * 10);
    canvas.tabIndex = 0;
    const diffBox = el("input", { type: "checkbox" });
    const result = el("p", { class: "lesson-result", "aria-live": "polite" });
    const check = el("button", { type: "button", class: "btn btn-primary btn-sm", disabled: true }, "Check my answer");
    const nextBtn = el("button", { type: "button", class: "btn btn-sm", hidden: true }, "Next patch →");
    const viewLink = el("a", { class: "btn btn-sm btn-ghost", hidden: true, href: "#" }, "Open in viewer");
    const hint = el("p", { class: "muted lesson-hint" });
    let st = null, bl = null;

    function draw() {
      if (!st) return;
      const { frames, imgs, x0, y0 } = st;
      const i = bl.index;
      if (diffBox.checked) {
        const a = imgs[imgs.length - 1], b = imgs[0];
        const v = new Float32Array(a.v.length);
        for (let k = 0; k < v.length; k++) v[k] = a.v[k] - b.v[k];
        drawCrop(canvas, { w: a.w, h: a.h, v }, x0, y0, N1, (t) => Math.max(0, Math.min(255, 128 + t * 1.5)));
      } else {
        drawCrop(canvas, imgs[i], x0, y0, N1, (t) => t);
      }
      const ctx = canvas.getContext("2d"), z = canvas.width / N1;
      const at = (x, y) => [(x - x0 + 0.5) * z, (y - y0 + 0.5) * z];
      if (st.answer) {
        ctx.strokeStyle = css("--gaia"); ctx.lineWidth = 2;
        const pts = frames.map((f) => at(...st.gaiaAt(f)));
        ctx.beginPath(); pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke();
        const [gx, gy] = pts[diffBox.checked ? pts.length - 1 : i];
        ctx.beginPath(); ctx.moveTo(gx, gy - 9); ctx.lineTo(gx + 9, gy); ctx.lineTo(gx, gy + 9); ctx.lineTo(gx - 9, gy); ctx.closePath(); ctx.stroke();
      }
      if (st.guess) {
        const [cx, cy] = at(...st.guess);
        ctx.strokeStyle = css("--mover"); ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx, cy, 11, 0, Math.PI * 2); ctx.stroke();
      }
      if (st.cursor && !st.answer) {
        const [cx, cy] = at(...st.cursor);
        ctx.strokeStyle = css("--warm"); ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(cx - 14, cy); ctx.lineTo(cx - 5, cy); ctx.moveTo(cx + 5, cy); ctx.lineTo(cx + 14, cy);
        ctx.moveTo(cx, cy - 14); ctx.lineTo(cx, cy - 5); ctx.moveTo(cx, cy + 5); ctx.lineTo(cx, cy + 14); ctx.stroke();
      }
    }

    async function startRound() {
      const R = ROUNDS[round];
      result.textContent = ""; nextBtn.hidden = true; viewLink.hidden = true; check.disabled = true;
      hint.textContent = "Patch " + (round + 1) + " of " + ROUNDS.length + " · 3.4′ across, zoomed 10×";
      st = null; if (bl) bl.stop();
      const res = await loadPatch(R.id, "all");
      const frames = res.frames.filter((f) => f.detector === "all").sort((a, b) => a.mjd - b.mjd);
      const pick = [frames[0], frames[frames.length - 1]];
      const pred = res.predictions.find((p) => p.id === R.pred);
      const gaia = res.overlays.gaia.find((s) => s.label === pred.match);
      const last = pred.track[pred.track.length - 1];
      const clamp = (v) => Math.max(0, Math.min(res.patch.width_px - N1, v));
      const x0 = clamp(Math.round(last.x) - (N1 >> 1) - R.shift[0]);
      const y0 = clamp(Math.round(last.y) - (N1 >> 1) - R.shift[1]);
      st = {
        res, R, frames: pick, x0, y0, guess: null, answer: false,
        imgs: pick.map((f) => grayOf(res.images[f.url])),
        cursor: [x0 + (N1 >> 1), y0 + (N1 >> 1)],
        gaiaAt: (f) => G.skyToPix(res.patch, ...propagate(gaia, gaia.epoch || 2016, mjdYear(f.mjd))),
        pm: Math.hypot(gaia.pmra, gaia.pmdec) / 1000,
      };
      viewLink.href = window.Wink.viewerUrl({ ra: res.patch.ra, dec: res.patch.dec, fov: res.patch.fov_deg, name: R.name });
      bl.go(0);
    }

    function place(x, y) {
      if (!st || st.answer) return;
      st.guess = [x, y]; st.cursor = [x, y]; check.disabled = false;
      result.textContent = "Guess placed. Press Check my answer when you're happy.";
      draw();
    }

    function reveal() {
      if (!st || !st.guess) return;
      st.answer = true; check.disabled = true;
      const shown = diffBox.checked ? st.frames.length - 1 : bl.index;
      const [gx, gy] = st.gaiaAt(st.frames[shown]);
      const px = Math.hypot(st.guess[0] - gx, st.guess[1] - gy);
      const hit = px <= 2.5;
      if (hit) score += 1;
      const years = mjdYear(st.frames[st.frames.length - 1].mjd) - mjdYear(st.frames[0].mjd);
      result.textContent = (hit ? "Found it! " : "Not quite. ") + "You were " + fmt(px * SCALE, 0) + "″ (" + fmt(px) +
        " pixels) from where Gaia puts it. It's " + st.R.name + ", " + st.R.note + ". It moves " + fmt(st.pm) +
        "″ a year, so in these " + fmt(years) + (fmt(years) === "1" ? " year" : " years") + " it shifted " + fmt(st.pm * years / SCALE) + " SPHEREx pixels. Score: " +
        score + " of " + (round + 1) + ".";
      nextBtn.hidden = false; viewLink.hidden = false;
      if (round === ROUNDS.length - 1) nextBtn.textContent = "Play again";
      draw();
    }

    canvas.addEventListener("click", (e) => {
      if (!st) return;
      const r = canvas.getBoundingClientRect();
      place(st.x0 + (e.clientX - r.left) / r.width * N1 - 0.5, st.y0 + (e.clientY - r.top) / r.height * N1 - 0.5);
    });
    canvas.addEventListener("keydown", (e) => {
      if (!st) return;
      const step = e.shiftKey ? 3 : 0.5;
      const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (moves[e.key] && !st.answer) {
        e.preventDefault();
        st.cursor = [Math.max(st.x0, Math.min(st.x0 + N1 - 1, st.cursor[0] + moves[e.key][0])),
          Math.max(st.y0, Math.min(st.y0 + N1 - 1, st.cursor[1] + moves[e.key][1]))];
        draw();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (st.guess && !st.answer && st.guess[0] === st.cursor[0] && st.guess[1] === st.cursor[1]) reveal();
        else place(...st.cursor);
      } else if (e.key === " ") {
        e.preventDefault(); bl.toggle();
      }
    });
    check.addEventListener("click", reveal);
    nextBtn.addEventListener("click", () => {
      round = (round + 1) % ROUNDS.length;
      if (round === 0) { score = 0; nextBtn.textContent = "Next patch →"; }
      startRound().catch(() => { result.textContent = "Couldn't load the next patch."; });
    });
    diffBox.addEventListener("change", draw);

    bl = blinker(() => 2, () => draw(), (i) => st ? "Date " + (i + 1) + " of 2 · " + st.frames[i].date : "");
    box.append(
      el("div", { class: "lesson-stage" }, [hint, canvas]),
      bl.node,
      el("div", { class: "lesson-controls" }, [el("label", { class: "check" }, [diffBox, el("span", {}, "Difference (last date minus first)")]), check, nextBtn, viewLink]),
      result,
      el("p", { class: "lesson-credit muted" }, CREDIT + " Answer positions: Gaia DR3 (ESA/Gaia/DPAC)."),
    );
    startRound().catch(() => { box.textContent = "Couldn't load the images for this lesson. Check your connection and reload."; });
  }

  // ---- 2. Wavelength slider ----
  function bandOf(b) {
    const det = Math.ceil(b / 17), ch = b - (det - 1) * 17 - 1;
    const [lo, hi] = DET_RANGE[det];
    return { det, um: lo * Math.pow(hi / lo, (ch + 0.5) / 17) };
  }

  function wavelengthLesson() {
    const box = el("div", { class: "lesson-body" });
    const node = card("lesson-wavelength", "Colours you can't see",
      "See why the coldest brown dwarfs only show up at the longest SPHEREx wavelengths.",
      ["Drag the slider through SPHEREx's 102 colours. The circle marks WISE 1405+5534, a brown dwarf. Ordinary stars are brightest at short wavelengths and fade as you go right; the brown dwarf does the opposite, and only appears in detectors 5 and 6.",
        "It is about 400 K, as warm as a hot oven, so it gives off almost no short-wavelength light. Methane and water in its air also block most of what it does give off, leaving a window near 4 to 5 µm."],
      box);
    lazy(node, () => loading(box, loadPatch("w1405", ["1", "2", "3", "4", "5", "6"]), (res) => buildWavelength(box, res)));
    return node;
  }

  function buildWavelength(box, res) {
    const N = 41;
    const pred = res.predictions.find((p) => /\(target\)/.test(p.label));
    const byVisit = {};
    for (const f of res.frames) if (f.detector !== "all") (byVisit[f.visit] = byVisit[f.visit] || {})[f.detector] = f;
    const visit = +Object.keys(byVisit).sort((a, b) => Object.keys(byVisit[b]).length - Object.keys(byVisit[a]).length || a - b)[0];
    const frames = byVisit[visit];
    const tp = pred.track.find((q) => q.visit === visit) || pred.track[0];
    const x0 = Math.round(tp.x) - (N >> 1), y0 = Math.round(tp.y) - (N >> 1);
    const phys = {};
    for (const d of Object.keys(frames)) phys[d] = physical(frames[d], res.images[frames[d].url]);
    // one shared stretch for all six detectors, so stars really fade and the brown dwarf really appears
    const crop = (img) => { const out = []; for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) out.push(img.v[(y0 + y) * img.w + x0 + x]); return out; };
    const pooled = Object.values(phys).flatMap(crop);
    const black = median(pooled);
    // the pipeline's knee is 4x each detector's sky noise; the PNGs are too coarse to measure noise again
    const knee = median(Object.values(frames).map((f) => f.stretch.knee)), top = Math.max(...crop(phys[1] || Object.values(phys)[0]).map((v) => v - black)) * 0.6;
    const span = Math.asinh(top / knee);
    const tone = (v) => Math.max(0, Math.min(255, Math.asinh(Math.max(0, v - black) / knee) / span * 255));

    // the brightest ordinary star in the crop, to put a number on the fading
    const p1 = phys[1] || Object.values(phys)[0];
    let best = { v: -Infinity, x: 0, y: 0 };
    for (let y = 2; y < N - 2; y++) for (let x = 2; x < N - 2; x++) {
      const v = p1.v[(y0 + y) * p1.w + x0 + x];
      if (v > best.v && Math.hypot(x0 + x - tp.x, y0 + y - tp.y) > 4) best = { v, x: x0 + x, y: y0 + y };
    }
    const peak = (img, x, y) => { let m = -Infinity; for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) m = Math.max(m, img.v[(Math.round(y) + j) * img.w + Math.round(x) + i]); return m - black; };
    const starRef = peak(p1, best.x, best.y);

    const spec = (res.spectrum || []).filter((p) => !p.saturated && isFinite(p.flux_ujy));
    const fluxAt = (um) => median(spec.filter((p) => Math.abs(p.wavelength_um - um) / um < 0.02).map((p) => p.flux_ujy));
    const bands = Array.from({ length: 102 }, (_, i) => ({ ...bandOf(i + 1), flux: fluxAt(bandOf(i + 1).um) }));
    const fmax = Math.max(...bands.map((b) => b.flux).filter(isFinite), 1);

    const canvas = skyCanvas("SPHEREx view of WISE 1405+5534 at the chosen wavelength", N * 8);
    const strip = el("canvas", { class: "lesson-strip", width: "612", height: "90", role: "img", "aria-label": "Brightness of WISE 1405+5534 in each of the 102 SPHEREx bands" });
    const slider = el("input", { type: "range", min: "1", max: "102", step: "1", value: "8", "aria-label": "SPHEREx band, 1 to 102" });
    const out = el("p", { class: "lesson-result", "aria-live": "polite" });

    function draw() {
      const b = +slider.value, info = bands[b - 1], img = phys[info.det];
      if (img) drawCrop(canvas, img, x0, y0, N, tone);
      const ctx = canvas.getContext("2d"), z = canvas.width / N;
      ctx.strokeStyle = css("--mover"); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc((tp.x - x0 + 0.5) * z, (tp.y - y0 + 0.5) * z, 16, 0, Math.PI * 2); ctx.stroke();
      if (!img) { ctx.fillStyle = css("--muted"); ctx.fillText("No image in this detector on this date", 10, 20); }

      const s = strip.getContext("2d"), W = strip.width, H = strip.height, bw = W / 102;
      s.clearRect(0, 0, W, H);
      bands.forEach((bd, i) => {
        s.fillStyle = css(DET_COLOURS[bd.det - 1]);
        s.globalAlpha = i === b - 1 ? 1 : 0.55;
        const h = isFinite(bd.flux) ? Math.max(1, Math.max(0, bd.flux) / fmax * (H - 16)) : 0;
        s.fillRect(i * bw + 0.5, H - 14 - h, bw - 1, h);
      });
      s.globalAlpha = 1;
      s.fillStyle = css("--text"); s.fillRect((b - 1) * bw, 0, bw, H - 14);
      s.globalAlpha = 0.25; s.fillRect((b - 1) * bw, 0, bw, H - 14); s.globalAlpha = 1;
      s.fillStyle = css("--muted"); s.font = "10px " + getComputedStyle(document.body).fontFamily;
      for (let d = 1; d <= 6; d++) s.fillText("D" + d, (d - 1) * 17 * bw + 2, H - 2);

      const star = img ? peak(img, best.x, best.y) : NaN;
      out.textContent = "Band " + b + " · " + fmt(info.um, 2) + " µm · detector " + info.det + ". WISE 1405: " +
        (isFinite(info.flux) ? fmt(Math.max(0, info.flux), 0) + " µJy" : "not measured") + ". The bright star nearby: " +
        (isFinite(star) && starRef > 0 ? fmt(100 * star / starRef, 0) + "% of its brightness at band 1." : "–");
    }
    slider.addEventListener("input", draw);
    box.append(
      el("div", { class: "lesson-stage" }, canvas),
      el("label", { class: "lesson-slider" }, ["Wavelength ", slider]),
      el("div", { class: "lesson-strip-wrap" }, strip),
      out,
      el("p", { class: "lesson-credit muted" }, CREDIT + " Dated " + frames[Object.keys(frames)[0]].date + ". All six detectors shown on one brightness scale."),
    );
    draw();
  }

  // ---- 3. Colour change ----
  function colourLesson() {
    const box = el("div", { class: "lesson-body" });
    const node = card("lesson-colour", "A star that changes colour",
      "See that a star can brighten at one wavelength while fading at another.",
      ["RW Aurigae is a young star still wrapped in a dusty disc. Blink the two views: on the left, detector 1 (about 1 µm); on the right, detector 6 (about 4.7 µm). Both use one brightness scale for every date, so changes are real.",
        "Between our dates it got brighter in short infrared and fainter in long infrared. One idea is that warm dust near the star thinned out: less dust glowing at long wavelengths, and less dust blocking the star's own light."],
      box);
    lazy(node, () => loading(box, loadPatch("rwaur", ["1", "6"]), (res) => buildColour(box, res)));
    return node;
  }

  function buildColour(box, res) {
    const N = 29;
    const visits = [...new Set(res.frames.map((f) => f.visit))].sort((a, b) => a - b);
    const get = (v, d) => res.frames.find((f) => f.visit === v && String(f.detector) === d);
    const dates = visits.filter((v) => get(v, "1") && get(v, "6"));
    const c = (res.patch.width_px - 1) / 2;
    const x0 = Math.round(c) - (N >> 1), y0 = Math.round(c) - (N >> 1);
    const left = skyCanvas("RW Aurigae in detector 1, about 1 micron", N * 8);
    const right = skyCanvas("RW Aurigae in detector 6, about 4.7 microns", N * 8);
    const chart = el("canvas", { class: "lesson-strip", width: "612", height: "200", role: "img" });

    // median brightness per detector per visit, from the pipeline's light curve
    const frameMjd = visits.map((v) => [v, median(res.frames.filter((f) => f.visit === v).map((f) => f.mjd))]);
    const visitOf = (mjd) => frameMjd.reduce((a, b) => (Math.abs(b[1] - mjd) < Math.abs(a[1] - mjd) ? b : a))[0];
    const table = {};
    for (const p of res.light_curve) {
      if (p.flagged || !isFinite(p.flux_ujy)) continue;
      const k = p.detector + "|" + visitOf(p.mjd);
      (table[k] = table[k] || []).push(p.flux_ujy);
    }
    const level = (d, v) => median(table[d + "|" + v] || []);

    function draw(i) {
      const v = dates[i];
      for (const [cv, d] of [[left, "1"], [right, "6"]]) {
        const f = get(v, d);
        drawCrop(cv, grayOf(res.images[f.url]), x0, y0, N, (t) => t);
      }
      const ctx = chart.getContext("2d"), W = chart.width, H = chart.height, mid = H / 2;
      ctx.clearRect(0, 0, W, H);
      ctx.strokeStyle = css("--line-strong"); ctx.beginPath(); ctx.moveTo(30, mid); ctx.lineTo(W - 4, mid); ctx.stroke();
      ctx.font = "12px " + getComputedStyle(document.body).fontFamily;
      const bw = (W - 40) / 6;
      const parts = [];
      for (let d = 1; d <= 6; d++) {
        const a = level(d, dates[0]), b = level(d, v);
        const ch = isFinite(a) && isFinite(b) && a > 0 ? (b / a - 1) * 100 : NaN;
        const h = isFinite(ch) ? Math.max(-1, Math.min(1, ch / 70)) * (mid - 22) : 0;
        ctx.fillStyle = css(DET_COLOURS[d - 1]);
        ctx.fillRect(34 + (d - 1) * bw + 6, h > 0 ? mid - h : mid, bw - 12, Math.abs(h));
        ctx.fillStyle = css("--text");
        ctx.textAlign = "center";
        ctx.fillText(isFinite(ch) ? (ch > 0 ? "+" : "") + fmt(ch, 0) + "%" : "–", 34 + (d - 0.5) * bw, h >= 0 ? mid - h - 6 : mid - h + 14);
        ctx.fillStyle = css("--muted");
        ctx.fillText("D" + d + " " + fmt((DET_RANGE[d][0] + DET_RANGE[d][1]) / 2, 1) + " µm", 34 + (d - 0.5) * bw, H - 4);
        if (isFinite(ch)) parts.push("detector " + d + " " + (ch > 0 ? "+" : "") + fmt(ch, 0) + "%");
      }
      ctx.textAlign = "start";
      chart.setAttribute("aria-label", i === 0 ? "Change since the first date: this is the first date" : "Change since " + get(dates[0], "1").date + ": " + parts.join(", "));
    }
    const bl = blinker(() => dates.length, draw, (i) => "Date " + (i + 1) + " of " + dates.length + " · " + get(dates[i], "1").date);
    box.append(
      el("div", { class: "lesson-pair" }, [
        el("figure", {}, [left, el("figcaption", { class: "muted" }, "Detector 1 · ~1 µm")]),
        el("figure", {}, [right, el("figcaption", { class: "muted" }, "Detector 6 · ~4.7 µm")]),
      ]),
      bl.node,
      el("p", { class: "muted lesson-hint" }, "Brightness change since the first date, by detector:"),
      el("div", { class: "lesson-strip-wrap" }, chart),
      el("p", { class: "lesson-credit muted" }, CREDIT + " RW Aur is bright enough to saturate some images, so these numbers are approximate."),
    );
    bl.go(dates.length - 1);
  }

  // ---- 4. Planet X ----
  function planetLesson() {
    const box = el("div", { class: "lesson-body" });
    const node = card("lesson-planetx", "Could SPHEREx catch Planet X?",
      "See why a far-away planet moves enough between SPHEREx visits to be noticed.",
      ["A planet far beyond Neptune barely moves along its own orbit. But we watch from Earth, which swings to the other side of the Sun every six months, so the planet seems to shift against the stars. The farther away it is, the smaller the shift.",
        "SPHEREx maps the whole sky every six months and sees each spot several times within a few days. Pick a distance and compare the shifts with one SPHEREx pixel (6.15″)."],
      box);
    lazy(node, () => buildPlanet(box));
    return node;
  }

  function buildPlanet(box) {
    const AU_DAY = 2 * Math.PI * 206265 / 365.25;
    const slider = el("input", { type: "range", min: "30", max: "1500", step: "10", value: "300", "aria-label": "Distance from the Sun in AU" });
    const chart = el("canvas", { class: "lesson-strip", width: "612", height: "190", role: "img" });
    const out = el("p", { class: "lesson-result", "aria-live": "polite" });
    const presets = el("div", { class: "lesson-controls" }, [50, 300, 1000].map((d) => {
      const b = el("button", { type: "button", class: "btn btn-sm" }, d + " AU");
      b.addEventListener("click", () => { slider.value = String(d); draw(); });
      return b;
    }));
    function draw() {
      const d = +slider.value;
      const half = 2 * 206265 / d;
      const orbit = 0.5 * 1296000 / Math.pow(d, 1.5);
      const day = AU_DAY / d;
      const rows = [
        ["One SPHEREx pixel", SCALE, "--muted"],
        ["In one day (Earth's motion)", day, "--accent"],
        ["In six months (Earth's motion)", half, "--warm"],
        ["In six months (its own orbit)", orbit, "--accent-2"],
        ["Width of a 15′ Wink patch", 900, "--line-strong"],
      ];
      const ctx = chart.getContext("2d"), W = chart.width, H = chart.height;
      ctx.clearRect(0, 0, W, H);
      ctx.font = "12px " + getComputedStyle(document.body).fontFamily;
      const L = 196, lo = Math.log10(0.5), hi = Math.log10(20000);
      const X = (v) => L + (Math.log10(Math.max(v, 0.5)) - lo) / (hi - lo) * (W - L - 8);
      ctx.strokeStyle = css("--line"); ctx.fillStyle = css("--muted");
      for (const t of [1, 10, 100, 1000, 10000]) {
        ctx.beginPath(); ctx.moveTo(X(t), 4); ctx.lineTo(X(t), H - 18); ctx.stroke();
        ctx.fillText(t >= 3600 ? fmt(t / 3600, 1) + "°" : t >= 60 ? fmt(t / 60, 1) + "′" : t + "″", X(t) - 6, H - 4);
      }
      rows.forEach(([label, v, colour], i) => {
        const y = 10 + i * 30;
        ctx.fillStyle = css("--text"); ctx.fillText(label, 0, y + 13);
        ctx.fillStyle = css(colour); ctx.fillRect(X(0.5), y + 2, X(v) - X(0.5), 16);
      });
      chart.setAttribute("aria-label", "Bar chart on a log scale comparing one pixel with how far a planet at " + d + " AU appears to move.");
      out.textContent = "At " + d + " AU, Earth's motion shifts it by up to " + fmt(half / SCALE, 0) + " pixels in six months (" +
        (half >= 3600 ? fmt(half / 3600, 1) + "°" : fmt(half / 60, 1) + "′") + "), and about " + fmt(day / SCALE, 1) +
        " pixels per day within one visit. Its own orbit adds " + fmt(orbit, 0) + "″. A dot that moves several pixels between nearby dates and isn't in any catalogue is worth a closer look.";
    }
    slider.addEventListener("input", draw);
    box.append(
      el("label", { class: "lesson-slider" }, ["Distance from the Sun ", slider]),
      presets,
      el("div", { class: "lesson-strip-wrap" }, chart),
      out,
      el("p", { class: "lesson-credit muted" }, "Largest shift, for a planet near the ecliptic. Pixel size 6.15″ from our SPHEREx images."),
    );
    draw();
  }

  // ---- 5. How we know it moved ----
  const BARNARD_PARALLAX = 0.54698;   // arcsec, Gaia DR3

  function sunXYZ(year) {
    const n = (year - 2000.0) * 365.25 - 0.5;
    const g = (357.528 + 0.9856003 * n) * Math.PI / 180;
    const lam = (280.46 + 0.9856474 * n + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * Math.PI / 180;
    const eps = 23.439 * Math.PI / 180;
    return [Math.cos(lam), Math.cos(eps) * Math.sin(lam), Math.sin(eps) * Math.sin(lam)];
  }

  function movedLesson() {
    const box = el("div", { class: "lesson-body" });
    const node = card("lesson-moved", "How we know it moved",
      "Tell apart a star's steady drift (proper motion) from its yearly wobble (parallax).",
      ["Barnard's Star drifts north by about 10.4″ a year: that's proper motion. On top of that it traces a small loop every year as Earth circles the Sun: that's parallax, and its size tells us the distance, 6 light years.",
        "Drag through time. The grey squares are SPHEREx pixels, the line is Gaia's prediction and the pink dots are where our pipeline measured the star. The loop is only a tenth of a pixel, so tick the box to make it 20 times bigger (the dashed line stays true size)."],
      box);
    lazy(node, () => loading(box, loadPatch("barnard", "all"), (res) => buildMoved(box, res)));
    return node;
  }

  function buildMoved(box, res) {
    const pred = res.predictions.find((p) => /\(target\)/.test(p.label));
    const gaia = res.overlays.gaia.find((s) => s.label === pred.match);
    const c = (res.patch.width_px - 1) / 2;
    const meas = pred.track.map((q) => ({ year: mjdYear(q.mjd), e: -(q.x - c) * SCALE, n: -(q.y - c) * SCALE }));
    const rad = (v) => v * Math.PI / 180;
    const a = rad(gaia.ra), d = rad(gaia.dec);
    const pos = (year, boost) => {
      const [ra, dec] = propagate(gaia, gaia.epoch || 2016, year);
      const [x, y, z] = sunXYZ(year);
      const p = BARNARD_PARALLAX * boost;
      const de = p * (x * Math.sin(a) - y * Math.cos(a));
      const dn = p * (x * Math.cos(a) * Math.sin(d) + y * Math.sin(a) * Math.sin(d) - z * Math.cos(d));
      const [xi, eta] = G.project(res.patch.ra, res.patch.dec, ra, dec);
      return { e: xi * 3600 + de, n: eta * 3600 + dn };
    };
    const t0 = 2025.0, t1 = 2027.0;
    const slider = el("input", { type: "range", min: "0", max: "730", step: "1", value: String(Math.round((meas[0].year - t0) * 365.25)), "aria-label": "Date between 2025 and 2027" });
    const boost = el("input", { type: "checkbox" });
    const canvas = el("canvas", { class: "lesson-plot", width: "420", height: "420", role: "img", "aria-label": "Path of Barnard's Star on the sky from 2025 to 2027" });
    const out = el("p", { class: "lesson-result", "aria-live": "polite" });
    const yearOf = () => t0 + (+slider.value) / 365.25;

    function draw() {
      const k = boost.checked ? 20 : 1;
      const ctx = canvas.getContext("2d"), W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H);
      const span = 26;   // arcsec shown top to bottom
      const s = H / span;
      const X = (e) => W / 2 - e * s, Y = (n) => H / 2 - n * s;   // east left, north up
      ctx.strokeStyle = css("--line"); ctx.lineWidth = 1;
      for (let g = -6; g <= 6; g++) {
        const off = (g + 0.5) * SCALE;
        ctx.beginPath(); ctx.moveTo(X(off), 0); ctx.lineTo(X(off), H); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, Y(off)); ctx.lineTo(W, Y(off)); ctx.stroke();
      }
      const path = (boostBy) => {
        ctx.beginPath();
        for (let t = 0; t <= 730; t += 3) {
          const p = pos(t0 + t / 365.25, boostBy);
          if (t) ctx.lineTo(X(p.e), Y(p.n)); else ctx.moveTo(X(p.e), Y(p.n));
        }
        ctx.stroke();
      };
      ctx.strokeStyle = css("--gaia"); ctx.lineWidth = 2;
      path(k);
      if (k > 1) {   // the pink dots carry the real, unmagnified wobble, so show that path too
        ctx.save(); ctx.globalAlpha = 0.5; ctx.setLineDash([4, 4]); ctx.lineWidth = 1.5; path(1); ctx.restore();
      }
      ctx.fillStyle = css("--mover");
      for (const m of meas) { ctx.beginPath(); ctx.arc(X(m.e), Y(m.n), 5, 0, Math.PI * 2); ctx.fill(); }
      const now = pos(yearOf(), k);
      ctx.fillStyle = css("--warm");
      ctx.beginPath(); ctx.arc(X(now.e), Y(now.n), 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = css("--muted"); ctx.font = "12px " + getComputedStyle(document.body).fontFamily;
      ctx.fillText("N ↑   E ←", 8, 16);
      ctx.fillText("grid = SPHEREx pixels (6.15″)", 8, H - 8);
      const y = yearOf(), dt = y - 2026;
      const date = new Date(Date.UTC(2025, 0, 1) + (+slider.value) * 86400000).toISOString().slice(0, 10);
      out.textContent = date + ": proper motion puts it " + fmt(Math.abs(dt * Math.hypot(gaia.pmra, gaia.pmdec) / 1000), 1) + "″ " + (dt < 0 ? "south of where it will be" : "north of where it was") +
        " on 1 January 2026, plus a parallax wobble of up to " + fmt(BARNARD_PARALLAX, 2) + "″" +
        (k > 1 ? " (drawn 20× bigger)" : "") + ". SPHEREx measured " + fmt(pred.pm_arcsec_yr, 1) + "″ a year; Gaia says " +
        fmt(Math.hypot(gaia.pmra, gaia.pmdec) / 1000, 1) + "″.";
    }
    slider.addEventListener("input", draw);
    boost.addEventListener("change", draw);
    box.append(
      el("div", { class: "lesson-stage" }, canvas),
      el("label", { class: "lesson-slider" }, ["Date ", slider]),
      el("label", { class: "check" }, [boost, el("span", {}, "Make the parallax loop 20× bigger")]),
      out,
      el("p", { class: "lesson-credit muted" }, "Measured positions: our SPHEREx pipeline. Path, motion and parallax (0.547″): Gaia DR3 (ESA/Gaia/DPAC)."),
    );
    draw();
  }

  // ---- page ----
  const lessons = [moverLesson(), wavelengthLesson(), colourLesson(), planetLesson(), movedLesson()];
  holder.prepend(el("section", { class: "chapter", id: "try", "aria-labelledby": "try-title" }, [
    el("header", {}, [
      el("div", { class: "kicker" }, "Hands-on"),
      el("h2", { id: "try-title" }, "Try it yourself"),
      el("p", { class: "muted" }, "Five short lessons using our own processed SPHEREx images. Nothing moves until you press a button."),
    ]),
    ...lessons,
  ]));
  if (navList) {
    navList.prepend(el("li", {}, [
      el("a", { href: "#try", "data-target": "try" }, "Try it yourself"),
      el("ol", { class: "sub" }, lessons.map((n) => el("li", {}, el("a", { href: "#" + n.id, "data-target": n.id }, n.querySelector("h3").textContent)))),
    ]));
  }
  if (location.hash && document.querySelector(location.hash)) {
    requestAnimationFrame(() => document.querySelector(location.hash).scrollIntoView());
  }
})();
