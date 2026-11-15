// The only module that fetches patch data: pre-built files first, then the live server.
(function () {
  "use strict";

  // keep in step with RENDER_URL in project.config.json and ALLOWED_ORIGINS in render.yaml
  const LIVE_SERVER = "https://wink-spherex-explorer-live.onrender.com";
  const DATA_BASE = "data/";
  const POLL_MS = 1500;
  const WAKE_MS = 2500;
  // a sleeping free Render service can take about a minute to answer
  const WAKE_WINDOW_MS = 75000;
  const MIN_DOWNLOAD_FOV = 5 / 60;
  const DEFAULT_LAYERS = ["gaia", "wise"];
  // 2MASS is opt-in so "layers missing = gaia,wise" (R32) still holds; the live server ignores it for now
  const KNOWN_LAYERS = ["gaia", "wise", "tmass"];
  const D2R = Math.PI / 180;

  class DataError extends Error {
    constructor(message, code, extra) {
      super(message);
      this.name = "DataError";
      this.code = code || "network";
      Object.assign(this, extra || {});
    }
  }

  const query = new URLSearchParams(location.search);

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      if (signal) {
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new DataError("Search cancelled.", "cancelled"));
        }, { once: true });
      }
    });
  }

  function throwIfAborted(signal) {
    if (signal && signal.aborted) throw new DataError("Search cancelled.", "cancelled");
  }

  // ---- sky geometry (TAN projection, degrees) ----

  function project(ra0, dec0, ra, dec) {
    const a = (ra - ra0) * D2R, d = dec * D2R, d0 = dec0 * D2R;
    const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a);
    const xi = Math.cos(d) * Math.sin(a) / cosc;
    const eta = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a)) / cosc;
    return [xi / D2R, eta / D2R];
  }

  function deproject(ra0, dec0, xi, eta) {
    const x = xi * D2R, y = eta * D2R, d0 = dec0 * D2R;
    const rho = Math.hypot(x, y);
    if (rho === 0) return [ra0, dec0];
    const c = Math.atan(rho);
    const dec = Math.asin(Math.cos(c) * Math.sin(d0) + y * Math.sin(c) * Math.cos(d0) / rho);
    const ra = ra0 * D2R + Math.atan2(x * Math.sin(c), rho * Math.cos(d0) * Math.cos(c) - y * Math.sin(d0) * Math.sin(c));
    return [((ra / D2R) % 360 + 360) % 360, dec / D2R];
  }

  function separation(ra1, dec1, ra2, dec2) {
    const s = Math.sin((dec2 - dec1) * D2R / 2) ** 2 +
      Math.cos(dec1 * D2R) * Math.cos(dec2 * D2R) * Math.sin((ra2 - ra1) * D2R / 2) ** 2;
    return 2 * Math.asin(Math.min(1, Math.sqrt(s))) / D2R;
  }

  // Pixel coordinates are PNG pixel centres: x right (east is left), y down (north is up).
  function skyToPix(patch, ra, dec) {
    const [xi, eta] = project(patch.ra, patch.dec, ra, dec);
    const s = patch.pixel_scale_arcsec / 3600;
    return [(patch.width_px - 1) / 2 - xi / s, (patch.height_px - 1) / 2 - eta / s];
  }

  function pixToSky(patch, x, y) {
    const s = patch.pixel_scale_arcsec / 3600;
    return deproject(patch.ra, patch.dec, ((patch.width_px - 1) / 2 - x) * s, ((patch.height_px - 1) / 2 - y) * s);
  }

  // ---- fetching ----

  async function fetchJSON(url, signal) {
    let resp;
    try {
      resp = await fetch(url, { signal });
    } catch (e) {
      throwIfAborted(signal);
      throw new DataError("Couldn't reach " + url + ". Check your connection and try again.", "network");
    }
    if (!resp.ok) throw new DataError("Couldn't load " + url + " (HTTP " + resp.status + ").", "http", { status: resp.status });
    try {
      return await resp.json();
    } catch (e) {
      throw new DataError(url + " isn't valid JSON.", "http");
    }
  }

  const jsonCache = new Map();
  function cachedJSON(url, signal) {
    if (!jsonCache.has(url)) {
      const p = fetchJSON(url, signal);
      jsonCache.set(url, p);
      p.catch(() => jsonCache.delete(url));
    }
    return jsonCache.get(url);
  }

  function patchList(signal) {
    return cachedJSON(DATA_BASE + "patches.json", signal).catch((e) => {
      if (e.code === "http" && e.status === 404) return [];
      throw e;
    });
  }

  function sourceMode(opt) {
    const s = opt || query.get("source");
    return s === "static" || s === "api" ? s : "auto";
  }

  let apiBasePromise = null;
  function apiBase() {
    if (apiBasePromise) return apiBasePromise;
    const override = query.get("api");
    if (override) {
      apiBasePromise = Promise.resolve(override.replace(/\/+$/, "") + "/");
    } else if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
      // server.py serves the site and the API from one origin; python -m http.server doesn't
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 1500);
      apiBasePromise = fetch("api/health", { signal: ctl.signal })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => (j && j.ok ? "" : LIVE_SERVER + "/"))
        .catch(() => LIVE_SERVER + "/")
        .finally(() => clearTimeout(t));
    } else {
      apiBasePromise = Promise.resolve(LIVE_SERVER + "/");
    }
    return apiBasePromise;
  }

  function normaliseLayers(layers) {
    if (layers === undefined || layers === null) return DEFAULT_LAYERS.slice();
    const list = Array.isArray(layers) ? layers : String(layers).split(",");
    return list.map((s) => s.trim().toLowerCase()).filter((s) => KNOWN_LAYERS.includes(s));
  }

  function nearestOf(list, ra, dec) {
    let best = null;
    for (const p of list) {
      const sep = separation(ra, dec, p.ra, p.dec);
      if (!best || sep < best.sep_deg) best = { id: p.id, name: p.title || p.name || p.id, ra: p.ra, dec: p.dec, sep_deg: sep, simulated: !!p.simulated };
    }
    return best;
  }

  // A patch covers the spot when the spot lies inside its square, keeping a 1 px margin.
  function findCovering(list, req) {
    let best = null;
    for (const p of list) {
      const half = p.fov_deg / 2;
      const [xi, eta] = project(p.ra, p.dec, req.ra, req.dec);
      const off = Math.max(Math.abs(xi), Math.abs(eta));
      if (off > half - 6.15 / 3600) continue;
      if (!best || off < best.off) best = { entry: p, off };
    }
    return best && best.entry;
  }

  function cropFor(patch, req) {
    const [cx, cy] = skyToPix(patch, req.ra, req.dec);
    const n = Math.max(4, Math.round(req.fov * 3600 / patch.pixel_scale_arcsec));
    const x0 = cx + 0.5 - n / 2, y0 = cy + 0.5 - n / 2;
    const ox = Math.max(0, Math.min(x0 + n, patch.width_px) - Math.max(x0, 0));
    const oy = Math.max(0, Math.min(y0 + n, patch.height_px) - Math.max(y0, 0));
    return { x0, y0, w: n, h: n, covered: (ox * oy) / (n * n) };
  }

  function finish(json, baseUrl, req, source) {
    const base = new URL(baseUrl, location.href);
    const resolve = (f) => (f ? new URL(f, base).href : f);
    const frames = (json.frames || []).map((f, i) => Object.assign({}, f, {
      index: i,
      url: resolve(f.file),
      flags_url: resolve(f.flags_file),
    }));
    // cached patches can hold more layers than asked for; drop the others (R32)
    const overlays = {};
    for (const k of req.layers) if (json.overlays && json.overlays[k]) overlays[k] = json.overlays[k];
    const patch = json.patch;
    return {
      status: "ok",
      source,
      request: req,
      patch,
      frames,
      light_curve: json.light_curve || [],
      spectrum: json.spectrum || null,
      overlays,
      predictions: json.predictions || [],
      verdicts: json.verdicts || null,
      crop: cropFor(patch, req),
      zoomed: req.fov < MIN_DOWNLOAD_FOV - 1e-9,
      images: {},
    };
  }

  async function loadStatic(entry, req, onStage, signal) {
    onStage({ stage: "patch", message: "Loading " + (entry.title || entry.id) + "…" });
    const url = DATA_BASE + entry.id + ".json";
    const json = await cachedJSON(url, signal);
    return finish(json, url, req, "static");
  }

  async function fetchLive(req, onStage, signal) {
    const base = await apiBase();
    const q = new URLSearchParams({
      ra: req.ra.toFixed(6),
      dec: req.dec.toFixed(6),
      fov: String(+Math.max(req.fov, MIN_DOWNLOAD_FOV).toFixed(4)),
    });
    if (req.det && req.det !== "all") q.set("det", req.det);
    q.set("layers", req.layers.length ? req.layers.join(",") : "none");
    const url = base + "api/patch?" + q.toString();
    const started = Date.now();
    const elapsed = () => (Date.now() - started) / 1000;
    let answered = false;

    for (;;) {
      throwIfAborted(signal);
      const wake = answered ? null : setTimeout(() => onStage({
        stage: "waking", message: "Waking up the live SPHEREx server…", elapsed_s: elapsed(),
      }), WAKE_MS);
      let resp = null;
      try {
        resp = await fetch(url, { signal, mode: "cors" });
      } catch (e) {
        throwIfAborted(signal);
      } finally {
        clearTimeout(wake);
      }
      const booting = !resp || resp.status === 502 || resp.status === 503 || resp.status === 504;
      if (booting) {
        if (navigator.onLine === false) {
          throw new DataError("You seem to be offline. Check your connection and try again.", "network");
        }
        if (!answered && Date.now() - started < WAKE_WINDOW_MS) {
          onStage({ stage: "waking", message: "Waking up the live SPHEREx server…", elapsed_s: elapsed() });
          await sleep(POLL_MS * 2, signal);
          continue;
        }
        throw new DataError("This spot needs the live server, and it isn't answering right now.", "needs-live");
      }
      answered = true;
      if (resp.status === 202) {
        let j = {};
        try { j = await resp.json(); } catch (e) { /* keep polling */ }
        const queued = j.status === "queued";
        onStage(Object.assign({}, j, {
          stage: queued ? "queued" : "working",
          message: queued ? "Waiting for another search on this server to finish" : (j.message || "Working…"),
          elapsed_s: typeof j.elapsed_s === "number" ? j.elapsed_s : elapsed(),
        }));
        await sleep(POLL_MS, signal);
        continue;
      }
      if (resp.status === 404) {
        let j = null;
        try { j = await resp.json(); } catch (e) { /* not ours */ }
        if (j && j.status === "no-coverage") return { status: "no-coverage", source: "live", nearest: j.nearest || null, request: req };
        throw new DataError("The live server doesn't know this request (HTTP 404).", "http", { status: 404 });
      }
      if (!resp.ok) {
        let j = null;
        try { j = await resp.json(); } catch (e) { /* not ours */ }
        throw new DataError(j && j.message ? j.message : "The live server had a problem (HTTP " + resp.status + "). Try again in a minute.", "http", { status: resp.status });
      }
      let json;
      try { json = await resp.json(); } catch (e) { throw new DataError("The live server sent something we can't read.", "http"); }
      return finish(json, resp.url || url, req, "live");
    }
  }

  // getPatch({ra, dec, fov, det, layers, onStage, signal, source})
  //   -> {status:"ok", patch, frames, images, crop, ...} | {status:"no-coverage", nearest}
  //   throws DataError (code: network | http | needs-live | cancelled)
  async function getPatch(opts) {
    const req = {
      ra: +opts.ra,
      dec: +opts.dec,
      fov: +opts.fov || 10 / 60,
      det: opts.det ? String(opts.det) : "all",
      layers: normaliseLayers(opts.layers),
    };
    if (!isFinite(req.ra) || !isFinite(req.dec) || req.dec < -90 || req.dec > 90) {
      throw new DataError("That position isn't valid.", "input");
    }
    req.ra = ((req.ra % 360) + 360) % 360;
    const onStage = opts.onStage || (() => {});
    const signal = opts.signal;
    const mode = sourceMode(opts.source);

    let list = [];
    if (mode !== "api") {
      list = await patchList(signal);
      const hit = findCovering(list, req);
      if (hit) return loadStatic(hit, req, onStage, signal);
      if (mode === "static") {
        return { status: "no-coverage", source: "static", needsLive: true, nearest: nearestOf(list, req.ra, req.dec), request: req };
      }
    }
    try {
      const res = await fetchLive(req, onStage, signal);
      if (res.status === "no-coverage" && !res.nearest) {
        if (!list.length) list = await patchList(signal).catch(() => []);
        res.nearest = nearestOf(list, req.ra, req.dec);
      }
      return res;
    } catch (e) {
      if (e.code === "needs-live") {
        if (!list.length) list = await patchList(signal).catch(() => []);
        e.nearest = nearestOf(list, req.ra, req.dec);
      }
      throw e;
    }
  }

  function loadImage(url, signal) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      if (new URL(url, location.href).origin !== location.origin) img.crossOrigin = "anonymous";
      img.decoding = "async";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new DataError("Couldn't load the image " + url.split("/").pop() + ".", "network"));
      if (signal) signal.addEventListener("abort", () => { img.src = ""; reject(new DataError("Search cancelled.", "cancelled")); }, { once: true });
      img.src = url;
    });
  }

  // Loads (once) the image and flag mask of every frame for one detector into result.images[url].
  async function loadImages(result, det, onStage, signal) {
    const want = result.frames.filter((f) => String(f.detector) === String(det));
    const urls = [];
    for (const f of want) {
      urls.push(f.url);
      if (f.flags_url) urls.push(f.flags_url);
    }
    const missing = urls.filter((u) => !result.images[u]);
    let done = 0;
    const report = () => onStage && onStage({ stage: "images", message: "Loading images", done, total: missing.length });
    if (missing.length) report();
    await Promise.all(missing.map((u) => {
      const p = result.images[u + "#pending"] || loadImage(u, signal);
      result.images[u + "#pending"] = p;
      return p.then((img) => {
        result.images[u] = img;
        delete result.images[u + "#pending"];
        done += 1;
        report();
      }, (e) => {
        delete result.images[u + "#pending"];
        throw e;
      });
    }));
    return want;
  }

  window.SkyData = {
    getPatch,
    loadImages,
    patchList,
    apiBase,
    DataError,
    LIVE_SERVER,
    MIN_DOWNLOAD_FOV,
    geometry: { project, deproject, separation, skyToPix, pixToSky },
  };
})();
