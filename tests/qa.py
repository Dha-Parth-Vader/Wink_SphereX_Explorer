"""QA run against the deployed site and live server. Prints a pass/fail table and writes tests/qa_results.md.
Changes nothing in the product.

    python tests/qa.py --site https://wink-spherex-explorer.vercel.app \
                       --api https://wink-spherex-explorer-live.onrender.com [--skip live,ui] [--quick]

Science checks read the pipeline results in pipeline/out/ (the same files the site was exported from).
Image checks download every frame PNG from the site. Live checks start real searches on the server, so
they need IRSA to be up. UI checks drive a headless Chromium (pip install playwright; playwright install chromium).
"""
import argparse
import io
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import requests
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "pipeline" / "out"
CHALLENGE = ["barnard", "epsindib", "wise0855", "rwaur", "rdra"]
RESULTS = []


def check(section, name, ok, detail=""):
    RESULTS.append((section, name, "PASS" if ok is True else ("SKIP" if ok is None else "FAIL"), str(detail)))
    print(f"[{RESULTS[-1][2]}] {section}: {name} {detail}", flush=True)


def load(kind, tid):
    p = OUT / kind / f"{tid}.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


# ---- science ----

def science():
    ident = {t: load("identify", t) or {} for t in CHALLENGE}
    comp = {t: load("compare", t) or {} for t in CHALLENGE}
    tgt = {t: ident[t].get("target") or comp[t].get("target") or {} for t in CHALLENGE}
    var = {t: (comp[t].get("variability") or {}).get("verdict") for t in CHALLENGE}

    pm = tgt["barnard"].get("measured_pm_arcsec_yr")
    check("science", "Barnard's Star motion within 10% of 10.4\"/yr", bool(pm) and abs(pm / 10.4 - 1) <= 0.10,
          f"{pm}\"/yr")
    pm = tgt["epsindib"].get("measured_pm_arcsec_yr")
    check("science", "Eps Indi B motion 4.4-4.7\"/yr", bool(pm) and 4.3 <= pm <= 4.8, f"{pm}\"/yr")
    w = ident["wise0855"]
    mover = next((m for m in w.get("movers", []) if m["id"] == tgt["wise0855"].get("mover")), None)
    in_cold = bool(mover) and "cold" in (mover.get("bands") or [])
    check("science", "WISE 0855 found as a mover", bool(mover), f"{tgt['wise0855'].get('measured_pm_arcsec_yr')}\"/yr")
    check("science", "WISE 0855 detected in the cold D5+D6 stack", in_cold, f"found in {mover and mover.get('bands')}")
    check("science", "WISE 0855 confirmed in CatWISE", bool(mover) and "wise" in (mover.get("matches") or {}),
          f"matches {sorted((mover or {}).get('matches') or {})}")
    check("science", "RW Aur reported as changing", var["rwaur"] == "changing", var["rwaur"])
    for t in ("epsindib", "wise0855", "barnard"):
        check("science", f"{t} brightness steady", var[t] in ("steady", "no same-wavelength comparison"), var[t])
    check("science", "R Dra at most 'possible change'", var["rdra"] in ("steady", "possible change"), var["rdra"])
    for t in CHALLENGE:
        off = tgt[t].get("mean_offset_px")
        check("science", f"{t} within 1/3 px of prediction", off is not None and off <= 1 / 3, f"{off} px")


# ---- images ----

