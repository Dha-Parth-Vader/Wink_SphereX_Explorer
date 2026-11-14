(function () {
  "use strict";
  const SB = window.SkyBlink;
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

  const start = window.location.hash.slice(1);
  selectTab(["raw", "gallery", "filtered"].includes(start) ? start : "raw");
  window.addEventListener("hashchange", () => {
    const h = window.location.hash.slice(1);
    if (["raw", "gallery", "filtered"].includes(h)) selectTab(h);
  });
})();
