// Community marks: read straight from Supabase with its public read-only key, shared through our server.
(function () {
  "use strict";

  // keep in step with SUPABASE_URL and SUPABASE_ANON_KEY in project.config.json
  const SUPABASE_URL = "https://bkycgwehmvmixkqkldld.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_EQr_sFl9vJgLgLWEukif3w_L-PYlspv";
  const LIVE_SERVER = "https://wink-spherex-explorer-live.onrender.com";
  const COLUMNS = "id,created_at,ra,dec,label,patch,mjd,detector";
  const MAX_ROWS = 2000;

  const LABELS = {
    mover: { name: "Mover", colour: "--mover", glyph: "◆" },
    variable: { name: "Changes brightness", colour: "--variable", glyph: "●" },
    artifact: { name: "Artifact", colour: "--faint", glyph: "✕" },
  };

  class HuntError extends Error {}

  function configured() {
    return /^https:\/\//.test(SUPABASE_URL) && SUPABASE_ANON_KEY.length > 20 && !SUPABASE_ANON_KEY.startsWith("{");
  }

  let listPromise = null;
  function list(force) {
    if (!configured()) return Promise.resolve([]);
    if (!listPromise || force) {
      const url = SUPABASE_URL.replace(/\/+$/, "") + "/rest/v1/marks?select=" + COLUMNS +
        "&order=created_at.desc&limit=" + MAX_ROWS;
      // the new-style publishable key goes in the apikey header only (it isn't a JWT)
      listPromise = fetch(url, { headers: { apikey: SUPABASE_ANON_KEY } })
        .then((r) => {
          if (!r.ok) throw new HuntError("The community map couldn't load (HTTP " + r.status + ").");
          return r.json();
        })
        .catch((e) => {
          listPromise = null;
          throw e instanceof HuntError ? e : new HuntError("The community map couldn't load. Check your connection.");
        });
    }
    return listPromise;
  }

  function apiBase() {
    if (window.SkyData && window.SkyData.apiBase) return window.SkyData.apiBase();
    return Promise.resolve(LIVE_SERVER + "/");
  }

  // mark: {ra, dec, label, patch?, mjd?, detector?}. Resolves when saved; throws HuntError with a message to show.
  async function share(mark) {
    if (!LABELS[mark.label]) throw new HuntError("Pick mover, variable or artifact.");
    const base = await apiBase();
    let resp;
    try {
      resp = await fetch(base + "api/marks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mark),
      });
    } catch (e) {
      throw new HuntError("We couldn't reach our server to share this. Your mark is still saved in this browser.");
    }
    let body = {};
    try { body = await resp.json(); } catch (e) { /* message below */ }
    if (!resp.ok) throw new HuntError(body.message || "Sharing failed (HTTP " + resp.status + "). Try again later.");
    listPromise = null;
    return body;
  }

  window.WinkHunt = { LABELS, configured, list, share, HuntError };
})();