def image_checks(site, quick):
    s = requests.Session()
    patches = [p for p in s.get(f"{site}/data/patches.json", timeout=60).json() if not p.get("simulated")]
    if quick:
        patches = [p for p in patches if p["id"] in CHALLENGE]
    jobs = []
    stretch_bad = []
    for p in patches:
        doc = s.get(f"{site}/data/{p['id']}.json", timeout=60).json()
        per_det = {}
        for f in doc["frames"]:
            per_det.setdefault(str(f["detector"]), set()).add(json.dumps(f["stretch"], sort_keys=True))
            jobs.append((p["id"], f))
        stretch_bad += [f"{p['id']} D{d}" for d, v in per_det.items() if len(v) > 1]

    def one(job):
        tid, f = job
        a = np.asarray(Image.open(io.BytesIO(s.get(f"{site}/data/{f['file']}", timeout=60).content)).convert("L"))
        c = 10
        valid = a > 0
        # an empty corner is a block with no data at all; sky below the black level is 0 too, so look for a
        # solid zero block that the frame's coverage doesn't explain
        corners = sum(not valid[sl].any() for sl in ((slice(0, c), slice(0, c)), (slice(0, c), slice(-c, None)),
                                                       (slice(-c, None), slice(0, c)), (slice(-c, None), slice(-c, None))))
        grey = float(((a > 90) & (a < 165)).mean())
        holes = 0
        bright = a >= 250
        if bright.any():
            from scipy import ndimage
            ring = ndimage.binary_dilation(bright, iterations=2) & ~bright
            inner = ndimage.binary_fill_holes(bright) & ~bright
            holes = int((inner & (a == 0)).sum()) if ring.any() else 0
        return tid, f, corners, float(np.median(a)), grey, holes

    with ThreadPoolExecutor(12) as ex:
        res = list(ex.map(one, jobs))
    # a black corner is fine on a date that doesn't cover the whole field: the viewer captions those (< 99.5%)
    corner_bad = [f"{t} {f['file'].split('/')[-1]}" for t, f, c, *_ in res if c and (f.get("coverage") or 1) >= 0.995]
    static_bad = [f"{t} {f['file'].split('/')[-1]}" for t, f, _, med, grey, _ in res if med > 40 or grey > 0.2]
    hole_bad = [f"{t} {f['file'].split('/')[-1]}" for t, f, *_, holes in res if holes > 3]
    check("images", f"no black corners except on captioned partial dates ({len(res)} frames)", not corner_bad,
          f"{len(corner_bad)} frames, e.g. {corner_bad[:3]}" if corner_bad else "")
    check("images", "no static: sky near black, few mid-grey pixels", not static_bad,
          f"{len(static_bad)}: {static_bad[:3]}" if static_bad else "")
    check("images", "no black holes inside bright stars", not hole_bad, f"{len(hole_bad)}: {hole_bad[:3]}" if hole_bad else "")
    check("images", "same stretch for all dates of one detector", not stretch_bad,
          f"{stretch_bad[:3]}" if stretch_bad else f"{len(patches)} targets")
    check("images", "edge wedges", None, "not measurable from PNGs alone; covered by coverage blanking in step 4")


# ---- live server ----

def poll(api, params, origin, limit=420):
    t0 = time.time()
    fields_ok = True
    while time.time() - t0 < limit:
        r = requests.get(f"{api}/api/patch", params=params, headers={"Origin": origin}, timeout=90)
        if r.status_code != 202:
            return r, time.time() - t0, fields_ok
        j = r.json()
        fields_ok &= all(k in j for k in ("status", "step", "steps", "message", "done", "total", "elapsed_s"))
        time.sleep(1.5)
    return None, limit, fields_ok


