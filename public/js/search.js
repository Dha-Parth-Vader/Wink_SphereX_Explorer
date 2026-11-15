(function () {
  "use strict";
  const SB = window.Wink;
  const { el } = SB;

  const TYPE_LABEL = { "brown-dwarf": "Brown dwarf", star: "Star", variable: "Variable", nebula: "Nebula", asteroid: "Asteroid" };

  // Tabs ------------------------------------------------------------------
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  function selectTab(name, focus) {
    for (const t of tabs) {
      const on = t.dataset.tab === name;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
      if (on && focus) t.focus();
    }
    if (window.location.hash.slice(1) !== name) history.replaceState(null, "", window.location.pathname + window.location.search + "#" + name);
    if (name !== "raw") loadGallery();
    if (name === "community") loadHunt();
  }
  tabs.forEach((t, i) => {
    t.addEventListener("click", () => selectTab(t.dataset.tab));
    t.addEventListener("keydown", (e) => {
      const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (step) selectTab(tabs[(i + step + tabs.length) % tabs.length].dataset.tab, true);
    });
  });
  document.querySelectorAll("[data-goto]").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    selectTab(a.dataset.goto, true);
  }));

  // Data to load (R36) ----------------------------------------------------
  const layerBoxes = [...document.querySelectorAll('input[name="layer"]')];
  const savedLayers = SB.store.get("layers", ["gaia", "wise"]);
  layerBoxes.forEach((box) => {
    box.checked = Array.isArray(savedLayers) ? savedLayers.includes(box.value) : true;
    box.addEventListener("change", () => {
      SB.store.set("layers", currentLayers());
      if (gallery) { renderGrid(document.getElementById("gallery-grid"), gallery); applyFilters(); }
    });
  });
  function currentLayers() {
    return layerBoxes.filter((b) => b.checked).map((b) => b.value);
  }

  // Raw search ------------------------------------------------------------
  const form = document.getElementById("raw-form");
  const raInput = document.getElementById("ra");
  const decInput = document.getElementById("dec");
  const fovSelect = document.getElementById("fov");

  SB.FOV_OPTIONS.forEach((opt) => {
    fovSelect.append(el("option", { value: opt.value.toFixed(4), selected: opt.value === SB.DEFAULT_FOV }, opt.label));
  });

  const q = SB.params;
  if (q.get("ra")) raInput.value = q.get("ra");
  if (q.get("dec")) decInput.value = q.get("dec");
  if (q.get("fov")) fovSelect.value = SB.nearestFovOption(parseFloat(q.get("fov"))).value.toFixed(4);

  function check(input, parse, fieldId, errId, message) {
    const value = parse(input.value);
    const ok = Number.isFinite(value);
    document.getElementById(fieldId).classList.toggle("invalid", !ok);
    input.setAttribute("aria-invalid", String(!ok));
    document.getElementById(errId).textContent = ok ? "" : message;
    return value;
  }

  function readPosition() {
    const ra = check(raInput, SB.parseRA, "f-ra", "ra-err", "Use degrees (0 to 360) or hours like 08h55m10.8s.");
    const dec = check(decInput, SB.parseDec, "f-dec", "dec-err", "Use degrees (−90 to +90) or −07d14m42s.");
    if (!Number.isFinite(ra)) { raInput.focus(); return null; }
    if (!Number.isFinite(dec)) { decInput.focus(); return null; }
    return { ra, dec, fov: parseFloat(fovSelect.value) };
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const pos = readPosition();
    if (pos) window.location.href = SB.viewerUrl({ ...pos, layers: currentLayers() });
  });
  document.getElementById("to-dome").addEventListener("click", () => {
    const pos = readPosition();
    if (!pos) return;
    const dq = new URLSearchParams({ ra: pos.ra.toFixed(4), dec: pos.dec.toFixed(4), look: "1" });
    window.location.href = "dome.html?" + dq.toString();
  });

  const chips = document.getElementById("chips");
  SB.TARGETS.forEach((t) => {
    const chip = el("a", {
      class: "chip",
      href: SB.viewerUrl({ ra: t.ra, dec: t.dec, fov: t.fov, name: t.name, det: t.det, layers: currentLayers() }),
      title: t.blurb,
    }, [t.name, el("span", { class: "chip-tag " + t.tag }, t.tag)]);
    // layers can change after the chip is drawn
    chip.addEventListener("click", () => {
      chip.href = SB.viewerUrl({ ra: t.ra, dec: t.dec, fov: t.fov, name: t.name, det: t.det, layers: currentLayers() });
    });
    chips.append(chip);
  });

  // Gallery and filtered search ------------------------------------------
  let gallery = null;
  let galleryPromise = null;

  function loadGallery() {
    if (!galleryPromise) {
      const grid = document.getElementById("gallery-grid");
      grid.replaceChildren(el("p", { class: "muted" }, "Loading the gallery…"));
      galleryPromise = fetch("data/gallery.json")
        .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then((items) => {
          gallery = items.slice().sort((a, b) => (a.simulated ? 1 : 0) - (b.simulated ? 1 : 0) || a.name.localeCompare(b.name));
          renderGrid(grid, gallery);
          applyFilters();
        })
        .catch(() => {
          grid.replaceChildren(el("div", { class: "empty" }, "We couldn't load the gallery. Check your connection and reload the page."));
          galleryPromise = null;
        });
    }
    return galleryPromise;
  }

  function card(item) {
    const href = SB.viewerUrl({ ra: item.ra, dec: item.dec, fov: item.fov, name: item.name, layers: currentLayers() });
    const meta = [el("span", { class: "badge" }, TYPE_LABEL[item.type] || item.type)];
    if (item.simulated) meta.push(el("span", { class: "badge badge-sim" }, "Simulated"));
    else if (item.status) meta.push(el("span", { class: "badge badge-ok" }, item.status));
    return el("a", { class: "card g-card", href }, [
      item.thumb
        ? el("img", { class: "thumb", src: "data/" + item.thumb, alt: "SPHEREx picture of " + item.name, loading: "lazy", width: 147, height: 147 })
        : el("div", { class: "thumb", "aria-hidden": "true" }),
      el("div", { class: "body" }, [
        el("h3", {}, item.name),
        el("div", { class: "meta" }, meta),
        item.blurb ? el("p", { class: "blurb" }, item.blurb) : null,
        el("span", { class: "tiny muted mono" }, SB.formatRA(item.ra) + " " + SB.formatDec(item.dec)),
      ]),
    ]);
  }

  function renderGrid(grid, items) {
    grid.replaceChildren(...(items.length ? items.map(card) : [el("div", { class: "empty" }, "Nothing matches yet. Try ticking more types.")]));
  }

  // galactic latitude from J2000 RA/Dec (degrees)
  function galacticLat(ra, dec) {
    const r = Math.PI / 180;
    const raGP = 192.85948 * r, decGP = 27.12825 * r;
    const s = Math.sin(dec * r) * Math.sin(decGP) + Math.cos(dec * r) * Math.cos(decGP) * Math.cos(ra * r - raGP);
    return Math.asin(Math.max(-1, Math.min(1, s))) / r;
  }

  const nameBox = document.getElementById("f-name");
  const typeBoxes = [...document.querySelectorAll('input[name="type"]')];
  const onlyImages = document.getElementById("only-images");
  const region = document.getElementById("region");

  function applyFilters() {
    if (!gallery) return;
    const types = new Set(typeBoxes.filter((b) => b.checked && !b.disabled).map((b) => b.value));
    const text = nameBox.value.trim().toLowerCase();
    const items = gallery.filter((g) => {
      if (!types.has(g.type)) return false;
      if (text && !g.name.toLowerCase().includes(text)) return false;
      if (onlyImages.checked && !g.thumb) return false;
      const b = Math.abs(galacticLat(g.ra, g.dec));
      switch (region.value) {
        case "north": return g.dec > 0;
        case "south": return g.dec < 0;
        case "plane": return b <= 15;
        case "away": return b > 15;
        default: return true;
      }
    });
    document.getElementById("filter-count").textContent = items.length + " of " + gallery.length + " targets";
    renderGrid(document.getElementById("filter-grid"), items);
  }
  [nameBox, onlyImages, region, ...typeBoxes].forEach((c) => c.addEventListener("input", applyFilters));

  // Community finds ---------------------------------------------------------
  const huntCanvas = document.getElementById("hunt-canvas");
  const huntStatus = document.getElementById("hunt-status");
  const huntHover = document.getElementById("hunt-hover");
  const huntLabelBoxes = [...document.querySelectorAll('input[name="hunt-label"]')];
  const huntTargetsBox = document.getElementById("hunt-targets");
  let huntRows = null;
  let huntLoading = false;
  let huntDots = [];

  function loadHunt() {
    loadGallery().then(drawHunt);
    if (huntRows || huntLoading) return drawHunt();
    if (!window.WinkHunt || !WinkHunt.configured()) {
      huntRows = [];
      huntStatus.textContent = "Sharing marks isn't switched on yet, so the map only shows our prepared targets.";
      renderHuntList();
      return drawHunt();
    }
    huntLoading = true;
    huntStatus.textContent = "Loading shared marks…";
    WinkHunt.list().then((rows) => {
      huntRows = rows;
      const n = (label) => rows.filter((r) => r.label === label).length;
      huntStatus.textContent = rows.length
        ? rows.length + " shared mark" + (rows.length === 1 ? "" : "s") + ": " + n("mover") + " movers, " +
          n("variable") + " changing, " + n("artifact") + " artifacts."
        : "No shared marks yet. Be the first!";
    }, (e) => {
      huntRows = [];
      huntStatus.textContent = e.message;
    }).finally(() => {
      huntLoading = false;
      renderHuntList();
      drawHunt();
    });
  }

  // Hammer projection, 0h in the middle and RA growing to the left as on a real sky map
  function hammer(ra, dec) {
    const l = -(((ra + 180) % 360 + 360) % 360 - 180) * Math.PI / 180;
    const b = dec * Math.PI / 180;
    const d = Math.sqrt(1 + Math.cos(b) * Math.cos(l / 2));
    return [2 * Math.SQRT2 * Math.cos(b) * Math.sin(l / 2) / d, Math.SQRT2 * Math.sin(b) / d];
  }

  // a point on the galactic equator (b = 0) in RA/Dec, for the Milky Way line
  function galacticToRaDec(l) {
    const r = Math.PI / 180, dG = 27.12825 * r, aG = 192.85948 * r, lN = 122.93192 * r;
    const dec = Math.asin(Math.cos(dG) * Math.cos(lN - l * r));
    const ra = aG + Math.atan2(Math.sin(lN - l * r), -Math.sin(dG) * Math.cos(lN - l * r));
    return [((ra / r) % 360 + 360) % 360, dec / r];
  }

  function cssColour(name, fallback) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  }

  function drawHunt() {
    if (!huntCanvas || huntCanvas.closest("[hidden]")) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = huntCanvas.clientWidth;
    const h = Math.round(w / 2);
    huntCanvas.style.height = h + "px";
    huntCanvas.width = Math.round(w * dpr);
    huntCanvas.height = Math.round(h * dpr);
    const ctx = huntCanvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pad = 14;
    const sx = (w / 2 - pad) / (2 * Math.SQRT2), sy = (h / 2 - pad) / Math.SQRT2;
    const toXY = (ra, dec) => {
      const [x, y] = hammer(ra, dec);
      return [w / 2 + x * sx, h / 2 - y * sy];
    };
    const line = (pts, colour, dash) => {
      ctx.strokeStyle = colour;
      ctx.setLineDash(dash || []);
      ctx.beginPath();
      pts.forEach(([ra, dec], i) => {
        const [x, y] = toXY(ra, dec);
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      });
      ctx.stroke();
      ctx.setLineDash([]);
    };
    const range = (a, b, step) => { const out = []; for (let v = a; v <= b + 1e-9; v += step) out.push(v); return out; };

    ctx.clearRect(0, 0, w, h);
    ctx.lineWidth = 1;
    const grid = cssColour("--line", "#26335a");
    for (const dec of [-60, -30, 0, 30, 60]) line(range(-179.99, 179.99, 2).map((ra) => [ra, dec]), grid);
    for (const ra of range(-180, 135, 45)) line(range(-90, 90, 2).map((dec) => [ra === -180 ? -179.99 : ra, dec]), grid);
    line(range(-179.99, 179.99, 2).map((ra) => [ra, -90]).concat(range(-90, 90, 2).map((d) => [179.99, d])), cssColour("--line-strong", "#3a4a7a"));
    line(range(-90, 90, 2).map((d) => [-179.99, d]), cssColour("--line-strong", "#3a4a7a"));

    const mw = range(0, 360, 2).map(galacticToRaDec);
    ctx.lineWidth = 1.5;
    let seg = [];
    const fromEdge = (ra) => ((ra + 180) % 360 + 360) % 360;   // the map's edge is at 12h
    mw.forEach((p, i) => {   // break the line where it crosses the edge of the map
      if (i && Math.abs(fromEdge(p[0]) - fromEdge(mw[i - 1][0])) > 180) { line(seg, cssColour("--accent-2", "#b48cff"), [4, 4]); seg = []; }
      seg.push(p);
    });
    line(seg, cssColour("--accent-2", "#b48cff"), [4, 4]);
    ctx.lineWidth = 1;

    ctx.fillStyle = cssColour("--faint", "#7480a3");
    ctx.font = "11px " + cssColour("--mono", "monospace");
    ctx.textAlign = "center";
    for (const hr of [0, 3, 6, 9, 15, 18, 21]) {
      const [x, y] = toXY(hr * 15, 0);
      ctx.fillText(hr + "h", x, y - 4);
    }
    const [mx, my] = toXY(...galacticToRaDec(100));
    ctx.fillStyle = cssColour("--accent-2", "#b48cff");
    ctx.fillText("Milky Way", mx, my - 6);

    huntDots = [];
    if (huntTargetsBox.checked && gallery) {
      ctx.fillStyle = cssColour("--muted", "#a3aecb");
      for (const g of gallery) {
        if (g.simulated) continue;
        const [x, y] = toXY(g.ra, g.dec);
        ctx.globalAlpha = 0.55;
        ctx.beginPath();
        ctx.arc(x, y, 2.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        huntDots.push({ x, y, text: g.name + " (prepared target)",
          href: SB.viewerUrl({ ra: g.ra, dec: g.dec, fov: g.fov, name: g.name, layers: currentLayers() }) });
      }
    }
    const show = new Set(huntLabelBoxes.filter((b) => b.checked).map((b) => b.value));
    ctx.lineWidth = 1.6;
    for (const m of (huntRows || []).slice().reverse()) {
      const info = WinkHunt.LABELS[m.label];
      if (!info || !show.has(m.label)) continue;
      const [x, y] = toXY(m.ra, m.dec);
      const r = 4.5;
      ctx.strokeStyle = cssColour(info.colour, "#ffffff");
      ctx.beginPath();
      if (m.label === "mover") {
        ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath();
      } else if (m.label === "variable") {
        ctx.arc(x, y, r, 0, Math.PI * 2);
      } else {
        ctx.moveTo(x - r * 0.75, y - r * 0.75); ctx.lineTo(x + r * 0.75, y + r * 0.75);
        ctx.moveTo(x + r * 0.75, y - r * 0.75); ctx.lineTo(x - r * 0.75, y + r * 0.75);
      }
      ctx.stroke();
      huntDots.push({ x, y, text: info.name + " at " + SB.formatRA(m.ra) + " " + SB.formatDec(m.dec) + ", shared " + timeAgo(m.created_at),
        href: markHref(m) });
    }
  }

  function markHref(m) {
    return SB.viewerUrl({ ra: m.ra, dec: m.dec, fov: SB.DEFAULT_FOV, det: m.detector || "all", layers: currentLayers() });
  }

  function nearestDot(ev) {
    const rect = huntCanvas.getBoundingClientRect();
    const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
    let best = null, bestD = 10;
    for (const d of huntDots) {
      const dist = Math.hypot(d.x - x, d.y - y);
      if (dist < bestD) { best = d; bestD = dist; }
    }
    return best;
  }

  function timeAgo(iso) {
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (!isFinite(s)) return "";
    if (s < 90) return "just now";
    if (s < 5400) return Math.round(s / 60) + " min ago";
    if (s < 129600) return Math.round(s / 3600) + " h ago";
    return Math.round(s / 86400) + " days ago";
  }

  function renderHuntList() {
    const ul = document.getElementById("hunt-list");
    const names = new Map((gallery || []).map((g) => [g.id, g.name]));
    const rows = (huntRows || []).slice(0, 12);
    if (!rows.length) {
      ul.replaceChildren(el("li", { class: "empty" }, "Nothing shared yet."));
      return;
    }
    ul.replaceChildren(...rows.map((m) => {
      const info = WinkHunt.LABELS[m.label] || { name: m.label, glyph: "?" };
      return el("li", {}, el("a", { class: "card hunt-item", href: markHref(m) }, [
        el("span", { class: "hunt-glyph h-" + m.label, "aria-hidden": "true" }, info.glyph),
        el("span", {}, [
          el("strong", {}, info.name),
          el("span", { class: "tiny muted mono" }, " " + SB.formatRA(m.ra) + " " + SB.formatDec(m.dec)),
          el("span", { class: "tiny muted" }, (names.get(m.patch) ? " · near " + names.get(m.patch) : "") + " · " + timeAgo(m.created_at)),
        ]),
      ]));
    }));
  }

  huntCanvas.addEventListener("mousemove", (ev) => {
    const d = nearestDot(ev);
    huntCanvas.style.cursor = d ? "pointer" : "default";
    huntHover.textContent = d ? d.text : "Point at a dot to see what it is. Click it to open the Viewer there.";
  });
  huntCanvas.addEventListener("click", (ev) => {
    const d = nearestDot(ev);
    if (d) window.location.href = d.href;
  });
  [...huntLabelBoxes, huntTargetsBox].forEach((b) => b.addEventListener("change", drawHunt));
  if ("ResizeObserver" in window) new ResizeObserver(drawHunt).observe(huntCanvas);
  else window.addEventListener("resize", drawHunt);

  const start = window.location.hash.slice(1);
  selectTab(["raw", "gallery", "filtered", "community"].includes(start) ? start : "raw");
  window.addEventListener("hashchange", () => {
    const h = window.location.hash.slice(1);
    if (["raw", "gallery", "filtered", "community"].includes(h)) selectTab(h);
  });
})();
