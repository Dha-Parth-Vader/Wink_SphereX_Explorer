// Sky Dome: a 360° sky you look around from the inside. Background stars on WebGL (2D canvas fallback),
// markers, grid and labels on a second canvas that is redrawn only when something changes.
(function () {
  "use strict";
  const SB = window.SkyBlink;
  const { el } = SB;
  const DEG = Math.PI / 180;
  const MAX_STEPS_PER_S = 3;
  const MIN_FOV = 0.5, MAX_FOV = 140;

  const dome = document.getElementById("dome");
  const sky = document.getElementById("sky");
  const overlay = document.getElementById("overlay");
  const octx = overlay.getContext("2d");
  const statusBox = document.getElementById("status");

  const q = SB.params;
  const view = {
    ra: num(q.get("ra"), 266.4),
    dec: clamp(num(q.get("dec"), -29), -89.9, 89.9),
    fov: clamp(num(q.get("fov"), 90), MIN_FOV, MAX_FOV),
  };
  const look = q.get("look") === "1" && q.get("ra") ? { ra: view.ra, dec: view.dec } : null;
  if (look && !q.get("fov")) view.fov = 20;

  const state = {
    bands: [], pois: [], categories: {},
    band: clamp(Math.round(num(q.get("band"), 57)), 1, 102),
    allBands: q.get("band") == null,
    dateIndex: null,
    maxEpochs: 1,
    labels: true, grid: false,
    hiddenCats: new Set(), onlyViewer: false, search: "",
    selected: null,
    cubes: new Map(),
  };

  function num(v, fallback) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // Projection -----------------------------------------------------------------------------------
  function vec(ra, dec) {
    const a = ra * DEG, d = dec * DEG;
    return [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
  }
  function basis() {
    const a = view.ra * DEG, d = view.dec * DEG;
    return {
      f: [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)],
      e: [-Math.sin(a), Math.cos(a), 0],
      n: [-Math.sin(d) * Math.cos(a), -Math.sin(d) * Math.sin(a), Math.cos(d)],
    };
  }
  let B = basis();
  let W = 0, H = 0, DPR = 1, SCALE = 1;
  // stereographic, vertical field = view.fov, east on the left (we look up from inside the sphere)
  function updateScale() { SCALE = (H / 2) / (2 * Math.tan(view.fov * DEG / 4)); }
  function project(v) {
    const d = v[0] * B.f[0] + v[1] * B.f[1] + v[2] * B.f[2];
    if (d < -0.2) return null;
    const k = 2 / (1 + d);
    return {
      x: W / 2 - k * (v[0] * B.e[0] + v[1] * B.e[1] + v[2] * B.e[2]) * SCALE,
      y: H / 2 - k * (v[0] * B.n[0] + v[1] * B.n[1] + v[2] * B.n[2]) * SCALE,
      d,
    };
  }

  // Decorative background stars, denser along the Milky Way ---------------------------------------
  const GAL_TO_EQ = [
    [-0.0548755604, 0.4941094279, -0.8676661490],
    [-0.8734370902, -0.4448296300, -0.1980763734],
    [-0.4838350155, 0.7469822445, 0.4559837762],
  ];
  function makeStars(count) {
    let seed = 20260;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
    const out = new Float32Array(count * 5);
    for (let i = 0; i < count; i++) {
      let v;
      if (rand() < 0.55) {
        const l = rand() * 2 * Math.PI, b = gauss() * 9 * DEG;
        const g = [Math.cos(b) * Math.cos(l), Math.cos(b) * Math.sin(l), Math.sin(b)];
        v = GAL_TO_EQ.map((row) => row[0] * g[0] + row[1] * g[1] + row[2] * g[2]);
      } else {
        const z = rand() * 2 - 1, t = rand() * 2 * Math.PI, r = Math.sqrt(1 - z * z);
        v = [r * Math.cos(t), r * Math.sin(t), z];
      }
      const bright = Math.pow(rand(), 4);
      out.set([v[0], v[1], v[2], 0.8 + bright * 2.6, 0.25 + bright * 0.75], i * 5);
    }
    return out;
  }
  const STARS = makeStars(7000);

  // Sky renderer: WebGL first, 2D fallback (?gl=0 forces the fallback) -----------------------------
  const skyRenderer = (function () {
    const gl = q.get("gl") === "0" ? null : sky.getContext("webgl", { antialias: false, alpha: false });
    if (gl) {
      const vs = `
        attribute vec3 a_pos; attribute float a_size; attribute float a_alpha;
        uniform vec3 u_f; uniform vec3 u_e; uniform vec3 u_n; uniform float u_scale; uniform vec2 u_res; uniform float u_dpr;
        varying float v_alpha;
        void main() {
          float d = dot(a_pos, u_f);
          if (d < -0.2) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
          float k = 2.0 / (1.0 + d);
          vec2 p = vec2(-k * dot(a_pos, u_e), k * dot(a_pos, u_n)) * u_scale;
          gl_Position = vec4(p / (u_res * 0.5), 0.0, 1.0);
          gl_PointSize = a_size * u_dpr;
          v_alpha = a_alpha;
        }`;
      const fs = `
        precision mediump float; varying float v_alpha;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float a = smoothstep(0.5, 0.0, length(c)) * v_alpha;
          gl_FragColor = vec4(vec3(0.86, 0.9, 1.0) * a, 1.0);
        }`;
      function shader(type, src) {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      }
      try {
        const prog = gl.createProgram();
        gl.attachShader(prog, shader(gl.VERTEX_SHADER, vs));
        gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, fs));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
        gl.useProgram(prog);
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, STARS, gl.STATIC_DRAW);
        const attr = (name, size, offset) => {
          const loc = gl.getAttribLocation(prog, name);
          gl.enableVertexAttribArray(loc);
          gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 20, offset);
        };
        attr("a_pos", 3, 0);
        attr("a_size", 1, 12);
        attr("a_alpha", 1, 16);
        const u = (name) => gl.getUniformLocation(prog, name);
        const U = { f: u("u_f"), e: u("u_e"), n: u("u_n"), scale: u("u_scale"), res: u("u_res"), dpr: u("u_dpr") };
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        return {
          kind: "webgl",
          draw() {
            gl.viewport(0, 0, sky.width, sky.height);
            gl.clearColor(0.008, 0.016, 0.043, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.uniform3fv(U.f, B.f);
            gl.uniform3fv(U.e, B.e);
            gl.uniform3fv(U.n, B.n);
            gl.uniform1f(U.scale, SCALE);
            gl.uniform2f(U.res, W, H);
            gl.uniform1f(U.dpr, DPR);
            gl.drawArrays(gl.POINTS, 0, STARS.length / 5);
          },
        };
      } catch (err) {
        /* fall through to 2D */
      }
    }
    const ctx = sky.getContext("2d");
    return {
      kind: "2d",
      draw() {
        ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
        ctx.fillStyle = "#02040b";
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = "#dbe5ff";
        for (let i = 0; i < STARS.length; i += 5) {
          const p = project([STARS[i], STARS[i + 1], STARS[i + 2]]);
          if (!p || p.x < -2 || p.y < -2 || p.x > W + 2 || p.y > H + 2) continue;
          const s = STARS[i + 3] * 0.6;
          ctx.globalAlpha = STARS[i + 4];
          ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
        }
        ctx.globalAlpha = 1;
      },
    };
  })();
  dome.dataset.renderer = skyRenderer.kind;

  // Overlay: grid, markers, labels -------------------------------------------------------------
  let hitList = [];

  function visiblePois() {
    return state.pois.filter((p) => !state.hiddenCats.has(p.category) && (!state.onlyViewer || p.patch));
  }

  function epochOf(p) {
    const n = p.epochs ? p.epochs.length : 0;
    if (!n) return null;
    const i = state.dateIndex == null ? n - 1 : Math.min(state.dateIndex, n - 1);
    return p.epochs[i];
  }

  function brightness(p) {
    const spec = p.spectrum || [];
    let v = 0.6;
    if (spec.length) {
      v = state.allBands ? spec.reduce((a, b) => a + b, 0) / spec.length : spec[state.band - 1];
    }
    const ep = epochOf(p);
    const peak = p.epochs && p.epochs.length ? Math.max(...p.epochs.map((e) => e.brightness || 1)) : 1;
    return clamp(v * (ep && ep.brightness != null ? ep.brightness / peak : 1), 0, 1);
  }

  function drawGrid() {
    octx.strokeStyle = "rgba(124, 200, 255, 0.22)";
    octx.lineWidth = 1;
    octx.fillStyle = "rgba(163, 174, 203, 0.8)";
    octx.font = "11px " + getComputedStyle(document.body).fontFamily;
    const line = (pts) => {
      let started = false;
      octx.beginPath();
      for (const v of pts) {
        const p = project(v);
        if (!p || p.d < 0) { started = false; continue; }
        if (!started) { octx.moveTo(p.x, p.y); started = true; } else octx.lineTo(p.x, p.y);
      }
      octx.stroke();
    };
    for (let dec = -75; dec <= 75; dec += 15) {
      const pts = [];
      for (let ra = 0; ra <= 360; ra += 2) pts.push(vec(ra, dec));
      line(pts);
      const p = project(vec(view.ra, dec));
      if (p && p.d > 0) octx.fillText((dec > 0 ? "+" : dec < 0 ? "−" : "") + Math.abs(dec) + "°", p.x + 4, p.y - 3);
    }
    for (let ra = 0; ra < 360; ra += 30) {
      const pts = [];
      for (let dec = -88; dec <= 88; dec += 2) pts.push(vec(ra, dec));
      line(pts);
      const labelDec = clamp(view.dec, -60, 60);
      const p = project(vec(ra, labelDec));
      if (p && p.d > 0) octx.fillText(ra / 15 + "h", p.x + 4, p.y + 12);
    }
  }

  function shapePath(shape, x, y, r) {
    octx.beginPath();
    if (shape === "diamond") {
      octx.moveTo(x, y - r); octx.lineTo(x + r, y); octx.lineTo(x, y + r); octx.lineTo(x - r, y); octx.closePath();
    } else if (shape === "square") {
      octx.rect(x - r * 0.85, y - r * 0.85, r * 1.7, r * 1.7);
    } else {
      octx.arc(x, y, r, 0, Math.PI * 2);
    }
  }

  function drawOverlay() {
    octx.setTransform(DPR, 0, 0, DPR, 0, 0);
    octx.clearRect(0, 0, W, H);
    if (state.grid) drawGrid();
    hitList = [];
    const font = getComputedStyle(document.body).fontFamily;
    for (const p of visiblePois()) {
      const s = project(vec(p.ra, p.dec));
      if (!s || s.d < 0 || s.x < -60 || s.y < -60 || s.x > W + 60 || s.y > H + 60) continue;
      const cat = state.categories[p.category] || { color: "#ffffff", shape: "circle" };
      const b = brightness(p);
      const sizePx = (p.size || 0.1) * DEG * SCALE;
      const r = clamp(4 + 6 * Math.sqrt(b), 4, 10) + Math.min(sizePx / 2, 40);
      const glow = octx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r * 2.4);
      glow.addColorStop(0, hexA(cat.color, 0.25 + 0.6 * b));
      glow.addColorStop(1, hexA(cat.color, 0));
      octx.fillStyle = glow;
      octx.beginPath();
      octx.arc(s.x, s.y, r * 2.4, 0, Math.PI * 2);
      octx.fill();
      shapePath(cat.shape, s.x, s.y, r * 0.55);
      octx.lineWidth = 1.5;
      octx.strokeStyle = hexA(cat.color, 0.95);
      if (cat.shape === "ring") octx.stroke();
      else { octx.fillStyle = hexA(cat.color, 0.35 + 0.6 * b); octx.fill(); octx.stroke(); }
      if (state.selected && state.selected.id === p.id) {
        octx.strokeStyle = "#ffd166";
        octx.lineWidth = 2;
        octx.beginPath();
        octx.arc(s.x, s.y, r + 6, 0, Math.PI * 2);
        octx.stroke();
      }
      if (state.labels) {
        octx.font = "600 12px " + font;
        octx.fillStyle = "rgba(232, 236, 248, 0.92)";
        octx.shadowColor = "rgba(0,0,0,0.9)";
        octx.shadowBlur = 3;
        octx.fillText(p.name + (p.simulated ? " (sim)" : ""), s.x + r + 6, s.y + 4);
        octx.shadowBlur = 0;
      }
      hitList.push({ p, x: s.x, y: s.y, r: Math.max(r + 4, 14) });
    }
    if (look) {
      const s = project(vec(look.ra, look.dec));
      if (s && s.d > 0) {
        octx.strokeStyle = "#ffd166";
        octx.lineWidth = 1.5;
        octx.setLineDash([5, 4]);
        octx.beginPath();
        octx.arc(s.x, s.y, 16, 0, Math.PI * 2);
        octx.stroke();
        octx.setLineDash([]);
        octx.beginPath();
        octx.moveTo(s.x - 26, s.y); octx.lineTo(s.x - 18, s.y);
        octx.moveTo(s.x + 18, s.y); octx.lineTo(s.x + 26, s.y);
        octx.moveTo(s.x, s.y - 26); octx.lineTo(s.x, s.y - 18);
        octx.moveTo(s.x, s.y + 18); octx.lineTo(s.x, s.y + 26);
        octx.stroke();
        octx.fillStyle = "#ffd166";
        octx.font = "600 12px " + font;
        octx.fillText("Your spot", s.x + 22, s.y - 20);
      }
    }
  }

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return "rgba(" + (n >> 16 & 255) + "," + (n >> 8 & 255) + "," + (n & 255) + "," + a.toFixed(3) + ")";
  }

  // Redraw only when something changed --------------------------------------------------------
  let skyDirty = true, overlayDirty = true, scheduled = false;
  function invalidate(skyToo) {
    if (skyToo) skyDirty = true;
    overlayDirty = true;
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(render);
    }
  }
  function render() {
    scheduled = false;
    if (skyDirty) { B = basis(); updateScale(); skyRenderer.draw(); skyDirty = false; }
    if (overlayDirty) { drawOverlay(); overlayDirty = false; }
  }

  function resize() {
    const rect = dome.getBoundingClientRect();
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(1, rect.width);
    H = Math.max(1, rect.height);
    for (const c of [sky, overlay]) {
      c.width = Math.round(W * DPR);
      c.height = Math.round(H * DPR);
    }
    invalidate(true);
  }
  const bottomPanel = document.querySelector(".dome-bottom");
  if ("ResizeObserver" in window) {
    new ResizeObserver(() => {
      dome.style.setProperty("--bottom-h", bottomPanel.offsetHeight + "px");
      resize();
    }).observe(dome);
  } else {
    window.addEventListener("resize", resize);
  }

  let urlTimer = null;
  function syncUrl() {
    clearTimeout(urlTimer);
    urlTimer = setTimeout(() => {
      const u = new URLSearchParams();
      u.set("ra", view.ra.toFixed(3));
      u.set("dec", view.dec.toFixed(3));
      u.set("fov", view.fov.toFixed(1));
      if (!state.allBands) u.set("band", state.band);
      if (state.selected) u.set("select", state.selected.id);
      if (look) u.set("look", "1");
      if (SB.isEmbed()) u.set("embed", "1");
      history.replaceState(null, "", "dome.html?" + u.toString());
    }, 250);
  }

  function setView(ra, dec, fov) {
    view.ra = ((ra % 360) + 360) % 360;
    view.dec = clamp(dec, -89.9, 89.9);
    if (fov != null) view.fov = clamp(fov, MIN_FOV, MAX_FOV);
    invalidate(true);
    syncUrl();
  }

  // Look around: drag, pinch, wheel, keys ------------------------------------------------------
  const pointers = new Map();
  let dragStart = null, pinchStart = null, moved = false;
  sky.addEventListener("pointerdown", (e) => {
    sky.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = false;
    if (pointers.size === 1) dragStart = { x: e.clientX, y: e.clientY, ra: view.ra, dec: view.dec };
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchStart = { dist: Math.hypot(a.x - b.x, a.y - b.y), fov: view.fov };
    }
  });
  sky.addEventListener("pointermove", (e) => {
    wake();
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && pinchStart) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (dist > 0) setView(view.ra, view.dec, pinchStart.fov * pinchStart.dist / dist);
      moved = true;
      return;
    }
    if (!dragStart) return;
    const dx = e.clientX - dragStart.x, dy = e.clientY - dragStart.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) { moved = true; sky.classList.add("dragging"); }
    const degPerPx = view.fov / H;
    setView(dragStart.ra + dx * degPerPx / Math.max(Math.cos(view.dec * DEG), 0.25), dragStart.dec + dy * degPerPx);
  });
  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchStart = null;
    if (pointers.size === 0) {
      sky.classList.remove("dragging");
      if (!moved && e.type === "pointerup") pick(e);
      dragStart = null;
    } else {
      const [p] = [...pointers.values()];
      dragStart = { x: p.x, y: p.y, ra: view.ra, dec: view.dec };
    }
  }
  sky.addEventListener("pointerup", endPointer);
  sky.addEventListener("pointercancel", endPointer);
  sky.addEventListener("wheel", (e) => {
    e.preventDefault();
    setView(view.ra, view.dec, view.fov * Math.exp(e.deltaY * 0.0012));
  }, { passive: false });
  sky.addEventListener("keydown", (e) => {
    const step = view.fov / 12;
    const keys = {
      ArrowLeft: () => setView(view.ra + step, view.dec),
      ArrowRight: () => setView(view.ra - step, view.dec),
      ArrowUp: () => setView(view.ra, view.dec + step),
      ArrowDown: () => setView(view.ra, view.dec - step),
      "+": () => setView(view.ra, view.dec, view.fov / 1.25),
      "=": () => setView(view.ra, view.dec, view.fov / 1.25),
      "-": () => setView(view.ra, view.dec, view.fov * 1.25),
      Enter: () => pickNearestCentre(),
    };
    if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
  });

  function pick(e) {
    const rect = sky.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    let best = null, bestD = Infinity;
    for (const h of hitList) {
      const d = Math.hypot(h.x - x, h.y - y);
      if (d <= h.r && d < bestD) { best = h; bestD = d; }
    }
    if (best) select(best.p);
  }
  function pickNearestCentre() {
    let best = null, bestD = Infinity;
    for (const h of hitList) {
      const d = Math.hypot(h.x - W / 2, h.y - H / 2);
      if (d < bestD) { best = h; bestD = d; }
    }
    if (best) select(best.p);
  }

  // sub-nav fades when the pointer has been still for a while
  let idleTimer = null;
  function wake() {
    dome.classList.remove("idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => dome.classList.add("idle"), 2500);
  }
  dome.addEventListener("pointermove", wake);
  dome.addEventListener("keydown", wake);
  wake();

  // Toolbar ---------------------------------------------------------------------------------
  const drawer = document.getElementById("drawer");
  const details = document.getElementById("details");
  const objBtn = document.getElementById("btn-objects");
  // on a phone the drawer and the details panel share the screen, so only one is open at a time
  const narrow = window.matchMedia("(max-width: 760px)");
  function setDrawer(open) {
    drawer.hidden = !open;
    objBtn.setAttribute("aria-expanded", String(open));
    if (open && narrow.matches) details.hidden = true;
  }
  objBtn.addEventListener("click", () => {
    setDrawer(drawer.hidden);
    if (!drawer.hidden) document.getElementById("obj-search").focus();
  });
  document.getElementById("btn-zoom-in").addEventListener("click", () => setView(view.ra, view.dec, view.fov / 1.5));
  document.getElementById("btn-zoom-out").addEventListener("click", () => setView(view.ra, view.dec, view.fov * 1.5));
  document.getElementById("btn-wide").addEventListener("click", () => setView(view.ra, view.dec, 120));
  function toggleBtn(id, key) {
    const btn = document.getElementById(id);
    btn.setAttribute("aria-pressed", String(state[key]));
    btn.addEventListener("click", () => {
      state[key] = !state[key];
      btn.setAttribute("aria-pressed", String(state[key]));
      invalidate();
    });
  }
  toggleBtn("btn-labels", "labels");
  toggleBtn("btn-grid", "grid");

  // Objects drawer --------------------------------------------------------------------------
  const listEl = document.getElementById("obj-list");
  const typesEl = document.getElementById("obj-types");

  function renderDrawer() {
    const text = state.search.trim().toLowerCase();
    const items = visiblePois().filter((p) => !text || p.name.toLowerCase().includes(text));
    document.getElementById("obj-count").textContent = items.length + " of " + state.pois.length + " objects";
    listEl.replaceChildren(...items.map((p) => {
      const cat = state.categories[p.category] || {};
      return el("li", {}, el("button", {
        type: "button",
        "aria-current": state.selected && state.selected.id === p.id ? "true" : null,
        onclick: () => { if (narrow.matches) setDrawer(false); select(p); flyTo(p); },
      }, [
        el("span", { class: "dot", style: "background:" + (cat.color || "#fff") }),
        el("span", {}, p.name),
        p.simulated ? el("span", { class: "badge badge-sim" }, "Simulated") : null,
      ]));
    }));
  }

  function buildTypeFilters() {
    const used = new Set(state.pois.map((p) => p.category));
    typesEl.replaceChildren(...Object.entries(state.categories).filter(([id]) => used.has(id)).map(([id, cat]) => {
      const box = el("input", { type: "checkbox", value: id, checked: !state.hiddenCats.has(id) });
      box.addEventListener("change", () => {
        if (box.checked) state.hiddenCats.delete(id); else state.hiddenCats.add(id);
        renderDrawer();
        invalidate();
      });
      return el("label", { class: "check small" }, [box, el("span", { style: "color:" + cat.color }, cat.label)]);
    }));
  }

  document.getElementById("obj-search").addEventListener("input", (e) => { state.search = e.target.value; renderDrawer(); });
  document.getElementById("show-all").addEventListener("click", () => { state.hiddenCats.clear(); buildTypeFilters(); renderDrawer(); invalidate(); });
  document.getElementById("hide-all").addEventListener("click", () => {
    Object.keys(state.categories).forEach((id) => state.hiddenCats.add(id));
    buildTypeFilters(); renderDrawer(); invalidate();
  });
  document.getElementById("only-viewer").addEventListener("change", (e) => { state.onlyViewer = e.target.checked; renderDrawer(); invalidate(); });

  function flyTo(p) {
    const fov = clamp(Math.max((p.size || 0.2) * 6, 4), 4, view.fov);
    setView(p.ra, p.dec, fov);
  }

  const tileCanvas = document.getElementById("d-tile");
  const tctx = tileCanvas.getContext("2d");

  // Details panel ---------------------------------------------------------------------------
  function select(p) {
    state.selected = p;
    details.hidden = false;
    if (narrow.matches) setDrawer(false);
    document.getElementById("d-name").textContent = p.name;
    const cat = state.categories[p.category] || {};
    const badges = [el("span", { class: "badge", style: "color:" + (cat.color || "inherit") }, cat.label || p.type || "")];
    if (p.simulated) badges.push(el("span", { class: "badge badge-sim" }, "Simulated"));
    document.getElementById("d-badges").replaceChildren(...badges);
    document.getElementById("d-pos").textContent = SB.formatRA(p.ra) + "  " + SB.formatDec(p.dec);
    document.getElementById("d-blurb").textContent = p.blurb || "";
    const measured = p.bands_measured != null ? p.bands_measured : (p.spectrum || []).length;
    document.getElementById("d-measured").textContent = measured + " of 102 bands measured" +
      (measured < 102 ? "; the rest are filled in between." : ".");
    const open = document.getElementById("d-open");
    const fov = p.patch ? Math.min(Math.max(p.size || SB.DEFAULT_FOV, 1 / 12), 1) : SB.DEFAULT_FOV;
    open.href = SB.viewerUrl({ ra: p.ra, dec: p.dec, fov, name: p.name, layers: SB.store.get("layers", ["gaia", "wise"]) });
    open.textContent = p.patch ? "Open in Viewer →" : "Search this spot in the Viewer →";
    updateDetails();
    renderDrawer();
    invalidate();
    syncUrl();
  }

  document.getElementById("details-close").addEventListener("click", () => {
    state.selected = null;
    details.hidden = true;
    renderDrawer();
    invalidate();
    syncUrl();
    sky.focus();
  });

  function cube(path) {
    if (!state.cubes.has(path)) {
      const img = new Image();
      img.onload = () => { if (state.selected) updateDetails(); };
      img.src = "data/" + path;
      state.cubes.set(path, img);
    }
    return state.cubes.get(path);
  }

  function updateDetails() {
    const p = state.selected;
    if (!p) return;
    const band = state.bands[state.band - 1];
    document.getElementById("d-band").textContent = state.allBands
      ? "All 102 bands (17 per row, detectors 1 to 6 top to bottom)"
      : "Band " + state.band + " · detector " + band.detector + " · " + band.center_um.toFixed(2) + " µm";
    const ep = epochOf(p);
    document.getElementById("d-date").textContent = ep ? "Date: " + mjdToDate(ep.mjd) : "";
    tctx.imageSmoothingEnabled = false;
    tctx.fillStyle = "#000";
    tctx.fillRect(0, 0, 128, 128);
    const img = ep && ep.cube ? cube(ep.cube) : null;
    if (img && img.complete && img.naturalWidth) {
      if (state.allBands) {
        tctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, 0, 42, 128, 45);
      } else {
        tctx.drawImage(img, band.channel * 32, (band.detector - 1) * 32, 32, 32, 0, 0, 128, 128);
      }
    }
    document.getElementById("d-spectrum").replaceChildren(spectrumSvg(p));
  }

  function spectrumSvg(p) {
    const ns = "http://www.w3.org/2000/svg";
    const w = 290, h = 130, m = { l: 30, r: 8, t: 8, b: 26 };
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 " + w + " " + h);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Spectrum of " + p.name + ": brightness against wavelength from 0.75 to 5 microns");
    const lx = (um) => m.l + (Math.log(um / 0.75) / Math.log(5 / 0.75)) * (w - m.l - m.r);
    const ly = (v) => h - m.b - v * (h - m.t - m.b);
    const add = (tag, attrs, text) => {
      const n = document.createElementNS(ns, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      if (text) n.textContent = text;
      svg.append(n);
      return n;
    };
    add("rect", { x: m.l, y: m.t, width: w - m.l - m.r, height: h - m.t - m.b, fill: "rgba(0,0,0,0.25)", stroke: "#26335a" });
    for (const um of [1, 2, 3, 4, 5]) {
      add("line", { x1: lx(um), x2: lx(um), y1: h - m.b, y2: h - m.b + 4, stroke: "#7480a3" });
      add("text", { x: lx(um), y: h - 8, "text-anchor": um === 5 ? "end" : "middle", "font-size": 10, fill: "#a3aecb" }, um === 5 ? "5 µm" : String(um));
    }
    add("text", { x: 4, y: m.t + 10, "font-size": 10, fill: "#a3aecb" }, "1");
    add("text", { x: 4, y: h - m.b, "font-size": 10, fill: "#a3aecb" }, "0");
    const spec = p.spectrum || [];
    if (spec.length === state.bands.length) {
      const pts = state.bands.map((b, i) => lx(b.center_um).toFixed(1) + "," + ly(spec[i]).toFixed(1)).join(" ");
      add("polyline", { points: pts, fill: "none", stroke: (state.categories[p.category] || {}).color || "#7cc8ff", "stroke-width": 1.8 });
    }
    if (!state.allBands && state.bands.length) {
      const x = lx(state.bands[state.band - 1].center_um);
      add("line", { x1: x, x2: x, y1: m.t, y2: h - m.b, stroke: "#ffd166", "stroke-dasharray": "3 3" });
    }
    return svg;
  }

  function mjdToDate(mjd) {
    return new Date(Date.UTC(1858, 10, 17) + mjd * 86400000).toISOString().slice(0, 10);
  }

  // Band and date sliders --------------------------------------------------------------------
  const bandInput = document.getElementById("band");
  const bandOut = document.getElementById("band-out");
  const allBandsBox = document.getElementById("all-bands");
  const sweepBandsBtn = document.getElementById("sweep-bands");
  const dateInput = document.getElementById("date");
  const dateOut = document.getElementById("date-out");
  const sweepDatesBtn = document.getElementById("sweep-dates");

  function showBand() {
    bandInput.value = state.band;
    bandInput.disabled = state.allBands;
    allBandsBox.checked = state.allBands;
    const b = state.bands[state.band - 1];
    bandOut.textContent = state.allBands ? "0.75–5 µm" : (b ? state.band + " · D" + b.detector + " · " + b.center_um.toFixed(2) + " µm" : String(state.band));
    updateDetails();
    invalidate();
  }
  bandInput.addEventListener("input", () => { state.band = +bandInput.value; showBand(); syncUrl(); });
  allBandsBox.addEventListener("change", () => { state.allBands = allBandsBox.checked; if (state.allBands) stopSweep("bands"); showBand(); syncUrl(); });

  function showDate() {
    const latest = state.dateIndex == null;
    dateInput.max = Math.max(0, state.maxEpochs - 1);
    dateInput.value = latest ? state.maxEpochs - 1 : state.dateIndex;
    dateInput.disabled = state.maxEpochs < 2;
    const ep = state.selected ? epochOf(state.selected) : null;
    dateOut.textContent = (latest ? "Latest" : "Date " + (state.dateIndex + 1) + " of " + state.maxEpochs) + (ep ? " · " + mjdToDate(ep.mjd) : "");
    updateDetails();
    invalidate();
  }
  dateInput.addEventListener("input", () => {
    const i = +dateInput.value;
    state.dateIndex = i >= state.maxEpochs - 1 ? null : i;
    showDate();
  });
  document.getElementById("date-latest").addEventListener("click", () => { stopSweep("dates"); state.dateIndex = null; showDate(); });

  // Sweeps step at most 3 times per second and never start on their own.
  const sweeps = { bands: null, dates: null };
  function stopSweep(which) {
    clearInterval(sweeps[which]);
    sweeps[which] = null;
    const btn = which === "bands" ? sweepBandsBtn : sweepDatesBtn;
    btn.textContent = which === "bands" ? "▶ Sweep bands" : "▶ Sweep dates";
    btn.setAttribute("aria-pressed", "false");
  }
  function startSweep(which, step, perSecond) {
    let last = 0;
    sweeps[which] = setInterval(() => {
      const now = performance.now();
      if (now - last < 1000 / MAX_STEPS_PER_S) return;
      last = now;
      step();
    }, 1000 / Math.min(perSecond, MAX_STEPS_PER_S));
    const btn = which === "bands" ? sweepBandsBtn : sweepDatesBtn;
    btn.textContent = "❚❚ Pause";
    btn.setAttribute("aria-pressed", "true");
  }
  sweepBandsBtn.addEventListener("click", () => {
    if (sweeps.bands) return stopSweep("bands");
    state.allBands = false;
    showBand();
    startSweep("bands", () => { state.band = state.band % 102 + 1; showBand(); }, 3);
  });
  sweepDatesBtn.addEventListener("click", () => {
    if (sweeps.dates) return stopSweep("dates");
    if (state.maxEpochs < 2) return;
    startSweep("dates", () => {
      const i = state.dateIndex == null ? 0 : state.dateIndex + 1;
      state.dateIndex = i >= state.maxEpochs - 1 ? null : i;
      showDate();
    }, 1);
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) { stopSweep("bands"); stopSweep("dates"); } });

  // Data ---------------------------------------------------------------------------------------
  function showStatus(message, retry) {
    statusBox.hidden = false;
    statusBox.replaceChildren(el("p", {}, message), retry ? el("button", { class: "btn", type: "button", onclick: retry }, "Retry") : null);
  }

  function load() {
    statusBox.hidden = true;
    const get = (path) => fetch(path).then((r) => { if (!r.ok) throw new Error(path + " " + r.status); return r.json(); });
    Promise.all([get("data/dome/bands.json"), get("data/dome/poi.json")]).then(([bands, poi]) => {
      state.bands = bands;
      state.categories = poi.categories || {};
      state.pois = poi.pois || [];
      state.maxEpochs = Math.max(1, ...state.pois.map((p) => (p.epochs || []).length));
      buildTypeFilters();
      renderDrawer();
      showBand();
      showDate();
      const want = q.get("select");
      const p = want && state.pois.find((x) => x.id === want);
      if (p) select(p);
      if (!state.pois.length) showStatus("No objects to show yet. The pipeline adds them as targets are processed.");
    }).catch(() => showStatus("We couldn't load the Sky Dome data. Check your connection and try again.", load));
  }

  dome.style.setProperty("--bottom-h", bottomPanel.offsetHeight + "px");
  resize();
  load();
})();