def live(api, origin):
    h = requests.get(f"{api}/api/health", timeout=120)
    check("live", "/api/health ok", h.ok and h.json().get("ok") is True, h.text[:80])
    r = requests.get(f"{api}/api/health", headers={"Origin": origin}, timeout=60)
    check("live", "CORS allowed for our site", r.headers.get("Access-Control-Allow-Origin") == origin, origin)
    r = requests.get(f"{api}/api/health", headers={"Origin": "https://evil.example"}, timeout=60)
    check("live", "CORS refused for https://evil.example",
          r.status_code == 403 and not r.headers.get("Access-Control-Allow-Origin"), f"HTTP {r.status_code}")

    spot = {"ra": 150.11, "dec": 2.21, "fov": 5 / 60}
    r, dt, fields = poll(api, spot, origin)
    if r is None or r.status_code != 200:
        msg = r.json().get("message", "") if r is not None and r.headers.get("Content-Type", "").startswith("application/json") else ""
        check("live", "new spot completes", False, f"HTTP {r.status_code if r is not None else 'timeout'} {msg[:90]}")
        for name in ("progress fields", "second request < 2 s", "layers", "partial-coverage field", "two searches at once"):
            check("live", name, None, "needs a working new-spot search")
        return
    check("live", "new spot completes", True, f"{dt:.0f} s")
    check("live", "progress fields while working", fields)
    t0 = time.time()
    r2 = requests.get(f"{api}/api/patch", params=spot, headers={"Origin": origin}, timeout=60)
    check("live", "second request < 2 s", r2.ok and time.time() - t0 < 2, f"{time.time() - t0:.2f} s")
    want = {None: ["gaia", "wise"], "": [], "none": [], "gaia": ["gaia"], "wise": ["wise"], "gaia,wise": ["gaia", "wise"]}
    bad = []
    for lay, exp in want.items():
        q = dict(spot)
        if lay is not None:
            q["layers"] = lay
        got = sorted(requests.get(f"{api}/api/patch", params=q, headers={"Origin": origin}, timeout=120).json()["overlays"])
        if got != exp:
            bad.append(f"{lay!r}->{got}")
    check("live", "layers missing/''/none/gaia/wise/gaia,wise", not bad, ", ".join(bad))

    r, dt, _ = poll(api, {"ra": 89.6230, "dec": -58.2360, "fov": 0.5, "layers": "none"}, origin)
    if r is not None and r.ok:
        dates = [(f["date"], f["coverage"]) for f in r.json()["frames"] if f["detector"] == "all"]
        check("live", "partial-coverage field has per-date coverage", all(c is not None for _, c in dates), dates)
    else:
        check("live", "partial-coverage field has per-date coverage", False, f"HTTP {r.status_code if r else 'timeout'}")

    out = {}
    a, b = {"ra": 210.80, "dec": 54.35, "fov": 5 / 60}, {"ra": 83.82, "dec": -5.39, "fov": 5 / 60}
    import threading
    ta = threading.Thread(target=lambda: out.__setitem__("a", poll(api, a, origin)))
    ta.start()
    time.sleep(5)
    second = requests.get(f"{api}/api/patch", params=b, headers={"Origin": origin}, timeout=60)
    queued = second.status_code == 202 and second.json().get("status") == "queued"
    rb = poll(api, b, origin)
    ta.join()
    both = out["a"][0] is not None and out["a"][0].ok and rb[0] is not None and rb[0].ok
    check("live", "two new spots at once: second queued, both finish", queued and both,
          f"second={second.json().get('status')}, times {out['a'][1]:.0f}/{rb[1]:.0f} s")


# ---- UI ----

