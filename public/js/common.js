// Shared shell: header, footer, nav, challenge targets, coordinate parsing, small helpers.
(function () {
  "use strict";

  const NAV = [
    { id: "home", label: "Home", href: "index.html" },
    { id: "learn", label: "Education", href: "learn.html" },
    { id: "search", label: "Search Tool", href: "search.html" },
    { id: "dome", label: "Sky Dome", href: "dome.html" },
    { id: "about", label: "About", href: "about.html" },
  ];
  // the viewer lives under the Search Tool tab
  const PAGE_TO_NAV = { viewer: "search" };
  // team logo: replace public/img/logo.svg (or point this at a .png) and every page picks it up
  const LOGO = "img/logo.svg";

  // 2026.0 positions from pipeline/out/targets.json (Gaia DR3 or CatWISE2020 propagated), not J2000.
  // pmra/pmdec in mas/yr; fov in degrees.
  const TARGETS = [
    { id: "barnard", name: "Barnard's Star", ra: 269.446268, dec: 4.768204, pmra: -801.55, pmdec: 10362.39,
      fov: 0.25, det: "all", tag: "moves", blurb: "The fastest-moving star in our sky." },
    { id: "epsindib", name: "Epsilon Indi B", ra: 331.09665, dec: -56.800664, pmra: 3981.98, pmdec: -2466.83,
      fov: 1 / 6, det: "all", tag: "moves", blurb: "A pair of brown dwarfs 7′ from a bright star." },
    { id: "wise0855", name: "WISE 0855-0714", ra: 133.75947, dec: -7.242557, pmra: -7919.9, pmdec: 493.9,
      fov: 1 / 6, det: "6", tag: "moves", blurb: "The coldest brown dwarf we know. Look in detector 6." },
    { id: "rwaur", name: "RW Aurigae", ra: 76.95609, dec: 30.401128, pmra: 2.64, pmdec: -27.4,
      fov: 1 / 6, det: "all", tag: "varies", blurb: "A young star that brightens and fades." },
    { id: "rdra", name: "R Draconis", ra: 248.167233, dec: 66.755024, pmra: -20.64, pmdec: 6.15,
      fov: 1 / 6, det: "all", tag: "varies", blurb: "A pulsing giant star, about 245 days per cycle." },
  ];

  // 2' is a client-side zoom of a 5' patch; we never download less than 5'.
  const FOV_OPTIONS = [
    { value: 2 / 60, label: "2′ (zoomed)", zoomOnly: true },
    { value: 5 / 60, label: "5′" },
    { value: 10 / 60, label: "10′" },
    { value: 15 / 60, label: "15′" },
    { value: 30 / 60, label: "30′" },
    { value: 1, label: "1°" },
  ];
  const DEFAULT_FOV = 10 / 60;

  function normalise(text) {
    return String(text == null ? "" : text)
      .trim()
      .replace(/[−–—]/g, "-")
      .replace(/[″"]/g, "s")
      .replace(/[′']/g, "m")
      .replace(/°/g, "d")
      .replace(/,/g, ".");
  }

  // "12 34 56.7", "12:34:56.7", "12h34m56.7s", "-7d14m42s" -> [sign, a, b, c] or null
  function splitSexagesimal(text, firstUnit) {
    const re = new RegExp("^([+-]?)\\s*(\\d+(?:\\.\\d*)?)\\s*(?:" + firstUnit + "|:|\\s)\\s*(\\d+(?:\\.\\d*)?)" +
      "(?:\\s*(?:m|:|\\s)\\s*(\\d+(?:\\.\\d*)?))?\\s*s?$", "i");
    const m = text.match(re);
    if (!m) return null;
    return [m[1] === "-" ? -1 : 1, parseFloat(m[2]), parseFloat(m[3]), m[4] ? parseFloat(m[4]) : 0];
  }

  function parseRA(input) {
    const text = normalise(input);
    if (!text) return NaN;
    if (/^[+]?\d+(\.\d*)?\s*d?$/i.test(text)) {
      const deg = parseFloat(text);
      return deg >= 0 && deg < 360 ? deg : NaN;
    }
    if (/^\d+(\.\d*)?\s*h$/i.test(text)) {
      const h = parseFloat(text);
      return h >= 0 && h < 24 ? h * 15 : NaN;
    }
    const parts = splitSexagesimal(text, "h");
    if (!parts || parts[0] < 0) return NaN;
    const [, h, m, s] = parts;
    if (h >= 24 || m >= 60 || s >= 60) return NaN;
    return (h + m / 60 + s / 3600) * 15;
  }

  function parseDec(input) {
    const text = normalise(input);
    if (!text) return NaN;
    if (/^[+-]?\d+(\.\d*)?\s*d?$/i.test(text)) {
      const deg = parseFloat(text);
      return deg >= -90 && deg <= 90 ? deg : NaN;
    }
    const parts = splitSexagesimal(text, "d");
    if (!parts) return NaN;
    const [sign, d, m, s] = parts;
    if (m >= 60 || s >= 60) return NaN;
    const deg = sign * (d + m / 60 + s / 3600);
    return deg >= -90 && deg <= 90 ? deg : NaN;
  }

  function pad(n, width, digits) {
    const s = digits ? n.toFixed(digits) : String(Math.floor(n));
    const [whole] = s.split(".");
    return "0".repeat(Math.max(0, width - whole.length)) + s;
  }

  function formatRA(deg) {
    let t = (((deg % 360) + 360) % 360) / 15 * 3600;
    t = Math.round(t * 10) / 10;
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return pad(h % 24, 2) + "h" + pad(m, 2) + "m" + pad(s, 2, 1) + "s";
  }

  function formatDec(deg) {
    const sign = deg < 0 ? "−" : "+";
    let t = Math.round(Math.abs(deg) * 3600);
    const d = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return sign + pad(d, 2) + "°" + pad(m, 2) + "′" + pad(s, 2) + "″";
  }

  function formatFov(deg) {
    const arcmin = deg * 60;
    if (Math.abs(arcmin - 60) < 0.01) return "1°";
    return (Math.round(arcmin * 10) / 10) + "′";
  }

  function nearestFovOption(deg) {
    let best = FOV_OPTIONS[0];
    for (const opt of FOV_OPTIONS) {
      if (Math.abs(opt.value - deg) < Math.abs(best.value - deg)) best = opt;
    }
    return best;
  }

  // Wrapped because storage throws in some private modes and sandboxed frames.
  const store = {
    get(key, fallback) {
      try {
        const raw = window.localStorage.getItem("wink." + key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        window.localStorage.setItem("wink." + key, JSON.stringify(value));
      } catch (e) {
        /* storage unavailable: settings just won't be remembered */
      }
    },
  };

  const params = new URLSearchParams(window.location.search);
  function isEmbed() {
    return params.get("embed") === "1";
  }

  // layers: array of "gaia" / "wise"; an empty array becomes layers=none (R32)
  function viewerUrl(opts) {
    const q = new URLSearchParams();
    q.set("ra", (+opts.ra).toFixed(6));
    q.set("dec", (+opts.dec).toFixed(6));
    q.set("fov", (+(opts.fov || DEFAULT_FOV)).toFixed(4));
    if (opts.name) q.set("name", opts.name);
    if (opts.det && opts.det !== "all") q.set("det", opts.det);
    if (opts.layers) q.set("layers", opts.layers.length ? opts.layers.join(",") : "none");
    return "viewer.html?" + q.toString();
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : v);
    }
    for (const child of [].concat(children || [])) {
      if (child == null) continue;
      node.append(child.nodeType ? child : document.createTextNode(child));
    }
    return node;
  }

  function mountShell() {
    const body = document.body;
    if (isEmbed()) body.classList.add("embed");
    const page = body.dataset.page || "";
    const active = PAGE_TO_NAV[page] || page;

    const toggle = el("button", { class: "nav-toggle", type: "button", "aria-expanded": "false",
      "aria-controls": "site-nav", "aria-label": "Menu" }, "☰");
    const list = el("ul", {}, NAV.map((item) => el("li", {}, el("a", {
      href: item.href, "aria-current": item.id === active ? "page" : null,
    }, item.label))));
    const nav = el("nav", { class: "site-nav", id: "site-nav", "aria-label": "Main" }, list);
    toggle.addEventListener("click", () => {
      const open = nav.classList.toggle("open");
      toggle.setAttribute("aria-expanded", String(open));
    });

    const header = el("header", { class: "site-header" }, el("div", { class: "bar" }, [
      el("a", { class: "brand", href: "index.html" }, [el("img", { class: "brand-logo", src: LOGO, alt: "", width: "28", height: "28" }), "Wink"]),
      toggle,
      nav,
    ]));
    const skip = el("a", { class: "skip-link", href: "#main" }, "Skip to content");
    body.prepend(skip, header);

    const footer = el("footer", { class: "site-footer" }, el("div", { class: "bar" }, [
      el("span", {}, ["Data: NASA/JPL-Caltech SPHEREx via IRSA · ", el("a", { href: "about.html#credits" }, "Credits")]),
      el("span", {}, "NASA Space Apps 2026 · Planet X & SPHEREx"),
    ]));
    body.append(footer);
  }

  window.Wink = {
    NAV, TARGETS, FOV_OPTIONS, DEFAULT_FOV,
    parseRA, parseDec, formatRA, formatDec, formatFov, nearestFovOption,
    store, params, isEmbed, viewerUrl, el,
  };

  // scripts sit at the end of <body>, so mount now and page scripts measure the final layout
  if (document.body) mountShell();
  else document.addEventListener("DOMContentLoaded", mountShell);
})();