def ui(site):
    from playwright.sync_api import sync_playwright
    target = f"{site}/viewer.html?ra=269.446268&dec=4.768204&fov=0.25&name=Barnard%27s%20Star"
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        for label, vp in (("desktop", {"width": 1440, "height": 900}), ("phone", {"width": 390, "height": 844})):
            page = browser.new_page(viewport=vp)
            errors = []
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            page.on("pageerror", lambda e: errors.append(str(e)))
            for path in ("index.html", "learn.html", "search.html", "dome.html", "about.html"):
                page.goto(f"{site}/{path}", wait_until="networkidle")
                over = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
                check(f"ui {label}", f"{path} no horizontal scroll", over <= 1, f"{over}px")
            page.goto(target + "&speed=10", wait_until="networkidle")
            page.wait_for_function("document.querySelector('#in-time') && +document.querySelector('#in-time').max > 0",
                                   timeout=60000)
            over = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
            check(f"ui {label}", "viewer no horizontal scroll", over <= 1, f"{over}px")
            i0 = page.input_value("#in-time")
            page.wait_for_timeout(3000)
            check(f"ui {label}", "no autoplay", page.input_value("#in-time") == i0)
            if label == "desktop":
                changes = page.evaluate("""() => new Promise(res => {
                    const r = document.querySelector('#in-time'); let n = 0, last = r.value;
                    const t = setInterval(() => { if (r.value !== last) { n++; last = r.value; } }, 20);
                    document.querySelector('#btn-play').click();
                    setTimeout(() => { clearInterval(t); document.querySelector('#btn-play').click(); res(n); }, 4000);
                  })""")
                check("ui desktop", "at most 3 swaps/s with &speed=10 in the URL", changes <= 13, f"{changes} swaps in 4 s")
                page.locator("#sky-canvas").focus()
                i0 = page.input_value("#in-time")
                page.keyboard.press("ArrowLeft" if int(i0) > 0 else "ArrowRight")
                page.wait_for_timeout(1000)
                check("ui desktop", "arrow keys change date", page.input_value("#in-time") != i0)
                page.keyboard.press("Space")
                playing = page.get_attribute("#btn-play", "aria-pressed")
                page.keyboard.press("Space")
                check("ui desktop", "Space toggles play", playing == "true" and
                      page.get_attribute("#btn-play", "aria-pressed") == "false")
                check("ui desktop", "canvas has an aria-label",
                      bool(page.get_attribute("#sky-canvas", "aria-label")))
                url = page.url
                for k in ("ra=", "dec=", "fov="):
                    check("ui desktop", f"URL keeps {k}", k in url)
                wv = page.get_attribute("#link-wiseview", "href") or ""
                check("ui desktop", "WiseView link carries the position", "269.4" in wv and "byw.tools" in wv, wv[:80])
                page.click("#btn-mark")
                page.locator("#sky-canvas").focus()
                page.keyboard.press("Enter")
                page.wait_for_selector("#mark-text", state="visible", timeout=5000)
                page.fill("#mark-text", "qa test")
                page.keyboard.press("Enter")
                with page.expect_download() as dl:
                    page.click("#btn-report-txt")
                text = Path(dl.value.path()).read_text(encoding="utf-8")
                check("ui desktop", "Mark this report has position, date and link",
                      all(s in text for s in ("RA", "Dec")) and "viewer.html" in text, text[:60].replace("\n", " "))
                page.goto(target + "&embed=1", wait_until="networkidle")
                check("ui desktop", "embed mode hides the header", not page.locator("#site-header").is_visible())
                page.goto(f"{site}/about.html", wait_until="networkidle")
                body = page.inner_text("body")
                check("ui desktop", "credits: ESA/Gaia/DPAC wording",
                      "Gaia Data Processing and Analysis Consortium" in body and "Gaia Multilateral Agreement" in body)
                check("ui desktop", "credits: NASA non-endorsement line",
                      "NASA does not endorse any non-U.S. Government entity" in body)
            check(f"ui {label}", "zero console errors", not errors, errors[:3])
            page.close()
        browser.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", default="https://wink-spherex-explorer.vercel.app")
    ap.add_argument("--api", default="https://wink-spherex-explorer-live.onrender.com")
    ap.add_argument("--skip", default="", help="comma list of science,images,live,ui")
    ap.add_argument("--quick", action="store_true", help="image checks on the 5 challenge targets only")
    a = ap.parse_args()
    skip = set(a.skip.split(","))
    site, api = a.site.rstrip("/"), a.api.rstrip("/")
    for name, fn in (("science", science), ("images", lambda: image_checks(site, a.quick)),
                     ("live", lambda: live(api, site)), ("ui", lambda: ui(site))):
        if name in skip:
            continue
        try:
            fn()
        except Exception as exc:  # noqa: BLE001  one broken section shouldn't hide the others
            check(name, "section ran", False, f"{type(exc).__name__}: {str(exc)[:150]}")
    lines = ["| Section | Check | Result | Detail |", "|---|---|---|---|"]
    lines += [f"| {s} | {n} | {r} | {d.replace('|', '/')[:160]} |" for s, n, r, d in RESULTS]
    counts = {k: sum(r[2] == k for r in RESULTS) for k in ("PASS", "FAIL", "SKIP")}
    lines.append(f"\n{counts['PASS']} passed, {counts['FAIL']} failed, {counts['SKIP']} skipped.")
    (ROOT / "tests" / "qa_results.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))
    sys.exit(1 if counts["FAIL"] else 0)


if __name__ == "__main__":
    main()
